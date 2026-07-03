/**
 * Owner Money page aggregations.
 *
 * Backs GET /api/owner/money. Answers: cash in, cash owed, cash out, who
 * handles it, where leakage happens.
 *
 * Sections (matched to the brief's layout):
 *   - kpis              Gross / Net / Outstanding / Discounts (+ deltas vs prior period)
 *   - revenueTrend      Daily net revenue across the period
 *   - aging             4-bucket receivables aging on open bills
 *   - oldestUnpaid      Top-N oldest unpaid bills with patient/branch/owed
 *   - cashByBranch      Per-branch revenue + cash/online split
 *   - cashByUser        Per-user collection split (audit signal)
 *   - discountLog       Bills with discounts (rows tinted >30% or >₹1000)
 *   - refunds           Total refunds + recent rows
 */

import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';
import type { Prisma } from '@prisma/client';

const CACHE_TTL_SEC = 60;
const cacheKey = (period: PeriodKey, branchId: string | null) =>
  `owner-money:v2:${period}:${branchId ?? 'all'}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_DISCOUNT_PCT = 30;
const HIGH_DISCOUNT_PAISE = 100_000; // ₹1,000 in paise
const HEAVY_CASH_PCT = 70;
const SOLO_USER_CASH_PCT = 80;

export type PeriodKey = '7d' | '30d' | 'mtd' | 'ytd';

export interface MoneyKpi {
  grossInPaise: number;
  netInPaise: number;
  outstandingInPaise: number;
  outstandingAgedInPaise: number; // > 30 days portion of outstanding
  outstandingAgedBillCount: number; // # of open bills aged > 30 days
  discountInPaise: number;
  discountBillCount: number;
  commissionInPaise: number; // referral + clinic commission accrued in period (Net-to-you composition)
  collectionRatePct: number | null; // % of this period's net-billable that has been collected
  grossDeltaPercent: number | null;
  netDeltaPercent: number | null;
}

export interface AgingBucket {
  key: '0_7' | '8_15' | '16_30' | '30_plus';
  label: string;
  amountInPaise: number;
  billCount: number;
}

export interface OldestUnpaidRow {
  billId: string;
  billNumber: string;
  patientId: string;
  patientName: string;
  patientTitle: string | null;
  branchCode: string;
  daysOverdue: number;
  owedInPaise: number;
}

export interface CashByBranchRow {
  branchId: string;
  branchName: string;
  branchCode: string;
  totalInPaise: number;
  cashInPaise: number;
  onlineInPaise: number;
  cashSharePct: number;
  flagHeavyCash: boolean;
}

export interface CashByUserRow {
  userId: string;
  userName: string;
  branchName: string;
  cashInPaise: number;
  onlineInPaise: number;
  totalCollectedInPaise: number;
  transactionCount: number;
  flagSoloCash: boolean;
}

export interface DiscountRow {
  billId: string;
  billNumber: string;
  patientName: string;
  patientTitle: string | null;
  branchCode: string;
  discountInPaise: number;
  discountPercent: number;
  reason: string | null;
  grantedBy: string | null;
  flag: boolean;
}

export interface RefundSummary {
  totalInPaise: number;
  count: number;
  pctOfGross: number | null;
  recent: Array<{
    billId: string;
    billNumber: string;
    patientName: string;
    patientTitle: string | null;
    refundedInPaise: number;
    reason: string | null;
    refundedAt: string;
  }>;
}

export interface MoneyResponse {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  kpis: MoneyKpi;
  revenueTrend: Array<{ date: string; netInPaise: number }>;
  aging: AgingBucket[];
  oldestUnpaid: OldestUnpaidRow[];
  cashByBranch: CashByBranchRow[];
  cashByUser: CashByUserRow[];
  cashByUserTotalCount: number;
  discountLog: DiscountRow[];
  discountLogTotalCount: number;
  refunds: RefundSummary;
}

// --- helpers ------------------------------------------------------------

function startOfTodayIst(now: Date): Date {
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  istNow.setUTCHours(0, 0, 0, 0);
  return new Date(istNow.getTime() - IST_OFFSET_MS);
}

function startOfDaysAgoIst(now: Date, daysAgo: number): Date {
  return new Date(startOfTodayIst(now).getTime() - daysAgo * DAY_MS);
}

function periodWindow(period: PeriodKey, now: Date): { start: Date; end: Date } {
  const todayStart = startOfTodayIst(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  if (period === '7d') return { start: startOfDaysAgoIst(now, 6), end: tomorrowStart };
  if (period === '30d') return { start: startOfDaysAgoIst(now, 29), end: tomorrowStart };
  if (period === 'mtd') {
    const ist = new Date(now.getTime() + IST_OFFSET_MS);
    ist.setUTCDate(1);
    ist.setUTCHours(0, 0, 0, 0);
    return { start: new Date(ist.getTime() - IST_OFFSET_MS), end: tomorrowStart };
  }
  // ytd
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCMonth(0, 1);
  ist.setUTCHours(0, 0, 0, 0);
  return { start: new Date(ist.getTime() - IST_OFFSET_MS), end: tomorrowStart };
}

function priorWindow(window: { start: Date; end: Date }) {
  const span = window.end.getTime() - window.start.getTime();
  return { start: new Date(window.start.getTime() - span), end: window.start };
}

function toIstDateKey(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function accruedCommissionInPaise(orders: Array<{
  priceInPaise: number;
  referralCommissionType: string | null;
  referralCommissionPercentage: number | null;
  referralCommissionAmountInPaise: number | null;
  diagnosticCenterCommissionType: string | null;
  diagnosticCenterCommissionPercentage: number | null;
  diagnosticCenterCommissionAmountInPaise: number | null;
}>): number {
  let total = 0;
  for (const o of orders) {
    if (o.referralCommissionType === 'PERCENTAGE') {
      total += Math.round((o.priceInPaise * (o.referralCommissionPercentage ?? 0)) / 100);
    } else if (o.referralCommissionType === 'FIXED_AMOUNT') {
      total += o.referralCommissionAmountInPaise ?? 0;
    }
    if (o.diagnosticCenterCommissionType === 'PERCENTAGE') {
      total += Math.round((o.priceInPaise * (o.diagnosticCenterCommissionPercentage ?? 0)) / 100);
    } else if (o.diagnosticCenterCommissionType === 'FIXED_AMOUNT') {
      total += o.diagnosticCenterCommissionAmountInPaise ?? 0;
    }
  }
  return total;
}

function clinicCommissionInPaise(visits: Array<{
  consultationFeeInPaise: number;
  clinicDoctor: { commissionType: string; commissionPercent: number; commissionAmountInPaise: number | null };
}>): number {
  let total = 0;
  for (const v of visits) {
    if (v.clinicDoctor.commissionType === 'PERCENTAGE') {
      total += Math.round((v.consultationFeeInPaise * (v.clinicDoctor.commissionPercent ?? 0)) / 100);
    } else if (v.clinicDoctor.commissionType === 'FIXED_AMOUNT') {
      total += v.clinicDoctor.commissionAmountInPaise ?? 0;
    }
  }
  return total;
}

// --- main entry ---------------------------------------------------------

export async function getOwnerMoney(
  period: PeriodKey,
  branchId: string | null,
): Promise<MoneyResponse> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const hit = await redis.get(cacheKey(period, branchId));
      if (hit) return JSON.parse(hit) as MoneyResponse;
    } catch (err) {
      logger.warn({ err, period, branchId }, 'owner-money: cache read failed');
    }
  }

  const now = new Date();
  const win = periodWindow(period, now);
  const prior = priorWindow(win);
  const billBranchWhere: Prisma.BillWhereInput = branchId ? { branchId } : {};

  const [
    scopedBranch,
    billsInWindow,
    testOrdersInWindow,
    clinicVisitsInWindow,
    priorBillsAgg,
    priorTestOrders,
    priorClinicVisits,
    openBills,
    refundedBills,
    paymentsInWindow,
    branches,
    refundedBillsRecent,
  ] = await Promise.all([
    branchId
      ? prisma.branch.findUnique({
          where: { id: branchId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),
    prisma.bill.findMany({
      where: { billedAt: { gte: win.start, lt: win.end }, ...billBranchWhere },
      select: {
        id: true,
        billNumber: true,
        branchId: true,
        billedAt: true,
        totalAmountInPaise: true,
        discountAmountInPaise: true,
        discountPercentage: true,
        discountReason: true,
        discountedByUser: { select: { name: true } },
        paidAmountInPaise: true,
        reversedChargeInPaise: true,
        paymentStatus: true,
        visit: { select: { patient: { select: { id: true, name: true, title: true } } } },
      },
    }),
    prisma.testOrder.findMany({
      where: {
        createdAt: { gte: win.start, lt: win.end },
        ...(branchId ? { branchId } : {}),
      },
      select: {
        priceInPaise: true,
        createdAt: true,
        referralCommissionType: true,
        referralCommissionPercentage: true,
        referralCommissionAmountInPaise: true,
        diagnosticCenterCommissionType: true,
        diagnosticCenterCommissionPercentage: true,
        diagnosticCenterCommissionAmountInPaise: true,
      },
    }),
    prisma.clinicVisit.findMany({
      where: {
        createdAt: { gte: win.start, lt: win.end },
        ...(branchId ? { visit: { branchId } } : {}),
      },
      select: {
        consultationFeeInPaise: true,
        createdAt: true,
        clinicDoctor: {
          select: {
            commissionType: true,
            commissionPercent: true,
            commissionAmountInPaise: true,
          },
        },
      },
    }),
    prisma.bill.aggregate({
      where: { billedAt: { gte: prior.start, lt: prior.end }, ...billBranchWhere },
      _sum: { totalAmountInPaise: true, discountAmountInPaise: true },
      _count: true,
    }),
    prisma.testOrder.findMany({
      where: {
        createdAt: { gte: prior.start, lt: prior.end },
        ...(branchId ? { branchId } : {}),
      },
      select: {
        priceInPaise: true,
        referralCommissionType: true,
        referralCommissionPercentage: true,
        referralCommissionAmountInPaise: true,
        diagnosticCenterCommissionType: true,
        diagnosticCenterCommissionPercentage: true,
        diagnosticCenterCommissionAmountInPaise: true,
      },
    }),
    prisma.clinicVisit.findMany({
      where: {
        createdAt: { gte: prior.start, lt: prior.end },
        ...(branchId ? { visit: { branchId } } : {}),
      },
      select: {
        consultationFeeInPaise: true,
        clinicDoctor: {
          select: {
            commissionType: true,
            commissionPercent: true,
            commissionAmountInPaise: true,
          },
        },
      },
    }),
    prisma.bill.findMany({
      where: { paymentStatus: { not: 'PAID' }, ...billBranchWhere },
      select: {
        id: true,
        billNumber: true,
        branchId: true,
        billedAt: true,
        totalAmountInPaise: true,
        discountAmountInPaise: true,
        paidAmountInPaise: true,
        reversedChargeInPaise: true,
        visit: { select: { patient: { select: { id: true, name: true, title: true } } } },
      },
    }),
    prisma.bill.aggregate({
      where: { paymentStatus: 'REFUNDED', billedAt: { gte: win.start, lt: win.end }, ...billBranchWhere },
      // Cash actually returned to the patient = what was paid in. Face value
      // (total - discount) overstates refunds for partially-paid bills.
      _sum: { paidAmountInPaise: true },
      _count: true,
    }),
    prisma.paymentTransaction.findMany({
      where: {
        transactionDate: { gte: win.start, lt: win.end },
        ...(branchId ? { bill: { branchId } } : {}),
      },
      select: {
        amountInPaise: true,
        paymentType: true,
        collectedByUserId: true,
        bill: { select: { branchId: true } },
        collectedByUser: {
          select: { id: true, name: true, activeBranch: { select: { name: true } } },
        },
      },
    }),
    prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true },
    }),
    prisma.bill.findMany({
      where: { paymentStatus: 'REFUNDED', billedAt: { gte: win.start, lt: win.end }, ...billBranchWhere },
      orderBy: { updatedAt: 'desc' },
      take: 5,
      select: {
        id: true,
        billNumber: true,
        paidAmountInPaise: true,
        refundReason: true,
        refundedAt: true,
        updatedAt: true,
        visit: { select: { patient: { select: { name: true, title: true } } } },
      },
    }),
  ]);

  // ---- KPIs ----
  const grossInWindow = billsInWindow.reduce((s, b) => s + b.totalAmountInPaise, 0);
  const discountInWindow = billsInWindow.reduce((s, b) => s + b.discountAmountInPaise, 0);
  const commissionInWindow =
    accruedCommissionInPaise(testOrdersInWindow) + clinicCommissionInPaise(clinicVisitsInWindow);
  const netInWindow = grossInWindow - discountInWindow - commissionInWindow;

  const priorGross = priorBillsAgg._sum.totalAmountInPaise ?? 0;
  const priorDiscount = priorBillsAgg._sum.discountAmountInPaise ?? 0;
  const priorCommission =
    accruedCommissionInPaise(priorTestOrders) + clinicCommissionInPaise(priorClinicVisits);
  const priorNet = priorGross - priorDiscount - priorCommission;

  const grossDeltaPercent =
    priorBillsAgg._count > 0 && priorGross > 0
      ? Math.round(((grossInWindow - priorGross) / priorGross) * 100)
      : null;
  const netDeltaPercent =
    priorBillsAgg._count > 0 && priorNet > 0
      ? Math.round(((netInWindow - priorNet) / priorNet) * 100)
      : null;

  // outstanding (all-time, scoped)
  const outstandingTotal = openBills.reduce(
    (s, b) =>
      s +
      Math.max(
        0,
        b.totalAmountInPaise - b.discountAmountInPaise - (b.reversedChargeInPaise ?? 0) - b.paidAmountInPaise,
      ),
    0,
  );
  // IST day boundary so "aged > 30d" matches the aging buckets below.
  const cutoff30 = startOfDaysAgoIst(now, 30);
  const agedOpenBills = openBills.filter(
    (b) =>
      b.billedAt < cutoff30 &&
      b.totalAmountInPaise - b.discountAmountInPaise - (b.reversedChargeInPaise ?? 0) - b.paidAmountInPaise > 0,
  );
  const outstandingAged = agedOpenBills.reduce(
    (s, b) =>
      s +
      Math.max(
        0,
        b.totalAmountInPaise - b.discountAmountInPaise - (b.reversedChargeInPaise ?? 0) - b.paidAmountInPaise,
      ),
    0,
  );
  const outstandingAgedBillCount = agedOpenBills.length;

  const discountBillCount = billsInWindow.filter((b) => b.discountAmountInPaise > 0).length;

  // Collection rate for the selected period: of what was net-billable
  // (gross - discount) for bills billed in this window, how much has been
  // collected. Unpaid-from-this-period = the still-owed remainder on those bills.
  const netBillableInWindow = grossInWindow - discountInWindow;
  const unpaidFromThisPeriod = billsInWindow.reduce(
    (s, b) =>
      s +
      Math.max(
        0,
        b.totalAmountInPaise - b.discountAmountInPaise - (b.reversedChargeInPaise ?? 0) - b.paidAmountInPaise,
      ),
    0,
  );
  const collectionRatePct =
    netBillableInWindow > 0
      ? Math.round(((netBillableInWindow - unpaidFromThisPeriod) / netBillableInWindow) * 100)
      : null;

  const kpis: MoneyKpi = {
    grossInPaise: grossInWindow,
    netInPaise: netInWindow,
    outstandingInPaise: outstandingTotal,
    outstandingAgedInPaise: outstandingAged,
    outstandingAgedBillCount,
    discountInPaise: discountInWindow,
    discountBillCount,
    commissionInPaise: commissionInWindow,
    collectionRatePct,
    grossDeltaPercent,
    netDeltaPercent,
  };

  // ---- revenue trend ----
  const dayKeys: string[] = [];
  const dayMap = new Map<string, number>();
  const spanDays = Math.max(
    1,
    Math.round((win.end.getTime() - win.start.getTime()) / DAY_MS) - 1,
  );
  for (let i = spanDays; i >= 0; i -= 1) {
    const k = toIstDateKey(startOfDaysAgoIst(now, i));
    dayKeys.push(k);
    dayMap.set(k, 0);
  }
  for (const b of billsInWindow) {
    const key = toIstDateKey(b.billedAt);
    if (dayMap.has(key)) {
      dayMap.set(key, (dayMap.get(key) ?? 0) + (b.totalAmountInPaise - b.discountAmountInPaise));
    }
  }
  for (const o of testOrdersInWindow) {
    const key = toIstDateKey(o.createdAt);
    if (!dayMap.has(key)) continue;
    dayMap.set(key, (dayMap.get(key) ?? 0) - accruedCommissionInPaise([o]));
  }
  for (const v of clinicVisitsInWindow) {
    const key = toIstDateKey(v.createdAt);
    if (!dayMap.has(key)) continue;
    dayMap.set(key, (dayMap.get(key) ?? 0) - clinicCommissionInPaise([v]));
  }
  const revenueTrend = dayKeys.map((d) => ({ date: d, netInPaise: dayMap.get(d) ?? 0 }));

  // ---- aging ----
  const cutoff7 = startOfDaysAgoIst(now, 7);
  const cutoff15 = startOfDaysAgoIst(now, 15);
  const cutoff30agedAt = startOfDaysAgoIst(now, 30);
  const aging: AgingBucket[] = [
    { key: '0_7', label: '0–7 days', amountInPaise: 0, billCount: 0 },
    { key: '8_15', label: '8–15 days', amountInPaise: 0, billCount: 0 },
    { key: '16_30', label: '16–30 days', amountInPaise: 0, billCount: 0 },
    { key: '30_plus', label: '30+ days', amountInPaise: 0, billCount: 0 },
  ];
  for (const b of openBills) {
    const owed = Math.max(
      0,
      b.totalAmountInPaise - b.discountAmountInPaise - (b.reversedChargeInPaise ?? 0) - b.paidAmountInPaise,
    );
    if (owed === 0) continue;
    let bucket: AgingBucket;
    if (b.billedAt >= cutoff7) bucket = aging[0];
    else if (b.billedAt >= cutoff15) bucket = aging[1];
    else if (b.billedAt >= cutoff30agedAt) bucket = aging[2];
    else bucket = aging[3];
    bucket.amountInPaise += owed;
    bucket.billCount += 1;
  }

  // ---- oldest unpaid (top 5) ----
  const branchById = new Map(branches.map((b) => [b.id, b]));
  const oldestUnpaid: OldestUnpaidRow[] = openBills
    .map((b) => {
      const owed = Math.max(
        0,
        b.totalAmountInPaise - b.discountAmountInPaise - (b.reversedChargeInPaise ?? 0) - b.paidAmountInPaise,
      );
      const days = Math.floor((now.getTime() - b.billedAt.getTime()) / DAY_MS);
      return {
        billId: b.id,
        billNumber: b.billNumber,
        patientId: b.visit.patient.id,
        patientName: b.visit.patient.name,
        patientTitle: b.visit.patient.title,
        branchCode: branchById.get(b.branchId)?.code ?? '?',
        daysOverdue: days,
        owedInPaise: owed,
      };
    })
    .filter((r) => r.owedInPaise > 0)
    .sort((a, b) => b.daysOverdue - a.daysOverdue)
    .slice(0, 5);

  // ---- cash by branch ----
  const branchCash = new Map<string, { cash: number; online: number }>();
  for (const p of paymentsInWindow) {
    const bid = p.bill.branchId;
    if (!bid) continue;
    const cur = branchCash.get(bid) ?? { cash: 0, online: 0 };
    if (p.paymentType === 'CASH') cur.cash += p.amountInPaise;
    else if (p.paymentType === 'ONLINE') cur.online += p.amountInPaise;
    branchCash.set(bid, cur);
  }
  const cashByBranch: CashByBranchRow[] = (branchId
    ? branches.filter((b) => b.id === branchId)
    : branches
  )
    .map((b) => {
      const c = branchCash.get(b.id) ?? { cash: 0, online: 0 };
      const total = c.cash + c.online;
      const cashShare = total > 0 ? Math.round((c.cash / total) * 100) : 0;
      return {
        branchId: b.id,
        branchName: b.name,
        branchCode: b.code,
        totalInPaise: total,
        cashInPaise: c.cash,
        onlineInPaise: c.online,
        cashSharePct: cashShare,
        flagHeavyCash: cashShare > HEAVY_CASH_PCT && total > 0,
      };
    })
    .sort((a, b) => b.totalInPaise - a.totalInPaise);

  // ---- cash by user ----
  const userMap = new Map<
    string,
    { name: string; branchName: string; cash: number; online: number; count: number }
  >();
  for (const p of paymentsInWindow) {
    const u = p.collectedByUserId;
    if (!u) continue;
    const cur = userMap.get(u) ?? {
      name: p.collectedByUser?.name ?? `(unknown ${u.slice(0, 6)})`,
      branchName: p.collectedByUser?.activeBranch?.name ?? '—',
      cash: 0,
      online: 0,
      count: 0,
    };
    if (p.paymentType === 'CASH') cur.cash += p.amountInPaise;
    else if (p.paymentType === 'ONLINE') cur.online += p.amountInPaise;
    cur.count += 1;
    userMap.set(u, cur);
  }
  const cashByUser: CashByUserRow[] = Array.from(userMap.entries())
    .map(([userId, v]) => {
      const userTotal = v.cash + v.online;
      const userCashShare = userTotal > 0 ? Math.round((v.cash / userTotal) * 100) : 0;
      return {
        userId,
        userName: v.name,
        branchName: v.branchName,
        cashInPaise: v.cash,
        onlineInPaise: v.online,
        totalCollectedInPaise: userTotal,
        transactionCount: v.count,
        flagSoloCash: userCashShare > SOLO_USER_CASH_PCT && userTotal > 0,
      };
    })
    .sort((a, b) => b.totalCollectedInPaise - a.totalCollectedInPaise);
  const cashByUserTotalCount = cashByUser.length;

  // ---- discount log ----
  const discountLog: DiscountRow[] = billsInWindow
    .filter((b) => b.discountAmountInPaise > 0)
    .map((b) => ({
      billId: b.id,
      billNumber: b.billNumber,
      patientName: b.visit.patient.name,
      patientTitle: b.visit.patient.title,
      branchCode: branchById.get(b.branchId)?.code ?? '?',
      discountInPaise: b.discountAmountInPaise,
      discountPercent: Math.round(b.discountPercentage ?? 0),
      reason: b.discountReason ?? null,
      grantedBy: b.discountedByUser?.name ?? null,
      flag:
        (b.discountPercentage ?? 0) > HIGH_DISCOUNT_PCT ||
        b.discountAmountInPaise > HIGH_DISCOUNT_PAISE,
    }))
    .sort((a, b) => b.discountInPaise - a.discountInPaise);
  const discountLogTotalCount = discountLog.length;

  // ---- refunds ----
  // Cash actually returned = sum of paidAmountInPaise on refunded bills, not
  // face value (total - discount).
  const refundedTotal = refundedBills._sum.paidAmountInPaise ?? 0;
  const refunds: RefundSummary = {
    totalInPaise: refundedTotal,
    count: refundedBills._count,
    pctOfGross:
      grossInWindow > 0 ? Math.round((refundedTotal / grossInWindow) * 1000) / 10 : null,
    recent: refundedBillsRecent.map((b) => ({
      billId: b.id,
      billNumber: b.billNumber,
      patientName: b.visit.patient.name,
      patientTitle: b.visit.patient.title,
      // Cash returned on this bill = what the patient had paid in.
      refundedInPaise: b.paidAmountInPaise ?? 0,
      reason: b.refundReason ?? null,
      // Prefer the real refund timestamp; fall back to updatedAt for historical
      // rows where the refund flow never wrote refundedAt.
      refundedAt: (b.refundedAt ?? b.updatedAt).toISOString(),
    })),
  };

  const response: MoneyResponse = {
    generatedAt: now.toISOString(),
    period: { key: period, startIso: win.start.toISOString(), endIso: win.end.toISOString() },
    branchScope: { branchId: branchId ?? null, branchName: scopedBranch?.name ?? null },
    kpis,
    revenueTrend,
    aging,
    oldestUnpaid,
    cashByBranch,
    cashByUser,
    cashByUserTotalCount,
    discountLog,
    discountLogTotalCount,
    refunds,
  };

  if (redis) {
    redis
      .set(cacheKey(period, branchId), JSON.stringify(response), 'EX', CACHE_TTL_SEC)
      .catch((err) => logger.warn({ err }, 'owner-money: cache write failed'));
  }

  return response;
}
