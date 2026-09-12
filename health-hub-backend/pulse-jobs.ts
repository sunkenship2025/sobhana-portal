/**
 * DOES THE OPPORTUNITY PIPELINE EVER FIRE?
 *
 * A job is not a label. It selects the contract, which selects whether Opportunity objects are
 * extracted at all — so a question classified `explanation` instead of `opportunity` does not get
 * a slightly worse answer, it gets NO rupee sizing, NO observed/modeled/causal tag, NO ranking,
 * NO "considered but not sized" list. The whole of opportunity.ts never runs.
 *
 * Six of seven improvement questions in the real logs came back `explanation`. That is an
 * observation, not a rate. This measures it, and measures the thing that actually matters:
 *
 *   ACTIVATION = of questions whose intent is "what should I do to make more money",
 *                what fraction reach the owner as sized, ranked opportunities?
 *
 *   npx ts-node --transpile-only pulse-jobs.ts
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';

const GATE = 0.80;   // pre-registered
const QS = [
  'How can I increase revenue?',
  'How do I make more money?',
  'What should I optimize to grow revenue?',
  'Where can I improve to increase collections?',
  'What are the biggest opportunities to increase revenue?',
  'how can i improve this',
  'What should I do about these numbers?',
  'Where are we losing money?',
  'What can we optimize?',
  'What should we fix first?',
  'What changes would have the biggest financial impact?',
  'How do I grow this business?',
];

(async () => {
  console.log(`PRE-REGISTERED GATE: >= ${GATE * 100}% of opportunity-intent questions must activate the`);
  console.log(`opportunity pipeline (job=opportunity AND at least one sized, ranked Opportunity).\n`);
  let opportunityJob = 0, produced = 0, sized = 0, causal = 0;
  for (const q of QS) {
    let a: any;
    try { a = await ask(q, {}); } catch (e: any) { console.log(`✗ THREW  ${q}`); continue; }
    const job = a.job ?? a.kind;
    const ops = a.opportunities || [];
    const withRupees = ops.filter((o: any) => o.rupeeValue > 0);
    const withCause = ops.filter((o: any) => o.causality);
    if (job === 'opportunity') opportunityJob++;
    if (ops.length) produced++;
    if (withRupees.length) sized++;
    if (withCause.length) causal++;
    console.log(`${job === 'opportunity' ? '✓' : '✗'} ${String(job).padEnd(13)} ops=${String(ops.length).padStart(2)} sized=${withRupees.length} | ${q.slice(0, 48)}`);
    if (withRupees.length) console.log(`     ${withRupees.slice(0,2).map((o: any) => `${o.title} — ${o.estimatedImpact || o.currentValue} (${o.causality})`).join(' · ')}`);
  }
  const n = QS.length, pct = (x: number) => `${Math.round(x / n * 100)}%`;
  console.log(`\n${'═'.repeat(66)}`);
  console.log(`job = opportunity              ${opportunityJob}/${n} = ${pct(opportunityJob)}`);
  console.log(`produced any Opportunity       ${produced}/${n} = ${pct(produced)}`);
  console.log(`ACTIVATION (sized + ranked)    ${sized}/${n} = ${pct(sized)}`);
  console.log(`carried a causality tag        ${causal}/${n} = ${pct(causal)}`);
  console.log(`\nDECISION: ${sized / n >= GATE ? 'activation above gate → leave job classification alone'
    : `activation ${pct(sized)} < ${GATE * 100}% → FIX JOB CLASSIFICATION`}`);
  process.exit(0);
})();
