/**
 * CALCULATION BENCHMARK — questions whose answer is a formula, not an investigation.
 *
 * The case that prompted it: "do u think the 50 lakhs on ct scan machine will be worth it, look
 * at ct referral rates and tell me estimated roi". The answer is
 *
 *     capital / (monthly CT revenue - monthly CT referral commission)
 *     = 50,00,000 / 65,450 = 76 months
 *
 * Three numbers and one division. Pulse spent 15 calls, 10 steps and 4 rounds, manufactured a
 * contradiction between a 30-day figure and a 90-day figure it could not tell apart, and
 * concluded "any ROI figure would be invented" — while step 7 had already computed the correct
 * commission basis and been discarded.
 *
 * So this suite asks a different question from the others. pulse-regression asks "is the number
 * right"; pulse-adversarial asks "did the chain stop when it should have". This asks:
 *
 *     CAN PULSE REPRESENT THE CALCULATION THE QUESTION REQUIRES?
 *
 * Every expected value is computed from the database at run time. Failures are classified, not
 * merely counted, because the classes have different fixes:
 *
 *   CALCULATION    the formula could not be expressed at all — no result produced
 *   OPERAND        a required input was never retrieved
 *   SCOPE          operands came from different periods or populations
 *   PROVENANCE     the loop flagged a contradiction between figures that were never comparable
 *   INVESTIGATION  a closed-form question was investigated instead of computed
 *   PRESENTATION   the arithmetic was right and the artifact did not serve the question
 *
 *   npx ts-node --transpile-only pulse-calc.ts
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';
import { PrismaClient } from '@prisma/client';

/* A BILLING FAILURE IS NOT A QUALITY FAILURE, AND MUST NEVER BE COUNTED AS ONE.
   When the account ran out of balance mid-suite, twenty of twenty-nine cases threw 402 and this
   harness printed "8/29 clean" — a number indistinguishable, from the outside, from a
   catastrophic regression. It cost a measurement and very nearly a wrong conclusion about the
   build. An unusable account is a fact about the ACCOUNT; reporting it as a score is the same
   error this whole layer exists to prevent, committed by the instrument. */
const INFRA = /402|Insufficient Balance|401|invalid_api_key|LLM API key not set|429|rate.?limit|ECONNREFUSED|ENOTFOUND/i;
/** One cheap call before any case runs. `ask()` catches an unusable account internally and
 *  returns a polite refusal, so a dead account looks exactly like a build that fails every
 *  question — which is how twenty 402s were once reported as "8/29 clean". Asked directly, the
 *  error is visible, and the suite refuses to produce a score it cannot stand behind. */
async function preflight(): Promise<void> {
  const { llmJson } = require('./src/services/pulse/llm');
  try { await llmJson('Return JSON {"ok":true}', 'ping', { maxTokens: 20 }); }
  catch (e: any) {
    console.error(`\n  STOPPED BEFORE RUNNING — this is the model account, not the build.\n  ${String(e?.message || e).slice(0, 170)}\n  No score is reported, because nothing was measured.\n`);
    process.exit(2);
  }
}

function bailIfInfra(e: any): void {
  const m = String(e?.message || e);
  if (!INFRA.test(m)) return;
  console.error(`\n  STOPPED — this is the model account, not the build.\n  ${m.slice(0, 160)}\n  No result is reported, because none was measured.\n`);
  process.exit(2);
}


