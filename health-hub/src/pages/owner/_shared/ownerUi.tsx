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
import { cn } from '@/lib/utils';
import { useBranchStore } from '@/store/branchStore';

export { formatRupees } from '@/lib/payoutFormatters';

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
        (delta.percent !== null ? (
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
      className="rounded-md border bg-white px-3 py-1.5"
      style={{ fontSize: 13, borderColor: TOKENS.border, color: TOKENS.textPrimary }}
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

export type PeriodKey = '7d' | '30d' | 'mtd' | 'ytd';
export const PERIOD_LABEL: Record<PeriodKey, string> = {
  '7d': '7 days',
  '30d': '30 days',
  mtd: 'MTD',
  ytd: 'YTD',
};

export function PeriodFilter({
  value,
  onChange,
}: {
  value: PeriodKey;
  onChange: (v: PeriodKey) => void;
}) {
  const opts: PeriodKey[] = ['7d', '30d', 'mtd', 'ytd'];
  return (
    <div
      className="inline-flex overflow-hidden rounded-md border"
      style={{ borderColor: TOKENS.border, fontSize: 12 }}
    >
      {opts.map((k) => (
        <button
          key={k}
          onClick={() => onChange(k)}
          className="px-2.5 py-1.5"
          style={{
            background: k === value ? TOKENS.info : 'white',
            color: k === value ? 'white' : TOKENS.textSecondary,
            borderLeft: k === opts[0] ? 'none' : `0.5px solid ${TOKENS.border}`,
          }}
        >
          {PERIOD_LABEL[k]}
        </button>
      ))}
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
