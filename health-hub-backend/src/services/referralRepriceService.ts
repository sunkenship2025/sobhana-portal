/**
 * Re-apply a referral doctor's CURRENT rates to bills already made.
 *
 * Commission is frozen onto each TestOrder at billing, so changing a doctor's
 * rates only reaches future bills. When the old rate was simply wrong (the owner
 * agreed a rate and it was entered late), this re-prices the doctor's past
 * orders in a date window: preview first, then apply only the orders the owner
 * ticked. Statements, the Pay-Run and the dashboard all derive live from these
 * order snapshots, so they follow at once; saved ledger rows are re-derived.
 *
 * Resolution mirrors billing (routes/diagnosticVisits.ts) exactly:
 *   doctor·product rule (FIXED split across that product's tests on the bill)
 *   → doctor·category rule → centre·category rate → zero,
 * branch row beating the global row at each rung; a partner order then gets its
 * partner card's doctor-commission mode, as billing applies it. The order's
 * frozen payout category is kept — only the rate moves.
 *
 * What billing cannot tell us: an ad-hoc rate typed in at the counter is stored
 * like any other rate. A past rate matching neither the old nor the new ladder
 * is flagged and left unticked, so a hand-set rate is never overwritten blind.
 */
import { ReferralPayoutType } from '@prisma/client';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { categorize } from './payoutCategorize';
import { distributeFixedAmountInPaise } from './referralPayoutService';
import { allocateBillDiscountAcrossOrders, computeBillFinancialsFromPersisted } from './billFinancialService';
import { derivePayout, referralOrderCommissionInPaise } from './payoutService';
import { applyPartnerDoctorMode, loadPartnerRateCard, resolvePartnerRate, type PartnerRateCard } from './partnerRateService';

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

type Rate = {
  commissionType: ReferralPayoutType;
  commissionPercent: number | null;
  commissionAmountInPaise: number | null;
};
type Snapshot = {
  referralCommissionType: ReferralPayoutType;
  referralCommissionPercentage: number | null;
  referralCommissionAmountInPaise: number | null;
};

export interface RepriceLine {
  orderId: string;
  name: string;
  category: string;
  priceInPaise: number;
  discountShareInPaise: number;
  oldLabel: string;
  oldPayoutInPaise: number;
  newLabel: string;
  newPayoutInPaise: number;
  /** Old rate matched no rule we can see — possibly typed in at the counter. */
  handSet: boolean;
  /** Report not finalized yet: earns nothing until it is, then at the new rate. */
  notYetPayable: boolean;
}

export interface RepriceBill {
  visitId: string;
  billNumber: string;
  billedAt: string;
  patientName: string;
  branchName: string;
  lines: RepriceLine[];
}

export interface RepricePreview {
  doctor: { id: string; name: string };
  fromKey: string;
  toKey: string;
  branchId: string | null;
  bills: RepriceBill[];
  totals: {
    bills: number;
    orders: number;
    oldPayoutInPaise: number;
    newPayoutInPaise: number;
    alreadyCurrentOrders: number;
  };
}

export class RepriceInputError extends Error {}

function istStart(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - IST_OFFSET_MS);
}

const sameSnapshot = (a: Snapshot, b: Snapshot) =>
  a.referralCommissionType === b.referralCommissionType &&
  (a.referralCommissionPercentage ?? null) === (b.referralCommissionPercentage ?? null) &&
  (a.referralCommissionAmountInPaise ?? null) === (b.referralCommissionAmountInPaise ?? null);

const rateLabel = (s: Snapshot) =>
  s.referralCommissionType === 'FIXED_AMOUNT'
    ? `₹${((s.referralCommissionAmountInPaise ?? 0) / 100).toLocaleString('en-IN')}`
    : `${s.referralCommissionPercentage ?? 0}%`;

