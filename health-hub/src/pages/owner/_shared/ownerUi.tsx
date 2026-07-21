/**
 * Shared primitives for the redesigned owner pages.
 *
 * Every page (Dashboard, Money, Doctors, Operations) renders inside the same
 * shell — header + branch filter + period filter + refresh — and shares the
 * same minimal component vocabulary defined in the design brief: SectionCard,
 * StatRow, MiniBar, KpiCard, AgingBar, etc.
 */
import React from 'react';
import { RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRupees } from '@/lib/payoutFormatters';
import { cn } from '@/lib/utils';
import { useBranchStore } from '@/store/branchStore';

export { formatRupees };

// ----- design tokens ----------------------------------------------------

export const TOKENS = {
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
  reportable: '#378ADD',
  clinic: '#5DCAA5',
  billOnly: '#FAC775',
  cash: '#BA7517',
  online: '#185FA5',
  // bar fills
  gross: '#9DC4ED',
  discount: '#FAC775',
  commissionBar: '#E48A8A',
  net: '#5DCAA5',
} as const;

export function formatIstDateTime(iso: string): string {
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

export function formatIstDate(iso: string): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(new Date(iso));
}

export function formatIstTime(iso: string): string {
  const fmt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return fmt.format(new Date(iso)).toLowerCase();
}

// ----- primitives -------------------------------------------------------

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-medium uppercase"
      style={{ color: TOKENS.textSecondary, fontSize: 11, letterSpacing: '0.06em' }}
    >
      {children}
    </div>
  );
}

