/**
 * Owner dashboard v2 — decision-first aggregations.
 *
 * Backs the redesigned `/` owner page. Returns the entire dashboard payload in
 * a single call:
 *   - actionQueue       chips that fire when a decision is pending
 *   - moneyToday        gross → discount → commission → net waterfall + cash/online
 *   - payoutLiability   open derived payouts split by doctor type
 *   - opsPulse          diagnostics / clinic / comms 3-tile status
 *   - revenueTrend      30-day net revenue series (no expected band yet)
 *   - revenueMix        today's net split: reportable / clinic / bill-only+external
 *   - branchTable       per-branch KPIs for the period
 *   - dataAge           days since first visit, used by the UI to suppress
 *                       comparison deltas during the first 30 days
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
import { logger } from '../lib/logger';
import type { Prisma } from '@prisma/client';

const CACHE_TTL_SEC = 60;
const cacheKey = (branchId: string | null, period: PeriodKey, range: CustomRange | null) =>
  `owner-dashboard-v2:v3:${branchId ?? 'all'}:${period}:${range ? `${range.startKey}_${range.endKey}` : ''}`;

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
  | 'payouts_to_review'
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
}

export interface PayoutLiability {
  totalInPaise: number;
  // Split of the total by stage: toReview matches the payouts_to_review chip
  // (reviewedAt == null && paidAt == null); approvedUnpaid is reviewed but not
  // yet paid (reviewedAt != null && paidAt == null). Sum == totalInPaise.
  toReviewInPaise: number;
  approvedUnpaidInPaise: number;
  byType: {
    referralInPaise: number;
    clinicInPaise: number;
    diagnosticCenterInPaise: number;
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
  netInPaise: number;
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
  deltaPercent: number | null;
  daysDormant: number; // 0 if active in window
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
  revenueMix: RevenueMix;
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

/**
 * Per-order commission accrual. Picks up referral + diagnostic-center sides;
 * either may be percentage-based or a fixed-amount snapshot. Untouched fields
 * coalesce to 0 — TestOrders without a referral simply contribute 0.
 */
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
  clinicDoctor: {
    commissionType: string;
    commissionPercent: number;
    commissionAmountInPaise: number | null;
  };
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

// --- main entry ----------------------------------------------------------

