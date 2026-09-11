/**
 * Read the Pulse decision traces. Every turn writes one (routes/pulse.ts → logTrace), and this
 * is what turns them into something you can act on: where the seconds actually go, which
 * renderers the evidence admits versus which get chosen, how often the response has to be
 * repaired, and what Pulse refused.
 *
 *   npx ts-node --transpile-only pulse-traces.ts [limit]
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const N = Number(process.argv[2]) || 100;
const pct = (n: number, d: number) => d ? `${Math.round(n / d * 100)}%` : '—';

(async () => {
  const rows = await db.auditLog.findMany({
    where: { entityType: 'PulseTrace' }, orderBy: { createdAt: 'desc' }, take: N,
    select: { createdAt: true, newValues: true },
  });
  const traces = rows.map((r) => { let v: any = r.newValues; if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } } return v; })
    .filter((t) => t && t.v === 1);
  if (!traces.length) { console.log('No traces yet. They are written from the next question onward.'); await db.$disconnect(); return; }

  console.log(`${traces.length} turns\n`);

  // ── where the time goes ──────────────────────────────────────────────────────────────────
  const byTool = new Map<string, { n: number; ms: number; err: number }>();
  for (const t of traces) for (const e of t.executed || []) {
    const a = byTool.get(e.tool) || { n: 0, ms: 0, err: 0 };
    a.n++; a.ms += e.ms || 0; if (!e.ok) a.err++; byTool.set(e.tool, a);
  }
  console.log('TOOL COST — the slowest thing is rarely the one you suspect');
  console.table([...byTool.entries()].sort((x, y) => y[1].ms - x[1].ms).slice(0, 12)
    .map(([tool, a]) => ({ tool, calls: a.n, 'avg ms': Math.round(a.ms / a.n), 'total s': +(a.ms / 1000).toFixed(1), errors: a.err })));

  // ── latency split ────────────────────────────────────────────────────────────────────────
  const avg = (f: (t: any) => number) => Math.round(traces.reduce((s, t) => s + (f(t) || 0), 0) / traces.length);
  console.log(`\nLATENCY  total ${avg((t) => t.ms)}ms  ·  gathering ${avg((t) => t.timing?.toEvidence)}ms  ·  writing ${avg((t) => t.timing?.toAnswer)}ms`);
  console.log(`CALLS    ${(traces.reduce((s, t) => s + (t.calls || 0), 0) / traces.length).toFixed(1)} per turn  ·  rounds ${(traces.reduce((s, t) => s + (t.rounds || 0), 0) / traces.length).toFixed(1)}`);
  const slow = [...traces].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log('\nSLOWEST TURNS');
  for (const t of slow) console.log(`  ${String(Math.round(t.ms / 1000)).padStart(3)}s ${String(t.calls).padStart(2)}c ${String(t.job || '—').padEnd(14)} ${String(t.question).slice(0, 62)}`);

  // ── what the answer looked like ──────────────────────────────────────────────────────────
  const jobs = new Map<string, number>();
  for (const t of traces) jobs.set(t.job || '—', (jobs.get(t.job || '—') || 0) + 1);
  console.log('\nANALYTICAL JOBS');
  console.log('  ' + [...jobs.entries()].sort((a, b) => b[1] - a[1]).map(([j, n]) => `${j} ${n}`).join(' · '));

  const repaired = traces.filter((t) => t.validation?.repaired).length;
  const simplified = traces.filter((t) => t.validation?.simplified).length;
  const stillBroken = traces.filter((t) => (t.validation?.stillBroken || []).length).length;
  console.log(`\nRESPONSE CONTRACT  repaired ${repaired} (${pct(repaired, traces.length)}) · simplified ${simplified} · shipped still breaking ${stillBroken}`);
  const why = new Map<string, number>();
  for (const t of traces) for (const v of t.validation?.violations || []) {
    const key = /numbers, more than/.test(v) ? 'too many numbers' : /one sentence carries/.test(v) ? 'dense sentence' : /must show a/.test(v) ? 'missing artifact' : v.slice(0, 40);
    why.set(key, (why.get(key) || 0) + 1);
  }
  if (why.size) console.log('  why: ' + [...why.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(' · '));

  // ── capability: admitted vs chosen ───────────────────────────────────────────────────────
  const adm = new Map<string, number>(), chose = new Map<string, number>();
  for (const t of traces) {
    for (const o of t.render?.admissible || []) adm.set(o.type, (adm.get(o.type) || 0) + 1);
    for (const c of t.render?.chosen || []) chose.set(c.type, (chose.get(c.type) || 0) + 1);
  }
  console.log('\nRENDERERS — admitted by the evidence vs actually chosen');
  console.table([...new Set([...adm.keys(), ...chose.keys()])].map((type) => ({
    type, admitted: adm.get(type) || 0, chosen: chose.get(type) || 0,
    'take-up': pct(chose.get(type) || 0, adm.get(type) || 0),
  })).sort((a, b) => b.admitted - a.admitted));

  // ── investigation depth ──────────────────────────────────────────────────────────────────
  const withInv = traces.filter((t) => t.investigation);
  if (withInv.length) {
    const h = withInv.flatMap((t) => t.investigation.hypotheses || []);
    const open = h.filter((x: any) => x.status === 'open').length;
    console.log(`\nINVESTIGATION  ${withInv.length} turns · ${h.length} hypotheses · confirmed ${h.filter((x: any) => x.status === 'confirmed').length} · rejected ${h.filter((x: any) => x.status === 'rejected').length} · left open ${open}`);
    const conf = new Map<string, number>();
    for (const t of withInv) conf.set(t.investigation.confidence, (conf.get(t.investigation.confidence) || 0) + 1);
    console.log('  confidence: ' + [...conf.entries()].map(([c, n]) => `${c} ${n}`).join(' · '));
  }

  // ── failures ─────────────────────────────────────────────────────────────────────────────
  const failed = traces.flatMap((t) => (t.executed || []).filter((e: any) => !e.ok).map((e: any) => ({ q: t.question, tool: e.tool, error: e.error })));
  if (failed.length) {
    console.log(`\nFAILED STEPS — ${failed.length}`);
    for (const f of failed.slice(0, 8)) console.log(`  ${f.tool.padEnd(12)} ${String(f.error).slice(0, 70)}   ← ${String(f.q).slice(0, 40)}`);
  }
  await db.$disconnect();
})();
