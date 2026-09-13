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
  const CT = { payout_category: 'CT / MRI' };
  const wrong: any = await step({ tool: 'metric', args: { metric: 'revenue', period: 'last_90_days', filter: CT } });
  ok('revenue refuses a work scope', wrong.ok, false, 'cash lives on payments, not orders');
  ok('  and names the metric that can', /billed_on_orders/.test(String(wrong.error)), true, String(wrong.error).slice(0, 80));
  ok('  value metric ranked above cost', String(wrong.error).indexOf('billed_on_orders') < String(wrong.error).indexOf('commission_on_orders'), true);
  const right: any = await step({ tool: 'metric', args: { metric: 'billed_on_orders', period: 'last_90_days', filter: CT } });
  ok('the named metric actually answers', right.ok, true, right.error);
  const plain: any = await step({ tool: 'metric', args: { metric: 'revenue', period: 'last_90_days' } });
  ok('unscoped revenue still works', plain.ok, true, 'the guard must not block the common case');

  console.log(`\n${'═'.repeat(60)}\n  ${pass} passed, ${fail} failed — no model calls\n`);
  await db.$disconnect();
  process.exit(fail ? 1 : 0);
})();