export async function getOwnerDashboardV2(
  branchId: string | null,
  period: PeriodKey = '30d',
  range: CustomRange | null = null,
): Promise<DashboardV2Response> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const hit = await redis.get(cacheKey(branchId, period, range));
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

  // ----- branch resolution & data age ------------------------------------
  const branchScopeWhere: Prisma.VisitWhereInput = branchId ? { branchId } : {};
  const billBranchWhere: Prisma.BillWhereInput = branchId ? { branchId } : {};

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
    payoutsToReviewAgg,
    waFailedCount,
    largeDiscountCount,
    identityChangeNoReasonCount,
    // branch dormancy needs all branches regardless of selected scope
    allBranches,

    // money today
    todayBills,
    todayTestOrders,
    todayClinicVisits,
    todayPaymentsByType,
    todayOutstandingAgg,

    // 28-day baseline window of net revenue (used for trend + dow delta)
    baselineBills,
    baselineTestOrders,
    baselineClinicVisits,

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

    // revenue mix (today)
    todayClinicForMix,

    // branch table — fetched after main bills query
    branchVisitCounts,
    branchTatSamples,

    // branch prior-window net (days [60..30) ago) for period-over-period delta
    priorBranchBills,
    priorBranchTestOrders,
    priorBranchClinicVisits,
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
      select: { totalAmountInPaise: true, paidAmountInPaise: true },
    }),
    prisma.doctorPayoutLedger.aggregate({
      where: {
        reviewedAt: null,
        paidAt: null,
        ...(branchId ? { branchId } : {}),
      },
      _sum: { derivedAmountInPaise: true },
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

    // money summary (selected window)
    prisma.bill.aggregate({
      where: {
        billedAt: { gte: win.start, lt: win.end },
        ...billBranchWhere,
      },
      _sum: {
        totalAmountInPaise: true,
        discountAmountInPaise: true,
        paidAmountInPaise: true,
        reversedChargeInPaise: true,
      },
      _count: true,
    }),
    prisma.testOrder.findMany({
      where: {
        createdAt: { gte: win.start, lt: win.end },
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
        workflowMode: true,
        uploadInsteadAt: true,
      },
    }),
    prisma.clinicVisit.findMany({
      where: {
        createdAt: { gte: win.start, lt: win.end },
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
    prisma.paymentTransaction.groupBy({
      by: ['paymentType', 'transactionType'],
      where: {
        transactionDate: { gte: win.start, lt: win.end },
        ...(branchId ? { bill: { branchId } } : {}),
      },
      _sum: { amountInPaise: true },
    }),
    prisma.bill.aggregate({
      where: {
        paymentStatus: { not: 'PAID' },
        ...billBranchWhere,
      },
      _sum: { totalAmountInPaise: true, paidAmountInPaise: true, discountAmountInPaise: true, reversedChargeInPaise: true },
    }),

    // window dataset (feeds revenue trend + branch table, scoped to the slicer)
    prisma.bill.findMany({
      where: { billedAt: { gte: win.start, lt: win.end }, ...billBranchWhere },
      select: {
        billedAt: true,
        totalAmountInPaise: true,
        discountAmountInPaise: true,
        reversedChargeInPaise: true,
        branchId: true,
      },
    }),
    prisma.testOrder.findMany({
      where: {
        createdAt: { gte: win.start, lt: win.end },
        ...(branchId ? { branchId } : {}),
      },
      select: {
        createdAt: true,
        branchId: true,
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
        createdAt: { gte: win.start, lt: win.end },
        ...(branchId ? { visit: { branchId } } : {}),
      },
      select: {
        createdAt: true,
        consultationFeeInPaise: true,
        visit: { select: { branchId: true } },
        clinicDoctor: {
          select: {
            commissionType: true,
            commissionPercent: true,
            commissionAmountInPaise: true,
          },
        },
      },
    }),

    // payout liability
    prisma.doctorPayoutLedger.groupBy({
      by: ['doctorType'],
      where: {
        paidAt: null,
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

    // revenue mix — clinic visits in the window (for clinic slice)
    prisma.clinicVisit.aggregate({
      where: {
        createdAt: { gte: win.start, lt: win.end },
        ...(branchId ? { visit: { branchId } } : {}),
      },
      _sum: { consultationFeeInPaise: true },
    }),

    // branch table — visit counts + tat by branch (selected window)
    prisma.visit.groupBy({
      by: ['branchId'],
      where: { createdAt: { gte: win.start, lt: win.end } },
      _count: true,
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

    // prior-window branch net inputs — mirror the window branch aggregation but
    // scoped to the equal-length window before it, for the Δ vs prior column.
    prisma.bill.findMany({
      where: {
        billedAt: { gte: priorWin.start, lt: priorWin.end },
        ...billBranchWhere,
      },
      select: {
        totalAmountInPaise: true,
        discountAmountInPaise: true,
        reversedChargeInPaise: true,
        branchId: true,
      },
    }),
    prisma.testOrder.findMany({
      where: {
        createdAt: { gte: priorWin.start, lt: priorWin.end },
        ...(branchId ? { branchId } : {}),
      },
      select: {
        branchId: true,
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
        createdAt: { gte: priorWin.start, lt: priorWin.end },
        ...(branchId ? { visit: { branchId } } : {}),
      },
      select: {
        consultationFeeInPaise: true,
        visit: { select: { branchId: true } },
        clinicDoctor: {
          select: {
            commissionType: true,
            commissionPercent: true,
            commissionAmountInPaise: true,
          },
        },
      },
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
    (sum, b) => sum + Math.max(0, b.totalAmountInPaise - b.paidAmountInPaise),
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

  const payoutsToReview = payoutsToReviewAgg._sum.derivedAmountInPaise ?? 0;
  if (payoutsToReview > 0) {
    actionQueue.push({
      type: 'payouts_to_review',
      severity: 'medium',
      label: `${formatRupeesShort(payoutsToReview)} payouts to review`,
      amountInPaise: payoutsToReview,
      drillTo: '/owner/payouts?status=derived',
    });
  }

  if (waFailedCount > 0) {
    actionQueue.push({
      type: 'whatsapp_failed',
      severity: 'high',
      label: `${waFailedCount} WhatsApp failure${waFailedCount === 1 ? '' : 's'}`,
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
  const grossToday = todayBills._sum.totalAmountInPaise ?? 0;
  const discountToday = todayBills._sum.discountAmountInPaise ?? 0;
  const reversedToday = todayBills._sum.reversedChargeInPaise ?? 0;
  const commissionToday =
    accruedCommissionInPaise(todayTestOrders) + clinicCommissionInPaise(todayClinicVisits);
  const netToday = grossToday - discountToday - reversedToday - commissionToday;

  // Split payments by direction: PAYMENT rows are collections (cash/online),
  // REFUND rows are money returned. Bucketing by transactionType stops refunds
  // from inflating collected cash/online.
  let cashToday = 0;
  let onlineToday = 0;
  let refundToday = 0;
  for (const row of todayPaymentsByType) {
    const amt = row._sum.amountInPaise ?? 0;
    if (row.transactionType === 'REFUND') refundToday += amt;
    else if (row.paymentType === 'CASH') cashToday += amt;
    else if (row.paymentType === 'ONLINE') onlineToday += amt;
  }
  // Open receivables stay all-time regardless of the slicer (a live figure).
  const outstandingTotal = Math.max(
    0,
    (todayOutstandingAgg._sum.totalAmountInPaise ?? 0) -
      (todayOutstandingAgg._sum.paidAmountInPaise ?? 0) -
      (todayOutstandingAgg._sum.discountAmountInPaise ?? 0) -
      (todayOutstandingAgg._sum.reversedChargeInPaise ?? 0),
  );

  // Net vs the prior equal-length window (period-over-period). priorBranch*
  // datasets are already scoped to priorWin and the selected branch.
  const priorGrossNet = priorBranchBills.reduce(
    (s, b) => s + b.totalAmountInPaise - b.discountAmountInPaise - b.reversedChargeInPaise,
    0,
  );
  const priorCommission =
    accruedCommissionInPaise(priorBranchTestOrders) + clinicCommissionInPaise(priorBranchClinicVisits);
  const priorNet = priorGrossNet - priorCommission;
  const deltaPercent: number | null =
    priorNet > 0 ? Math.round(((netToday - priorNet) / priorNet) * 100) : null;

  // ----- bucket the window by IST date for the revenue trend -------------
  // Cap the number of daily points so long windows (YTD) stay readable; the
  // trend then shows the most recent MAX_TREND_DAYS of the selected window.
  const trendDays = Math.min(winDays, MAX_TREND_DAYS);
  const trendStart = new Date(win.end.getTime() - trendDays * DAY_MS);
  const dailyNetMap = new Map<string, number>();
  const trendKeys: string[] = [];
  for (let i = 0; i < trendDays; i += 1) {
    const k = toIstDateKey(new Date(trendStart.getTime() + i * DAY_MS));
    trendKeys.push(k);
    dailyNetMap.set(k, 0);
  }
  for (const b of baselineBills) {
    const key = toIstDateKey(b.billedAt);
    if (dailyNetMap.has(key)) {
      const net = b.totalAmountInPaise - b.discountAmountInPaise - b.reversedChargeInPaise;
      dailyNetMap.set(key, (dailyNetMap.get(key) ?? 0) + net);
    }
  }
  for (const o of baselineTestOrders) {
    const key = toIstDateKey(o.createdAt);
    if (!dailyNetMap.has(key)) continue;
    const orderCommission = accruedCommissionInPaise([o]);
    dailyNetMap.set(key, (dailyNetMap.get(key) ?? 0) - orderCommission);
  }
  for (const v of baselineClinicVisits) {
    const key = toIstDateKey(v.createdAt);
    if (!dailyNetMap.has(key)) continue;
    const cc = clinicCommissionInPaise([{ ...v }]);
    dailyNetMap.set(key, (dailyNetMap.get(key) ?? 0) - cc);
  }

  const moneyToday: MoneyToday = {
    grossInPaise: grossToday,
    discountInPaise: discountToday,
    reversedInPaise: reversedToday,
    commissionInPaise: commissionToday,
    netInPaise: netToday,
    discountRatePct: grossToday > 0 ? Math.round((discountToday / grossToday) * 100) : 0,
    cashInPaise: cashToday,
    onlineInPaise: onlineToday,
    collectedTotalInPaise: cashToday + onlineToday,
    refundInPaise: refundToday,
    outstandingInPaise: outstandingTotal,
    deltaPercent,
  };

  // ----- payout liability -------------------------------------------------
  const liability: PayoutLiability = {
    totalInPaise: 0,
    toReviewInPaise: 0,
    approvedUnpaidInPaise: 0,
    byType: { referralInPaise: 0, clinicInPaise: 0, diagnosticCenterInPaise: 0 },
  };
  for (const row of payoutLiabilityRows) {
    const amt = row._sum.derivedAmountInPaise ?? 0;
    liability.totalInPaise += amt;
    if (row.doctorType === 'REFERRAL') liability.byType.referralInPaise = amt;
    else if (row.doctorType === 'CLINIC') liability.byType.clinicInPaise = amt;
    else if (row.doctorType === 'DIAGNOSTIC_CENTER')
      liability.byType.diagnosticCenterInPaise = amt;
  }
  // Stage split: toReview MUST equal the payouts_to_review chip definition
  // (reviewedAt == null && paidAt == null). approvedUnpaid is the remainder of
  // the open (paidAt == null) liability — i.e. reviewed but not yet paid.
  liability.toReviewInPaise = payoutsToReviewAgg._sum.derivedAmountInPaise ?? 0;
  liability.approvedUnpaidInPaise = Math.max(
    0,
    liability.totalInPaise - liability.toReviewInPaise,
  );

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
  // trendKeys + dailyNetMap were built above, spanning the window (capped at
  // MAX_TREND_DAYS days) so every point reflects real bills/orders.
  const revenueTrend: TrendPoint[] = trendKeys.map((date) => ({
    date,
    netInPaise: dailyNetMap.get(date) ?? 0,
  }));

  // ----- revenue mix (selected window) -----------------------------------
  // An order switched to "Upload instead" (uploadInsteadAt set) reads
  // EXTERNAL_UPLOAD now, but it was SOLD as a reportable narrative and still
  // produces a report — keep its revenue in the reportable bucket. Native
  // external-upload products (no uploadInsteadAt) stay bill-only as before.
  const reportableRev = todayTestOrders
    .filter((o) => o.workflowMode === 'REPORTABLE' || o.uploadInsteadAt != null)
    .reduce((s, o) => s + o.priceInPaise, 0);
  const billOnlyRev = todayTestOrders
    .filter((o) => o.workflowMode !== 'REPORTABLE' && o.uploadInsteadAt == null)
    .reduce((s, o) => s + o.priceInPaise, 0);
  const clinicRev = todayClinicForMix._sum.consultationFeeInPaise ?? 0;
  const revenueMix: RevenueMix = {
    reportableInPaise: reportableRev,
    clinicInPaise: clinicRev,
    billOnlyInPaise: billOnlyRev,
    totalInPaise: reportableRev + clinicRev + billOnlyRev,
  };

  // ----- branch table ----------------------------------------------------
  const visitCountByBranch = new Map<string, number>();
  for (const row of branchVisitCounts) {
    visitCountByBranch.set(row.branchId, (row._count as any) ?? 0);
  }

  // bucket gross/discount per branch from the window dataset
  const branchAgg = new Map<string, { gross: number; discount: number; reversed: number }>();
  for (const b of baselineBills) {
    const cur = branchAgg.get(b.branchId) ?? { gross: 0, discount: 0, reversed: 0 };
    cur.gross += b.totalAmountInPaise;
    cur.discount += b.discountAmountInPaise;
    cur.reversed += b.reversedChargeInPaise;
    branchAgg.set(b.branchId, cur);
  }
  const branchCommission = new Map<string, number>();
  for (const o of baselineTestOrders) {
    const cur = branchCommission.get(o.branchId) ?? 0;
    branchCommission.set(o.branchId, cur + accruedCommissionInPaise([o]));
  }
  for (const v of baselineClinicVisits) {
    const bid = v.visit?.branchId;
    if (!bid) continue;
    const cur = branchCommission.get(bid) ?? 0;
    branchCommission.set(bid, cur + clinicCommissionInPaise([v]));
  }

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

  // prior-window net per branch (same shape as current: gross - discount - commission)
  const priorBranchAgg = new Map<string, { gross: number; discount: number; reversed: number }>();
  for (const b of priorBranchBills) {
    const cur = priorBranchAgg.get(b.branchId) ?? { gross: 0, discount: 0, reversed: 0 };
    cur.gross += b.totalAmountInPaise;
    cur.discount += b.discountAmountInPaise;
    cur.reversed += b.reversedChargeInPaise;
    priorBranchAgg.set(b.branchId, cur);
  }
  const priorBranchCommission = new Map<string, number>();
  for (const o of priorBranchTestOrders) {
    const cur = priorBranchCommission.get(o.branchId) ?? 0;
    priorBranchCommission.set(o.branchId, cur + accruedCommissionInPaise([o]));
  }
  for (const v of priorBranchClinicVisits) {
    const bid = v.visit?.branchId;
    if (!bid) continue;
    const cur = priorBranchCommission.get(bid) ?? 0;
    priorBranchCommission.set(bid, cur + clinicCommissionInPaise([v]));
  }

  const visibleBranches = branchId
    ? allBranches.filter((b) => b.id === branchId)
    : allBranches;

  const branchTable: BranchRow[] = visibleBranches
    .map((b) => {
      const agg = branchAgg.get(b.id) ?? { gross: 0, discount: 0, reversed: 0 };
      const commission = branchCommission.get(b.id) ?? 0;
      const net = agg.gross - agg.discount - agg.reversed - commission;
      const priorAgg = priorBranchAgg.get(b.id) ?? { gross: 0, discount: 0, reversed: 0 };
      const priorNet =
        priorAgg.gross - priorAgg.discount - priorAgg.reversed - (priorBranchCommission.get(b.id) ?? 0);
      const visits = visitCountByBranch.get(b.id) ?? 0;
      const tatList = (branchTatBuckets.get(b.id) ?? []).sort((a, c) => a - c);
      const lastVisit = lastVisitByBranch.get(b.id);
      const daysDormant = lastVisit
        ? Math.max(0, Math.floor((now.getTime() - lastVisit.getTime()) / DAY_MS))
        : Math.floor((now.getTime() - b.createdAt.getTime()) / DAY_MS);
      return {
        branchId: b.id,
        branchName: b.name,
        branchCode: b.code,
        netInPaise: net,
        visitCount: visits,
        avgTicketInPaise: visits > 0 ? Math.round(net / visits) : null,
        tatP50Minutes: percentile(tatList, 50),
        deltaPercent:
          priorNet > 0 ? Math.round(((net - priorNet) / priorNet) * 100) : null,
        daysDormant: daysDormant >= DORMANT_DAYS ? daysDormant : 0,
      };
    })
    .sort((a, b) => b.netInPaise - a.netInPaise);

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
    revenueMix,
    branchTable,
  };

  if (redis) {
    redis
      .set(cacheKey(branchId, period, range), JSON.stringify(response), 'EX', CACHE_TTL_SEC)
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
