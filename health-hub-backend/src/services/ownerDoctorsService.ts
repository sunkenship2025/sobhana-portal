/**
 * Owner Doctors & payouts page aggregations.
 *
 * Backs GET /api/owner/doctors. Answers: who is profitable, what do I owe,
 * who's reviewing & approving payouts, where is referral money flowing.
 *
 * Sections:
 *   - kpis            Net kept / net referral / net clinic / commission / rate / outsourced
 *   - leaderboard     One row per doctor with visits, gross, commission, net, owed
 *   - payoutAging     Aging buckets on open DoctorPayoutLedger rows
 *   - externalFlow    REFERRED_TO (outgoing) vs REFERRED_FROM (incoming)
 *   - recentPayouts   Last 20 ledger rows by latest state change
 */

import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';
import type { Prisma } from '@prisma/client';

const CACHE_TTL_SEC = 60;
const cacheKey = (period: PeriodKey, branchId: string | null, range: CustomRange | null) =>
  `owner-doctors:v3:${period}:${branchId ?? 'all'}:${range ? `${range.startKey}_${range.endKey}` : ''}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const HIGH_RATE_PCT = 25;

export type PeriodKey = 'today' | 'yesterday' | '7d' | '30d' | 'mtd' | 'ytd' | 'custom';

/** IST calendar-day range for a custom filter, inclusive of both endpoints. */
export interface CustomRange {
  startKey: string; // YYYY-MM-DD (IST)
  endKey: string; // YYYY-MM-DD (IST)
}

export interface DoctorsKpi {
  netReferralRevenueInPaise: number;
  netClinicRevenueInPaise: number;
  // Total commission accrued to all doctors (referral + clinic) in the window.
  commissionTotalInPaise: number;
  // Blended commission rate: commission as a % of doctor-driven gross. The
  // leakage signal — how much of doctor revenue goes back out as commission.
  commissionRatePct: number | null;
  outsourcedSpendInPaise: number;
}

export interface LeaderboardRow {
  doctorId: string;
  doctorNumber: string;
  doctorType: 'REFERRAL' | 'CLINIC';
  doctorName: string;
  isActive: boolean;
  visits: number;
  grossInPaise: number;
  commissionInPaise: number;
  ratePercent: number; // blended commission %
  netInPaise: number;
  flagHighRate: boolean;
  // Period-over-period visit delta vs the immediately preceding equal-length
  // window; null when there were no prior-window visits to compare against.
  visitsDeltaPercent: number | null;
}

export interface PayoutAgingBucket {
  key: '0_7' | '8_15' | '16_30' | '30_plus';
  label: string;
  amountInPaise: number;
  rowCount: number;
}

export interface ExternalFlowSide {
  totalInPaise: number;
  testCount: number;
  centerCount: number;
  topCenterName: string | null;
}

export interface RecentPayoutRow {
  id: string;
  doctorName: string;
  doctorType: 'REFERRAL' | 'CLINIC' | 'DIAGNOSTIC_CENTER' | 'LAB';
  periodStart: string;
  periodEnd: string;
  amountInPaise: number;
  status: 'paid' | 'reviewed' | 'derived';
  reference: string | null;
}

export interface DoctorsResponse {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  kpis: DoctorsKpi;
  leaderboard: LeaderboardRow[];
  payoutAging: PayoutAgingBucket[];
  externalFlow: { outgoing: ExternalFlowSide; incoming: ExternalFlowSide };
  recentPayouts: RecentPayoutRow[];
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
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCMonth(0, 1);
  ist.setUTCHours(0, 0, 0, 0);
  return { start: new Date(ist.getTime() - IST_OFFSET_MS), end: tomorrowStart };
}

function commissionForOrder(o: {
  priceInPaise: number;
  referralCommissionType: string | null;
  referralCommissionPercentage: number | null;
  referralCommissionAmountInPaise: number | null;
}): number {
  if (o.referralCommissionType === 'PERCENTAGE') {
    return Math.round((o.priceInPaise * (o.referralCommissionPercentage ?? 0)) / 100);
  }
  if (o.referralCommissionType === 'FIXED_AMOUNT') {
    return o.referralCommissionAmountInPaise ?? 0;
  }
  return 0;
}

function commissionForCenter(o: {
  priceInPaise: number;
  diagnosticCenterCommissionType: string | null;
  diagnosticCenterCommissionPercentage: number | null;
  diagnosticCenterCommissionAmountInPaise: number | null;
}): number {
  if (o.diagnosticCenterCommissionType === 'PERCENTAGE') {
    return Math.round((o.priceInPaise * (o.diagnosticCenterCommissionPercentage ?? 0)) / 100);
  }
  if (o.diagnosticCenterCommissionType === 'FIXED_AMOUNT') {
    return o.diagnosticCenterCommissionAmountInPaise ?? 0;
  }
  return 0;
}

function clinicCommissionInPaise(visit: {
  consultationFeeInPaise: number;
  clinicDoctor: { commissionType: string; commissionPercent: number; commissionAmountInPaise: number | null };
}): number {
  if (visit.clinicDoctor.commissionType === 'PERCENTAGE') {
    return Math.round((visit.consultationFeeInPaise * (visit.clinicDoctor.commissionPercent ?? 0)) / 100);
  }
  if (visit.clinicDoctor.commissionType === 'FIXED_AMOUNT') {
    return visit.clinicDoctor.commissionAmountInPaise ?? 0;
  }
  return 0;
}

// --- main entry ---------------------------------------------------------

export async function getOwnerDoctors(
  period: PeriodKey,
  branchId: string | null,
  range: CustomRange | null = null,
): Promise<DoctorsResponse> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const hit = await redis.get(cacheKey(period, branchId, range));
      if (hit) return JSON.parse(hit) as DoctorsResponse;
    } catch (err) {
      logger.warn({ err, period, branchId }, 'owner-doctors: cache read failed');
    }
  }

  const now = new Date();
  const win = period === 'custom' && range ? customWindow(range) : periodWindow(period, now);
  // Prior equal-length window: immediately preceding the selected one.
  const priorWin = {
    start: new Date(win.start.getTime() - (win.end.getTime() - win.start.getTime())),
    end: win.start,
  };

  const [
    scopedBranch,
    referralLinks, // visits per referral doctor (window-scoped)
    priorReferralLinks, // referral-doctor visits in the prior equal-length window
    clinicVisitsInWindow,
    payoutsOpen,
    payoutsRecent,
    externalLinks,
    referralDoctors,
    clinicDoctors,
    diagnosticCenters,
  ] = await Promise.all([
    branchId
      ? prisma.branch.findUnique({
          where: { id: branchId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),

    // ReferralDoctor_Visit + TestOrders for the visit, scoped to window+branch
    prisma.referralDoctor_Visit.findMany({
      where: {
        deletedAt: null,
        createdAt: { gte: win.start, lt: win.end },
        ...(branchId ? { branchId } : {}),
      },
      select: {
        referralDoctorId: true,
        visit: {
          select: {
            id: true,
            // Cancelled orders were voided off the bill — they must not
            // inflate this doctor's referral gross/commission KPIs.
            testOrders: {
              where: { cancelledAt: null },
              select: {
                priceInPaise: true,
                referralCommissionType: true,
                referralCommissionPercentage: true,
                referralCommissionAmountInPaise: true,
              },
            },
          },
        },
      },
    }),

    // Same shape as above, shifted back one period length — for the visit delta.
    prisma.referralDoctor_Visit.findMany({
      where: {
        deletedAt: null,
        createdAt: { gte: priorWin.start, lt: priorWin.end },
        ...(branchId ? { branchId } : {}),
      },
      select: { referralDoctorId: true },
    }),

    prisma.clinicVisit.findMany({
      where: {
        createdAt: { gte: win.start, lt: win.end },
        ...(branchId ? { visit: { branchId } } : {}),
      },
      select: {
        clinicDoctorId: true,
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

    // all currently-open payouts — used for the payout-aging card
    prisma.doctorPayoutLedger.findMany({
      where: { deletedAt: null, paidAt: null, ...(branchId ? { branchId } : {}) },
      select: {
        derivedAmountInPaise: true,
        derivedAt: true,
      },
    }),

    // recent activity — last 20 by latest state change
    prisma.doctorPayoutLedger.findMany({
      where: { deletedAt: null, ...(branchId ? { branchId } : {}) },
      orderBy: [{ paidAt: 'desc' }, { reviewedAt: 'desc' }, { derivedAt: 'desc' }],
      take: 20,
      select: {
        id: true,
        doctorType: true,
        derivedAmountInPaise: true,
        periodStartDate: true,
        periodEndDate: true,
        derivedAt: true,
        reviewedAt: true,
        paidAt: true,
        paymentReferenceId: true,
        referralDoctor: { select: { name: true } },
        clinicDoctor: { select: { name: true } },
        diagnosticCenter: { select: { name: true } },
      },
    }),

    // diagnostic center referrals + their test orders for in/out flow
    prisma.diagnosticCenter_Visit.findMany({
      where: {
        createdAt: { gte: win.start, lt: win.end },
        ...(branchId ? { branchId } : {}),
      },
      select: {
        diagnosticCenterId: true,
        referralType: true,
        diagnosticCenter: { select: { name: true } },
        visit: {
          select: {
            // Same guard — outgoing/incoming totals must exclude voided orders.
            testOrders: { where: { cancelledAt: null }, select: { priceInPaise: true } },
          },
        },
      },
    }),

    prisma.referralDoctor.findMany({
      select: {
        id: true,
        name: true,
        doctorNumber: true,
        isActive: true,
        commissionType: true,
        commissionPercent: true,
        commissionAmountInPaise: true,
      },
    }),
    prisma.clinicDoctor.findMany({
      select: {
        id: true,
        name: true,
        doctorNumber: true,
        isActive: true,
        commissionType: true,
        commissionPercent: true,
        commissionAmountInPaise: true,
      },
    }),
    prisma.diagnosticReferralCenter.findMany({
      select: { id: true, name: true },
    }),
  ]);

  // --- KPIs ----------------------------------------------------------------
  // Net referral revenue: gross from referral-doctor visits − commission accrued
  let referralGross = 0;
  let referralCommission = 0;
  const referralAggMap = new Map<
    string,
    { visits: number; gross: number; commission: number }
  >();
  for (const link of referralLinks) {
    let visitGross = 0;
    let visitCommission = 0;
    for (const o of link.visit.testOrders) {
      visitGross += o.priceInPaise;
      visitCommission += commissionForOrder(o);
    }
    const cur = referralAggMap.get(link.referralDoctorId) ?? { visits: 0, gross: 0, commission: 0 };
    cur.visits += 1;
    cur.gross += visitGross;
    cur.commission += visitCommission;
    referralAggMap.set(link.referralDoctorId, cur);
    referralGross += visitGross;
    referralCommission += visitCommission;
  }

  // Prior-window visit counts per referral doctor, for the period-over-period delta.
  const priorReferralVisits = new Map<string, number>();
  for (const link of priorReferralLinks) {
    priorReferralVisits.set(
      link.referralDoctorId,
      (priorReferralVisits.get(link.referralDoctorId) ?? 0) + 1,
    );
  }

  let clinicGross = 0;
  let clinicCommission = 0;
  const clinicAggMap = new Map<
    string,
    { visits: number; gross: number; commission: number }
  >();
  for (const cv of clinicVisitsInWindow) {
    const cc = clinicCommissionInPaise(cv);
    const cur = clinicAggMap.get(cv.clinicDoctorId) ?? { visits: 0, gross: 0, commission: 0 };
    cur.visits += 1;
    cur.gross += cv.consultationFeeInPaise;
    cur.commission += cc;
    clinicAggMap.set(cv.clinicDoctorId, cur);
    clinicGross += cv.consultationFeeInPaise;
    clinicCommission += cc;
  }

  // Total commission accrued in the window and the blended rate against the
  // doctor-driven gross that produced it.
  const commissionTotal = referralCommission + clinicCommission;
  const grossTotal = referralGross + clinicGross;
  const commissionRatePct =
    grossTotal > 0 ? Math.round((commissionTotal / grossTotal) * 100) : null;

  let outgoingTotal = 0;
  const outgoingCenters = new Set<string>();
  let outgoingTestCount = 0;
  let incomingTotal = 0;
  const incomingCenters = new Set<string>();
  let incomingTestCount = 0;
  const outgoingByCenter = new Map<string, { name: string; total: number }>();
  const incomingByCenter = new Map<string, { name: string; total: number }>();
  for (const link of externalLinks) {
    const total = link.visit.testOrders.reduce((s, o) => s + o.priceInPaise, 0);
    const tests = link.visit.testOrders.length;
    if (link.referralType === 'REFERRED_TO') {
      outgoingTotal += total;
      outgoingTestCount += tests;
      outgoingCenters.add(link.diagnosticCenterId);
      const cur = outgoingByCenter.get(link.diagnosticCenterId) ?? {
        name: link.diagnosticCenter.name,
        total: 0,
      };
      cur.total += total;
      outgoingByCenter.set(link.diagnosticCenterId, cur);
    } else if (link.referralType === 'REFERRED_FROM') {
      incomingTotal += total;
      incomingTestCount += tests;
      incomingCenters.add(link.diagnosticCenterId);
      const cur = incomingByCenter.get(link.diagnosticCenterId) ?? {
        name: link.diagnosticCenter.name,
        total: 0,
      };
      cur.total += total;
      incomingByCenter.set(link.diagnosticCenterId, cur);
    }
  }

  const kpis: DoctorsKpi = {
    netReferralRevenueInPaise: referralGross - referralCommission,
    netClinicRevenueInPaise: clinicGross - clinicCommission,
    commissionTotalInPaise: commissionTotal,
    commissionRatePct,
    outsourcedSpendInPaise: outgoingTotal,
  };

  // --- leaderboard ---------------------------------------------------------
  const refMap = new Map(referralDoctors.map((d) => [d.id, d]));
  const cliMap = new Map(clinicDoctors.map((d) => [d.id, d]));

  const leaderboard: LeaderboardRow[] = [];
  for (const [doctorId, agg] of referralAggMap) {
    const d = refMap.get(doctorId);
    if (!d) continue;
    const net = agg.gross - agg.commission;
    const rate = agg.gross > 0 ? Math.round((agg.commission / agg.gross) * 100) : 0;
    const priorVisits = priorReferralVisits.get(doctorId) ?? 0;
    leaderboard.push({
      doctorId,
      doctorNumber: d.doctorNumber,
      doctorType: 'REFERRAL',
      doctorName: d.name,
      isActive: d.isActive,
      visits: agg.visits,
      grossInPaise: agg.gross,
      commissionInPaise: agg.commission,
      ratePercent: rate,
      netInPaise: net,
      flagHighRate: rate > HIGH_RATE_PCT,
      visitsDeltaPercent:
        priorVisits > 0 ? Math.round(((agg.visits - priorVisits) / priorVisits) * 100) : null,
    });
  }
  for (const [doctorId, agg] of clinicAggMap) {
    const d = cliMap.get(doctorId);
    if (!d) continue;
    const net = agg.gross - agg.commission;
    const rate = agg.gross > 0 ? Math.round((agg.commission / agg.gross) * 100) : 0;
    leaderboard.push({
      doctorId,
      doctorNumber: d.doctorNumber,
      doctorType: 'CLINIC',
      doctorName: d.name,
      isActive: d.isActive,
      visits: agg.visits,
      grossInPaise: agg.gross,
      commissionInPaise: agg.commission,
      ratePercent: rate,
      netInPaise: net,
      flagHighRate: rate > HIGH_RATE_PCT,
      // Clinic doctors have no referral-visit prior-window data to compare.
      visitsDeltaPercent: null,
    });
  }
  leaderboard.sort((a, b) => b.netInPaise - a.netInPaise);

  // --- payout aging --------------------------------------------------------
  const c7 = new Date(now.getTime() - 7 * DAY_MS);
  const c15 = new Date(now.getTime() - 15 * DAY_MS);
  const c30 = new Date(now.getTime() - 30 * DAY_MS);
  const aging: PayoutAgingBucket[] = [
    { key: '0_7', label: '0–7 days', amountInPaise: 0, rowCount: 0 },
    { key: '8_15', label: '8–15 days', amountInPaise: 0, rowCount: 0 },
    { key: '16_30', label: '16–30 days', amountInPaise: 0, rowCount: 0 },
    { key: '30_plus', label: '30+ days', amountInPaise: 0, rowCount: 0 },
  ];
  for (const p of payoutsOpen) {
    if (!p.derivedAt) continue;
    let bucket: PayoutAgingBucket;
    if (p.derivedAt >= c7) bucket = aging[0];
    else if (p.derivedAt >= c15) bucket = aging[1];
    else if (p.derivedAt >= c30) bucket = aging[2];
    else bucket = aging[3];
    bucket.amountInPaise += p.derivedAmountInPaise;
    bucket.rowCount += 1;
  }

  // --- external flow -------------------------------------------------------
  const topOutgoing = Array.from(outgoingByCenter.values()).sort(
    (a, b) => b.total - a.total,
  )[0];
  const topIncoming = Array.from(incomingByCenter.values()).sort(
    (a, b) => b.total - a.total,
  )[0];
  const externalFlow = {
    outgoing: {
      totalInPaise: outgoingTotal,
      testCount: outgoingTestCount,
      centerCount: outgoingCenters.size,
      topCenterName: topOutgoing?.name ?? null,
    },
    incoming: {
      totalInPaise: incomingTotal,
      testCount: incomingTestCount,
      centerCount: incomingCenters.size,
      topCenterName: topIncoming?.name ?? null,
    },
  };

  // --- recent payouts ------------------------------------------------------
  const recentPayouts: RecentPayoutRow[] = payoutsRecent.map((r) => {
    const status: RecentPayoutRow['status'] = r.paidAt
      ? 'paid'
      : r.reviewedAt
        ? 'reviewed'
        : 'derived';
    const doctorName =
      r.referralDoctor?.name ??
      r.clinicDoctor?.name ??
      r.diagnosticCenter?.name ??
      '—';
    let reference: string | null = r.paymentReferenceId ?? null;
    if (!reference) {
      reference = status === 'reviewed' ? 'awaiting payment' : status === 'derived' ? 'needs review' : null;
    }
    return {
      id: r.id,
      doctorName,
      doctorType: r.doctorType,
      periodStart: r.periodStartDate.toISOString(),
      periodEnd: r.periodEndDate.toISOString(),
      amountInPaise: r.derivedAmountInPaise,
      status,
      reference,
    };
  });

  const response: DoctorsResponse = {
    generatedAt: now.toISOString(),
    period: { key: period, startIso: win.start.toISOString(), endIso: win.end.toISOString() },
    branchScope: { branchId: branchId ?? null, branchName: scopedBranch?.name ?? null },
    kpis,
    leaderboard,
    payoutAging: aging,
    externalFlow,
    recentPayouts,
  };

  if (redis) {
    redis
      .set(cacheKey(period, branchId, range), JSON.stringify(response), 'EX', CACHE_TTL_SEC)
      .catch((err) => logger.warn({ err }, 'owner-doctors: cache write failed'));
  }

  return response;
}
