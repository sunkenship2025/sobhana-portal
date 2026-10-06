/**
 * Owner dashboard — decision-first redesign.
 *
 * Backed by GET /api/owner/dashboard-v2. A global period slicer scopes the
 * "period zone" (money summary, revenue trend/mix, branch table). The action
 * queue, unsettled payouts, open receivables and ops pulse are current-state
 * ("live") and deliberately ignore the slicer — they answer "what needs my
 * decision right now?" regardless of the reporting window.
 *
 * Sections, top to bottom:
 *   - Header strip                 — title, IST timestamp, period + branch filters
 *   - Action queue                 — live chips, conditional
 *   - Money (period) + Payouts (period headline, live unsettled)  (60/40 split)
 *   - Diagnostics / clinic / comms 3-tile pulse (live/today)
 *   - Net collected trend + revenue mix (period)
 *
 * Money figures follow the All / Diagnostic / OP switch (?domain=, Diagnostic by
 * default, same control as the Money page); ops pulse and the payout ledger
 * always cover both.
 *   - Branch performance table (period, Δ vs prior window)
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Clock, Info } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import { KpiTile, ComparisonTrendChart, Sparkline, VarianceBridge, ShareBar, SERIES } from './_shared/dashboardCharts';
import {
  TOKENS,
  SectionCard,
  StatRow,
  MiniBar,
  DisplayNumber,
  SectionLabel,
  BranchFilter,
  PeriodFilter,
  PeriodKey,
  PERIOD_LABEL,
  formatIstDateTime,
  ErrorCard,
  RefreshButton,
  DeltaPercent,
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
  categoryMoves: { category: string; current: number; prior: number; tests: number; priorTests: number }[];
  sources: { source: 'referred' | 'walkin' | 'partner' | 'clinic'; visits: number; gross: number; priorVisits: number; priorGross: number }[];
  referrers: { referralDoctorId: string; name: string; visits: number; billed: number; commission: number; priorVisits: number; priorBilled: number }[];
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
  netCollected: number;
  net: number;
  visits: number;
  gross: number;
  bills: number;
  discount: number;
}

// ----- metrics: one definition feeds the KPI tile, its delta and the trend --

type MetricKey = 'collected' | 'net' | 'visits' | 'avgBill' | 'discount';
interface Metric {
  label: string;
  title: string;
  num: (p: DayPoint) => number;
  den?: (p: DayPoint) => number; // ratio metrics: averaged as Σnum / Σden
  scale?: number;
  format: (v: number) => string;
  axis: (v: number) => string;
  goodWhenUp: boolean;
}
const rupeesShort = (p: number) => formatRupees(p, { short: true });
// Whole rupees: paise on a summary tile is noise.
const rupeesWhole = (p: number) => formatRupees(Math.round(p / 100) * 100);
const METRICS: Record<MetricKey, Metric> = {
  collected: {
    label: 'Net collected',
    title: 'Net collected per day',
    num: (p) => p.collected,
    format: rupeesWhole,
    axis: rupeesShort,
    goodWhenUp: true,
  },
  net: {
    label: 'Net to you',
    title: 'Net to you per day (billed, after discounts & commission)',
    num: (p) => p.net,
    format: rupeesWhole,
    axis: rupeesShort,
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
  avgBill: {
    label: 'Avg bill (gross)',
    title: 'Average bill per day (gross ÷ bills)',
    num: (p) => p.gross,
    den: (p) => p.bills,
    format: rupeesWhole,
    axis: rupeesShort,
    goodWhenUp: true,
  },
  discount: {
    label: 'Discounts',
    title: 'Discount as % of gross, per day',
    num: (p) => p.discount,
    den: (p) => p.gross,
    scale: 100,
    format: (v) => `${v.toFixed(1)}%`,
    axis: (v) => `${Math.round(v)}%`,
    goodWhenUp: false,
  },
};
const METRIC_ORDER: MetricKey[] = ['collected', 'net', 'visits', 'avgBill', 'discount'];

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
  return d > 0 ? (m.num(p) / d) * (m.scale ?? 1) : null;
}
/** Trailing 7-day value at each point: Σnum / 7 for flows, Σnum / Σden for ratios. */
function rolling7(m: Metric, series: DayPoint[]): (number | null)[] {
  return series.map((_, i) => {
    if (i < 6) return null;
    const w = series.slice(i - 6, i + 1);
    const num = w.reduce((s, p) => s + m.num(p), 0);
    if (!m.den) return num / 7;
    const den = w.reduce((s, p) => s + m.den!(p), 0);
    return den > 0 ? (num / den) * (m.scale ?? 1) : null;
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

// ----- money today waterfall -------------------------------------------

function MoneyTodayCard({
  data,
  periodLabel,
}: {
  data: DashboardV2['moneyToday'];
  periodLabel: string;
}) {
  const gross = Math.max(0, data.grossInPaise);
  // proportional widths against gross; if gross = 0, fall back to flat zero bars
  const widthFor = (v: number) => (gross > 0 ? Math.max(0, v / gross) : 0);

  return (
    <SectionCard
      label={`Money · ${periodLabel}`}
      description="What came in, and where the billed amount went"
    >
      <SectionLabel>Collected</SectionLabel>
      <div className="mt-2 grid grid-cols-3 gap-2" style={{ fontSize: 12 }}>
        <Link
          to="/money/cash?date=today"
          style={{ color: TOKENS.textSecondary, textDecoration: 'none' }}
        >
          <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Cash</div>
          <div className="font-medium" style={{ color: TOKENS.textPrimary }}>
            {rupeesWhole(data.cashInPaise)}
          </div>
        </Link>
        <Link
          to="/money/cash?date=today&type=online"
          style={{ color: TOKENS.textSecondary, textDecoration: 'none' }}
        >
          <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Online</div>
          <div className="font-medium" style={{ color: TOKENS.textPrimary }}>
            {rupeesWhole(data.onlineInPaise)}
          </div>
        </Link>
        <div>
          <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Refunds paid out</div>
          <div
            className="font-medium"
            style={{ color: data.refundInPaise > 0 ? TOKENS.discount : TOKENS.textPrimary }}
          >
            {data.refundInPaise > 0 ? '−' : ''}
            {rupeesWhole(data.refundInPaise)}
          </div>
        </div>
      </div>

      <div className="mt-4 border-t pt-3" style={{ borderColor: TOKENS.border }}>
        <SectionLabel>Billed ({periodLabel}, accrual)</SectionLabel>
        <div style={{ color: TOKENS.textTertiary, fontSize: 11 }} className="mt-0.5">
          Billed differs from collected — patients pay across days.
        </div>
        <div className="mt-2 space-y-2">
          <WaterfallRow
            label="Gross billed"
            value={data.grossInPaise}
            ratio={widthFor(data.grossInPaise)}
            color={TOKENS.gross}
            isBaseline
          />
          <WaterfallRow
            label="Discounts"
            value={-data.discountInPaise}
            ratio={widthFor(data.discountInPaise)}
            color={TOKENS.discount}
            note={data.grossInPaise > 0 ? `(${((data.discountInPaise / data.grossInPaise) * 100).toFixed(1)}% of gross)` : undefined}
            noteCaution={data.grossInPaise > 0 && data.discountInPaise / data.grossInPaise > 0.15}
          />
          {data.reversedInPaise > 0 && (
            <WaterfallRow
              label="Cancellations"
              value={-data.reversedInPaise}
              ratio={widthFor(data.reversedInPaise)}
              color={TOKENS.discount}
            />
          )}
          <WaterfallRow
            label="Commission accrued"
            value={-data.commissionInPaise}
            ratio={widthFor(data.commissionInPaise)}
            color={TOKENS.commissionBar}
          />
          <WaterfallRow
            label="Net to you"
            value={data.netInPaise}
            ratio={widthFor(data.netInPaise)}
            color={TOKENS.net}
            emphasize
            note={
              data.deltaPercent !== null
                ? `(${data.deltaPercent >= 0 ? '+' : ''}${data.deltaPercent}% vs prior)`
                : undefined
            }
          />
        </div>
      </div>
    </SectionCard>
  );
}

function WaterfallRow({
  label,
  value,
  ratio,
  color,
  emphasize,
  note,
  noteCaution,
  isBaseline,
}: {
  label: string;
  value: number;
  ratio: number;
  color: string;
  emphasize?: boolean;
  note?: string;
  noteCaution?: boolean;
  isBaseline?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  // The bar length encodes share-of-gross but only Discounts ever spells it out.
  // On hover the rest reveal theirs in the SAME note slot Discounts already
  // uses — no floating tooltip, no new visual vocabulary.
  const sharePct = Math.round(ratio * 100);
  const revealed =
    hovered && !note ? (isBaseline ? 'baseline for the bars below' : `(${sharePct}% of gross)`) : null;

  const enter = () => setHovered(true);
  const leave = () => setHovered(false);

  return (
    <div
      tabIndex={0}
      aria-label={`${label}: ${value < 0 ? 'minus ' : ''}${formatRupees(Math.abs(value))}${
        isBaseline ? '' : `, ${sharePct} percent of gross billed`
      }`}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={enter}
      onBlur={leave}
      className="rounded focus-visible:ring-2 focus-visible:ring-blue-300"
      style={{ outline: 'none', cursor: 'default' }}
    >
      <div
        className="mb-1 flex items-baseline justify-between"
        style={{ fontSize: 12 }}
      >
        <span style={{ color: TOKENS.textSecondary }}>
          {label}
          {(note || revealed) && (
            <span
              className="ml-1.5"
              style={{ color: noteCaution ? TOKENS.caution : TOKENS.textTertiary }}
            >
              {note ?? revealed}
            </span>
          )}
        </span>
        <span
          className={emphasize ? 'font-medium' : ''}
          style={{ color: TOKENS.textPrimary }}
        >
          {value < 0 ? '−' : ''}
          {rupeesWhole(Math.abs(value))}
        </span>
      </div>
      <MiniBar fillRatio={ratio} color={color} highlight={hovered} />
    </div>
  );
}

// ----- payouts ----------------------------------------------------------

/**
 * Headline follows the date filter; the per-payee split is accrued-to-date.
 *
 * The card used to carry a settlement ladder — total unsettled, to review,
 * approved-awaiting-settlement. Payouts are not settled through this system,
 * they are only checked here, so `reviewedAt` was never once set in 1,472
 * ledger rows: "to review" always equalled the total and "approved, awaiting
 * settlement" was a permanent zero. Two of the three rows carried no
 * information. What is left is the question the screen can actually answer —
 * how much commission accrued, and to whom.
 */
function PayoutsCard({
  data,
  money,
  periodLabel,
}: {
  data: DashboardV2['payoutLiability'];
  money: DashboardV2['moneyToday'];
  periodLabel: string;
}) {
  return (
    <SectionCard
      label={`Payouts · ${periodLabel}`}
      rightSlot={
        <Link
          to="/owner/payouts"
          style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}
        >
          open ↗
        </Link>
      }
    >
      <DisplayNumber>{formatRupees(money.commissionInPaise)}</DisplayNumber>
      <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
        Commission accrued to doctors &amp; centres ({periodLabel})
      </div>
      <div className="mt-4">
        {/* Accrued to date, not the window above — say so, or it reads as the
            headline's breakdown. */}
        <SectionLabel>By payee · accrued to date</SectionLabel>
        <div className="mt-2 space-y-2">
          <StatRow
            label="Referral doctors"
            value={formatRupees(data.byType.referralInPaise)}
          />
          <StatRow
            label="Clinic doctors"
            value={formatRupees(data.byType.clinicInPaise)}
          />
          <StatRow
            label="Partners"
            value={formatRupees(data.byType.partnerInPaise)}
          />
        </div>
      </div>
    </SectionCard>
  );
}

// ----- ops pulse 3-tile -------------------------------------------------

function OpsPulseRow({ data }: { data: DashboardV2['opsPulse'] }) {
  const { diagnostics, clinic, comms } = data;
  const tatNote = diagnostics.tatSampleCount >= 4
    ? `Reg→report p50 ${Math.round(diagnostics.tatP50Minutes ?? 0)}m · p95 ${Math.round(diagnostics.tatP95Minutes ?? 0)}m · ${diagnostics.tatBreachCount} over 24h`
    : `TAT — baseline forming · ${diagnostics.tatSampleCount}/4 samples`;

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
        <StatRow label="Orders today" value={diagnostics.ordersToday} />
        <StatRow label="Finalized" value={diagnostics.finalizedToday} />
        <StatRow label="In progress" value={diagnostics.inProgress} />
        <StatRow
          label="Pending sample"
          value={diagnostics.pendingSample}
          emphasize={diagnostics.pendingSample > 0 ? 'caution' : undefined}
        />
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
          {` · Revisits ${clinic.revisitsToday}${
            Number.isFinite(clinic.revisitRatePct) ? ` · ${clinic.revisitRatePct}% revisit rate` : ''
          }`}
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
        <StatRow label="Sent" value={comms.sent} />
        <StatRow
          label="Delivered"
          value={comms.delivered}
          emphasize={comms.delivered > 0 ? 'healthy' : undefined}
        />
        <StatRow label="Read" value={comms.read} />
        <StatRow
          label="Failed"
          value={comms.failed}
          emphasize={comms.failed > 0 ? 'critical' : undefined}
        />
        <div
          className="mt-3 border-t pt-2"
          style={{ borderColor: TOKENS.border, color: TOKENS.textTertiary, fontSize: 11 }}
        >
          {comms.optInPercent !== null
            ? `Opt-in ${comms.optInPercent}% · target 80%`
            : 'No visits today'}
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
          if (m.den && m.scale) {
            const pts = now - before; // a rate moves in points, not percent
            delta = { text: `${Math.abs(pts).toFixed(1)} pts`, up: pts >= 0 };
          } else {
            const pct = Math.round(((now - before) / Math.abs(before)) * 100);
            delta = { text: `${Math.abs(pct)}%`, up: pct >= 0 };
          }
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
          label="Open dues · all-time"
          value={formatRupees(data.kpis.current.outstanding)}
          delta={null}
          footnote="unpaid across all bills · open ↗"
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
      description={capped ? `Last ${data.trend.length} days of the window · click any tile above to chart it` : 'Click any tile above to chart it'}
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
      />
    </SectionCard>
  );
}

// ----- revenue mix today ------------------------------------------------

function RevenueMixCard({
  mix,
  periodLabel,
}: {
  mix: DashboardV2['revenueMix'];
  periodLabel: string;
}) {
  const total = Math.max(1, mix.totalInPaise);
  const segs = [
    { label: 'Reportable diagnostics', value: mix.reportableInPaise, color: TOKENS.reportable },
    { label: 'Clinic consultations', value: mix.clinicInPaise, color: TOKENS.clinic },
    { label: 'Bill-only / external', value: mix.billOnlyInPaise, color: TOKENS.billOnly },
  ];
  // Hovering a segment or its legend row highlights the other — a thin segment
  // (clinic is often ~8%) is hard to aim at, so the row is a hit target too.
  const [activeSeg, setActiveSeg] = useState<string | null>(null);

  return (
    <SectionCard
      label={`Revenue mix · ${periodLabel}`}
      description="Category split of gross for the selected window — before discounts"
      rightSlot={
        <span
          style={{
            background: `${TOKENS.gross}33`,
            color: TOKENS.textSecondary,
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}
        >
          gross · pre-discount
        </span>
      }
    >
      {mix.totalInPaise === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No bills in this window.</div>
      ) : (
        <>
          <div
            className="mb-3 flex items-baseline justify-between border-b pb-3"
            style={{ borderColor: TOKENS.border }}
          >
            <span style={{ color: TOKENS.textSecondary, fontSize: 12 }}>
              Total gross · {periodLabel}
            </span>
            <DisplayNumber size={18}>{formatRupees(mix.totalInPaise)}</DisplayNumber>
          </div>
          <div className="relative">
            <div
              className="flex w-full overflow-hidden"
              style={{ height: 18, borderRadius: 3 }}
              onMouseLeave={() => setActiveSeg(null)}
            >
              {segs.map((s) => {
                const isActive = activeSeg === s.label;
                const dimmed = activeSeg != null && !isActive;
                return (
                  <div
                    key={s.label}
                    tabIndex={0}
                    aria-label={`${s.label}: ${formatRupees(s.value)}, ${Math.round(
                      (s.value / total) * 100
                    )} percent of gross`}
                    onMouseEnter={() => setActiveSeg(s.label)}
                    onFocus={() => setActiveSeg(s.label)}
                    onBlur={() => setActiveSeg(null)}
                    style={{
                      width: `${(s.value / total) * 100}%`,
                      background: s.color,
                      opacity: dimmed ? 0.45 : 1,
                      transition: 'opacity 120ms ease',
                      cursor: 'default',
                      outline: 'none',
                    }}
                  />
                );
              })}
            </div>
            {(() => {
              if (!activeSeg) return null;
              const i = segs.findIndex((x) => x.label === activeSeg);
              const s = segs[i];
              // centre the readout over the hovered segment, clamped so it can't
              // run off either end of the card
              const before = segs.slice(0, i).reduce((a, x) => a + x.value, 0);
              const centerPct = ((before + s.value / 2) / total) * 100;
              return (
                <div
                  role="status"
                  aria-live="polite"
                  style={{
                    position: 'absolute',
                    // above the bar: the legend below is the thing being
                    // cross-highlighted, so keep the box off it
                    top: -32,
                    left: `${Math.min(85, Math.max(15, centerPct))}%`,
                    transform: 'translateX(-50%)',
                    pointerEvents: 'none',
                    zIndex: 1,
                    background: TOKENS.surface,
                    border: `1px solid ${TOKENS.border}`,
                    borderRadius: 4,
                    boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
                    padding: '4px 8px',
                    fontSize: 12,
                    color: TOKENS.textPrimary,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {`${formatRupees(s.value)} · ${Math.round((s.value / total) * 100)}% — ${s.label}`}
                </div>
              );
            })()}
          </div>
          <div className="mt-3 space-y-1.5">
            {segs.map((s) => {
              const pct = Math.round((s.value / total) * 100);
              return (
                <div
                  key={s.label}
                  className="flex items-baseline justify-between"
                  style={{
                    fontSize: 12,
                    // negative margin keeps the row flush while giving the wash
                    // some breathing room, so nothing shifts on hover
                    margin: '0 -6px',
                    padding: '2px 6px',
                    borderRadius: 3,
                    background: activeSeg === s.label ? TOKENS.page : 'transparent',
                    opacity: activeSeg != null && activeSeg !== s.label ? 0.55 : 1,
                    transition: 'background 120ms ease, opacity 120ms ease',
                  }}
                  onMouseEnter={() => setActiveSeg(s.label)}
                  onMouseLeave={() => setActiveSeg(null)}
                >
                  <span className="flex items-center gap-2">
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: s.color,
                        display: 'inline-block',
                      }}
                    />
                    <span style={{ color: TOKENS.textSecondary }}>{s.label}</span>
                  </span>
                  <span style={{ color: TOKENS.textPrimary }}>
                    {formatRupees(s.value)} · {pct}%
                  </span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </SectionCard>
  );
}

// ----- what moved + where the business comes from -----------------------

function WhatMovedCard({ moves, periodLabel }: { moves: DashboardV2['categoryMoves']; periodLabel: string }) {
  const priorTotal = moves.reduce((s, m) => s + m.prior, 0);
  // Fold categories too small to read into one "Other" bar.
  const small = (m: (typeof moves)[number]) =>
    Math.abs(m.current - m.prior) < priorTotal * 0.01 && m.current < priorTotal * 0.03;
  const rows = moves.filter((m) => !small(m)).map((m) => ({ key: m.category, prior: m.prior, current: m.current, m }));
  const rest = moves.filter(small);
  if (rest.length) {
    rows.push({
      key: 'Other',
      prior: rest.reduce((s, m) => s + m.prior, 0),
      current: rest.reduce((s, m) => s + m.current, 0),
      m: { category: 'Other', current: 0, prior: 0, tests: rest.reduce((s, m) => s + m.tests, 0), priorTests: rest.reduce((s, m) => s + m.priorTests, 0) },
    });
  }
  return (
    <SectionCard
      label={`What moved · ${periodLabel}`}
      description="Billed by test category, against the prior period · biggest gain first"
    >
      {moves.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No tests billed in this window.</div>
      ) : (
        <VarianceBridge
          rows={rows}
          priorLabel="Prior period"
          currentLabel="This period"
          format={(v) => formatRupees(v, { short: true })}
          detail={(r) => {
            const m = rows.find((x) => x.key === r.key)?.m;
            return m ? `${m.tests.toLocaleString('en-IN')} tests now · ${m.priorTests.toLocaleString('en-IN')} before` : '';
          }}
        />
      )}
    </SectionCard>
  );
}

const SOURCE_META: Record<DashboardV2['sources'][number]['source'], { label: string; color: string }> = {
  referred: { label: 'Referred by a doctor', color: SERIES[0] },
  walkin: { label: 'Walk-in', color: SERIES[1] },
  partner: { label: 'Through a partner', color: SERIES[2] },
  clinic: { label: 'OP consultation', color: SERIES[3] },
};
const changeText = (now: number, before: number) =>
  before > 0 ? `${now >= before ? '▲' : '▼'} ${Math.abs(Math.round(((now - before) / before) * 100))}%` : 'new';

function SourcesCard({ data, periodLabel }: { data: DashboardV2; periodLabel: string }) {
  const order: DashboardV2['sources'][number]['source'][] = ['referred', 'walkin', 'partner', 'clinic'];
  const parts = order
    .map((k) => data.sources.find((s) => s.source === k))
    .filter((s): s is DashboardV2['sources'][number] => Boolean(s))
    .map((s) => ({
      key: s.source,
      label: SOURCE_META[s.source].label,
      color: SOURCE_META[s.source].color,
      value: s.gross,
      note: `${formatRupees(s.gross, { short: true })} · ${s.visits.toLocaleString('en-IN')} bills · ${changeText(s.gross, s.priorGross)}`,
    }));
  return (
    <SectionCard
      label={`Where the business comes from · ${periodLabel}`}
      description="Share of gross billed, and the doctors who send the most"
    >
      {parts.length === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No bills in this window.</div>
      ) : (
        <ShareBar parts={parts} />
      )}
      {data.referrers.length > 0 && (
        <table className="mt-4 w-full" style={{ fontSize: 12 }}>
          <thead>
            <tr style={{ color: TOKENS.textTertiary }}>
              <th className="py-1.5 text-left" style={{ fontWeight: 400 }}>Top referrers</th>
              <th className="py-1.5 text-right" style={{ fontWeight: 400 }}>Billed</th>
              <th className="py-1.5 text-right" style={{ fontWeight: 400 }}>vs prior</th>
              <th className="py-1.5 text-right" style={{ fontWeight: 400 }} title="Commission ÷ billed: what the relationship costs">Commission</th>
            </tr>
          </thead>
          <tbody>
            {data.referrers.map((r) => {
              const falling = r.priorBilled > 0 && r.billed < r.priorBilled * 0.8;
              return (
                <tr key={r.referralDoctorId} style={{ borderTop: `0.5px solid ${TOKENS.border}` }}>
                  <td className="py-2" style={{ color: TOKENS.textPrimary }}>
                    {r.name.replace(/\s{2,}.*$/, '')}
                    <span style={{ color: TOKENS.textTertiary }}> · {r.visits} visits</span>
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>{formatRupees(r.billed, { short: true })}</td>
                  <td className="py-2 text-right" style={{ color: falling ? TOKENS.critical : r.billed >= r.priorBilled ? TOKENS.healthy : TOKENS.textSecondary }}>
                    {changeText(r.billed, r.priorBilled)}
                  </td>
                  <td className="py-2 text-right" style={{ color: TOKENS.textPrimary }}>
                    {formatRupees(r.commission, { short: true })}
                    <span style={{ color: TOKENS.textTertiary }}> · {r.billed > 0 ? Math.round((r.commission / r.billed) * 100) : 0}%</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
}: {
  rows: DashboardV2['branchTable'];
  periodLabel: string;
  onPickBranch: (branchId: string) => void;
}) {
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
      case 'avg': return r.avgTicketInPaise ?? -Infinity;
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
    <div id="branch-performance">
      <SectionCard
        label="Branches"
        description={`${periodLabel} · click a branch to see the whole dashboard for it`}
      >
        {rows.length === 0 ? (
          <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No branches yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full" style={{ fontSize: 12 }}>
              <thead>
                <tr style={{ color: TOKENS.textTertiary, textAlign: 'left' }}>
                  <th className="py-2" style={{ fontWeight: 400 }}>Branch</th>
                  {head('collected', 'Net collected')}
                  <th className="py-2 text-right" style={{ fontWeight: 400 }}>Trend</th>
                  {head('delta', 'Δ prior')}
                  {head('visits', 'Visits')}
                  {head('avg', 'Avg bill (net)')}
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
                      style={{
                        borderTop: `0.5px solid ${TOKENS.border}`,
                        background: dormant ? '#FCEBEB30' : undefined,
                        cursor: 'pointer',
                      }}
                    >
                      <td className="py-3">
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
                      <td className="py-3 text-right" style={{ color: TOKENS.textPrimary }}>
                        {formatRupees(r.collectedInPaise, { short: true })}
                      </td>
                      <td className="py-3">
                        <div className="flex justify-end">
                          <Sparkline values={r.collectedDaily} width={88} height={20} />
                        </div>
                      </td>
                      <td className="py-3 text-right">
                        <DeltaPercent value={r.deltaPercent} />
                      </td>
                      <td className="py-3 text-right" style={{ color: TOKENS.textPrimary }}>
                        {r.visitCount.toLocaleString('en-IN')}
                      </td>
                      <td className="py-3 text-right" style={{ color: TOKENS.textPrimary }}>
                        {r.avgTicketInPaise !== null ? rupeesWhole(r.avgTicketInPaise) : '—'}
                      </td>
                      <td className="py-3 text-right" style={{ color: TOKENS.textPrimary }}>
                        {formatRupees(r.netInPaise, { short: true })}
                      </td>
                      <td className="py-3 text-right" style={{ color: TOKENS.textPrimary }}>
                        {r.tatP50Minutes !== null && (r.tatSampleCount ?? TAT_MIN_SAMPLES) >= TAT_MIN_SAMPLES ? (
                          `${(r.tatP50Minutes / 60).toFixed(1)}h`
                        ) : (
                          <span title={`Fewer than ${TAT_MIN_SAMPLES} finalized reports in this window`} style={{ color: TOKENS.textTertiary }}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
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
          <div className="flex flex-wrap items-center gap-2">
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
              <div
                className="mb-1.5"
                style={{ color: TOKENS.textTertiary, fontSize: 11, letterSpacing: 0.3, textTransform: 'uppercase' }}
              >
                Needs attention · live (not affected by the date filter)
              </div>
              <ActionQueue chips={data.actionQueue} />
            </div>

            <KpiRow data={data} metric={metric} onMetric={setMetric} adjacent={adjacent} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
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
              <div className="lg:col-span-2">
                <MoneyTodayCard data={data.moneyToday} periodLabel={periodLabel} />
              </div>
            </div>

            {/* sent since phase 2 — a bundle cached before it still renders */}
            {data.categoryMoves && data.sources && (
              <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                <WhatMovedCard moves={data.categoryMoves} periodLabel={periodLabel} />
                <SourcesCard data={data} periodLabel={periodLabel} />
              </div>
            )}

            <BranchTableCard rows={data.branchTable} periodLabel={periodLabel} onPickBranch={setBranchValue} />

            <OpsPulseRow data={data.opsPulse} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <RevenueMixCard mix={data.revenueMix} periodLabel={periodLabel} />
              <PayoutsCard
                data={data.payoutLiability}
                money={data.moneyToday}
                periodLabel={periodLabel}
              />
            </div>
          </div>
        )}
      </div>
    </AppLayout>
  );
}
