/**
 * RE-EXECUTE THE STEPS THE MODEL ACTUALLY CHOSE, AGAINST TODAY'S CODE.
 *
 * The adversarial suite asks a model to plan and then judges the answer. Its plans are the one
 * thing that cannot be reproduced without spending. But the plans it ALREADY made are recorded:
 * every trace carries the tool and the arguments of every step, and what that step returned at
 * the time.
 *
 * So the registry half of the pipeline can be re-run exactly as it was asked to run, and compared
 * against what it did then. That is a real behavioural measurement — same inputs, new code —
 * and it answers the question that matters after a week of changes: given the same plans, does
 * this build do better or worse than the one that was last measured?
 *
 * Query steps are skipped: they need generation, which needs the model. Everything else runs.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ensureKnowledge } from './src/services/pulse/knowledge';
import { runStep } from './src/services/pulse/v2/tools';

(async () => {
  const db = new PrismaClient();
  const k = await ensureKnowledge();
  const rows = await db.auditLog.findMany({
    where: { entityType: 'PulseTrace' }, orderBy: { createdAt: 'desc' },
    take: Number(process.argv[2]) || 200, select: { newValues: true },
  });
  const traces = rows.map((r) => { let v: any = r.newValues; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } } return v; }).filter(Boolean);

  let ran = 0, sameOk = 0, sameFail = 0, fixed = 0, broke = 0;
  const fixes: string[] = [], breaks: string[] = [];

  for (const t of traces) {
    const plan = Array.isArray(t?.plan?.proposed) ? t.plan.proposed : [];
    const executed = Array.isArray(t?.executed) ? t.executed : [];
    const spec = t?.plan?.spec ?? null;
    const q = String(t?.question || '');
    for (let i = 0; i < executed.length; i++) {
      const was = executed[i];
      const tool = String(was?.tool || '');
      if (!tool || tool === 'query' || tool === 'resolve') continue;       // need the model, or are trivially stable
      /* ONLY WHERE THE ARGUMENTS ARE PROVABLY THE ONES THAT RAN. executed[] records no args, and
         plan.proposed covers only the FIRST round while executed spans every round — so pairing
         them by index is valid for the opening steps and meaningless after that. Pairing blindly
         handed a trend step someone else's arguments and reported "no such metric 'undefined'"
         as a regression in the product. The tool name must match as well, which is what makes
         the alignment checkable rather than assumed. */
      const proposed = plan[i];
      if (!proposed || String(proposed.tool) !== tool || !proposed.args) continue;
      const args = proposed.args;
      ran++;
      let now: any;
      try { now = await runStep({ tool, args, label: was?.label }, i, k, spec, {}, [], q); }
      catch (e: any) { now = { ok: false, error: String(e?.message).slice(0, 80) }; }
      const before = was.ok !== false, after = now.ok !== false;
      if (before && after) sameOk++;
      else if (!before && !after) sameFail++;
      else if (!before && after) { fixed++; if (fixes.length < 6) fixes.push(`${tool} · was "${String(was.error).slice(0, 58)}"`); }
      else { broke++; if (breaks.length < 6) breaks.push(`${tool} · now "${String(now.error).slice(0, 58)}" · q: ${q.slice(0, 34)}`); }
    }
  }

  console.log(`\n${traces.length} traces · ${ran} recorded registry steps re-executed against today's code\n`);
  console.log(`  ${String(sameOk).padStart(4)}  worked then, work now`);
  console.log(`  ${String(fixed).padStart(4)}  FAILED then, work now`);
  console.log(`  ${String(broke).padStart(4)}  worked then, FAIL now   ← the only number that must be zero`);
  console.log(`  ${String(sameFail).padStart(4)}  failed then and now\n`);
  if (fixes.length) { console.log('  now fixed:'); for (const f of fixes) console.log(`    · ${f}`); console.log(); }
  if (breaks.length) { console.log('  NEWLY BROKEN:'); for (const b of breaks) console.log(`    · ${b}`); console.log(); }
  await db.$disconnect();
  process.exit(broke ? 1 : 0);
})();
