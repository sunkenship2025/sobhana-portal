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

  /** Every use of this code, reversed ones included, oldest first. */
  uses: {
    patientId: string | null;
    patientName: string | null;
    visitId: string;
    billId: string;
    at: Date;
    discountInPaise: number;
    reversed: boolean;
    /**
     * Billed to a number the code was also issued to. A signal for a family offer (the
     * holder may have registered again), never a block — families share phones.
     */
    samePhoneAsHolder: boolean;
  }[];
  /** Uses still standing, and how many the code allows. */
  usesLive: number;
  maxUses: number;

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
      id: true, code: true, status: true, patientId: true, phone: true, createdAt: true,
      expiresAt: true, issuedVisitId: true, automationRunId: true, maxUses: true,
      campaign: { select: { discountPercentage: true, maxDiscountPerBillInPaise: true } },
      // Every use — the record the ledger is built from. Coupon.redeemed* holds only the
      // first, and nothing new reads it.
      redemptions: {
        orderBy: { createdAt: 'asc' },
        select: { patientId: true, phone: true, visitId: true, billId: true, createdAt: true, discountInPaise: true, reversedAt: true },
      },
    },
  });
  if (coupons.length === 0) return [];

  const allUses = coupons.flatMap((c) => c.redemptions);
  const visitIds = [
    ...coupons.map((c) => c.issuedVisitId),
    ...allUses.map((u) => u.visitId),
  ].filter(Boolean) as string[];

  const [visits, bills, runs, patients] = await Promise.all([
    prisma.visit.findMany({
      where: { id: { in: visitIds } },
      select: { id: true, branchId: true, branch: { select: { name: true } } },
    }),
    prisma.bill.findMany({
      where: { id: { in: allUses.map((u) => u.billId) } },
      select: { id: true, totalAmountInPaise: true },
    }),
    prisma.automationRun.findMany({
      where: { id: { in: coupons.map((c) => c.automationRunId).filter(Boolean) as string[] } },
      select: {
        id: true, automationId: true, convertedAt: true, convertedValueInPaise: true, subjectId: true,
      },
    }),
    prisma.patient.findMany({
      where: { id: { in: [...coupons.map((c) => c.patientId), ...allUses.map((u) => u.patientId)].filter(Boolean) as string[] } },
      select: { id: true, name: true },
    }),
  ]);

  const visitById = new Map(visits.map((v) => [v.id, v]));
  const billById = new Map(bills.map((b) => [b.id, b]));
  const runById = new Map(runs.map((r) => [r.id, r]));
  const nameById = new Map(patients.map((p) => [p.id, p.name]));
  const now = new Date();

  const tail = (p: string | null) => (p ?? '').replace(/\D/g, '').slice(-10);

  return coupons.map((c) => {
    const run = c.automationRunId ? runById.get(c.automationRunId) : null;
    const issuedVisit = c.issuedVisitId ? visitById.get(c.issuedVisitId) : null;
    const live = c.redemptions.filter((u) => !u.reversedAt);
    const first = live[0] ?? null;
    const redeemedVisit = first ? visitById.get(first.visitId) : null;

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
      redeemedAt: first?.createdAt ?? null,
      // A code that was used never later reads as expired.
      expired: live.length === 0 && c.expiresAt <= now,

      discountPercentage: c.campaign.discountPercentage,
      maxDiscountPerBillInPaise: c.campaign.maxDiscountPerBillInPaise,
      actualDiscountInPaise: live.length ? live.reduce((n, u) => n + u.discountInPaise, 0) : null,
      transactionAmountInPaise: live.length
        ? live.reduce((n, u) => n + (billById.get(u.billId)?.totalAmountInPaise ?? 0), 0) : null,
      transactionBillId: first?.billId ?? null,

      issuedBranchId: issuedVisit?.branchId ?? null,
      issuedBranchName: issuedVisit?.branch.name ?? null,
      redeemedBranchId: redeemedVisit?.branchId ?? null,
      redeemedBranchName: redeemedVisit?.branch.name ?? null,

      // Recovery, not redemption. Someone who came in without using their code is a
      // success — the journey's job was to get them back, not to spend the discount.
      uses: c.redemptions.map((u) => ({
        patientId: u.patientId,
        patientName: u.patientId ? nameById.get(u.patientId) ?? null : null,
        visitId: u.visitId,
        billId: u.billId,
        at: u.createdAt,
        discountInPaise: u.discountInPaise,
        reversed: !!u.reversedAt,
        samePhoneAsHolder: !!c.phone && !!u.phone && tail(c.phone) === tail(u.phone),
      })),
      usesLive: live.length,
      maxUses: c.maxUses,

      recovered: !!run?.convertedAt,
      recoveredAt: run?.convertedAt ?? null,
      recoveredValueInPaise: run?.convertedValueInPaise ?? null,
    };
  });
}

/** The funnel a campaign is actually running, each stage counted from rows. */
export async function couponFunnel(campaignId: string) {
  const rows = await couponLedger(campaignId, 500);
  // Used = at least one standing use. A family code two relatives used is still ISSUED.
  const redeemed = rows.filter((r) => r.usesLive > 0);

  return {
    issued: rows.length,
    redeemed: redeemed.length,
    /** Standing uses across every code — one family code can account for several. */
    redemptions: rows.reduce((n, r) => n + r.usesLive, 0),
    /** Uses reversed because their bill was cancelled or refunded. */
    reversed: rows.reduce((n, r) => n + r.uses.filter((u) => u.reversed).length, 0),
    /** Uses billed to the holder's own phone number — worth a look, never a block. */
    samePhoneUses: rows.reduce((n, r) => n + r.uses.filter((u) => !u.reversed && u.samePhoneAsHolder).length, 0),
    expiredUnused: rows.filter((r) => r.expired).length,
    voided: rows.filter((r) => r.status === 'VOID').length,
    /** Still in date with a use left. */
    outstanding: rows.filter((r) => r.status === 'ISSUED' && !r.expired && r.usesLive < r.maxUses).length,

    /** Came in, whether or not the code was used. This is what the journey is for. */
    recovered: rows.filter((r) => r.recovered).length,
    /**
     * Came in and never used the code. Not a failure — the point is stated here because
     * folding it into "unredeemed" is how a working campaign starts looking broken.
     */
    recoveredWithoutUsingCode: rows.filter((r) => r.recovered && r.usesLive === 0).length,

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
      id: true, code: true, status: true, createdAt: true, expiresAt: true, automationRunId: true,
      redemptions: { select: { createdAt: true, reversedAt: true, reversedReason: true, patientId: true, visitId: true, discountInPaise: true } },
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
  // Every use and every reversal, not just the first use.
  for (const u of coupon.redemptions) {
    events.push({ at: u.createdAt, event: 'COUPON_REDEEMED', detail: { patientId: u.patientId, visitId: u.visitId, discountInPaise: u.discountInPaise } });
    if (u.reversedAt) events.push({ at: u.reversedAt, event: 'COUPON_USE_REVERSED', detail: { reason: u.reversedReason } });
  }
  if (!coupon.redemptions.some((u) => !u.reversedAt) && coupon.expiresAt <= new Date()) {
    events.push({ at: coupon.expiresAt, event: 'COUPON_EXPIRED' });
  }

  return {
    coupon,
    events: events.sort((a, b) => a.at.getTime() - b.at.getTime()),
  };
}
