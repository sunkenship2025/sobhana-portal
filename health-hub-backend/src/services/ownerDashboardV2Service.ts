/**
 * Owner dashboard v2 — decision-first aggregations.
 *
 * Backs the redesigned `/` owner page. Returns the entire dashboard payload in
 * a single call:
 *   - actionQueue       chips that fire when a decision is pending
 *   - moneyToday        gross → discount → commission → net waterfall + cash/online
 *   - payoutLiability   commission accrued to date, split by doctor type.
 *                       The dashboard's Payouts card leads with moneyToday.commissionInPaise
 *                       (period-scoped) and shows these underneath as the live stock.
 *   - opsPulse          diagnostics / clinic / comms 3-tile status
 *   - kpis              the window's money totals and the prior window's, for deltas
 *   - trend             per day: collected, billed, net, visits, discount — each
 *                       beside the same day one window earlier
 *   - revenueTrend      daily net collected (kept for bundles cached before `trend`)
 *   - revenueMix        window's gross split: reportable / clinic / bill-only+external
 *   - branchTable       per-branch KPIs for the period
 *   - dataAge           days since first visit, used by the UI to suppress
 *                       comparison deltas during the first 30 days
 *
 * Every period money figure comes from the money engine (moneyFactsService):
 * the database adds up by day × branch × register, so this never loads the
 * window's bills — and the Money page reads the same engine.
 *
 * Register scoping (`domain`, like the Money page): DIAGNOSTICS, CLINIC, or null
 * for both. It scopes every money figure — bills, payments, test orders, clinic
 * fees and commission — in the waterfall, collections, trend, mix, receivables
 * and branch table. Ops pulse and the payout ledger always cover both.
 *
 * Branch scoping: if `branchId` is null, all branches are aggregated. The
 * owner dashboard defaults to "all branches" per the brief.
 *
 * Time zone: every "today" / day boundary is computed in Asia/Kolkata (the
 * business time zone). The DB stores UTC timestamps; helpers convert.
 *
 * Caching: 60s in Redis when available. Cache key includes branchId so an
 * owner switching branches gets fresh data immediately.
 */

import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import {
  getBusyHours,
  getMoneyFacts,
  getReferrerFacts,
  getSourceFacts,
  totalsOf,
  type BusyHourFact,
  type DayFact,
  type MoneyTotals,
  type ReferrerFact,
  type SourceFact,
} from './moneyFactsService';
import { logger } from '../lib/logger';
import type { Prisma, VisitDomain } from '@prisma/client';

