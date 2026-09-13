/**
 * The coupon's whole life, in one row and one timeline.
 *
 * Every field this needs already existed — on Coupon, on Bill, on the step log — but
 * nothing joined them, so "did the offer pay for itself" was a question you could only
 * answer by writing SQL by hand. Data being present is not the same as it being
 * available.
 *
 * THE SEPARATION THIS EXISTS TO PRESERVE: a journey stops when the patient comes in,
 * and the coupon keeps its own clock. Recovery and redemption are different outcomes and
 * the ledger reports them separately rather than folding one into the other — a patient
 * who came in without using their code is a success, not an unredeemed coupon.
 */
import prisma from '../../lib/prisma';

export interface CouponLedgerRow {
  couponId: string;
  code: string;
  status: string;

  patientId: string | null;
  patientName: string | null;
  /** The clinic visit that started the journey. */
  clinicVisitId: string | null;
  automationId: string | null;
  automationRunId: string | null;

  issuedAt: Date;
  expiresAt: Date;
  redeemedAt: Date | null;
  /** Past its date and never used. Derived, so no sweep has to have run. */
  expired: boolean;

  discountPercentage: number | null;
  maxDiscountPerBillInPaise: number | null;
  /** What the discount actually came to on the bill that used it. */
  actualDiscountInPaise: number | null;
  transactionAmountInPaise: number | null;
  transactionBillId: string | null;

  issuedBranchId: string | null;
  issuedBranchName: string | null;
  redeemedBranchId: string | null;
  redeemedBranchName: string | null;

  /** Did the patient come in at all, whether or not they used the code. */
  recovered: boolean;
  recoveredAt: Date | null;
  recoveredValueInPaise: number | null;
}

export async function couponLedger(campaignId: string, limit = 200): Promise<CouponLedgerRow[]> {
  const coupons = await prisma.coupon.findMany({
    where: { campaignId },
    orderBy: { createdAt: 'desc' },
    take: Math.min(limit, 500),
    select: {
      id: true, code: true, status: true, patientId: true, createdAt: true,
      expiresAt: true, redeemedAt: true, redeemedVisitId: true, redeemedBillId: true,
      issuedVisitId: true, automationRunId: true,
      campaign: { select: { discountPercentage: true, maxDiscountPerBillInPaise: true } },
    },
  });
  if (coupons.length === 0) return [];

  const visitIds = [
    ...coupons.map((c) => c.issuedVisitId),
    ...coupons.map((c) => c.redeemedVisitId),
  ].filter(Boolean) as string[];

  const [visits, bills, runs, patients] = await Promise.all([
    prisma.visit.findMany({
      where: { id: { in: visitIds } },
      select: { id: true, branchId: true, branch: { select: { name: true } } },
    }),
    prisma.bill.findMany({
      where: { id: { in: coupons.map((c) => c.redeemedBillId).filter(Boolean) as string[] } },
      select: { id: true, totalAmountInPaise: true, couponDiscountInPaise: true },
    }),
    prisma.automationRun.findMany({
      where: { id: { in: coupons.map((c) => c.automationRunId).filter(Boolean) as string[] } },
      select: {
        id: true, automationId: true, convertedAt: true, convertedValueInPaise: true, subjectId: true,
      },
    }),
    prisma.patient.findMany({
      where: { id: { in: coupons.map((c) => c.patientId).filter(Boolean) as string[] } },
      select: { id: true, name: true },
    }),
  ]);

  const visitById = new Map(visits.map((v) => [v.id, v]));
  const billById = new Map(bills.map((b) => [b.id, b]));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const nameById = new Map(patients.map((p) => [p.id, p.name]));
  const now = new Date();

  return coupons.map((c) => {
    const run = c.automationRunId ? runById.get(c.automationRunId) : null;
    const issuedVisit = c.issuedVisitId ? visitById.get(c.issuedVisitId) : null;
    const redeemedVisit = c.redeemedVisitId ? visitById.get(c.redeemedVisitId) : null;
    const bill = c.redeemedBillId ? billById.get(c.redeemedBillId) : null;

    return {
      couponId: c.id,
      code: c.code,
      status: c.status,
      patientId: c.patientId,
      patientName: c.patientId ? nameById.get(c.patientId) ?? null : null,
      // The run's subject IS the clinic visit that started this.
      clinicVisitId: run?.subjectId ?? c.issuedVisitId,
      automationId: run?.automationId ?? null,
      automationRunId: c.automationRunId,

      issuedAt: c.createdAt,
      expiresAt: c.expiresAt,
      redeemedAt: c.redeemedAt,
      expired: c.status !== 'REDEEMED' && c.expiresAt <= now,

      discountPercentage: c.campaign.discountPercentage,
      maxDiscountPerBillInPaise: c.campaign.maxDiscountPerBillInPaise,
      actualDiscountInPaise: bill?.couponDiscountInPaise ?? null,
      transactionAmountInPaise: bill?.totalAmountInPaise ?? null,
      transactionBillId: c.redeemedBillId,

      issuedBranchId: issuedVisit?.branchId ?? null,
      issuedBranchName: issuedVisit?.branch.name ?? null,
      redeemedBranchId: redeemedVisit?.branchId ?? null,
      redeemedBranchName: redeemedVisit?.branch.name ?? null,

      // Recovery, not redemption. Someone who came in without using their code is a
      // success — the journey's job was to get them back, not to spend the discount.
      recovered: !!run?.convertedAt,
      recoveredAt: run?.convertedAt ?? null,
      recoveredValueInPaise: run?.convertedValueInPaise ?? null,
    };
  });
}