export function SectionCard({
  label,
  description,
  rightSlot,
  children,
  className,
  padding = 16,
}: {
  label?: string;
  description?: string;
  rightSlot?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  padding?: number;
}) {
  return (
    <div
      className={cn(className)}
      style={{
        background: TOKENS.surface,
        border: `0.5px solid ${TOKENS.border}`,
        borderRadius: 12,
        padding,
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

export function DisplayNumber({
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

export function StatRow({
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

export function MiniBar({
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

// ----- compact KPI card -------------------------------------------------

export function KpiCard({
  label,
  value,
  sub,
  delta,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  delta?: { percent: number | null; baseline?: string };
}) {
  return (
    <div
      style={{
        background: TOKENS.surface,
        border: `0.5px solid ${TOKENS.border}`,
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div
        className="mb-1.5 font-medium uppercase"
        style={{ color: TOKENS.textSecondary, fontSize: 11, letterSpacing: '0.06em' }}
      >
        {label}
      </div>
      <DisplayNumber size={22}>{value}</DisplayNumber>
      {delta &&
        (Number.isFinite(delta.percent as number) ? (
          <div
            className="mt-1"
            style={{
              fontSize: 11,
              color: delta.percent >= 0 ? TOKENS.healthy : TOKENS.critical,
            }}
          >
            {delta.percent >= 0 ? '+' : ''}
            {delta.percent}% {delta.baseline ?? 'vs prior'}
          </div>
        ) : (
          <div className="mt-1" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
            baseline forming
          </div>
        ))}
      {sub && (
        <div className="mt-1" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
          {sub}
        </div>
      )}
    </div>
  );
}

// ----- aging bar --------------------------------------------------------

export function AgingBar({
  bucket,
  total,
  color,
}: {
  bucket: { label: string; amountInPaise: number; rowCount?: number; billCount?: number };
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((bucket.amountInPaise / total) * 100) : 0;
  const count = bucket.rowCount ?? bucket.billCount ?? 0;
  return (
    <div className="py-2">
      <div className="mb-1 flex items-baseline justify-between" style={{ fontSize: 12 }}>
        <span style={{ color: TOKENS.textSecondary }}>{bucket.label}</span>
        <span style={{ color: TOKENS.textPrimary }}>
          {formatRupees(bucket.amountInPaise, { short: true })} · {count} bills · {pct}%
        </span>
      </div>
      <MiniBar fillRatio={pct / 100} color={color} />
    </div>
  );
}

// ----- branch + period filters ------------------------------------------

export function BranchFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const branches = useBranchStore((s) => s.branches).filter((b) => b.isActive);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="inline-flex rounded-md border bg-white px-2.5 py-1.5"
      style={{
        fontSize: 12,
        borderColor: TOKENS.border,
        background: TOKENS.surface,
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

export type PeriodKey = 'today' | 'yesterday' | '7d' | '30d' | 'mtd' | 'ytd' | 'custom';
export const PERIOD_LABEL: Record<PeriodKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  '7d': '7 days',
  '30d': '30 days',
  mtd: 'MTD',
  ytd: 'YTD',
  custom: 'Custom',
};

const DEFAULT_PERIOD_OPTS: PeriodKey[] = ['7d', '30d', 'mtd', 'ytd'];

export function PeriodFilter({
  value,
  onChange,
  options = DEFAULT_PERIOD_OPTS,
  customRange,
  onCustomRangeChange,
}: {
  value: PeriodKey;
  onChange: (v: PeriodKey) => void;
  options?: PeriodKey[];
  // Only needed when 'custom' is one of the options.
  customRange?: { start: string; end: string };
  onCustomRangeChange?: (r: { start: string; end: string }) => void;
}) {
  const dateInputStyle: React.CSSProperties = {
    border: `0.5px solid ${TOKENS.border}`,
    borderRadius: 6,
    padding: '5px 7px',
    fontSize: 12,
    color: TOKENS.textSecondary,
    background: 'white',
  };
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <div
        className="inline-flex overflow-hidden rounded-md border"
        style={{ borderColor: TOKENS.border, fontSize: 12 }}
      >
        {options.map((k, i) => (
          <button
            key={k}
            onClick={() => onChange(k)}
            className="px-2.5 py-1.5"
            style={{
              background: k === value ? TOKENS.info : 'white',
              color: k === value ? 'white' : TOKENS.textSecondary,
              borderLeft: i === 0 ? 'none' : `0.5px solid ${TOKENS.border}`,
            }}
          >
            {PERIOD_LABEL[k]}
          </button>
        ))}
      </div>
      {value === 'custom' && customRange && onCustomRangeChange && (
        <div className="inline-flex items-center gap-1.5">
          <input
            type="date"
            value={customRange.start}
            max={customRange.end || undefined}
            onChange={(e) => onCustomRangeChange({ ...customRange, start: e.target.value })}
            style={dateInputStyle}
          />
          <span style={{ fontSize: 12, color: TOKENS.textSecondary }}>to</span>
          <input
            type="date"
            value={customRange.end}
            min={customRange.start || undefined}
            onChange={(e) => onCustomRangeChange({ ...customRange, end: e.target.value })}
            style={dateInputStyle}
          />
        </div>
      )}
    </div>
  );
}

// ----- shell ------------------------------------------------------------

export function OwnerPageHeader({
  title,
  subtitle,
  rightSlot,
}: {
  title: string;
  subtitle?: React.ReactNode;
  rightSlot?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-medium" style={{ fontSize: 20 }}>
          {title}
        </h1>
        {subtitle && (
          <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>{subtitle}</div>
        )}
      </div>
      {rightSlot && <div className="flex items-center gap-2">{rightSlot}</div>}
    </div>
  );
}

export function RefreshButton({
  isFetching,
  onClick,
}: {
  isFetching: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={isFetching}
      className="rounded-md border bg-white px-3 py-1.5"
      style={{ fontSize: 12, borderColor: TOKENS.border, color: TOKENS.textSecondary }}
      title="Refresh"
    >
      <RefreshCw className={cn('inline h-3.5 w-3.5', isFetching && 'animate-spin')} />
    </button>
  );
}

export function ErrorCard({ onRetry }: { onRetry: () => void }) {
  return (
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
      Failed to load.{' '}
      <button
        onClick={onRetry}
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
  );
}

export function FullPageSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-4">
      <Skeleton className="h-12" />
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-32" />
      ))}
    </div>
  );
}

// ----- severity badge ---------------------------------------------------

export function SeverityBadge({
  severity,
}: {
  severity: 'high' | 'medium' | 'low';
}) {
  const c =
    severity === 'high'
      ? TOKENS.critical
      : severity === 'medium'
        ? TOKENS.caution
        : TOKENS.textTertiary;
  return (
    <span
      style={{
        background: `${c}1A`,
        color: c,
        fontSize: 11,
        padding: '2px 6px',
        borderRadius: 3,
        textTransform: 'uppercase',
        letterSpacing: '0.04em',
      }}
    >
      {severity}
    </span>
  );
}

// ----- numeric link -----------------------------------------------------

export function NumericLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <Link
      to={to}
      style={{
        color: TOKENS.info,
        textDecoration: 'none',
        borderBottom: `1px dashed ${TOKENS.info}40`,
      }}
    >
      {children}
    </Link>
  );
}

// ----- trend chart ------------------------------------------------------

/** Fixed readout box so the hover card can be clamped/flipped inside the plot. */
const TOOLTIP_W = 104;
const TOOLTIP_H = 40;

/**
 * Shared daily-trend line chart. Uses a fixed-aspect responsive svg (the
 * viewBox is sized to the data) so the rendered slope is honest — never
 * preserveAspectRatio="none", which stretches and lies about the trend.
 */
export function TrendChart({
  data,
  height = 140,
  valueFormat = (v) => String(v),
  markLastAsToday = false,
  accent = TOKENS.info,
}: {
  data: { date: string; value: number }[];
  height?: number;
  valueFormat?: (v: number) => string;
  markLastAsToday?: boolean;
  accent?: string;
}) {
  // Measure the container and render the svg at its true pixel width so the
  // chart fills the card (no left/right letterboxing) while markers stay round
  // and the slope is honest (viewBox === pixel size, no aspect distortion).
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = React.useState(0);
  const [activeIdx, setActiveIdx] = React.useState<number | null>(null);
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      if (w > 0) setContainerW(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (!data || data.length === 0) {
    return (
      <div
        className="flex items-center justify-center"
        style={{ height, color: TOKENS.textTertiary, fontSize: 12 }}
      >
        No data
      </div>
    );
  }

  // viewBox coordinate space == measured pixel width (svg fills the container)
  const VB_W = containerW;
  const VB_H = height;
  const padL = 8;
  const padR = 8;
  const padT = 14;
  const padB = 18;
  const plotW = VB_W - padL - padR;
  const plotH = VB_H - padT - padB;

  const values = data.map((d) => d.value);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);
  const span = maxV - minV || 1;

  const n = data.length;
  const xAt = (i: number) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const yAt = (v: number) => padT + (1 - (v - minV) / span) * plotH;

  const points = data.map((d, i) => ({ x: xAt(i), y: yAt(d.value), d }));
  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
  const baselineY = padT + plotH;

  const midIdx = Math.floor((n - 1) / 2);
  const dateLabels: { i: number; anchor: 'start' | 'middle' | 'end' }[] = [
    { i: 0, anchor: 'start' },
  ];
  if (midIdx > 0 && midIdx < n - 1) dateLabels.push({ i: midIdx, anchor: 'middle' });
  if (n > 1) dateLabels.push({ i: n - 1, anchor: 'end' });

  // Nearest-X hover: the reader aims at a date, never at a 1.5px line, so the
  // whole plot is the hit target and the pointer only has to be *closest*.
  const idxAtPointer = (clientX: number, svgEl: SVGSVGElement) => {
    const box = svgEl.getBoundingClientRect();
    const px = clientX - box.left;
    if (n === 1) return 0;
    const ratio = (px - padL) / (plotW || 1);
    return Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1))));
  };

  const active = activeIdx != null && activeIdx >= 0 && activeIdx < n ? points[activeIdx] : null;

  return (
    <div ref={containerRef} style={{ width: '100%', height, position: 'relative' }}>
      {containerW > 0 && (
    <svg
      width={VB_W}
      height={height}
      viewBox={`0 0 ${VB_W} ${VB_H}`}
      role="img"
      aria-label={`Daily trend, ${n} points, from ${formatIstDate(data[0].date)} to ${formatIstDate(
        data[n - 1].date
      )}. High ${valueFormat(maxV)}, low ${valueFormat(minV)}.`}
      tabIndex={0}
      style={{ display: 'block', outline: 'none', touchAction: 'none' }}
      onPointerMove={(e) => setActiveIdx(idxAtPointer(e.clientX, e.currentTarget))}
      onPointerDown={(e) => setActiveIdx(idxAtPointer(e.clientX, e.currentTarget))}
      onPointerLeave={() => setActiveIdx(null)}
      onFocus={() => setActiveIdx((cur) => cur ?? n - 1)}
      onBlur={() => setActiveIdx(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const step = e.key === 'ArrowRight' ? 1 : -1;
          setActiveIdx((cur) => {
            const base = cur ?? n - 1;
            return Math.max(0, Math.min(n - 1, base + step));
          });
        } else if (e.key === 'Home') {
          e.preventDefault();
          setActiveIdx(0);
        } else if (e.key === 'End') {
          e.preventDefault();
          setActiveIdx(n - 1);
        } else if (e.key === 'Escape') {
          setActiveIdx(null);
        }
      }}
    >
      {/* zero baseline */}
      <line
        x1={padL}
        y1={baselineY}
        x2={VB_W - padR}
        y2={baselineY}
        stroke={TOKENS.border}
        strokeWidth={1}
      />
      {/* min / max Y labels */}
      <text x={padL} y={padT - 2} fontSize={10} fill={TOKENS.textTertiary} textAnchor="start">
        {valueFormat(maxV)}
      </text>
      <text
        x={padL}
        y={baselineY - 3}
        fontSize={10}
        fill={TOKENS.textTertiary}
        textAnchor="start"
      >
        {valueFormat(minV)}
      </text>
      {/* crosshair — drawn under the marks so it never sits on top of them */}
      {active && (
        <line
          x1={active.x}
          y1={padT - 6}
          x2={active.x}
          y2={baselineY}
          stroke={TOKENS.borderStrong}
          strokeWidth={1}
        />
      )}
      {/* trend line */}
      <polyline
        points={polyline}
        fill="none"
        stroke={accent}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {/* points */}
      {points.map((p, i) => {
        const isToday = markLastAsToday && i === n - 1;
        const isActive = activeIdx === i;
        return (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={isActive ? 4.5 : isToday ? 4 : 2}
            fill={isActive || isToday ? accent : TOKENS.surface}
            stroke={isActive ? TOKENS.surface : accent}
            strokeWidth={isActive ? 1.5 : isToday ? 0 : 1.2}
          />
        );
      })}
      {/* date labels */}
      {dateLabels.map(({ i, anchor }) => (
        <text
          key={i}
          x={anchor === 'start' ? padL : anchor === 'end' ? VB_W - padR : xAt(i)}
          y={VB_H - 4}
          fontSize={10}
          fill={TOKENS.textTertiary}
          textAnchor={anchor}
        >
          {formatIstDate(data[i].date)}
        </text>
      ))}
    </svg>
      )}
      {/* readout — value leads, date follows; clamped so it never leaves the card */}
      {active && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'absolute',
            left: Math.max(0, Math.min(VB_W - TOOLTIP_W, active.x - TOOLTIP_W / 2)),
            // sit above the point, but flip below for peaks so the box never
            // covers the line it is describing (nor the max-value label)
            top:
              active.y > padT + plotH * 0.45
                ? Math.max(0, active.y - TOOLTIP_H - 10)
                : Math.min(VB_H - TOOLTIP_H, active.y + 12),
            width: TOOLTIP_W,
            pointerEvents: 'none',
            background: TOKENS.surface,
            border: `1px solid ${TOKENS.border}`,
            borderRadius: 4,
            boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
            padding: '5px 8px',
            textAlign: 'center',
          }}
        >
          <div style={{ fontSize: 13, color: TOKENS.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
            {valueFormat(active.d.value)}
          </div>
          <div style={{ fontSize: 10, color: TOKENS.textTertiary, whiteSpace: 'nowrap' }}>
            {formatIstDate(active.d.date)}
          </div>
        </div>
      )}
    </div>
  );
}

