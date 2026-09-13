import 'dotenv/config';
const { analyse } = await import('./dist/services/pulse/v2/run.js');
const Q = ['last month collection how much', 'why is collection down this week', 'how can i improve my business',
  'how is the business doing', 'which doctor is performing best', "what's unusual this week", 'revenue per visit last month'];
for (const q of Q) {
  const a = await analyse(q, {});
  if (a.kind !== 'analysis') { console.log(`▶ ${q}\n  ${a.kind}: ${String(a.text).slice(0, 90)}\n`); continue; }
  console.log(`▶ ${q}`);
  console.log(`  goal: ${a.goal}`);
  console.log(`  plan: ${a.evidence.map((e) => e.tool + (e.ok ? '' : '✗')).join(' → ')}`);
  console.log(`  sections: ${a.sections.map((s) => s.type).join(' · ')}`);
  console.log(`  ${a.meta.calls} calls · ${a.meta.steps} steps · ${(a.meta.ms / 1000).toFixed(1)}s`);
  const h = a.sections.find((s) => s.type === 'headline'); if (h) console.log(`  "${String(h.text).slice(0, 150)}"`);
  console.log('');
}
process.exit(0);
