/**
 * One small-multiple trend chart, rendered as plain SVG.
 *
 * No charting library and no JavaScript, because the same markup has to survive
 * Puppeteer when the PDF is printed AND render on a patient's phone from a static
 * page. For three to six points that is about thirty lines of arithmetic.
 */
import type { Finding, TrendPoint } from './types';

const W = 300, H = 128;
const L = 8, R = 8, T = 16, B = 20;          // plot insets
const PLOT_W = W - L - R, PLOT_H = H - T - B;

/** A chart needs today plus at least one comparable earlier reading. */
export const MIN_POINTS = 2;

const fmt = (n: number) =>
  Math.abs(n) >= 100 ? String(Math.round(n)) : String(Math.round(n * 100) / 100);

/**
 * X from real dates, not even spacing. Four visits at two weeks, two weeks and
 * then fourteen months would otherwise draw a straight ramp that lies about the
 * trajectory. Falls back to even spacing when the dates are unusable.
 */
function xPositions(points: TrendPoint[]): number[] {
  const times = points.map((p) => (p.date ? Date.parse(p.date) : NaN));
  const known = times.filter((t) => !Number.isNaN(t));
  // the current reading carries no date; place it "today"
  const last = known.length ? Math.max(...known, Date.now()) : Date.now();
  const filled = times.map((t) => (Number.isNaN(t) ? last : t));
  const lo = Math.min(...filled), hi = Math.max(...filled);
  if (!(hi > lo)) return points.map((_, i) => L + (PLOT_W * i) / Math.max(1, points.length - 1));
  return filled.map((t) => L + (PLOT_W * (t - lo)) / (hi - lo));
}

export function trendChart(f: Finding): string {
  const pts = f.history;
  if (pts.length < MIN_POINTS) return '';

  const values = pts.map((p) => p.value);
  const bounds = [f.refLow, f.refHigh].filter((n): n is number => n !== null);
  const lo0 = Math.min(...values, ...bounds), hi0 = Math.max(...values, ...bounds);
  const span = hi0 - lo0 || Math.max(Math.abs(hi0), 1) * 0.2;
  const lo = lo0 - span * 0.18, hi = hi0 + span * 0.18;
  const y = (v: number) => T + PLOT_H - ((v - lo) / (hi - lo)) * PLOT_H;
  const xs = xPositions(pts);

  // reference band, clipped to the drawn area
  const bandTop = f.refHigh !== null ? y(f.refHigh) : T;
  const bandBot = f.refLow !== null ? y(f.refLow) : T + PLOT_H;
  const band = bounds.length
    ? `<rect x="${L}" y="${bandTop.toFixed(1)}" width="${PLOT_W}" height="${Math.max(1, bandBot - bandTop).toFixed(1)}"
        fill="#E6F4EA" rx="3"/>`
    : '';

  const line = `<polyline fill="none" stroke="#185484" stroke-width="2" stroke-linejoin="round"
    stroke-linecap="round" points="${pts.map((p, i) => `${xs[i].toFixed(1)},${y(p.value).toFixed(1)}`).join(' ')}"/>`;

  const dots = pts.map((p, i) => {
    const isLast = i === pts.length - 1;
    const inRange = (f.refLow === null || p.value >= f.refLow) && (f.refHigh === null || p.value <= f.refHigh);
    const col = isLast ? (inRange ? '#1E8E3E' : '#C5221F') : '#185484';
    return `<circle cx="${xs[i].toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${isLast ? 4.5 : 3}"
      fill="${col}" ${isLast ? 'stroke="#fff" stroke-width="1.6"' : ''}/>`;
  }).join('');

  // label only the first and the current reading; the middle would collide
  const first = pts[0], lastPt = pts[pts.length - 1];
  const lastAnchor = xs[xs.length - 1] > W - 42 ? 'end' : 'middle';
  const labels = `
    <text x="${xs[0].toFixed(1)}" y="${(y(first.value) - 8).toFixed(1)}" text-anchor="${xs[0] < 26 ? 'start' : 'middle'}"
      font-size="10" fill="#7A8189">${fmt(first.value)}</text>
    <text x="${xs[xs.length - 1].toFixed(1)}" y="${(y(lastPt.value) - 9).toFixed(1)}" text-anchor="${lastAnchor}"
      font-size="11.5" font-weight="700" fill="#1A1A1A">${fmt(lastPt.value)}</text>
    <text x="${L}" y="${H - 5}" font-size="9" fill="#9AA0A6">${first.date || ''}</text>
    <text x="${W - R}" y="${H - 5}" font-size="9" fill="#9AA0A6" text-anchor="end">This visit</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="tchart">${band}${line}${dots}${labels}</svg>`;
}

/**
 * Plain-language verdict, computed not written. "Improving" is deliberately
 * avoided — a value moving toward its range is not the same as a person getting
 * better, and we are not entitled to the second claim.
 */
export function trendVerdict(f: Finding): string {
  const pts = f.history;
  if (pts.length < MIN_POINTS) return '';
  const prev = pts[pts.length - 2].value, now = pts[pts.length - 1].value;
  const dist = (v: number) => {
    if (f.refHigh !== null && v > f.refHigh) return v - f.refHigh;
    if (f.refLow !== null && v < f.refLow) return f.refLow - v;
    return 0;
  };
  const d0 = dist(prev), d1 = dist(now);
  if (d1 === 0 && d0 > 0) return 'Back inside the normal range';
  if (d1 === 0) return 'Still inside the normal range';
  if (d1 < d0) return 'Closer to the normal range than last time';
  if (d1 > d0) return 'Further from the normal range than last time';
  return 'About the same as last time';
}
