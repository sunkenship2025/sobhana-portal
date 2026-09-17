import { DiagnosticWorkflowMode, PayoutDoctorType, PaymentType, Prisma, ReportStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { computeCommissionInPaise, computeLabCostInPaise, computeReferralPayoutInPaise } from './referralPayoutService';
import {
  allocateBillDiscountAcrossOrders,
  computeBillFinancialsFromPersisted,
} from './billFinancialService';
import { categorize, categoryLabel, CATEGORY_ORDER, CAT_LAB, type PayoutCategory } from './payoutCategorize';
import { isWhatsAppEnabled } from './whatsappCloudService';

// Defensive fallback when a sync* caller omits `startDate`: the live Payouts
// UI (PayoutsList.tsx) always sends a concrete range, but these are optional
// route params, so an unbounded new Date(0) default would repeat the same
// "scan every visit ever" pattern that caused the Jul 2026 worklist OOM (see
// project_oom_remediation_2026_07 memory) for any direct/future API caller.
const defaultSyncWindowStart = () => new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);


// ===========================================================================
// TYPES
// ===========================================================================

export interface PayoutLineItem {
  visitId: string;
  productId?: string | null;
  billNumber: string;
  patientName: string;
  patientTitle?: string | null;
  date: Date;
  testOrFee: string; // Test name for referral, "Consultation Fee" for clinic
  amountInPaise: number;
  commissionPercentage?: number; // Only for referral/diagnostic center
  commissionType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
  commissionAmountInPaise?: number;
  commissionLabel?: string;
  derivedCommissionInPaise: number;
  // Statement enrichment (optional; populated by diagnostic derivations)
  category?: PayoutCategory;        // centre-defined label (product category or department)
  basisLabel?: string;              // e.g. "50% → ₹300" or "Flat ₹200"
  discountInPaise?: number;         // this order's allocated share of the bill discount
  departmentName?: string | null;
  productCode?: string | null;
  // Outside-lab (LAB payout) only
  labCostInPaise?: number;          // what we owe the lab for this order (= derivedCommissionInPaise for LAB)
  centerMarginInPaise?: number;     // post-discount price − lab cost
}

export interface PayoutDerivationResult {
  doctorType: PayoutDoctorType;
  doctorId: string;
  doctorName: string;
  branchId: string;
  periodStartDate: Date;
  periodEndDate: Date;
  lineItems: PayoutLineItem[];
  derivedAmountInPaise: number;
}

export interface PayoutSummary {
  id: string;
  doctorType: PayoutDoctorType;
  doctorId: string;
  doctorName: string;
  branchId: string;
  branchName: string;
  periodStartDate: Date;
  periodEndDate: Date;
  derivedAmountInPaise: number;
  derivedAt: Date;
}

export interface PayoutDetail extends PayoutSummary {
  notes: string | null;
  lineItems: PayoutLineItem[];
}

function buildDateWindow(startDate?: Date, endDate?: Date) {
  return {
    ...(startDate && { gte: startDate }),
    ...(endDate && { lte: endDate }),
  };
}

function buildDiagnosticPayoutVisitWindow(startDate: Date, endDate: Date): Prisma.VisitWhereInput {
  const noFinalizedReport: Prisma.VisitWhereInput['OR'] = [
    { report: { is: null } },
    { report: { is: { versions: { none: { status: ReportStatus.FINALIZED } } } } },
  ];
  return {
    OR: [
      // 1) Reportable — counted when its report is FINALIZED within the window.
      {
        report: {
          is: {
            versions: {
              some: {
                status: ReportStatus.FINALIZED,
                finalizedAt: buildDateWindow(startDate, endDate),
              },
            },
          },
        },
      },
      // 2) Bill-only — no report expected; counted at completion.
      {
        status: 'COMPLETED',
        updatedAt: buildDateWindow(startDate, endDate),
        testOrders: {
          some: {
            workflowMode: DiagnosticWorkflowMode.BILL_ONLY,
          },
        },
        OR: noFinalizedReport,
      },
      // 3) Films-only ("no report needed") — patient paid, doctor referred, no
      //    written report. Owner rule: referral IS earned on films. Counted in
      //    the month the order was closed films-only (noReportAt), when the
      //    visit has no finalized report. Per-order payability is enforced in
      //    the derive loops so a mixed visit only pays its resolved orders.
      {
        testOrders: {
          some: {
            noReportAt: buildDateWindow(startDate, endDate),
            cancelledAt: null,
          },
        },
        OR: noFinalizedReport,
      },
    ],
  };
}

function markCommissionAsMixed(lineItem: PayoutLineItem) {
  lineItem.commissionType = undefined;
  lineItem.commissionPercentage = undefined;
  lineItem.commissionAmountInPaise = undefined;
  lineItem.commissionLabel = 'Mixed';
}

function mergeGroupedCommission(target: PayoutLineItem, incoming: PayoutLineItem) {
  if (target.commissionLabel === 'Mixed' || incoming.commissionLabel === 'Mixed') {
    markCommissionAsMixed(target);
    return;
  }

  if (!target.commissionType && !incoming.commissionType) {
    return;
  }

  if (target.commissionType === 'FIXED_AMOUNT' && incoming.commissionType === 'FIXED_AMOUNT') {
    target.commissionAmountInPaise =
      (target.commissionAmountInPaise ?? 0) + (incoming.commissionAmountInPaise ?? 0);
    return;
  }

  if (target.commissionType === 'PERCENTAGE' && incoming.commissionType === 'PERCENTAGE') {
    const targetPercent = target.commissionPercentage ?? 0;
    const incomingPercent = incoming.commissionPercentage ?? 0;

    if (Math.abs(targetPercent - incomingPercent) <= 0.0001) {
      return;
    }
  }

  markCommissionAsMixed(target);
}

function groupDiagnosticLineItemsByBillableProduct(lineItems: PayoutLineItem[]) {
  const groupedLineItems: PayoutLineItem[] = [];
  const groupedProductLineItems = new Map<string, PayoutLineItem>();

  for (const lineItem of lineItems) {
    if (!lineItem.productId) {
      groupedLineItems.push(lineItem);
      continue;
    }

    const groupingKey = `${lineItem.visitId}:${lineItem.productId}`;
    const existing = groupedProductLineItems.get(groupingKey);

    if (!existing) {
      const groupedItem = { ...lineItem };
      groupedProductLineItems.set(groupingKey, groupedItem);
      groupedLineItems.push(groupedItem);
      continue;
    }

    existing.amountInPaise += lineItem.amountInPaise;
    existing.derivedCommissionInPaise += lineItem.derivedCommissionInPaise;
    mergeGroupedCommission(existing, lineItem);
  }

  return groupedLineItems;
}

// ===========================================================================
// DERIVATION LOGIC - REFERRAL DOCTORS
// ===========================================================================

/**
 * Derive payout for a referral doctor.
 * Formula:
 *   - percentage rules: discounted test-order share × referralCommissionPercentage / 100
 *   - fixed rules: referralCommissionAmountInPaise snapshot
 * for all tests in visits where:
 *   - Visit has a finalized report
 *   - Visit is linked to this referral doctor
 *   - Visit is in the given branch
 *   - Report finalized within the period
 */