/** The funnel a campaign is actually running, each stage counted from rows. */
export async function couponFunnel(campaignId: string) {
  const rows = await couponLedger(campaignId, 500);
  const redeemed = rows.filter((r) => r.status === 'REDEEMED');

  return {
    issued: rows.length,
    redeemed: redeemed.length,
    expiredUnused: rows.filter((r) => r.expired).length,
    voided: rows.filter((r) => r.status === 'VOID').length,
    /** Still live and still usable. */
    outstanding: rows.filter((r) => r.status === 'ISSUED' && !r.expired).length,

    /** Came in, whether or not the code was used. This is what the journey is for. */
    recovered: rows.filter((r) => r.recovered).length,
    /**
     * Came in and never used the code. Not a failure — the point is stated here because
     * folding it into "unredeemed" is how a working campaign starts looking broken.
     */
    recoveredWithoutUsingCode: rows.filter((r) => r.recovered && r.status !== 'REDEEMED').length,

    discountGivenInPaise: redeemed.reduce((n, r) => n + (r.actualDiscountInPaise ?? 0), 0),
    transactionValueInPaise: redeemed.reduce((n, r) => n + (r.transactionAmountInPaise ?? 0), 0),
  };
}

/**
 * One coupon's story, end to end.
 *
 * The step log holds what the journey did; the coupon holds what happened to the code.
 * Neither alone reconstructs "offer sent → claimed → sent → came in → redeemed", so the
 * two are merged into one ordered list.
 */
export async function couponJourney(couponId: string) {
  const coupon = await prisma.coupon.findUnique({
    where: { id: couponId },
    select: {
      id: true, code: true, status: true, createdAt: true, expiresAt: true,
      redeemedAt: true, automationRunId: true,
    },
  });
  if (!coupon) return null;

  const steps = coupon.automationRunId
    ? await prisma.automationStepLog.findMany({
        where: { runId: coupon.automationRunId },
        orderBy: { at: 'asc' },
        select: { at: true, kind: true, outcome: true, detail: true },
      })
    : [];

  const events: { at: Date; event: string; detail?: unknown }[] = steps.map((s) => ({
    at: s.at,
    event: `${s.kind}:${s.outcome}`,
    detail: s.detail,
  }));

  events.push({ at: coupon.createdAt, event: 'COUPON_ISSUED', detail: { code: coupon.code } });
  if (coupon.redeemedAt) events.push({ at: coupon.redeemedAt, event: 'COUPON_REDEEMED' });
  else if (coupon.expiresAt <= new Date()) {
    events.push({ at: coupon.expiresAt, event: 'COUPON_EXPIRED' });
  }

  return {
    coupon,
    events: events.sort((a, b) => a.at.getTime() - b.at.getTime()),
  };
}
