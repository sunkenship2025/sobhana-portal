/**
 * BINDING — the boundary between what the owner meant and how SQL implements it.
 *
 * The defect this exists to close: completeSpec resolves "CT-BRAIN PLAIN" to CTBP with confidence
 * 1, resolves "last month" to two real IST dates — and then tools.ts calls generate(k, q) with
 * nothing but the question text. Everything resolved is discarded, the generator re-derives the
 * meaning from English, and verifySpec tries to recognise whatever it produced. That is
 * SQL → semantics → decision, backwards, and it is why the verifier has had to learn aliases,
 * then LIKE patterns, then predicate breadth. Each patch teaches it one more dialect of a
 * question that was already answered upstream.
 *
 * AnalysisSpec stays what it is: semantic meaning. QueryBinding is a separate thing — an
 * implementation contract handed forward to the stage that writes SQL. They are deliberately not
 * the same type and the spec gains no SQL fields, because the moment a column name appears in
 * AnalysisSpec the two jobs are merged again.
 *
 * PHASE 1 IS TIME ONLY. Time has no joins, no aliases, no derived CASE expressions — it is the
 * cheapest possible test of whether a typed binding survives the generator at all. Scope waits
 * until that question has an answer, because scope carries the whole DIMS problem (br.code
 * presupposes a join; modality is a twelve-line CASE) and there is no point designing for it
 * before knowing the mechanism works.
 */
import { PERIOD_WORD, ALL_TIME, type AnalysisSpec } from './spec';

/**
 * How much force a binding carries. A named type rather than a confidence threshold, because a
 * threshold is a number someone tunes and `if (binding) useBinding(binding)` is a regression
 * nobody notices. The distinction has to be unmissable in the type system.
 */
export type BindingAuthority = 'authoritative' | 'advisory' | 'unresolved';

export interface TimeBinding {
  kind: 'time';
  authority: BindingAuthority;
  /** the owner's own words, when they said any */
  phrase?: string;
  /** what the analyst called it — month, last-month, 2026-08 */
  period: string;
  /** inclusive start, exclusive end, both IST dates */
  start: string;
  end: string;
  timezone: 'Asia/Kolkata';
}

export type QueryBinding = TimeBinding;      // scope joins this union in phase 2

/**
 * WHO SAID SO. Authority for time cannot come from `how`/`confidence` — there is no ranked
 * resolution for periods; completeSpec calls periods() on whatever label the ANALYST wrote. So
 * every time binding would default to authoritative, which is exactly the hardening this design
 * exists to prevent: the planner's invented period would become a hard constraint.
 *
 * The signal already exists in timeHonoured: a period the OWNER named binds us, a planner default
 * does not. That guard is what stopped "ik there is gorowth" — a typo'd trailing clause the
 * analyst filed as the time phrase — becoming an enforced eleven-day window on a question about
 * doctors who had STOPPED referring, a period in which they have no revenue by definition.
 */
export function timeAuthority(t: AnalysisSpec['time']): BindingAuthority {
  if (!t?.from || !t?.to) return 'unresolved';               // nothing concrete to bind to
  if (ALL_TIME.test(t.phrase || '') || ALL_TIME.test(t.period || '')) return 'unresolved';
  if (!t.phrase) return 'advisory';                          // a planner default is not a commitment
  return PERIOD_WORD.test(t.phrase) ? 'authoritative' : 'advisory';
}

/** AnalysisSpec → QueryBinding[]. The one place semantic meaning becomes an implementation contract. */
export function compileBindings(spec: AnalysisSpec | null | undefined): QueryBinding[] {
  const out: QueryBinding[] = [];
  const t = spec?.time;
  if (t?.from && t?.to) {
    const authority = timeAuthority(t);
    if (authority !== 'unresolved')
      out.push({ kind: 'time', authority, phrase: t.phrase, period: t.period,
        start: t.from, end: t.to, timezone: 'Asia/Kolkata' });
  }
  return out;
}

/**
 * The contract, as the generator will read it. Only AUTHORITATIVE bindings are stated as
 * instructions; advisory ones are offered as the working assumption and may be overridden, which
 * is the whole point of the distinction surviving into the prompt rather than being flattened.
 */
export function formatBindings(bindings: QueryBinding[]): string {
  if (!bindings.length) return '';
  const hard = bindings.filter((b) => b.authority === 'authoritative');
  const soft = bindings.filter((b) => b.authority === 'advisory');
  const lines: string[] = [];
  if (hard.length) {
    lines.push('AUTHORITATIVE BINDINGS — already resolved against live data. Use these literals exactly.');
    for (const b of hard) lines.push(`  the owner said "${b.phrase}" — restrict the time column to >= '${b.start}' AND < '${b.end}' in ${b.timezone}`);
  }
  if (soft.length) {
    lines.push('ASSUMED PERIOD — not stated by the owner. Use it unless the question implies otherwise.');
    for (const b of soft) lines.push(`  ${b.period}: >= '${b.start}' AND < '${b.end}' in ${b.timezone}`);
  }
  return lines.join('\n');
}
