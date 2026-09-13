/**
 * THE DETERMINISTIC CORE, VERIFIED WITHOUT A SINGLE MODEL CALL.
 *
 * Every benchmark in this repo needs the LLM, so when the account hit "Insufficient Balance"
 * mid-suite there was no way to tell a good build from a broken one. That is a bad property for
 * a BI layer to have: the part that must never be wrong — what a metric means, whether a filter
 * reaches both halves of a ratio, whether paise became rupees, whether two figures may be
 * combined at all — is exactly the part that involves no model.
 *
 * So it is tested on its own, against truth computed independently in SQL here. Free to run,
 * runs in seconds, and fails on the defect classes this layer actually produced:
 *   a ratio whose halves cover different rows
 *   a window silently narrowed
 *   money 100x out
 *   two figures combined across different populations
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { ensureKnowledge } from './src/services/pulse/knowledge';
import { runStep } from './src/services/pulse/v2/tools';

const db = new PrismaClient({ datasources: { db: { url: process.env.ANALYTICS_DATABASE_URL || process.env.DATABASE_URL } } });
const IST = (x: string) => `(${x} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;
const IMG = `'Ultrasound','Ultrasound Tiffa','2D Echo','X-Ray','Dental X-Ray','CT / MRI'`;
const COMM = `SUM(CASE WHEN o."referralCommissionType"='PERCENTAGE' THEN ROUND(o."priceInPaise" * COALESCE(o."referralCommissionPercentage",0)/100.0) ELSE COALESCE(o."referralCommissionAmountInPaise",0) END)`;

let pass = 0, fail = 0;
const ok = (name: string, got: any, want: any, why = '') => {
  const good = String(got) === String(want);
  console.log(`  ${good ? '✓' : '✗'} ${name.padEnd(46)} ${good ? String(got) : `got ${got}, want ${want}`}${why && !good ? ` — ${why}` : ''}`);
  good ? pass++ : fail++;
};
const near = (name: string, got: number, want: number, tol: number) => {
  const good = Math.abs(got - want) / Math.max(Math.abs(want), 1) <= tol;
  console.log(`  ${good ? '✓' : '✗'} ${name.padEnd(46)} ${got}${good ? '' : ` (want ~${want})`}`);
  good ? pass++ : fail++;
};

(async () => {
  const k = await ensureKnowledge();
  const step = async (s: any, prior: any[] = []) => runStep(s, prior.length, k, null, {}, prior) as any;

  // ── truth, computed here, independently of anything the layer does ──────────────────────
  const t: any = (await db.$queryRawUnsafe(`
    SELECT COUNT(*) n, SUM(o."priceInPaise") billed, ${COMM} comm
    FROM "TestOrder" o JOIN "Visit" v ON v.id=o."visitId" JOIN "Branch" br ON br.id=v."branchId"
    WHERE o."payoutCategorySnapshot" IN (${IMG}) AND br.code NOT IN ('JGG','IDPL')
      AND ${IST('o."createdAt"')} >= CURRENT_DATE - 90 AND ${IST('o."createdAt"')} < CURRENT_DATE`))[0];
  const N = Number(t.n), B = Number(t.billed), C = Number(t.comm);
  console.log(`\ntruth (imaging, 90d, live): ${N} orders  billed ₹${Math.round(B/100).toLocaleString('en-IN')}  commission ₹${Math.round(C/100).toLocaleString('en-IN')}\n`);

  const IMGF = { service_kind: 'IMAGING' };
  const CT = { payout_category: 'CT / MRI' };
  console.log('SCOPED METRICS — a filter the registry could not express is how every CT figure came back 0');
  const b = await step({ tool: 'metric', args: { metric: 'billed_on_orders', period: 'last_90_days', filter: IMGF } });
  const c = await step({ tool: 'metric', args: { metric: 'commission_on_orders', period: 'last_90_days', filter: IMGF } });
  const n = await step({ tool: 'metric', args: { metric: 'test_orders', period: 'last_90_days', filter: IMGF } });
  near('billed_on_orders scoped to imaging', Number(b.data?.value ?? b.data), B, 0.02);
  near('commission_on_orders scoped to imaging', Number(c.data?.value ?? c.data), C, 0.02);
  near('test_orders scoped to imaging', Number(n.data?.value ?? n.data), N, 0.02);

  console.log('\nSCOPED RATIO — the filter must reach BOTH halves, or the two cover different rows');
  const share = await step({ tool: 'derive', args: { numerator: 'commission_on_orders', denominator: 'billed_on_orders', period: 'last_90_days', filter: IMGF } });
  ok('commission share of imaging', share.summary?.value, `${(C / B * 100).toFixed(1)}%`);
  const per = await step({ tool: 'derive', args: { numerator: 'billed_on_orders', denominator: 'test_orders', period: 'last_90_days', filter: IMGF } });
  near('billed per imaging scan', Number(per.data?.value) / 100, B / 100 / N, 0.02);

  console.log('\nREPEATABILITY — the same question twice is the same number');
  const again: string[] = [];
  for (let i = 0; i < 3; i++) { const r = await step({ tool: 'derive', args: { numerator: 'commission_on_orders', denominator: 'billed_on_orders', period: 'last_90_days', filter: IMGF } }); again.push(r.summary?.value); }
  ok('three runs agree', new Set(again).size, 1, again.join('/'));

  console.log('\nARITHMETIC — paise, and operands that may not be combined');
  const pay = await step({ tool: 'compute', args: { formula: 'capital / ((billed - commission) / 3)', unit: 'months',
    let: { capital: { value: 5000000, unit: 'rupees' }, billed: { step: 0 }, commission: { step: 1 } } } }, [{ ...b, step: 0 }, { ...c, step: 1 }]);
  near('CT-style payback, paise normalised', Number(pay.data?.value), 5000000 / ((B - C) / 100 / 3), 0.02);
  const mixed = await step({ tool: 'compute', args: { formula: 'a / b', unit: 'percent',
    let: { a: { step: 0 }, b: { step: 1 } } } }, [{ ...b, step: 0 }, { ...c, step: 1, scope: 'something else', period: '2020-01-01…2020-02-01' }]);
  ok('refuses operands on different populations', mixed.ok, false, 'a ratio across two scopes is silently wrong');
  const paise = await step({ tool: 'compute', args: { formula: 'x', unit: 'rupees', let: { x: { value: 1, unit: 'paise' } } } });
  ok('refuses money supplied as paise', paise.ok, false, 'a 100x error that looks plausible');

  console.log('\nROUTING — a dead end is retried; a direction is followed');
  const wrong: any = await step({ tool: 'metric', args: { metric: 'revenue', period: 'last_90_days', filter: CT } });
  ok('revenue refuses a work scope', wrong.ok, false, 'cash lives on payments, not orders');
  ok('  and names the metric that can', /billed_on_orders/.test(String(wrong.error)), true, String(wrong.error).slice(0, 80));
  ok('  value metric ranked above cost', String(wrong.error).indexOf('billed_on_orders') < String(wrong.error).indexOf('commission_on_orders'), true);
  const right: any = await step({ tool: 'metric', args: { metric: 'billed_on_orders', period: 'last_90_days', filter: CT } });
  ok('the named metric actually answers', right.ok, true, right.error);
  const plain: any = await step({ tool: 'metric', args: { metric: 'revenue', period: 'last_90_days' } });
  ok('unscoped revenue still works', plain.ok, true, 'the guard must not block the common case');
  const marginQ: any = await runStep({ tool: 'metric', args: { metric: 'revenue', period: 'last_90_days' } }, 0, k,
    { goal: '', scope: [] } as any, {}, [], 'what is our margin and roi this quarter');
  ok('a question merely SAYING margin/roi is fine', marginQ.ok, true, 'centre-level margin legitimately uses revenue');

  /* THE GUARDS MUST NOT OVER-FIRE. Every guard added this week refuses something, and the one
     that refuses correct work is worse than the gap it closes — that has happened twice already
     (the registry spec guard answered "no patients have dues" against a true 11, and the cash
     guard turned a collection question into a billed one). The adversarial suite would catch it,
     and cannot run. These are the cases it would have caught. */
  console.log('\nGUARDS MUST NOT OVER-FIRE — a guard that refuses correct work is worse than the gap it closes');
  const branchSpec: any = { goal: '', scope: [{ term: 'chintal', dimension: 'branch', value: 'CNT', confidence: 1 }], time: { period: 'last-7-days' } };
  const byBranch: any = await runStep({ tool: 'metric', args: { metric: 'revenue', period: 'last-7-days', filter: { branch: 'CNT' } } }, 0, k, branchSpec, {}, [], 'what was last week collection chintal');
  ok('revenue scoped to a BRANCH still answers', byBranch.ok, true, 'branch is not work — the guard must ignore it');
  const domainSpec: any = { goal: '', scope: [{ term: 'lab', dimension: 'domain', value: 'DIAGNOSTICS', confidence: 1 }], time: { period: 'last-7-days' } };
  const byDomain: any = await runStep({ tool: 'metric', args: { metric: 'revenue', period: 'last-7-days', filter: { domain: 'DIAGNOSTICS' } } }, 0, k, domainSpec, {}, [], 'what was last week collection lab only');
  ok('revenue scoped to a DOMAIN still answers', byDomain.ok, true, 'domain is not a test, category or modality');

  console.log('\nTHE PERIOD BINDING MUST CORRECT, NOT CLOBBER');
  const specP: any = { goal: '', scope: [], time: { period: 'last-90-days' } };
  const bound: any = await runStep({ tool: 'metric', args: { metric: 'revenue', period: 'last_30_days' } }, 0, k, specP, {}, [], 'revenue last 90 days');
  ok('a step disagreeing with the spec is corrected', bound.summary?.period?.includes(new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)), true, bound.summary?.period);
  const agree: any = await runStep({ tool: 'metric', args: { metric: 'revenue', period: 'last-90-days' } }, 0, k, specP, {}, [], 'revenue last 90 days');
  ok('a step that already agrees is untouched', agree.summary?.period, bound.summary?.period);
  const noSpec: any = await runStep({ tool: 'metric', args: { metric: 'revenue', period: 'last_30_days' } }, 0, k, { goal: '', scope: [] } as any, {}, [], 'revenue last 30 days');
  ok('no spec period leaves the step alone', noSpec.ok && !noSpec.summary.period.includes(new Date(Date.now() - 90 * 864e5).toISOString().slice(0, 10)), true, noSpec.summary?.period);

  console.log('\nA RATE QUESTION NAMING NO WINDOW STILL HAS ONE — chosen once, and stated');
  const { completeSpec } = require('./src/services/pulse/v2/spec');
  const payback = completeSpec({ goal: '', scope: [] }, 'how many months to pay back a 50 lakh CT scanner at our current CT volume');
  ok('payback with no period gets one', payback?.time?.period, 'last-90-days', 'otherwise it is a dice roll on a capital decision');
  ok('  and it is stated, not silent', payback?.time?.phrase, 'the last 90 days');
  const stated = completeSpec({ goal: '', scope: [] }, 'what is our roi over the last 30 days');
  ok('an explicit window still wins', stated?.time?.period, 'last-30-days');
  const plainQ = completeSpec({ goal: '', scope: [] }, 'how much did we collect');
  ok('a non-rate question is left alone', plainQ?.time?.period ?? 'none', 'none', 'the default must not leak everywhere');

  /* THE WHOLE CT PAYBACK PATH, END TO END, WITH NO MODEL CALL. This is the question that could
     not be answered at all — "CT" resolved to CLOTTING TIME, every CT figure came back 0, and the
     answer was "I could not establish it". Every link in the chain is now deterministic: the
     question fixes its own window, the operands exist as scoped metrics, and the arithmetic runs
     in TypeScript. What a model still chooses is which steps to emit — not what any of them mean. */
  console.log('\nCT PAYBACK, WHOLE PATH — the question that could not be answered at all');
  const q0 = 'how many months would it take to pay back a 50 lakh CT scanner at our current CT volume';
  const sp: any = completeSpec({ goal: '', scope: [{ term: 'CT', dimension: 'payout_category', value: 'CT / MRI' }] } as any, q0);
  ok('the question fixes its own window', sp?.time?.period, 'last-90-days');
  const ctB: any = await runStep({ tool: 'metric', args: { metric: 'billed_on_orders', period: sp.time.period, filter: CT } }, 0, k, sp, {}, [], q0);
  const ctC: any = await runStep({ tool: 'metric', args: { metric: 'commission_on_orders', period: sp.time.period, filter: CT } }, 1, k, sp, {}, [], q0);
  ok('CT billed is measurable', ctB.ok && Number(ctB.data?.value) > 0, true, ctB.error);
  ok('CT commission is measurable', ctC.ok && Number(ctC.data?.value) > 0, true, ctC.error);
  const months: string[] = [];
  for (let i = 0; i < 3; i++) {
    const r: any = await runStep({ tool: 'compute', args: { formula: 'capital / ((billed - commission) / 3)', unit: 'months',
      let: { capital: { value: 5000000, unit: 'rupees' }, billed: { step: 0 }, commission: { step: 1 } } } }, 2, k, sp, {}, [{ ...ctB, step: 0 }, { ...ctC, step: 1 }], q0);
    months.push(r.ok ? r.summary.value : `ERR ${r.error}`);
  }
  ok('payback computes, same every time', new Set(months).size === 1 && !months[0].startsWith('ERR'), true, months.join(' / '));
  console.log(`     → ${months[0]} from ₹${Math.round(Number(ctB.data.value)/100).toLocaleString('en-IN')} billed less ₹${Math.round(Number(ctC.data.value)/100).toLocaleString('en-IN')} commission over 90 days`);

  /* THE CONTRACT CHECKS, BOTH DIRECTIONS. These are the last line before an answer reaches the
     owner, and they are pure functions — so there is no excuse for them being the only thing here
     that was never tested. Each is asserted to FIRE on the sentence it exists to catch and to
     stay SILENT on the one it must not, because a contract check that rejects a correct answer
     sends the pipeline into a repair loop and spends the budget getting further from the truth. */
  console.log('\nCONTRACT CHECKS — must fire on the bad sentence, and stay silent on the good one');
  const { checkAnswer } = require('./src/services/pulse/v2/contract');
  const CONTRACT: any = { job: 'magnitude', prose: '', artifact: '', needsArtifact: false, maxNumbers: 9, rowsInProse: true, canShow: [] };
  const fired = (v: string[], re: RegExp) => v.some((x: string) => re.test(x));
  const PER = /no step restricted a time column/, SCO = /no step restricted the rows/;
  const noPeriod = [{ step: 0, ok: true, summary: { value: '₹1,03,400' } }];
  const hasPeriod = [{ step: 0, ok: true, period: '2026-09-01…2026-09-13', summary: { value: '₹1,03,400' } }];
  ok('period: a month claimed with no step period', fired(checkAnswer(CONTRACT, 'billed ₹1,03,400 for the period September 2026.', [], undefined, noPeriod).violations, PER), true);
  ok('period: "in total" is not a period claim', fired(checkAnswer(CONTRACT, 'billed ₹1,03,400 in total.', [], undefined, noPeriod).violations, PER), false);
  ok('period: a real step period passes', fired(checkAnswer(CONTRACT, 'billed ₹1,03,400 for September 2026.', [], undefined, hasPeriod).violations, PER), false);
  const ctSpec: any = { goal: '', scope: [{ term: 'CT', dimension: 'payout_category', value: 'CT / MRI' }] };
  const unscoped = [{ step: 0, ok: true, period: '2026-08-01…2026-09-01', summary: { value: '₹18,93,725' } }];
  const scoped = [{ step: 0, ok: true, period: '2026-08-01…2026-09-01', scope: 'payout_category=CT / MRI', summary: { value: '₹2,38,000' } }];
  ok('scope: a figure called CT with no CT step', fired(checkAnswer(CONTRACT, 'the current CT run-rate is ₹18,93,725 a month.', [], undefined, unscoped, undefined, ctSpec).violations, SCO), true);
  ok('scope: a scoped step passes', fired(checkAnswer(CONTRACT, 'the current CT run-rate is ₹2,38,000 a quarter.', [], undefined, scoped, undefined, ctSpec).violations, SCO), false);
  ok('scope: never naming the scope passes', fired(checkAnswer(CONTRACT, 'total collection was ₹18,93,725 last month.', [], undefined, unscoped, undefined, ctSpec).violations, SCO), false);

  /* verifySpec IS THE THING THAT DECIDES WHETHER A WRONG-SCOPED QUERY SHIPS. It was only ever
     exercised through generated SQL, so it could only be tested by paying for generation. Given
     SQL text it is a pure function, and these are the shapes that matter — including the two that
     look right and restrict nothing: a value inside a CTE no one references, and a predicate
     hanging off a LEFT JOIN. Reachable is not restricting. */
  console.log('\nverifySpec — does the query actually restrict the rows, or only mention the value');
  const { verifySpec } = require('./src/services/pulse/v2/spec');
  const vs: any = { goal: '', scope: [{ term: 'CT', dimension: 'test', value: 'CTBP', confidence: 1, aliases: ['CT-BRAIN PLAIN'] }] };
  const FROM_ORDERS = `FROM "TestOrder" o JOIN "Visit" v ON v.id=o."visitId" JOIN "Branch" br ON br.id=v."branchId"`;
  ok('restricts by the column we inferred', verifySpec(vs, `SELECT SUM(o."priceInPaise") ${FROM_ORDERS} WHERE o."testCodeSnapshot" = 'CTBP'`).ok, true);
  ok('restricts by a DIFFERENT column, same value', verifySpec(vs, `SELECT SUM(o."priceInPaise") ${FROM_ORDERS} WHERE o."testNameSnapshot" = 'CT-BRAIN PLAIN'`).ok, true);
  ok('does not restrict the value at all', verifySpec(vs, `SELECT SUM(o."priceInPaise") ${FROM_ORDERS}`).ok, false);
  ok('the value is only a SELECT label', verifySpec(vs, `SELECT SUM(o."priceInPaise") AS "CTBP" ${FROM_ORDERS}`).ok, false);
  ok('the value sits in an unreferenced CTE', verifySpec(vs, `WITH x AS (SELECT 1 ${FROM_ORDERS} WHERE o."testCodeSnapshot"='CTBP') SELECT SUM(o."priceInPaise") ${FROM_ORDERS}`).ok, false);
  ok('the predicate hangs off a LEFT JOIN', verifySpec(vs, `SELECT SUM(o."priceInPaise") FROM "Visit" v LEFT JOIN "TestOrder" o ON o."visitId"=v.id AND o."testCodeSnapshot"='CTBP'`).ok, false);
  const named: any = { goal: '', scope: [], time: { period: 'last-90-days', from: '2026-06-15', to: '2026-09-13', days: 90, phrase: 'last 90 days' } };
  const planned: any = { goal: '', scope: [], time: { period: 'last-90-days', from: '2026-06-15', to: '2026-09-13', days: 90 } };
  ok('owner named the window, SQL ignores it', verifySpec(named, `SELECT SUM(o."priceInPaise") ${FROM_ORDERS}`).ok, false);
  ok('planner DEFAULT ignored — not enforced', verifySpec(planned, `SELECT SUM(o."priceInPaise") ${FROM_ORDERS}`).ok, true);
  ok('a relative window of the right length counts', verifySpec(named, `SELECT SUM(o."priceInPaise") ${FROM_ORDERS} WHERE o."createdAt" >= CURRENT_DATE - 90`).ok, true);

  console.log('\nAN EMPTY WINDOW IS NOT AN EMPTY RESULT');
  const noPrior: any = await step({ tool: 'quiet_doctors', args: { period: 'last-90-days', priorDays: 180 } });
  ok('a prior window predating all data refuses', noPrior.ok, false, 'zero lapsed doctors would be a claim about the doctors');
  ok('  and names the horizon', /history only begins|no referrals exist between/.test(String(noPrior.error)), true, String(noPrior.error).slice(0, 70));
  const hasPrior: any = await step({ tool: 'quiet_doctors', args: { period: 'last-30-days', priorDays: 30 } });
  ok('a real prior window still answers', hasPrior.ok, true, hasPrior.error);
  ok('  and says what it compared against', /prior window/.test(String(hasPrior.summary?.comparedAgainst)), true);

  console.log(`\n${'═'.repeat(60)}\n  ${pass} passed, ${fail} failed — no model calls\n`);
  await db.$disconnect();
  process.exit(fail ? 1 : 0);
})();
