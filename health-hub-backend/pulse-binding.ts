/**
 * PHASE 1 — does a typed binding survive the generator?
 *
 * completeSpec resolves "last month" to two real IST dates before any SQL exists. Until now that
 * was discarded at tools.ts:239 — generate(k, q) received the question text and nothing else — so
 * the generator re-derived the period from English and verifySpec tried to recognise whichever of
 * three syntactic forms came back. This measures whether handing it the dates changes that.
 *
 * TIME ONLY, deliberately. No joins, no aliases, no derived CASE expressions. It is the cheapest
 * possible test of the MECHANISM, and if a binding this simple does not survive, scope binding was
 * never going to work and we have learned it in an afternoon rather than a week.
 *
 * TWO METRICS, which answer different questions and must not be averaged together:
 *
 *   ADHERENCE    the bound literal dates appear in a predicate on the relation the answer is
 *                computed from. Tests the GENERATOR — did it obey the contract?
 *
 *   CORRECTNESS  the query restricts the intended window, in ANY honest form (literal dates, a
 *                relative CURRENT_DATE expression, date_trunc). Tests the COMPILER — was the
 *                window we resolved the right one?
 *
 * High correctness must not rescue low adherence. A generator that reaches the right window by
 * its own reasoning has not demonstrated it obeys a binding, and reading it as if it had is how
 * you proceed to scope on a mechanism that was never being followed.
 *
 *   npx ts-node --transpile-only pulse-binding.ts
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';
import { compileBindings } from './src/services/pulse/v2/binding';
import { verifySpec } from './src/services/pulse/v2/spec';
import { scopeOf, verifyTimeWindow } from './src/services/pulse/v2/sqlscope';

/** PRE-REGISTERED, before any result is seen. */
const GATE = 0.80;

interface Case { q: string; why: string; expect: 'authoritative' | 'advisory' | 'none' }
const CASES: Case[] = [
  { q: 'how much did we collect last month', why: 'the plainest owner-named period', expect: 'authoritative' },
  { q: 'what was last week collection chintal only lab', why: 'period alongside two scope constraints', expect: 'authoritative' },
  { q: 'how much did we collect in august', why: 'a month by name', expect: 'authoritative' },
  { q: 'how much did we collect yesterday', why: 'a single day', expect: 'authoritative' },
  { q: 'how much did we collect in the last 30 days', why: 'a trailing window — the form most likely written relatively', expect: 'authoritative' },
  { q: 'what is turnover of this month', why: 'a current, incomplete period', expect: 'authoritative' },
  { q: 'how many scans last month in chintal', why: 'a count rather than money', expect: 'authoritative' },
  { q: 'break down discounts at chintal in the last 30 days by reason', why: 'a breakdown, period must survive the grouping', expect: 'authoritative' },
  // must emit NO binding — the guards
  { q: 'what is our total net billed all time', why: 'all-time has no window to bind', expect: 'none' },
  { q: 'how many branches do we have', why: 'no period asked for, none may be invented', expect: 'none' },
];

const pct = (n: number, d: number) => d ? `${Math.round(n / d * 100)}%` : '—';

(async () => {
  console.log(`PRE-REGISTERED GATE: >= ${Math.round(GATE * 100)}% authoritative adherence → proceed to scope binding.`);
  console.log(`Below that, fix the binding mechanism — placement, format, or post-generation injection.\n`);

  let emitted = 0, adherent = 0, correct = 0, wrongAuthority = 0;
  for (const c of CASES) {
    let a: any;
    try { a = await ask(c.q, {}); } catch (e: any) { console.log(`✗ THREW  ${c.q}  ${e?.message}`); continue; }
    const spec = a?.trace?.plan?.spec ?? a?.spec ?? null;
    const bindings = compileBindings(spec);
    const b = bindings[0];
    const got = !b ? 'none' : b.authority;
    const sqls: string[] = (a.evidence || []).filter((e: any) => e.ok && e.sql).map((e: any) => e.sql);

    if (got !== c.expect) wrongAuthority++;
    let line = `${got === c.expect ? '✓' : '✗'} ${String(got).padEnd(14)} ${c.q.slice(0, 52)}`;

    if (b?.authority === 'authoritative' && sqls.length) {
      emitted++;
      const ad = sqls.some((s) => verifyTimeWindow(scopeOf(s), b.start, b.end).adherent);
      const co = sqls.some((s) => !verifySpec(spec, s).timeMissing);
      if (ad) adherent++;
      if (co) correct++;
      line += `  ${b.start}→${b.end}  adherence ${ad ? 'YES' : 'no '}  correct ${co ? 'YES' : 'no '}`;
      if (!ad && sqls[0]) {
        const r = scopeOf(sqls[0]).effective.filter((p) => p.mode === 'range');
        line += `\n     ranges seen: ${r.map((p) => `${p.column} ${p.operator} ${p.values.join('..')}`).join(' · ') || 'none'}`;
      }
    } else if (b?.authority === 'authoritative') {
      line += '  (no SQL produced — not counted)';
    }
    console.log(line);
  }

  console.log(`\n${'═'.repeat(66)}`);
  console.log(`authoritative bindings emitted with SQL:  ${emitted}`);
  console.log(`  effective literal adherence:            ${adherent} / ${emitted} = ${pct(adherent, emitted)}`);
  console.log(`  semantic window correctness:            ${correct} / ${emitted} = ${pct(correct, emitted)}`);
  console.log(`authority classified wrongly:             ${wrongAuthority} / ${CASES.length}`);
  const rate = emitted ? adherent / emitted : 0;
  console.log(`\nDECISION: ${rate >= GATE
    ? `adherence ${pct(adherent, emitted)} >= ${Math.round(GATE * 100)}% → PROCEED to scope binding`
    : `adherence ${pct(adherent, emitted)} < ${Math.round(GATE * 100)}% → FIX THE BINDING MECHANISM, do not proceed`}`);
  if (emitted && correct / emitted > rate + 0.2)
    console.log(`NOTE: correctness materially exceeds adherence — the generator is reaching the right\n      window by its own reasoning, not by obeying the binding. That is not a pass.`);
  process.exit(0);
})();
