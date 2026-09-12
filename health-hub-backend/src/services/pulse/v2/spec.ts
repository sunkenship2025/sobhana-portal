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
import { resolveRanked, resolveTerm, concepts, MIN_CONFIDENCE } from '../knowledge';
import { periods } from '../diagnostic';
import { scopeOf, restrictsBy } from './sqlscope';

export interface ScopeConstraint {
  /** what the owner said — "lab", "chintal", "only cash" */
  term: string;
  /** the dimension it resolved to, e.g. domain, branch, payment_type */
  dimension: string;
  /** the literal it must filter on, e.g. DIAGNOSTICS, CNT */
  value: string;
  /** HOW we got from the owner's word to that literal, and how sure we are. A constraint is only
   *  ENFORCED when the resolution is solid — "CT-BRAIN PLAIN" once resolved to the lab code CT on
   *  a substring match and the validator then forced `test = CT` into three separate queries,
   *  turning one bad lookup into a whole turn of wrong answers. A guess may guide a query; only a
   *  confident resolution may gate one. */
  how?: string;
  confidence?: number;
  /** when the term covers several literals — "my business" is CNT and BLN, not a branch called
   *  "CNT,BLN". Defaults to [value]; every one of them must survive into the SQL. */
  values?: string[];
}
/**
 * When the question is about. Resolved to real dates during grounding, because "last week" is
 * not a contract — two dates are. The original failure this whole file exists for was
 * "last week's lab collection at Chintal": scope was verified and time never was, so a query
 * that honoured the branch and the domain but silently used the wrong window still passed.
 */
export interface TimeConstraint {
  /** what the owner said */
  phrase?: string;
  /** what the analyst called it: month, last-month, last-7-days, 2026-08 */
  period: string;
  /** the window it resolves to — inclusive start, EXCLUSIVE end, both IST dates */
  from?: string;
  to?: string;
  /** whole days in the window, for recognising a relative expression */
  days?: number;
}

