/**
 * Dashboard charts: KPI tile, comparison trend, sparkline. Same visual
 * language as ownerUi's TrendChart (light tokens, measured-width svg so slopes
 * are honest, nearest-x hover, arrow keys).
 */
import React from 'react';
import { TOKENS } from './ownerUi';

/** One day of the window beside the same day one window earlier. */
export interface DayValue {
  date: string;
  value: number | null;
  prior: number | null;
}

const fmtDay = (key: string, opts: Intl.DateTimeFormatOptions) =>
  new Date(`${key}T00:00:00+05:30`).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', ...opts });

function useWidth() {
  const ref = React.useRef<HTMLDivElement>(null);
  const [w, setW] = React.useState(0);
  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((e) => {
      const next = Math.round(e[0]?.contentRect.width ?? 0);
      if (next > 0) setW(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function Sparkline({
  values,
  width = 96,
  height = 24,
  color = TOKENS.info,
}: {
  values: (number | null)[];
  width?: number;
  height?: number;
  color?: string;
}) {
  const pts = values.map((v, i) => ({ v, i })).filter((p): p is { v: number; i: number } => p.v != null);
  if (pts.length < 2) return <div style={{ width, height }} />;
  const lo = Math.min(...pts.map((p) => p.v));
  const hi = Math.max(...pts.map((p) => p.v));
  const span = hi - lo || 1;
  const x = (i: number) => 1 + (i / (values.length - 1)) * (width - 2);
  const y = (v: number) => height - 2 - ((v - lo) / span) * (height - 4);
  return (
    <svg width={width} height={height} aria-hidden style={{ display: 'block' }}>
      <polyline
        points={pts.map((p) => `${x(p.i)},${y(p.v)}`).join(' ')}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function KpiTile({
  label,
  value,
  delta,
  deltaGoodWhenUp = true,
  spark,
  selected,
  onSelect,
  footnote,
}: {
  label: string;
  value: string;
  /** Already formatted, e.g. "+13%" or "−0.4 pts"; null = nothing to compare. */
  delta: { text: string; up: boolean } | null;
  deltaGoodWhenUp?: boolean;
  spark?: (number | null)[];
  selected?: boolean;
  onSelect?: () => void;
  footnote?: string;
}) {
  const good = delta ? delta.up === deltaGoodWhenUp : true;
  const Tag = onSelect ? 'button' : 'div';
  return (
    <Tag
      onClick={onSelect}
      aria-pressed={onSelect ? Boolean(selected) : undefined}
      className="h-full w-full text-left"
      style={{
        background: TOKENS.surface,
        border: `${selected ? 1.5 : 0.5}px solid ${selected ? TOKENS.info : TOKENS.border}`,
        borderRadius: 12,
        padding: selected ? '11px 13px' : '12px 14px',
        cursor: onSelect ? 'pointer' : 'default',
      }}
    >
      <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>{label}</div>
      <div className="font-medium" style={{ fontSize: 20, color: TOKENS.textPrimary, letterSpacing: '-0.01em' }}>
        {value}
      </div>
      <div style={{ fontSize: 12, minHeight: 18, color: delta ? (good ? TOKENS.healthy : TOKENS.critical) : TOKENS.textTertiary }}>
        {delta ? `${delta.up ? '▲' : '▼'} ${delta.text} vs prior` : footnote ?? ' '}
      </div>
      {spark && (
        <div className="mt-1">
          <Sparkline values={spark} />
        </div>
      )}
    </Tag>
  );
}

/**
 * Daily bars for the window, its 7-day average, and the prior window's 7-day
 * average drawn behind (daily values instead when the window is under two
 * weeks, where an average says nothing). Hover any day for its numbers; click
 * opens it.
 */
export function ComparisonTrendChart({
  days,
  average,
  priorAverage,
  format,
  onPickDay,
  height = 220,
}: {
  days: DayValue[];
  /** One per day, aligned with `days`; null where there is no line. */
  average: (number | null)[];
  priorAverage: (number | null)[];
  format: (v: number) => string;
  onPickDay?: (date: string) => void;
  height?: number;
}) {
  const [ref, W] = useWidth();
  const [active, setActive] = React.useState<number | null>(null);
  const n = days.length;
  if (n === 0) {
    return (
      <div className="flex items-center justify-center" style={{ height, color: TOKENS.textTertiary, fontSize: 12 }}>
        No data
      </div>
    );
  }
  const padL = 52;
  const padR = 8;
  const padT = 10;
  const padB = 22;
  const plotW = Math.max(1, W - padL - padR);
  const plotH = height - padT - padB;
  const all = [...days.map((d) => d.value), ...average, ...priorAverage].filter((v): v is number => v != null);
  const hi = Math.max(1, ...all) * 1.05;
  const lo = Math.min(0, ...all);
  const slot = plotW / n;
  const x = (i: number) => padL + (i + 0.5) * slot;
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
  const barW = Math.max(1, Math.min(18, slot - 3));
  const line = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v == null ? null : `${x(i)},${y(v)}`))
      .filter(Boolean)
      .join(' ');
  const grid = [0, 1, 2, 3].map((g) => lo + ((hi - lo) * g) / 3);
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  const pick = (clientX: number, el: SVGSVGElement) => {
    const px = clientX - el.getBoundingClientRect().left - padL;
    return Math.max(0, Math.min(n - 1, Math.floor(px / slot)));
  };
  const a = active != null ? days[active] : null;

  return (
    <div ref={ref} style={{ position: 'relative', width: '100%', height }}>
      {W > 0 && (
        <svg
          width={W}
          height={height}
          role="img"
          aria-label={`Daily figures from ${fmtDay(days[0].date, { day: 'numeric', month: 'short' })} to ${fmtDay(days[n - 1].date, { day: 'numeric', month: 'short' })}, with the prior period behind. Use arrow keys to step through days.`}
          tabIndex={0}
          style={{ display: 'block', outline: 'none', cursor: onPickDay ? 'pointer' : 'default', touchAction: 'none' }}
          onPointerMove={(e) => setActive(pick(e.clientX, e.currentTarget))}
          onPointerLeave={() => setActive(null)}
          onClick={(e) => onPickDay?.(days[pick(e.clientX, e.currentTarget)].date)}
          onFocus={() => setActive((c) => c ?? n - 1)}
          onBlur={() => setActive(null)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              setActive((c) => Math.max(0, Math.min(n - 1, (c ?? n - 1) + (e.key === 'ArrowRight' ? 1 : -1))));
            } else if (e.key === 'Enter' && active != null) {
              onPickDay?.(days[active].date);
            } else if (e.key === 'Escape') setActive(null);
          }}
        >
          {grid.map((v, i) => (
            <g key={i}>
              <line x1={padL} x2={W - padR} y1={y(v)} y2={y(v)} stroke={TOKENS.border} />
              <text x={padL - 6} y={y(v) + 3} fontSize={10} fill={TOKENS.textTertiary} textAnchor="end">
                {format(v)}
              </text>
            </g>
          ))}
          {active != null && (
            <rect x={x(active) - slot / 2} y={padT} width={slot} height={plotH} fill={TOKENS.page} />
          )}
          {days.map((d, i) =>
            d.value == null ? null : (
              <rect
                key={d.date}
                x={x(i) - barW / 2}
                y={Math.min(y(d.value), y(0))}
                width={barW}
                height={Math.max(0, Math.abs(y(0) - y(d.value)))}
                rx={2}
                fill={TOKENS.gross}
                opacity={active == null || active === i ? 1 : 0.55}
              />
            ),
          )}
          <polyline points={line(priorAverage)} fill="none" stroke={TOKENS.textTertiary} strokeWidth={1.5} strokeDasharray="4 3" />
          <polyline points={line(average)} fill="none" stroke={TOKENS.info} strokeWidth={2} strokeLinejoin="round" />
          {days.map((d, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={d.date} x={x(i)} y={height - 6} fontSize={10} fill={TOKENS.textTertiary} textAnchor="middle">
                {fmtDay(d.date, { day: 'numeric', month: 'short' })}
              </text>
            ) : null,
          )}
        </svg>
      )}
      {a && active != null && (
        <div
          role="status"
          style={{
            position: 'absolute',
            top: 4,
            left: Math.min(Math.max(x(active) + 10, padL), W - 190),
            width: 180,
            pointerEvents: 'none',
            background: TOKENS.surface,
            border: `1px solid ${TOKENS.border}`,
            borderRadius: 6,
            boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
            padding: '6px 8px',
            fontSize: 12,
            color: TOKENS.textPrimary,
          }}
        >
          <div className="font-medium">{fmtDay(a.date, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
          <div>{a.value == null ? '—' : format(a.value)}</div>
          {average[active] != null && (
            <div style={{ color: TOKENS.info }}>7-day avg {format(average[active]!)}</div>
          )}
          {a.prior != null && (
            <div style={{ color: TOKENS.textTertiary }}>
              Prior period, same day {format(a.prior)}
              {priorAverage[active] != null && average[active] != null ? ` · avg ${format(priorAverage[active]!)}` : ''}
            </div>
          )}
          {onPickDay && <div style={{ color: TOKENS.textTertiary, fontSize: 11 }}>Click to open this day</div>}
        </div>
      )}
    </div>
  );
}
