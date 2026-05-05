import prisma from '../lib/prisma';

const BUSINESS_TIME_ZONE = process.env.BUSINESS_TIME_ZONE || 'Asia/Kolkata';
const BASELINE_WEEKS = 6;
const TREND_DAYS = 30;
const HISTORY_DAYS = TREND_DAYS + (BASELINE_WEEKS * 7) + 7;
const CACHE_TTL_MS = 60_000;
const ANOMALY_THRESHOLD_PERCENT = 12;
const ALERT_THRESHOLD_PERCENT = 20;
const MAX_TREND_ANOMALIES = 5;
const DOCTOR_BREAKDOWN_DAYS = 30;

type SignalStatus = 'BELOW_EXPECTED' | 'ABOVE_EXPECTED' | 'TYPICAL';

type MetricKey = 'revenue' | 'patients' | 'diagnostics' | 'clinic';

interface MetricBand {
  median: number;
  lower_bound: number;
  upper_bound: number;
}

interface SignalMetric extends MetricBand {
  value: number;
  deviation_percent: number;
  signal_status: SignalStatus;
}

interface TrendPoint extends MetricBand {
  date: string;
  value: number;
  deviation_percent: number;
  is_anomaly: boolean;
  severity: number;
}

interface CompositionSegment {
  segment: 'clinic' | 'diagnostics';
  current_percent: number;
  baseline_percent: number;
}

interface TopIssue {
  entity_type: 'branch';
  entity_id: string;
  entity_name: string;
  value: number;
  deviation_percent: number;
  signal_status: SignalStatus;
  rank: number;
}

interface AlertItem {
  entity: string;
  issue: string;
  severity: 'HIGH';
  is_duplicate: boolean;
}

interface DoctorContributionRow {
  id: string;
  name: string;
  revenue: number;
  contribution_percent: number;
}

interface BranchBreakdownRow {
  branch_id: string;
  branch_name: string;
  revenue: number;
  patients: number;
  diagnostics: number;
  clinic: number;
  deviation_percent: number;
  signal_status: SignalStatus;
}

export interface OwnerDashboardResponse {
  generated_at: string;
  window: {
    today: string;
    trend_days: number;
    baseline_weeks: number;
  };
  signals: Record<MetricKey, SignalMetric>;
  trend: {
    metric: 'revenue';
    points: TrendPoint[];
  };
  composition: {
    segments: CompositionSegment[];
  };
  insight: string;
  top_issues: TopIssue[];
  alerts: AlertItem[];
  advanced_breakdown: {
    doctor_contribution: {
      clinic_doctors: DoctorContributionRow[];
      referral_doctors: DoctorContributionRow[];
    };
    full_branch_table: BranchBreakdownRow[];
    extended_analytics: {
      anomaly_days: TrendPoint[];
      revenue_mix: {
        clinic: number;
        diagnostics: number;
      };
    };
  };
}

interface DailyAggregate {
  revenue: number;
  clinicRevenue: number;
  diagnosticsRevenue: number;
  patients: number;
  diagnostics: number;
  clinic: number;
}

interface CacheEntry {
  expiresAt: number;
  data: OwnerDashboardResponse;
}

const cache = new Map<string, CacheEntry>();

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const labelFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIME_ZONE,
  month: 'short',
  day: 'numeric',
});

function getLocalDateKey(date: Date): string {
  const parts = dateFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === 'year')?.value ?? '0000';
  const month = parts.find((part) => part.type === 'month')?.value ?? '01';
  const day = parts.find((part) => part.type === 'day')?.value ?? '01';
  return `${year}-${month}-${day}`;
}

function getLocalLabel(date: Date): string {
  return labelFormatter.format(date);
}

function roundToTwo(value: number): number {
  return Math.round(value * 100) / 100;
}

function getEmptyAggregate(): DailyAggregate {
  return {
    revenue: 0,
    clinicRevenue: 0,
    diagnosticsRevenue: 0,
    patients: 0,
    diagnostics: 0,
    clinic: 0,
  };
}

