/**
 * SCOPE BASELINE — does the generator already get the filter right on its own?
 *
 * Deliberately measures the UNBOUND path only. The question is not "does binding work" but
 * "is there anything for binding to fix" — and building the DIMS compiler (predicate + required
 * joins + derived CASE semantics) to find out would be the mistake the time pilot just taught.
 * Time's unbound baseline was 83%, so binding bought one case in six. If scope is also 83% the
 * same will be true and the compiler is not worth it.
 *
 * Three outcomes, not two, because "wrong" has different repairs:
 *   CORRECT   restricts to the resolved value (exact, IN, or a pattern bounded BY that value)
 *   BROAD     restricts, but to something wider — ILIKE '%CT%' when CT-BRAIN PLAIN was asked
 *   MISSING   no predicate restricts the rows the answer is computed from
 *
 *   npx ts-node --transpile-only pulse-scope.ts
 */
import 'dotenv/config';
import { ensureKnowledge, resolveTerm } from './src/services/pulse/knowledge';
import { generate } from './src/services/pulse/sqlPath';
import { scopeOf, verifyConstraint } from './src/services/pulse/v2/sqlscope';

const GATE = 0.80;   // pre-registered: at or above this, do not build scope binding

/** term the owner used → the literal it resolves to, plus every alias that also expresses it */
const CASES: { q: string; term: string; why: string }[] = [
  { q: 'how much has CT-BRAIN PLAIN been billed for', term: 'CT-BRAIN PLAIN', why: 'name vs code, the coin flip' },
  { q: 'how many CT-BRAIN PLAIN orders were there last month', term: 'CT-BRAIN PLAIN', why: 'same identity, counting' },
  { q: 'collection at chintal yesterday', term: 'chintal', why: 'branch by spoken name' },
  { q: 'how many visits in balanagar this month', term: 'balanagar', why: 'the other branch' },
  { q: 'lab collection last week', term: 'lab', why: 'a synonym for a domain' },
  { q: 'how many ultrasound scans last month', term: 'ultrasound', why: 'a rolled-up modality, three payout categories' },
  { q: 'x-ray revenue in august', term: 'x-ray', why: 'a rolled-up modality, two categories' },
  { q: 'how much cash did we take last week', term: 'cash', why: 'a payment type' },
  { q: 'CT-BRAIN PLAIN revenue at chintal', term: 'CT-BRAIN PLAIN', why: 'test identity alongside a branch' },
  { q: 'how many ECG orders this month', term: 'ecg', why: 'a category the owner may name loosely' },
];

(async () => {
  console.log(`PRE-REGISTERED GATE: unbound scope correctness >= ${GATE * 100}% → do NOT build scope binding.`);
  console.log(`Below that, the generator needs telling and the DIMS compiler is justified.\n`);
  const k = await ensureKnowledge();
  let correct = 0, broad = 0, missing = 0, unresolvable = 0;

  for (const c of CASES) {
    const hits = resolveTerm(c.term);
    if (!hits.length) { unresolvable++; console.log(`— UNRESOLVABLE  "${c.term}" — nothing to measure against`); continue; }
    const want = String(hits[0].value);
    const aliases = [...new Set(hits.map((h) => String(h.value)).concat(hits.map((h) => h.term)))];

    const g = await generate(k, c.q, { bustCache: true } as any);
    const sc = scopeOf(g.sql);
    const any = aliases.map((a) => verifyConstraint(sc, a));
    const hit = any.find((v) => v.verified);
    const wide = any.find((v) => /broader/.test(v.reason || ''));

    let verdict: string;
    if (hit) { correct++; verdict = `CORRECT (${hit.mode})`; }
    else if (wide) { broad++; verdict = `BROAD — ${wide.reason}`; }
    else { missing++; verdict = 'MISSING — nothing restricts the result'; }
    console.log(`${hit ? '✓' : '✗'} ${String(want).padEnd(16)} ${verdict.slice(0, 62).padEnd(64)} ${c.q.slice(0, 34)}`);
    if (!hit) {
      const eff = sc.effective.filter((p) => p.mode !== 'range');
      console.log(`     effective: ${eff.map((p) => `${p.column} ${p.operator} ${p.values.slice(0,3).join('|')}`).join(' · ') || 'none'}`);
    }
  }

  const n = CASES.length - unresolvable;
  const pct = (x: number) => n ? `${Math.round(x / n * 100)}%` : '—';
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`measurable cases   ${n}`);
  console.log(`  CORRECT          ${correct} = ${pct(correct)}`);
  console.log(`  BROAD            ${broad} = ${pct(broad)}`);
  console.log(`  MISSING          ${missing} = ${pct(missing)}`);
  console.log(`\nDECISION: ${n && correct / n >= GATE
    ? `${pct(correct)} >= ${GATE * 100}% → the generator does not need telling. Do NOT build scope binding.`
    : `${pct(correct)} < ${GATE * 100}% → BUILD SCOPE BINDING (predicate + joins + derived sets)`}`);
  process.exit(0);
})();
