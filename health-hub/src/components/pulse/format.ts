/** Money stays in paise on the wire; the UI formats. Indian grouping (₹18,93,724). */
export const rupees = (paise: number | null | undefined, opts: { compact?: boolean } = {}) => {
  if (paise == null || !Number.isFinite(Number(paise))) return '—';
  const r = Math.round(Number(paise)) / 100;
  if (opts.compact && Math.abs(r) >= 1e5) return '₹' + (r / 1e5).toFixed(r >= 1e7 ? 0 : 1) + 'L';
  return '₹' + r.toLocaleString('en-IN', { maximumFractionDigits: 0 });
};
export const num = (v: unknown) => v == null || v === '' ? '—' : Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 });
/** Format a value according to the metric unit the backend attached, else by column name. */
export function fmtValue(v: unknown, unit: string | null | undefined, col?: string): string {
  if (v == null) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (unit === 'paise' || /paise/i.test(col || '')) return rupees(n);
  if (unit === 'ratio') return (n <= 1 ? n * 100 : n).toFixed(1) + '%';
  if (/pct|percent|share|rate/i.test(col || '') && n <= 100) return n.toFixed(1) + '%';
  if (unit === 'minutes') return n >= 120 ? (n / 60).toFixed(1) + 'h' : Math.round(n) + 'm';
  if (/hours?$/i.test(col || '')) return n.toFixed(1) + 'h';
  return num(n);
}
export const pct = (p: number | null | undefined) => p == null ? '' : (p > 0 ? '▲ ' : p < 0 ? '▼ ' : '') + Math.abs(p).toFixed(1) + '%';
export const label = (k: string) => k.replace(/[_ ]?(in_?)?paise$/i, '').replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/ In Paise$/i, '');
