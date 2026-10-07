/**
 * Dashboard charts: KPI tile, comparison trend, sparkline. Same visual
 * language as ownerUi's TrendChart (light tokens, measured-width svg so slopes
 * are honest, nearest-x hover, arrow keys).
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, Clock, Info } from 'lucide-react';
import { TOKENS, formatRupees } from './ownerUi';

/** One live to-do: a label, a count or amount, and where it's fixed. */
export interface AttentionChip {
  type: string;
  severity: 'high' | 'medium' | 'low';
  label: string;
  count?: number;
  amountInPaise?: number;
  drillTo: string;
}

// ----- one look for every owner card ------------------------------------
// Body and table text 13px; column heads 12px muted; a hairline above each
// row; totals medium weight under a stronger rule; bars 6px on a light track;
// changes as ▲/▼ n% in green/red. Every card on the dashboard and the Money
// page uses these, so new and old cards read the same.

/** Column head style for owner tables. */
export const TH: React.CSSProperties = { fontWeight: 400, fontSize: 12, color: TOKENS.textTertiary };
/** Hairline above a row. */
export const ROW: React.CSSProperties = { borderTop: `0.5px solid ${TOKENS.border}` };
/** The rule above a total row. */
export const TOTAL_ROW: React.CSSProperties = { boxShadow: `inset 0 1px 0 ${TOKENS.borderStrong}` };
const TRACK = '#F1F0EC';

/** Change against the period before: ▲ 12% green / ▼ 12% red, "new" from nothing. */
export function Delta({ now, before, pct }: { now?: number; before?: number; pct?: number | null }) {
  const c = pct !== undefined ? pct : before != null && before > 0 && now != null ? Math.round(((now - before) / before) * 100) : null;
  if (c == null) {
    return <span style={{ color: TOKENS.textTertiary, fontSize: 12 }}>{now && now > 0 && pct === undefined ? 'new' : '—'}</span>;
  }
  return (
    <span style={{ color: c >= 0 ? TOKENS.healthy : TOKENS.critical, fontSize: 12, whiteSpace: 'nowrap' }}>
      {c >= 0 ? '▲' : '▼'} {Math.abs(c)}%
    </span>
  );
}

/** Small caps heading above a group of cards. */
export function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mb-2" style={{ color: TOKENS.textTertiary, fontSize: 11, letterSpacing: 0.4, textTransform: 'uppercase' }}>
      {children}
    </div>
  );
}