const CACHE_TTL_SEC = 60;
const cacheKey = (
  branchId: string | null,
  period: PeriodKey,
  range: CustomRange | null,
  domain: VisitDomain | null,
) =>
  `owner-dashboard-v2:v8:${branchId ?? 'all'}:${period}:${range ? `${range.startKey}_${range.endKey}` : ''}:${domain ?? 'all'}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TREND_DAYS = 120; // cap daily trend points so long windows (YTD) stay readable
const SLA_TAT_MINUTES = 1440; // 24h from registration (owner-set SLA)
const DORMANT_DAYS = 7;

export type PeriodKey = 'today' | 'yesterday' | '7d' | '30d' | 'mtd' | 'ytd' | 'custom';

/** IST calendar-day range for a custom filter, inclusive of both endpoints. */
export interface CustomRange {
  startKey: string; // YYYY-MM-DD (IST)
  endKey: string; // YYYY-MM-DD (IST)
}

// --- types ---------------------------------------------------------------

export type ActionChipType =
  | 'late_reports'
  | 'unpaid_aged'
  | 'whatsapp_failed'
  | 'large_discount'
  | 'dormant_branch'
  | 'identity_change_unjustified';

export interface ActionChip {
  type: ActionChipType;
  severity: 'high' | 'medium' | 'low';
  label: string;
  count?: number;
  amountInPaise?: number;
  drillTo: string;
}

export interface MoneyToday {
  grossInPaise: number;
  discountInPaise: number;
  // Charges voided after billing (order cancellations). Reduces net billed.
  reversedInPaise: number;
  commissionInPaise: number;
  netInPaise: number;
  // Discounts as a % of gross (0 when gross is 0). Surfaced inline so a
  // discount leak is visible without opening the discounts page.
  discountRatePct: number;
  cashInPaise: number;
  onlineInPaise: number;
  // Cash + online collected in the window (gross inflow, before refunds).
  // Collected differs from billed because patients pay across days.
  collectedTotalInPaise: number;
  // Cash returned to patients in the window (REFUND transactions). Reduces
  // net collected (collectedTotalInPaise − refundInPaise).
  refundInPaise: number;
  outstandingInPaise: number;
  // Net vs the prior equal-length window. Null when the prior window had no
  // net revenue to compare against (so the UI suppresses the delta).
  deltaPercent: number | null;
  // The headline: cash + online collected less refunds paid out, and the same
  // against the prior equal-length window (null when that had nothing).
  netCollectedInPaise: number;
  collectedDeltaPercent: number | null;
}

export interface PayoutLiability {
  totalInPaise: number;
  byType: {
    referralInPaise: number;
    clinicInPaise: number;
    partnerInPaise: number;
  };
}

export interface OpsPulseDiagnostics {
  ordersToday: number;
  finalizedToday: number;
  inProgress: number;
  pendingSample: number;
  tatP50Minutes: number | null;
  tatP95Minutes: number | null;
  tatBreachCount: number;
  tatSampleCount: number;
}

export interface OpsPulseClinic {
  waiting: number;
  inConsultation: number;
  completedToday: number;
  revisitsToday: number;
  revisitRatePct: number | null;
  avgWaitMinutes: number | null;
  onShiftDoctorName: string | null;
}

export interface OpsPulseComms {
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  optInPercent: number | null;
}

export interface OpsPulse {
  diagnostics: OpsPulseDiagnostics;
  clinic: OpsPulseClinic;
  comms: OpsPulseComms;
}

export interface TrendPoint {
  date: string; // YYYY-MM-DD in IST
  // Cash + online collected that day minus refunds paid out — the same basis
  // as moneyToday's "Net collected", so the series sums to it.
  collectedInPaise: number;
}

/** One day's figures (paise; visits/bills are counts). */
export interface DayPoint {
  collected: number;
  gross: number;
  net: number;
  visits: number;
  discount: number;
  bills: number;
}

/** A day of the window, beside the same day one window earlier. */
export interface TrendDay extends DayPoint {
  date: string; // YYYY-MM-DD in IST
  prior: DayPoint;
}

/** Billed (test price) in one payout category: this window and the prior one. */
export interface CategoryMove {
  category: string;
  current: number;
  prior: number;
  tests: number;
  priorTests: number;
}

export interface RevenueMix {
  reportableInPaise: number;
  clinicInPaise: number;
  billOnlyInPaise: number;
  totalInPaise: number;
}

export interface BranchRow {
  branchId: string;
  branchName: string;
  branchCode: string;
  netInPaise: number;
  visitCount: number;
  avgTicketInPaise: number | null;
  tatP50Minutes: number | null;
  tatSampleCount: number;
  deltaPercent: number | null;
  daysDormant: number; // 0 if active in window
  collectedInPaise: number;
  grossInPaise: number;
  discountInPaise: number;
  collectedDaily: number[]; // one per `trend` day
}

export interface DashboardV2Response {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  branchScope: {
    branchId: string | null;
    branchName: string | null;
  };
  dataAge: {
    firstVisitAt: string | null;
    daysSinceLaunch: number;
  };
  actionQueue: ActionChip[];
  moneyToday: MoneyToday;
  payoutLiability: PayoutLiability;
  opsPulse: OpsPulse;
  revenueTrend: TrendPoint[];
  trend: TrendDay[];
  kpis: { current: MoneyTotals & { outstanding: number }; prior: MoneyTotals };
  revenueMix: RevenueMix;
  categoryMoves: CategoryMove[];
  sources: SourceFact[];
  referrers: ReferrerFact[];
  busyHours: BusyHourFact[];
  branchTable: BranchRow[];
}

// --- helpers -------------------------------------------------------------

/** Start of today in IST, returned as a UTC Date suitable for Prisma queries. */
function startOfTodayIst(now: Date): Date {
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  istNow.setUTCHours(0, 0, 0, 0);
  return new Date(istNow.getTime() - IST_OFFSET_MS);
}

function startOfDaysAgoIst(now: Date, daysAgo: number): Date {
  const today = startOfTodayIst(now);
  return new Date(today.getTime() - daysAgo * DAY_MS);
}

/** Parse a YYYY-MM-DD IST calendar day into the UTC Date at its IST midnight. */
function istDateKeyToStart(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0) - IST_OFFSET_MS);
}

/** Inclusive [startKey, endKey] IST calendar range → half-open [start, end) UTC window. */
function customWindow(range: CustomRange): { start: Date; end: Date } {
  const start = istDateKeyToStart(range.startKey);
  const end = new Date(istDateKeyToStart(range.endKey).getTime() + DAY_MS);
  return { start, end };
}

/** The selected reporting window as a half-open [start, end) UTC range. */
function periodWindow(period: PeriodKey, now: Date): { start: Date; end: Date } {
  const todayStart = startOfTodayIst(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  if (period === 'today') return { start: todayStart, end: tomorrowStart };
  if (period === 'yesterday') return { start: startOfDaysAgoIst(now, 1), end: todayStart };
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

/** Format a UTC instant as YYYY-MM-DD in IST. */
function toIstDateKey(d: Date): string {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const day = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// --- main entry ----------------------------------------------------------

export async function getOwnerDashboardV2(
  branchId: string | null,
  period: PeriodKey = '30d',
  range: CustomRange | null = null,
  domain: VisitDomain | null = 'DIAGNOSTICS',
): Promise<DashboardV2Response> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const hit = await redis.get(cacheKey(branchId, period, range, domain));
      if (hit) return JSON.parse(hit) as DashboardV2Response;
    } catch (err) {
      logger.warn({ err, branchId }, 'dashboard-v2: cache read failed');
    }
  }

  const now = new Date();
  // Now-anchored boundaries drive the "live / as of now" zone: action queue,
  // open receivables, payout liability and ops pulse. These never move with the
  // period slicer — they are current-state alerts, not period metrics.
  const todayStart = startOfTodayIst(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const yesterdayStart = startOfDaysAgoIst(now, 1);
  const sevenDaysAgo = startOfDaysAgoIst(now, 7);

  // The selected reporting window drives the period zone: money summary,
  // revenue trend, revenue mix and the branch table. `priorWin` is the equal-
  // length window immediately before it, for period-over-period deltas.
  const win = period === 'custom' && range ? customWindow(range) : periodWindow(period, now);
  const winSpanMs = win.end.getTime() - win.start.getTime();
  const winDays = Math.max(1, Math.round(winSpanMs / DAY_MS));
  const priorWin = { start: new Date(win.start.getTime() - winSpanMs), end: win.start };
  // Cap the number of daily points so long windows (YTD) stay readable; the
  // trend then shows the most recent MAX_TREND_DAYS of the selected window.
  const trendDays = Math.min(winDays, MAX_TREND_DAYS);
  const trendStart = new Date(win.end.getTime() - trendDays * DAY_MS);

  // ----- branch resolution & data age ------------------------------------
  const branchScopeWhere: Prisma.VisitWhereInput = branchId ? { branchId } : {};
  const billBranchWhere: Prisma.BillWhereInput = branchId ? { branchId } : {};
  // Money surfaces: same branch scope, narrowed to the selected register.
  const moneyBillWhere: Prisma.BillWhereInput = domain
    ? { ...billBranchWhere, visit: { domain } }
    : billBranchWhere;

  const [scopedBranch, firstVisit] = await Promise.all([
    branchId
      ? prisma.branch.findUnique({
          where: { id: branchId },
          select: { id: true, name: true, code: true },
        })
      : Promise.resolve(null),
    prisma.visit.findFirst({
      where: branchScopeWhere,
      orderBy: { createdAt: 'asc' },
      select: { createdAt: true },
    }),
  ]);

  const daysSinceLaunch = firstVisit
    ? Math.floor((now.getTime() - firstVisit.createdAt.getTime()) / DAY_MS)
    : 0;

  // ----- run independent aggregations in parallel ------------------------
  const [
    // action queue inputs
    lateDraftCount,
    unpaidAgedAgg,
    waFailedCount,
    largeDiscountCount,
    identityChangeNoReasonCount,
    // branch dormancy needs all branches regardless of selected scope
    allBranches,

    // open receivables (live, all-time)
    todayOutstandingAgg,
    // every period money figure: the window and the equal window before it
    facts,
    sources,
    referrerFacts,
    busyHours,

    // payout liability
    payoutLiabilityRows,

    // ops pulse
    diagOrdersToday,
    diagFinalizedTodaySamples,
    diagInProgress,
    diagPendingSample,
    clinicWaiting,
    clinicInProgress,
    clinicCompletedToday,
    clinicRevisitsToday,
    clinicRecentCompleted,
    clinicShiftDoctor,
    commsAggToday,
    optInWindowVisits,

    // branch table — TAT by branch (selected window)
    branchTatSamples,
  ] = await Promise.all([
    // Overdue result entry — count DIAGNOSTIC VISITS (one row per visit) still
    // in the entry queue and older than 24h, mirroring the Result Queue page.
    // Counting reportVersion rows over-counted: it swept in cancelled visits,
    // finalized partial-report leftovers (a fresh versionNum+1 DRAFT lingers),
    // and multiple version rows per report. Gate on the visit's own workflow
    // status (DRAFT/WAITING excludes CANCELLED & COMPLETED) plus an open draft.
    prisma.visit.count({
      where: {
        domain: 'DIAGNOSTICS',
        status: { in: ['DRAFT', 'WAITING'] },
        createdAt: { lt: new Date(now.getTime() - DAY_MS) },
        report: { versions: { some: { status: 'DRAFT' } } },
        ...(branchId ? { branchId } : {}),
      },
    }),
    prisma.bill.findMany({
      where: {
        billedAt: { lt: sevenDaysAgo },
        paymentStatus: { not: 'PAID' },
        ...billBranchWhere,
      },
      select: {
        totalAmountInPaise: true, paidAmountInPaise: true, discountAmountInPaise: true,
        couponDiscountInPaise: true, reversedChargeInPaise: true,
      },
    }),
    prisma.messageLog.count({
      where: {
        status: 'FAILED',
        updatedAt: { gte: yesterdayStart },
        ...(branchId ? { branchId } : {}),
      },
    }),
    prisma.bill.count({
      where: {
        billedAt: { gte: yesterdayStart },
        discountPercentage: { gt: 30 },
        ...billBranchWhere,
      },
    }),
    prisma.patientChangeLog.count({
      where: {
        changeType: 'IDENTITY',
        changeReason: null,
        createdAt: { gte: yesterdayStart },
      },
    }),
    prisma.branch.findMany({
      where: { isActive: true },
      select: { id: true, name: true, code: true, createdAt: true },
    }),

    prisma.bill.aggregate({
      where: {
        paymentStatus: { not: 'PAID' },
        ...moneyBillWhere,
      },
      _sum: { totalAmountInPaise: true, paidAmountInPaise: true, discountAmountInPaise: true, couponDiscountInPaise: true, reversedChargeInPaise: true },
    }),
    getMoneyFacts({ start: priorWin.start, end: win.end, branchId, domain }),
    getSourceFacts({ start: priorWin.start, end: win.end, branchId, domain }, win.start),
    getReferrerFacts({ start: priorWin.start, end: win.end, branchId, domain }, win.start),
    getBusyHours({ start: win.start, end: win.end, branchId, domain }),
    // payout liability
    prisma.doctorPayoutLedger.groupBy({
      by: ['doctorType'],
      where: {
        deletedAt: null,
        ...(branchId ? { branchId } : {}),
      },
      _sum: { derivedAmountInPaise: true },
    }),

    // ops pulse — diagnostics
    prisma.testOrder.count({
      where: {
        createdAt: { gte: todayStart, lt: tomorrowStart },
        ...(branchId ? { branchId } : {}),
      },
    }),
    prisma.reportVersion.findMany({
      where: {
        status: 'FINALIZED',
        finalizedAt: { gte: todayStart, lt: tomorrowStart },
        ...(branchId ? { report: { branchId } } : {}),
      },
      select: {
        finalizedAt: true,
        report: { select: { visit: { select: { createdAt: true } } } },
      },
      take: 500,
    }),
    prisma.visit.count({
      where: {
        domain: 'DIAGNOSTICS',
        status: 'IN_PROGRESS',
        ...branchScopeWhere,
      },
    }),
    prisma.testOrder.count({
      where: {
        visit: { status: 'WAITING', domain: 'DIAGNOSTICS', ...branchScopeWhere },
        testResults: { none: {} },
      },
    }),

    // ops pulse — clinic
    prisma.clinicVisit.count({
      where: {
        status: 'WAITING',
        ...(branchId ? { visit: { branchId } } : {}),
      },
    }),
    prisma.clinicVisit.count({
      where: {
        status: 'IN_PROGRESS',
        ...(branchId ? { visit: { branchId } } : {}),
      },
    }),
    prisma.clinicVisit.count({
      where: {
        status: 'COMPLETED',
        completedAt: { gte: todayStart, lt: tomorrowStart },
        ...(branchId ? { visit: { branchId } } : {}),
      },
    }),
    prisma.clinicVisit.count({
      where: {
        isRevisit: true,
        createdAt: { gte: todayStart, lt: tomorrowStart },
        ...(branchId ? { visit: { branchId } } : {}),
      },
    }),
    prisma.clinicVisit.findMany({
      where: {
        status: { in: ['IN_PROGRESS', 'COMPLETED'] },
        startedAt: { gte: todayStart, lt: tomorrowStart },
        ...(branchId ? { visit: { branchId } } : {}),
      },
      select: { createdAt: true, startedAt: true },
      take: 200,
    }),
    // "On shift" = clinic doctor with at least one IN_PROGRESS visit. Pick the
    // most recent so the tile reads as the doctor currently consulting.
    prisma.clinicVisit.findFirst({
      where: {
        status: 'IN_PROGRESS',
        ...(branchId ? { visit: { branchId } } : {}),
      },
      orderBy: { startedAt: 'desc' },
      select: { clinicDoctor: { select: { name: true } } },
    }),
    prisma.messageLog.groupBy({
      by: ['status'],
      where: {
        createdAt: { gte: todayStart, lt: tomorrowStart },
        ...(branchId ? { branchId } : {}),
      },
      _count: true,
    }),
    prisma.visit.findMany({
      where: {
        createdAt: { gte: todayStart, lt: tomorrowStart },
        ...branchScopeWhere,
      },
      select: { patient: { select: { whatsappOptIn: true } } },
      take: 1000,
    }),

    prisma.reportVersion.findMany({
      where: {
        status: 'FINALIZED',
        finalizedAt: { gte: win.start, lt: win.end },
      },
      select: {
        finalizedAt: true,
        report: { select: { branchId: true, visit: { select: { createdAt: true } } } },
      },
      take: 2000,
    }),
  ]);

  // ----- action queue ----------------------------------------------------
  const actionQueue: ActionChip[] = [];
  if (lateDraftCount > 0) {
    actionQueue.push({
      type: 'late_reports',
      severity: 'high',
      label: `${lateDraftCount} report${lateDraftCount === 1 ? '' : 's'} overdue`,
      count: lateDraftCount,
      drillTo: '/diagnostics/pending?filter=overdue',
    });
  }

  const unpaidAgedAmount = unpaidAgedAgg.reduce(
    (sum, b) =>
      sum +
      Math.max(
        0,
        b.totalAmountInPaise - b.discountAmountInPaise - b.couponDiscountInPaise -
          b.reversedChargeInPaise - b.paidAmountInPaise,
      ),
    0,
  );
  if (unpaidAgedAmount > 0) {
    actionQueue.push({
      type: 'unpaid_aged',
      severity: 'medium',
      label: `${formatRupeesShort(unpaidAgedAmount)} unpaid > 7d`,
      amountInPaise: unpaidAgedAmount,
      drillTo: '/money/bills?aging=8plus',
    });
  }

  if (waFailedCount > 0) {
    actionQueue.push({
      type: 'whatsapp_failed',
      severity: 'high',
      label: `${waFailedCount} WhatsApp failure${waFailedCount === 1 ? '' : 's'} since yesterday`,
      count: waFailedCount,
      drillTo: '/ops/audit?tab=comms',
    });
  }

  if (largeDiscountCount > 0) {
    actionQueue.push({
      type: 'large_discount',
      severity: 'medium',
      label: `${largeDiscountCount} discount${largeDiscountCount === 1 ? '' : 's'} > 30%`,
      count: largeDiscountCount,
      drillTo: '/money/discounts?filter=high',
    });
  }

  // dormant_branch — only meaningful in all-branches view
  if (!branchId) {
    const visitsLast7 = await prisma.visit.groupBy({
      by: ['branchId'],
      where: { createdAt: { gte: sevenDaysAgo } },
      _count: true,
    });
    const activeBranchSet = new Set(visitsLast7.map((v) => v.branchId));
    const dormantCount = allBranches.filter(
      (b) =>
        !activeBranchSet.has(b.id) &&
        now.getTime() - b.createdAt.getTime() > 7 * DAY_MS,
    ).length;
    if (dormantCount > 0) {
      actionQueue.push({
        type: 'dormant_branch',
        severity: 'medium',
        label: `${dormantCount} dormant branch${dormantCount === 1 ? '' : 'es'}`,
        count: dormantCount,
        drillTo: '/owner#branch-performance',
      });
    }
  }

  if (identityChangeNoReasonCount > 0) {
    actionQueue.push({
      type: 'identity_change_unjustified',
      severity: 'high',
      label: `${identityChangeNoReasonCount} identity change${identityChangeNoReasonCount === 1 ? '' : 's'} unjustified`,
      count: identityChangeNoReasonCount,
      drillTo: '/ops/audit?tab=identity',
    });
  }

  // ----- money summary (selected window) ---------------------------------
  // Every period figure comes from the money engine; the one fetch spans the
  // prior window too, split here by IST day.
  const winStartKey = toIstDateKey(win.start);
  const curFacts = facts.days.filter((f) => f.date >= winStartKey);
  const priorFacts = facts.days.filter((f) => f.date < winStartKey);
  const cur = totalsOf(curFacts);
  const prior = totalsOf(priorFacts);
  const pct = (now: number, before: number) =>
    before > 0 ? Math.round(((now - before) / before) * 100) : null;

  // Open receivables stay all-time regardless of the slicer (a live figure).
  const outstandingTotal = Math.max(
    0,
    (todayOutstandingAgg._sum.totalAmountInPaise ?? 0) -
      (todayOutstandingAgg._sum.paidAmountInPaise ?? 0) -
      (todayOutstandingAgg._sum.discountAmountInPaise ?? 0) -
      (todayOutstandingAgg._sum.couponDiscountInPaise ?? 0) -
      (todayOutstandingAgg._sum.reversedChargeInPaise ?? 0),
  );

  const moneyToday: MoneyToday = {
    grossInPaise: cur.gross,
    discountInPaise: cur.discount,
    reversedInPaise: cur.cancelled,
    commissionInPaise: cur.commission,
    netInPaise: cur.net,
    discountRatePct: cur.gross > 0 ? Math.round((cur.discount / cur.gross) * 100) : 0,
    cashInPaise: cur.cash,
    onlineInPaise: cur.online,
    collectedTotalInPaise: cur.cash + cur.online,
    refundInPaise: cur.refunds,
    outstandingInPaise: outstandingTotal,
    deltaPercent: pct(cur.net, prior.net),
    netCollectedInPaise: cur.netCollected,
    collectedDeltaPercent: pct(cur.netCollected, prior.netCollected),
  };

  // ----- daily series: window + the same day one window earlier ----------
  // Capped at MAX_TREND_DAYS so long windows (YTD) stay readable.
  const trendKeys: string[] = [];
  for (let i = 0; i < trendDays; i += 1) {
    trendKeys.push(toIstDateKey(new Date(trendStart.getTime() + i * DAY_MS)));
  }
  const priorKeyOf = (key: string) => toIstDateKey(new Date(istDateKeyToStart(key).getTime() - winSpanMs));
  const byDay = (rows: DayFact[]) => {
    const m = new Map<string, DayFact[]>();
    for (const f of rows) m.set(f.date, [...(m.get(f.date) ?? []), f]);
    return m;
  };
  const point = (rows: DayFact[] | undefined): DayPoint => {
    const t = totalsOf(rows ?? []);
    return { collected: t.netCollected, gross: t.gross, net: t.net, visits: t.visits, discount: t.discount, bills: t.bills };
  };
  const allByDay = byDay(facts.days);
  const trend: TrendDay[] = trendKeys.map((date) => ({
    date,
    ...point(allByDay.get(date)),
    prior: point(allByDay.get(priorKeyOf(date))),
  }));

  // ----- payout liability -------------------------------------------------
  const liability: PayoutLiability = {
    totalInPaise: 0,
    byType: { referralInPaise: 0, clinicInPaise: 0, partnerInPaise: 0 },
  };
  for (const row of payoutLiabilityRows) {
    const amt = row._sum.derivedAmountInPaise ?? 0;
    liability.totalInPaise += amt;
    if (row.doctorType === 'REFERRAL') liability.byType.referralInPaise = amt;
    else if (row.doctorType === 'CLINIC') liability.byType.clinicInPaise = amt;
    else if (row.doctorType === 'PARTNER') liability.byType.partnerInPaise = amt;
  }
  // ----- ops pulse -------------------------------------------------------
  const tatDurations = diagFinalizedTodaySamples
    .filter((r) => r.report?.visit?.createdAt && r.finalizedAt)
    .map(
      (r) =>
        (r.finalizedAt!.getTime() - r.report!.visit.createdAt.getTime()) / 60_000,
    )
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);
  const breachCount = tatDurations.filter((d) => d > SLA_TAT_MINUTES).length;

  // wait minutes — clinic visits started today
  const waitDurations = clinicRecentCompleted
    .filter((v) => v.startedAt)
    .map((v) => (v.startedAt!.getTime() - v.createdAt.getTime()) / 60_000)
    .filter((d) => d >= 0);
  const avgWait = waitDurations.length
    ? Math.round(waitDurations.reduce((s, v) => s + v, 0) / waitDurations.length)
    : null;

  const comms: OpsPulseComms = { sent: 0, delivered: 0, read: 0, failed: 0, optInPercent: null };
  for (const row of commsAggToday) {
    const c = (row._count as any) ?? 0;
    if (row.status === 'SENT') comms.sent = c;
    else if (row.status === 'DELIVERED') comms.delivered = c;
    else if (row.status === 'READ') comms.read = c;
    else if (row.status === 'FAILED') comms.failed = c;
  }
  if (optInWindowVisits.length > 0) {
    const optIns = optInWindowVisits.filter((v) => v.patient.whatsappOptIn).length;
    comms.optInPercent = Math.round((optIns / optInWindowVisits.length) * 100);
  }

  const opsPulse: OpsPulse = {
    diagnostics: {
      ordersToday: diagOrdersToday,
      finalizedToday: tatDurations.length,
      inProgress: diagInProgress,
      pendingSample: diagPendingSample,
      tatP50Minutes: percentile(tatDurations, 50),
      tatP95Minutes: percentile(tatDurations, 95),
      tatBreachCount: breachCount,
      tatSampleCount: tatDurations.length,
    },
    clinic: {
      waiting: clinicWaiting,
      inConsultation: clinicInProgress,
      completedToday: clinicCompletedToday,
      revisitsToday: clinicRevisitsToday,
      revisitRatePct:
        clinicCompletedToday > 0
          ? Math.round((clinicRevisitsToday / clinicCompletedToday) * 100)
          : null,
      avgWaitMinutes: avgWait,
      onShiftDoctorName: clinicShiftDoctor?.clinicDoctor?.name ?? null,
    },
    comms,
  };

  // ----- revenue trend (selected window) ---------------------------------
  // Kept for bundles cached before `trend` (deploy skew): same numbers.
  const revenueTrend: TrendPoint[] = trend.map((d) => ({ date: d.date, collectedInPaise: d.collected }));

  // ----- revenue mix (selected window) -----------------------------------
  // An order switched to "Upload instead" was SOLD as reportable — the engine
  // keeps it there. Native external-upload products stay bill-only.
  const curCats = facts.categories.filter((c) => c.date >= winStartKey);
  const reportableRev = curCats.filter((c) => c.reportable).reduce((s, c) => s + c.price, 0);
  const billOnlyRev = curCats.filter((c) => !c.reportable).reduce((s, c) => s + c.price, 0);
  const clinicRev = cur.clinicFees;
  const revenueMix: RevenueMix = {
    reportableInPaise: reportableRev,
    clinicInPaise: clinicRev,
    billOnlyInPaise: billOnlyRev,
    totalInPaise: reportableRev + clinicRev + billOnlyRev,
  };

  // ----- what moved: billed by payout category, window vs prior ----------
  const catAgg = new Map<string, CategoryMove>();
  for (const c of facts.categories) {
    const m = catAgg.get(c.category) ?? { category: c.category, current: 0, prior: 0, tests: 0, priorTests: 0 };
    if (c.date >= winStartKey) { m.current += c.price; m.tests += c.tests; }
    else { m.prior += c.price; m.priorTests += c.tests; }
    catAgg.set(c.category, m);
  }
  const categoryMoves = [...catAgg.values()].sort((a, b) => (b.current - b.prior) - (a.current - a.prior));

  // ----- top referrers: the eight who billed most this window -----------
  const referrers = [...referrerFacts]
    .sort((a, b) => b.billed - a.billed)
    .slice(0, 8);

  // ----- branch table ----------------------------------------------------
  const curByBranch = new Map<string, DayFact[]>();
  const priorByBranch = new Map<string, DayFact[]>();
  for (const f of curFacts) curByBranch.set(f.branchId, [...(curByBranch.get(f.branchId) ?? []), f]);
  for (const f of priorFacts) priorByBranch.set(f.branchId, [...(priorByBranch.get(f.branchId) ?? []), f]);

  // tat per branch
  const branchTatBuckets = new Map<string, number[]>();
  for (const r of branchTatSamples) {
    if (!r.report?.visit?.createdAt || !r.finalizedAt) continue;
    const bid = r.report.branchId;
    const dur = (r.finalizedAt.getTime() - r.report.visit.createdAt.getTime()) / 60_000;
    if (dur < 0) continue;
    const arr = branchTatBuckets.get(bid) ?? [];
    arr.push(dur);
    branchTatBuckets.set(bid, arr);
  }

  // last visit per branch (for dormancy)
  const lastVisitByBranch = new Map<string, Date>();
  const allRecentVisits = await prisma.visit.groupBy({
    by: ['branchId'],
    _max: { createdAt: true },
  });
  for (const row of allRecentVisits) {
    if (row._max.createdAt) lastVisitByBranch.set(row.branchId, row._max.createdAt);
  }

  const visibleBranches = branchId
    ? allBranches.filter((b) => b.id === branchId)
    : allBranches;

  const branchTable: BranchRow[] = visibleBranches
    .map((b) => {
      const c = totalsOf(curByBranch.get(b.id) ?? []);
      const p = totalsOf(priorByBranch.get(b.id) ?? []);
      const daily = byDay(curByBranch.get(b.id) ?? []);
      const tatList = (branchTatBuckets.get(b.id) ?? []).sort((x, y) => x - y);
      const lastVisit = lastVisitByBranch.get(b.id);
      const daysDormant = lastVisit
        ? Math.max(0, Math.floor((now.getTime() - lastVisit.getTime()) / DAY_MS))
        : Math.floor((now.getTime() - b.createdAt.getTime()) / DAY_MS);
      return {
        branchId: b.id,
        branchName: b.name,
        branchCode: b.code,
        netInPaise: c.net,
        visitCount: c.visits,
        avgTicketInPaise: c.visits > 0 ? Math.round(c.net / c.visits) : null,
        tatP50Minutes: percentile(tatList, 50),
        tatSampleCount: tatList.length,
        // Δ follows the headline: net collected against the prior window.
        deltaPercent: pct(c.netCollected, p.netCollected),
        daysDormant: daysDormant >= DORMANT_DAYS ? daysDormant : 0,
        collectedInPaise: c.netCollected,
        grossInPaise: c.gross,
        discountInPaise: c.discount,
        collectedDaily: trendKeys.map((k) => totalsOf(daily.get(k) ?? []).netCollected),
      };
    })
    .sort((a, b) => b.collectedInPaise - a.collectedInPaise);

  const response: DashboardV2Response = {
    generatedAt: now.toISOString(),
    period: { key: period, startIso: win.start.toISOString(), endIso: win.end.toISOString() },
    branchScope: {
      branchId: branchId ?? null,
      branchName: scopedBranch?.name ?? null,
    },
    dataAge: {
      firstVisitAt: firstVisit?.createdAt.toISOString() ?? null,
      daysSinceLaunch,
    },
    actionQueue,
    moneyToday,
    payoutLiability: liability,
    opsPulse,
    revenueTrend,
    trend,
    kpis: {
      current: { ...cur, outstanding: outstandingTotal },
      prior,
    },
    revenueMix,
    categoryMoves,
    sources,
    referrers,
    busyHours,
    branchTable,
  };

  if (redis) {
    redis
      .set(cacheKey(branchId, period, range, domain), JSON.stringify(response), 'EX', CACHE_TTL_SEC)
      .catch((err) => logger.warn({ err, branchId }, 'dashboard-v2: cache write failed'));
  }

  return response;
}

function formatRupeesShort(paise: number): string {
  const rupees = paise / 100;
  if (rupees >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`;
  if (rupees >= 1000) return `₹${(rupees / 1000).toFixed(1)}k`;
  return `₹${Math.round(rupees)}`;
}