function getAggregateRecord(
  bucket: Map<string, DailyAggregate>,
  key: string,
): DailyAggregate {
  const existing = bucket.get(key);
  if (existing) {
    return existing;
  }

  const next = getEmptyAggregate();
  bucket.set(key, next);
  return next;
}

function addDays(date: Date, offset: number): Date {
  return new Date(date.getTime() + (offset * 24 * 60 * 60 * 1000));
}

function getQuantile(sortedValues: number[], percentile: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }

  const index = (sortedValues.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);

  if (lower === upper) {
    return sortedValues[lower];
  }

  const weight = index - lower;
  return sortedValues[lower] + ((sortedValues[upper] - sortedValues[lower]) * weight);
}

function computeBand(samples: number[]): MetricBand {
  if (samples.length === 0) {
    return { median: 0, lower_bound: 0, upper_bound: 0 };
  }

  const sorted = [...samples].sort((a, b) => a - b);
  return {
    median: roundToTwo(getQuantile(sorted, 0.5)),
    lower_bound: roundToTwo(getQuantile(sorted, 0.25)),
    upper_bound: roundToTwo(getQuantile(sorted, 0.75)),
  };
}

function computeDeviationPercent(value: number, median: number): number {
  if (median === 0) {
    return value === 0 ? 0 : 100;
  }

  return roundToTwo(((value - median) / median) * 100);
}

function classifySignal(value: number, band: MetricBand): SignalStatus {
  if (value < band.lower_bound) {
    return 'BELOW_EXPECTED';
  }

  if (value > band.upper_bound) {
    return 'ABOVE_EXPECTED';
  }

  return 'TYPICAL';
}

function metricValue(aggregate: DailyAggregate, key: MetricKey): number {
  switch (key) {
    case 'revenue':
      return aggregate.revenue;
    case 'patients':
      return aggregate.patients;
    case 'diagnostics':
      return aggregate.diagnostics;
    case 'clinic':
      return aggregate.clinic;
  }
}

function buildComparableSamples(
  targetDate: Date,
  bucket: Map<string, DailyAggregate>,
  metric: MetricKey,
): number[] {
  const samples: number[] = [];

  for (let weekOffset = 1; weekOffset <= BASELINE_WEEKS; weekOffset += 1) {
    const sampleDate = addDays(targetDate, -(weekOffset * 7));
    const sampleKey = getLocalDateKey(sampleDate);
    const aggregate = bucket.get(sampleKey) || getEmptyAggregate();
    samples.push(metricValue(aggregate, metric));
  }

  return samples;
}

function buildSignalMetric(
  value: number,
  band: MetricBand,
): SignalMetric {
  return {
    value: roundToTwo(value),
    median: band.median,
    lower_bound: band.lower_bound,
    upper_bound: band.upper_bound,
    deviation_percent: computeDeviationPercent(value, band.median),
    signal_status: classifySignal(value, band),
  };
}

function buildDoctorContributionRows(
  rows: Array<{ id: string; name: string; revenue: number }>,
): DoctorContributionRow[] {
  const total = rows.reduce((sum, row) => sum + row.revenue, 0);

  return rows
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 8)
    .map((row) => ({
      id: row.id,
      name: row.name,
      revenue: roundToTwo(row.revenue),
      contribution_percent: total > 0 ? roundToTwo((row.revenue / total) * 100) : 0,
    }));
}

function buildInsight(
  revenueSignal: SignalMetric,
  composition: CompositionSegment[],
  topIssues: TopIssue[],
): string {
  const diagnosticsShift = composition.find((item) => item.segment === 'diagnostics');
  const clinicShift = composition.find((item) => item.segment === 'clinic');
  const biggestIssue = topIssues[0];

  if (revenueSignal.signal_status === 'BELOW_EXPECTED' && diagnosticsShift && diagnosticsShift.current_percent > diagnosticsShift.baseline_percent + 5) {
    return 'Diagnostics is carrying more of the day than usual, which points to softer clinic demand as the main drag on overall performance.';
  }

  if (revenueSignal.signal_status === 'BELOW_EXPECTED' && biggestIssue) {
    return 'The shortfall looks concentrated in branch execution rather than broad demand, so the biggest win is fixing the weakest branches first.';
  }

  if (revenueSignal.signal_status === 'ABOVE_EXPECTED' && clinicShift && clinicShift.current_percent > clinicShift.baseline_percent + 5) {
    return 'Today is outperforming because clinic activity is contributing more than its usual share, not just because both services moved together.';
  }

  if (revenueSignal.signal_status === 'ABOVE_EXPECTED') {
    return 'Performance is running above the normal band, and the lift looks broad-based rather than driven by a single branch or segment.';
  }

  return 'The business is operating inside its normal range, so the main watchpoint is mix shift and localized branch weakness rather than an overall demand problem.';
}

