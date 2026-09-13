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

(async () => {
  const db = new PrismaClient();
  const rows = await db.auditLog.findMany({
    where: { entityType: 'PulseTrace' }, orderBy: { createdAt: 'desc' },
    take: Number(process.argv[2]) || 200, select: { createdAt: true, newValues: true },
  });
  const traces = rows.map((r) => { let v: any = r.newValues; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } } return v; }).filter(Boolean);

  const byRule = new Map<string, { n: number; example: string; q: string }>();
  let judged = 0, newly = 0, alreadyKnown = 0;

  for (const t of traces) {
    const text = String(t?.answer?.text || '');
    if (!text) continue;
    const ev = Array.isArray(t?.executed) ? t.executed : [];
    const contract = { ...(t?.contract || {}), canShow: t?.render?.admissible || [] } as any;
    if (!contract.job) continue;
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

  console.log(`\n${traces.length} traces · ${judged} answers re-judged by today's contract\n`);
  console.log(`  ${newly} would now be caught that were NOT flagged when they shipped`);
  console.log(`  ${alreadyKnown} were already flagged at the time\n`);
  const sorted = [...byRule.entries()].sort((a, b) => b[1].n - a[1].n);
  if (!sorted.length) { console.log('  no violations — every recorded answer passes the rules as they stand today\n'); }
  for (const [rule, d] of sorted.slice(0, 10)) {
    console.log(`  ${String(d.n).padStart(3)}x  ${rule}`);
    console.log(`        e.g. "${d.q.slice(0, 62)}"`);
  }
  console.log();
  await db.$disconnect();
})();
