/**
 * REPLAY EVERY REAL ANSWER THROUGH TODAY'S CONTRACT CHECKS — no model calls.
 *
 * The traces in the audit log carry the question, the evidence each step returned, the spec, and
 * the exact sentences the owner was shown. checkAnswer is a pure function of those. So every
 * answer this system has ever given can be re-judged by the rules it has today, for free, and
 * the ones it would now refuse to ship are the defects that were actually reaching the owner.
 *
 * This is the closest thing to the adversarial suite that costs nothing: real questions, real
 * evidence, real prose — only the model's choices are frozen rather than re-made.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { checkAnswer } from './src/services/pulse/v2/contract';
import { audit } from './pulse-adversarial';

(async () => {
  const db = new PrismaClient();
  const rows = await db.auditLog.findMany({
    where: { entityType: 'PulseTrace' }, orderBy: { createdAt: 'desc' },
    take: Number(process.argv[2]) || 200, select: { createdAt: true, newValues: true },
  });
  const traces = rows.map((r) => { let v: any = r.newValues; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } } return v; }).filter(Boolean);

  const grounded = (ev: any[]) => ev.some((e: any) => e && Object.prototype.hasOwnProperty.call(e, 'summary'));
  const byRule = new Map<string, { n: number; example: string; q: string }>();
  let judged = 0, newly = 0, alreadyKnown = 0;

  for (const t of traces) {
    const text = String(t?.answer?.text || '');
    if (!text) continue;
    const ev = Array.isArray(t?.executed) ? t.executed : [];
    const contract = { ...(t?.contract || {}), canShow: t?.render?.admissible || [] } as any;
    if (!contract.job) continue;
    if (!grounded(ev)) continue;          // same reason: no values, no grounding verdict
    judged++;
    let v: string[] = [];
    try { v = checkAnswer(contract, text, t?.answer?.artifacts || [], contract.canShow, ev, undefined, t?.plan?.spec).violations; }
    catch { continue; }
    if (!v.length) continue;
    const had = (t?.validation?.violations || []).length > 0;
    had ? alreadyKnown++ : newly++;
    for (const one of v) {
      // the rule, not the instance: strip the quoted specifics
      const rule = one.replace(/"[^"]*"/g, '"…"').replace(/₹[\d,]+/g, '₹…').slice(0, 96);
      const cur = byRule.get(rule) || { n: 0, example: one, q: String(t?.question || '') };
      cur.n++; byRule.set(rule, cur);
    }
  }

  /* AND THROUGH THE ADVERSARIAL JUDGE ITSELF. Different question from the contract check: that
     asks whether the sentences are grounded in the evidence, this asks the things the benchmark
     asks — did it invent a number, show a test branch, deny something the centre records, leave a
     material claim open without saying so, recommend something unsized. The questions are the
     owner's real ones rather than the suite's, and the model's choices are frozen, so this is not
     the benchmark. It is the nearest free reading of it, on an instrument pulse-judge.ts checks. */
  /* ONLY TRACES THAT CARRY THE FIGURES. Until now `executed` recorded the tool, the SQL and the
     row COUNT but never the values, so grounding had nothing to check against and reported every
     number in every answer as invented — nineteen of twenty-six, which is the absence of the
     evidence rather than the presence of a lie. Traces written before that fix can never be
     re-judged on grounding; they are skipped rather than counted, because a confident wrong
     number about the product is exactly what this whole exercise exists to prevent. */
  const advFlags = new Map<string, number>();
  let audited = 0, clean = 0, tooOld = 0;
  for (const t of traces) {
    const a = t?.answer; if (!a?.text) continue;
    if (!grounded(t?.executed || [])) { tooOld++; continue; }
    audited++;
    let f: string[] = [];
    try { f = audit({ ...a, kind: 'answer', evidence: t?.executed || [], trace: { investigation: t?.investigation } }, { q: String(t.question || ''), why: '' } as any).flags as string[]; }
    catch { audited--; continue; }
    if (!f.length) { clean++; continue; }
    for (const one of f) advFlags.set(one, (advFlags.get(one) || 0) + 1);
  }
  console.log(`\n${audited} recorded answers through the ADVERSARIAL judge — ${clean} carry no flag at all`
    + (tooOld ? `\n  (${tooOld} skipped: written before the trace carried evidence values, so grounding cannot be judged)` : ''));
  for (const [f, n] of [...advFlags.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}x  ${f}`);

  console.log(`\n${traces.length} traces · ${judged} answers re-judged by today's contract\n`);
  console.log(`  ${newly} would now be caught that were NOT flagged when they shipped`);
  console.log(`  ${alreadyKnown} were already flagged at the time\n`);
  const sorted = [...byRule.entries()].sort((a, b) => b[1].n - a[1].n);
  if (!judged) console.log('  NOTHING WAS JUDGED. Every trace here predates the evidence values being recorded,\n'
    + '  so no verdict is possible. That is not a clean bill of health — it is an empty one.\n'
    + '  Ask Pulse anything, and the next trace will be judgeable.\n');
  else if (!sorted.length) console.log('  no violations — every recorded answer passes the rules as they stand today\n');
  for (const [rule, d] of sorted.slice(0, 10)) {
    console.log(`  ${String(d.n).padStart(3)}x  ${rule}`);
    console.log(`        e.g. "${d.q.slice(0, 62)}"`);
  }
  console.log();
  await db.$disconnect();
})();
