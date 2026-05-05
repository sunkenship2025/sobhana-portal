/**
 * Owner business metrics.
 *
 * Aggregates KPIs the clinic owner actually needs to see at a glance:
 *   - Volume: visits, by domain, by branch
 *   - Revenue: gross / net / paid / due, average bill, discount %
 *   - Mix: reportable / bill-only / external-upload split
 *   - Operations: WhatsApp delivery rate, time-to-finalize p50/p95,
 *     reports-finalized count
 *   - Top entities: top tests, top referring doctors by volume + payout
 *
 * Cached in Redis for 5 minutes per window so the dashboard doesn't pound the
 * DB on every refresh. If Redis is unavailable, falls through to a fresh query.
 */

import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';

export type MetricsWindow = 'today' | '7d' | '30d';

const CACHE_TTL_SEC = 5 * 60;
const CACHE_KEY = (window: MetricsWindow) => `owner-metrics:v1:${window}`;

interface RevenueSlice {
  grossInPaise: number;
  netInPaise: number;
  paidInPaise: number;
  dueInPaise: number;
  discountInPaise: number;
  billCount: number;
  averageBillInPaise: number;
}

interface CountByKey {
  key: string;
  label: string;
  count: number;
}

export interface OwnerMetricsReport {
  window: MetricsWindow;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  visits: {
    total: number;
    diagnostics: number;
    clinic: number;
  };
  revenue: RevenueSlice;
  mix: {
    reportable: number;
    billOnly: number;
    externalUpload: number;
  };
  operations: {
    reportsFinalized: number;
    timeToFinalize: { p50Minutes: number | null; p95Minutes: number | null; samples: number };
    whatsapp: { sent: number; delivered: number; failed: number; deliveryRatePct: number | null };
  };
  topTests: CountByKey[];
  topReferringDoctors: Array<CountByKey & { totalPayoutInPaise: number }>;
}

