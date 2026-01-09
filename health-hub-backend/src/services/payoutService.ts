import { PrismaClient, PayoutDoctorType, PaymentType } from '@prisma/client';

const prisma = new PrismaClient();

// ===========================================================================
// TYPES
// ===========================================================================

export interface PayoutLineItem {
  visitId: string;
  billNumber: string;
  patientName: string;
  date: Date;
  testOrFee: string; // Test name for referral, "Consultation Fee" for clinic
  amountInPaise: number;
  commissionPercentage?: number; // Only for referral
  derivedCommissionInPaise: number;
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

// ===========================================================================
// DERIVATION LOGIC - REFERRAL DOCTORS
// ===========================================================================

/**
 * Derive payout for a referral doctor.
 * Formula: Sum of (testOrder.priceInPaise × testOrder.referralCommissionPercentage / 100)
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

  // Get all visits with finalized reports in the period
  const visits = await prisma.visit.findMany({
    where: {
      branchId,
      domain: 'DIAGNOSTICS',
      referrals: {
        some: { referralDoctorId },
      },
      report: {
        versions: {
          some: {
            status: 'FINALIZED',
            finalizedAt: {
              gte: periodStartDate,
              lte: periodEndDate,
            },
          },
        },
      },
    },
    include: {
      patient: { select: { name: true } },
      testOrders: {
        include: {
          test: { select: { name: true } },
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
  });

  const lineItems: PayoutLineItem[] = [];
  let totalDerivedInPaise = 0;

  for (const visit of visits) {
    const finalizedAt = visit.report?.versions[0]?.finalizedAt;

    for (const testOrder of visit.testOrders) {
      const commissionInPaise = Math.round(
        (testOrder.priceInPaise * testOrder.referralCommissionPercentage) / 100
      );
      totalDerivedInPaise += commissionInPaise;

      lineItems.push({
        visitId: visit.id,
        billNumber: visit.billNumber,
        patientName: visit.patient.name,
        date: finalizedAt || visit.createdAt,
        testOrFee: testOrder.test.name,
        amountInPaise: testOrder.priceInPaise,
        commissionPercentage: testOrder.referralCommissionPercentage,
        derivedCommissionInPaise: commissionInPaise,
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
    lineItems,
    derivedAmountInPaise: totalDerivedInPaise,
  };
}

// ===========================================================================
// DERIVATION LOGIC - CLINIC DOCTORS
// ===========================================================================

/**
 * Derive payout for a clinic doctor.
 * Formula: Sum of consultationFeeInPaise for all completed clinic visits in the period.
 */
async function deriveClinicPayout(
  clinicDoctorId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<PayoutDerivationResult> {
  // Get clinic doctor info
  const doctor = await prisma.clinicDoctor.findUnique({
    where: { id: clinicDoctorId },
    select: { id: true, name: true },
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
      createdAt: {
        gte: periodStartDate,
        lte: periodEndDate,
      },
    },
    include: {
      visit: {
        include: {
          patient: { select: { name: true } },
        },
      },
    },
  });

  const lineItems: PayoutLineItem[] = [];
  let totalDerivedInPaise = 0;

  for (const cv of clinicVisits) {
    totalDerivedInPaise += cv.consultationFeeInPaise;

    lineItems.push({
      visitId: cv.visit.id,
      billNumber: cv.visit.billNumber,
      patientName: cv.visit.patient.name,
      date: cv.createdAt,
      testOrFee: 'Consultation Fee',
      amountInPaise: cv.consultationFeeInPaise,
      derivedCommissionInPaise: cv.consultationFeeInPaise, // Full fee goes to doctor
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
// EXPORTED SERVICE FUNCTIONS
// ===========================================================================

/**
 * Derive and save a new payout ledger entry.
 * Returns existing entry if already derived for this period.
 */
export async function derivePayout(
  doctorType: PayoutDoctorType,
  doctorId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
): Promise<{ payout: PayoutDetail; isNew: boolean }> {
  // Check if payout already exists
  const existing = await prisma.doctorPayoutLedger.findFirst({
    where: {
      doctorType,
      ...(doctorType === 'REFERRAL'
        ? { referralDoctorId: doctorId }
        : { clinicDoctorId: doctorId }),
      branchId,
      periodStartDate,
      periodEndDate,
    },
    include: {
      referralDoctor: { select: { name: true } },
      clinicDoctor: { select: { name: true } },
      branch: { select: { name: true } },
    },
  });

  if (existing) {
    // Return existing with line items recalculated (for display only)
    const derivation =
      doctorType === 'REFERRAL'
        ? await deriveReferralPayout(doctorId, branchId, periodStartDate, periodEndDate)
        : await deriveClinicPayout(doctorId, branchId, periodStartDate, periodEndDate);

    return {
      payout: {
        id: existing.id,
        doctorType: existing.doctorType,
        doctorId: doctorType === 'REFERRAL' ? existing.referralDoctorId! : existing.clinicDoctorId!,
        doctorName:
          existing.referralDoctor?.name || existing.clinicDoctor?.name || 'Unknown',
        branchId: existing.branchId,
        branchName: existing.branch.name,
        periodStartDate: existing.periodStartDate,
        periodEndDate: existing.periodEndDate,
        derivedAmountInPaise: existing.derivedAmountInPaise,
        derivedAt: existing.derivedAt,
        paidAt: existing.paidAt,
        paymentMethod: existing.paymentMethod,
        paymentReferenceId: existing.paymentReferenceId,
        notes: existing.notes,
        reviewedAt: existing.reviewedAt,
        lineItems: derivation.lineItems,
      },
      isNew: false,
    };
  }

  // Derive new payout
  const derivation =
    doctorType === 'REFERRAL'
      ? await deriveReferralPayout(doctorId, branchId, periodStartDate, periodEndDate)
      : await deriveClinicPayout(doctorId, branchId, periodStartDate, periodEndDate);

  // Create new ledger entry
  const newPayout = await prisma.doctorPayoutLedger.create({
    data: {
      doctorType,
      referralDoctorId: doctorType === 'REFERRAL' ? doctorId : null,
      clinicDoctorId: doctorType === 'CLINIC' ? doctorId : null,
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
export async function listPayouts(
  branchId: string,
  filters?: {
    doctorType?: PayoutDoctorType;
    isPaid?: boolean;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<PayoutSummary[]> {
  const payouts = await prisma.doctorPayoutLedger.findMany({
    where: {
      branchId,
      ...(filters?.doctorType && { doctorType: filters.doctorType }),
      ...(filters?.isPaid !== undefined && {
        paidAt: filters.isPaid ? { not: null } : null,
      }),
      ...(filters?.startDate && { periodStartDate: { gte: filters.startDate } }),
      ...(filters?.endDate && { periodEndDate: { lte: filters.endDate } }),
    },
    include: {
      referralDoctor: { select: { name: true } },
      clinicDoctor: { select: { name: true } },
      branch: { select: { name: true } },
    },
    orderBy: { derivedAt: 'desc' },
  });

  return payouts.map((p) => ({
    id: p.id,
    doctorType: p.doctorType,
    doctorId: p.doctorType === 'REFERRAL' ? p.referralDoctorId! : p.clinicDoctorId!,
    doctorName: p.referralDoctor?.name || p.clinicDoctor?.name || 'Unknown',
    branchId: p.branchId,
    branchName: p.branch.name,
    periodStartDate: p.periodStartDate,
    periodEndDate: p.periodEndDate,
    derivedAmountInPaise: p.derivedAmountInPaise,
    derivedAt: p.derivedAt,
    paidAt: p.paidAt,
    paymentMethod: p.paymentMethod,
  }));
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
      branch: { select: { name: true } },
    },
  });

  if (!payout) return null;

  const doctorId =
    payout.doctorType === 'REFERRAL' ? payout.referralDoctorId! : payout.clinicDoctorId!;

  // Re-derive line items for display (amounts frozen in ledger)
  const derivation =
    payout.doctorType === 'REFERRAL'
      ? await deriveReferralPayout(
          doctorId,
          payout.branchId,
          payout.periodStartDate,
          payout.periodEndDate
        )
      : await deriveClinicPayout(
          doctorId,
          payout.branchId,
          payout.periodStartDate,
          payout.periodEndDate
        );

  return {
    id: payout.id,
    doctorType: payout.doctorType,
    doctorId,
    doctorName: payout.referralDoctor?.name || payout.clinicDoctor?.name || 'Unknown',
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

/**
 * Mark a payout as paid.
 * IMMUTABLE after this operation - no further changes allowed.
 */
export async function markPayoutPaid(
  payoutId: string,
  paymentMethod: PaymentType,
  paymentReferenceId?: string,
  notes?: string
): Promise<PayoutDetail> {
  // Get current payout
  const existing = await prisma.doctorPayoutLedger.findUnique({
    where: { id: payoutId },
  });

  if (!existing) {
    throw new Error('Payout not found');
  }

  if (existing.paidAt) {
    throw new Error('Payout already marked as paid - cannot modify');
  }

  // Update with payment info
  await prisma.doctorPayoutLedger.update({
    where: { id: payoutId },
    data: {
      paidAt: new Date(),
      paymentMethod,
      paymentReferenceId,
      notes,
    },
  });

  // Return full detail
  const detail = await getPayoutDetail(payoutId);
  if (!detail) {
    throw new Error('Failed to retrieve updated payout');
  }

  return detail;
}

/**
 * Get all referral doctors for dropdown selection.
 */
export async function getReferralDoctors(isActive?: boolean) {
  return prisma.referralDoctor.findMany({
    where: isActive !== undefined ? { isActive } : undefined,
    select: {
      id: true,
      doctorNumber: true,
      name: true,
      commissionPercent: true,
      isActive: true,
    },
    orderBy: { name: 'asc' },
  });
}

/**
 * Get all clinic doctors for dropdown selection.
 */
export async function getClinicDoctors(isActive?: boolean) {
  return prisma.clinicDoctor.findMany({
    where: isActive !== undefined ? { isActive } : undefined,
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
