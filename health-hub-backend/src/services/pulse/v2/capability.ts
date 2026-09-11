/**
 * CAPABILITY-BASED RENDERING — the evidence decides what CAN be drawn; the analytical job
 * decides which of those is most useful. No regex, no keyword table, no central decision tree.
 *
 * What this replaces: a ladder of question patterns that chose the render family before anyone
 * had looked at the data. It failed within an hour of being written — "break down discounts in
 * the last 30 days by reason" matched the trend pattern (because of "last 30 days") before the
 * breakdown pattern was ever tested, and a split question was rendered as a time series. Another
 * phrase would have broken it next week. The model was never choosing the chart; an ordered list
 * of regexes was.
 *
 * Worse, the requirement was a NAME check. `checkAnswer` passed as soon as the string "waterfall"
 * appeared, but the waterfall renderer returns null when no row carries a delta — so a required
 * artifact could ship rendering nothing at all, and validation called it valid.
 *
 * Here a renderer that cannot truthfully represent the evidence is not a low-ranked candidate.
 * It is not a candidate. `requires` is a hard gate evaluated against the real shape of the rows.
 *
 * Three inputs, and no extra model call:
 *   the ANALYST says what the owner is trying to understand   (one field on the plan)
 *   the SYSTEM computes what structures the evidence supports  (deterministic, from the rows)
 *   the MATCHER scores the supported structures against the job (deterministic)
 */
import type { Evidence } from './tools';

/** What the owner is trying to understand. Decided by the analyst, not by matching words. */
export type AnalyticalJob =
  | 'magnitude'       // how big is it
  | 'comparison'      // this against that
  | 'composition'     // what is it made of
  | 'concentration'   // what accounts for most of it
  | 'attribution'     // what drove the change
  | 'progression'     // how has it moved over time
  | 'variability'     // how spread out, how consistent
  | 'conversion'      // how much survives each stage
  | 'relationship'    // does this move with that
  | 'ranking'         // who is top
  | 'enumeration'     // give me the rows
  | 'explanation'     // why — a narrative, which may need no artifact at all
  | 'opportunity';    // what should I fix — the only job that owes an economic estimate

export const JOBS: AnalyticalJob[] = ['magnitude', 'comparison', 'composition', 'concentration',
  'attribution', 'progression', 'variability', 'conversion', 'relationship', 'ranking',
  'enumeration', 'explanation', 'opportunity'];

/** The shape of what came back, read off the rows themselves. */
export interface EvidenceStructure {
  rowCount: number;
  cardinality: 'one' | 'few' | 'many';
  dimensions: 0 | 1 | 2;
  measures: number;
  hasDeltas: boolean;
  partsOfWhole: boolean;
  isTimeSeries: boolean;
  hasStages: boolean;
  numericSpread: boolean;
  seriesPerEntity: boolean;
  hasTarget: boolean;
}

