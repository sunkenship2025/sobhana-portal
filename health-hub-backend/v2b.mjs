import 'dotenv/config';
const { analyse } = await import('./dist/services/pulse/v2/run.js');
const Q = ['last month collection how much', 'why is collection down this week', 'how can i improve my business',
  'show me revenue by branch this month', 'what about last week', 'which doctor is performing best', 'how is the business doing'];
let tot = 0, cal = 0;
for (const q of Q) {
  const a = await analyse(q, {});
  if (a.kind !== 'analysis') { console.log(`▶ ${q}\n  ${a.kind}\n`); continue; }
  tot += a.meta.ms; cal += a.meta.calls;
  console.log(`▶ ${q}`);
  console.log(`  ${a.evidence.map((e) => e.tool + (e.ok ? '' : '✗')).join(' → ')}  |  ${a.meta.calls} calls · ${(a.meta.ms / 1000).toFixed(1)}s`);
  console.log(`  TEXT: ${String(a.text).slice(0, 210)}`);
  console.log(`  SHOWS: ${a.artifacts.length ? a.artifacts.map((x) => x.type).join(' + ') : '(nothing — text only)'}`);
  console.log('');
}
console.log(`mean ${(tot / Q.length / 1000).toFixed(1)}s · ${(cal / Q.length).toFixed(1)} calls`);
process.exit(0);