const toSnapshot = (r: Rate | null): Snapshot =>
  !r
    ? { referralCommissionType: 'PERCENTAGE', referralCommissionPercentage: 0, referralCommissionAmountInPaise: null }
    : r.commissionType === 'FIXED_AMOUNT'
      ? { referralCommissionType: 'FIXED_AMOUNT', referralCommissionPercentage: null, referralCommissionAmountInPaise: r.commissionAmountInPaise ?? 0 }
      : { referralCommissionType: 'PERCENTAGE', referralCommissionPercentage: r.commissionPercent ?? 0, referralCommissionAmountInPaise: null };

// This branch's row, else the global (branchId null) row.
function branchFirst<T extends { branchId: string | null }>(rows: T[], branchId: string): T | undefined {
  return rows.find((r) => r.branchId === branchId) ?? rows.find((r) => r.branchId === null);
}

async function computeReprice(
  doctorId: string,
  fromKey: string,
  toKey: string,
  branchId: string | null,
): Promise<{ preview: RepricePreview; next: Map<string, Snapshot>; old: Map<string, Snapshot> }> {
  if (!DATE_KEY.test(fromKey) || !DATE_KEY.test(toKey) || fromKey > toKey) {
    throw new RepriceInputError('Pick a valid from and to date.');
  }
  const doctor = await prisma.referralDoctor.findUnique({
    where: { id: doctorId },
    select: {
      id: true,
      name: true,
      productRules: { where: { isActive: true } },
      categoryRules: { where: { isActive: true } },
    },
  });
  if (!doctor) throw new RepriceInputError('Referral doctor not found.');
  const centreRates = await prisma.referralCategoryRate.findMany({ where: { isActive: true } });

  const visits = await prisma.visit.findMany({
    where: {
      domain: 'DIAGNOSTICS',
      createdAt: { gte: istStart(fromKey), lt: new Date(istStart(toKey).getTime() + DAY_MS) },
      ...(branchId ? { branchId } : {}),
      referrals: { some: { referralDoctorId: doctorId, deletedAt: null } },
    },
    orderBy: { createdAt: 'asc' },
    include: {
      branch: { select: { name: true } },
      patient: { select: { name: true } },
      bill: true,
      report: { include: { versions: { where: { status: 'FINALIZED' }, take: 1 } } },
      testOrders: {
        include: {
          product: { select: { name: true, payoutCategory: true } },
          test: { select: { name: true } },
        },
      },
    },
  });

  const cards = new Map<string, PartnerRateCard | null>();
  const cardFor = async (partnerId: string, kind: NonNullable<(typeof visits)[number]['testOrders'][number]['partnerArrangement']>, bid: string) => {
    const k = `${partnerId}|${kind}|${bid}`;
    if (!cards.has(k)) cards.set(k, await loadPartnerRateCard(partnerId, kind, bid));
    return cards.get(k) ?? null;
  };

  const bills: RepriceBill[] = [];
  const next = new Map<string, Snapshot>();
  const old = new Map<string, Snapshot>();
  let alreadyCurrent = 0;
  let oldTotal = 0;
  let newTotal = 0;

  for (const v of visits) {
    const live = v.testOrders.filter((o) => !o.cancelledAt && !o.replacedAt);
    const fin = v.bill ? computeBillFinancialsFromPersisted(v.bill) : null;
    const shares = fin
      ? allocateBillDiscountAcrossOrders(
          v.testOrders.filter((o) => !o.replacedAt).map((o) => ({ id: o.id, priceInPaise: o.priceInPaise })),
          fin.discountAmountInPaise,
        )
      : new Map<string, number>();
    const finalized = Boolean(v.report?.versions[0]?.finalizedAt);

    // A FIXED product rule is one amount for the whole product — split it across
    // that product's tests on this bill by price, exactly as billing does.
    const productRuleFor = (productId: string | null) =>
      productId ? branchFirst(doctor.productRules.filter((r) => r.productId === productId), v.branchId) : undefined;
    const fixedSplit = new Map<string, number>();
    const byProduct = new Map<string, typeof live>();
    for (const o of live) {
      const rule = productRuleFor(o.productId);
      if (rule?.commissionType === 'FIXED_AMOUNT' && o.productId) {
        byProduct.set(o.productId, [...(byProduct.get(o.productId) ?? []), o]);
      }
    }
    for (const [pid, orders] of byProduct) {
      const amounts = distributeFixedAmountInPaise(
        productRuleFor(pid)!.commissionAmountInPaise ?? 0,
        orders.map((o) => o.priceInPaise),
      );
      orders.forEach((o, i) => fixedSplit.set(o.id, amounts[i]));
    }

    const lines: RepriceLine[] = [];
    for (const o of live) {
      const category =
        o.payoutCategorySnapshot?.trim() ||
        categorize({ productPayoutCategory: o.product?.payoutCategory, productName: o.product?.name, testName: o.testNameSnapshot || o.test?.name });
      const productRule = productRuleFor(o.productId);
      const ladder: Snapshot = productRule
        ? productRule.commissionType === 'FIXED_AMOUNT'
          ? { referralCommissionType: 'FIXED_AMOUNT', referralCommissionPercentage: null, referralCommissionAmountInPaise: fixedSplit.get(o.id) ?? 0 }
          : toSnapshot(productRule)
        : toSnapshot(
            branchFirst(doctor.categoryRules.filter((r) => r.category === category), v.branchId) ??
              branchFirst(centreRates.filter((r) => r.category === category), v.branchId) ??
              null,
          );

      let target = ladder;
      if (o.partnerId && o.partnerArrangement) {
        const card = await cardFor(o.partnerId, o.partnerArrangement, v.branchId);
        if (!card) continue; // partner arrangement gone — leave this order exactly as billed
        const mode = resolvePartnerRate(card, o.productId, category).doctorCommissionMode;
        const adj = applyPartnerDoctorMode(ladder, mode, o.priceInPaise, o.ourShareInPaise ?? 0);
        target = {
          referralCommissionType: (adj.referralCommissionType ?? 'PERCENTAGE') as ReferralPayoutType,
          referralCommissionPercentage: adj.referralCommissionPercentage,
          referralCommissionAmountInPaise: adj.referralCommissionAmountInPaise,
        };
      }

      const current: Snapshot = {
        referralCommissionType: o.referralCommissionType,
        referralCommissionPercentage: o.referralCommissionPercentage,
        referralCommissionAmountInPaise: o.referralCommissionAmountInPaise,
      };
      if (sameSnapshot(current, target)) {
        alreadyCurrent++;
        continue;
      }

      // Would the CENTRE card alone have produced the old rate? If not, and no
      // doctor rule explains it, someone likely typed it at the counter.
      const centre = toSnapshot(branchFirst(centreRates.filter((r) => r.category === category), v.branchId) ?? null);
      const handSet = !o.partnerId && !sameSnapshot(current, centre);

      const share = shares.get(o.id) ?? 0;
      const oldPay = referralOrderCommissionInPaise({ priceInPaise: o.priceInPaise, ...current }, share);
      const newPay = referralOrderCommissionInPaise({ priceInPaise: o.priceInPaise, ...target }, share);
      next.set(o.id, target);
      old.set(o.id, current);
      lines.push({
        orderId: o.id,
        name: o.product?.name || o.testNameSnapshot || o.test?.name || 'Test',
        category,
        priceInPaise: o.priceInPaise,
        discountShareInPaise: share,
        oldLabel: rateLabel(current),
        oldPayoutInPaise: oldPay,
        newLabel: rateLabel(target),
        newPayoutInPaise: newPay,
        handSet,
        notYetPayable: !finalized && o.workflowMode !== 'BILL_ONLY' && o.noReportAt == null,
      });
      oldTotal += oldPay;
      newTotal += newPay;
    }
    if (lines.length) {
      bills.push({
        visitId: v.id,
        billNumber: v.billNumber,
        billedAt: v.createdAt.toISOString(),
        patientName: v.patient.name,
        branchName: v.branch.name,
        lines,
      });
    }
  }

  return {
    preview: {
      doctor: { id: doctor.id, name: doctor.name },
      fromKey,
      toKey,
      branchId,
      bills,
      totals: {
        bills: bills.length,
        orders: next.size,
        oldPayoutInPaise: oldTotal,
        newPayoutInPaise: newTotal,
        alreadyCurrentOrders: alreadyCurrent,
      },
    },
    next,
    old,
  };
}

