/**
 * Owner dashboard — decision-first redesign.
 *
 * Backed by GET /api/owner/dashboard-v2. The page answers exactly one question:
 * "what needs my decision today?" Every section either fires (with a value)
 * or hides itself; nothing is rendered when there is nothing to act on.
 *
 * Sections, top to bottom:
 *   - Header strip                 — title, IST timestamp, branch filter
 *   - Action queue                 — chips, conditional, max 6
 *   - Money today + payout liability  (60/40 split)
 *   - Diagnostics / clinic / comms 3-tile pulse
 *   - 30-day net revenue trend + today's mix
 *   - Branch performance table
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Clock, Info } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { API_BASE } from '@/lib/api';
import { apiRequest } from '@/lib/utils';
import {
  TOKENS,
  SectionCard,
  StatRow,
  MiniBar,
  DisplayNumber,
  SectionLabel,
  BranchFilter,
  formatIstDateTime,
  ErrorCard,
  RefreshButton,
  TrendChart,
  DeltaPercent,
  severityForRatio,
  formatRupees,
} from './_shared/ownerUi';

// ----- types ------------------------------------------------------------

type ActionChipType =
  | 'late_reports'
  | 'unpaid_aged'
  | 'payouts_to_review'
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
  branchScope: { branchId: string | null; branchName: string | null };
  dataAge: { firstVisitAt: string | null; daysSinceLaunch: number };
  actionQueue: ActionChip[];
  moneyToday: {
    grossInPaise: number;
    discountInPaise: number;
    commissionInPaise: number;
    netInPaise: number;
    discountRatePct: number;
    cashInPaise: number;
    onlineInPaise: number;
    collectedTotalInPaise: number;
    outstandingInPaise: number;
    deltaPercent: number | null;
    baselineSamples: number;
  };
  payoutLiability: {
    totalInPaise: number;
    toReviewInPaise: number;
    approvedUnpaidInPaise: number;
    byType: {
      referralInPaise: number;
      clinicInPaise: number;
      diagnosticCenterInPaise: number;
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
  revenueTrend: { date: string; netInPaise: number }[];
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
    deltaPercent: number | null;
    daysDormant: number;
  }[];
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
  // 7 chip types, so the cap of 7 shows them all — no overflow chip.
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

function MoneyTodayCard({ data }: { data: DashboardV2['moneyToday'] }) {
  const gross = Math.max(0, data.grossInPaise);
  // proportional widths against gross; if gross = 0, fall back to flat zero bars
  const widthFor = (v: number) => (gross > 0 ? Math.max(0, v / gross) : 0);

  const showDelta = data.baselineSamples >= 4 && data.deltaPercent !== null;
  const deltaColor =
    data.deltaPercent !== null && data.deltaPercent >= 0
      ? TOKENS.healthy
      : TOKENS.critical;

  return (
    <SectionCard
      label="Money today"
      description="Net revenue · take-home after discounts & commission"
    >
      <div className="flex items-baseline gap-3">
        <DisplayNumber>{formatRupees(data.netInPaise)}</DisplayNumber>
        {showDelta && (
          <span style={{ color: deltaColor, fontSize: 13 }}>
            {data.deltaPercent! >= 0 ? '+' : ''}
            {data.deltaPercent}% vs same-day 4-week avg
          </span>
        )}
        {!showDelta && (
          <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
            baseline forming · {data.baselineSamples} of 4 prior samples
          </span>
        )}
      </div>

      <div className="mt-4">
        <SectionLabel>Billed today (accrual)</SectionLabel>
        <div className="mt-2 space-y-2">
          <WaterfallRow
            label="Gross billed"
            value={data.grossInPaise}
            ratio={widthFor(data.grossInPaise)}
            color={TOKENS.gross}
          />
          <WaterfallRow
            label="Discounts"
            value={-data.discountInPaise}
            ratio={widthFor(data.discountInPaise)}
            color={TOKENS.discount}
            note={Number.isFinite(data.discountRatePct) ? `(${data.discountRatePct}% of gross)` : undefined}
            noteCaution={Number.isFinite(data.discountRatePct) && data.discountRatePct > 15}
          />
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
          />
        </div>
      </div>

      <div className="mt-4 border-t pt-3" style={{ borderColor: TOKENS.border }}>
        <SectionLabel>Collected today</SectionLabel>
        <div style={{ color: TOKENS.textTertiary, fontSize: 11 }} className="mt-0.5">
          Collected may differ from billed — patients pay across days.
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2" style={{ fontSize: 12 }}>
          <Link
            to="/money/cash?date=today"
            style={{ color: TOKENS.textSecondary, textDecoration: 'none' }}
          >
            <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Cash</div>
            <div className="font-medium" style={{ color: TOKENS.textPrimary }}>
              {formatRupees(data.cashInPaise)}
            </div>
          </Link>
          <Link
            to="/money/cash?date=today&type=online"
            style={{ color: TOKENS.textSecondary, textDecoration: 'none' }}
          >
            <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Online</div>
            <div className="font-medium" style={{ color: TOKENS.textPrimary }}>
              {formatRupees(data.onlineInPaise)}
            </div>
          </Link>
          <div>
            <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Total collected</div>
            <div className="font-medium" style={{ color: TOKENS.textPrimary }}>
              {formatRupees(data.collectedTotalInPaise)}
            </div>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// ----- total open receivables (all-time) -------------------------------

function OutstandingTile({ data }: { data: DashboardV2['moneyToday'] }) {
  // Caution only when outstanding is meaningfully large vs today's gross (>10%),
  // not merely > 0 — a small open balance is normal.
  const sev = severityForRatio(data.outstandingInPaise, data.grossInPaise, {
    caution: 0.1,
    critical: 0.1,
  });
  return (
    <SectionCard label="Total open receivables (all-time)">
      <Link to="/money/bills?aging=open" style={{ textDecoration: 'none' }}>
        <DisplayNumber>
          <span style={{ color: sev ? TOKENS.caution : TOKENS.textPrimary }}>
            {formatRupees(data.outstandingInPaise)}
          </span>
        </DisplayNumber>
      </Link>
      <div className="mt-1" style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
        Unpaid balance across all bills · open ↗
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
}: {
  label: string;
  value: number;
  ratio: number;
  color: string;
  emphasize?: boolean;
  note?: string;
  noteCaution?: boolean;
}) {
  return (
    <div>
      <div
        className="mb-1 flex items-baseline justify-between"
        style={{ fontSize: 12 }}
      >
        <span style={{ color: TOKENS.textSecondary }}>
          {label}
          {note && (
            <span
              className="ml-1.5"
              style={{ color: noteCaution ? TOKENS.caution : TOKENS.textTertiary }}
            >
              {note}
            </span>
          )}
        </span>
        <span
          className={emphasize ? 'font-medium' : ''}
          style={{ color: TOKENS.textPrimary }}
        >
          {value < 0 ? '−' : ''}
          {formatRupees(Math.abs(value))}
        </span>
      </div>
      <MiniBar fillRatio={ratio} color={color} />
    </div>
  );
}

// ----- payout liability -------------------------------------------------

function PayoutLiabilityCard({
  data,
}: {
  data: DashboardV2['payoutLiability'];
}) {
  return (
    <SectionCard
      label="Payout liability"
      rightSlot={
        <Link
          to="/owner/payouts"
          style={{ color: TOKENS.info, fontSize: 12, textDecoration: 'none' }}
        >
          open ↗
        </Link>
      }
    >
      <DisplayNumber>{formatRupees(data.totalInPaise)}</DisplayNumber>
      <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
        Total unsettled · awaiting review or payment
      </div>
      <div className="mt-4 space-y-1">
        <StatRow
          label="To review"
          value={formatRupees(data.toReviewInPaise)}
          emphasize={data.toReviewInPaise > 0 ? 'caution' : undefined}
        />
        <StatRow
          label="Approved, awaiting payment"
          value={formatRupees(data.approvedUnpaidInPaise)}
        />
      </div>
      <div
        className="mt-3 space-y-2 border-t pt-3"
        style={{ borderColor: TOKENS.border }}
      >
        <StatRow
          label="Referral doctors"
          value={formatRupees(data.byType.referralInPaise)}
        />
        <StatRow
          label="Clinic doctors"
          value={formatRupees(data.byType.clinicInPaise)}
        />
        <StatRow
          label="External centers"
          value={formatRupees(data.byType.diagnosticCenterInPaise)}
        />
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
        label="Patient comms"
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

// ----- 30d trend (line, no chart lib for phase 1) -----------------------

function RevenueTrendCard({ trend }: { trend: DashboardV2['revenueTrend'] }) {
  const chartData = trend.map((p) => ({ date: p.date, value: p.netInPaise }));
  return (
    <SectionCard
      label="Revenue trend · 30 days"
      description="Daily net revenue · last point is today"
    >
      <TrendChart
        data={chartData}
        valueFormat={(v) => formatRupees(v, { short: true })}
        markLastAsToday
        accent={TOKENS.net}
      />
    </SectionCard>
  );
}

// ----- revenue mix today ------------------------------------------------

function RevenueMixCard({ mix }: { mix: DashboardV2['revenueMix'] }) {
  const total = Math.max(1, mix.totalInPaise);
  const segs = [
    { label: 'Reportable diagnostics', value: mix.reportableInPaise, color: TOKENS.reportable },
    { label: 'Clinic consultations', value: mix.clinicInPaise, color: TOKENS.clinic },
    { label: 'Bill-only / external', value: mix.billOnlyInPaise, color: TOKENS.billOnly },
  ];

  return (
    <SectionCard
      label="Revenue mix · today"
      description="Category split of today's gross — before discounts"
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
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No bills yet today.</div>
      ) : (
        <>
          <div
            className="mb-3 flex items-baseline justify-between border-b pb-3"
            style={{ borderColor: TOKENS.border }}
          >
            <span style={{ color: TOKENS.textSecondary, fontSize: 12 }}>
              Total gross today
            </span>
            <DisplayNumber size={18}>{formatRupees(mix.totalInPaise)}</DisplayNumber>
          </div>
          <div
            className="flex w-full overflow-hidden"
            style={{ height: 18, borderRadius: 3 }}
          >
            {segs.map((s) => (
              <div
                key={s.label}
                style={{
                  width: `${(s.value / total) * 100}%`,
                  background: s.color,
                }}
              />
            ))}
          </div>
          <div className="mt-3 space-y-1.5">
            {segs.map((s) => {
              const pct = Math.round((s.value / total) * 100);
              return (
                <div
                  key={s.label}
                  className="flex items-baseline justify-between"
                  style={{ fontSize: 12 }}
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

// ----- branch table -----------------------------------------------------

function BranchTableCard({ rows }: { rows: DashboardV2['branchTable'] }) {
  if (rows.length === 0) {
    return (
      <div id="branch-performance">
        <SectionCard label="Branch performance" description="Last 30 days · sorted by net">
          <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No branches yet.</div>
        </SectionCard>
      </div>
    );
  }

  return (
    <div id="branch-performance">
    <SectionCard label="Branch performance" description="Last 30 days · sorted by net">
      <div className="overflow-x-auto">
        <table className="w-full" style={{ fontSize: 12 }}>
          <thead>
            <tr
              style={{
                color: TOKENS.textTertiary,
                textAlign: 'left',
                fontWeight: 400,
              }}
            >
              <th className="py-2">Branch</th>
              <th className="py-2 text-right">Net rev</th>
              <th className="py-2 text-right">Visits</th>
              <th className="py-2 text-right">Avg ticket</th>
              <th className="py-2 text-right">Δ 30d</th>
              <th className="py-2 text-right">TAT p50</th>
              <th className="py-2 text-right">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const dormant = r.daysDormant > 0;
              return (
                <tr
                  key={r.branchId}
                  style={{
                    borderTop: `0.5px solid ${TOKENS.border}`,
                    background: dormant ? '#FCEBEB30' : undefined,
                  }}
                >
                  <td className="py-3">
                    <Link
                      to={`/owner?branch=${r.branchId}`}
                      style={{ color: TOKENS.info, textDecoration: 'none' }}
                    >
                      {r.branchName}{' '}
                      <span style={{ color: TOKENS.textTertiary }}>({r.branchCode})</span>
                    </Link>
                  </td>
                  <td className="py-3 text-right">
                    <span style={{ color: TOKENS.textPrimary }}>
                      {formatRupees(r.netInPaise, { short: true })}
                    </span>
                  </td>
                  <td className="py-3 text-right" style={{ color: TOKENS.textPrimary }}>
                    {r.visitCount}
                  </td>
                  <td className="py-3 text-right" style={{ color: TOKENS.textPrimary }}>
                    {r.avgTicketInPaise !== null
                      ? formatRupees(r.avgTicketInPaise)
                      : '—'}
                  </td>
                  <td className="py-3 text-right">
                    <DeltaPercent value={r.deltaPercent} />
                  </td>
                  <td className="py-3 text-right" style={{ color: TOKENS.textPrimary }}>
                    {r.tatP50Minutes !== null ? `${Math.round(r.tatP50Minutes)}m` : '—'}
                  </td>
                  <td
                    className="py-3 text-right"
                    style={{
                      color: dormant ? TOKENS.caution : TOKENS.textTertiary,
                    }}
                  >
                    {dormant ? `dormant ${r.daysDormant}d` : 'active'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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

export default function OwnerDashboardV2() {
  const [searchParams, setSearchParams] = useSearchParams();
  const branchValue = searchParams.get('branch') || 'all';

  const setBranchValue = (newBranch: string) => {
    setSearchParams(prev => {
      prev.set('branch', newBranch);
      return prev;
    });
  };

  const query = useQuery<DashboardV2>({
    queryKey: ['owner-dashboard-v2', branchValue],
    queryFn: () =>
      apiRequest<DashboardV2>(
        `${API_BASE}/owner/dashboard-v2?branch=${encodeURIComponent(branchValue)}`,
      ),
    refetchInterval: 5 * 60 * 1000,
    // Match staleTime to the poll interval so revisiting the page within the
    // window serves the last result instead of visibly refetching (the numbers
    // were "popping in" 1-2s after the shell rendered). The 5-min poll still
    // keeps values fresh in the background.
    staleTime: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  const data = query.data;
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
          <div className="flex items-center gap-2">
            <BranchFilter value={branchValue} onChange={setBranchValue} />
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
            <ActionQueue chips={data.actionQueue} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <MoneyTodayCard data={data.moneyToday} />
              </div>
              <div className="flex flex-col gap-4 lg:col-span-2">
                <PayoutLiabilityCard data={data.payoutLiability} />
                <OutstandingTile data={data.moneyToday} />
              </div>
            </div>

            <OpsPulseRow data={data.opsPulse} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <RevenueTrendCard trend={data.revenueTrend} />
              <RevenueMixCard mix={data.revenueMix} />
            </div>

            <BranchTableCard rows={data.branchTable} />
          </div>
        )}
      </div>
    </AppLayout>
  );
}
