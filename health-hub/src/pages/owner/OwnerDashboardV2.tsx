/**
 * Owner dashboard.
 *
 * One basis for money: NET COLLECTED (cash + online − refunds). Every split on
 * the page — department, source, doctor, branch — adds back up to it, and
 * "net to you" is collected − commission. Billed amounts appear only where the
 * figure is about billing itself (discounts given, dues still open).
 *
 * Top to bottom: what needs attention (live) · the KPIs · the trend beside
 * where the money went and this month's pace · departments and sources beside
 * doctors · branches · today, live · when patients come.
 *
 * Money follows the All / Diagnostic / OP switch (?domain=, Diagnostic by
 * default); live operations always cover both.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Clock, Info } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { KpiTile, ComparisonTrendChart, Sparkline, SERIES, BusyHoursHeatmap, BarList, StatementLine, Delta, GroupLabel, TH, ROW, TOTAL_ROW, type BarRow } from './_shared/dashboardCharts';
import {
  TOKENS,
  SectionCard,
  StatRow,
  SectionLabel,
  BranchFilter,
  PeriodFilter,
  PeriodKey,
  PERIOD_LABEL,
  formatIstDateTime,
  ErrorCard,
  RefreshButton,
  formatRupees,
  DomainFilter,
  DomainKey,
  domainFromParam,
} from './_shared/ownerUi';

// ----- types ------------------------------------------------------------

type ActionChipType =
  | 'late_reports'
  | 'unpaid_aged'
  | 'whatsapp_failed'
  | 'large_discount'
  | 'dormant_branch'
  | 'identity_change_unjustified';

interface ActionChip {
  type: ActionChipType;
  severity: 'high' | 'medium' | 'low';
  label: string;
  count?: number;
  amountInPaise?: number;
  drillTo: string;
}

interface DashboardV2 {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  dataAge: { firstVisitAt: string | null; daysSinceLaunch: number };
  actionQueue: ActionChip[];
  moneyToday: {
    grossInPaise: number;
    discountInPaise: number;
    reversedInPaise: number;
    commissionInPaise: number;
    netInPaise: number;
    discountRatePct: number;
    cashInPaise: number;
    onlineInPaise: number;
    collectedTotalInPaise: number;
    refundInPaise: number;
    outstandingInPaise: number;
    deltaPercent: number | null;
    netCollectedInPaise: number;
    collectedDeltaPercent: number | null;
    commissionSplit?: { referralInPaise: number; partnerInPaise: number; clinicInPaise: number };
  };
  payoutLiability: {
    totalInPaise: number;
    byType: {
      referralInPaise: number;
      clinicInPaise: number;
      partnerInPaise: number;
    };
  };
  opsPulse: {
    diagnostics: {
      ordersToday: number;
      finalizedToday: number;
      inProgress: number;
      pendingSample: number;
      tatP50Minutes: number | null;
      tatP95Minutes: number | null;
      tatBreachCount: number;
      tatSampleCount: number;
      visitsToday?: number;
      awaitingResults?: number;
      partlyReported?: number;
    };
    clinic: {
      waiting: number;
      inConsultation: number;
      completedToday: number;
      revisitsToday: number;
      revisitRatePct: number | null;
      avgWaitMinutes: number | null;
      onShiftDoctorName: string | null;
    };
    comms: {
      sent: number;
      delivered: number;
      read: number;
      failed: number;
      optInPercent: number | null;
    };
  };
  revenueTrend: { date: string; collectedInPaise: number }[];
  trend: TrendDay[];
  kpis: { current: Totals & { outstanding: number }; prior: Totals };
  /** current / prior are net collected (older payloads: billed). */
  categoryMoves: { category: string; current: number; prior: number; tests: number; priorTests: number }[];
  sources: { source: 'referred' | 'walkin' | 'partner' | 'clinic'; visits: number; gross: number; priorVisits: number; priorGross: number; collected?: number; priorCollected?: number }[];
  referrers: { referralDoctorId: string; name: string; visits: number; billed: number; commission: number; priorVisits: number; priorBilled: number; collected?: number; priorCollected?: number }[];
  slippingReferrers?: { referralDoctorId: string; name: string; collected: number; priorCollected: number }[];
  monthPace?: {
    monthLabel: string;
    priorMonthLabel: string;
    soFar: number;
    throughYesterday: number;
    daysDone: number;
    daysInMonth: number;
    projected: number | null;
    priorMonthTotal: number;
    priorMonthSameDays: number;
  };
  busyHours?: { dow: number; hour: number; visits: number }[];
  revenueMix: {
    reportableInPaise: number;
    clinicInPaise: number;
    billOnlyInPaise: number;
    totalInPaise: number;
  };
  branchTable: {
    branchId: string;
    branchName: string;
    branchCode: string;
    netInPaise: number;
    visitCount: number;
    avgTicketInPaise: number | null;
    avgBillInPaise?: number | null;
    tatP50Minutes: number | null;
    tatSampleCount?: number;
    deltaPercent: number | null;
    daysDormant: number;
    collectedInPaise: number;
    grossInPaise: number;
    discountInPaise: number;
    collectedDaily: number[];
  }[];
}

interface DayPoint {
  collected: number;
  gross: number;
  net: number;
  visits: number;
  discount: number;
  bills: number;
}
interface TrendDay extends DayPoint {
  date: string;
  prior: DayPoint;
}
interface Totals {
  commission?: number;
  netCollected: number;
  net: number;
  visits: number;
  gross: number;
  bills: number;
  discount: number;
}

