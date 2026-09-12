/**
 * Pulse regression — every expected value is computed from the database at run time, never
 * hardcoded. Four separate times a hardcoded or subtly-wrong scorer sent me chasing a bug that
 * was in the test rather than the product, so the harness derives its own truth and the only
 * thing asserted is that Pulse's prose contains the number the database gives back right now.
 *
 *   npx ts-node --transpile-only pulse-regression.ts
 */
import 'dotenv/config';
import { ask } from './src/services/pulse/index';
import { ensureKnowledge, resolveTerm, concepts } from './src/services/pulse/knowledge';
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient({ datasources: { db: { url: process.env.ANALYTICS_DATABASE_URL } } });
const q = (s: string) => db.$queryRawUnsafe<any[]>(s);
const IST = (c: string) => `(${c} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;
/* Today in IST, not the database's UTC date. The columns were being converted and the BOUNDARIES
   were not, so between 18:30 UTC and midnight the harness compared a window one day behind the
   one Pulse had correctly used, and failed two cases that were right. Half a timezone conversion
   is worse than none: it looks converted. */
/* NOT the double conversion used for columns above. A Prisma DateTime column is a NAIVE
   timestamp, so it needs `AT TIME ZONE 'UTC'` first to say what it is; CURRENT_TIMESTAMP already
   knows its zone, and converting it twice lands a day early — which is how the first attempt at
   this fix took the suite from 10/12 to 8/12. Verified against the database: at 00:01 IST,
   CURRENT_DATE and the double conversion both say the 11th; this says the 12th. */
const TODAY = `(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date`;
const COLL = `SUM(CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" ELSE pt."amountInPaise" END)`;
const DUE = `(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise")`;
const PAY = `"PaymentTransaction" pt JOIN "Bill" b ON b.id=pt."billId" JOIN "Branch" br ON br.id=b."branchId"`;
/* The owner says JGG and IDPL exist only for testing, so their rows are not trade and do not
   belong in "what the business earned". Ground truth has to hold the same definition the product
   does, or the suite reports a correct answer as a failure — which is what it just did. */
const LIVE = `br.code NOT IN ('JGG','IDPL')`;

/** Pulse counts WHOLE days — today is still running, so it is excluded from a trailing window,
 *  deliberately, so a comparison is like-for-like. Three times now a window that included today
 *  made a correct answer look wrong. Every trailing window in this file goes through here. */
const lastDays = (col: string, n: number) =>
  `${IST(col)} >= ${TODAY} - ${n} AND ${IST(col)} < ${TODAY}`;
const IMG = `('Ultrasound','Ultrasound Tiffa','2D Echo','X-Ray','Dental X-Ray','CT / MRI')`;
const ORD = `"TestOrder" o JOIN "Branch" br ON br.id=o."branchId"`;
const AUG = `${IST('o."createdAt"')}>='2026-08-01' AND ${IST('o."createdAt"')}<'2026-09-01'`;

/** rupees, the way Pulse writes them, so a substring match is meaningful */
const R = (p: any) => '₹' + Math.round(Number(p) / 100).toLocaleString('en-IN');
const N = (n: any) => Number(n).toLocaleString('en-IN');

/* ── SQL SHAPE ASSERTIONS ──────────────────────────────────────────────────────────────────
 * A money answer can be right by accident. "how much has CT-BRAIN PLAIN been billed for"
 * returned Rs 1,03,400 on one run and Rs 83,700 on the next, from two different grains — line
 * items on one, whole-bill totals on the other — and a value-only assertion would have called
 * one of those a pass. So these cases assert the QUERY: the right grain, and the right entity.
 * Checking only for the presence or absence of SUM is not enough; a total and a rate can both
 * contain one. */
const sumsOrderLines = (sql: string) => /SUM\s*\(\s*[\w.\"]*"priceInPaise"/i.test(sql) && /"TestOrder"/.test(sql);
const sumsBillTotals = (sql: string) => /SUM\s*\([^)]*"totalAmountInPaise"/i.test(sql);
const readsUnitPrice = (sql: string) => /"BillableProduct"/.test(sql) && /"basePriceInPaise"/.test(sql);
/** The scan, not the two-letter lab code that happens to start its name. */
const isTheScan = (sql: string) => /'CTBP'/i.test(sql) || /CT-?\s?BRAIN\s?PLAIN/i.test(sql);
const isClottingTime = (sql: string) => /=\s*'CT'|IN\s*\(\s*'CT'\s*[,)]/i.test(sql);

const CASES: Array<{ id: string; q: string; truth: () => Promise<string>; note: string;
  /** returns a reason the QUERY is wrong, or null. Runs even when the number matched. */
  sql?: (sql: string) => string | null;
  /** carry the previous turn's state, for follow-ups */
  state?: 'carry' }> = [

  { id: 'TEST_BILLED', note: 'answered Rs 1,918 — the CLOTTING TIME figure — for a brain scan',
    q: 'how much has CT-BRAIN PLAIN been billed for',
    truth: async () => R((await q(`SELECT SUM(o."priceInPaise") p FROM ${ORD} WHERE o."testCodeSnapshot"='CTBP' AND ${LIVE}`))[0].p),
    sql: (x) => !isTheScan(x) ? 'does not filter to the CT-BRAIN PLAIN identity'
      : isClottingTime(x) ? "filters on 'CT' — that is CLOTTING TIME, a different test"
      : sumsBillTotals(x) ? 'sums whole-bill totals: those bills hold other tests too'
      : !sumsOrderLines(x) ? "does not aggregate that test's own TestOrder line prices" : null },

  { id: 'TEST_RATE', note: 'a rate is not a total — reported the 47-order sum as what one scan costs',
    q: 'give me cost', state: 'carry',
    truth: async () => R((await q(`SELECT "basePriceInPaise" p FROM "BillableProduct" WHERE code='CTBP'`))[0].p),
    sql: (x) => !readsUnitPrice(x) ? 'does not read the per-unit BillableProduct.basePriceInPaise'
      : sumsOrderLines(x) ? 'aggregates TestOrder prices — that is a total, not a rate'
      : !isTheScan(x) ? 'does not filter to the CT-BRAIN PLAIN identity' : null },

  { id: 'LAB_SCOPE', note: 'the qualifier that used to be dropped silently',
    q: 'what was last week collection chintal only lab',
    truth: async () => R((await q(`SELECT ${COLL} p FROM ${PAY} JOIN "Visit" v ON v.id=b."visitId" WHERE br.code='CNT' AND v.domain='DIAGNOSTICS' AND ${lastDays('pt."transactionDate"', 7)}`))[0].p) },

  { id: 'BRANCH_DAY', note: 'branch + single day',
    q: 'how much collection yesterday chintal',
    truth: async () => R((await q(`SELECT ${COLL} p FROM ${PAY} WHERE br.code='CNT' AND ${IST('pt."transactionDate"')} >= ${TODAY} - 1 AND ${IST('pt."transactionDate"')} < ${TODAY}`))[0].p) },

  { id: 'DUES_TOTAL', note: 'the list that reported 10/₹5,002 where 11 owed ₹5,802',
    q: 'give me list of all dues with name number amt from oldest to newest',
    truth: async () => R((await q(`SELECT SUM(${DUE}) p FROM "Bill" b WHERE ${DUE} > 0`))[0].p) },

  { id: 'DUES_COUNT', note: 'and the count, under a "complete list" headline',
    q: 'how many patients have outstanding dues',
    truth: async () => N((await q(`SELECT COUNT(*)::int n FROM "Bill" b WHERE ${DUE} > 0`))[0].n) },

  { id: 'SCANS', note: '"scan" collapsed to every test order — 5,104 instead of 528',
    q: 'how many scans last month in chintal',
    truth: async () => N((await q(`SELECT COUNT(*)::int n FROM ${ORD} WHERE br.code='CNT' AND o."cancelledAt" IS NULL AND ${AUG} AND o."payoutCategorySnapshot" IN ${IMG}`))[0].n) },

  { id: 'XRAY', note: 'a modality that rolls up two payout categories',
    q: 'how many x-ray scans last month in chintal',
    truth: async () => N((await q(`SELECT COUNT(*)::int n FROM ${ORD} WHERE br.code='CNT' AND o."cancelledAt" IS NULL AND ${AUG} AND o."payoutCategorySnapshot" IN ('X-Ray','Dental X-Ray')`))[0].n) },

  { id: 'NET_BILLED', note: 'reached the owner as a bare 435,854,453 — 100x the truth',
    q: 'what is our total net billed all time',
    truth: async () => R((await q(`SELECT SUM(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise") p FROM "Bill" b JOIN "Branch" br ON br.id=b."branchId" WHERE ${LIVE}`))[0].p) },

  { id: 'TURNOVER', note: 'turnover must mean collected, not billed',
    q: 'what is turnover of this month',
    truth: async () => R((await q(`SELECT ${COLL} p FROM ${PAY} WHERE ${LIVE} AND ${IST('pt."transactionDate"')} >= date_trunc('month', ${TODAY}) AND ${IST('pt."transactionDate"')} < ${TODAY}`))[0].p) },

  { id: 'DISCOUNT_REASON', note: 'the top discount reason by value',
    q: 'break down discounts at chintal in the last 30 days by reason',
    truth: async () => R((await q(`SELECT SUM(b."discountAmountInPaise") p FROM "Bill" b JOIN "Branch" br ON br.id=b."branchId" WHERE br.code='CNT' AND b."discountAmountInPaise">0 AND ${lastDays('b."createdAt"', 30)} GROUP BY TRIM(b."discountReason") ORDER BY 1 DESC LIMIT 1`))[0].p) },

  { id: 'STAFF', note: 'answered "no field anywhere records mistakes" — 44k rows say otherwise',
    q: 'which staff makes most mistakes',
    truth: async () => (await q(`SELECT COALESCE(ae."actorName",'(unattributed)') w FROM "AnomalyEvent" ae WHERE ae."occurredAt" > now() - interval '30 days' AND ae.severity='high' GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`))[0].w },

  { id: 'REFUNDS', note: 'operational table that was never reached',
    q: 'how many refunds did we process in total',
    truth: async () => N((await q(`SELECT COUNT(*)::int n FROM "OrderRefund" orf JOIN "Visit" v ON v.id=orf."visitId" JOIN "Branch" br ON br.id=v."branchId" WHERE ${LIVE}`))[0].n) },

  { id: 'WHATSAPP', note: 'message delivery',
    q: 'how many whatsapp messages did we send last month',
    truth: async () => N((await q(`SELECT COUNT(*)::int n FROM "MessageLog" WHERE ${IST('"createdAt"')}>='2026-08-01' AND ${IST('"createdAt"')}<'2026-09-01'`))[0].n) },
];

/**
 * THE RESOLVER, before any model call. Deterministic, so it runs first and costs nothing.
 *
 * A two-letter lab code must never win a name it merely begins. This is not a CT special case —
 * the property is general: a concept term must resolve to ITSELF, whatever shorter terms happen
 * to be substrings of it. Asserting only the CT example would leave the next collision to be
 * found in production, the way this one was.
 */
async function resolverChecks(): Promise<string[]> {
  await ensureKnowledge();
  const bad: string[] = [];
  const best = (t: string) => resolveTerm(t)[0];

  if (best('CT-BRAIN PLAIN')?.value !== 'CTBP')
    bad.push(`CT-BRAIN PLAIN resolves to ${best('CT-BRAIN PLAIN')?.value ?? 'nothing'}, not CTBP`);
  for (const phrasing of ['CT-BRAIN PLAIN', 'ct brain plain', 'CT BRAIN PLAIN', 'ct-brain plain'])
    if (resolveTerm(phrasing).some((c) => c.value === 'CT'))
      bad.push(`"${phrasing}" still admits CT (Clotting Time) as a committable match`);
  if (best('CT')?.value !== 'CT') bad.push('the code CT no longer resolves to itself');

  // the general property: every long concept term resolves to itself, not to a substring of it
  const long = concepts().filter((c) => c.term.length >= 8 && c.dimension).slice(0, 40);
  for (const c of long) {
    const top = best(c.term);
    if (top && top.value !== c.value && top.term.length < c.term.length)
      bad.push(`"${c.term}" is outranked by the shorter "${top.term}" (${top.value})`);
  }

  // the owner's own words for his own schema
  for (const [t, v] of [['reportable', 'REPORTABLE'], ['bill only', 'BILL_ONLY'],
    ['external', 'EXTERNAL_UPLOAD'], ['external reports', 'EXTERNAL_UPLOAD']] as [string, string][])
    if (!resolveTerm(t).some((c) => c.value === v)) bad.push(`"${t}" does not resolve to ${v}`);
  return bad;
}

(async () => {
  let pass = 0; const fails: string[] = [];
  const bad = await resolverChecks();
  console.log(bad.length ? `\u2717 RESOLVER\n  ${bad.join('\n  ')}\n` : '\u2713 RESOLVER        ranking holds\n');
  let state: any = {};
  for (const c of CASES) {
    const want = await c.truth();
    const t = Date.now();
    let txt = '', sqlSeen = '';
    try {
      const a: any = await ask(c.q, c.state === 'carry' ? state : {});
      if (a?.state) state = a.state;
      sqlSeen = (a.trace?.executed || []).filter((e: any) => e.ok && e.sql).map((e: any) => e.sql).join('\n');
      // The answer is text PLUS artifacts. Shapes that push detail onto the screen (breakdown,
      // ranking, list) deliberately keep per-row numbers OUT of the prose, so asserting on text
      // alone marks a correct answer wrong — the figure is in the table, which is where the
      // contract says it belongs.
      const rows = JSON.stringify(a.state?.lastTurn?.artifacts ?? a.artifacts ?? []);
      txt = `${a.text ?? ''} ${rows}`;
    } catch (e: any) { txt = `THREW ${e?.message}`; }
    // accept the figure with or without thousands separators, since prose varies
    // A small count is often spelled out — "Nine patients currently have outstanding dues" is
    // the right answer and the digit never appears. The assertion is about the VALUE, not how
    // the sentence happens to render it; without this the case passes or fails by coin toss.
    const WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'];
    const asInt = Number(want.replace(/[^0-9]/g, ''));
    const spelled = !want.startsWith('\u20b9') && Number.isInteger(asInt) && asInt < WORDS.length
      && new RegExp('\\b' + WORDS[asInt] + '\\b', 'i').test(txt);
    const valueOk = txt.includes(want) || txt.replace(/,/g, '').includes(want.replace(/,/g, '')) || spelled;
    // The number being right is not the same as the question being answered. A case that declares
    // a shape must satisfy it even when the figure matched — that is the whole point of adding it.
    const shapeErr = c.sql ? (sqlSeen ? c.sql(sqlSeen) : 'no SQL ran, so the grain cannot be checked') : null;
    const ok = valueOk && !shapeErr;
    if (ok) pass++;
    else fails.push(`${c.id}: ${!valueOk ? `wanted ${want}` : 'right number, wrong query'} — ${c.note}`
      + (shapeErr ? `\n      SQL: ${shapeErr}` : '')
      + (!valueOk ? `\n      got: ${txt.replace(/\s+/g, ' ').slice(0, 150)}` : ''));
    console.log(`${ok ? '✓' : '✗'} ${c.id.padEnd(16)} want ${want.padEnd(12)} ${Date.now() - t}ms${shapeErr && valueOk ? '  (value ok, SQL wrong)' : ''}`);
  }
  console.log(`\n${pass}/${CASES.length} pass`);
  if (fails.length) console.log('\nFAILURES\n  ' + fails.join('\n  '));
  await db.$disconnect(); process.exit(0);
})();