export interface AnalysisSpec {
  goal: string;
  measure?: { concept: string; metric?: string | null };
  scope: ScopeConstraint[];
  time?: TimeConstraint;
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

export interface SpecCheck { ok: boolean; missing: ScopeConstraint[]; timeMissing?: TimeConstraint; note?: string }

/**
 * Did the query restrict to the window the spec committed to? A query may express the same
 * window three ways — the literal dates, a relative CURRENT_DATE expression, or date_trunc — so
 * this accepts any of them, and only fails when the SQL restricts NO time column at all or
 * restricts one to a window that is plainly not the one asked for.
 */
const PERIOD_WORD = /\b(today|yesterday|now|week|weeks|month|months|quarter|year|years|day|days|period|fortnight|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|ytd|mtd|since|until|between|last|past|previous|this|current|recent|so far)\b|\d{4}-\d{2}|\d{1,2}\/\d{1,2}/i;
const ALL_TIME = /\b(all[- ]?time|ever|lifetime|in total|overall|to date|since (we |the )?(start|beginning|opening)|entire history)\b/i;

function timeHonoured(t: TimeConstraint | undefined, sql: string): boolean {
  if (!t || (!t.from && !t.days)) return true;
  // "total net billed all time" has no window, and forcing one turned a correct all-time figure
  // into a month-to-date one. A guard that makes a right answer wrong is worse than no guard.
  if (ALL_TIME.test(t.phrase || '') || ALL_TIME.test(t.period || '')) return true;
  // Only verify a period the OWNER asked for. A planner default is not a commitment, and
  // enforcing it would be the validator inventing a constraint rather than checking one.
  // Nor is a mislabel: "ik there is gorowth" arrived as the owner's time phrase, resolved to
  // month-to-date, and was then enforced on a question about doctors who STOPPED referring —
  // a window in which, by definition, they have no revenue. The owner's words bind us only when
  // they actually name a period.
  if (!t.phrase || !PERIOD_WORD.test(t.phrase)) return true;
  const s = String(sql);
  // does it restrict a time column at all?
  const touchesTime = /"?(transactionDate|billedAt|createdAt|finalizedAt|occurredAt|updatedAt|cancelledAt|sentAt)"?/i.test(s)
    || /\bdate_trunc\s*\(/i.test(s) || /CURRENT_DATE|now\s*\(\)/i.test(s);
  if (!touchesTime) return false;
  if (t.from && s.includes(t.from)) return true;
  if (t.to && s.includes(t.to)) return true;
  // a relative window of the right length: CURRENT_DATE - 30, interval '30 days'
  if (t.days) {
    const rel = new RegExp(`(CURRENT_DATE|now\\(\\))\\s*-\\s*(interval\\s*')?${t.days}( days?')?`, 'i');
    if (rel.test(s)) return true;
    const near = new RegExp(`\\b(${t.days - 1}|${t.days}|${t.days + 1})\\s*days?\\b`, 'i');
    if (near.test(s)) return true;
  }
  // a month named in the spec, written as a month boundary
  if (/^\d{4}-\d{2}$/.test(t.period) && s.includes(t.period)) return true;
  // date_trunc on the right unit is an honest expression of month/week to date
  if (/month/i.test(t.period) && /date_trunc\s*\(\s*'month'/i.test(s)) return true;
  if (/week/i.test(t.period) && /date_trunc\s*\(\s*'week'/i.test(s)) return true;
  return false;
}

/**
 * Did the SQL honour the spec? Deterministic: for each scope constraint, the query must mention
 * both the dimension's column and the literal value. Never guesses intent — it only checks that
 * what we committed to in the spec survived into the query.
 */
export function verifySpec(spec: AnalysisSpec | null | undefined, sql: string): SpecCheck {
  if (!sql || (!spec?.scope?.length && !spec?.time)) return { ok: true, missing: [] };
  const s = String(sql);
  /* Does the constraint restrict the rows the ANSWER is computed from, or merely appear in the
     text? A string search cannot tell those apart, and they come apart in the one case where
     being wrong is invisible — a filter inside a CTE nothing references. On real generated SQL
     this parses 100% of the time; when it does not, we fall back to the string check rather than
     reject a query we only failed to understand. */
  const scope = scopeOf(s);
  const timeMissing = timeHonoured(spec?.time, s) ? undefined : spec?.time;
  const missing = spec.scope.filter((c) => {
    if (!c?.dimension || !c?.value) return false;
    // Only a resolution we stand behind may reject a query. An unconfident one is a hint.
    if (c.confidence != null && c.confidence < MIN_CONFIDENCE) return false;
    const col = COLUMNS[c.dimension];
    const hasCol = col ? col.test(s) : new RegExp(`"?${c.dimension}"?`, 'i').test(s);
    if (DERIVED.has(c.dimension)) return !hasCol;
    // every literal, case-insensitively, in a quoted or IN-list form. A multi-value constraint
    // was checked as one string: the SQL said IN ('CNT','BLN') and the check looked for the
    // literal 'CNT,BLN', so five correct queries were rejected for dropping a constraint they
    // had honoured. A validator that rejects correct work is worse than no validator.
    const hasVal = (c.values?.length ? c.values : [c.value]).every((one) =>
      scope.parsed ? restrictsBy(scope, String(one)) : (() => {
        const v = String(one).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`'${v}'`, 'i').test(s) || new RegExp(`\\b${v}\\b`, 'i').test(s);
      })());
    return !(hasCol && hasVal);
  });
  const notes = [
    missing.length ? `the query does not restrict to ${missing.map((m) => `${m.dimension} = ${m.value} (the owner said "${m.term}")`).join(' and ')}` : '',
    timeMissing ? `the query does not restrict to ${timeMissing.phrase || timeMissing.period}${timeMissing.from ? ` (${timeMissing.from} up to ${timeMissing.to})` : ''} — a figure for the wrong period is a wrong answer even when every other filter is right` : '',
  ].filter(Boolean);
  return { ok: missing.length === 0 && !timeMissing, missing, timeMissing,
    note: notes.length ? notes.join('; ') : undefined };
}

/** A repair instruction naming exactly what went missing. */
export function specRepairHint(check: SpecCheck): string {
  if (!check.missing.length && check.timeMissing) {
    const t = check.timeMissing;
    return `The query must restrict its time column to ${t.phrase || t.period}`
      + (t.from ? `: >= '${t.from}' and < '${t.to}', in IST.` : '.')
      + ' Add the period filter and keep everything else.';
  }
  return `The query must restrict to ${check.missing.map((m) => DERIVED_SETS[m.value]
    ? `o."payoutCategorySnapshot" IN (${DERIVED_SETS[m.value]})`
    : `${DIMS[m.dimension] || m.dimension} = '${m.value}'`).join(' AND ')}. `
    + `The owner asked for ${check.missing.map((m) => `"${m.term}"`).join(' and ')}, so a total that includes anything else is the wrong answer. Add the filter and keep everything else.`;
}

/** The literals a dimension actually takes, from the live semantic index. */
const valuesFor = (dim: string) =>
  new Set(concepts().filter((c) => c.dimension === dim && c.value).map((c) => String(c.value)));

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
    const hit = resolveRanked(c?.term || '').find((r) => r.score >= MIN_CONFIDENCE && r.dimension && r.value);
    if (hit) { scope.push({ term: c.term, dimension: hit.dimension!, value: hit.value!, how: hit.how, confidence: hit.score }); continue; }
    // The same bug wearing a new costume. "ultrasound" got through because the DIMENSION name was
    // valid; so did branch = "CNT,BLN", which is not a branch but two, and which then became a
    // hard gate every correct query failed. A valid dimension is not a grounded constraint — the
    // VALUE has to exist too, and an ungrounded one is dropped rather than enforced, because
    // enforcing a constraint we cannot verify is how a validator manufactures wrong answers.
    if (!c?.dimension || !c?.value || !DIMS[c.dimension]) continue;
    const known = valuesFor(c.dimension);
    const values = String(c.value).split(',').map((v) => v.trim()).filter((v) => v && (!known.size || known.has(v)));
    if (!values.length) continue;
    // The planner's own guess. It may be right, and it may be "CT" for a question about
    // CT-BRAIN PLAIN. It gets to shape the query; it does not get to gate it.
    scope.push({ term: c.term, dimension: c.dimension, value: values[0], values, how: 'planner', confidence: 0.25 });
  }
  const metric = spec.measure?.metric && METRICS[spec.measure.metric] ? spec.measure.metric : null;

  // Resolve the period to real dates. "last week" is not something a validator can check; a
  // window is. periods() is the same resolver the registry tools use, so the free-SQL path and
  // the deterministic path cannot disagree about what the owner's words meant.
  let time = spec.time;
  if (time?.period) {
    try {
      const p = periods(time.period);
      time = { ...time, from: p.cur.from, to: p.cur.to, days: (p as any).days };
    } catch { /* an unparseable period stays unverifiable rather than becoming wrong */ }
  }

  return { ...spec, scope, time, measure: spec.measure ? { ...spec.measure, metric } : undefined };
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

/**
 * RETROACTIVE CORRECTION — a resolution found to be wrong must take its figures with it.
 *
 * The failure: asked what CT-BRAIN PLAIN had billed, Pulse answered Rs 1,918 — the clotting-time
 * figure. Asked again a minute later it worked out exactly what had gone wrong and SAID SO:
 * "the name resolver mapped CT-BRAIN PLAIN to the lab test CT (Clotting Time), which is wrong for
 * a brain scan". And then it left the Rs 1,918 standing. A correction that lives in prose while
 * the number it disproves is still on screen is not a correction; it is a footnote on a lie.
 *
 * So when a later step resolves a term better than the spec did, the spec is amended and every
 * piece of evidence that filtered on the disowned literal is WITHDRAWN — it stops being usable,
 * stops being renderable, and its requirements go back to unmet, which is what makes the loop go
 * and fetch the right number rather than narrate the wrong one.
 */
export function recheckScope(spec: AnalysisSpec | null | undefined, fresh: any[], all: any[]):
  { term: string; from: string; to: string }[] {
  const fixes: { term: string; from: string; to: string }[] = [];
  const same = (a: string, b: string) => String(a || '').toLowerCase().trim() === String(b || '').toLowerCase().trim();
  for (const e of fresh || []) {
    if (e?.tool !== 'resolve' || !e.ok) continue;
    for (const r of (Array.isArray(e.data) ? e.data : []) as any[]) {
      const c = (spec?.scope || []).find((x) => same(x.term, r?.term));
      if (!c || !r?.value || typeof r.confidence !== 'number') continue;
      if (r.confidence < MIN_CONFIDENCE || String(r.value) === String(c.value)) continue;
      if (r.confidence <= (c.confidence ?? 0)) continue;          // not actually better
      fixes.push({ term: c.term, from: String(c.value), to: String(r.value) });
      c.value = String(r.value); c.values = undefined; c.how = r.how; c.confidence = r.confidence;
    }
  }
  for (const f of fixes) {
    const lit = new RegExp(`'${f.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'i');
    for (const e of all || []) {
      if (!e?.ok || !e.sql || !lit.test(e.sql)) continue;
      e.ok = false;
      e.error = `withdrawn — this was filtered on ${f.term} = ${f.from}, which has since resolved to ${f.to}`;
    }
  }
  return fixes;
}