// ----- metrics: one definition feeds the KPI tile, its delta and the trend --

type MetricKey = 'collected' | 'net' | 'visits' | 'perVisit' | 'discount';
interface Metric {
  label: string;
  title: string;
  num: (p: DayPoint) => number;
  den?: (p: DayPoint) => number; // ratio metrics: averaged as Σnum / Σden
  format: (v: number) => string;
  axis: (v: number) => string;
  goodWhenUp: boolean;
}
// Axis ticks are round numbers: ₹50k, ₹1L, ₹1.5L — not ₹1.0L.
const rupeesAxis = (p: number) => formatRupees(p, { short: true }).replace('.0', '');
// Whole rupees: paise on a summary is noise.
const rupeesWhole = (p: number) => formatRupees(Math.round(p / 100) * 100);
const rupeesShort = (p: number) => formatRupees(p, { short: true });
const duration = (min: number) => (min < 60 ? `${Math.round(min)}m` : `${(min / 60).toFixed(1)}h`);
const pctOf = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
const change = (now: number, before: number): number | null =>
  before > 0 ? Math.round(((now - before) / before) * 100) : null;
const METRICS: Record<MetricKey, Metric> = {
  collected: {
    label: 'Net collected',
    title: 'Net collected per day',
    num: (p) => p.collected,
    format: rupeesWhole,
    axis: rupeesAxis,
    goodWhenUp: true,
  },
  net: {
    label: 'Net to you',
    title: 'Net to you per day (collected − commission)',
    num: (p) => p.net,
    format: rupeesWhole,
    axis: rupeesAxis,
    goodWhenUp: true,
  },
  visits: {
    label: 'Visits',
    title: 'Visits per day',
    num: (p) => p.visits,
    format: (v) => Math.round(v).toLocaleString('en-IN'),
    axis: (v) => Math.round(v).toLocaleString('en-IN'),
    goodWhenUp: true,
  },
  perVisit: {
    label: 'Collected per visit',
    title: 'Net collected per visit, per day',
    num: (p) => p.collected,
    den: (p) => p.visits,
    format: rupeesWhole,
    axis: rupeesAxis,
    goodWhenUp: true,
  },
  discount: {
    label: 'Discounts given',
    title: 'Discounts given per day',
    num: (p) => p.discount,
    format: rupeesWhole,
    axis: rupeesAxis,
    goodWhenUp: false,
  },
};
const METRIC_ORDER: MetricKey[] = ['collected', 'net', 'visits', 'perVisit', 'discount'];

const totalsPoint = (t: Totals): DayPoint => ({
  collected: t.netCollected,
  gross: t.gross,
  net: t.net,
  visits: t.visits,
  discount: t.discount,
  bills: t.bills,
});
function metricValue(m: Metric, p: DayPoint): number | null {
  if (!m.den) return m.num(p);
  const d = m.den(p);
  return d > 0 ? m.num(p) / d : null;
}
/** Trailing 7-day value at each point: Σnum / 7 for flows, Σnum / Σden for ratios. */
function rolling7(m: Metric, series: DayPoint[]): (number | null)[] {
  return series.map((_, i) => {
    if (i < 6) return null;
    const w = series.slice(i - 6, i + 1);
    const num = w.reduce((s, p) => s + m.num(p), 0);
    if (!m.den) return num / 7;
    const den = w.reduce((s, p) => s + m.den!(p), 0);
    return den > 0 ? num / den : null;
  });
}
/**
 * Daily series for a metric: the window's values, the prior window's same-day
 * values, and both 7-day averages. The prior window ends where this one
 * starts, so it seeds the window's first six averages — unless the trend was
 * capped (long windows), where the two are not adjacent.
 */
function metricSeries(m: Metric, trend: TrendDay[], adjacent: boolean) {
  const days = trend.map((d) => ({ date: d.date, value: metricValue(m, d), prior: metricValue(m, d.prior) }));
  const long = trend.length >= 14;
  const priors = trend.map((d) => d.prior);
  const average = long
    ? adjacent
      ? rolling7(m, [...priors, ...trend]).slice(trend.length)
      : rolling7(m, trend)
    : days.map((d) => d.value);
  const priorAverage = long ? rolling7(m, priors) : days.map((d) => d.prior);
  return { days, average, priorAverage, long };
}

// Design tokens + primitives are the single source of truth in
// ./_shared/ownerUi (imported above).

function severityRank(s: ActionChip['severity']): number {
  if (s === 'high') return 3;
  if (s === 'medium') return 2;
  return 1;
}

function severityColor(s: ActionChip['severity']): string {
  if (s === 'high') return TOKENS.critical;
  if (s === 'medium') return TOKENS.caution;
  return TOKENS.textTertiary;
}

function severityIcon(s: ActionChip['severity']) {
  if (s === 'high') return AlertTriangle;
  if (s === 'medium') return Clock;
  return Info;
}

// ----- action queue -----------------------------------------------------