const db = new PrismaClient({ datasources: { db: { url: process.env.ANALYTICS_DATABASE_URL } } });
const q1 = async (sql: string) => (await db.$queryRawUnsafe<any[]>(sql))[0];
const LIVE = `br.code NOT IN ('JGG','IDPL')`;
const IST = (c: string) => `(${c} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;
const ORD = `"TestOrder" o JOIN "Visit" v ON v.id=o."visitId" JOIN "Branch" br ON br.id=v."branchId"`;
/** referral commission is frozen on the ORDER, not derivable from the payout ledger */
const COMM = `CASE WHEN o."referralCommissionType"='PERCENTAGE'
    THEN ROUND(o."priceInPaise" * COALESCE(o."referralCommissionPercentage",0)/100.0)
    ELSE COALESCE(o."referralCommissionAmountInPaise",0) END`;
const R = (p: any) => Math.round(Number(p || 0) / 100);
const money = (n: number) => '₹' + n.toLocaleString('en-IN');

type Klass = 'CORRECT' | 'CALCULATION' | 'OPERAND' | 'SCOPE' | 'PROVENANCE' | 'INVESTIGATION' | 'PRESENTATION';
interface Case {
  id: string; q: string; why: string;
  /** the answer, and how many model calls a competent route would need */
  truth: () => Promise<{ value: number; unit: 'months' | 'rupees' | 'pct' | 'ratio'; shows: string[] }>;
  budget: number;
  /* WHAT THE FORMULA NEEDS. Classified from the TRACE, never from the answer's excuse — "I can't
     calculate CT payback" is OPERAND if the commission was never fetched and CALCULATION if all
     three inputs were sitting there. The two have opposite fixes: retrieve(evidence) versus
     calculate(formula, operands). Reading the sentence instead of the steps would blur exactly
     the distinction this suite exists to draw. */
  operands: { name: string; found: (steps: any[]) => boolean }[];
}
/** did any successful step actually go and get this quantity? */
const fetched = (re: RegExp) => (steps: any[]) => steps.some((e) =>
  e.ok && re.test(`${e.sql ?? ''} ${e.detail ?? ''} ${e.label ?? ''} ${e.means ?? ''}`));
const CT = /CT ?\/ ?MRI|CT-BRAIN|CTBP|\bCT\b/i;
const REV = /priceInPaise|net_billed|netBilled|revenue|collected/i;
const CMM = /referralCommission|commission|payout/i;

const CASES: Case[] = [
  { id: 'CT_PAYBACK', operands: [{ name:'CT revenue', found: fetched(/(?=.*CT)(?=.*(priceInPaise|net_billed|revenue))/is) },
      { name:'CT commission', found: fetched(/(?=.*CT)(?=.*(referralCommission|commission))/is) },
      { name:'capital ₹50,00,000', found: () => true }], budget: 6, why: 'the real question — capital ÷ monthly contribution',
    q: 'do u think the 50 lakhs on ct scan machine will be worth it, look at ct referral rates and tell me estimated roi',
    truth: async () => {
      const r = await q1(`SELECT AVG(c) v FROM (
        SELECT to_char(${IST('o."createdAt"')},'YYYY-MM') m, SUM(o."priceInPaise") - SUM(${COMM}) c
        FROM ${ORD} WHERE o."payoutCategorySnapshot"='CT / MRI' AND ${LIVE}
          AND ${IST('o."createdAt"')} >= date_trunc('month', CURRENT_DATE - interval '3 months')
          AND ${IST('o."createdAt"')} <  date_trunc('month', CURRENT_DATE) GROUP BY 1) x`);
      const perMonth = R(r.v);
      return { value: Math.round(5000000 / perMonth), unit: 'months', shows: [String(Math.round(5000000/perMonth)), money(perMonth)] };
    } },

  { id: 'CT_PAYBACK_PLAIN', operands: [{ name:'CT revenue', found: fetched(/(?=.*CT)(?=.*(priceInPaise|net_billed|revenue))/is) },
      { name:'CT commission', found: fetched(/(?=.*CT)(?=.*(referralCommission|commission))/is) },
      { name:'capital ₹50,00,000', found: () => true }], budget: 5, why: 'the same formula, asked plainly — does phrasing change the route?',
    q: 'how many months would it take to pay back a 50 lakh CT scanner at our current CT volume',
    truth: async () => {
      const r = await q1(`SELECT AVG(c) v FROM (
        SELECT to_char(${IST('o."createdAt"')},'YYYY-MM') m, SUM(o."priceInPaise") - SUM(${COMM}) c
        FROM ${ORD} WHERE o."payoutCategorySnapshot"='CT / MRI' AND ${LIVE}
          AND ${IST('o."createdAt"')} >= date_trunc('month', CURRENT_DATE - interval '3 months')
          AND ${IST('o."createdAt"')} <  date_trunc('month', CURRENT_DATE) GROUP BY 1) x`);
      const m = Math.round(5000000 / R(r.v));
      return { value: m, unit: 'months', shows: [String(m)] };
    } },

  { id: 'REV_PER_SCAN', operands: [{ name:'imaging revenue', found: fetched(REV) }, { name:'imaging order count', found: fetched(/count|orders|test_orders/i) }], budget: 4, why: 'a ratio over one population — revenue ÷ orders',
    q: 'what is our average revenue per imaging scan over the last 90 days',
    truth: async () => {
      const r = await q1(`SELECT SUM(o."priceInPaise") p, COUNT(*) n FROM ${ORD}
        WHERE o."payoutCategorySnapshot" IN ('Ultrasound','Ultrasound Tiffa','2D Echo','X-Ray','Dental X-Ray','CT / MRI')
          AND ${LIVE} AND ${IST('o."createdAt"')} >= CURRENT_DATE - 90`);
      const v = Math.round(R(r.p) / Number(r.n));
      return { value: v, unit: 'rupees', shows: [money(v)] };
    } },

  { id: 'COMM_PCT', operands: [{ name:'imaging revenue', found: fetched(REV) }, { name:'imaging commission', found: fetched(CMM) }], budget: 4, why: 'commission as a share of revenue — two operands, same scope',
    q: 'what percentage of our imaging revenue goes out as referral commission, last 90 days',
    truth: async () => {
      const r = await q1(`SELECT SUM(o."priceInPaise") p, SUM(${COMM}) c FROM ${ORD}
        WHERE o."payoutCategorySnapshot" IN ('Ultrasound','Ultrasound Tiffa','2D Echo','X-Ray','Dental X-Ray','CT / MRI')
          AND ${LIVE} AND ${IST('o."createdAt"')} >= CURRENT_DATE - 90`);
      const v = Number((Number(r.c) / Number(r.p) * 100).toFixed(1));
      return { value: v, unit: 'pct', shows: [String(v)] };
    } },

  { id: 'CT_MARGIN', operands: [{ name:'CT revenue', found: fetched(/(?=.*CT)(?=.*(priceInPaise|net_billed|revenue))/is) },
      { name:'CT commission', found: fetched(/(?=.*CT)(?=.*(referralCommission|commission))/is) },
      { name:'CT order count', found: fetched(/count|orders|test_orders/i) }], budget: 4, why: 'contribution per unit — the operand the ROI turns on',
    q: 'what is the contribution margin per CT scan after referral commission',
    truth: async () => {
      const r = await q1(`SELECT SUM(o."priceInPaise") - SUM(${COMM}) c, COUNT(*) n FROM ${ORD}
        WHERE o."payoutCategorySnapshot"='CT / MRI' AND ${LIVE} AND ${IST('o."createdAt"')} >= CURRENT_DATE - 90`);
      const v = Math.round(R(r.c) / Number(r.n));
      return { value: v, unit: 'rupees', shows: [money(v)] };
    } },

  { id: 'RUN_RATE', operands: [{ name:'collection so far', found: fetched(/revenue|collected|amountInPaise/i) }, { name:'days elapsed', found: () => true }], budget: 4, why: 'pace × period — a projection from an incomplete month',
    q: 'at our current pace what will this month total collection come to',
    truth: async () => {
      const r = await q1(`SELECT SUM(CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" ELSE pt."amountInPaise" END) p
        FROM "PaymentTransaction" pt JOIN "Bill" b ON b.id=pt."billId" JOIN "Branch" br ON br.id=b."branchId"
        WHERE ${LIVE} AND ${IST('pt."transactionDate"')} >= date_trunc('month', CURRENT_DATE)
          AND ${IST('pt."transactionDate"')} < CURRENT_DATE`);
      const el = new Date().getUTCDate() - 1;
      const v = Math.round(R(r.p) / Math.max(el, 1) * 30);
      return { value: v, unit: 'rupees', shows: [] };   // tolerance-checked, not string-matched
    } },
];

const ONLY = process.argv.slice(2).filter((x) => !x.startsWith('-'));
/* NUMBERS THAT CARRY THE RIGHT UNIT, not every number in the prose.
   Matching bare digits scored "₹1,260 across 920 scans" as CORRECT against a truth of ₹950,
   because the SCAN COUNT 920 is within 12% of a RUPEE figure. The instrument was reporting a
   pass on a coincidence of magnitude between two different kinds of quantity. A grader that
   cannot tell rupees from scans cannot grade a calculation.
   "21.9 lakh" and "₹21,71,277" are the same money written two ways, so lakh/crore are scaled. */
function digitsWithUnit(s: string, unit: string): number[] {
  const txt = String(s);
  const out: number[] = [];
  const push = (raw: string, mult = 1) => { const n = Number(raw.replace(/,/g, '')) * mult; if (Number.isFinite(n)) out.push(n); };
  if (unit === 'rupees') {
    for (const m of txt.matchAll(/₹\s*([\d,]+(?:\.\d+)?)\s*(lakhs?|crores?|k\b)?/gi))
      push(m[1], /lakh/i.test(m[2] || '') ? 1e5 : /crore/i.test(m[2] || '') ? 1e7 : /^k$/i.test(m[2] || '') ? 1e3 : 1);
  } else if (unit === 'months') {
    for (const m of txt.matchAll(/([\d,]+(?:\.\d+)?)\s*(months?|years?)/gi)) push(m[1], /year/i.test(m[2]) ? 12 : 1);
  } else if (unit === 'pct') {
    for (const m of txt.matchAll(/([\d,]+(?:\.\d+)?)\s*%/g)) push(m[1]);
  } else {
    for (const m of txt.matchAll(/[\d,]+(?:\.\d+)?/g)) push(m[0]);
  }
  return out;
}
const near = (a: number, b: number, tol = 0.12) => Math.abs(a - b) / Math.max(Math.abs(b), 1) <= tol;

(async () => {
  await preflight();
  const tally: Record<Klass, number> = { CORRECT:0, CALCULATION:0, OPERAND:0, SCOPE:0, PROVENANCE:0, INVESTIGATION:0, PRESENTATION:0 };
  for (const c of CASES) {
    if (ONLY.length && !ONLY.includes(c.id)) continue;
    const t = await c.truth();
    let a: any; const t0 = Date.now();
    try { a = await ask(c.q, {}); } catch (e: any) { bailIfInfra(e); console.log(`✗ THREW ${c.id}`); continue; }
    const text = String(a.segments?.verdict ? [a.segments.verdict, ...(a.segments.points||[]).map((p:any)=>p.text), a.segments.caveat, a.segments.action].filter(Boolean).join(' ') : a.text || '');
    const tr = a.trace || {};
    const nums = digitsWithUnit(text, String(t.unit || 'number'));
    const got = nums.some((n) => near(n, t.value));
    const cantSay = /could not establish|cannot (give|say|quote)|would be invented|not.*established|unresolved|no .*figure/i.test(text);
    const contradictions = (tr.investigation?.contradictions || []).length;
    const arts = (a.artifacts || []).length;

    // classify from the STEPS, not the sentence
    const steps = tr.executed || [];
    const missing = c.operands.filter((o) => !o.found(steps)).map((o) => o.name);

    let k: Klass;
    if (got && tr.calls <= c.budget * 2) k = 'CORRECT';
    else if (got) k = 'INVESTIGATION';                 // right answer, wrong route
    else if (missing.length) k = 'OPERAND';            // an input was never fetched
    else if (contradictions) k = 'PROVENANCE';         // inputs present, compared incomparably
    else k = 'CALCULATION';                            // every input present, no formula
    if (k === 'CORRECT' && arts === 0) k = 'PRESENTATION';
    tally[k]++;

    const want = t.unit === 'months' ? `${t.value} months` : t.unit === 'pct' ? `${t.value}%` : money(t.value);
    console.log(`${got ? '✓' : '✗'} ${k.padEnd(13)} ${String(tr.calls ?? '-').padStart(2)}c/${c.budget}  ${String(Math.round((Date.now()-t0)/1000)).padStart(3)}s  arts=${arts}  want ${want.padEnd(14)} ${c.id}`);
    console.log(`     ${text.replace(/\s+/g,' ').slice(0, 150)}`);
    console.log(`     operands: ${c.operands.map((o) => `${o.found(steps) ? '✓' : '✗'} ${o.name}`).join('  ')}`);
    if (contradictions) console.log(`     ⚠ ${contradictions} contradiction(s) flagged between steps`);
  }
  console.log(`\n${'═'.repeat(72)}`);
  for (const [k, v] of Object.entries(tally)) if (v) console.log(`  ${String(v).padStart(2)} × ${k}`);
  console.log(`\n  ${tally.CORRECT}/${CASES.length} answered the calculation the question asked for.`);
  console.log(`\n  OPERAND-heavy  → build retrieval/scope, a calculation engine will not help`);
  console.log(`  CALCULATION-heavy → build formula representation: the inputs were already there`);
  await db.$disconnect(); process.exit(0);
})();