// Only SEMANTIC ROLES are named here — whether a column is a delta or a share is a meaning, not
// a data type. What is a dimension and what is a measure is read off the VALUES, because a name
// whitelist is the same brittle keyword table this file exists to delete: it had "reason" in it
// and still scored dimensions=0, because a stray digit in a value made the column look numeric.
const KEY = {
  delta: /(change|delta|diff|movement|vs_?prev|^prev|^before|shareOfChange)/i,
  share: /(share|pct|percent|proportion)/i,
  time: /^(day|date|month|week|bucket|period|k)$/i,
};
const isDateish = (v: any) => typeof v === 'string' && /^\d{4}-\d{2}(-\d{2})?$/.test(v);
// A value is a number only if the WHOLE string is one — "₹28,075" and "36.3%" are, "R0" and
// "NOREFARAL" are not. Stripping non-digits first turned "R0" into 0 and every text column into
// a measure.
const NUMERIC = /^[\s₹$]*-?[\d,]+(\.\d+)?[\s%]*$/;
const toNum = (v: any) => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const t = String(v ?? '').trim();
  if (!NUMERIC.test(t)) return NaN;
  const n = Number(t.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
/** A column's role, decided by what most of its values actually are. */
const columnIsNumeric = (list: any[], k: string) => {
  const vals = list.slice(0, 40).map((r) => r?.[k]).filter((v) => v != null && v !== '');
  if (!vals.length) return false;
  return vals.filter((v) => Number.isFinite(toNum(v))).length / vals.length >= 0.8;
};

/** Deterministic. Never looks at the question — only at what the analysis actually produced. */
export function describeEvidence(e: Evidence): EvidenceStructure {
  const s: any = e.summary || {};
  const rows: any[] = (e.data as any)?.rows ?? s.rows ?? s.parts ?? s.top ?? s.byBranch ?? [];
  const list = Array.isArray(rows) ? rows : [];
  const rowCount = list.length;
  const first = list.find((r) => r && typeof r === 'object') || {};
  const keys = Object.keys(first);

  const numericKeys = keys.filter((k) => columnIsNumeric(list, k));
  const nameKeys = keys.filter((k) => !numericKeys.includes(k) && !Array.isArray(first[k]));
  const timeKey = keys.find((k) => KEY.time.test(k) && (isDateish(first[k]) || e.tool === 'trend'));

  const hasDeltas = keys.some((k) => KEY.delta.test(k) && list.some((r) => { const n = toNum(r[k]); return Number.isFinite(n) && n !== 0; }))
    || (s.now != null && s.before != null);
  const partsOfWhole = (s.total != null || keys.some((k) => KEY.share.test(k)))
    && rowCount > 1 && numericKeys.length > 0 && nameKeys.length > 0;
  const isTimeSeries = e.tool === 'trend' || (!!timeKey && rowCount > 2);
  const hasStages = Array.isArray(s.stages) && s.stages.length > 1;
  const seriesPerEntity = keys.some((k) => Array.isArray(first[k]) && (first[k] as any[]).length > 2);

  // a numeric column worth showing the spread of: enough rows, and actual variance
  let numericSpread = false;
  if (rowCount >= 6) {
    for (const k of numericKeys) {
      if (KEY.share.test(k) || KEY.delta.test(k)) continue;
      const vals = list.map((r) => toNum(r[k])).filter(Number.isFinite);
      if (vals.length < 6) continue;
      const lo = Math.min(...vals), hi = Math.max(...vals);
      if (hi > lo && (hi - lo) / (Math.abs(hi) || 1) > 0.15) { numericSpread = true; break; }
    }
  }

  return {
    rowCount,
    cardinality: rowCount <= 1 ? 'one' : rowCount <= 7 ? 'few' : 'many',
    dimensions: (nameKeys.length > 1 ? 2 : nameKeys.length === 1 ? 1 : 0) as 0 | 1 | 2,
    measures: Math.max(numericKeys.filter((k) => !KEY.delta.test(k) && !KEY.share.test(k)).length, s.value != null ? 1 : 0),
    hasDeltas, partsOfWhole, isTimeSeries, hasStages, numericSpread, seriesPerEntity,
    hasTarget: s.target != null || s.expected != null || s.baseline != null,
  };
}

export interface RendererCapability {
  type: string;
  /** hard gates. Unsatisfied means NOT A CANDIDATE — never a low score. */
  requires: Partial<Record<keyof EvidenceStructure, any>>;
  /** the analytical jobs this structure genuinely expresses */
  expresses: AnalyticalJob[];
  /** soft signals: structure this renderer uses well when present */
  prefers?: (keyof EvidenceStructure)[];
  /** comfortable row range — outside it the thing is drawable but hard to read */
  rows?: [number, number];
}

/**
 * Adding a renderer means adding one entry here and one case in the frontend switch. Nothing in
 * the selection logic changes, which is the whole point — the previous design needed an edit to
 * a central ordered table for every new type, and that table is what kept breaking.
 */
export const CAPABILITIES: RendererCapability[] = [
  { type: 'kpi', requires: { cardinality: 'one' }, expresses: ['magnitude'], rows: [0, 1] },
  { type: 'compare', requires: { hasDeltas: true, cardinality: 'one' }, expresses: ['comparison', 'magnitude'], rows: [0, 2] },
  { type: 'waterfall', requires: { hasDeltas: true, dimensions: 1 }, expresses: ['attribution', 'explanation'],
    prefers: ['hasDeltas'], rows: [2, 10] },
  { type: 'pareto', requires: { partsOfWhole: true, dimensions: 1 }, expresses: ['concentration', 'attribution'],
    prefers: ['partsOfWhole'], rows: [4, 20] },
  { type: 'breakdown', requires: { dimensions: 1 }, expresses: ['composition', 'concentration', 'comparison'],
    prefers: ['partsOfWhole'], rows: [2, 12] },
  { type: 'ranking', requires: { dimensions: 1 }, expresses: ['ranking', 'concentration'], rows: [2, 20] },
  { type: 'chart', requires: { isTimeSeries: true }, expresses: ['progression'], prefers: ['isTimeSeries'], rows: [3, 60] },
  { type: 'funnel', requires: { hasStages: true }, expresses: ['conversion'], prefers: ['hasStages'], rows: [0, 8] },
  { type: 'distribution', requires: { numericSpread: true }, expresses: ['variability'], prefers: ['numericSpread'], rows: [6, 5000] },
  { type: 'table', requires: { dimensions: 1 }, expresses: ['enumeration', 'comparison', 'composition'], rows: [1, 200] },
];

export interface Candidate { type: string; score: number; why: string }

/** Is every hard gate satisfied? */
function admissible(cap: RendererCapability, st: EvidenceStructure): boolean {
  for (const [k, want] of Object.entries(cap.requires)) {
    const got = (st as any)[k];
    if (typeof want === 'boolean') { if (got !== want) return false; }
    else if (typeof want === 'number') { if (Number(got) < Number(want)) return false; }
    else if (got !== want) return false;
  }
  return true;
}

/**
 * Rank what CAN be drawn by how well it serves the job. Capability fit is a gate, so everything
 * scored here is already a truthful representation of the evidence; the score only decides which
 * truthful option is most useful.
 */
export function rankRenderers(e: Evidence, job: AnalyticalJob | null | undefined, askedFor?: string): Candidate[] {
  const st = describeEvidence(e);
  const out: Candidate[] = [];
  for (const cap of CAPABILITIES) {
    if (!admissible(cap, st)) continue;
    let score = 0; const why: string[] = [];

    // job fit — the dominant term, but never the only one
    if (job && cap.expresses.includes(job)) { score += 0.45; why.push(`expresses ${job}`); }
    else if (job) score += 0.08;
    else score += 0.2;

    // does it use the richest structure available?
    const used = (cap.prefers || []).filter((p) => !!(st as any)[p]).length;
    if (used) { score += 0.15 * Math.min(used, 2); why.push('uses the structure present'); }

    // readability: comfortable row count
    const [lo, hi] = cap.rows || [0, 1e9];
    if (st.rowCount >= lo && st.rowCount <= hi) { score += 0.15; why.push('reads well at this size'); }
    else score -= 0.1;

    // cardinality fit
    if (cap.requires.cardinality === st.cardinality) score += 0.08;

    // the owner asked for something by name
    if (askedFor && new RegExp(`\\b${cap.type}\\b`, 'i').test(askedFor)) { score += 0.2; why.push('the owner asked for it'); }

    out.push({ type: cap.type, score: Number(score.toFixed(3)), why: why.join(', ') || 'valid for this evidence' });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The renderable options across every usable step, best first, de-duplicated by type. */
export function renderOptions(evidence: Evidence[], job: AnalyticalJob | null | undefined, askedFor?: string):
  { type: string; step: number; score: number; why: string }[] {
  const all: { type: string; step: number; score: number; why: string }[] = [];
  for (const e of evidence) {
    if (!e.ok) continue;
    for (const c of rankRenderers(e, job, askedFor)) all.push({ ...c, step: e.step });
  }
  all.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  return all.filter((c) => (seen.has(c.type) ? false : (seen.add(c.type), true))).slice(0, 6);
}