/** A thin bar split into parts (e.g. cash / online), on the standard track. */
export function SplitBar({ parts }: { parts: { value: number; color: string; label: string }[] }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  return (
    <div
      className="flex overflow-hidden"
      style={{ height: 6, borderRadius: 3, background: TRACK, gap: 2 }}
      role="img"
      aria-label={parts.map((p) => `${p.label} ${total > 0 ? Math.round((p.value / total) * 100) : 0}%`).join(', ')}
    >
      {total > 0 &&
        parts.map((p) =>
          p.value > 0 ? <div key={p.label} style={{ width: `${(p.value / total) * 100}%`, background: p.color }} /> : null,
        )}
    </div>
  );
}

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
  hint,
  vs = 'vs prior',
}: {
  label: string;
  hint?: string;
  /** What the change is against, e.g. "vs last Tue". */
  vs?: string;
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
  const flat = delta?.text === '0%'; // no change is neither good nor bad
  const Tag = onSelect ? 'button' : 'div';
  return (
    <Tag
      onClick={onSelect}
      aria-pressed={onSelect ? Boolean(selected) : undefined}
      title={hint}
      className={`h-full w-full text-left ${onSelect ? 'bg-white transition-colors hover:bg-slate-50' : ''}`}
      style={{
        background: onSelect ? undefined : TOKENS.surface,
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
      <div style={{ fontSize: 12, minHeight: 18, color: delta && !flat ? (good ? TOKENS.healthy : TOKENS.critical) : TOKENS.textTertiary }}>
        {delta ? (flat ? `no change ${vs}` : `${delta.up ? '▲' : '▼'} ${delta.text} ${vs}`) : footnote ?? ' '}
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
 *
 * With `parts`, each bar is stacked from its parts instead — positives up from
 * zero, negatives (refunds) down — so a day's parts net to its value.
 */
export function ComparisonTrendChart({
  days,
  average,
  priorAverage,
  format,
  onPickDay,
  height = 220,
  parts,
  valueLabel,
  axisLabel,
  titleLabel,
  note,
}: {
  days: DayValue[];
  /** An extra line in the hover card for day i (e.g. that day's median turnaround). */
  note?: (i: number) => string | null;
  /** Keys that are not dates (e.g. hours): how to print them on the axis and in the hover card. */
  axisLabel?: (key: string) => string;
  titleLabel?: (key: string) => string;
  parts?: { label: string; color: string; values: number[] }[];
  /** Names the value in the hover card, e.g. "Net collected". */
  valueLabel?: string;
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
  const axis = axisLabel ?? ((k: string) => fmtDay(k, { day: 'numeric', month: 'short' }));
  const title = titleLabel ?? ((k: string) => fmtDay(k, { weekday: 'short', day: 'numeric', month: 'short' }));
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
  const stackUp = days.map((_, i) => (parts ?? []).reduce((s, p) => s + Math.max(0, p.values[i] ?? 0), 0));
  const stackDown = days.map((_, i) => (parts ?? []).reduce((s, p) => s + Math.min(0, p.values[i] ?? 0), 0));
  const all = [...days.map((d) => d.value), ...average, ...priorAverage, ...stackUp, ...stackDown].filter((v): v is number => v != null);
  // Gridlines on round numbers (₹50k, ₹1L, ₹1.5L), about four of them.
  const step = niceStep((Math.max(...all, 0) - Math.min(0, ...all)) / 4 || 1);
  // A small dip below zero (a day's refunds) gets just enough room, not a whole step.
  const min = Math.min(0, ...all);
  const lo = min < 0 && -min < step ? min * 1.25 : Math.floor(min / step) * step;
  const hi = Math.max(step, Math.ceil(Math.max(...all, 0) / step) * step);
  const slot = plotW / n;
  const x = (i: number) => padL + (i + 0.5) * slot;
  const y = (v: number) => padT + (1 - (v - lo) / (hi - lo)) * plotH;
  const barW = Math.max(1, Math.min(18, slot - 3));
  const line = (vals: (number | null)[]) =>
    vals
      .map((v, i) => (v == null ? null : `${x(i)},${y(v)}`))
      .filter(Boolean)
      .join(' ');
  const firstTick = Math.ceil(lo / step - 1e-9) * step;
  const grid = Array.from({ length: Math.round((hi - firstTick) / step) + 1 }, (_, g) => firstTick + g * step);
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
          aria-label={`Figures from ${axis(days[0].date)} to ${axis(days[n - 1].date)}, with the comparison period behind. Use arrow keys to step through.`}
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
          {parts
            ? days.map((d, i) => {
                let up = 0;
                let down = 0;
                return (
                  <g key={d.date} opacity={active == null || active === i ? 1 : 0.55}>
                    {parts.map((p) => {
                      const v = p.values[i] ?? 0;
                      if (!v) return null;
                      const from = v > 0 ? up : down;
                      const to = from + v;
                      if (v > 0) up = to;
                      else down = to;
                      return (
                        <rect
                          key={p.label}
                          x={x(i) - barW / 2}
                          y={Math.min(y(from), y(to))}
                          width={barW}
                          height={Math.max(0, Math.abs(y(to) - y(from)))}
                          fill={p.color}
                          stroke={TOKENS.surface}
                          strokeWidth={1}
                        />
                      );
                    })}
                  </g>
                );
              })
            : days.map((d, i) =>
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
          {parts && <line x1={padL} x2={W - padR} y1={y(0)} y2={y(0)} stroke={TOKENS.borderStrong} />}
          <polyline points={line(priorAverage)} fill="none" stroke={TOKENS.textTertiary} strokeWidth={1.5} strokeDasharray="4 3" />
          <polyline points={line(average)} fill="none" stroke={TOKENS.info} strokeWidth={2} strokeLinejoin="round" />
          {days.map((d, i) =>
            i % labelEvery === 0 || i === n - 1 ? (
              <text key={d.date} x={x(i)} y={height - 6} fontSize={10} fill={TOKENS.textTertiary} textAnchor="middle">
                {axis(d.date)}
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
          <div className="font-medium">{title(a.date)}</div>
          {parts?.map((p) =>
            p.values[active] ? (
              <div key={p.label} className="flex justify-between gap-2">
                <span className="inline-flex items-center gap-1.5" style={{ color: TOKENS.textSecondary }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block' }} />
                  {p.label}
                </span>
                <span>{format(p.values[active])}</span>
              </div>
            ) : null,
          )}
          <div className={parts ? 'flex justify-between gap-2 font-medium' : undefined}>
            {valueLabel && <span>{valueLabel}</span>}
            <span>{a.value == null ? '—' : format(a.value)}</span>
          </div>
          {note?.(active) && <div style={{ color: TOKENS.textSecondary }}>{note(active)}</div>}
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

/** 1, 2, 2.5 or 5 × a power of ten, at least `raw`. */
function niceStep(raw: number): number {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// Validated categorical slots (light surface): blue, orange, aqua, yellow.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'] as const;

/** One line of a statement: label left, amount right; `total` lines are ruled and bold. */
export function StatementLine({ label, value, total, note, to }: { label: string; value: number; total?: boolean; note?: string; to?: string }) {
  const body = (
    <div
      className="flex items-baseline justify-between gap-3 py-1.5"
      style={{
        fontSize: total ? 14 : 13,
        fontWeight: total ? 600 : 400,
        borderTop: total ? `1px solid ${TOKENS.borderStrong}` : undefined,
        color: TOKENS.textPrimary,
      }}
    >
      <span style={{ color: total ? TOKENS.textPrimary : TOKENS.textSecondary }}>
        {label}
        {note && <span style={{ color: TOKENS.textTertiary, fontWeight: 400 }}> · {note}</span>}
      </span>
      <span style={{ fontVariantNumeric: 'tabular-nums' }}>{formatRupees(Math.round(value / 100) * 100)}</span>
    </div>
  );
  return to ? (
    <Link to={to} className="block rounded hover:bg-slate-50" style={{ textDecoration: 'none' }}>
      {body}
    </Link>
  ) : (
    body
  );
}

export interface BarRow {
  key: string;
  label: string;
  value: number;
  prior?: number;
  note?: string;
  color?: string; // defaults to the first series colour
}

/**
 * A ranked list of parts that add up to a total: each row's bar, amount, share
 * and change against the period before, then the total — so a reader can see
 * the parts reconcile with the headline. A bar is the row's share of the total,
 * so its length and the Share column always agree.
 */
export function BarList({
  rows,
  format,
  totalLabel,
  priorLabel = 'the period before',
  keepOrder,
  onPick,
  selected,
}: {
  rows: BarRow[];
  format: (v: number) => string;
  totalLabel: string;
  priorLabel?: string;
  keepOrder?: boolean; // rows in the order given (e.g. age buckets), not largest first
  onPick?: (key: string) => void;
  selected?: string | null;
}) {
  if (rows.length === 0) {
    return <div style={{ color: TOKENS.textTertiary, fontSize: 13 }}>Nothing in this window.</div>;
  }
  const total = rows.reduce((s, r) => s + r.value, 0);
  const priorTotal = rows.reduce((s, r) => s + (r.prior ?? 0), 0);
  const compare = rows.some((r) => r.prior != null);
  const cols = compare ? 'minmax(0, 1fr) 76px 40px 56px' : 'minmax(0, 1fr) 76px 40px';
  return (
    <div style={{ fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
      <div className="grid gap-x-3 pb-1" style={{ gridTemplateColumns: cols, ...TH }}>
        <span />
        <span className="text-right">Amount</span>
        <span className="text-right">Share</span>
        {compare && <span className="text-right">vs before</span>}
      </div>
      {(keepOrder ? rows : [...rows].sort((a, b) => b.value - a.value)).map((r) => (
        <div
          key={r.key}
          className={`grid items-center gap-x-3 py-1.5 ${onPick ? 'cursor-pointer rounded hover:bg-slate-50' : ''}`}
          role={onPick ? 'button' : undefined}
          tabIndex={onPick ? 0 : undefined}
          onClick={onPick ? () => onPick(r.key) : undefined}
          onKeyDown={onPick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(r.key); } } : undefined}
          aria-pressed={onPick ? selected === r.key : undefined}
          style={{
            gridTemplateColumns: cols,
            ...ROW,
            background: selected === r.key ? '#EEF4FF' : undefined,
            opacity: selected && selected !== r.key ? 0.55 : 1,
          }}
          title={`${r.label}: ${format(r.value)}${compare ? ` now · ${format(r.prior ?? 0)} ${priorLabel}` : ''}${r.note ? ` · ${r.note}` : ''}`}
        >
          <div className="min-w-0">
            <div style={{ color: TOKENS.textPrimary }}>
              {r.label}
              {r.note && <span style={{ color: TOKENS.textTertiary, fontSize: 11 }}> · {r.note}</span>}
            </div>
            <div className="mt-1" style={{ height: 6, borderRadius: 3, background: TRACK }}>
              <div style={{ width: `${total > 0 ? Math.min(100, (Math.max(0, r.value) / total) * 100) : 0}%`, height: '100%', borderRadius: 3, background: r.color ?? SERIES[0] }} />
            </div>
          </div>
          <span className="text-right">{format(r.value)}</span>
          <span className="text-right" style={{ color: TOKENS.textSecondary }}>{total > 0 ? `${Math.round((r.value / total) * 100)}%` : ''}</span>
          {compare && <span className="text-right"><Delta now={r.value} before={r.prior ?? 0} /></span>}
        </div>
      ))}
      <div
        className="grid items-center gap-x-3 pt-2 font-medium"
        style={{ gridTemplateColumns: cols, ...TOTAL_ROW }}
      >
        <span>{totalLabel}</span>
        <span className="text-right">{format(total)}</span>
        <span className="text-right" style={{ color: TOKENS.textSecondary }}>100%</span>
        {compare && <span className="text-right"><Delta now={total} before={priorTotal} /></span>}
      </div>
    </div>
  );
}

// Sequential blue ramp (validated light steps), lightest = fewest.
export const HEAT = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95'];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? 'am' : 'pm'}`;

/** Visits by weekday × hour. Darker = busier; every cell answers on hover/focus. */
export function BusyHoursHeatmap({ cells }: { cells: { dow: number; hour: number; visits: number }[] }) {
  const [active, setActive] = React.useState<{ dow: number; hour: number } | null>(null);
  if (cells.length === 0) {
    return <div style={{ color: TOKENS.textTertiary, fontSize: 12 }}>No visits in this window.</div>;
  }
  const at = new Map(cells.map((c) => [`${c.dow}-${c.hour}`, c.visits]));
  const max = Math.max(...cells.map((c) => c.visits));
  const total = cells.reduce((s, c) => s + c.visits, 0);
  // Only the hours anyone came in, so the grid stays wide enough to read.
  const lo = Math.min(...cells.map((c) => c.hour));
  const hi = Math.max(...cells.map((c) => c.hour));
  const hours = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
  const busiest = [...cells].sort((a, b) => b.visits - a.visits)[0];
  const shade = (n: number) => (n === 0 ? '#F1F0EC' : HEAT[Math.min(HEAT.length - 1, Math.floor((n / max) * HEAT.length - 1e-9))]);
  const a = active ? at.get(`${active.dow}-${active.hour}`) ?? 0 : null;

  return (
    <div>
      <div style={{ fontSize: 12, color: TOKENS.textSecondary, minHeight: 18 }} role="status">
        {active
          ? `${DAYS[active.dow - 1]} ${hourLabel(active.hour)}–${hourLabel(active.hour + 1)} · ${a} visit${a === 1 ? '' : 's'} (${total ? ((a! / total) * 100).toFixed(1) : 0}% of the window)`
          : `Busiest: ${DAYS[busiest.dow - 1]} ${hourLabel(busiest.hour)}–${hourLabel(busiest.hour + 1)} · ${busiest.visits} visits`}
      </div>
      <div
        className="mt-2 grid"
        style={{ gridTemplateColumns: `34px repeat(${hours.length}, minmax(0, 1fr))`, gap: 2 }}
        onMouseLeave={() => setActive(null)}
      >
        {DAYS.map((d, di) => (
          <React.Fragment key={d}>
            <div style={{ fontSize: 11, color: TOKENS.textTertiary, alignSelf: 'center' }}>{d}</div>
            {hours.map((h) => {
              const n = at.get(`${di + 1}-${h}`) ?? 0;
              const on = active?.dow === di + 1 && active?.hour === h;
              return (
                <div
                  key={h}
                  tabIndex={0}
                  aria-label={`${d} ${hourLabel(h)}: ${n} visits`}
                  onMouseEnter={() => setActive({ dow: di + 1, hour: h })}
                  onFocus={() => setActive({ dow: di + 1, hour: h })}
                  className="focus-visible:ring-2 focus-visible:ring-blue-300"
                  style={{
                    height: 22,
                    borderRadius: 3,
                    background: shade(n),
                    outline: on ? `1.5px solid ${TOKENS.textPrimary}` : 'none',
                    outlineOffset: -1,
                  }}
                />
              );
            })}
          </React.Fragment>
        ))}
        <div />
        {hours.map((h, i) => (
          <div key={h} style={{ fontSize: 10, color: TOKENS.textTertiary, textAlign: 'center' }}>
            {i % 2 === 0 ? hourLabel(h) : ''}
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5" style={{ fontSize: 11, color: TOKENS.textTertiary }}>
        Fewer
        {HEAT.map((c) => <span key={c} style={{ width: 14, height: 8, borderRadius: 2, background: c, display: 'inline-block' }} />)}
        More · {max} at most in one hour-slot
      </div>
    </div>
  );
}

// ----- needs attention ----------------------------------------------------

function severityRank(s: AttentionChip['severity']): number {
  if (s === 'high') return 3;
  if (s === 'medium') return 2;
  return 1;
}

function severityColor(s: AttentionChip['severity']): string {
  if (s === 'high') return TOKENS.critical;
  if (s === 'medium') return TOKENS.caution;
  return TOKENS.textTertiary;
}

function severityIcon(s: AttentionChip['severity']) {
  if (s === 'high') return AlertTriangle;
  if (s === 'medium') return Clock;
  return Info;
}

// ----- action queue -----------------------------------------------------

/** Live to-dos as chips, most severe first; each opens where it's fixed. */
export function ActionQueue({ chips }: { chips: AttentionChip[] }) {
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
            // "#id" = a card further down this page: scroll to it.
            onClick={(e) => {
              if (!chip.drillTo.startsWith('#')) return;
              e.preventDefault();
              document.getElementById(chip.drillTo.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
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