export async function getOwnerDashboardData(): Promise<OwnerDashboardResponse> {
  const cached = cache.get('owner-dashboard:v1');
  if (cached && cached.expiresAt > Date.now()) {
    return cached.data;
  }

  const now = new Date();
  const todayKey = getLocalDateKey(now);
  const historyStart = addDays(now, -(HISTORY_DAYS - 1));
  const doctorBreakdownStart = addDays(now, -(DOCTOR_BREAKDOWN_DAYS - 1));

  const activeBranches = await prisma.branch.findMany({
    where: { isActive: true },
    select: { id: true, name: true },
    orderBy: { name: 'asc' },
  });

  const branchIds = activeBranches.map((branch) => branch.id);

  if (branchIds.length === 0) {
    const emptySignal = buildSignalMetric(0, { median: 0, lower_bound: 0, upper_bound: 0 });
    const emptyResponse: OwnerDashboardResponse = {
      generated_at: now.toISOString(),
      window: {
        today: todayKey,
        trend_days: TREND_DAYS,
        baseline_weeks: BASELINE_WEEKS,
      },
      signals: {
        revenue: emptySignal,
        patients: emptySignal,
        diagnostics: emptySignal,
        clinic: emptySignal,
      },
      trend: { metric: 'revenue', points: [] },
      composition: { segments: [] },
      insight: 'No active branches are configured yet, so the owner dashboard has no business data to evaluate.',
      top_issues: [],
      alerts: [],
      advanced_breakdown: {
        doctor_contribution: {
          clinic_doctors: [],
          referral_doctors: [],
        },
        full_branch_table: [],
        extended_analytics: {
          anomaly_days: [],
          revenue_mix: {
            clinic: 0,
            diagnostics: 0,
          },
        },
      },
    };

    cache.set('owner-dashboard:v1', {
      expiresAt: Date.now() + CACHE_TTL_MS,
      data: emptyResponse,
    });

    return emptyResponse;
  }

  // Aggregate in Postgres rather than streaming every Bill/Visit row into Node.
  // The previous version pulled every bill in HISTORY_DAYS for every branch,
  // which OOMed the dyno once volumes crossed ~50K rows. Postgres `date_trunc`
  // gives us per-day rollups in a single query each.
  //
  // Note on time-zone: `date_trunc` runs in UTC by default. We apply the
  // BUSINESS_TIME_ZONE conversion before truncation so the date keys match
  // what `getLocalDateKey` produces in JS. AT TIME ZONE expects a timestamptz.
  type RevenueRow = {
    branchId: string;
    dateKey: string;
    domain: 'CLINIC' | 'DIAGNOSTICS';
    revenuePaise: bigint;
  };
  type VisitRow = {
    branchId: string;
    dateKey: string;
    domain: 'CLINIC' | 'DIAGNOSTICS';
    visitCount: bigint;
  };

  const [billRollups, visitRollups, clinicDoctorVisits, diagnosticReferralVisits] = await Promise.all([
    prisma.$queryRaw<RevenueRow[]>`
      SELECT
        b."branchId" AS "branchId",
        to_char((b."billedAt" AT TIME ZONE ${BUSINESS_TIME_ZONE})::date, 'YYYY-MM-DD') AS "dateKey",
        v.domain::text AS "domain",
        COALESCE(SUM(b."totalAmountInPaise"), 0)::bigint AS "revenuePaise"
      FROM "Bill" b
      JOIN "Visit" v ON v.id = b."visitId"
      WHERE b."branchId" = ANY(${branchIds}::text[])
        AND b."billedAt" >= ${historyStart}
      GROUP BY b."branchId", "dateKey", v.domain
    `,
    prisma.$queryRaw<VisitRow[]>`
      SELECT
        v."branchId" AS "branchId",
        to_char((v."createdAt" AT TIME ZONE ${BUSINESS_TIME_ZONE})::date, 'YYYY-MM-DD') AS "dateKey",
        v.domain::text AS "domain",
        COUNT(*)::bigint AS "visitCount"
      FROM "Visit" v
      WHERE v."branchId" = ANY(${branchIds}::text[])
        AND v."createdAt" >= ${historyStart}
        AND v.status <> 'CANCELLED'
      GROUP BY v."branchId", "dateKey", v.domain
    `,
    prisma.visit.findMany({
      where: {
        branchId: { in: branchIds },
        domain: 'CLINIC',
        createdAt: { gte: doctorBreakdownStart },
        status: { not: 'CANCELLED' },
        clinicVisit: { isNot: null },
      },
      select: {
        totalAmountInPaise: true,
        clinicVisit: {
          select: {
            clinicDoctor: {
              select: { id: true, name: true },
            },
          },
        },
      },
    }),
    prisma.visit.findMany({
      where: {
        branchId: { in: branchIds },
        domain: 'DIAGNOSTICS',
        createdAt: { gte: doctorBreakdownStart },
        status: { not: 'CANCELLED' },
      },
      select: {
        totalAmountInPaise: true,
        referrals: {
          select: {
            referralDoctor: {
              select: { id: true, name: true },
            },
          },
        },
      },
    }),
  ]);

  const totalsByDate = new Map<string, DailyAggregate>();
  const totalsByBranchDate = new Map<string, DailyAggregate>();

  for (const row of billRollups) {
    const amount = roundToTwo(Number(row.revenuePaise) / 100);
    const totalAggregate = getAggregateRecord(totalsByDate, row.dateKey);
    totalAggregate.revenue += amount;
    if (row.domain === 'CLINIC') {
      totalAggregate.clinicRevenue += amount;
    } else {
      totalAggregate.diagnosticsRevenue += amount;
    }

    const branchAggregate = getAggregateRecord(totalsByBranchDate, `${row.branchId}:${row.dateKey}`);
    branchAggregate.revenue += amount;
    if (row.domain === 'CLINIC') {
      branchAggregate.clinicRevenue += amount;
    } else {
      branchAggregate.diagnosticsRevenue += amount;
    }
  }

  for (const row of visitRollups) {
    const count = Number(row.visitCount);
    const totalAggregate = getAggregateRecord(totalsByDate, row.dateKey);
    totalAggregate.patients += count;
    if (row.domain === 'CLINIC') {
      totalAggregate.clinic += count;
    } else {
      totalAggregate.diagnostics += count;
    }

    const branchAggregate = getAggregateRecord(totalsByBranchDate, `${row.branchId}:${row.dateKey}`);
    branchAggregate.patients += count;
    if (row.domain === 'CLINIC') {
      branchAggregate.clinic += count;
    } else {
      branchAggregate.diagnostics += count;
    }
  }

  const todayAggregate = totalsByDate.get(todayKey) || getEmptyAggregate();
  const todaySignalDate = now;

  const signals = {
    revenue: buildSignalMetric(
      todayAggregate.revenue,
      computeBand(buildComparableSamples(todaySignalDate, totalsByDate, 'revenue')),
    ),
    patients: buildSignalMetric(
      todayAggregate.patients,
      computeBand(buildComparableSamples(todaySignalDate, totalsByDate, 'patients')),
    ),
    diagnostics: buildSignalMetric(
      todayAggregate.diagnostics,
      computeBand(buildComparableSamples(todaySignalDate, totalsByDate, 'diagnostics')),
    ),
    clinic: buildSignalMetric(
      todayAggregate.clinic,
      computeBand(buildComparableSamples(todaySignalDate, totalsByDate, 'clinic')),
    ),
  };

  const trendPoints: TrendPoint[] = [];
  for (let index = TREND_DAYS - 1; index >= 0; index -= 1) {
    const pointDate = addDays(now, -index);
    const dateKey = getLocalDateKey(pointDate);
    const dayAggregate = totalsByDate.get(dateKey) || getEmptyAggregate();
    const band = computeBand(buildComparableSamples(pointDate, totalsByDate, 'revenue'));
    const deviationPercent = computeDeviationPercent(dayAggregate.revenue, band.median);
    const isAnomaly = dayAggregate.revenue < band.lower_bound
      || dayAggregate.revenue > band.upper_bound
      || Math.abs(deviationPercent) >= ANOMALY_THRESHOLD_PERCENT;

    trendPoints.push({
      date: getLocalLabel(pointDate),
      value: roundToTwo(dayAggregate.revenue),
      median: band.median,
      lower_bound: band.lower_bound,
      upper_bound: band.upper_bound,
      deviation_percent: deviationPercent,
      is_anomaly: isAnomaly,
      severity: roundToTwo(Math.abs(deviationPercent)),
    });
  }

  const baselineRevenueSamples = Array.from({ length: BASELINE_WEEKS }, (_, index) => {
    const sampleDate = addDays(now, -((index + 1) * 7));
    const sampleKey = getLocalDateKey(sampleDate);
    return totalsByDate.get(sampleKey) || getEmptyAggregate();
  });

  const baselineRevenueTotal = baselineRevenueSamples.reduce((sum, sample) => sum + sample.revenue, 0);
  const baselineClinicRevenue = baselineRevenueSamples.reduce((sum, sample) => sum + sample.clinicRevenue, 0);
  const baselineDiagnosticsRevenue = baselineRevenueSamples.reduce((sum, sample) => sum + sample.diagnosticsRevenue, 0);
  const currentRevenueTotal = todayAggregate.revenue;

  const compositionSegments: CompositionSegment[] = [
    {
      segment: 'clinic',
      current_percent: currentRevenueTotal > 0 ? roundToTwo((todayAggregate.clinicRevenue / currentRevenueTotal) * 100) : 0,
      baseline_percent: baselineRevenueTotal > 0 ? roundToTwo((baselineClinicRevenue / baselineRevenueTotal) * 100) : 0,
    },
    {
      segment: 'diagnostics',
      current_percent: currentRevenueTotal > 0 ? roundToTwo((todayAggregate.diagnosticsRevenue / currentRevenueTotal) * 100) : 0,
      baseline_percent: baselineRevenueTotal > 0 ? roundToTwo((baselineDiagnosticsRevenue / baselineRevenueTotal) * 100) : 0,
    },
  ];

  const fullBranchTable: BranchBreakdownRow[] = activeBranches.map((branch) => {
    const todayBranchAggregate = totalsByBranchDate.get(`${branch.id}:${todayKey}`) || getEmptyAggregate();
    const branchSamples: number[] = [];

    for (let weekOffset = 1; weekOffset <= BASELINE_WEEKS; weekOffset += 1) {
      const sampleDate = addDays(now, -(weekOffset * 7));
      const sampleKey = getLocalDateKey(sampleDate);
      const aggregate = totalsByBranchDate.get(`${branch.id}:${sampleKey}`) || getEmptyAggregate();
      branchSamples.push(aggregate.revenue);
    }

    const band = computeBand(branchSamples);
    const deviationPercent = computeDeviationPercent(todayBranchAggregate.revenue, band.median);

    return {
      branch_id: branch.id,
      branch_name: branch.name,
      revenue: roundToTwo(todayBranchAggregate.revenue),
      patients: todayBranchAggregate.patients,
      diagnostics: todayBranchAggregate.diagnostics,
      clinic: todayBranchAggregate.clinic,
      deviation_percent: deviationPercent,
      signal_status: classifySignal(todayBranchAggregate.revenue, band),
    };
  }).sort((a, b) => a.deviation_percent - b.deviation_percent);

  const topIssues = fullBranchTable
    .filter((branch) => branch.signal_status === 'BELOW_EXPECTED')
    .slice(0, 3)
    .map((branch, index) => ({
      entity_type: 'branch' as const,
      entity_id: branch.branch_id,
      entity_name: branch.branch_name,
      value: branch.revenue,
      deviation_percent: branch.deviation_percent,
      signal_status: branch.signal_status,
      rank: index + 1,
    }));

  const topIssueBranchIds = new Set(topIssues.map((item) => item.entity_id));
  const alerts = fullBranchTable
    .filter((branch) => !topIssueBranchIds.has(branch.branch_id))
    .map((branch) => {
      const patientSamples: number[] = [];
      for (let weekOffset = 1; weekOffset <= BASELINE_WEEKS; weekOffset += 1) {
        const sampleDate = addDays(now, -(weekOffset * 7));
        const sampleKey = getLocalDateKey(sampleDate);
        const aggregate = totalsByBranchDate.get(`${branch.branch_id}:${sampleKey}`) || getEmptyAggregate();
        patientSamples.push(aggregate.patients);
      }

      const patientBand = computeBand(patientSamples);
      const patientToday = totalsByBranchDate.get(`${branch.branch_id}:${todayKey}`)?.patients || 0;
      const patientDeviation = computeDeviationPercent(patientToday, patientBand.median);

      if (patientToday < patientBand.lower_bound && Math.abs(patientDeviation) >= ALERT_THRESHOLD_PERCENT) {
        return {
          entity: branch.branch_name,
          issue: `Patient volume is ${Math.abs(Math.round(patientDeviation))}% below its usual range.`,
          severity: 'HIGH' as const,
          is_duplicate: false,
        };
      }

      return null;
    })
    .filter((item): item is AlertItem => Boolean(item))
    .slice(0, 3);

  const clinicDoctorRevenue = new Map<string, { id: string; name: string; revenue: number }>();
  for (const visit of clinicDoctorVisits) {
    const doctor = visit.clinicVisit?.clinicDoctor;
    if (!doctor) {
      continue;
    }

    const existing = clinicDoctorRevenue.get(doctor.id) || { id: doctor.id, name: doctor.name, revenue: 0 };
    existing.revenue += visit.totalAmountInPaise / 100;
    clinicDoctorRevenue.set(doctor.id, existing);
  }

  const referralDoctorRevenue = new Map<string, { id: string; name: string; revenue: number }>();
  for (const visit of diagnosticReferralVisits) {
    const doctorCount = visit.referrals.length;
    if (doctorCount === 0) {
      continue;
    }

    const allocatedRevenue = (visit.totalAmountInPaise / 100) / doctorCount;
    for (const referral of visit.referrals) {
      const doctor = referral.referralDoctor;
      const existing = referralDoctorRevenue.get(doctor.id) || { id: doctor.id, name: doctor.name, revenue: 0 };
      existing.revenue += allocatedRevenue;
      referralDoctorRevenue.set(doctor.id, existing);
    }
  }

  const anomalyDays = trendPoints
    .filter((point) => point.is_anomaly)
    .sort((a, b) => b.severity - a.severity)
    .slice(0, MAX_TREND_ANOMALIES);

  const response: OwnerDashboardResponse = {
    generated_at: now.toISOString(),
    window: {
      today: todayKey,
      trend_days: TREND_DAYS,
      baseline_weeks: BASELINE_WEEKS,
    },
    signals,
    trend: {
      metric: 'revenue',
      points: trendPoints,
    },
    composition: {
      segments: compositionSegments,
    },
    insight: buildInsight(signals.revenue, compositionSegments, topIssues),
    top_issues: topIssues,
    alerts,
    advanced_breakdown: {
      doctor_contribution: {
        clinic_doctors: buildDoctorContributionRows(Array.from(clinicDoctorRevenue.values())),
        referral_doctors: buildDoctorContributionRows(Array.from(referralDoctorRevenue.values())),
      },
      full_branch_table: fullBranchTable,
      extended_analytics: {
        anomaly_days: anomalyDays,
        revenue_mix: {
          clinic: roundToTwo(todayAggregate.clinicRevenue),
          diagnostics: roundToTwo(todayAggregate.diagnosticsRevenue),
        },
      },
    },
  };

  cache.set('owner-dashboard:v1', {
    expiresAt: Date.now() + CACHE_TTL_MS,
    data: response,
  });

  return response;
}
