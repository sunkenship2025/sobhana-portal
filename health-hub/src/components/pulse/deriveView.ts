/**
 * EVIDENCE → VIEW. One deterministic derivation, shared by every renderer.
 *
 * What this replaces: `seriesOf()`, which guessed which column was the label and which was the
 * value and threw the rest away. Measured across the artifact types, the renderers were showing
 * 85% of the MATERIAL information they were handed, 24% of the useful context, and 0% of the
 * quantities that are arithmetic over what is already there — share of total, concentration,
 * share of change. Not lost in transit: run.ts puts the whole evidence[] on the wire beside the
 * artifact specs. Simply never computed, and never displayed.
 *
 * So the gap was never "the card needs more fields". It was that a bar's WIDTH encoded a share
 * that no number ever stated, `slice(0, 8)` dropped the tail in silence, and `means` — the one
 * sentence saying what the figure actually is — reached the browser on every single step and was
 * rendered nowhere.
 *
 * TWO RULES.
 *
 * Nothing here is authored by the model. Totals and shares are arithmetic; every number a model
 * writes is a number that can be wrong and then has to be grounded.
 *
 * A field that cannot justify itself is ABSENT, not null. A renderer must never test eight
 * nullables per row, and must never print "— %" where a share could not be computed. The
 * question each field answers is "is this derivable from what we have", and where the answer is
 * no the field does not exist.
 */

export interface ViewRow {
  label: string;
  value: string;            // as displayed — money arrives pre-formatted and is not re-formatted
  n: number;                // the numeric magnitude behind it, for bars and arithmetic
  share?: number;           // 0-1 of the total, only when a total exists
  change?: string;          // as displayed
  changeN?: number;
  rank?: number;
}

export interface View {
  rows: ViewRow[];
  /** what the figures ARE — metric, dimension, period, scope, all of which travel on the wire */
  context: string[];
  total?: string;
  totalN?: number;
  /** rows the renderer is not showing, and what they add up to */
  hidden?: { count: number; value?: string };
  /** how concentrated: the share carried by the visible leaders */
  concentration?: { topN: number; share: number };
  /** the single sentence saying what this number represents */
  means?: string;
}

const NUM = /^[\s₹$]*-?[\d,]+(\.\d+)?[\s%]*$/;
export const toNum = (v: unknown): number => {
  if (typeof v === 'number') return v;
  const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const isNumeric = (v: unknown) => typeof v === 'number' || (typeof v === 'string' && NUM.test(v));

/** Rows arrive under any of these — a query step uses summary.rows, the registry uses parts. */
function rowsOf(ev: any): any[] {
  const s = ev?.summary || {};
  const r = s.parts ?? s.byBranch ?? s.top ?? s.doctors ?? s.rows ?? ev?.data?.rows ?? [];
  return Array.isArray(r) ? r : [];
}

/** Which column is the label and which is the measure — decided from the VALUES, not the names. */
function columns(rows: any[]): { label?: string; value?: string; change?: string } {
  const first = rows.find((r) => r && typeof r === 'object');
  if (!first) return {};
  const keys = Object.keys(first);
  if (keys.includes('name') && (keys.includes('value') || keys.includes('v')))
    return { label: 'name', value: keys.includes('value') ? 'value' : 'v', change: keys.find((k) => /change|delta/i.test(k)) };
  const numeric = keys.filter((k) => rows.filter((r) => r?.[k] != null).every((r) => isNumeric(r[k])));
  const label = keys.find((k) => !numeric.includes(k));
  const change = keys.find((k) => /change|delta/i.test(k));
  const value = numeric.find((k) => k !== change && !/share|pct|percent|rank|prev/i.test(k));
  return { label, value, change };
}

/** The sentences that say what these figures are. Only what is actually known. */
function contextOf(ev: any): string[] {
  const out: string[] = [];
  const s = ev?.summary || {};
  const period = ev?.period ?? s.period;
  const scope = ev?.scope ?? s.scope;
  if (period) out.push(typeof period === 'object' ? `${period.from} to ${period.to}` : String(period));
  if (scope) out.push(String(scope));
  return out;
}

export function deriveView(ev: any, limit = 8): View | null {
  const raw = rowsOf(ev);
  if (!raw.length) return null;
  const { label, value, change } = columns(raw);
  if (!label || !value) return null;

  const all: ViewRow[] = raw
    .filter((r) => r && typeof r === 'object' && r[label] != null)
    .map((r, i) => ({
      label: String(r[label]),
      value: String(r[value] ?? ''),
      n: Math.abs(toNum(r[value])),
      change: change && r[change] != null && r[change] !== '—' ? String(r[change]) : undefined,
      changeN: change ? toNum(r[change]) : undefined,
      rank: i + 1,
    }));
  if (!all.length) return null;

  // A total we were given beats one we computed; a total we can compute beats none. Both are
  // arithmetic — neither is ever asked of the model.
  const givenTotal = ev?.summary?.total ?? ev?.data?.total;
  const summed = all.reduce((t, r) => t + r.n, 0);
  const totalN = givenTotal != null ? Math.abs(toNum(givenTotal)) : summed;
  const total = givenTotal != null ? String(givenTotal) : undefined;

  const rows = all.slice(0, limit);
  if (totalN > 0) for (const r of rows) r.share = r.n / totalN;

  const view: View = { rows, context: contextOf(ev) };
  if (total) { view.total = total; view.totalN = totalN; }
  else if (totalN > 0 && all.length > 1) view.totalN = totalN;

  // the tail, stated rather than silently dropped
  if (all.length > rows.length) {
    const rest = all.slice(rows.length);
    view.hidden = { count: rest.length };
    if (totalN > 0) view.hidden.value = `${Math.round(rest.reduce((t, r) => t + r.n, 0) / totalN * 100)}%`;
  }
  // concentration — the answer to "is 9 a lot", which no artifact has ever stated
  if (all.length > 4 && totalN > 0) {
    const topN = Math.min(5, rows.length);
    const share = rows.slice(0, topN).reduce((t, r) => t + r.n, 0) / totalN;
    if (share < 0.999) view.concentration = { topN, share };
  }
  if (ev?.means) view.means = String(ev.means);
  return view;
}

export const pctOf = (share: number) => `${share < 0.01 ? '<1' : Math.round(share * 100)}%`;
