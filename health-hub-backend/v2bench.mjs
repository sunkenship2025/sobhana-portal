import 'dotenv/config';
const { analyse } = await import('./dist/services/pulse/v2/run.js');
const { query } = await import('./dist/services/pulse/db.js');
const { CEIL } = await import('/private/tmp/claude-501/-Users-pranavreddy-Desktop-sobhana-portal/d6782da9-4459-4102-9b92-85e8e02ddab4/scratchpad/cases5.mjs');
const { PAIRS } = await import('/private/tmp/claude-501/-Users-pranavreddy-Desktop-sobhana-portal/d6782da9-4459-4102-9b92-85e8e02ddab4/scratchpad/owner.mjs');
const nums = (o) => { const out = []; (function walk(x){ if (x == null) return;
  if (typeof x === 'number') out.push(x);
  else if (typeof x === 'string') { for (const m of x.matchAll(/-?[\d,]*\.?\d+/g)) { const n = Number(m[0].replace(/,/g,'')); if (Number.isFinite(n)) out.push(n); } }
  else if (typeof x === 'object') for (const v of Object.values(x)) walk(v); })(o); return out; };
const near = (hay, w) => hay.some((g) => Math.abs(g - w) <= Math.max(0.02, Math.abs(w) * 0.005)) || hay.some((g) => Math.abs(g - w / 100) <= Math.max(0.02, Math.abs(w / 100) * 0.005));
for (const [name, cases] of [['held-out (32)', CEIL], ['owner phrasing (20)', PAIRS]]) {
  let ok = 0, cal = 0, ms = 0; const miss = []; let i = 0;
  const tasks = cases.map((c) => async () => {
    const ctrl = await query(c.sql, [], 100000); if (ctrl.err) { miss.push(c.id + ':ctrl'); return; }
    const want = nums(ctrl.rows).filter((n) => Math.abs(n) > 0.001);
    try { const a = await analyse(c.q, {});
      cal += a.meta?.calls || 0; ms += a.meta?.ms || 0;
      const got = nums({ t: a.text, e: a.evidence?.map((e) => e.summary) });
      const hit = want.length === 0 || want.every((w) => near(got, w)) || (want.length > 3 && want.filter((w) => near(got, w)).length / want.length >= 0.8);
      if (hit) ok++; else miss.push(c.id);
    } catch { miss.push(c.id + ':err'); }
  });
  let n = 0; await Promise.all(Array.from({length:2}, async () => { while (n < tasks.length) await tasks[n++](); }));
  console.log(`${name}: ${ok}/${cases.length} · ${(cal/cases.length).toFixed(1)} calls · ${(ms/cases.length/1000).toFixed(1)}s avg`);
  console.log(`   misses: ${miss.sort().join(' ')}`);
}
process.exit(0);