// ----- signed delta percent (NaN/null-safe) -----------------------------

/**
 * Renders a period-over-period delta as ▲N% (healthy) / ▼N% (critical), or an
 * em dash when the value is null/undefined/NaN — so a stale or missing field
 * never shows "▼NaN%".
 */
export function DeltaPercent({
  value,
  className,
}: {
  value: number | null | undefined;
  className?: string;
}) {
  const finite = Number.isFinite(value as number);
  const n = finite ? (value as number) : 0;
  return (
    <span
      className={className}
      style={{
        fontSize: 11,
        color: !finite ? TOKENS.textTertiary : n >= 0 ? TOKENS.healthy : TOKENS.critical,
      }}
    >
      {!finite ? '—' : `${n >= 0 ? '▲' : '▼'}${Math.abs(n)}%`}
    </span>
  );
}

// ----- proportional severity --------------------------------------------

/**
 * Color a value by its proportion of a base (ratios in 0..1) instead of a
 * raw > 0 check. Returns "critical" / "caution" / null so callers can pick a
 * TOKENS color (or a SeverityBadge severity) from a threshold.
 */
export function severityForRatio(
  value: number,
  base: number,
  opts: { caution: number; critical: number },
): 'critical' | 'caution' | null {
  if (base <= 0) return null;
  const ratio = value / base;
  if (ratio >= opts.critical) return 'critical';
  if (ratio >= opts.caution) return 'caution';
  return null;
}

