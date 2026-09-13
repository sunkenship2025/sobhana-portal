/**
 * EVERY QUERY THE MODEL EVER GENERATED, REPLAYED THROUGH TODAY'S CODE.
 *
 * Generation needs the model. Everything that happens to a generated query afterwards does not:
 * the safety validator, the spec check that decides whether it honoured what the owner asked, and
 * the database itself. Fifty-seven real generated queries are recorded in the traces, with
 * whether each one was accepted and what it returned.
 *
 * So the whole query path minus generation can be measured on real inputs. The number that
 * matters is the third one: a query that was accepted and correct before, and is refused now,
 * is a regression that no unit test would have found — and every guard added this week refuses
 * something.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { validate } from './src/services/pulse/validator';
import { verifySpec } from './src/services/pulse/v2/spec';

(async () => {
  const db = new PrismaClient({ datasources: { db: { url: process.env.ANALYTICS_DATABASE_URL || process.env.DATABASE_URL } } });
  const rows = await db.auditLog.findMany({
    where: { entityType: 'PulseTrace' }, orderBy: { createdAt: 'desc' },
    take: Number(process.argv[2]) || 200, select: { newValues: true },
  });
  const traces = rows.map((r) => { let v: any = r.newValues; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } } return v; }).filter(Boolean);

  const TRUNCATED_AT = 600;
  let skipped = 0, n = 0, safeOk = 0, safeNow = 0, specWas = 0, specNow = 0, ranOk = 0, ranFail = 0;
  const blocked: string[] = [], broke: string[] = [];

  for (const t of traces) {
    const spec = t?.plan?.spec ?? null;
    for (const e of (t?.executed || [])) {
      const sql = String(e?.sql || ''); if (!sql) continue;
      /* ONLY COMPLETE QUERIES. Traces capped the SQL at 600 characters, so two thirds of what is
         recorded is cut mid-expression — and executing a fragment produces "unterminated quoted
         identifier", which is a fact about the cap and not about the query. The cap is now 4,000;
         older rows stay truncated forever, so the ones that end mid-token are skipped rather than
         counted as failures. */
      if (sql.length >= TRUNCATED_AT && !/\)\s*;?\s*$/.test(sql.trim())) { skipped++; continue; }
      n++;
      // 1. does the safety validator still allow what it allowed before?
      const why = validate(sql, {});
      if (!why) safeNow++; else if (e.ok !== false && blocked.length < 5) blocked.push(`${why} · ${String(t.question).slice(0, 40)}`);
      if (e.ok !== false) safeOk++;
      // 2. does the spec check agree the query honoured the owner?
      if (spec) { const v = verifySpec(spec, sql); if (v.ok) specNow++; specWas++; }
      // 3. does it still run, and still return rows?
      if (why) continue;
      const capped = /\bLIMIT\s+\d+\s*;?\s*$/i.test(sql) ? sql.replace(/;\s*$/, '') : sql.replace(/;\s*$/, '') + ' LIMIT 50';
      try { await db.$queryRawUnsafe(capped); ranOk++; }
      catch (err: any) {
        ranFail++;
        if (e.ok !== false && broke.length < 5) broke.push(`${String(err?.meta?.message || err?.message).slice(0, 70)} · ${String(t.question).slice(0, 34)}`);
      }
    }
  }

  console.log(`\n${n} complete generated queries replayed through today's code (${skipped} skipped: truncated in storage)\n`);
  console.log(`  ${String(safeOk).padStart(3)}  were accepted when they ran`);
  console.log(`  ${String(safeNow).padStart(3)}  pass today's safety validator`);
  console.log(`  ${String(specNow).padStart(3)}/${specWas}  satisfy today's spec check`);
  console.log(`  ${String(ranOk).padStart(3)}  still execute against the database`);
  console.log(`  ${String(ranFail).padStart(3)}  fail to execute  ← schema drift or a real break\n`);
  if (blocked.length) { console.log('  NEWLY REFUSED BY THE VALIDATOR:'); for (const b of blocked) console.log(`    · ${b}`); console.log(); }
  if (broke.length) { console.log('  NEWLY FAILING TO EXECUTE:'); for (const b of broke) console.log(`    · ${b}`); console.log(); }
  await db.$disconnect();
})();
