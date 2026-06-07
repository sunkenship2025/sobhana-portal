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
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { AppLayout } from '@/components/layout/AppLayout';
import { Skeleton } from '@/components/ui/skeleton';
import { API_BASE } from '@/lib/api';
import { apiRequest, cn } from '@/lib/utils';
import { useBranchStore } from '@/store/branchStore';

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
    cashInPaise: number;
    onlineInPaise: number;
    outstandingInPaise: number;
    deltaPercent: number | null;
    baselineSamples: number;
  };
  payoutLiability: {
    totalInPaise: number;
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

// ----- design tokens ----------------------------------------------------

const TOKENS = {
  healthy: '#0F6E56',
  caution: '#854F0B',
  cautionLight: '#B7793C',
  critical: '#A32D2D',
  info: '#185FA5',
  textPrimary: '#1F1F1E',
  textSecondary: '#5F5E5A',
  textTertiary: '#888780',
  surface: '#FFFFFF',
  page: '#FAFAF8',
  border: 'rgba(0,0,0,0.08)',
  borderStrong: 'rgba(0,0,0,0.15)',
  // categorical
  reportable: '#378ADD',
  clinic: '#5DCAA5',
  billOnly: '#FAC775',
  cash: '#BA7517',
  online: '#185FA5',
  // waterfall
  gross: '#9DC4ED',
  discount: '#FAC775',
  commissionBar: '#E48A8A',
  net: '#5DCAA5',
};

// ----- formatting -------------------------------------------------------

function formatRupees(paise: number, options?: { short?: boolean }): string {
  const rupees = paise / 100;
  if (options?.short) {
    if (Math.abs(rupees) >= 100000) return `₹${(rupees / 100000).toFixed(1)}L`;
    if (Math.abs(rupees) >= 1000) return `₹${(rupees / 1000).toFixed(1)}k`;
  }
  return `₹${Math.round(rupees).toLocaleString('en-IN')}`;
}

function formatIstDateTime(iso: string): string {
  const d = new Date(iso);
  const dateFmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const timeFmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${dateFmt.format(d)} · ${timeFmt.format(d).toLowerCase()}`;
}

function formatTrendDateLabel(isoDate: string): string {
  // isoDate is YYYY-MM-DD; show DD MMM
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(dt);
}

function severityColor(s: ActionChip['severity']): string {
  if (s === 'high') return TOKENS.critical;
  if (s === 'medium') return TOKENS.caution;
  return TOKENS.textTertiary;
}

// ----- small primitives -------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-medium uppercase"
      style={{
        color: TOKENS.textSecondary,
        fontSize: 11,
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </div>
  );
}

function SectionCard({
  label,
  description,
  rightSlot,
  children,
  className,
}: {
  label?: string;
  description?: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('p-4', className)}
      style={{
        background: TOKENS.surface,
        border: `0.5px solid ${TOKENS.border}`,
        borderRadius: 12,
      }}
    >
      {(label || rightSlot) && (
        <div className="mb-3 flex items-start justify-between gap-3">
          <div>
            {label && <SectionLabel>{label}</SectionLabel>}
            {description && (
              <div className="mt-1" style={{ color: TOKENS.textTertiary, fontSize: 11 }}>
                {description}
              </div>
            )}
          </div>
          {rightSlot}
        </div>
      )}
      {children}
    </div>
  );
}

function DisplayNumber({
  children,
  size = 26,
}: {
  children: React.ReactNode;
  size?: number;
}) {
  return (
    <div
      className="font-medium"
      style={{ fontSize: size, color: TOKENS.textPrimary, lineHeight: 1.1 }}
    >
      {children}
    </div>
  );
}

function StatRow({
  label,
  value,
  emphasize,
}: {
  label: string;
  value: React.ReactNode;
  emphasize?: 'critical' | 'caution' | 'healthy';
}) {
  const valueColor =
    emphasize === 'critical'
      ? TOKENS.critical
      : emphasize === 'caution'
        ? TOKENS.caution
        : emphasize === 'healthy'
          ? TOKENS.healthy
          : TOKENS.textPrimary;
  return (
    <div className="flex items-baseline justify-between py-1.5" style={{ fontSize: 13 }}>
      <span style={{ color: TOKENS.textSecondary }}>{label}</span>
      <span className="font-medium" style={{ color: valueColor }}>
        {value}
      </span>
    </div>
  );
}

function MiniBar({
  fillRatio,
  color,
  height = 6,
}: {
  fillRatio: number;
  color: string;
  height?: number;
}) {
  const ratio = Math.max(0, Math.min(1, fillRatio));
  return (
    <div
      style={{
        width: '100%',
        height,
        background: 'rgba(0,0,0,0.04)',
        borderRadius: 3,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          width: `${ratio * 100}%`,
          height: '100%',
          background: color,
          borderRadius: 3,
        }}
      />
    </div>
  );
}

// ----- branch filter ----------------------------------------------------

function BranchFilter({
  value,
  onChange,
  branches,
}: {
  value: string; // 'all' or branchId
  onChange: (v: string) => void;
  branches: { id: string; name: string; code: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border bg-white px-3 py-1.5"
      style={{
        fontSize: 13,
        borderColor: TOKENS.border,
        color: TOKENS.textPrimary,
      }}
    >
      <option value="all">All branches</option>
      {branches.map((b) => (
        <option key={b.id} value={b.id}>
          {b.name} ({b.code})
        </option>
      ))}
    </select>
  );
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

  const visible = chips.slice(0, 6);
  const overflow = chips.length - visible.length;

  return (
    <div className="flex flex-wrap gap-2">
      {visible.map((chip) => (
        <Link
          key={chip.type}
          to={chip.drillTo}
          className="inline-flex max-w-[240px] items-center gap-2 truncate"
          style={{
            background: TOKENS.surface,
            borderLeft: `2px solid ${severityColor(chip.severity)}`,
            border: `0.5px solid ${TOKENS.border}`,
            borderLeftWidth: 2,
            borderLeftColor: severityColor(chip.severity),
            borderRadius: 4,
            padding: '8px 12px',
            fontSize: 13,
            color: TOKENS.textPrimary,
            textDecoration: 'none',
          }}
        >
          <span className="truncate">{chip.label}</span>
        </Link>
      ))}
      {overflow > 0 && (
        <Link
          to="/ops/audit"
          style={{
            background: TOKENS.surface,
            border: `0.5px solid ${TOKENS.border}`,
            borderRadius: 4,
            padding: '8px 12px',
            fontSize: 13,
            color: TOKENS.info,
            textDecoration: 'none',
          }}
        >
          +{overflow} more
        </Link>
      )}
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

      <div className="mt-4 space-y-2">
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

      <div
        className="mt-4 grid grid-cols-3 gap-2 border-t pt-3"
        style={{ borderColor: TOKENS.border, fontSize: 12 }}
      >
        <Link
          to="/money/cash?date=today"
          style={{ color: TOKENS.textSecondary, textDecoration: 'none' }}
        >
          <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Cash collected</div>
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
        <Link
          to="/money/bills?aging=open"
          style={{ color: TOKENS.textSecondary, textDecoration: 'none' }}
        >
          <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Outstanding (all)</div>
          <div
            className="font-medium"
            style={{
              color:
                data.outstandingInPaise > 0 ? TOKENS.caution : TOKENS.textPrimary,
            }}
          >
            {formatRupees(data.outstandingInPaise)}
          </div>
        </Link>
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
}: {
  label: string;
  value: number;
  ratio: number;
  color: string;
  emphasize?: boolean;
}) {
  return (
    <div>
      <div
        className="mb-1 flex items-baseline justify-between"
        style={{ fontSize: 12 }}
      >
        <span style={{ color: TOKENS.textSecondary }}>{label}</span>
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
        Open derived payouts · awaiting review or payment
      </div>
      <div
        className="mt-4 space-y-2 border-t pt-3"
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
    ? `TAT p50 ${Math.round(diagnostics.tatP50Minutes ?? 0)}m · p95 ${Math.round(diagnostics.tatP95Minutes ?? 0)}m · ${diagnostics.tatBreachCount} breach`
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
  const max = Math.max(1, ...trend.map((p) => p.netInPaise));
  // pick top-2 outliers by absolute deviation from median
  const sorted = [...trend.map((p) => p.netInPaise)].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const ranked = trend
    .map((p, i) => ({ idx: i, dev: Math.abs(p.netInPaise - median), value: p.netInPaise }))
    .sort((a, b) => b.dev - a.dev);
  const outlierIdx = new Set(ranked.slice(0, 2).map((r) => r.idx));

  return (
    <SectionCard
      label="Revenue trend · 30 days"
      description="Daily net revenue · ₹ values, two largest outliers marked"
    >
      <div className="relative" style={{ height: 140 }}>
        <svg
          viewBox={`0 0 ${trend.length * 14} 140`}
          width="100%"
          height="100%"
          preserveAspectRatio="none"
        >
          <polyline
            fill="none"
            stroke={TOKENS.info}
            strokeWidth="1.5"
            points={trend
              .map((p, i) => {
                const x = i * 14 + 7;
                const y = 140 - (p.netInPaise / max) * 120 - 8;
                return `${x},${y}`;
              })
              .join(' ')}
          />
          {trend.map((p, i) => {
            const x = i * 14 + 7;
            const y = 140 - (p.netInPaise / max) * 120 - 8;
            const isOutlier = outlierIdx.has(i);
            return (
              <circle
                key={p.date}
                cx={x}
                cy={y}
                r={isOutlier ? 3 : 1.5}
                fill={isOutlier ? TOKENS.critical : TOKENS.info}
              />
            );
          })}
        </svg>
      </div>
      <div
        className="mt-2 flex justify-between"
        style={{ color: TOKENS.textTertiary, fontSize: 11 }}
      >
        <span>{trend[0] && formatTrendDateLabel(trend[0].date)}</span>
        <span>
          {trend[Math.floor(trend.length / 2)] &&
            formatTrendDateLabel(trend[Math.floor(trend.length / 2)].date)}
        </span>
        <span>{trend[trend.length - 1] && formatTrendDateLabel(trend[trend.length - 1].date)}</span>
      </div>
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
      description="Today's gross broken down by category"
    >
      {mix.totalInPaise === 0 ? (
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No bills yet today.</div>
      ) : (
        <>
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
      <SectionCard label="Branch performance" description="Last 30 days · sorted by net">
        <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No branches yet.</div>
      </SectionCard>
    );
  }

  return (
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
                      to={`/branches/${r.branchId}`}
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
  const branches = useBranchStore((s) => s.branches);
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
    staleTime: 60 * 1000,
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
            <BranchFilter
              value={branchValue}
              onChange={setBranchValue}
              branches={branches.filter((b) => b.isActive)}
            />
            <button
              onClick={() => query.refetch()}
              disabled={query.isFetching}
              className="rounded-md border bg-white px-3 py-1.5"
              style={{
                fontSize: 12,
                borderColor: TOKENS.border,
                color: TOKENS.textSecondary,
              }}
              title="Refresh"
            >
              <RefreshCw
                className={cn('inline h-3.5 w-3.5', query.isFetching && 'animate-spin')}
              />
            </button>
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

        {query.isError && (
          <div
            className="px-4 py-3"
            style={{
              background: TOKENS.surface,
              border: `0.5px solid ${TOKENS.border}`,
              borderRadius: 12,
              color: TOKENS.critical,
              fontSize: 13,
            }}
          >
            Failed to load dashboard.{' '}
            <button
              onClick={() => query.refetch()}
              style={{
                color: TOKENS.info,
                textDecoration: 'underline',
                background: 'transparent',
                border: 0,
              }}
            >
              Retry
            </button>
          </div>
        )}

        {data && (
          <div className="space-y-4">
            <ActionQueue chips={data.actionQueue} />

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
              <div className="lg:col-span-3">
                <MoneyTodayCard data={data.moneyToday} />
              </div>
              <div className="lg:col-span-2">
                <PayoutLiabilityCard data={data.payoutLiability} />
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
