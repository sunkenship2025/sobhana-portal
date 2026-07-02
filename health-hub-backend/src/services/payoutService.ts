import { DiagnosticWorkflowMode, PayoutDoctorType, PaymentType, Prisma, ReportStatus } from '@prisma/client';
import prisma from '../lib/prisma';
import { computeCommissionInPaise, computeLabCostInPaise, computeReferralPayoutInPaise } from './referralPayoutService';
import {
  allocateBillDiscountAcrossOrders,
  computeBillFinancialsFromPersisted,
} from './billFinancialService';
import { categorize, categoryLabel, CATEGORY_ORDER, CAT_LAB, type PayoutCategory } from './payoutCategorize';
import { isWhatsAppEnabled } from './whatsappCloudService';


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
  paidAt: Date | null;
  paymentMethod: PaymentType | null;
}

export interface PayoutDetail extends PayoutSummary {
  paymentReferenceId: string | null;
  notes: string | null;
  reviewedAt: Date | null;
  lineItems: PayoutLineItem[];
}

function buildDateWindow(startDate?: Date, endDate?: Date) {
  return {
    ...(startDate && { gte: startDate }),
    ...(endDate && { lte: endDate }),
  };
}

function buildDiagnosticPayoutVisitWindow(startDate: Date, endDate: Date): Prisma.VisitWhereInput {
  return {
    OR: [
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
      {
        status: 'COMPLETED',
        updatedAt: buildDateWindow(startDate, endDate),
        testOrders: {
          some: {
            workflowMode: DiagnosticWorkflowMode.BILL_ONLY,
          },
        },
        OR: [
          {
            report: {
              is: null,
            },
          },
          {
            report: {
              is: {
                versions: {
                  none: {
                    status: ReportStatus.FINALIZED,
                  },
                },
              },
            },
          },
        ],
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
        some: { referralDoctorId },
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
    const discountAllocations = billFinancials
      ? allocateBillDiscountAcrossOrders(
          visit.testOrders.map((order) => ({
            id: order.id,
            priceInPaise: order.priceInPaise,
          })),
          billFinancials.discountAmountInPaise
        )
      : new Map<string, number>();

    for (const testOrder of visit.testOrders) {
      // Cancelled orders earn no payout — their charge was voided off the bill.
      if (testOrder.cancelledAt) continue;
      const referralAmountInPaise =
        testOrder.referralCommissionType === 'PERCENTAGE'
          ? Math.max(
              0,
              testOrder.priceInPaise - (discountAllocations.get(testOrder.id) ?? 0)
            )
          : testOrder.priceInPaise;
      const commissionInPaise =
        testOrder.referralCommissionType === 'PERCENTAGE'
          ? computeCommissionInPaise({
              priceInPaise: referralAmountInPaise,
              commissionType: testOrder.referralCommissionType,
              commissionPercentage: testOrder.referralCommissionPercentage,
              commissionAmountInPaise: testOrder.referralCommissionAmountInPaise,
            })
          : computeReferralPayoutInPaise(testOrder);
      totalDerivedInPaise += commissionInPaise;

      lineItems.push({
        visitId: visit.id,
        productId: testOrder.productId,
        billNumber: visit.billNumber,
        patientName: visit.patient.name,
        patientTitle: visit.patient.title,
        date: finalizedAt || visit.updatedAt || visit.createdAt,
        testOrFee:
          testOrder.product?.name ||
          testOrder.testNameSnapshot ||
          testOrder.test.name,
        amountInPaise: referralAmountInPaise,
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
        category: categorize({
          productPayoutCategory: testOrder.product?.payoutCategory,
          productName: testOrder.product?.name,
          testName: testOrder.testNameSnapshot || testOrder.test?.name,
        }),
        basisLabel:
          testOrder.referralCommissionType === 'FIXED_AMOUNT'
            ? `Flat ${rupeesShort(commissionInPaise)}`
            : `${testOrder.referralCommissionPercentage ?? 0}% → ${rupeesShort(commissionInPaise)}`,
        discountInPaise:
          testOrder.referralCommissionType === 'PERCENTAGE'
            ? discountAllocations.get(testOrder.id) ?? 0
            : 0,
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
// ===========================================================================

/**
 * Derive payout for a diagnostic center.
 * Formula:
 *   - snapshot percentage rules: testOrder.priceInPaise × diagnosticCenterCommissionPercentage / 100
 *   - snapshot fixed rules: diagnosticCenterCommissionAmountInPaise
 * for all finalized diagnostic-center-linked visits in the period.
 * Older records created before snapshot support fall back to the center's legacy percentage.
 */
async function deriveDiagnosticCenterPayout(
  diagnosticCenterId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<PayoutDerivationResult> {
  const center = await prisma.diagnosticReferralCenter.findUnique({
    where: { id: diagnosticCenterId },
    select: { id: true, name: true, commissionPercent: true },
  });

  if (!center) {
    throw new Error('Diagnostic center not found');
  }

  // Get visits linked to this center and completed in the period.
  const centerVisits = await prisma.diagnosticCenter_Visit.findMany({
    where: {
      diagnosticCenterId,
      branchId,
      visit: {
        domain: 'DIAGNOSTICS',
        ...buildDiagnosticPayoutVisitWindow(periodStartDate, periodEndDate),
      },
    },
    include: {
      visit: {
        include: {
          patient: { select: { name: true, title: true } },
          testOrders: {
            include: {
              test: { select: { name: true, code: true, department: { select: { name: true } } } },
              product: { select: { id: true, name: true, code: true, payoutCategory: true } },
            },
          },
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
      },
    },
  });

  const lineItems: PayoutLineItem[] = [];
  let totalDerivedInPaise = 0;

  for (const cv of centerVisits) {
    const visit = cv.visit;
    const finalizedAt = visit.report?.versions[0]?.finalizedAt;
    for (const testOrder of visit.testOrders) {
      if (testOrder.cancelledAt) continue;
      const hasSnapshot = testOrder.diagnosticCenterCommissionType !== null;
      const commissionInPaise = hasSnapshot
        ? computeCommissionInPaise({
            priceInPaise: testOrder.priceInPaise,
            commissionType: testOrder.diagnosticCenterCommissionType,
            commissionPercentage: testOrder.diagnosticCenterCommissionPercentage,
            commissionAmountInPaise: testOrder.diagnosticCenterCommissionAmountInPaise,
          })
        : Math.round((testOrder.priceInPaise * center.commissionPercent) / 100);

      totalDerivedInPaise += commissionInPaise;

      lineItems.push({
        visitId: visit.id,
        productId: testOrder.productId,
        billNumber: visit.billNumber,
        patientName: visit.patient.name,
        patientTitle: visit.patient.title,
        date: finalizedAt || visit.updatedAt || visit.createdAt,
        testOrFee:
          testOrder.product?.name ||
          testOrder.testNameSnapshot ||
          testOrder.test.name,
        amountInPaise: testOrder.priceInPaise,
        commissionType: hasSnapshot
          ? testOrder.diagnosticCenterCommissionType ?? undefined
          : 'PERCENTAGE',
        commissionPercentage:
          hasSnapshot && testOrder.diagnosticCenterCommissionType === 'PERCENTAGE'
            ? testOrder.diagnosticCenterCommissionPercentage ?? undefined
            : !hasSnapshot
              ? center.commissionPercent
              : undefined,
        commissionAmountInPaise:
          hasSnapshot && testOrder.diagnosticCenterCommissionType === 'FIXED_AMOUNT'
            ? testOrder.diagnosticCenterCommissionAmountInPaise ?? undefined
            : undefined,
        derivedCommissionInPaise: commissionInPaise,
        category: categorize({
          productPayoutCategory: testOrder.product?.payoutCategory,
          productName: testOrder.product?.name,
          testName: testOrder.testNameSnapshot || testOrder.test?.name,
        }),
        basisLabel:
          hasSnapshot && testOrder.diagnosticCenterCommissionType === 'FIXED_AMOUNT'
            ? `Flat ${rupeesShort(commissionInPaise)}`
            : `${(hasSnapshot ? testOrder.diagnosticCenterCommissionPercentage : center.commissionPercent) ?? 0}% → ${rupeesShort(commissionInPaise)}`,
        discountInPaise: 0,
        departmentName: testOrder.test?.department?.name ?? null,
        productCode: testOrder.product?.code ?? testOrder.testCodeSnapshot ?? null,
      });
    }
  }

  return {
    doctorType: 'DIAGNOSTIC_CENTER',
    doctorId: diagnosticCenterId,
    doctorName: center.name,
    branchId,
    periodStartDate,
    periodEndDate,
    lineItems: groupDiagnosticLineItemsByBillableProduct(lineItems),
    derivedAmountInPaise: totalDerivedInPaise,
  };
}

// ===========================================================================
// DERIVATION LOGIC - OUTSIDE LABS (vendor payables)
// ===========================================================================

function rupeesShort(paise: number): string {
  return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
}

/**
 * Derive the vendor payable owed to an outside lab for tests outsourced to it
 * in the period. Mirrors deriveReferralPayout: the bill discount is allocated
 * across the FULL bill, then PERCENTAGE lab cost is taken on the post-discount
 * price of each outsourced order (FIXED = flat snapshot). Center margin =
 * post-discount price − lab cost. Lab line items are NOT product-grouped (the
 * group merge does not sum lab cost / margin), so each outsourced order is its
 * own line.
 */
async function deriveExternalLabPayout(
  externalLabId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<PayoutDerivationResult> {
  const lab = await prisma.externalLab.findUnique({
    where: { id: externalLabId },
    select: { id: true, name: true },
  });

  if (!lab) {
    throw new Error('Outside lab not found');
  }

  const visits = await prisma.visit.findMany({
    where: {
      branchId,
      domain: 'DIAGNOSTICS',
      testOrders: { some: { externalLabId } },
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
    const billFinancials = visit.bill ? computeBillFinancialsFromPersisted(visit.bill) : null;
    // Allocate discount across the FULL bill (all orders), not just outsourced ones.
    const discountAllocations = billFinancials
      ? allocateBillDiscountAcrossOrders(
          visit.testOrders.map((order) => ({ id: order.id, priceInPaise: order.priceInPaise })),
          billFinancials.discountAmountInPaise
        )
      : new Map<string, number>();

    for (const testOrder of visit.testOrders) {
      if (testOrder.externalLabId !== externalLabId) continue;
      if (testOrder.cancelledAt) continue;

      const discountInPaise = discountAllocations.get(testOrder.id) ?? 0;
      const postDiscountPriceInPaise = Math.max(0, testOrder.priceInPaise - discountInPaise);
      const labCostInPaise = computeLabCostInPaise({
        postDiscountPriceInPaise,
        costType: testOrder.labCostType,
        costPercent: testOrder.labCostPercentage,
        costAmountInPaise: testOrder.labCostAmountInPaise,
      });
      const centerMarginInPaise = postDiscountPriceInPaise - labCostInPaise;
      totalDerivedInPaise += labCostInPaise;

      const category = categorize({
          productPayoutCategory: testOrder.product?.payoutCategory,
          productName: testOrder.product?.name,
          testName: testOrder.testNameSnapshot || testOrder.test?.name,
        });
      const basisLabel =
        testOrder.labCostType === 'FIXED_AMOUNT'
          ? `Flat ${rupeesShort(labCostInPaise)}`
          : `${testOrder.labCostPercentage ?? 0}% of P`;

      lineItems.push({
        visitId: visit.id,
        productId: testOrder.productId,
        billNumber: visit.billNumber,
        patientName: visit.patient.name,
        patientTitle: visit.patient.title,
        date: finalizedAt || visit.updatedAt || visit.createdAt,
        testOrFee: testOrder.product?.name || testOrder.testNameSnapshot || testOrder.test.name,
        amountInPaise: postDiscountPriceInPaise,
        commissionType: testOrder.labCostType ?? undefined,
        commissionPercentage:
          testOrder.labCostType === 'PERCENTAGE' ? testOrder.labCostPercentage ?? undefined : undefined,
        commissionAmountInPaise:
          testOrder.labCostType === 'FIXED_AMOUNT' ? testOrder.labCostAmountInPaise ?? undefined : undefined,
        derivedCommissionInPaise: labCostInPaise,
        category,
        basisLabel,
        discountInPaise,
        departmentName: testOrder.test?.department?.name ?? null,
        productCode: testOrder.product?.code ?? testOrder.testCodeSnapshot ?? null,
        labCostInPaise,
        centerMarginInPaise,
      });
    }
  }

  return {
    doctorType: 'LAB',
    doctorId: externalLabId,
    doctorName: lab.name,
    branchId,
    periodStartDate,
    periodEndDate,
    lineItems,
    derivedAmountInPaise: totalDerivedInPaise,
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
    case 'DIAGNOSTIC_CENTER':
      return deriveDiagnosticCenterPayout(doctorId, branchId, periodStartDate, periodEndDate);
    case 'LAB':
      return deriveExternalLabPayout(doctorId, branchId, periodStartDate, periodEndDate);
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
    case 'DIAGNOSTIC_CENTER':
      return { diagnosticCenterId: doctorId };
    case 'LAB':
      return { externalLabId: doctorId };
    default:
      throw new Error(`Unsupported doctor type: ${doctorType}`);
  }
}

/**
 * Extract doctorId from a payout ledger record.
 */
function extractDoctorId(payout: any): string {
  if (payout.doctorType === 'REFERRAL') return payout.referralDoctorId!;
  if (payout.doctorType === 'CLINIC') return payout.clinicDoctorId!;
  if (payout.doctorType === 'LAB') return payout.externalLabId!;
  return payout.diagnosticCenterId!;
}

/**
 * Extract doctorName from included relations.
 */
function extractDoctorName(payout: any): string {
  return (
    payout.referralDoctor?.name ||
    payout.clinicDoctor?.name ||
    payout.diagnosticCenter?.name ||
    payout.externalLab?.name ||
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

async function findCoveringPaidPayout(
  doctorType: PayoutDoctorType,
  doctorId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date,
  excludePayoutId?: string
) {
  return prisma.doctorPayoutLedger.findFirst({
    where: {
      doctorType,
      ...doctorIdWhereClause(doctorType, doctorId),
      branchId,
      deletedAt: null,
      paidAt: { not: null },
      periodStartDate: { lte: periodStartDate },
      periodEndDate: { gte: periodEndDate },
      ...(excludePayoutId && { id: { not: excludePayoutId } }),
    },
    orderBy: [
      { periodStartDate: 'desc' },
      { periodEndDate: 'asc' },
      { paidAt: 'desc' },
    ],
  });
}

async function syncReferralPayoutsForBranch(
  branchId: string,
  filters?: {
    doctorType?: PayoutDoctorType;
    doctorId?: string;
    isPaid?: boolean;
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
        some: filters?.doctorId
          ? { referralDoctorId: filters.doctorId }
          : {},
      },
      ...buildDiagnosticPayoutVisitWindow(
        filters?.startDate ?? new Date(0),
        filters?.endDate ?? new Date('9999-12-31T23:59:59.999Z')
      ),
    },
    select: {
      updatedAt: true,
      referrals: {
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

async function syncDiagnosticCenterPayoutsForBranch(
  branchId: string,
  filters?: {
    doctorType?: PayoutDoctorType;
    doctorId?: string;
    isPaid?: boolean;
    startDate?: Date;
    endDate?: Date;
  }
) {
  if (filters?.doctorType && filters.doctorType !== 'DIAGNOSTIC_CENTER') return;

  const centerVisits = await prisma.diagnosticCenter_Visit.findMany({
    where: {
      branchId,
      ...(filters?.doctorId && { diagnosticCenterId: filters.doctorId }),
      visit: {
        domain: 'DIAGNOSTICS',
        ...buildDiagnosticPayoutVisitWindow(
          filters?.startDate ?? new Date(0),
          filters?.endDate ?? new Date('9999-12-31T23:59:59.999Z')
        ),
      },
    },
    select: {
      diagnosticCenterId: true,
      visit: {
        select: {
          updatedAt: true,
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
      },
    },
  });

  const periods = new Map<
    string,
    { doctorId: string; periodStartDate: Date; periodEndDate: Date }
  >();

  for (const centerVisit of centerVisits) {
    const finalizedAt = centerVisit.visit.report?.versions[0]?.finalizedAt || centerVisit.visit.updatedAt;

    if (!centerVisit.diagnosticCenterId || !finalizedAt) {
      continue;
    }

    const { periodStartDate, periodEndDate } = buildDayPeriod(finalizedAt);
    periods.set(`${centerVisit.diagnosticCenterId}:${periodStartDate.toISOString()}`, {
      doctorId: centerVisit.diagnosticCenterId,
      periodStartDate,
      periodEndDate,
    });
  }

  for (const period of periods.values()) {
    // Auto-sync respects deletions — see comment in syncReferralPayoutsForBranch.
    const anyExisting = await prisma.doctorPayoutLedger.findFirst({
      where: {
        doctorType: 'DIAGNOSTIC_CENTER',
        diagnosticCenterId: period.doctorId,
        branchId,
        periodStartDate: period.periodStartDate,
        periodEndDate: period.periodEndDate,
      },
      select: { id: true },
    });
    if (anyExisting) continue;

    await derivePayout(
      'DIAGNOSTIC_CENTER',
      period.doctorId,
      branchId,
      period.periodStartDate,
      period.periodEndDate
    );
  }
}

/**
 * Auto-create LAB (outside-lab) payout ledger rows for any (lab, day) bucket
 * that has outsourced test orders but no existing row. Mirrors the referral and
 * diagnostic-center syncs and respects soft-deletes (skips if ANY row exists).
 */
async function syncExternalLabPayoutsForBranch(
  branchId: string,
  filters?: {
    doctorType?: PayoutDoctorType;
    doctorId?: string;
    isPaid?: boolean;
    startDate?: Date;
    endDate?: Date;
  }
) {
  if (filters?.doctorType && filters.doctorType !== 'LAB') return;

  const visits = await prisma.visit.findMany({
    where: {
      branchId,
      domain: 'DIAGNOSTICS',
      testOrders: {
        some: { externalLabId: filters?.doctorId ? filters.doctorId : { not: null } },
      },
      ...buildDiagnosticPayoutVisitWindow(
        filters?.startDate ?? new Date(0),
        filters?.endDate ?? new Date('9999-12-31T23:59:59.999Z')
      ),
    },
    select: {
      updatedAt: true,
      testOrders: {
        where: filters?.doctorId
          ? { externalLabId: filters.doctorId }
          : { externalLabId: { not: null } },
        select: { externalLabId: true },
      },
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
    const labIds = new Set<string>();
    for (const order of visit.testOrders) {
      if (order.externalLabId) labIds.add(order.externalLabId);
    }
    for (const labId of labIds) {
      periods.set(`${labId}:${periodStartDate.toISOString()}`, {
        doctorId: labId,
        periodStartDate,
        periodEndDate,
      });
    }
  }

  for (const period of periods.values()) {
    // Auto-sync respects deletions — see comment in syncReferralPayoutsForBranch.
    const anyExisting = await prisma.doctorPayoutLedger.findFirst({
      where: {
        doctorType: 'LAB',
        externalLabId: period.doctorId,
        branchId,
        periodStartDate: period.periodStartDate,
        periodEndDate: period.periodEndDate,
      },
      select: { id: true },
    });
    if (anyExisting) continue;

    await derivePayout('LAB', period.doctorId, branchId, period.periodStartDate, period.periodEndDate);
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
      diagnosticCenter: { select: { name: true } },
      externalLab: { select: { name: true } },
      branch: { select: { name: true } },
    },
  });

  if (existing) {
    const derivation = await deriveByType(doctorType, doctorId, branchId, periodStartDate, periodEndDate);
    const coveringPaidPayout = existing.paidAt
      ? null
      : await findCoveringPaidPayout(
          doctorType,
          doctorId,
          branchId,
          periodStartDate,
          periodEndDate,
          existing.id
        );
    const nextData: {
      derivedAmountInPaise?: number;
      derivedAt?: Date;
      paidAt?: Date | null;
      paymentMethod?: PaymentType | null;
      paymentReferenceId?: string | null;
      notes?: string | null;
    } = {};

    if (!existing.paidAt && existing.derivedAmountInPaise !== derivation.derivedAmountInPaise) {
      nextData.derivedAmountInPaise = derivation.derivedAmountInPaise;
      nextData.derivedAt = new Date();
    }

    if (!existing.paidAt && coveringPaidPayout?.paidAt) {
      nextData.paidAt = coveringPaidPayout.paidAt;
      nextData.paymentMethod = coveringPaidPayout.paymentMethod;
      nextData.paymentReferenceId = coveringPaidPayout.paymentReferenceId;
      nextData.notes = existing.notes ?? coveringPaidPayout.notes;
    }

    const refreshedExisting =
      Object.keys(nextData).length > 0
        ? await prisma.doctorPayoutLedger.update({
            where: { id: existing.id },
            data: nextData,
            include: {
              referralDoctor: { select: { name: true } },
              clinicDoctor: { select: { name: true } },
              diagnosticCenter: { select: { name: true } },
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
        paidAt: refreshedExisting.paidAt,
        paymentMethod: refreshedExisting.paymentMethod,
        paymentReferenceId: refreshedExisting.paymentReferenceId,
        notes: refreshedExisting.notes,
        reviewedAt: refreshedExisting.reviewedAt,
        lineItems: derivation.lineItems,
      },
      isNew: false,
    };
  }

  // Derive new payout
  const derivation = await deriveByType(doctorType, doctorId, branchId, periodStartDate, periodEndDate);
  const coveringPaidPayout = await findCoveringPaidPayout(
    doctorType,
    doctorId,
    branchId,
    periodStartDate,
    periodEndDate
  );

  // Create new ledger entry
  const newPayout = await prisma.doctorPayoutLedger.create({
    data: {
      doctorType,
      referralDoctorId: doctorType === 'REFERRAL' ? doctorId : null,
      clinicDoctorId: doctorType === 'CLINIC' ? doctorId : null,
      diagnosticCenterId: doctorType === 'DIAGNOSTIC_CENTER' ? doctorId : null,
      externalLabId: doctorType === 'LAB' ? doctorId : null,
      branchId,
      periodStartDate,
      periodEndDate,
      derivedAmountInPaise: derivation.derivedAmountInPaise,
      derivedAt: new Date(),
      ...(coveringPaidPayout?.paidAt && {
        paidAt: coveringPaidPayout.paidAt,
        paymentMethod: coveringPaidPayout.paymentMethod,
        paymentReferenceId: coveringPaidPayout.paymentReferenceId,
        notes: coveringPaidPayout.notes,
      }),
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
      paidAt: newPayout.paidAt,
      paymentMethod: newPayout.paymentMethod,
      paymentReferenceId: newPayout.paymentReferenceId,
      notes: newPayout.notes,
      reviewedAt: newPayout.reviewedAt,
      lineItems: derivation.lineItems,
    },
    isNew: true,
  };
}

/**
 * Get all payouts for a branch with optional filters.
 */
export type PayoutSortField = 'derivedAt' | 'doctorName' | 'amount' | 'periodStart' | 'paidAt';
export type SortDir = 'asc' | 'desc';

export interface ListPayoutsFilters {
  doctorType?: PayoutDoctorType;
  doctorId?: string;
  isPaid?: boolean;
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
    pendingCount: number;
    pendingAmountInPaise: number;
    paidCount: number;
    paidAmountInPaise: number;
  };
}

export async function listPayouts(
  branchId: string,
  filters?: ListPayoutsFilters
): Promise<ListPayoutsResult> {
  await syncReferralPayoutsForBranch(branchId, filters);
  await syncDiagnosticCenterPayoutsForBranch(branchId, filters);
  await syncExternalLabPayoutsForBranch(branchId, filters);

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
            { diagnosticCenterId: filters.doctorId },
            { externalLabId: filters.doctorId },
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
          { diagnosticCenter: { name: { contains: q, mode: 'insensitive' as const } } },
          { externalLab: { name: { contains: q, mode: 'insensitive' as const } } },
          { paymentReferenceId: { contains: q, mode: 'insensitive' as const } },
        ],
      }
    : {};

  const where: Prisma.DoctorPayoutLedgerWhereInput = {
    branchId,
    deletedAt: null,
    ...(filters?.doctorType && { doctorType: filters.doctorType }),
    ...doctorIdFilter,
    ...(filters?.isPaid !== undefined && {
      paidAt: filters.isPaid ? { not: null } : null,
    }),
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
      case 'paidAt':
        return [{ paidAt: sortDir }];
      case 'doctorName':
        return [
          { referralDoctor: { name: sortDir } },
          { clinicDoctor: { name: sortDir } },
          { diagnosticCenter: { name: sortDir } },
          { externalLab: { name: sortDir } },
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
        diagnosticCenter: { select: { name: true } },
        externalLab: { select: { name: true } },
        branch: { select: { name: true } },
      },
      orderBy,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.doctorPayoutLedger.count({ where }),
    filters?.includeTotals
      ? prisma.doctorPayoutLedger.groupBy({
          by: ['paidAt'],
          where,
          _count: { _all: true },
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
    paidAt: p.paidAt,
    paymentMethod: p.paymentMethod,
  }));

  let totals: ListPayoutsResult['totals'] | undefined;
  if (totalsAgg) {
    let pendingCount = 0;
    let pendingAmount = 0;
    let paidCount = 0;
    let paidAmount = 0;
    // groupBy on a nullable column returns one bucket per distinct value,
    // including a null bucket; collapse all non-null paidAt values into one.
    for (const row of totalsAgg) {
      const isPaid = row.paidAt !== null;
      if (isPaid) {
        paidCount += row._count._all;
        paidAmount += row._sum.derivedAmountInPaise ?? 0;
      } else {
        pendingCount += row._count._all;
        pendingAmount += row._sum.derivedAmountInPaise ?? 0;
      }
    }
    totals = {
      pendingCount,
      pendingAmountInPaise: pendingAmount,
      paidCount,
      paidAmountInPaise: paidAmount,
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
      diagnosticCenter: { select: { name: true } },
      externalLab: { select: { name: true } },
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
    paidAt: payout.paidAt,
    paymentMethod: payout.paymentMethod,
    paymentReferenceId: payout.paymentReferenceId,
    notes: payout.notes,
    reviewedAt: payout.reviewedAt,
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
  const isLab = detail.doctorType === 'LAB';
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
      diagnosticCenter: { select: { phone: true } },
      externalLab: { select: { phone: true } },
    },
  });
  if (!p) return null;
  switch (p.doctorType) {
    case 'REFERRAL':
      return p.referralDoctor?.phone ?? null;
    case 'CLINIC':
      return p.clinicDoctor?.phone ?? null;
    case 'DIAGNOSTIC_CENTER':
      return p.diagnosticCenter?.phone ?? null;
    case 'LAB':
      return p.externalLab?.phone ?? null;
    default:
      return null;
  }
}

// ===========================================================================
// PAY-RUN WORKLIST (grouped who-I-owe view with two non-netting hero totals)
// ===========================================================================

export type PayoutDirection = 'INBOUND' | 'OUTBOUND';
export type PayoutKind = 'COMMISSION' | 'PAYABLE';

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
    labPayablesTotalInPaise: number;
    payeeCount: number;
    byType: Record<PayoutDoctorType, PayoutTypeTotals>;
  };
  groups: PayRunWorklistGroup[];
  rows: PayoutWorklistRow[];
}

const PAYOUT_TYPES_ORDER: PayoutDoctorType[] = ['REFERRAL', 'CLINIC', 'DIAGNOSTIC_CENTER', 'LAB'];

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
  await syncDiagnosticCenterPayoutsForBranch(branchId, syncFilters);
  await syncExternalLabPayoutsForBranch(branchId, syncFilters);

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
        { diagnosticCenter: { name: { contains: q, mode: 'insensitive' as const } } },
        { externalLab: { name: { contains: q, mode: 'insensitive' as const } } },
        { paymentReferenceId: { contains: q, mode: 'insensitive' as const } },
      ],
    }),
  };

  const payouts = await prisma.doctorPayoutLedger.findMany({
    where,
    include: {
      referralDoctor: { select: { name: true } },
      clinicDoctor: { select: { name: true } },
      diagnosticCenter: { select: { name: true } },
      externalLab: { select: { name: true } },
      branch: { select: { name: true } },
    },
    orderBy: [{ derivedAmountInPaise: 'desc' }],
  });

  const rows: PayoutWorklistRow[] = payouts.map((p) => {
    const isLab = p.doctorType === 'LAB';
    return {
      id: p.id,
      payeeType: p.doctorType,
      direction: (isLab ? 'OUTBOUND' : 'INBOUND') as PayoutDirection,
      kind: (isLab ? 'PAYABLE' : 'COMMISSION') as PayoutKind,
      payeeId: extractDoctorId(p),
      payeeName: extractDoctorName(p),
      periodStartDate: p.periodStartDate,
      periodEndDate: p.periodEndDate,
      amountInPaise: p.derivedAmountInPaise,
    };
  });

  // Totals are simply what's owed for the period (no paid/unpaid concept).
  const byType = Object.fromEntries(
    PAYOUT_TYPES_ORDER.map((t) => [t, { count: 0, amountInPaise: 0 }])
  ) as Record<PayoutDoctorType, PayoutTypeTotals>;

  let commissionsTotal = 0;
  let labTotal = 0;
  for (const r of rows) {
    const bt = byType[r.payeeType];
    bt.count += 1;
    bt.amountInPaise += r.amountInPaise;
    if (r.payeeType === 'LAB') labTotal += r.amountInPaise;
    else commissionsTotal += r.amountInPaise;
  }

  const groups: PayRunWorklistGroup[] = PAYOUT_TYPES_ORDER.map((t) => {
    const groupRows = rows.filter((r) => r.payeeType === t);
    return {
      payeeType: t,
      direction: (t === 'LAB' ? 'OUTBOUND' : 'INBOUND') as PayoutDirection,
      subtotalInPaise: groupRows.reduce((s, r) => s + r.amountInPaise, 0),
      rows: groupRows,
    };
  }).filter((g) => g.rows.length > 0);

  return {
    period: { startDate: filters?.startDate ?? null, endDate: filters?.endDate ?? null },
    view,
    totals: {
      commissionsTotalInPaise: commissionsTotal,
      labPayablesTotalInPaise: labTotal,
      payeeCount: rows.length,
      byType,
    },
    groups,
    rows,
  };
}

/**
 * Mark a payout as paid.
 * IMMUTABLE after this operation - no further changes allowed.
 *
 * Concurrency: uses an atomic conditional updateMany so two simultaneous
 * mark-paid calls don't both succeed (which would double-pay the doctor).
 *
 * Cascade: payouts whose period falls inside this payout's period AND that
 * were derived BEFORE this one was paid are also marked paid. Newly-derived
 * payouts created AFTER the human approved the outer payment are NOT
 * auto-paid — they need their own approval.
 */
export async function markPayoutPaid(
  payoutId: string,
  paymentMethod: PaymentType,
  paymentReferenceId?: string,
  notes?: string,
  paidOn?: Date
): Promise<PayoutDetail> {
  // Get current payout (read-only context for downstream details).
  const existing = await prisma.doctorPayoutLedger.findUnique({
    where: { id: payoutId },
  });

  if (!existing || existing.deletedAt) {
    throw new Error('Payout not found');
  }

  if (existing.paidAt) {
    throw new Error('Payout already marked as paid - cannot modify');
  }

  const paidAt = paidOn ?? new Date();
  const doctorId = extractDoctorId(existing);

  await prisma.$transaction(async (tx) => {
    // Atomic conditional update — if another request raced us and already
    // flipped paidAt, our updateMany returns count=0 and we abort.
    const claim = await tx.doctorPayoutLedger.updateMany({
      where: { id: payoutId, deletedAt: null, paidAt: null },
      data: { paidAt, paymentMethod, paymentReferenceId, notes },
    });
    if (claim.count === 0) {
      throw new Error('Payout already marked as paid - cannot modify');
    }

    // Cascade-pay only payouts that existed (derivedAt <= our paidAt) at the
    // moment of approval. Anything derived later is intentionally untouched
    // so it requires its own human review.
    await tx.doctorPayoutLedger.updateMany({
      where: {
        id: { not: payoutId },
        doctorType: existing.doctorType,
        ...doctorIdWhereClause(existing.doctorType, doctorId),
        branchId: existing.branchId,
        deletedAt: null,
        paidAt: null,
        periodStartDate: { gte: existing.periodStartDate },
        periodEndDate: { lte: existing.periodEndDate },
        derivedAt: { lte: paidAt },
      },
      data: { paidAt, paymentMethod, paymentReferenceId, notes },
    });
  });

  // Return full detail
  const detail = await getPayoutDetail(payoutId);
  if (!detail) {
    throw new Error('Failed to retrieve updated payout');
  }

  return detail;
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
 * Get diagnostic centers for dropdown selection. See note above on branchId.
 */
export async function getDiagnosticCenters(isActive?: boolean, branchId?: string) {
  const where: any = isActive !== undefined ? { isActive } : {};
  if (branchId) {
    where.payoutLedger = { some: { branchId } };
  }
  return prisma.diagnosticReferralCenter.findMany({
    where,
    select: {
      id: true,
      centerNumber: true,
      name: true,
      commissionType: true,
      commissionPercent: true,
      commissionAmountInPaise: true,
      isActive: true,
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

// ===========================================================================
// BULK MARK-PAID
// ===========================================================================

export interface BulkMarkPaidResult {
  paidIds: string[];
  conflictIds: string[]; // already paid
  notFoundIds: string[]; // out-of-branch or deleted
  totalPaidInPaise: number;
  commissionsPaidInPaise: number; // REFERRAL + CLINIC + DIAGNOSTIC_CENTER
  labPayablesPaidInPaise: number; // LAB (outbound)
}

/**
 * Apply ONE payment record (method + reference + notes) to N selected payouts
 * in a single transaction. Rows already marked paid are reported as conflicts.
 * Each row gets its own paidAt (within ms of each other).
 */
export async function markPayoutsPaidBulk(
  payoutIds: string[],
  branchId: string,
  payment: { paymentMethod: PaymentType; paymentReferenceId?: string; notes?: string; paidOn?: Date }
): Promise<BulkMarkPaidResult> {
  if (payoutIds.length === 0) {
    return {
      paidIds: [],
      conflictIds: [],
      notFoundIds: [],
      totalPaidInPaise: 0,
      commissionsPaidInPaise: 0,
      labPayablesPaidInPaise: 0,
    };
  }

  const paidAt = payment.paidOn ?? new Date();

  return prisma.$transaction(async (tx) => {
    // Fetch the candidates first so we can categorize the response.
    const candidates = await tx.doctorPayoutLedger.findMany({
      where: { id: { in: payoutIds }, branchId, deletedAt: null },
      select: { id: true, paidAt: true, derivedAmountInPaise: true, doctorType: true },
    });

    const candidateIds = new Set(candidates.map(c => c.id));
    const notFoundIds = payoutIds.filter(id => !candidateIds.has(id));

    const eligibleIds: string[] = [];
    const conflictIds: string[] = [];
    let totalPaid = 0;
    let commissionsPaid = 0;
    let labPayablesPaid = 0;
    for (const c of candidates) {
      if (c.paidAt) {
        conflictIds.push(c.id);
      } else {
        eligibleIds.push(c.id);
        totalPaid += c.derivedAmountInPaise;
        if (c.doctorType === 'LAB') {
          labPayablesPaid += c.derivedAmountInPaise;
        } else {
          commissionsPaid += c.derivedAmountInPaise;
        }
      }
    }

    if (eligibleIds.length > 0) {
      await tx.doctorPayoutLedger.updateMany({
        where: { id: { in: eligibleIds }, paidAt: null, deletedAt: null },
        data: {
          paidAt,
          paymentMethod: payment.paymentMethod,
          paymentReferenceId: payment.paymentReferenceId ?? null,
          notes: payment.notes ?? null,
        },
      });
    }

    return {
      paidIds: eligibleIds,
      conflictIds,
      notFoundIds,
      totalPaidInPaise: totalPaid,
      commissionsPaidInPaise: commissionsPaid,
      labPayablesPaidInPaise: labPayablesPaid,
    };
  });
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
  isPaid: boolean;
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
  const docs = await getDiagnosticCenters(true, branchId);
  return docs.map(d => ({ id: d.id, name: d.name }));
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
  return prisma.diagnosticReferralCenter.findMany({
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
      select: { id: true, derivedAmountInPaise: true, paidAt: true },
    });
    if (existing) {
      alreadyDerived.push({
        doctorId: d.id,
        doctorName: d.name,
        payoutId: existing.id,
        amountInPaise: existing.derivedAmountInPaise,
        isPaid: existing.paidAt !== null,
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
        paidAt: result.payout.paidAt,
        paymentMethod: result.payout.paymentMethod,
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
  pendingTotalInPaise: number;
  paidTotalInPaise: number;
  lastPaidAt: Date | null;
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
          { diagnosticCenter: { name: { contains: q, mode: 'insensitive' as const } } },
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
      diagnosticCenterId: true,
      derivedAmountInPaise: true,
      paidAt: true,
      referralDoctor: { select: { name: true } },
      clinicDoctor: { select: { name: true } },
      diagnosticCenter: { select: { name: true } },
    },
  });

  const map = new Map<string, DoctorPayoutRollup>();
  for (const r of rows) {
    const doctorId =
      r.referralDoctorId ?? r.clinicDoctorId ?? r.diagnosticCenterId ?? '';
    const doctorName =
      r.referralDoctor?.name ?? r.clinicDoctor?.name ?? r.diagnosticCenter?.name ?? '';
    const key = `${r.doctorType}:${doctorId}`;

    let bucket = map.get(key);
    if (!bucket) {
      bucket = {
        doctorId,
        doctorType: r.doctorType,
        doctorName,
        periodCount: 0,
        pendingTotalInPaise: 0,
        paidTotalInPaise: 0,
        lastPaidAt: null,
      };
      map.set(key, bucket);
    }

    bucket.periodCount += 1;
    if (r.paidAt) {
      bucket.paidTotalInPaise += r.derivedAmountInPaise;
      if (!bucket.lastPaidAt || r.paidAt > bucket.lastPaidAt) {
        bucket.lastPaidAt = r.paidAt;
      }
    } else {
      bucket.pendingTotalInPaise += r.derivedAmountInPaise;
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.doctorName.localeCompare(b.doctorName)
  );
}