function ActionQueue({ chips }: { chips: ActionChip[] }) {
  if (chips.length === 0) {
    return (
      <div
        className="px-4 py-3"
        style={{
          color: TOKENS.textTertiary,
          fontSize: 13,
          background: TOKENS.surface,
          border: `0.5px solid ${TOKENS.border}`,
          borderRadius: 12,
        }}
      >
        All clear — no decisions pending.
      </div>
    );
  }

  // Sort by severity (high > medium > low), then by amount desc. There are only
  // 6 chip types, so the cap of 7 shows them all — no overflow chip.
  const sorted = [...chips]
    .sort((a, b) => {
      const sev = severityRank(b.severity) - severityRank(a.severity);
      if (sev !== 0) return sev;
      return (b.amountInPaise ?? 0) - (a.amountInPaise ?? 0);
    })
    .slice(0, 7);

  return (
    <div className="flex flex-wrap gap-2">
      {sorted.map((chip) => {
        const Icon = severityIcon(chip.severity);
        const color = severityColor(chip.severity);
        const badge =
          chip.amountInPaise !== undefined
            ? formatRupees(chip.amountInPaise, { short: true })
            : chip.count !== undefined
              ? String(chip.count)
              : null;
        return (
          <Link
            key={chip.type}
            to={chip.drillTo}
            className="inline-flex items-center gap-2"
            style={{
              background: TOKENS.surface,
              border: `0.5px solid ${TOKENS.border}`,
              borderLeftWidth: 2,
              borderLeftColor: color,
              borderRadius: 4,
              padding: '8px 12px',
              fontSize: 13,
              color: TOKENS.textPrimary,
              textDecoration: 'none',
            }}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" style={{ color }} />
            <span>{chip.label}</span>
            {badge && (
              <span
                className="ml-1 font-medium"
                style={{
                  color,
                  background: `${color}1A`,
                  borderRadius: 3,
                  padding: '1px 6px',
                  fontSize: 12,
                }}
              >
                {badge}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

// ----- where the money went + this month ---------------------------------

function MoneyCard({
  data,
  periodLabel,
  moneyHref,
}: {
  data: DashboardV2;
  periodLabel: string;
  moneyHref: string;
}) {
  const m = data.moneyToday;
  const pace = data.monthPace;
  const split = m.commissionSplit;
  const payees = split
    ? [
        ['doctors', split.referralInPaise],
        ['partners', split.partnerInPaise],
        ['clinic doctors', split.clinicInPaise],
      ].filter(([, v]) => v) as [string, number][]
    : [];
  const kept = m.netCollectedInPaise > 0 ? Math.max(0, Math.min(1, m.netInPaise / m.netCollectedInPaise)) : 0;
  return (
    <SectionCard label={`Where the money went · ${periodLabel}`} className="h-full">
      <StatementLine label="Cash" value={m.cashInPaise} to={moneyHref} />
      <StatementLine label="Online" value={m.onlineInPaise} to={moneyHref} />
      {m.refundInPaise > 0 && <StatementLine label="Refunds paid out" value={-m.refundInPaise} />}
      <StatementLine label="Net collected" value={m.netCollectedInPaise} total />
      <StatementLine
        label="Commission"
        note={payees.length > 1 ? payees.map(([k, v]) => `${k} ${rupeesShort(v)}`).join(', ') : `${pctOf(m.commissionInPaise, m.netCollectedInPaise)}% of collected`}
        value={-m.commissionInPaise}
        to="/owner/payouts"
      />
      <StatementLine label="Net to you" value={m.netInPaise} total />
      <div
        className="mt-1 flex overflow-hidden"
        style={{ height: 8, borderRadius: 4, gap: 2 }}
        role="img"
        aria-label={`You keep ${Math.round(kept * 100)} percent of what was collected`}
      >
        <div style={{ width: `${kept * 100}%`, background: TOKENS.net }} />
        <div style={{ flex: 1, background: TOKENS.commissionBar }} />
      </div>
      <div className="mt-1 flex justify-between" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
        <span>You keep {Math.round(kept * 100)}%</span>
        <span>Commission {100 - Math.round(kept * 100)}%</span>
      </div>

      {pace && <MonthPace pace={pace} />}
    </SectionCard>
  );
}

/** This calendar month, whatever the date filter: so far, and where it is heading. */
function MonthPace({ pace }: { pace: NonNullable<DashboardV2['monthPace']> }) {
  const scale = Math.max(pace.projected ?? 0, pace.priorMonthTotal, pace.soFar, 1);
  const vsPrior = pace.projected != null ? change(pace.projected, pace.priorMonthTotal) : null;
  const sameDays = change(pace.throughYesterday, pace.priorMonthSameDays);
  return (
    <div className="mt-4 border-t pt-3" style={{ borderColor: TOKENS.border }}>
      <div className="flex items-baseline justify-between">
        <SectionLabel>{pace.monthLabel} so far</SectionLabel>
        <span className="font-medium" style={{ fontSize: 14 }}>{rupeesWhole(pace.soFar)}</span>
      </div>
      <div className="relative mt-2" style={{ height: 8, borderRadius: 4, background: '#F1F0EC' }}>
        {pace.projected != null && (
          <div
            style={{ position: 'absolute', inset: 0, width: `${(pace.projected / scale) * 100}%`, borderRadius: 4, background: '#DCE9F7' }}
          />
        )}
        <div style={{ position: 'absolute', inset: 0, width: `${(pace.soFar / scale) * 100}%`, borderRadius: 4, background: SERIES[0] }} />
        <div
          title={`${pace.priorMonthLabel}: ${rupeesWhole(pace.priorMonthTotal)}`}
          style={{ position: 'absolute', top: -3, bottom: -3, left: `calc(${(pace.priorMonthTotal / scale) * 100}% - 1px)`, width: 2, background: TOKENS.textPrimary }}
        />
      </div>
      <div className="mt-1.5" style={{ fontSize: 12, color: TOKENS.textSecondary }}>
        {pace.projected != null ? (
          <>
            On pace for <span className="font-medium" style={{ color: TOKENS.textPrimary }}>{rupeesShort(pace.projected)}</span>
            {' · '}
            {pace.priorMonthLabel} {rupeesShort(pace.priorMonthTotal)}
            {vsPrior != null && (
              <span style={{ color: vsPrior >= 0 ? TOKENS.healthy : TOKENS.critical }}> {vsPrior >= 0 ? '▲' : '▼'} {Math.abs(vsPrior)}%</span>
            )}
          </>
        ) : (
          `Pace shows after 3 full days · ${pace.priorMonthLabel} ${rupeesShort(pace.priorMonthTotal)}`
        )}
      </div>
      {pace.daysDone > 0 && sameDays != null && (
        <div style={{ fontSize: 11, color: TOKENS.textTertiary }}>
          First {pace.daysDone} day{pace.daysDone === 1 ? '' : 's'}: {rupeesShort(pace.throughYesterday)} vs {rupeesShort(pace.priorMonthSameDays)} in {pace.priorMonthLabel}
          {' '}({sameDays >= 0 ? '+' : '−'}{Math.abs(sameDays)}%)
        </div>
      )}
    </div>
  );
}

// ----- ops pulse 3-tile -------------------------------------------------

function OpsPulseRow({ data }: { data: DashboardV2['opsPulse'] }) {
  const { diagnostics, clinic, comms } = data;
  const tatNote = diagnostics.tatSampleCount >= 4
    ? `Turnaround: median ${duration(diagnostics.tatP50Minutes ?? 0)} · slowest 5% ${duration(diagnostics.tatP95Minutes ?? 0)} · ${diagnostics.tatBreachCount} over 24h`
    : `Turnaround shows after 4 reports today · ${diagnostics.tatSampleCount} so far`;
  // Message statuses are where each message got to: read ones were delivered too.
  const msgs = comms.sent + comms.delivered + comms.read + comms.failed;
  const reached = comms.delivered + comms.read;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <SectionCard
        label="Diagnostics"
        rightSlot={
          <Link
            to="/diagnostics/pending"
            style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}
          >
            open ↗
          </Link>
        }
      >
        <StatRow label="Visits today" value={diagnostics.visitsToday ?? '—'} />
        <StatRow label="Reports finalized today" value={diagnostics.finalizedToday} />
        <StatRow label="Open · no results yet" value={diagnostics.awaitingResults ?? '—'} />
        <StatRow label="Open · partly reported" value={diagnostics.partlyReported ?? '—'} />
        <div
          className="mt-3 border-t pt-2"
          style={{ borderColor: TOKENS.border, color: TOKENS.textTertiary, fontSize: 11 }}
        >
          {tatNote}
        </div>
      </SectionCard>

      <SectionCard
        label="Clinic queue"
        rightSlot={
          <Link
            to="/clinic/queue"
            style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}
          >
            open ↗
          </Link>
        }
      >
        <StatRow
          label="Waiting"
          value={clinic.waiting}
          emphasize={clinic.waiting > 5 ? 'caution' : undefined}
        />
        <StatRow label="In consultation" value={clinic.inConsultation} />
        <StatRow label="Completed today" value={clinic.completedToday} />
        <StatRow label="Revisits today" value={clinic.revisitsToday} />
        <div
          className="mt-3 border-t pt-2"
          style={{ borderColor: TOKENS.border, color: TOKENS.textTertiary, fontSize: 11 }}
        >
          {clinic.avgWaitMinutes !== null
            ? `Avg wait ${clinic.avgWaitMinutes}m`
            : 'Avg wait —'}
          {clinic.revisitRatePct != null ? ` · ${clinic.revisitRatePct}% revisits` : ''}
          {clinic.onShiftDoctorName ? ` · ${clinic.onShiftDoctorName} on shift` : ' · no doctor on shift'}
        </div>
      </SectionCard>

      <SectionCard
        label="Patient comms · today"
        rightSlot={
          <Link
            to="/ops/audit?tab=comms"
            style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}
          >
            open ↗
          </Link>
        }
      >
        <StatRow label="Messages today" value={msgs} />
        <StatRow label="Delivered" value={`${reached} · ${pctOf(reached, msgs)}%`} />
        <StatRow label="Read" value={`${comms.read} · ${pctOf(comms.read, msgs)}%`} />
        <StatRow
          label="Failed"
          value={`${comms.failed} · ${pctOf(comms.failed, msgs)}%`}
          emphasize={comms.failed > 0 ? 'critical' : undefined}
        />
        <div
          className="mt-3 border-t pt-2"
          style={{ borderColor: TOKENS.border, color: TOKENS.textTertiary, fontSize: 11 }}
        >
          {comms.sent > 0 ? `${comms.sent} not delivered yet · ` : ''}
          {comms.optInPercent !== null ? `Opt-in ${comms.optInPercent}% · target 80%` : 'No visits today'}
        </div>
      </SectionCard>
    </div>
  );
}

// ----- KPI row + trend --------------------------------------------------

function KpiRow({
  data,
  metric,
  onMetric,
  adjacent,
}: {
  data: DashboardV2;
  metric: MetricKey;
  onMetric: (m: MetricKey) => void;
  adjacent: boolean;
}) {
  const cur = totalsPoint(data.kpis.current);
  const prior = totalsPoint(data.kpis.prior);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {METRIC_ORDER.map((k) => {
        const m = METRICS[k];
        const now = metricValue(m, cur);
        const before = metricValue(m, prior);
        let delta: { text: string; up: boolean } | null = null;
        if (now != null && before != null && before !== 0) {
          const pct = Math.round(((now - before) / Math.abs(before)) * 100);
          delta = { text: `${Math.abs(pct)}%`, up: pct >= 0 };
        }
        return (
          <KpiTile
            key={k}
            label={m.label}
            hint={m.title}
            value={now == null ? '—' : m.format(now)}
            delta={delta}
            deltaGoodWhenUp={m.goodWhenUp}
            footnote="no prior period to compare"
            spark={metricSeries(m, data.trend, adjacent).average}
            selected={metric === k}
            onSelect={() => onMetric(k)}
          />
        );
      })}
      <Link to="/money/bills?aging=open" className="block h-full" style={{ textDecoration: 'none' }}>
        <KpiTile
          label="Open dues"
          value={rupeesWhole(data.kpis.current.outstanding)}
          delta={null}
          footnote="still to collect, all bills · open ↗"
        />
      </Link>
    </div>
  );
}

function TrendCard({
  data,
  metric,
  periodLabel,
  adjacent,
  onPickDay,
}: {
  data: DashboardV2;
  metric: MetricKey;
  periodLabel: string;
  adjacent: boolean;
  onPickDay: (date: string) => void;
}) {
  const m = METRICS[metric];
  const { days, average, priorAverage, long } = useMemo(
    () => metricSeries(m, data.trend, adjacent),
    [m, data.trend, adjacent],
  );
  const capped = data.trend.length > 0 && !adjacent;
  return (
    <SectionCard
      label={`${m.title} · ${periodLabel}`}
      description={capped ? `Last ${data.trend.length} days of the window · click a tile above to chart it, a day to open it` : 'Click a tile above to chart it, a day to open it'}
      className="h-full"
    >
      <div className="mb-1 flex flex-wrap gap-4" style={{ fontSize: 11, color: TOKENS.textSecondary }}>
        <span className="inline-flex items-center gap-1.5">
          <span style={{ width: 10, height: 10, borderRadius: 2, background: TOKENS.gross, display: 'inline-block' }} />
          Each day
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span style={{ width: 14, height: 2, background: TOKENS.info, display: 'inline-block' }} />
          {long ? '7-day average' : 'This period'}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span style={{ width: 14, borderTop: `2px dashed ${TOKENS.textTertiary}`, display: 'inline-block' }} />
          {long ? 'Prior period, 7-day average' : 'Prior period'}
        </span>
      </div>
      <ComparisonTrendChart
        days={days}
        average={average}
        priorAverage={priorAverage}
        format={m.axis}
        onPickDay={onPickDay}
        height={300}
      />
    </SectionCard>
  );
}

// ----- busy hours -------------------------------------------------------

function BusyHoursCard({ cells, periodLabel }: { cells: NonNullable<DashboardV2['busyHours']>; periodLabel: string }) {
  return (
    <SectionCard
      label={`When patients come · ${periodLabel}`}
      description="Registrations by weekday and hour — for staffing, and for timing offers into quiet slots"
      className="h-full"
    >
      <BusyHoursHeatmap cells={cells} />
    </SectionCard>
  );
}

// ----- departments, sources, doctors: splits of net collected ------------

const SOURCE_LABEL: Record<DashboardV2['sources'][number]['source'], string> = {
  referred: 'Referred by a doctor',
  walkin: 'Walk-in',
  partner: 'Through a partner',
  clinic: 'OP consultation',
};

function DepartmentsCard({ data, periodLabel }: { data: DashboardV2; periodLabel: string }) {
  const total = data.categoryMoves.reduce((s, m) => s + m.current, 0);
  // Departments under 1% of the money fold into one "Other" line.
  const small = (m: DashboardV2['categoryMoves'][number]) => Math.abs(m.current) < total * 0.01 && Math.abs(m.prior) < total * 0.01;
  const rest = data.categoryMoves.filter(small);
  const rows: BarRow[] = data.categoryMoves.filter((m) => !small(m)).map((m) => ({
    key: m.category,
    label: m.category,
    value: m.current,
    prior: m.prior,
    note: `${m.tests.toLocaleString('en-IN')} tests`,
  }));
  if (rest.length) {
    rows.push({
      key: 'Other',
      label: 'Other',
      value: rest.reduce((s, m) => s + m.current, 0),
      prior: rest.reduce((s, m) => s + m.prior, 0),
      note: rest.map((m) => m.category).join(', '),
    });
  }
  return (
    <SectionCard label={`Departments · ${periodLabel}`} description="Net collected by department, against the period before" className="h-full">
      <BarList rows={rows} format={rupeesShort} totalLabel="Net collected" priorLabel="the period before" />
    </SectionCard>
  );
}

function SourcesCard({ data, periodLabel }: { data: DashboardV2; periodLabel: string }) {
  const rows: BarRow[] = data.sources.map((s) => ({
    key: s.source,
    label: SOURCE_LABEL[s.source],
    value: s.collected ?? 0,
    prior: s.priorCollected ?? 0,
    note: `${s.visits.toLocaleString('en-IN')} bills`,
  }));
  return (
    <SectionCard label={`Where patients come from · ${periodLabel}`} description="Net collected by how the patient reached you" className="h-full">
      <BarList rows={rows} format={rupeesShort} totalLabel="Net collected" priorLabel="the period before" />
    </SectionCard>
  );
}

function DoctorsCard({
  data,
  periodLabel,
  onPickReferrer,
}: {
  data: DashboardV2;
  periodLabel: string;
  onPickReferrer: (doctorId: string) => void;
}) {
  const name = (n: string) => n.replace(/\s{2,}.*$/, '');
  const docButton = (id: string, n: string) => (
    <button
      onClick={(e) => { e.stopPropagation(); onPickReferrer(id); }}
      style={{ color: TOKENS.info, background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}
    >
      {name(n)}
    </button>
  );
  const th = TH;
  const slipping = data.slippingReferrers ?? [];
  return (
    <SectionCard
      label={`Referring doctors · ${periodLabel}`}
      description="Money their patients brought in · click a doctor for their payout statement"
      className="h-full"
    >
      {data.referrers.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>No referred patients in this window.</div>
      ) : (
        <table className="w-full" style={{ fontSize: 13 }}>
          <thead>
            <tr>
              <th className="py-1.5 text-left" style={th}>Doctor</th>
              <th className="py-1.5 text-right" style={th}>Visits</th>
              <th className="py-1.5 text-right" style={th}>Collected</th>
              <th className="py-1.5 text-right" style={th}>vs before</th>
              <th className="py-1.5 text-right" style={th} title="Commission, and what share of the collected money it is">Commission</th>
            </tr>
          </thead>
          <tbody>
            {data.referrers.map((r) => {
              const collected = r.collected ?? r.billed;
              return (
                <tr
                  key={r.referralDoctorId}
                  onClick={() => onPickReferrer(r.referralDoctorId)}
                  className="hover:bg-slate-50"
                  style={{ ...ROW, cursor: 'pointer' }}
                >
                  <td className="py-2">{docButton(r.referralDoctorId, r.name)}</td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textSecondary }}>{r.visits}</td>
                  <td className="py-2 text-right font-medium">{rupeesShort(collected)}</td>
                  <td className="py-2 text-right"><Delta now={collected} before={r.priorCollected ?? r.priorBilled} /></td>
                  <td className="py-2 text-right">
                    {rupeesShort(r.commission)}
                    <span style={{ color: TOKENS.textTertiary }}> · {pctOf(r.commission, collected)}%</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {slipping.length > 0 && (
        <div className="mt-4 rounded-lg px-3 py-2" style={{ background: '#FCEBEB55', border: `0.5px solid ${TOKENS.border}` }}>
          <div className="flex items-center gap-1.5" style={{ fontSize: 12, color: TOKENS.critical, fontWeight: 500 }}>
            <AlertTriangle className="h-3.5 w-3.5" /> Sending less than before
          </div>
          {slipping.map((r) => (
            <div key={r.referralDoctorId} className="flex items-baseline justify-between gap-3 py-1" style={{ fontSize: 13 }}>
              {docButton(r.referralDoctorId, r.name)}
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                <span style={{ color: TOKENS.textTertiary }}>{rupeesShort(r.priorCollected)} → </span>
                {rupeesShort(r.collected)} <Delta now={r.collected} before={r.priorCollected} />
              </span>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ----- branch table -----------------------------------------------------

type BranchSort = 'collected' | 'delta' | 'visits' | 'avg' | 'net' | 'tat';
// Same floor the diagnostics tile uses before it shows a TAT at all.
const TAT_MIN_SAMPLES = 4;

function BranchTableCard({
  rows,
  periodLabel,
  onPickBranch,
  perVisit,
  collectedDelta,
}: {
  rows: DashboardV2['branchTable'];
  periodLabel: string;
  onPickBranch: (branchId: string) => void;
  perVisit: number | null;
  collectedDelta: number | null;
}) {
  const avgOf = (r: DashboardV2['branchTable'][number]) => r.avgBillInPaise ?? r.avgTicketInPaise;
  const sum = (f: (r: DashboardV2['branchTable'][number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const [sort, setSort] = useState<BranchSort>('collected');
  // Largest first, except TAT where fastest first is the natural read.
  const [desc, setDesc] = useState(true);
  const pickSort = (k: BranchSort) => {
    if (k === sort) setDesc((d) => !d);
    else { setSort(k); setDesc(k !== 'tat'); }
  };
  const keyOf = (r: DashboardV2['branchTable'][number]): number => {
    switch (sort) {
      case 'delta': return r.deltaPercent ?? -Infinity;
      case 'visits': return r.visitCount;
      case 'avg': return avgOf(r) ?? -Infinity;
      case 'net': return r.netInPaise;
      case 'tat': return (r.tatSampleCount ?? 0) >= TAT_MIN_SAMPLES ? r.tatP50Minutes ?? -Infinity : -Infinity;
      default: return r.collectedInPaise;
    }
  };
  const sorted = [...rows].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    // Rows with nothing to compare stay at the bottom either way.
    if (ka === -Infinity || kb === -Infinity) return ka === kb ? 0 : ka === -Infinity ? 1 : -1;
    return desc ? kb - ka : ka - kb;
  });
  const head = (k: BranchSort, label: string) => (
    <th className="py-2 text-right" aria-sort={sort === k ? (desc ? 'descending' : 'ascending') : undefined}>
      <button
        onClick={() => pickSort(k)}
        style={{
          ...TH,
          color: sort === k ? TOKENS.textPrimary : TOKENS.textTertiary,
          fontWeight: sort === k ? 500 : 400,
          background: 'transparent',
          border: 0,
          padding: 0,
          cursor: 'pointer',
        }}
      >
        {label}
        {sort === k ? (desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );

  return (
    <div id="branch-performance" className="h-full">
      <SectionCard
        label={`Branches · ${periodLabel}`}
        description="Click a branch to see the whole dashboard for it"
        className="h-full"
      >
        {rows.length === 0 ? (
          <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No branches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  <th className="py-2" style={TH}>Branch</th>
                  {head('collected', 'Net collected')}
                  <th className="py-2 text-right" style={TH}>Trend</th>
                  {head('delta', 'vs before')}
                  {head('visits', 'Visits')}
                  {head('avg', 'Per visit')}
                  {head('net', 'Net to you')}
                  {head('tat', 'TAT p50')}
                </tr>
              </thead>
              <tbody>
                {sorted.map((r) => {
                  const dormant = r.daysDormant > 0;
                  return (
                    <tr
                      key={r.branchId}
                      onClick={() => onPickBranch(r.branchId)}
                      className="hover:bg-slate-50"
                      style={{
                        ...ROW,
                        background: dormant ? '#FCEBEB30' : undefined,
                        cursor: 'pointer',
                      }}
                    >
                      <td className="py-2">
                        <button
                          onClick={(e) => { e.stopPropagation(); onPickBranch(r.branchId); }}
                          style={{ color: TOKENS.info, background: 'transparent', border: 0, padding: 0, cursor: 'pointer', textAlign: 'left' }}
                        >
                          {r.branchName}{' '}
                          <span style={{ color: TOKENS.textTertiary }}>({r.branchCode})</span>
                        </button>
                        {dormant && (
                          <span style={{ color: TOKENS.caution, marginLeft: 6 }}>dormant {r.daysDormant}d</span>
                        )}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                        {formatRupees(r.collectedInPaise, { short: true })}
                      </td>
                      <td className="py-2">
                        <div className="flex justify-end">
                          <Sparkline values={r.collectedDaily} width={88} height={20} />
                        </div>
                      </td>
                      <td className="py-2 text-right">
                        <Delta pct={r.deltaPercent} />
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                        {r.visitCount.toLocaleString('en-IN')}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                        {avgOf(r) != null ? rupeesWhole(avgOf(r)!) : '—'}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                        {formatRupees(r.netInPaise, { short: true })}
                      </td>
                      <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                        {r.tatP50Minutes !== null && (r.tatSampleCount ?? TAT_MIN_SAMPLES) >= TAT_MIN_SAMPLES ? (
                          duration(r.tatP50Minutes)
                        ) : (
                          <span title={`Fewer than ${TAT_MIN_SAMPLES} finalized reports in this window`} style={{ color: TOKENS.textTertiary }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {rows.length > 1 && (
                <tfoot>
                  <tr className="font-medium" style={{ ...TOTAL_ROW, color: TOKENS.textPrimary }}>
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right">{formatRupees(sum((r) => r.collectedInPaise), { short: true })}</td>
                    <td />
                    <td className="py-2 text-right"><Delta pct={collectedDelta} /></td>
                    <td className="py-2 text-right">{sum((r) => r.visitCount).toLocaleString('en-IN')}</td>
                    <td className="py-2 text-right">{perVisit != null ? rupeesWhole(perVisit) : '—'}</td>
                    <td className="py-2 text-right">{formatRupees(sum((r) => r.netInPaise), { short: true })}</td>
                    <td />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

// ----- skeleton ---------------------------------------------------------

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-12" />
      <Skeleton className="h-10" />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Skeleton className="h-64" />
        </div>
        <div className="lg:col-span-2">
          <Skeleton className="h-64" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
    </div>
  );
}

// ----- main page -------------------------------------------------------

// Full date-filter set, matching the Money and Payouts pages. Scopes the
// period zone (money summary, revenue trend/mix, branch table).
const DASH_PERIOD_OPTS: PeriodKey[] = [
  'today',
  'yesterday',
  '7d',
  '30d',
  'mtd',
  'ytd',
  'custom',
];

function todayKey(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default function OwnerDashboardV2() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const [metric, setMetric] = useState<MetricKey>('collected');
  const branchValue = searchParams.get('branch') || 'all';
  const rawPeriod = searchParams.get('period');
  const period: PeriodKey = DASH_PERIOD_OPTS.includes(rawPeriod as PeriodKey)
    ? (rawPeriod as PeriodKey)
    : '30d';
  const customStart = searchParams.get('start') || '';
  const customEnd = searchParams.get('end') || '';
  const customReady = period === 'custom' && Boolean(customStart) && Boolean(customEnd);
  const periodLabel = period === 'custom' ? `${customStart} – ${customEnd}` : PERIOD_LABEL[period];
  const domain = domainFromParam(searchParams.get('domain'));

  const setBranchValue = (newBranch: string) => {
    setSearchParams(prev => {
      prev.set('branch', newBranch);
      return prev;
    });
  };

  const setDomain = (next: DomainKey) => {
    setSearchParams(prev => {
      prev.delete('clinic'); // pre-?domain= links
      if (next === 'diagnostics') prev.delete('domain');
      else prev.set('domain', next);
      return prev;
    });
  };

  const setPeriod = (next: PeriodKey) => {
    setSearchParams(prev => {
      prev.set('period', next);
      if (next === 'custom') {
        if (!prev.get('start')) prev.set('start', todayKey());
        if (!prev.get('end')) prev.set('end', todayKey());
      } else {
        prev.delete('start');
        prev.delete('end');
      }
      return prev;
    });
  };

  const setCustomRange = (r: { start: string; end: string }) => {
    setSearchParams(prev => {
      prev.set('period', 'custom');
      if (r.start) prev.set('start', r.start);
      if (r.end) prev.set('end', r.end);
      return prev;
    });
  };

  const dashParams =
    (period === 'custom'
      ? `period=custom&start=${customStart}&end=${customEnd}&branch=${encodeURIComponent(branchValue)}`
      : `period=${period}&branch=${encodeURIComponent(branchValue)}`) + `&domain=${domain}`;

  const query = useQuery<DashboardV2>({
    queryKey: ['owner-dashboard-v2', period, branchValue, customStart, customEnd, domain],
    queryFn: () => apiRequest<DashboardV2>(`${API_BASE}/owner/dashboard-v2?${dashParams}`),
    enabled: period !== 'custom' || customReady,
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60 * 1000,
  });

  const data = query.data;
  // The trend covers the whole window unless it was capped (long windows); only
  // then is the prior window adjacent to it, so averages can be seeded from it.
  const adjacent = Boolean(
    data &&
      data.trend.length ===
        Math.round((Date.parse(data.period.endIso) - Date.parse(data.period.startIso)) / 86_400_000),
  );
  const baselineBanner = useMemo(() => {
    if (!data) return null;
    if (data.dataAge.daysSinceLaunch < 7) {
      return `Baseline forming — comparisons available after ${7 - data.dataAge.daysSinceLaunch} more days of activity.`;
    }
    if (data.dataAge.daysSinceLaunch < 30) {
      return `Week-over-week comparisons only · 30-day baseline available in ${30 - data.dataAge.daysSinceLaunch} days.`;
    }
    return null;
  }, [data]);

  return (
    <AppLayout context="owner" hideContextBanner>
      <div
        className="mx-auto"
        style={{ maxWidth: 1440, color: TOKENS.textPrimary, background: TOKENS.page }}
      >
        {/* Header strip */}
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-medium" style={{ fontSize: 20 }}>
              Owner overview
            </h1>
            <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>
              {data
                ? `${formatIstDateTime(data.generatedAt)} · ${
                    data.branchScope.branchName ?? 'all branches'
                  }`
                : 'Loading…'}
            </div>
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            <PeriodFilter
              value={period}
              onChange={setPeriod}
              options={DASH_PERIOD_OPTS}
              customRange={{ start: customStart || todayKey(), end: customEnd || todayKey() }}
              onCustomRangeChange={setCustomRange}
            />
            <BranchFilter value={branchValue} onChange={setBranchValue} />
            <DomainFilter value={domain} onChange={setDomain} />
            <RefreshButton
              isFetching={query.isFetching}
              onClick={() => query.refetch()}
            />
          </div>
        </div>

        {baselineBanner && (
          <div
            className="mb-4 px-3 py-2"
            style={{
              border: `0.5px solid ${TOKENS.border}`,
              background: '#FFF8E1',
              borderRadius: 8,
              fontSize: 12,
              color: TOKENS.caution,
            }}
          >
            {baselineBanner}
          </div>
        )}

        {query.isLoading && <DashboardSkeleton />}

        {query.isError && <ErrorCard onRetry={() => query.refetch()} />}

        {data && (
          <div className="space-y-4">
            <div>
              <GroupLabel>Needs attention · live</GroupLabel>
              <ActionQueue chips={data.actionQueue} />
            </div>

            <KpiRow data={data} metric={metric} onMetric={setMetric} adjacent={adjacent} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="lg:col-span-8">
                <TrendCard
                  data={data}
                  metric={metric}
                  periodLabel={periodLabel}
                  adjacent={adjacent}
                  onPickDay={(d) =>
                    navigate(`/money/cash?period=custom&start=${d}&end=${d}&branch=${encodeURIComponent(branchValue)}&domain=${domain}`)
                  }
                />
              </div>
              <div className="lg:col-span-4">
                <MoneyCard data={data} periodLabel={periodLabel} moneyHref={`/money/cash?${dashParams}`} />
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
              <div className="lg:col-span-5">
                <DepartmentsCard data={data} periodLabel={periodLabel} />
              </div>
              <div className="lg:col-span-7">
                <DoctorsCard
                  data={data}
                  periodLabel={periodLabel}
                  onPickReferrer={(id) => {
                    // The window in IST calendar days; endIso is exclusive.
                    const day = (ms: number) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
                    const from = day(Date.parse(data.period.startIso));
                    const to = day(Date.parse(data.period.endIso) - 1);
                    navigate(`/owner/payouts/REFERRAL.${id}?from=${from}&to=${to}`);
                  }}
                />
              </div>
            </div>

            <BranchTableCard
              rows={data.branchTable}
              periodLabel={periodLabel}
              onPickBranch={setBranchValue}
              perVisit={metricValue(METRICS.perVisit, totalsPoint(data.kpis.current))}
              collectedDelta={data.moneyToday.collectedDeltaPercent}
            />

            <div>
              <GroupLabel>Today · live</GroupLabel>
              <OpsPulseRow data={data.opsPulse} />
            </div>

            <div>
              <GroupLabel>Patients · {periodLabel}</GroupLabel>
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
                <div className="lg:col-span-4">
                  <SourcesCard data={data} periodLabel={periodLabel} />
                </div>
                {data.busyHours && (
                  <div className="lg:col-span-8">
                    <BusyHoursCard cells={data.busyHours} periodLabel={periodLabel} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