function computeSince(window: MetricsWindow, now: Date): Date {
  const since = new Date(now);
  if (window === 'today') {
    since.setHours(0, 0, 0, 0);
  } else if (window === '7d') {
    since.setDate(since.getDate() - 7);
  } else {
    since.setDate(since.getDate() - 30);
  }
  return since;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export async function getOwnerMetrics(window: MetricsWindow): Promise<OwnerMetricsReport> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const hit = await redis.get(CACHE_KEY(window));
      if (hit) {
        return JSON.parse(hit) as OwnerMetricsReport;
      }
    } catch (err: any) {
      logger.warn({ err, window }, 'owner-metrics: cache read failed');
    }
  }

  const now = new Date();
  const since = computeSince(window, now);

  // Run independent aggregations in parallel.
  const [
    visitsByDomain,
    billAgg,
    workflowMix,
    finalizedCount,
    finalizedSamples,
    messageStats,
    topTestsRaw,
    topDoctorsRaw,
  ] = await Promise.all([
    prisma.visit.groupBy({
      by: ['domain'],
      where: { createdAt: { gte: since } },
      _count: true,
    }),
    prisma.bill.aggregate({
      where: { billedAt: { gte: since } },
      _sum: {
        totalAmountInPaise: true,
        paidAmountInPaise: true,
        discountAmountInPaise: true,
      },
      _count: true,
      _avg: { totalAmountInPaise: true },
    }),
    prisma.testOrder.groupBy({
      by: ['workflowMode'],
      where: { createdAt: { gte: since } },
      _count: true,
    }),
    prisma.reportVersion.count({
      where: { status: 'FINALIZED', finalizedAt: { gte: since } },
    }),
    prisma.reportVersion.findMany({
      where: { status: 'FINALIZED', finalizedAt: { gte: since } },
      select: {
        finalizedAt: true,
        report: { select: { visit: { select: { createdAt: true } } } },
      },
      take: 1000,
    }),
    prisma.messageLog.groupBy({
      by: ['status'],
      where: { createdAt: { gte: since }, contextType: 'REPORT' },
      _count: true,
    }),
    prisma.testOrder.groupBy({
      by: ['testCodeSnapshot'],
      where: { createdAt: { gte: since }, workflowMode: 'REPORTABLE' },
      _count: { _all: true },
      orderBy: { _count: { testCodeSnapshot: 'desc' } },
      take: 5,
    }),
    prisma.referralDoctor_Visit.groupBy({
      by: ['referralDoctorId'],
      where: { createdAt: { gte: since } },
      _count: { _all: true },
      orderBy: { _count: { referralDoctorId: 'desc' } },
      take: 5,
    }),
  ]);

  // Visits — flatten domain counts
  const visitTotals = visitsByDomain.reduce(
    (acc, row) => {
      const c = (row._count as any) ?? 0;
      if (row.domain === 'DIAGNOSTICS') acc.diagnostics += c;
      else if (row.domain === 'CLINIC') acc.clinic += c;
      acc.total += c;
      return acc;
    },
    { total: 0, diagnostics: 0, clinic: 0 },
  );

  // Revenue — gross = totalAmountInPaise (pre-discount). Net = total - discount.
  const gross = billAgg._sum.totalAmountInPaise ?? 0;
  const discount = billAgg._sum.discountAmountInPaise ?? 0;
  const paid = billAgg._sum.paidAmountInPaise ?? 0;
  const net = gross - discount;
  const due = Math.max(0, net - paid);
  const revenue: RevenueSlice = {
    grossInPaise: gross,
    netInPaise: net,
    paidInPaise: paid,
    dueInPaise: due,
    discountInPaise: discount,
    billCount: billAgg._count ?? 0,
    averageBillInPaise: Math.round(billAgg._avg.totalAmountInPaise ?? 0),
  };

  // Workflow mix
  const mix = { reportable: 0, billOnly: 0, externalUpload: 0 };
  for (const row of workflowMix) {
    const c = (row._count as any) ?? 0;
    if (row.workflowMode === 'REPORTABLE') mix.reportable = c;
    else if (row.workflowMode === 'BILL_ONLY') mix.billOnly = c;
    else if (row.workflowMode === 'EXTERNAL_UPLOAD') mix.externalUpload = c;
  }

  // Time-to-finalize percentiles (in minutes)
  const durations = finalizedSamples
    .filter((r) => r.report?.visit?.createdAt && r.finalizedAt)
    .map((r) => (r.finalizedAt!.getTime() - r.report!.visit.createdAt.getTime()) / 60_000)
    .filter((d) => d >= 0)
    .sort((a, b) => a - b);
  const p50Minutes = percentile(durations, 50);
  const p95Minutes = percentile(durations, 95);

  // WhatsApp delivery counters.
  //
  // Each MessageLog row has ONE current status — Meta updates the same row
  // through PENDING → SENT → DELIVERED → READ. The groupBy returns counts per
  // current status, so a delivered message appears ONLY in DELIVERED. The
  // previous code added DELIVERED rows to BOTH `sent` AND `delivered`, which
  // double-counted and made the delivery rate mathematically pinned ≥50%.
  //
  // We now expose the totals separately:
  //   attempted = SENT + DELIVERED + READ + FAILED   (everything that left us)
  //   delivered = DELIVERED + READ                    (Meta confirmed delivery)
  //   failed    = FAILED
  // and compute delivery rate as delivered / attempted.
  const wa = { sent: 0, delivered: 0, failed: 0 };
  let attempted = 0;
  for (const row of messageStats) {
    const c = (row._count as any) ?? 0;
    if (row.status === 'SENT') {
      wa.sent += c;
      attempted += c;
    } else if (row.status === 'DELIVERED' || row.status === 'READ') {
      wa.delivered += c;
      attempted += c;
    } else if (row.status === 'FAILED') {
      wa.failed += c;
      attempted += c;
    }
  }
  const deliveryRatePct = attempted > 0 ? Math.round((wa.delivered / attempted) * 100) : null;

  // Top tests — already include code; one short query for names
  const topTests: CountByKey[] = topTestsRaw
    .filter((row) => row.testCodeSnapshot)
    .map((row) => ({
      key: row.testCodeSnapshot!,
      label: row.testCodeSnapshot!,
      count: (row._count as any)._all ?? 0,
    }));

  // Top referring doctors — resolve names + total payout.
  //
  // For "total payout in window", we sum DoctorPayoutLedger.derivedAmountInPaise
  // grouped by doctor. That table is the canonical record /api/payouts shows,
  // so the top-list matches the payout detail screens exactly.
  const doctorIds = topDoctorsRaw.map((r) => r.referralDoctorId);
  const [doctors, ledgerSums] = await Promise.all([
    doctorIds.length
      ? prisma.referralDoctor.findMany({
          where: { id: { in: doctorIds } },
          select: { id: true, name: true, doctorNumber: true },
        })
      : Promise.resolve([]),
    doctorIds.length
      ? prisma.doctorPayoutLedger.groupBy({
          by: ['referralDoctorId'],
          where: {
            doctorType: 'REFERRAL',
            referralDoctorId: { in: doctorIds },
            derivedAt: { gte: since },
          },
          _sum: { derivedAmountInPaise: true },
        })
      : Promise.resolve([] as Array<{ referralDoctorId: string | null; _sum: { derivedAmountInPaise: number | null } }>),
  ]);
  const doctorMap = new Map(doctors.map((d) => [d.id, d]));
  const payoutByDoctorId = new Map<string, number>();
  for (const row of ledgerSums) {
    if (row.referralDoctorId) {
      payoutByDoctorId.set(row.referralDoctorId, row._sum.derivedAmountInPaise ?? 0);
    }
  }
  const topReferringDoctors = topDoctorsRaw.map((row) => {
    const doctor = doctorMap.get(row.referralDoctorId);
    return {
      key: row.referralDoctorId,
      label: doctor?.name || `(unknown ${row.referralDoctorId.slice(0, 8)})`,
      count: (row._count as any)._all ?? 0,
      totalPayoutInPaise: payoutByDoctorId.get(row.referralDoctorId) ?? 0,
    };
  });

  const report: OwnerMetricsReport = {
    window,
    windowStart: since.toISOString(),
    windowEnd: now.toISOString(),
    generatedAt: now.toISOString(),
    visits: visitTotals,
    revenue,
    mix,
    operations: {
      reportsFinalized: finalizedCount,
      timeToFinalize: { p50Minutes, p95Minutes, samples: durations.length },
      whatsapp: { ...wa, deliveryRatePct },
    },
    topTests,
    topReferringDoctors,
  };

  // Cache (5 min) — fire-and-forget so a Redis blip doesn't block the response.
  if (redis) {
    redis
      .set(CACHE_KEY(window), JSON.stringify(report), 'EX', CACHE_TTL_SEC)
      .catch((err) => logger.warn({ err, window }, 'owner-metrics: cache write failed'));
  }

  return report;
}