async function deriveReferralPayout(
  referralDoctorId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<PayoutDerivationResult> {
  // Get referral doctor info
  const doctor = await prisma.referralDoctor.findUnique({
    where: { id: referralDoctorId },
    select: { id: true, name: true },
  });

  if (!doctor) {
    throw new Error('Referral doctor not found');
  }

  // Get all visits completed in the period.
  // Reportable and mixed visits qualify by report finalization date.
  // Pure bill-only visits qualify by the completion-time proxy on Visit.updatedAt.
  const visits = await prisma.visit.findMany({
    where: {
      branchId,
      domain: 'DIAGNOSTICS',
      referrals: {
        some: { referralDoctorId, deletedAt: null },
      },
      ...buildDiagnosticPayoutVisitWindow(periodStartDate, periodEndDate),
    },
    include: {
      patient: { select: { name: true, title: true } },
      testOrders: {
        include: {
          test: { select: { name: true, code: true, department: { select: { name: true } } } },
          product: { select: { id: true, name: true, code: true, payoutCategory: true } },
        },
      },
      bill: true,
      report: {
        include: {
          versions: {
            where: { status: 'FINALIZED' },
            orderBy: { versionNum: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  const lineItems: PayoutLineItem[] = [];
  let totalDerivedInPaise = 0;

  for (const visit of visits) {
    const finalizedAt = visit.report?.versions[0]?.finalizedAt;
    const billFinancials = visit.bill
      ? computeBillFinancialsFromPersisted(visit.bill)
      : null;
    // Swapped-out orders are left out of the denominator: their replacement
    // carries that price now, so counting both shrinks every order's share.
    const discountAllocations = billFinancials
      ? allocateBillDiscountAcrossOrders(
          visit.testOrders
            .filter((order) => !order.replacedAt)
            .map((order) => ({
              id: order.id,
              priceInPaise: order.priceInPaise,
            })),
          billFinancials.discountAmountInPaise
        )
      : new Map<string, number>();

    for (const testOrder of visit.testOrders) {
      // Cancelled orders earn no payout — their charge was voided off the bill.
      if (testOrder.cancelledAt) continue;
      // An order earns commission once it's "delivered": the visit's report is
      // finalized, OR it's a bill-only order, OR it was closed films-only ("no
      // report needed" — owner: referral is earned on films). Reportable orders
      // still awaiting finalization do not earn yet. This makes a mixed visit
      // pay only its resolved orders even when it matched via the films-only
      // window branch.
      const isPayable =
        Boolean(finalizedAt) ||
        testOrder.workflowMode === DiagnosticWorkflowMode.BILL_ONLY ||
        testOrder.noReportAt != null;
      if (!isPayable) continue;
      // This order's share of the bill discount (allocated proportionally by
      // price across every order on the bill). Used both to show the
      // post-discount "Amount" and to reduce the commission.
      const discountShareInPaise = discountAllocations.get(testOrder.id) ?? 0;
      // The "Amount" shown on the statement is the post-discount price the
      // patient actually paid for this order.
      const postDiscountPriceInPaise = Math.max(
        0,
        testOrder.priceInPaise - discountShareInPaise
      );
      // Commission rule (owner, Aug 2026): the FULL bill discount is borne by
      // the referrer. Percentage commission = (percentage of the GROSS price)
      // minus the whole discount allocated to this order, floored at 0.
      // e.g. ₹1000 @ 50% with a ₹100 discount → 500 − 100 = ₹400.
      // Fixed-amount commissions are flat and unaffected by any discount.
      const commissionInPaise =
        testOrder.referralCommissionType === 'PERCENTAGE'
          ? Math.max(
              0,
              computeCommissionInPaise({
                priceInPaise: testOrder.priceInPaise,
                commissionType: 'PERCENTAGE',
                commissionPercentage: testOrder.referralCommissionPercentage,
                commissionAmountInPaise: testOrder.referralCommissionAmountInPaise,
              }) - discountShareInPaise
            )
          : computeReferralPayoutInPaise(testOrder);
      totalDerivedInPaise += commissionInPaise;

      lineItems.push({
        visitId: visit.id,
        productId: testOrder.productId,
        billNumber: visit.billNumber,
        patientName: visit.patient.name,
        patientTitle: visit.patient.title,
        date: finalizedAt || testOrder.noReportAt || visit.updatedAt || visit.createdAt,
        testOrFee:
          testOrder.product?.name ||
          testOrder.testNameSnapshot ||
          testOrder.test.name,
        amountInPaise: postDiscountPriceInPaise,
        commissionType: testOrder.referralCommissionType,
        commissionPercentage:
          testOrder.referralCommissionType === 'PERCENTAGE'
            ? testOrder.referralCommissionPercentage ?? undefined
            : undefined,
        commissionAmountInPaise:
          testOrder.referralCommissionType === 'FIXED_AMOUNT'
            ? testOrder.referralCommissionAmountInPaise ?? undefined
            : undefined,
        derivedCommissionInPaise: commissionInPaise,
        category: testOrder.payoutCategorySnapshot || categorize({
          productPayoutCategory: testOrder.product?.payoutCategory,
          productName: testOrder.product?.name,
          testName: testOrder.testNameSnapshot || testOrder.test?.name,
        }),
        basisLabel:
          testOrder.referralCommissionType === 'FIXED_AMOUNT'
            ? `Flat ${rupeesShort(commissionInPaise)}`
            : `${testOrder.referralCommissionPercentage ?? 0}% → ${rupeesShort(commissionInPaise)}`,
        discountInPaise: discountShareInPaise,
        departmentName: testOrder.test?.department?.name ?? null,
        productCode: testOrder.product?.code ?? testOrder.testCodeSnapshot ?? null,
      });
    }
  }

  return {
    doctorType: 'REFERRAL',
    doctorId: referralDoctorId,
    doctorName: doctor.name,
    branchId,
    periodStartDate,
    periodEndDate,
    lineItems: groupDiagnosticLineItemsByBillableProduct(lineItems),
    derivedAmountInPaise: totalDerivedInPaise,
  };
}

// ===========================================================================
// DERIVATION LOGIC - CLINIC DOCTORS
// ===========================================================================

/**
 * Derive payout for a clinic doctor.
 * Formula: Commission (percentage or fixed amount) of consultationFeeInPaise for all completed clinic visits in the period.
 */
async function deriveClinicPayout(
  clinicDoctorId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<PayoutDerivationResult> {
  // Get clinic doctor info with commission settings
  const doctor = await prisma.clinicDoctor.findUnique({
    where: { id: clinicDoctorId },
    select: {
      id: true,
      name: true,
      commissionType: true,
      commissionPercent: true,
      commissionAmountInPaise: true,
    },
  });

  if (!doctor) {
    throw new Error('Clinic doctor not found');
  }

  // Get all completed clinic visits in the period
  const clinicVisits = await prisma.clinicVisit.findMany({
    where: {
      clinicDoctorId,
      status: 'COMPLETED',
      visit: {
        branchId,
      },
      completedAt: {
        gte: periodStartDate,
        lte: periodEndDate,
      },
    },
    include: {
      visit: {
        include: {
          patient: { select: { name: true, title: true } },
        },
      },
    },
  });

  const lineItems: PayoutLineItem[] = [];
  let totalDerivedInPaise = 0;

  for (const cv of clinicVisits) {
    let commissionInPaise: number;

    if (doctor.commissionType === 'FIXED_AMOUNT' && doctor.commissionAmountInPaise != null) {
      // Fixed amount per consultation
      commissionInPaise = doctor.commissionAmountInPaise;
    } else {
      // Percentage of consultation fee (default)
      const percent = doctor.commissionPercent ?? 100;
      commissionInPaise = Math.round(cv.consultationFeeInPaise * percent / 100);
    }

    totalDerivedInPaise += commissionInPaise;

    lineItems.push({
      visitId: cv.visit.id,
      billNumber: cv.visit.billNumber,
      patientName: cv.visit.patient.name,
      patientTitle: cv.visit.patient.title,
      date: cv.completedAt || cv.createdAt,
      testOrFee: 'Consultation Fee',
      amountInPaise: cv.consultationFeeInPaise,
      derivedCommissionInPaise: commissionInPaise,
      commissionType: doctor.commissionType,
      commissionPercentage: doctor.commissionType === 'PERCENTAGE' ? doctor.commissionPercent ?? undefined : undefined,
      commissionAmountInPaise: doctor.commissionType === 'FIXED_AMOUNT' ? doctor.commissionAmountInPaise ?? undefined : undefined,
    });
  }

  return {
    doctorType: 'CLINIC',
    doctorId: clinicDoctorId,
    doctorName: doctor.name,
    branchId,
    periodStartDate,
    periodEndDate,
    lineItems,
    derivedAmountInPaise: totalDerivedInPaise,
  };
}

// ===========================================================================
// DERIVATION LOGIC - DIAGNOSTIC CENTERS
// DERIVATION LOGIC - PARTNERS (two-sided: outside labs & referring centres)
// ===========================================================================

function rupeesShort(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

/**
 * Derive a partner's position for the period — BOTH directions at once.
 *
 * Replaces deriveDiagnosticCenterPayout (they send in, we owe a cut) and
 * deriveExternalLabPayout (we send out, we owe a vendor rate). A real partner is
 * usually both and settles on one net figure, so deriving them separately meant
 * two statements and a subtraction done on paper.
 *
 * Every amount comes from the snapshot frozen onto the TestOrder at order time
 * (ourShareInPaise / partnerCutInPaise), so editing a rate today cannot restate
 * a past period.
 *
 * The one thing recomputed here is REVERSALS. A snapshot is frozen against the
 * charge that stood at order time; if part of that charge was later voided, both
 * sides must fall with it. Previously only a FULL cancel was honoured and
 * `reversedChargeInPaise` was ignored, so a partial refund still paid out in
 * full. Both sides are scaled by the surviving fraction of the charge.
 *
 * derivedAmountInPaise is NET and signed:
 *     what we owe them (partner cuts) − what they owe us (our share on work
 *                                        they billed and collected)
 * Negative therefore means the partner owes US, and the Pay-Run renders that as
 * a receivable rather than paying it.
 */
async function derivePartnerPayout(
  partnerId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<PayoutDerivationResult> {
  const partner = await prisma.partner.findUnique({
    where: { id: partnerId },
    select: { id: true, name: true },
  });
  if (!partner) {
    throw new Error('Partner not found');
  }

  const visits = await prisma.visit.findMany({
    where: {
      branchId,
      domain: 'DIAGNOSTICS',
      testOrders: { some: { partnerId } },
      ...buildDiagnosticPayoutVisitWindow(periodStartDate, periodEndDate),
    },
    include: {
      patient: { select: { name: true, title: true } },
      partnerVisit: { select: { kind: true, partnerBilledInPaise: true } },
      testOrders: {
        include: {
          test: { select: { name: true, code: true, department: { select: { name: true } } } },
          product: { select: { id: true, name: true, code: true, payoutCategory: true } },
        },
      },
      bill: true,
      report: {
        include: {
          versions: { where: { status: 'FINALIZED' }, orderBy: { versionNum: 'desc' }, take: 1 },
        },
      },
    },
  });

  const lineItems: PayoutLineItem[] = [];
  let weOweInPaise = 0;
  let theyOweInPaise = 0;

  for (const visit of visits) {
    const finalizedAt = visit.report?.versions[0]?.finalizedAt;
    const billFinancials = visit.bill ? computeBillFinancialsFromPersisted(visit.bill) : null;
    // Discount is allocated across the FULL bill, not just the partner's orders.
    const discountAllocations = billFinancials
      ? allocateBillDiscountAcrossOrders(
          visit.testOrders
            .filter((order) => !order.replacedAt)
            .map((order) => ({ id: order.id, priceInPaise: order.priceInPaise })),
          billFinancials.discountAmountInPaise
        )
      : new Map<string, number>();

    for (const testOrder of visit.testOrders) {
      if (testOrder.partnerId !== partnerId) continue;
      if (testOrder.cancelledAt) continue;
      // Partner money is earned on DELIVERY, exactly like commission: a finalized
      // report, a bill-only order, or one closed films-only.
      const isPayable =
        Boolean(finalizedAt) ||
        testOrder.workflowMode === DiagnosticWorkflowMode.BILL_ONLY ||
        testOrder.noReportAt != null;
      if (!isPayable) continue;

      const discountInPaise = discountAllocations.get(testOrder.id) ?? 0;
      const chargeAtOrderTime = Math.max(0, testOrder.priceInPaise - discountInPaise);
      const standingCharge = Math.max(0, chargeAtOrderTime - (testOrder.reversedChargeInPaise ?? 0));
      const surviving = chargeAtOrderTime > 0 ? standingCharge / chargeAtOrderTime : 0;

      const ourShareInPaise = Math.round((testOrder.ourShareInPaise ?? 0) * surviving);
      const partnerCutInPaise = Math.round((testOrder.partnerCutInPaise ?? 0) * surviving);
      const theyCollected =
        (testOrder.partnerArrangement ?? visit.partnerVisit?.kind ?? null) === 'INBOUND_BILLED_THERE';

      weOweInPaise += partnerCutInPaise;
      if (theyCollected) theyOweInPaise += ourShareInPaise;

      lineItems.push({
        visitId: visit.id,
        productId: testOrder.productId,
        billNumber: visit.billNumber,
        patientName: visit.patient.name,
        patientTitle: visit.patient.title,
        date: finalizedAt || testOrder.noReportAt || visit.updatedAt || visit.createdAt,
        testOrFee: testOrder.product?.name || testOrder.testNameSnapshot || testOrder.test.name,
        // The statement must reconcile against the partner's OWN register, so it
        // shows gross — what the patient was charged, by whoever charged them.
        amountInPaise: visit.partnerVisit?.partnerBilledInPaise ?? standingCharge,
        commissionType: testOrder.ourShareBasis === 'FLAT' ? 'FIXED_AMOUNT' : 'PERCENTAGE',
        commissionPercentage:
          testOrder.ourShareBasis === 'FLAT' ? undefined : testOrder.ourSharePercent ?? undefined,
        commissionAmountInPaise: testOrder.ourShareBasis === 'FLAT' ? ourShareInPaise : undefined,
        // Signed per line, so a statement mixing both directions still sums.
        derivedCommissionInPaise: theyCollected ? -ourShareInPaise : partnerCutInPaise,
        category:
          testOrder.payoutCategorySnapshot ||
          categorize({
            productPayoutCategory: testOrder.product?.payoutCategory,
            productName: testOrder.product?.name,
            testName: testOrder.testNameSnapshot || testOrder.test?.name,
          }),
        basisLabel:
          testOrder.ourShareBasis === 'FLAT'
            ? `Flat ${rupeesShort(ourShareInPaise)} to us`
            : `${testOrder.ourSharePercent ?? 0}% to us → ${rupeesShort(ourShareInPaise)}`,
        discountInPaise,
        departmentName: testOrder.test?.department?.name ?? null,
        productCode: testOrder.product?.code ?? testOrder.testCodeSnapshot ?? null,
        labCostInPaise: partnerCutInPaise,
        centerMarginInPaise: ourShareInPaise,
      });
    }
  }

  return {
    doctorType: 'PARTNER',
    doctorId: partnerId,
    doctorName: partner.name,
    branchId,
    periodStartDate,
    periodEndDate,
    // Not product-grouped: the group merge does not sum cut / share, and a
    // partner statement is read line by line against their own register.
    lineItems,
    derivedAmountInPaise: weOweInPaise - theyOweInPaise,
  };
}

// ===========================================================================
// HELPER: Route derivation to the correct function based on doctorType
// ===========================================================================

function deriveByType(
  doctorType: PayoutDoctorType,
  doctorId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<PayoutDerivationResult> {
  switch (doctorType) {
    case 'REFERRAL':
      return deriveReferralPayout(doctorId, branchId, periodStartDate, periodEndDate);
    case 'CLINIC':
      return deriveClinicPayout(doctorId, branchId, periodStartDate, periodEndDate);
    case 'PARTNER':
      return derivePartnerPayout(doctorId, branchId, periodStartDate, periodEndDate);
    default:
      throw new Error(`Unsupported doctor type: ${doctorType}`);
  }
}

/**
 * Map doctorType to the correct where clause for finding existing ledger entries.
 */
function doctorIdWhereClause(doctorType: PayoutDoctorType, doctorId: string) {
  switch (doctorType) {
    case 'REFERRAL':
      return { referralDoctorId: doctorId };
    case 'CLINIC':
      return { clinicDoctorId: doctorId };
    case 'PARTNER':
      return { partnerId: doctorId };
    default:
      throw new Error(`Unsupported doctor type: ${doctorType}`);
  }
}

/**
 * Extract doctorId from a payout ledger record.
 */
// Typed, not `any`. It was `any`, which is how the fallback went on reading
// `diagnosticCenterId` — a column the partner migration dropped — for months
// after DIAGNOSTIC_CENTER and LAB stopped existing. Every PARTNER payout came
// back with an undefined doctorId and nothing failed loudly enough to notice.
function extractDoctorId(payout: {
  doctorType: PayoutDoctorType;
  referralDoctorId: string | null;
  clinicDoctorId: string | null;
  partnerId: string | null;
}): string {
  if (payout.doctorType === 'REFERRAL') return payout.referralDoctorId!;
  if (payout.doctorType === 'CLINIC') return payout.clinicDoctorId!;
  return payout.partnerId!;
}

/**
 * Extract doctorName from included relations.
 */
function extractDoctorName(payout: any): string {
  return (
    payout.referralDoctor?.name ||
    payout.clinicDoctor?.name ||
    payout.partner?.name ||
    'Unknown'
  );
}

function buildDayPeriod(date: Date) {
  const periodStartDate = new Date(date);
  periodStartDate.setHours(0, 0, 0, 0);

  const periodEndDate = new Date(date);
  periodEndDate.setHours(23, 59, 59, 999);

  return {
    periodStartDate,
    periodEndDate,
  };
}


async function syncReferralPayoutsForBranch(
  branchId: string,
  filters?: {
    doctorType?: PayoutDoctorType;
    doctorId?: string;
    startDate?: Date;
    endDate?: Date;
  }
) {
  if (filters?.doctorType && filters.doctorType !== 'REFERRAL') return;

  const visits = await prisma.visit.findMany({
    where: {
      branchId,
      domain: 'DIAGNOSTICS',
      referrals: {
        some: {
          deletedAt: null,
          ...(filters?.doctorId ? { referralDoctorId: filters.doctorId } : {}),
        },
      },
      ...buildDiagnosticPayoutVisitWindow(
        filters?.startDate ?? defaultSyncWindowStart(),
        filters?.endDate ?? new Date('9999-12-31T23:59:59.999Z')
      ),
    },
    select: {
      updatedAt: true,
      referrals: {
        where: { deletedAt: null },
        select: {
          referralDoctorId: true,
        },
      },
      report: {
        select: {
          versions: {
            where: {
              status: 'FINALIZED',
            },
            orderBy: {
              versionNum: 'desc',
            },
            take: 1,
            select: {
              finalizedAt: true,
            },
          },
        },
      },
    },
  });

  const periods = new Map<
    string,
    { doctorId: string; periodStartDate: Date; periodEndDate: Date }
  >();

  for (const visit of visits) {
    const referralDoctorId = visit.referrals[0]?.referralDoctorId;
    const finalizedAt = visit.report?.versions[0]?.finalizedAt || visit.updatedAt;

    if (!referralDoctorId || !finalizedAt) {
      continue;
    }

    const { periodStartDate, periodEndDate } = buildDayPeriod(finalizedAt);
    periods.set(`${referralDoctorId}:${periodStartDate.toISOString()}`, {
      doctorId: referralDoctorId,
      periodStartDate,
      periodEndDate,
    });
  }

  for (const period of periods.values()) {
    // Auto-sync must respect deletions: if the owner soft-deleted a payout
    // for this (doctor, period), don't recreate it on every list refresh.
    // Manual derive (Single Payout / Run Cycle) still creates a fresh row.
    const anyExisting = await prisma.doctorPayoutLedger.findFirst({
      where: {
        doctorType: 'REFERRAL',
        referralDoctorId: period.doctorId,
        branchId,
        periodStartDate: period.periodStartDate,
        periodEndDate: period.periodEndDate,
      },
      select: { id: true },
    });
    if (anyExisting) continue;

    await derivePayout(
      'REFERRAL',
      period.doctorId,
      branchId,
      period.periodStartDate,
      period.periodEndDate
    );
  }
}

/**
 * Keep partner ledger rows fresh for a branch.
 *
 * Replaces the separate diagnostic-centre and outside-lab syncs. One pass driven
 * by TestOrder.partnerId now covers every arrangement, because a partner order is
 * a partner order whichever way the work and the money flowed.
 */
async function syncPartnerPayoutsForBranch(
  branchId: string,
  filters?: {
    doctorType?: PayoutDoctorType;
    doctorId?: string;
    startDate?: Date;
    endDate?: Date;
  }
) {
  if (filters?.doctorType && filters.doctorType !== 'PARTNER') return;

  const partnerOrderWhere = filters?.doctorId
    ? { partnerId: filters.doctorId }
    : { partnerId: { not: null } };

  const visits = await prisma.visit.findMany({
    where: {
      branchId,
      domain: 'DIAGNOSTICS',
      testOrders: { some: partnerOrderWhere },
      ...buildDiagnosticPayoutVisitWindow(
        filters?.startDate ?? defaultSyncWindowStart(),
        filters?.endDate ?? new Date('9999-12-31T23:59:59.999Z')
      ),
    },
    select: {
      updatedAt: true,
      testOrders: { where: partnerOrderWhere, select: { partnerId: true } },
      report: {
        select: {
          versions: {
            where: { status: 'FINALIZED' },
            orderBy: { versionNum: 'desc' },
            take: 1,
            select: { finalizedAt: true },
          },
        },
      },
    },
  });

  const periods = new Map<
    string,
    { doctorId: string; periodStartDate: Date; periodEndDate: Date }
  >();

  for (const visit of visits) {
    const finalizedAt = visit.report?.versions[0]?.finalizedAt || visit.updatedAt;
    if (!finalizedAt) continue;

    const { periodStartDate, periodEndDate } = buildDayPeriod(finalizedAt);
    const partnerIds = new Set<string>();
    for (const order of visit.testOrders) {
      if (order.partnerId) partnerIds.add(order.partnerId);
    }
    for (const partnerId of partnerIds) {
      periods.set(`${partnerId}:${periodStartDate.toISOString()}`, {
        doctorId: partnerId,
        periodStartDate,
        periodEndDate,
      });
    }
  }

  for (const period of periods.values()) {
    // Auto-sync respects deletions — see comment in syncReferralPayoutsForBranch.
    const anyExisting = await prisma.doctorPayoutLedger.findFirst({
      where: {
        doctorType: 'PARTNER',
        partnerId: period.doctorId,
        branchId,
        periodStartDate: period.periodStartDate,
        periodEndDate: period.periodEndDate,
      },
      select: { id: true },
    });
    if (anyExisting) continue;

    await derivePayout(
      'PARTNER',
      period.doctorId,
      branchId,
      period.periodStartDate,
      period.periodEndDate
    );
  }
}

// ===========================================================================
// EXPORTED SERVICE FUNCTIONS
// ===========================================================================

/**
 * Derive and save a new payout ledger entry.
 * Existing unpaid entries are refreshed so the ledger stays in sync with
 * newly completed/finalized work in the same period.
 */
export async function derivePayout(
  doctorType: PayoutDoctorType,
  doctorId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<{ payout: PayoutDetail; isNew: boolean }> {
  // Check if payout already exists (only among non-deleted rows; a soft-deleted
  // row for the same (doctor, period) is allowed to be re-derived).
  const existing = await prisma.doctorPayoutLedger.findFirst({
    where: {
      doctorType,
      ...doctorIdWhereClause(doctorType, doctorId),
      branchId,
      deletedAt: null,
      periodStartDate,
      periodEndDate,
    },
    include: {
      referralDoctor: { select: { name: true } },
      clinicDoctor: { select: { name: true } },
      partner: { select: { name: true } },
      branch: { select: { name: true } },
    },
  });

  if (existing) {
    const derivation = await deriveByType(doctorType, doctorId, branchId, periodStartDate, periodEndDate);
    // Re-derivation OVERWRITES in place, and it is not as safe as it looks.
    // The commission RATE is snapshotted on TestOrder at order time, but two
    // inputs are read live and both move after a period closes:
    //   - the bill discount, allocated across orders below to cut commission —
    //     a concession granted at collection time lands days after finalization
    //   - cancelledAt, which drops an order's commission entirely — and 69 of
    //     the last 89 cancels happened AFTER the report was finalized
    // So a statement can change after the doctor was handed it. Nothing records
    // that it moved: derivedAmountInPaise is replaced and the old value is gone.
    // Tolerable only because this is a BOOK, not a payment record (settlement
    // state was removed 16 Sep — 6 of 1,602 rows ever marked paid). If payouts
    // ever need to answer "what did we pay against", the line items have to be
    // snapshotted here rather than re-derived on read.
    // ponytail: no line-item history. Snapshot lineItems if a statement ever
    // has to be reproducible after the fact.
    const nextData: { derivedAmountInPaise?: number; derivedAt?: Date } = {};
    if (existing.derivedAmountInPaise !== derivation.derivedAmountInPaise) {
      nextData.derivedAmountInPaise = derivation.derivedAmountInPaise;
      nextData.derivedAt = new Date();
    }

    const refreshedExisting =
      Object.keys(nextData).length > 0
        ? await prisma.doctorPayoutLedger.update({
            where: { id: existing.id },
            data: nextData,
            include: {
              referralDoctor: { select: { name: true } },
              clinicDoctor: { select: { name: true } },
              partner: { select: { name: true } },
              branch: { select: { name: true } },
            },
          })
        : existing;

    return {
      payout: {
        id: refreshedExisting.id,
        doctorType: refreshedExisting.doctorType,
        doctorId: extractDoctorId(refreshedExisting),
        doctorName: extractDoctorName(refreshedExisting),
        branchId: refreshedExisting.branchId,
        branchName: refreshedExisting.branch.name,
        periodStartDate: refreshedExisting.periodStartDate,
        periodEndDate: refreshedExisting.periodEndDate,
        derivedAmountInPaise: refreshedExisting.derivedAmountInPaise,
        derivedAt: refreshedExisting.derivedAt,
        notes: refreshedExisting.notes,
        lineItems: derivation.lineItems,
      },
      isNew: false,
    };
  }

  // Derive new payout
  const derivation = await deriveByType(doctorType, doctorId, branchId, periodStartDate, periodEndDate);

  // Create new ledger entry
  const newPayout = await prisma.doctorPayoutLedger.create({
    data: {
      doctorType,
      referralDoctorId: doctorType === 'REFERRAL' ? doctorId : null,
      clinicDoctorId: doctorType === 'CLINIC' ? doctorId : null,
      partnerId: doctorType === 'PARTNER' ? doctorId : null,
      branchId,
      periodStartDate,
      periodEndDate,
      derivedAmountInPaise: derivation.derivedAmountInPaise,
      derivedAt: new Date(),
    },
    include: {
      branch: { select: { name: true } },
    },
  });

  return {
    payout: {
      id: newPayout.id,
      doctorType: newPayout.doctorType,
      doctorId,
      doctorName: derivation.doctorName,
      branchId: newPayout.branchId,
      branchName: newPayout.branch.name,
      periodStartDate: newPayout.periodStartDate,
      periodEndDate: newPayout.periodEndDate,
      derivedAmountInPaise: newPayout.derivedAmountInPaise,
      derivedAt: newPayout.derivedAt,
      notes: newPayout.notes,
      lineItems: derivation.lineItems,
    },
    isNew: true,
  };
}

/**
 * Get all payouts for a branch with optional filters.
 */
export type PayoutSortField = 'derivedAt' | 'doctorName' | 'amount' | 'periodStart';
export type SortDir = 'asc' | 'desc';

export interface ListPayoutsFilters {
  doctorType?: PayoutDoctorType;
  doctorId?: string;
  startDate?: Date;
  endDate?: Date;
  q?: string;                  // free-text search (doctor name, reference id)
  page?: number;               // 1-based
  pageSize?: number;           // default 50
  sortBy?: PayoutSortField;    // default derivedAt
  sortDir?: SortDir;           // default desc
  // Sum-totals are computed across the FULL filtered set, not just the page,
  // so the summary cards stay correct when paginated.
  includeTotals?: boolean;
}

export interface ListPayoutsResult {
  rows: PayoutSummary[];
  total: number;
  page: number;
  pageSize: number;
  totals?: {
    accruedCount: number;
    accruedAmountInPaise: number;
  };
}

export async function listPayouts(
  branchId: string,
  filters?: ListPayoutsFilters
): Promise<ListPayoutsResult> {
  await syncReferralPayoutsForBranch(branchId, filters);
  await syncPartnerPayoutsForBranch(branchId, filters);

  const page = Math.max(1, filters?.page ?? 1);
  const pageSize = Math.min(500, Math.max(1, filters?.pageSize ?? 50));
  const sortBy: PayoutSortField = filters?.sortBy ?? 'derivedAt';
  const sortDir: SortDir = filters?.sortDir ?? 'desc';

  const doctorIdFilter = filters?.doctorId
    ? filters.doctorType
      ? doctorIdWhereClause(filters.doctorType, filters.doctorId)
      : {
          OR: [
            { referralDoctorId: filters.doctorId },
            { clinicDoctorId: filters.doctorId },
            { partnerId: filters.doctorId },
          ],
        }
    : {};

  // Free-text search: matches doctor name across all three doctor tables OR
  // payment reference id. Case-insensitive substring match.
  const q = filters?.q?.trim();
  const searchFilter = q
    ? {
        OR: [
          { referralDoctor: { name: { contains: q, mode: 'insensitive' as const } } },
          { clinicDoctor: { name: { contains: q, mode: 'insensitive' as const } } },
          { partner: { name: { contains: q, mode: 'insensitive' as const } } },
        ],
      }
    : {};

  const where: Prisma.DoctorPayoutLedgerWhereInput = {
    branchId,
    deletedAt: null,
    ...(filters?.doctorType && { doctorType: filters.doctorType }),
    ...doctorIdFilter,
    ...(filters?.startDate && { periodStartDate: { gte: filters.startDate } }),
    ...(filters?.endDate && { periodEndDate: { lte: filters.endDate } }),
    ...searchFilter,
  };

  // Map sort field to Prisma orderBy.
  // Doctor-name sort: ordering by a relation field requires multiple orderBys
  // because a row only has ONE of three doctor relations populated. Using
  // [referralDoctor, clinicDoctor, diagnosticCenter] in order makes Prisma sort
  // by whichever name is set per row (the others are null and sort to one end).
  const orderBy: Prisma.DoctorPayoutLedgerOrderByWithRelationInput[] = (() => {
    switch (sortBy) {
      case 'amount':
        return [{ derivedAmountInPaise: sortDir }];
      case 'periodStart':
        return [{ periodStartDate: sortDir }];
      case 'doctorName':
        return [
          { referralDoctor: { name: sortDir } },
          { clinicDoctor: { name: sortDir } },
          { partner: { name: sortDir } },
        ];
      case 'derivedAt':
      default:
        return [{ derivedAt: sortDir }];
    }
  })();

  const [payouts, total, totalsAgg] = await Promise.all([
    prisma.doctorPayoutLedger.findMany({
      where,
      include: {
        referralDoctor: { select: { name: true } },
        clinicDoctor: { select: { name: true } },
        partner: { select: { name: true } },
        branch: { select: { name: true } },
      },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.doctorPayoutLedger.count({ where }),
    filters?.includeTotals
      ? prisma.doctorPayoutLedger.aggregate({
          where,
          _count: true,
          _sum: { derivedAmountInPaise: true },
        })
      : Promise.resolve(null),
  ]);

  const summaries = payouts.map((p) => ({
    id: p.id,
    doctorType: p.doctorType,
    doctorId: extractDoctorId(p),
    doctorName: extractDoctorName(p),
    branchId: p.branchId,
    branchName: p.branch.name,
    periodStartDate: p.periodStartDate,
    periodEndDate: p.periodEndDate,
    derivedAmountInPaise: p.derivedAmountInPaise,
    derivedAt: p.derivedAt,
  }));

  let totals: ListPayoutsResult['totals'] | undefined;
  if (totalsAgg) {
    // The ledger is a book of what accrued, so there is no paid/pending split
    // left to make — one accrued figure for the filtered set.
    totals = {
      accruedCount: totalsAgg._count,
      accruedAmountInPaise: totalsAgg._sum.derivedAmountInPaise ?? 0,
    };
  }

  return { rows: summaries, total, page, pageSize, totals };
}

/**
 * Get detailed payout information including line items.
 */
export async function getPayoutDetail(payoutId: string): Promise<PayoutDetail | null> {
  const payout = await prisma.doctorPayoutLedger.findUnique({
    where: { id: payoutId },
    include: {
      referralDoctor: { select: { name: true } },
      clinicDoctor: { select: { name: true } },
      partner: { select: { name: true } },
      branch: { select: { name: true } },
    },
  });

  // Soft-deleted rows are invisible: callers see this as "not found".
  if (!payout || payout.deletedAt) return null;

  const doctorId = extractDoctorId(payout);

  // Re-derive line items for display (amounts frozen in ledger)
  const derivation = await deriveByType(
    payout.doctorType,
    doctorId,
    payout.branchId,
    payout.periodStartDate,
    payout.periodEndDate
  );

  return {
    id: payout.id,
    doctorType: payout.doctorType,
    doctorId,
    doctorName: extractDoctorName(payout),
    branchId: payout.branchId,
    branchName: payout.branch.name,
    periodStartDate: payout.periodStartDate,
    periodEndDate: payout.periodEndDate,
    derivedAmountInPaise: payout.derivedAmountInPaise,
    derivedAt: payout.derivedAt,
    notes: payout.notes,
    lineItems: derivation.lineItems,
  };
}

// ===========================================================================
// STATEMENT DETAIL (category-banded, for the per-payee statement page/print)
// ===========================================================================

export interface StatementTotals {
  tAmtInPaise: number;
  discInPaise: number;
  pAmtInPaise: number;
  finAmtInPaise: number;
  labCostInPaise?: number;
  centerMarginInPaise?: number;
}

export interface StatementRow {
  visitId: string;
  date: Date;
  billNumber: string;
  patientTitle?: string | null;
  patientName: string;
  testOrFee: string;
  category: PayoutCategory;
  basisLabel: string;
  tAmtInPaise: number;
  discInPaise: number;
  pAmtInPaise: number;
  finAmtInPaise: number;
  labCostInPaise?: number;
  centerMarginInPaise?: number;
}

export interface StatementBand {
  category: PayoutCategory;
  label: string;
  rows: StatementRow[];
  subtotal: StatementTotals;
}

export interface PayoutStatement {
  id: string;
  payeeType: PayoutDoctorType;
  direction: 'INBOUND' | 'OUTBOUND';
  payeeId: string;
  payeeName: string;
  branchName: string;
  periodStartDate: Date;
  periodEndDate: Date;
  isLab: boolean;
  whatsappEnabled?: boolean;
  payeeHasPhone?: boolean;
  bands: StatementBand[];
  grandTotal: StatementTotals;
  lab?: {
    labId: string;
    vendorCostInPaise: number;
    billedToPatientInPaise: number;
    marginInPaise: number;
    marginPct: number;
  };
}

function emptyStatementTotals(isLab: boolean): StatementTotals {
  return isLab
    ? { tAmtInPaise: 0, discInPaise: 0, pAmtInPaise: 0, finAmtInPaise: 0, labCostInPaise: 0, centerMarginInPaise: 0 }
    : { tAmtInPaise: 0, discInPaise: 0, pAmtInPaise: 0, finAmtInPaise: 0 };
}

/**
 * Reshape a derived PayoutDetail into a category-banded statement
 * (LAB/XRAY/USG/ECG/SPL) with per-band subtotals + a grand total. Column
 * identity holds per row: tAmt − disc = pAmt; finAmt = commission (or lab cost).
 */
export function buildPayoutStatementDetail(detail: PayoutDetail): PayoutStatement {
  const isLab = detail.doctorType === 'PARTNER';
  const bandsByCategory = new Map<PayoutCategory, StatementBand>();
  const grandTotal = emptyStatementTotals(isLab);

  for (const item of detail.lineItems) {
    const category: PayoutCategory = item.category ?? CAT_LAB;
    const pAmt = item.amountInPaise;
    const disc = item.discountInPaise ?? 0;
    const tAmt = pAmt + disc;
    const fin = item.derivedCommissionInPaise;

    let band = bandsByCategory.get(category);
    if (!band) {
      band = { category, label: categoryLabel(category), rows: [], subtotal: emptyStatementTotals(isLab) };
      bandsByCategory.set(category, band);
    }

    band.rows.push({
      visitId: item.visitId,
      date: item.date,
      billNumber: item.billNumber,
      patientTitle: item.patientTitle,
      patientName: item.patientName,
      testOrFee: item.testOrFee,
      category,
      basisLabel: item.basisLabel ?? '',
      tAmtInPaise: tAmt,
      discInPaise: disc,
      pAmtInPaise: pAmt,
      finAmtInPaise: fin,
      ...(isLab && {
        labCostInPaise: item.labCostInPaise ?? fin,
        centerMarginInPaise: item.centerMarginInPaise ?? 0,
      }),
    });

    band.subtotal.tAmtInPaise += tAmt;
    band.subtotal.discInPaise += disc;
    band.subtotal.pAmtInPaise += pAmt;
    band.subtotal.finAmtInPaise += fin;
    grandTotal.tAmtInPaise += tAmt;
    grandTotal.discInPaise += disc;
    grandTotal.pAmtInPaise += pAmt;
    grandTotal.finAmtInPaise += fin;
    if (isLab) {
      const lc = item.labCostInPaise ?? fin;
      const cm = item.centerMarginInPaise ?? 0;
      band.subtotal.labCostInPaise = (band.subtotal.labCostInPaise ?? 0) + lc;
      band.subtotal.centerMarginInPaise = (band.subtotal.centerMarginInPaise ?? 0) + cm;
      grandTotal.labCostInPaise = (grandTotal.labCostInPaise ?? 0) + lc;
      grandTotal.centerMarginInPaise = (grandTotal.centerMarginInPaise ?? 0) + cm;
    }
  }

  // Order by the preferred category list (Lab, X-Ray, USG, ECG, CT/MRI), then
  // any custom categories alphabetically.
  const bands = Array.from(bandsByCategory.values()).sort((a, b) => {
    const ia = CATEGORY_ORDER.indexOf(a.category);
    const ib = CATEGORY_ORDER.indexOf(b.category);
    if (ia !== -1 || ib !== -1) {
      return (ia === -1 ? Infinity : ia) - (ib === -1 ? Infinity : ib);
    }
    return a.category.localeCompare(b.category);
  });

  const statement: PayoutStatement = {
    id: detail.id,
    payeeType: detail.doctorType,
    direction: isLab ? 'OUTBOUND' : 'INBOUND',
    payeeId: detail.doctorId,
    payeeName: detail.doctorName,
    branchName: detail.branchName,
    periodStartDate: detail.periodStartDate,
    periodEndDate: detail.periodEndDate,
    isLab,
    bands,
    grandTotal,
  };

  if (isLab) {
    const billedToPatientInPaise = grandTotal.pAmtInPaise;
    const vendorCostInPaise = grandTotal.labCostInPaise ?? grandTotal.finAmtInPaise;
    const marginInPaise = grandTotal.centerMarginInPaise ?? billedToPatientInPaise - vendorCostInPaise;
    statement.lab = {
      labId: detail.doctorId,
      vendorCostInPaise,
      billedToPatientInPaise,
      marginInPaise,
      marginPct:
        billedToPatientInPaise > 0 ? Math.round((marginInPaise / billedToPatientInPaise) * 100) : 0,
    };
  }

  return statement;
}

/**
 * Load a payout and return its category-banded statement. Returns null if the
 * payout is missing, soft-deleted, or belongs to a different branch.
 */
export async function getPayoutStatement(
  payoutId: string,
  branchId: string
): Promise<PayoutStatement | null> {
  const detail = await getPayoutDetail(payoutId);
  if (!detail || detail.branchId !== branchId) return null;
  const statement = buildPayoutStatementDetail(detail);
  statement.whatsappEnabled = isWhatsAppEnabled();
  statement.payeeHasPhone = Boolean(await getPayoutPayeePhone(payoutId));
  return statement;
}

// ===========================================================================
// RANGE-BASED STATEMENT / DETAIL (per doctor, over the selected date range)
// ---------------------------------------------------------------------------
// The Pay-Run worklist groups per doctor and links to the date range at the
// top of the page, so a statement must cover the WHOLE selected range (not a
// single day's ledger row). These helpers derive line items live over
// [startDate, endDate] and reshape them, bypassing the per-day ledger. The
// synthetic id `TYPE.payeeId` lets the frontend round-trip a doctor identity
// through the same statement page without a persisted ledger row.
// ===========================================================================

async function buildRangeDetail(
  payeeType: PayoutDoctorType,
  payeeId: string,
  branchId: string,
  startDate: Date,
  endDate: Date
): Promise<PayoutDetail> {
  const [derivation, branch] = await Promise.all([
    deriveByType(payeeType, payeeId, branchId, startDate, endDate),
    prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }),
  ]);

  return {
    id: `${payeeType}.${payeeId}`,
    doctorType: payeeType,
    doctorId: payeeId,
    doctorName: derivation.doctorName,
    branchId,
    branchName: branch?.name ?? '',
    periodStartDate: startDate,
    periodEndDate: endDate,
    derivedAmountInPaise: derivation.derivedAmountInPaise,
    derivedAt: startDate,
    notes: null,
    lineItems: derivation.lineItems,
  };
}

/**
 * Per-doctor payout detail for an arbitrary date range (drives the range Excel
 * export). Throws if the doctor/lab id is unknown.
 */
export async function getPayoutDetailForDoctorRange(
  payeeType: PayoutDoctorType,
  payeeId: string,
  branchId: string,
  startDate: Date,
  endDate: Date
): Promise<PayoutDetail> {
  return buildRangeDetail(payeeType, payeeId, branchId, startDate, endDate);
}

/**
 * Per-doctor banded statement for an arbitrary date range. Range statements are
 * not tokenised for WhatsApp, so whatsappEnabled/payeeHasPhone are false (the
 * UI hides the WhatsApp button in this mode).
 */
export async function getPayoutStatementForDoctorRange(
  payeeType: PayoutDoctorType,
  payeeId: string,
  branchId: string,
  startDate: Date,
  endDate: Date
): Promise<PayoutStatement> {
  const detail = await buildRangeDetail(payeeType, payeeId, branchId, startDate, endDate);
  const statement = buildPayoutStatementDetail(detail);
  statement.whatsappEnabled = false;
  statement.payeeHasPhone = false;
  return statement;
}

/**
 * Resolve the payee's phone for a payout (referral doctor / clinic / diagnostic
 * center / outside lab), by doctorType. Returns null if not set.
 */
export async function getPayoutPayeePhone(payoutId: string): Promise<string | null> {
  const p = await prisma.doctorPayoutLedger.findUnique({
    where: { id: payoutId },
    include: {
      referralDoctor: { select: { phone: true } },
      clinicDoctor: { select: { phone: true } },
      partner: { select: { phone: true } },
    },
  });
  if (!p) return null;
  switch (p.doctorType) {
    case 'REFERRAL':
      return p.referralDoctor?.phone ?? null;
    case 'CLINIC':
      return p.clinicDoctor?.phone ?? null;
    case 'PARTNER':
      return p.partner?.phone ?? null;
    default:
      return null;
  }
}

// ===========================================================================
// PAY-RUN WORKLIST (grouped who-I-owe view with two non-netting hero totals)
// ===========================================================================

export type PayoutDirection = 'INBOUND' | 'OUTBOUND';
export type PayoutKind = 'COMMISSION' | 'PAYABLE' | 'RECEIVABLE';

export interface PayoutWorklistRow {
  id: string;
  payeeType: PayoutDoctorType;
  direction: PayoutDirection;
  kind: PayoutKind;
  payeeId: string;
  payeeName: string;
  periodStartDate: Date;
  periodEndDate: Date;
  amountInPaise: number;
  /// True when this figure is a STALE stored per-day sum, not a live derive —
  /// either the derive threw, or no range was given to derive over. Surfaced so
  /// the screen can mark it rather than presenting it as trustworthy.
  stale: boolean;
}

export interface PayoutTypeTotals {
  count: number;
  amountInPaise: number;
}

export interface PayRunWorklistFilters {
  startDate?: Date;
  endDate?: Date;
  payeeType?: PayoutDoctorType;
  q?: string;
  view?: 'grouped' | 'flat';
}

export interface PayRunWorklistGroup {
  payeeType: PayoutDoctorType;
  direction: PayoutDirection;
  subtotalInPaise: number;
  rows: PayoutWorklistRow[];
}

export interface PayRunWorklist {
  period: { startDate: Date | null; endDate: Date | null };
  view: 'grouped' | 'flat';
  totals: {
    commissionsTotalInPaise: number;
    /// What we owe partners: vendor rates, and their cut on work we billed.
    partnerPayableInPaise: number;
    /// What partners owe US: our share on work THEY billed and collected.
    /// Kept as its own positive number rather than a negative payable — money
    /// coming in is not money going out with a minus sign in front of it.
    partnerReceivableInPaise: number;
    payeeCount: number;
    byType: Record<PayoutDoctorType, PayoutTypeTotals>;
  };
  groups: PayRunWorklistGroup[];
  rows: PayoutWorklistRow[];
}

const PAYOUT_TYPES_ORDER: PayoutDoctorType[] = ['REFERRAL', 'CLINIC', 'PARTNER'];

export async function getPayRunWorklist(
  branchId: string,
  filters?: PayRunWorklistFilters
): Promise<PayRunWorklist> {
  const view = filters?.view ?? 'grouped';

  // Keep the ledger fresh (same auto-sync as listPayouts).
  const syncFilters = {
    doctorType: filters?.payeeType,
    startDate: filters?.startDate,
    endDate: filters?.endDate,
  };
  await syncReferralPayoutsForBranch(branchId, syncFilters);
  await syncPartnerPayoutsForBranch(branchId, syncFilters);

  const q = filters?.q?.trim();
  const where: Prisma.DoctorPayoutLedgerWhereInput = {
    branchId,
    deletedAt: null,
    ...(filters?.payeeType && { doctorType: filters.payeeType }),
    ...(filters?.startDate && { periodStartDate: { gte: filters.startDate } }),
    ...(filters?.endDate && { periodEndDate: { lte: filters.endDate } }),
    ...(q && {
      OR: [
        { referralDoctor: { name: { contains: q, mode: 'insensitive' as const } } },
        { clinicDoctor: { name: { contains: q, mode: 'insensitive' as const } } },
        { partner: { name: { contains: q, mode: 'insensitive' as const } } },
      ],
    }),
  };

  const payouts = await prisma.doctorPayoutLedger.findMany({
    where,
    include: {
      referralDoctor: { select: { name: true } },
      clinicDoctor: { select: { name: true } },
      partner: { select: { name: true } },
      branch: { select: { name: true } },
    },
    orderBy: [{ derivedAmountInPaise: 'desc' }],
  });

  // Collapse the per-day ledger rows to the distinct payees active in the range.
  // The ledger stores a row per (doctor, day) for audit/soft-delete and serves
  // as the fast index of "who had activity this period".
  const payeeIndex = new Map<
    string,
    { payeeType: PayoutDoctorType; payeeId: string; payeeName: string; storedSumInPaise: number }
  >();
  for (const p of payouts) {
    const payeeId = extractDoctorId(p);
    const key = `${p.doctorType}.${payeeId}`;
    const entry = payeeIndex.get(key);
    if (entry) {
      entry.storedSumInPaise += p.derivedAmountInPaise;
    } else {
      payeeIndex.set(key, {
        payeeType: p.doctorType,
        payeeId,
        payeeName: extractDoctorName(p),
        storedSumInPaise: p.derivedAmountInPaise,
      });
    }
  }

  // The worklist is grouped per doctor and linked to the date range at the top,
  // so each payee shows exactly once. Derive every payee's amount FRESH over the
  // whole range so the list total matches the statement and Excel exactly (both
  // derive live) — the stored per-day ledger amounts can lag a rate/discount
  // rule change until a row is re-derived. Bounded concurrency keeps the DB from
  // being hit with one burst per payee.
  const fallbackStart = filters?.startDate ?? payouts[0]?.periodStartDate ?? new Date();
  const fallbackEnd = filters?.endDate ?? payouts[0]?.periodEndDate ?? new Date();
  const canDeriveRange = Boolean(filters?.startDate && filters?.endDate);
  const entries = Array.from(payeeIndex.values());
  const amounts = new Array<number>(entries.length);
  // A payee whose live derive failed is showing a STALE stored sum. Tracked so
  // the screen can say so instead of presenting it as a derived figure.
  const staleFallback = new Array<boolean>(entries.length).fill(false);
  const CONCURRENCY = 6;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const slice = entries.slice(i, i + CONCURRENCY);
    const sliceAmounts = await Promise.all(
      slice.map(async (e): Promise<{ amount: number; stale: boolean }> => {
        // Without a range there is nothing to derive over, so the stored sum is
        // the honest answer — but it is still not a derived one.
        if (!canDeriveRange) return { amount: e.storedSumInPaise, stale: true };
        try {
          const d = await deriveByType(
            e.payeeType,
            e.payeeId,
            branchId,
            filters!.startDate!,
            filters!.endDate!
          );
          return { amount: d.derivedAmountInPaise, stale: false };
        } catch (err) {
          // A missing/renamed payee must not sink the whole worklist — but a
          // silent fallback is worse than a gap. This is how Lalitha showed
          // ₹379.66 of stale per-day rows while a live derive over the same
          // range returned ₹9,660: a wrong number that looked exactly like a
          // right one. Say so, loudly, in the log and on the row.
          logger.error(
            { err, payeeType: e.payeeType, payeeId: e.payeeId, branchId },
            'pay-run: live derive failed, falling back to the stored per-day sum — this figure is STALE',
          );
          return { amount: e.storedSumInPaise, stale: true };
        }
      })
    );
    for (let j = 0; j < sliceAmounts.length; j++) {
      amounts[i + j] = sliceAmounts[j].amount;
      staleFallback[i + j] = sliceAmounts[j].stale;
    }
  }

  const rows: PayoutWorklistRow[] = entries
    .map((e, idx) => {
      // A partner nets both directions into one figure, so the sign — not the
      // payee type — says whether we pay them or they owe us.
      const isPartner = e.payeeType === 'PARTNER';
      const owesUs = isPartner && amounts[idx] < 0;
      return {
        id: `${e.payeeType}.${e.payeeId}`,
        payeeType: e.payeeType,
        direction: (isPartner ? 'OUTBOUND' : 'INBOUND') as PayoutDirection,
        kind: (owesUs ? 'RECEIVABLE' : isPartner ? 'PAYABLE' : 'COMMISSION') as PayoutKind,
        payeeId: e.payeeId,
        payeeName: e.payeeName,
        periodStartDate: fallbackStart,
        periodEndDate: fallbackEnd,
        amountInPaise: amounts[idx],
        stale: staleFallback[idx],
      };
    })
    .sort((a, b) => b.amountInPaise - a.amountInPaise);

  // Totals are simply what's owed for the period (no paid/unpaid concept).
  const byType = Object.fromEntries(
    PAYOUT_TYPES_ORDER.map((t) => [t, { count: 0, amountInPaise: 0 }])
  ) as Record<PayoutDoctorType, PayoutTypeTotals>;

  let commissionsTotal = 0;
  let partnerPayable = 0;
  let partnerReceivable = 0;
  for (const r of rows) {
    const bt = byType[r.payeeType];
    bt.count += 1;
    bt.amountInPaise += r.amountInPaise;
    if (r.payeeType !== 'PARTNER') {
      commissionsTotal += r.amountInPaise;
      continue;
    }
    // A partner row is netted and signed: positive = we pay them, negative =
    // they owe us. Split into two positive figures so neither headline ever has
    // to render a minus sign.
    if (r.amountInPaise >= 0) partnerPayable += r.amountInPaise;
    else partnerReceivable += -r.amountInPaise;
  }

  const groups: PayRunWorklistGroup[] = PAYOUT_TYPES_ORDER.map((t) => {
    const groupRows = rows.filter((r) => r.payeeType === t);
    return {
      payeeType: t,
      direction: (t === 'PARTNER' ? 'OUTBOUND' : 'INBOUND') as PayoutDirection,
      subtotalInPaise: groupRows.reduce((s, r) => s + r.amountInPaise, 0),
      rows: groupRows,
    };
  }).filter((g) => g.rows.length > 0);

  return {
    period: { startDate: filters?.startDate ?? null, endDate: filters?.endDate ?? null },
    view,
    totals: {
      commissionsTotalInPaise: commissionsTotal,
      partnerPayableInPaise: partnerPayable,
      partnerReceivableInPaise: partnerReceivable,
      payeeCount: rows.length,
      byType,
    },
    groups,
    rows,
  };
}


/**
 * Get referral doctors for dropdown selection.
 * Doctors are global by design (a referral doctor can refer patients to any
 * branch), so by default all are returned. Pass `branchId` to scope to those
 * who actually have payout activity in that branch — useful for the per-branch
 * payouts UI to filter out inactive doctors who never refer here.
 */
export async function getReferralDoctors(isActive?: boolean, branchId?: string) {
  const where: any = isActive !== undefined ? { isActive } : {};
  if (branchId) {
    where.payoutLedger = { some: { branchId } };
  }
  return prisma.referralDoctor.findMany({
    where,
    select: {
      id: true,
      doctorNumber: true,
      name: true,
      commissionType: true,
      commissionPercent: true,
      commissionAmountInPaise: true,
      isActive: true,
    },
    orderBy: { name: 'asc' },
  });
}

/**
 * Get clinic doctors for dropdown selection. See note above on branchId.
 */
export async function getClinicDoctors(isActive?: boolean, branchId?: string) {
  const where: any = isActive !== undefined ? { isActive } : {};
  if (branchId) {
    where.payoutLedger = { some: { branchId } };
  }
  return prisma.clinicDoctor.findMany({
    where,
    select: {
      id: true,
      doctorNumber: true,
      name: true,
      specialty: true,
      isActive: true,
    },
    orderBy: { name: 'asc' },
  });
}

/**
 * Get partners for dropdown selection. See note above on branchId.
 */
export async function getPartners(isActive?: boolean, branchId?: string) {
  const where: any = isActive !== undefined ? { isActive } : {};
  if (branchId) {
    where.payoutLedger = { some: { branchId } };
  }
  return prisma.partner.findMany({
    where,
    select: {
      id: true,
      partnerNumber: true,
      name: true,
      sendBill: true,
      sendReport: true,
      isActive: true,
      arrangements: {
        where: { isActive: true },
        select: { kind: true, weCollect: true, rateBasis: true, ratePercent: true, rateAmountInPaise: true },
      },
    },
    orderBy: { name: 'asc' },
  });
}

// ===========================================================================
// SOFT DELETE
// ===========================================================================

/**
 * Soft-delete a single payout. Hidden from every read (list, detail, summary,
 * exports, doctor pivot). Re-deriving the same (doctor, period) afterwards is
 * permitted because the partial unique index ignores deleted rows.
 *
 * Returns the updated row's id (or null if not found / already deleted).
 */
export async function softDeletePayout(
  payoutId: string,
  branchId: string
): Promise<{ id: string } | null> {
  const result = await prisma.doctorPayoutLedger.updateMany({
    where: { id: payoutId, branchId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return result.count > 0 ? { id: payoutId } : null;
}

/**
 * Bulk soft-delete. Returns the count actually flipped to deleted (rows that
 * were already deleted or out of branch are silently ignored).
 */
export async function bulkSoftDeletePayouts(
  payoutIds: string[],
  branchId: string
): Promise<{ deletedCount: number }> {
  if (payoutIds.length === 0) return { deletedCount: 0 };
  const result = await prisma.doctorPayoutLedger.updateMany({
    where: { id: { in: payoutIds }, branchId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return { deletedCount: result.count };
}

/**
 * Soft-delete every ledger row for the given payees within a date range. The
 * Pay-Run worklist rows are now per-doctor aggregates over a range (no single
 * ledger id), so deleting a selected doctor means voiding all of that doctor's
 * per-day rows that fall inside the selected period.
 */
export async function bulkSoftDeletePayoutsByDoctorRange(
  payees: { payeeType: PayoutDoctorType; payeeId: string }[],
  branchId: string,
  startDate: Date,
  endDate: Date
): Promise<{ deletedCount: number }> {
  if (payees.length === 0) return { deletedCount: 0 };
  const or = payees.map(({ payeeType, payeeId }) => ({
    doctorType: payeeType,
    ...doctorIdWhereClause(payeeType, payeeId),
  }));
  const result = await prisma.doctorPayoutLedger.updateMany({
    where: {
      branchId,
      deletedAt: null,
      periodStartDate: { gte: startDate },
      periodEndDate: { lte: endDate },
      OR: or,
    },
    data: { deletedAt: new Date() },
  });
  return { deletedCount: result.count };
}

// ===========================================================================
// BULK MARK-PAID
// ===========================================================================

export interface BulkMarkPaidResult {
  paidIds: string[];
  conflictIds: string[]; // already paid
  notFoundIds: string[]; // out-of-branch or deleted
  totalPaidInPaise: number;
  commissionsPaidInPaise: number; // REFERRAL + CLINIC + PARTNER
  labPayablesPaidInPaise: number; // LAB (outbound)
}


// ===========================================================================
// BULK DERIVE + PREVIEW
// ===========================================================================

export interface DerivePreviewBucket {
  doctorId: string;
  doctorName: string;
}

export interface DerivePreviewWillBucket extends DerivePreviewBucket {
  // Estimated commission if we derive now (computed by deriveByType, no write).
  amountInPaise: number;
}

export interface DerivePreviewAlreadyBucket extends DerivePreviewBucket {
  payoutId: string;
  amountInPaise: number;
}

export interface DerivePreviewResult {
  willDerive: DerivePreviewWillBucket[];
  alreadyDerived: DerivePreviewAlreadyBucket[];
  noEligibleVisits: DerivePreviewBucket[];
}

/**
 * Resolve which doctor IDs to include for bulk derive. `'all'` expands to
 * every active doctor of the given type that has activity in the branch.
 */
async function resolveDoctorIds(
  doctorType: PayoutDoctorType,
  doctorIds: string[] | 'all',
  branchId: string
): Promise<{ id: string; name: string }[]> {
  if (doctorIds !== 'all' && doctorIds.length > 0) {
    const list = await getDoctorsByIds(doctorType, doctorIds);
    return list;
  }
  // 'all' or empty: get every active doctor with branch activity
  if (doctorType === 'REFERRAL') {
    const docs = await getReferralDoctors(true, branchId);
    return docs.map(d => ({ id: d.id, name: d.name }));
  }
  if (doctorType === 'CLINIC') {
    const docs = await getClinicDoctors(true, branchId);
    return docs.map(d => ({ id: d.id, name: d.name }));
  }
  const partners = await getPartners(true, branchId);
  return partners.map((partner) => ({ id: partner.id, name: partner.name }));
}

async function getDoctorsByIds(
  doctorType: PayoutDoctorType,
  ids: string[]
): Promise<{ id: string; name: string }[]> {
  if (doctorType === 'REFERRAL') {
    return prisma.referralDoctor.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }
  if (doctorType === 'CLINIC') {
    return prisma.clinicDoctor.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
  }
  return prisma.partner.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });
}

/**
 * Preview a bulk derive: bucketize each doctor into willDerive / alreadyDerived
 * / noEligibleVisits. No writes. Drives the Run Cycle sheet's preview panel.
 */
export async function previewDerivePayouts(args: {
  doctorType: PayoutDoctorType;
  doctorIds: string[] | 'all';
  branchId: string;
  periodStartDate: Date;
  periodEndDate: Date;
}): Promise<DerivePreviewResult> {
  const doctors = await resolveDoctorIds(args.doctorType, args.doctorIds, args.branchId);

  const willDerive: DerivePreviewWillBucket[] = [];
  const alreadyDerived: DerivePreviewAlreadyBucket[] = [];
  const noEligibleVisits: DerivePreviewBucket[] = [];

  for (const d of doctors) {
    const existing = await prisma.doctorPayoutLedger.findFirst({
      where: {
        doctorType: args.doctorType,
        ...doctorIdWhereClause(args.doctorType, d.id),
        branchId: args.branchId,
        periodStartDate: args.periodStartDate,
        periodEndDate: args.periodEndDate,
        deletedAt: null,
      },
      select: { id: true, derivedAmountInPaise: true },
    });
    if (existing) {
      alreadyDerived.push({
        doctorId: d.id,
        doctorName: d.name,
        payoutId: existing.id,
        amountInPaise: existing.derivedAmountInPaise,
      });
      continue;
    }

    // Quick eligibility probe — derive yields a non-zero amount if there's any
    // eligible visit in the period. We check by computing the line items
    // (cheap-ish: a few SQL queries per doctor). For 50 doctors this runs in
    // well under a second.
    const probe = await deriveByType(
      args.doctorType,
      d.id,
      args.branchId,
      args.periodStartDate,
      args.periodEndDate
    );
    if (probe.lineItems.length === 0 && probe.derivedAmountInPaise === 0) {
      noEligibleVisits.push({ doctorId: d.id, doctorName: d.name });
    } else {
      willDerive.push({
        doctorId: d.id,
        doctorName: d.name,
        amountInPaise: probe.derivedAmountInPaise,
      });
    }
  }

  return { willDerive, alreadyDerived, noEligibleVisits };
}

export interface BulkDeriveResult {
  derived: PayoutSummary[];      // newly created
  alreadyExisted: PayoutSummary[]; // already had a payout (returned, not re-derived)
  skipped: { doctorId: string; doctorName: string; reason: string }[];
}

/**
 * Bulk derive — runs derivePayout per doctor, swallowing per-doctor failures
 * into the `skipped` bucket so one bad doctor doesn't sink the whole cycle.
 * Idempotent: re-running classifies pre-existing rows into `alreadyExisted`.
 */
export async function derivePayoutsBulk(args: {
  doctorType: PayoutDoctorType;
  doctorIds: string[] | 'all';
  branchId: string;
  periodStartDate: Date;
  periodEndDate: Date;
}): Promise<BulkDeriveResult> {
  const doctors = await resolveDoctorIds(args.doctorType, args.doctorIds, args.branchId);

  const derived: PayoutSummary[] = [];
  const alreadyExisted: PayoutSummary[] = [];
  const skipped: { doctorId: string; doctorName: string; reason: string }[] = [];

  for (const d of doctors) {
    try {
      const result = await derivePayout(
        args.doctorType,
        d.id,
        args.branchId,
        args.periodStartDate,
        args.periodEndDate
      );
      const summary: PayoutSummary = {
        id: result.payout.id,
        doctorType: result.payout.doctorType,
        doctorId: result.payout.doctorId,
        doctorName: result.payout.doctorName,
        branchId: result.payout.branchId,
        branchName: result.payout.branchName,
        periodStartDate: result.payout.periodStartDate,
        periodEndDate: result.payout.periodEndDate,
        derivedAmountInPaise: result.payout.derivedAmountInPaise,
        derivedAt: result.payout.derivedAt,
      };
      if (result.isNew) {
        derived.push(summary);
      } else {
        alreadyExisted.push(summary);
      }
    } catch (err: any) {
      skipped.push({
        doctorId: d.id,
        doctorName: d.name,
        reason: err?.message ?? 'derivation failed',
      });
    }
  }

  return { derived, alreadyExisted, skipped };
}

// ===========================================================================
// BY-DOCTOR AGGREGATION
// ===========================================================================

export interface DoctorPayoutRollup {
  doctorId: string;
  doctorType: PayoutDoctorType;
  doctorName: string;
  periodCount: number;
  accruedTotalInPaise: number;
}

/**
 * One row per (doctor, doctorType) for the By Doctor tab. Uses raw findMany
 * because Prisma's groupBy doesn't let us include relation fields needed for
 * doctor names; we aggregate in memory after the fetch. For typical branches
 * this stays under a few thousand rows so memory aggregation is fine.
 */
export async function groupPayoutsByDoctor(
  branchId: string,
  filters?: { doctorType?: PayoutDoctorType; startDate?: Date; endDate?: Date; q?: string }
): Promise<DoctorPayoutRollup[]> {
  const q = filters?.q?.trim();
  const searchFilter = q
    ? {
        OR: [
          { referralDoctor: { name: { contains: q, mode: 'insensitive' as const } } },
          { clinicDoctor: { name: { contains: q, mode: 'insensitive' as const } } },
          { partner: { name: { contains: q, mode: 'insensitive' as const } } },
        ],
      }
    : {};

  const rows = await prisma.doctorPayoutLedger.findMany({
    where: {
      branchId,
      deletedAt: null,
      ...(filters?.doctorType && { doctorType: filters.doctorType }),
      ...(filters?.startDate && { periodStartDate: { gte: filters.startDate } }),
      ...(filters?.endDate && { periodEndDate: { lte: filters.endDate } }),
      ...searchFilter,
    },
    select: {
      doctorType: true,
      referralDoctorId: true,
      clinicDoctorId: true,
      partnerId: true,
      derivedAmountInPaise: true,
      referralDoctor: { select: { name: true } },
      clinicDoctor: { select: { name: true } },
      partner: { select: { name: true } },
    },
  });

  const map = new Map<string, DoctorPayoutRollup>();
  for (const r of rows) {
    const doctorId =
      r.referralDoctorId ?? r.clinicDoctorId ?? r.partnerId ?? '';
    const doctorName =
      r.referralDoctor?.name ?? r.clinicDoctor?.name ?? r.partner?.name ?? '';
    const key = `${r.doctorType}:${doctorId}`;

    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        doctorId,
        doctorType: r.doctorType,
        doctorName,
        periodCount: 0,
        accruedTotalInPaise: 0,
      };
      map.set(key, bucket);
    }

    bucket.periodCount += 1;
    bucket.accruedTotalInPaise += r.derivedAmountInPaise;
  }

  return Array.from(map.values()).sort((a, b) =>
    a.doctorName.localeCompare(b.doctorName)
  );
}