// ----- truncation footer ------------------------------------------------

export function TruncationFooter({
  shown,
  total,
  onShowAll,
  allLabel,
}: {
  shown: number;
  total: number;
  onShowAll?: () => void;
  allLabel?: string;
}) {
  if (total <= shown) return null;
  return (
    <div
      className="flex items-center justify-between pt-2"
      style={{ fontSize: 11, color: TOKENS.textTertiary }}
    >
      <span>
        Showing {shown} of {total}
      </span>
      {onShowAll && (
        <button
          onClick={onShowAll}
          style={{
            color: TOKENS.info,
            background: 'transparent',
            border: 0,
            fontSize: 11,
            padding: 0,
          }}
        >
          {allLabel || 'Show all'}
        </button>
      )}
    </div>
  );
}

// ----- empty state ------------------------------------------------------

export function EmptyState({
  label,
  hint,
  icon: Icon,
}: {
  label: string;
  hint?: string;
  icon?: React.ElementType;
}) {
  return (
    <div
      className="flex flex-col items-center justify-center text-center"
      style={{ padding: '24px 16px', color: TOKENS.textTertiary, gap: 4 }}
    >
      {Icon && <Icon className="h-5 w-5" style={{ color: TOKENS.textTertiary }} />}
      <div style={{ fontSize: 13, color: TOKENS.textSecondary }}>{label}</div>
      {hint && <div style={{ fontSize: 11, color: TOKENS.textTertiary }}>{hint}</div>}
    </div>
  );
}
