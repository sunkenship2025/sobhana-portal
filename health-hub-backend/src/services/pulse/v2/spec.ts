/**
 * ANALYSIS SPEC — what the owner asked for, structured, before any SQL exists.
 *
 * The failure this exists to kill: "last week's lab collection at Chintal" answered with the
 * centre-wide total and labelled "lab collection". Every heuristic guard I tried caught some
 * cases and missed others, because they all asked "does this question look scoped?" rather than
 * "did the query do what we said we would do?".
 *
 * With a spec there is a contract. The analyst writes down the measure, the scope and the period,
 * carrying the owner's own word alongside the resolved value. The validator then checks the SQL
 * against that contract. A constraint in the spec that is absent from the SQL is a rejection, not
 * a warning — and the repair is told exactly which one went missing.
 */
import { DIMS, METRICS } from '../catalog';
import { resolveTerm } from '../knowledge';

export interface ScopeConstraint {
  /** what the owner said — "lab", "chintal", "only cash" */
  term: string;
  /** the dimension it resolved to, e.g. domain, branch, payment_type */
  dimension: string;
  /** the literal it must filter on, e.g. DIAGNOSTICS, CNT */
  value: string;
}
export interface AnalysisSpec {
  goal: string;
  measure?: { concept: string; metric?: string | null };
  scope: ScopeConstraint[];
  time?: { period: string; phrase?: string };
}

/** Column expressions a scope constraint may legitimately appear as, per dimension. */
const COLUMNS: Record<string, RegExp> = {
  domain: /\b(v|visit)\."?domain"?|"?domain"?\s*(=|in)/i,
  branch: /\bbr\."?(code|id)"?|"?Branch"?\b|"?branchId"?/i,
  payment_type: /"?paymentType"?/i,
  referring_doctor: /"?ReferralDoctor"?|"?referralDoctorId"?/i,
  test: /"?testCodeSnapshot"?|"?testDefinitionId"?/i,
  payout_category: /"?payoutCategorySnapshot"?/i,
  modality: /"?payoutCategorySnapshot"?/i,
  service_kind: /"?payoutCategorySnapshot"?/i,
};

/** Dimensions whose value is a rolled-up label rather than a literal in the data. 'IMAGING' and
 *  'Ultrasound' are names for a SET of payout categories, so the label itself never appears in
 *  the SQL — the categories it stands for do. Requiring the literal here rejected every correct
 *  query. For these the column is the whole check. */
const DERIVED = new Set(['modality', 'service_kind']);

/** What each rolled-up label actually means, for the repair instruction. */
const DERIVED_SETS: Record<string, string> = {
  IMAGING: `'Ultrasound','Ultrasound Tiffa','2D Echo','X-Ray','Dental X-Ray','CT / MRI'`,
  LABORATORY: `'Laboratory'`,
  Ultrasound: `'Ultrasound','Ultrasound Tiffa','2D Echo'`,
  'X-Ray': `'X-Ray','Dental X-Ray'`,
};

export interface SpecCheck { ok: boolean; missing: ScopeConstraint[]; note?: string }

/**
 * Did the SQL honour the spec? Deterministic: for each scope constraint, the query must mention
 * both the dimension's column and the literal value. Never guesses intent — it only checks that
 * what we committed to in the spec survived into the query.
 */
export function verifySpec(spec: AnalysisSpec | null | undefined, sql: string): SpecCheck {
  if (!spec?.scope?.length || !sql) return { ok: true, missing: [] };
  const s = String(sql);
  const missing = spec.scope.filter((c) => {
    if (!c?.dimension || !c?.value) return false;
    const col = COLUMNS[c.dimension];
    const hasCol = col ? col.test(s) : new RegExp(`"?${c.dimension}"?`, 'i').test(s);
    if (DERIVED.has(c.dimension)) return !hasCol;
    // the literal, case-insensitively, allowing a quoted or IN-list form
    const v = String(c.value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hasVal = new RegExp(`'${v}'`, 'i').test(s) || new RegExp(`\\b${v}\\b`, 'i').test(s);
    return !(hasCol && hasVal);
  });
  return { ok: missing.length === 0, missing,
    note: missing.length ? `the query does not restrict to ${missing.map((m) => `${m.dimension} = ${m.value} (the owner said "${m.term}")`).join(' and ')}` : undefined };
}

/** A repair instruction naming exactly what went missing. */
export function specRepairHint(check: SpecCheck): string {
  return `The query must restrict to ${check.missing.map((m) => DERIVED_SETS[m.value]
    ? `o."payoutCategorySnapshot" IN (${DERIVED_SETS[m.value]})`
    : `${DIMS[m.dimension] || m.dimension} = '${m.value}'`).join(' AND ')}. `
    + `The owner asked for ${check.missing.map((m) => `"${m.term}"`).join(' and ')}, so a total that includes anything else is the wrong answer. Add the filter and keep everything else.`;
}

/** Fill in scope the analyst named but did not resolve, from the live semantic index. */
export function completeSpec(spec: AnalysisSpec | null | undefined): AnalysisSpec | null {
  if (!spec) return null;
  const scope: ScopeConstraint[] = [];
  for (const c of spec.scope || []) {
    // Live data beats the planner's guess. "ultrasound" was arriving as
    // {dimension:'test', value:'ultrasound'} — a test code that does not exist — and because the
    // dimension NAME was valid it passed straight through unchecked. verifySpec then did its job
    // and forced o."testCodeSnapshot" = 'ultrasound' into the SQL to satisfy the constraint, so
    // the owner got a confident 0 instead of 265. A validator that can only check a constraint
    // reached the SQL will happily enforce a wrong one; the constraint itself has to be grounded
    // first. Only fall back to what the planner wrote when the term resolves to nothing.
    const hit = resolveTerm(c?.term || '')[0];
    if (hit?.dimension && hit.value) { scope.push({ term: c.term, dimension: hit.dimension, value: hit.value }); continue; }
    if (c?.dimension && c?.value && DIMS[c.dimension]) scope.push(c);
  }
  const metric = spec.measure?.metric && METRICS[spec.measure.metric] ? spec.measure.metric : null;
  return { ...spec, scope, measure: spec.measure ? { ...spec.measure, metric } : undefined };
}

/** One sentence saying exactly what a number represents — travels with it to the response. */
export function lineage(spec: AnalysisSpec | null, extra?: string): string {
  if (!spec) return extra || '';
  const bits: string[] = [];
  if (spec.measure?.concept) bits.push(spec.measure.concept);
  if (spec.scope?.length) bits.push(`for ${spec.scope.map((c) => `${c.term} (${c.dimension}=${c.value})`).join(' and ')}`);
  if (spec.time?.phrase || spec.time?.period) bits.push(`over ${spec.time.phrase || spec.time.period}`);
  return [bits.join(' '), extra].filter(Boolean).join(' · ');
}