export async function previewReferralReprice(
  doctorId: string,
  fromKey: string,
  toKey: string,
  branchId: string | null,
): Promise<RepricePreview> {
  return (await computeReprice(doctorId, fromKey, toKey, branchId)).preview;
}

/**
 * Apply the preview, minus the orders the owner unticked. Recomputed
 * server-side — the client never sends a rate. The client sends the unticked
 * ids (few; a ticked list of thousands overruns the JSON body limit) and how
 * many it expects to change: if bills moved since the preview, the counts
 * disagree and nothing is written. Order updates and the audit row commit
 * together; the audit row carries every old snapshot, so it is the undo.
 */
export async function applyReferralReprice(
  doctorId: string,
  fromKey: string,
  toKey: string,
  branchId: string | null,
  excludedOrderIds: string[],
  expectedCount: number,
  userId: string,
  auditBranchId: string,
): Promise<{ updated: number; oldPayoutInPaise: number; newPayoutInPaise: number; ledgersRederived: number }> {
  const { preview, next, old } = await computeReprice(doctorId, fromKey, toKey, branchId);
  const excluded = new Set(excludedOrderIds);
  const picked = [...next.keys()].filter((id) => !excluded.has(id));
  if (picked.length === 0) throw new RepriceInputError('Nothing to apply — no ticked test needs a new rate.');
  if (picked.length !== expectedCount) {
    throw new RepriceInputError('Bills changed since the preview. Check again, then apply.');
  }

  const lineById = new Map(preview.bills.flatMap((b) => b.lines.map((l) => [l.orderId, { ...l, billNumber: b.billNumber }] as const)));
  let oldSum = 0;
  let newSum = 0;
  for (const id of picked) {
    oldSum += lineById.get(id)!.oldPayoutInPaise;
    newSum += lineById.get(id)!.newPayoutInPaise;
  }

  const CHUNK = 200;
  await prisma.$transaction(
    async (tx) => {
      for (let i = 0; i < picked.length; i += CHUNK) {
        await Promise.all(
          picked.slice(i, i + CHUNK).map((id) => tx.testOrder.update({ where: { id }, data: next.get(id)! })),
        );
      }
      await tx.auditLog.create({
        data: {
          branchId: auditBranchId,
          actionType: 'UPDATE',
          entityType: 'ReferralRateReapplied',
          entityId: doctorId,
          userId,
          oldValues: JSON.stringify({
            orders: picked.map((id) => ({ id, ...old.get(id)! })),
          }),
          newValues: JSON.stringify({
            doctorName: preview.doctor.name,
            from: fromKey,
            to: toKey,
            branchId,
            orderCount: picked.length,
            billNumbers: [...new Set(picked.map((id) => lineById.get(id)!.billNumber))],
            oldPayoutInPaise: oldSum,
            newPayoutInPaise: newSum,
            orders: picked.map((id) => ({ id, ...next.get(id)! })),
          }),
        },
      });
    },
    { timeout: 120_000 },
  );

  // Saved Pay-Run rows hold a stored sum; refresh the ones the window touches.
  // Statements derive live, so a failure here only leaves a stale saved total.
  const ledgers = await prisma.doctorPayoutLedger.findMany({
    where: {
      doctorType: 'REFERRAL',
      referralDoctorId: doctorId,
      deletedAt: null,
      ...(branchId ? { branchId } : {}),
      periodEndDate: { gte: istStart(fromKey) },
    },
    select: { branchId: true, periodStartDate: true, periodEndDate: true },
  });
  let rederived = 0;
  for (const l of ledgers) {
    try {
      await derivePayout('REFERRAL', doctorId, l.branchId, l.periodStartDate, l.periodEndDate);
      rederived++;
    } catch (err) {
      logger.warn({ err, doctorId, period: l.periodStartDate }, 'referral reprice: ledger re-derive failed');
    }
  }

  return { updated: picked.length, oldPayoutInPaise: oldSum, newPayoutInPaise: newSum, ledgersRederived: rederived };
}

