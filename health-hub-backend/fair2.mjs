import 'dotenv/config';
import fs from 'fs';
const { analyse } = await import('./dist/services/pulse/v2/run.js');
const { sqlAnswer } = await import('./dist/services/pulse/sqlPath.js');
const { ensureKnowledge } = await import('./dist/services/pulse/knowledge.js');
const { query } = await import('./dist/services/pulse/db.js');
const { CEIL } = await import('/private/tmp/claude-501/-Users-pranavreddy-Desktop-sobhana-portal/d6782da9-4459-4102-9b92-85e8e02ddab4/scratchpad/cases5.mjs');
const { PAIRS } = await import('/private/tmp/claude-501/-Users-pranavreddy-Desktop-sobhana-portal/d6782da9-4459-4102-9b92-85e8e02ddab4/scratchpad/owner.mjs');
const k = await ensureKnowledge();
const LOG = '/tmp/fair2.log'; fs.writeFileSync(LOG, '');
const say = (s) => { fs.appendFileSync(LOG, s + '\n'); console.log(s); };
const nums = (o) => { const out = []; (function walk(x){ if (x == null) return;
  if (typeof x === 'number') out.push(x);
  else if (typeof x === 'string') { for (const m of x.matchAll(/-?[\d,]*\.?\d+/g)) { const n = Number(m[0].replace(/,/g,'')); if (Number.isFinite(n)) out.push(n); } }
  else if (typeof x === 'object') for (const v of Object.values(x)) walk(v); })(o); return out; };
const near = (h, w) => h.some((g) => Math.abs(g-w) <= Math.max(0.02, Math.abs(w)*0.005) || Math.abs(g-w/100) <= Math.max(0.02, Math.abs(w/100)*0.005) || Math.abs(g*100-w) <= Math.max(0.02, Math.abs(w)*0.005));
const score = (want, got) => { const h = want.filter((w) => near(got, w)).length; return want.length === 0 || h === want.length || (want.length > 2 && h/want.length >= 0.8); };
for (const [name, cases] of [['held-out (32)', CEIL], ['owner (20)', PAIRS]]) {
  let v1 = 0, v2 = 0, ms1 = 0, ms2 = 0, done = 0; const m1 = [], m2 = [];
  const tasks = cases.map((c) => async () => {
    const ctrl = await query(c.sql, [], 100000); if (ctrl.err) return;
    const want = nums(ctrl.rows).filter((n) => Math.abs(n) > 0.001);
    let t = Date.now();
    try { const a = await sqlAnswer(k, c.q); ms1 += Date.now()-t; if (a.kind === 'sql' && score(want, nums(a.rows))) v1++; else m1.push(c.id); } catch { m1.push(c.id); }
    t = Date.now();
    try { const b = await analyse(c.q, {}); ms2 += Date.now()-t; if (score(want, nums({ t: b.text, s: b.evidence?.map((e)=>e.summary), d: b.evidence?.map((e)=>e.data) }))) v2++; else m2.push(c.id); } catch { m2.push(c.id); }
    if (++done % 8 === 0) say(`   …${done}/${cases.length}  V1 ${v1}  V2 ${v2}`);
  });
  let n = 0; await Promise.all(Array.from({length:3}, async () => { while (n < tasks.length) await tasks[n++](); }));
  say(`${name}`);
  say(`  V1 single-call : ${v1}/${cases.length}  ${(ms1/cases.length/1000).toFixed(1)}s`);
  say(`  V2 analyst     : ${v2}/${cases.length}  ${(ms2/cases.length/1000).toFixed(1)}s`);
  say(`  V1 only misses : ${m1.filter(x=>!m2.includes(x)).sort().join(' ') || '—'}`);
  say(`  V2 only misses : ${m2.filter(x=>!m1.includes(x)).sort().join(' ') || '—'}`);
  say(`  both miss      : ${m1.filter(x=>m2.includes(x)).sort().join(' ') || '—'}`);
}
process.exit(0);
