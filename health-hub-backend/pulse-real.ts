/**
 * PULSE ON THE OWNER'S OWN QUESTIONS — scored against the owner's own pages.
 *
 * Every question here was typed into Pulse in production, in the owner's words, typos included.
 * The right answer is computed at run time from the same money engine the dashboard and the
 * Money page read (getMoneyFacts / getCollectedSplits), or from plain SQL where no page exists,
 * so "correct" means "agrees with what the owner already sees", never "agrees with Pulse".
 *
 * How a case passes: every figure of at least one acceptable answer appears in what the owner
 * reads — the prose or a card — at the precision it was written ("₹1.3 lakh" matches 1,32,500;
 * "₹1,32,500" must be exact to the rupee). An ambiguous phrase ("last week") lists each reading
 * as an acceptable answer instead of picking one. A hedge with no figure fails.
 *
 * Each question runs K times (PULSE_K, default 3): pass-all is the headline, pass-any shows the
 * ceiling, and the gap between them is the model's own run-to-run noise. Held-out cases are
 * reported as a total only — they are not to be tuned against.
 *
 *   npx ts-node --transpile-only pulse-real.ts            # K runs, all cases (spends credit)
 *   npx ts-node --transpile-only pulse-real.ts --judge    # check the scorer itself, no model calls
 *   PULSE_ONLY=coll_yday,ct_cost npx ts-node ...           # just these cases
 */
import 'dotenv/config';
import * as fs from 'fs';
import { ask } from './src/services/pulse/index';
import { todayIST } from './src/services/pulse/db';
import { groundNumbers, unsupported } from './src/services/pulse/v2/grounding';
import { DUE, OWES } from './src/services/pulse/catalog';
import prisma from './src/lib/prisma';
import { getMoneyFacts, totalsOf, getCollectedSplits, getCollectedByDay } from './src/services/moneyFactsService';

// ── time, in IST ──────────────────────────────────────────────────────────────────────────
const T = todayIST();
const add = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const at = (d: string) => new Date(`${d}T00:00:00+05:30`);
const monthStart = (d: string, back = 0) => { const [y, m] = d.split('-').map(Number); const z = new Date(Date.UTC(y, m - 1 - back, 1)); return z.toISOString().slice(0, 10); };
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();           // 0 = Sunday
const lastMon = add(T, -((dow(T) + 6) % 7) - 7);                              // Monday of last week
type Win = { from: string; to: string; label: string };
const W = {
  yday: { from: add(T, -1), to: T, label: 'yesterday' },
  mtd: [{ from: monthStart(T), to: T, label: 'month to yesterday' }, { from: monthStart(T), to: add(T, 1), label: 'month to now' }],
  lastMonth: { from: monthStart(T, 1), to: monthStart(T), label: 'last month' },
  lastWeek: [{ from: add(T, -7), to: T, label: 'last 7 days' }, { from: lastMon, to: add(lastMon, 7), label: 'last Mon–Sun' }],
  last3m: [{ from: add(T, -90), to: T, label: 'last 90 days' }, { from: monthStart(T, 3), to: monthStart(T), label: '3 whole months' },
    { from: monthStart(T, 2), to: add(T, 1), label: '3 months incl. this one' }],
};

// ── truth, from the owner's own engine ────────────────────────────────────────────────────
let BR: Record<string, string> | null = null;
const branchId = async (code: string) => { BR ??= Object.fromEntries((await prisma.branch.findMany({ select: { id: true, code: true } })).map((b) => [b.code, b.id])); return BR[code]; };
const rs = (paise: number) => Math.round(paise) / 100;
async function collected(w: Win, code?: string, domain?: 'DIAGNOSTICS' | 'CLINIC'): Promise<number> {
  const days = await getCollectedByDay({ start: at(w.from), end: at(w.to), branchId: code ? await branchId(code) : null, domain: domain ?? null });
  return rs(days.reduce((t, d) => t + d.collected, 0));
}
async function collectedBy(w: Win, cats: string[], code?: string): Promise<number> {
  const s = await getCollectedSplits({ start: at(w.from), end: at(w.to), branchId: code ? await branchId(code) : null, domain: null }, at(w.from), at(w.from));
  return rs(s.filter((x) => cats.includes(x.category)).reduce((t, x) => t + x.collected, 0));
}
const sql = <R = any>(q: string) => prisma.$queryRawUnsafe<R[]>(q);
const IST = (c: string) => `(${c} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata')`;
const inWin = (c: string, w: Win) => `${IST(c)} >= '${w.from}' AND ${IST(c)} < '${w.to}'`;
const IMAGING = `('Ultrasound','Ultrasound Tiffa','2D Echo','X-Ray','Dental X-Ray','CT / MRI')`;
async function orders(w: Win, cats: string, code?: string): Promise<number> {
  const r = await sql(`SELECT count(*)::int n FROM "TestOrder" o JOIN "Branch" br ON br.id=o."branchId"
    WHERE o."cancelledAt" IS NULL AND o."replacedAt" IS NULL AND o."payoutCategorySnapshot" IN ${cats} AND ${inWin('o."createdAt"', w)} ${code ? `AND br.code='${code}'` : ''}`);
  return r[0].n;
}

// ── what a case expects ──────────────────────────────────────────────────────────────────
/** One acceptable answer: every value must be visible, every name must be present. */
interface Alt { label: string; values?: number[]; names?: string[]; list?: { ids: string[]; oldestFirst?: string } }
type Kind = 'value' | 'list' | 'guard' | 'open';
interface Case { id: string; q: string; setup?: string[]; kind: Kind; heldOut?: boolean; truth?: () => Promise<Alt[]>; guard?: RegExp }

const cross = async (wins: Win[], f: (w: Win) => Promise<number>) => Promise.all(wins.map(async (w) => ({ label: w.label, values: [await f(w)] })));

export const CASES: Case[] = [
  // plain figures
  { id: 'coll_yday', q: 'how much was yesterdays colleciton', kind: 'value',
    truth: async () => [{ label: 'yesterday', values: [await collected(W.yday)] }] },
  { id: 'coll_yday_cnt_followup', setup: ['how much was yestredays collection'], q: 'collection in chintal?', kind: 'value',
    truth: async () => [{ label: 'yesterday, CNT', values: [await collected(W.yday, 'CNT')] }] },
  { id: 'coll_yday_cnt', q: 'how much collection patient yesterday chintal', kind: 'value',
    truth: async () => [{ label: 'yesterday, CNT', values: [await collected(W.yday, 'CNT')] }] },
  { id: 'coll_yday_mode', q: 'how much was yestredays collection, by payment mode', kind: 'value',
    truth: async () => { const t = totalsOf((await getMoneyFacts({ start: at(W.yday.from), end: at(W.yday.to), branchId: null, domain: null })).days);
      return [{ label: 'cash and online', values: [rs(t.cash), rs(t.online)].filter((v) => v > 0) }]; } },
  { id: 'coll_week_cnt', q: 'what was last weeks collection chintal', kind: 'value', heldOut: true,
    truth: () => cross(W.lastWeek, (w) => collected(w, 'CNT')) },
  { id: 'coll_week_cnt_lab', q: 'what was last week collection chintal only lab', kind: 'value',
    // "lab" is the diagnostics register, or the Laboratory department — both readings stand
    truth: async () => [...await cross(W.lastWeek, (w) => collected(w, 'CNT', 'DIAGNOSTICS')),
      ...(await cross(W.lastWeek, (w) => collectedBy(w, ['Laboratory'], 'CNT'))).map((a) => ({ ...a, label: `${a.label}, Laboratory only` }))] },
  { id: 'turnover_mtd', q: 'what is turnover of this month', kind: 'value',
    truth: () => cross(W.mtd, (w) => collected(w)) },
  { id: 'turnover_branch', setup: ['what is turnover of this month'], q: 'need branch wise', kind: 'value',
    truth: async () => Promise.all(W.mtd.map(async (w) => ({ label: w.label, values: [await collected(w, 'CNT'), await collected(w, 'BLN')] }))) },
  { id: 'mtd_vs_last', q: 'how was this months collection going comapred to last month', kind: 'value',
    truth: () => cross(W.mtd, (w) => collected(w)) },
  { id: 'coll_vs_fridays', q: 'forget that how was yesterdays collection compared to every friday recodred makea line graph', kind: 'value',
    truth: async () => [{ label: 'yesterday', values: [await collected(W.yday)] }] },

  // volume
  { id: 'scans_cnt', q: 'how many scans last month in chintal', kind: 'value',
    truth: async () => [{ label: 'imaging orders, CNT, last month', values: [await orders(W.lastMonth, IMAGING, 'CNT')] }] },
  { id: 'usg_cnt', setup: ['how many scans last month in chintal'], q: 'i meant what all scans are icluded for example how many ultrasound scans', kind: 'value',
    truth: async () => [
      { label: 'ultrasound incl. echo', values: [await orders(W.lastMonth, `('Ultrasound','Ultrasound Tiffa','2D Echo')`, 'CNT')] },
      { label: 'ultrasound excl. echo', values: [await orders(W.lastMonth, `('Ultrasound','Ultrasound Tiffa')`, 'CNT')] }] },
  { id: 'usg_top_branch', q: 'in last 3 months which branch has highest amount of ultrasound scans', kind: 'value', heldOut: true,
    truth: async () => Promise.all(W.last3m.map(async (w) => {
      const [c, b] = [await orders(w, `('Ultrasound','Ultrasound Tiffa','2D Echo')`, 'CNT'), await orders(w, `('Ultrasound','Ultrasound Tiffa','2D Echo')`, 'BLN')];
      return { label: w.label, names: [c >= b ? 'chintal|CNT' : 'balanagar|BLN'], values: [Math.max(c, b)] }; })) },

  // one test
  { id: 'ctbp_billed', q: 'how much has CT-BRAIN PLAIN been billed for', kind: 'value',
    truth: async () => { const r = await sql(`SELECT COALESCE(SUM("priceInPaise"),0)::bigint p FROM "TestOrder" WHERE "testCodeSnapshot"='CTBP' AND "cancelledAt" IS NULL AND "replacedAt" IS NULL`);
      return [{ label: 'CTBP live orders, all time', values: [rs(Number(r[0].p))] }]; } },
  { id: 'ctbp_cost', setup: ['how much has CT-BRAIN PLAIN been billed for'], q: 'give me cost', kind: 'value',
    truth: async () => { const r = await sql(`SELECT "basePriceInPaise" p FROM "BillableProduct" WHERE code='CTBP'`); return [{ label: 'list price', values: [rs(r[0].p)] }]; } },
  { id: 'ct_priciest', q: 'which ct is the most expensive', kind: 'value', heldOut: true,
    truth: async () => { const r = await sql(`SELECT name, "basePriceInPaise" p FROM "BillableProduct" WHERE "isActive" AND (name ILIKE 'CT %' OR name ILIKE 'CT-%' OR name ILIKE 'HRCT%') ORDER BY p DESC LIMIT 1`);
      return [{ label: 'top list price', names: [r[0].name], values: [rs(r[0].p)] }]; } },
  { id: 'ctbp_latest', q: 'Show the most recent CT-BRAIN PLAIN order and its billed amount', kind: 'value',
    truth: async () => { const r = await sql(`SELECT "priceInPaise" p, to_char(${IST('"createdAt"')},'YYYY-MM-DD') d FROM "TestOrder" WHERE "testCodeSnapshot"='CTBP' AND "cancelledAt" IS NULL ORDER BY "createdAt" DESC LIMIT 1`);
      const [y, m, d] = r[0].d.split('-'); const day = String(Number(d)), mon = new Date(`${r[0].d}T00:00:00Z`).toLocaleString('en-US', { month: 'long', timeZone: 'UTC' }).toLowerCase();
      return [{ label: 'latest order', values: [rs(r[0].p)], names: [[`${day} ${mon.slice(0, 3)}`, `${mon} ${day}`, `${mon.slice(0, 3)} ${day}`, r[0].d, `${d}-${m}-${y}`, `${d}/${m}/${y}`].join('|')] }]; } },

  // a kind of work, as money
  { id: 'ct_per_month', q: 'how much are we making on ct scan per month', kind: 'value',
    truth: async () => [{ label: 'CT collected, last month', values: [await collectedBy(W.lastMonth, ['CT / MRI'])] }] },
  { id: 'ct_mtd_vs_last', q: 'this month isnt complete right how is this month ct doing compared with last motth ct', kind: 'value',
    truth: () => cross(W.mtd, (w) => collectedBy(w, ['CT / MRI'])) },
  { id: 'external_per_month', q: 'how much am i making rom external reports per month', kind: 'value',
    // "making" is collected on the owner's basis; billed is accepted too, as both are defensible here
    truth: async () => {
      const b = await sql(`SELECT COALESCE(SUM("priceInPaise"),0)::bigint p FROM "TestOrder" o WHERE o."workflowMode"='EXTERNAL_UPLOAD' AND o."cancelledAt" IS NULL AND o."replacedAt" IS NULL AND ${inWin('o."createdAt"', W.lastMonth)}`);
      const c = await sql(`WITH pay AS (SELECT b."visitId", SUM(CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" WHEN pt."paymentType" IN ('CASH','ONLINE') THEN pt."amountInPaise" ELSE 0 END)::numeric amt
          FROM "PaymentTransaction" pt JOIN "Bill" b ON b.id=pt."billId" WHERE ${inWin('pt."transactionDate"', W.lastMonth)} GROUP BY 1),
        lt AS (SELECT t."visitId", t."workflowMode", greatest(t."priceInPaise",0)::numeric p FROM "TestOrder" t JOIN pay USING ("visitId") WHERE t."cancelledAt" IS NULL AND t."replacedAt" IS NULL),
        tot AS (SELECT "visitId", sum(p) total FROM lt GROUP BY 1)
        SELECT COALESCE(SUM(pay.amt * lt.p / tot.total),0) v FROM pay JOIN tot USING ("visitId") JOIN lt USING ("visitId") WHERE tot.total > 0 AND lt."workflowMode"='EXTERNAL_UPLOAD'`);
      return [{ label: 'external uploads collected, last month', values: [rs(Number(c[0].v))] }, { label: 'external uploads billed, last month', values: [rs(Number(b[0].p))] }]; } },

  // what the centre records
  { id: 'workflow_types', q: 'we have types called reportable bill only external', kind: 'value',
    truth: async () => { const r = await sql(`SELECT "workflowMode"::text m, count(*)::int n FROM "TestOrder" WHERE "cancelledAt" IS NULL GROUP BY 1`);
      const n = (m: string) => r.find((x: any) => x.m === m)?.n ?? 0;
      return [{ label: 'live orders per type', values: [n('REPORTABLE'), n('BILL_ONLY'), n('EXTERNAL_UPLOAD')] }]; } },
  { id: 'categories', q: 'What billing or charge categories exist in the system?', kind: 'value', heldOut: true,
    truth: async () => [{ label: 'payout categories', names: ['Laboratory', 'X-Ray', 'Ultrasound', 'CT / MRI', 'ECG'] }] },

  // people
  { id: 'repeat_customer', q: 'who is the most repeating customer', kind: 'value',
    truth: async () => { const r = await sql(`SELECT p.name, count(*)::int n FROM "Visit" v JOIN "Patient" p ON p.id=v."patientId" GROUP BY p.id, p.name ORDER BY n DESC LIMIT 1`);
      return [{ label: 'most visits', names: [r[0].name], values: [r[0].n] }]; } },
  { id: 'repeat_name_him', setup: ['who is the most repeating customer'], q: 'name him', kind: 'value',
    truth: async () => { const r = await sql(`SELECT p.name FROM "Visit" v JOIN "Patient" p ON p.id=v."patientId" GROUP BY p.id, p.name ORDER BY count(*) DESC LIMIT 1`);
      return [{ label: 'the same patient', names: [r[0].name] }]; } },

  // dues — the Money page's definition
  { id: 'dues_list', q: 'can u give list of all dues with pt name and number and amt of due', kind: 'list',
    truth: async () => { const r = await sql(`SELECT b."billNumber" id FROM "Bill" b WHERE ${OWES()}`); return [{ label: 'every open bill', list: { ids: r.map((x: any) => x.id) } }]; } },
  { id: 'dues_oldest', q: 'give me list of all dues with name number amt from oldest to newest', kind: 'list',
    truth: async () => { const r = await sql(`SELECT b."billNumber" id FROM "Bill" b WHERE ${OWES()} ORDER BY b."billedAt"`);
      return [{ label: 'oldest first', list: { ids: r.map((x: any) => x.id), oldestFirst: r[0]?.id } }]; } },
  { id: 'dues_aging', q: 'Break the outstanding dues down by how old the bills are', kind: 'value', heldOut: true,
    truth: async () => { const r = await sql(`SELECT COALESCE(SUM(${DUE()}),0)::bigint p FROM "Bill" b WHERE ${OWES()}`); return [{ label: 'total open', values: [rs(Number(r[0].p))] }]; } },

  // a calculation — every operand is a figure the engine already has
  { id: 'ct_payback', q: 'if the ct machine costs me 5000000rs how long will the ct scans revenue take to get roi , calc after ermoving the referral amt', kind: 'value',
    truth: () => payback() },
  { id: 'ct_payback_50l', q: 'do u think the 50 lakhs on ct scan machine will be worth it loo at ct refferal rates and tell me estimated roi', kind: 'value', heldOut: true,
    truth: () => payback() },

  // Kidcare counts, as on the dashboard: the answer must give what JGG took in the same days last month
  { id: 'jgg_fall', q: 'Why did JGG revenue fall this month?', kind: 'value',
    truth: async () => { const days = (w: Win) => Math.round((Date.parse(w.to) - Date.parse(w.from)) / 864e5);
      return Promise.all(W.mtd.map(async (w) => ({ label: `JGG, first ${days(w)} days of last month`,
        values: [await collected({ from: W.lastMonth.from, to: add(W.lastMonth.from, days(w)), label: '' }, 'JGG')] }))); } },

  // open questions: no single right figure, judged on finishing, time, calls and grounding
  { id: 'losing_money', q: 'where am i losing money', kind: 'open' },
  { id: 'improve', q: 'how is my buisness doing , how can i improve it', kind: 'open' },
  { id: 'why_up', q: 'why is my buisness going up?', kind: 'open' },
  { id: 'optimize', q: 'ik my buisness is going up but what can i optimize to make it increase even more', kind: 'open', heldOut: true },
  { id: 'self_patients', q: 'how can we increase self patients', kind: 'open' },
  { id: 'quiet_doctors', q: 'overall which doctor not sending much comparative to other months', kind: 'open' },
  { id: 'discount_reasons', q: 'can u read all the reaons for discounts and understand whats driving it', kind: 'open' },
  { id: 'heavy_discount', q: 'which test is heavily discounted', kind: 'value',
    // each test's share of its bill's discount, by price; the top test over any reasonable window
    truth: async () => Promise.all([...W.last3m, W.lastMonth].map(async (w) => {
      const r = await sql(`WITH t AS (SELECT o."visitId", coalesce(o."testNameSnapshot", o."testCodeSnapshot") n, greatest(o."priceInPaise",0)::numeric p FROM "TestOrder" o
          WHERE o."cancelledAt" IS NULL AND o."replacedAt" IS NULL AND ${inWin('o."createdAt"', w)}),
        tot AS (SELECT o."visitId", sum(greatest(o."priceInPaise",0))::numeric total FROM "TestOrder" o WHERE o."replacedAt" IS NULL GROUP BY 1)
        SELECT t.n, SUM((b."discountAmountInPaise" + b."couponDiscountInPaise")::numeric * t.p / NULLIF(tot.total,0)) d
        FROM t JOIN tot USING ("visitId") JOIN "Bill" b ON b."visitId" = t."visitId" GROUP BY 1 ORDER BY 2 DESC NULLS LAST LIMIT 1`);
      return { label: `most discount, ${w.label}`, names: [String(r[0].n)] }; })) },
  { id: 'slow_reports', q: 'on avergaw which reports take the longest', kind: 'open' },
  { id: 'mistakes', q: 'which staff makes most mistakes', kind: 'open' },
  { id: 'anomalies', q: 'find me all anomolies this month compared to last month', kind: 'open', heldOut: true },
];

/** 50,00,000 over a month of CT net of commission, each defensible reading of "a month". */
async function payback(): Promise<Alt[]> {
  const months = [1, 2, 3].map((b) => ({ from: monthStart(T, b), to: monthStart(T, b - 1), label: monthStart(T, b).slice(0, 7) }));
  const net = async (w: Win) => {
    const col = await collectedBy(w, ['CT / MRI']);
    const r = await sql(`WITH o AS (SELECT t.*, (SELECT sum(greatest(x."priceInPaise",0))::numeric FROM "TestOrder" x WHERE x."visitId"=t."visitId" AND x."replacedAt" IS NULL) total,
        (SELECT least(greatest(coalesce(b."discountAmountInPaise",0),0)+greatest(coalesce(b."couponDiscountInPaise",0),0), greatest(b."totalAmountInPaise",0)) FROM "Bill" b WHERE b."visitId"=t."visitId") disc
      FROM "TestOrder" t WHERE t."payoutCategorySnapshot"='CT / MRI' AND t."cancelledAt" IS NULL AND t."replacedAt" IS NULL AND ${inWin('t."createdAt"', w)})
      SELECT COALESCE(SUM(CASE WHEN "referralCommissionType"='FIXED_AMOUNT' THEN greatest(0,coalesce("referralCommissionAmountInPaise",0))
        ELSE greatest(0, round("priceInPaise"*coalesce("referralCommissionPercentage",0)/100.0) - CASE WHEN total>0 THEN coalesce(disc,0)::numeric*greatest("priceInPaise",0)/total ELSE 0 END) END),0)::bigint c,
        COALESCE(SUM("priceInPaise"),0)::bigint billed FROM o`);
    return { col, billed: rs(Number(r[0].billed)), comm: rs(Number(r[0].c)) };
  };
  const per = await Promise.all(months.map(net));
  const last30 = await net({ from: add(T, -30), to: T, label: 'last 30 days' });
  const alts: Alt[] = [];
  const push = (label: string, m: number) => { if (m > 0) alts.push({ label, values: [5_000_000 / m] }, { label: `${label}, in years`, values: [5_000_000 / m / 12] }); };
  push('last month, collected', per[0].col - per[0].comm);
  push('last month, billed', per[0].billed - per[0].comm);
  push('3-month average, collected', per.reduce((t, p) => t + p.col - p.comm, 0) / 3);
  push('3-month average, billed', per.reduce((t, p) => t + p.billed - p.comm, 0) / 3);
  push('last 30 days, collected', last30.col - last30.comm);
  push('last 30 days, billed', last30.billed - last30.comm);
  return alts.map((a) => ({ ...a, label: `${a.label} → ${a.values![0].toFixed(1)}` }));
}

// ── reading what the owner sees ─────────────────────────────────────────────────────────
interface Num { raw: number; mult: number; dp: number }
const NUM = /(?:₹|rs\.?\s*|inr\s*)?(-?\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|l\b|crores?|cr\b|k\b|thousand)?/gi;
const MULT: Record<string, number> = { l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3, thousand: 1e3 };
export function numbersIn(s: string): Num[] {
  const out: Num[] = [];
  for (const m of String(s || '').matchAll(NUM)) {
    const txt = m[1].replace(/,/g, ''); if (!/\d/.test(txt)) continue;
    out.push({ raw: Number(txt), mult: MULT[(m[2] || '').toLowerCase()] ?? 1, dp: (txt.split('.')[1] || '').length });
  }
  return out;
}
/** Does a written figure state this value, at the precision it was written? */
export function states(n: Num, truth: number): boolean {
  const x = truth / n.mult, f = 10 ** n.dp;
  if (Math.abs(Math.round(x * f) / f - n.raw) < 1e-9) return true;       // rounded
  if (Math.abs(Math.trunc(x * f) / f - n.raw) < 1e-9) return true;       // truncated
  return n.mult === 1 && n.dp === 0 && Math.abs(x - n.raw) <= 1;         // a rupee of rounding
}
/** Everything the owner reads: the prose, and every card's figures and rows. Paise become rupees. */
export function seen(a: any): { text: string; nums: Num[]; rows: any[] } {
  const s = a?.segments || {};
  const text = [a?.text, s.verdict, ...(s.points || []).map((p: any) => p?.text), s.caveat, s.action,
    ...(a?.opportunities || []).map((o: any) => `${o.title} ${o.impact}`)].filter(Boolean).join(' \n ');
  const byStep = new Map((a?.evidence || []).map((e: any) => [e.step, e]));
  const shown = (a?.artifacts || []).flatMap((x: any) => (Array.isArray(x.evidence) ? x.evidence : [x.evidence]).map((i: any) => byStep.get(Number(i)))).filter(Boolean);
  const nums = numbersIn(text); const rows: any[] = [];
  const walk = (v: any, k: string, paise: boolean): void => {
    if (v == null) return;
    if (typeof v === 'number' || typeof v === 'bigint') { const n = Number(v); nums.push({ raw: paise || /paise/i.test(k) ? n / 100 : n, mult: 1, dp: 2 }); nums.push({ raw: Math.round(paise || /paise/i.test(k) ? n / 100 : n), mult: 1, dp: 0 }); return; }
    if (typeof v === 'string') { nums.push(...numbersIn(v)); return; }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, k, paise)); return; }
    if (typeof v === 'object') for (const [kk, vv] of Object.entries(v)) walk(vv, kk, paise);
  };
  for (const e of shown as any[]) {
    walk(e.summary, '', false);
    const paise = e.unit === 'paise';
    for (const r of (e.data?.rows || e.summary?.rows || [])) { rows.push(r); for (const [k, v] of Object.entries(r || {})) walk(v, k, paise && ['v', 'value', 'prev', 'delta', 'now', 'before', 'total'].includes(k)); }
    if (e.data && !Array.isArray(e.data)) for (const k of ['value', 'now', 'before', 'total']) if (e.data[k] != null) walk(e.data[k], k, paise);
  }
  return { text, nums, rows };
}
const hay = (v: { text: string; rows: any[] }) => (v.text + ' ' + JSON.stringify(v.rows)).toLowerCase();

export function score(a: any, c: Case, alts: Alt[]): { pass: boolean; why: string } {
  if (!a || a.kind === 'refuse' || a.kind === 'error') return { pass: false, why: `refused: ${String(a?.text || a?.reason || '').slice(0, 90)}` };
  const v = seen(a);
  if (c.kind === 'guard') return c.guard!.test(v.text) ? { pass: true, why: 'said so' } : { pass: false, why: `did not say it is a test branch: "${v.text.slice(0, 90)}"` };
  if (c.kind === 'open') {
    const bad = unsupported(groundNumbers(v.text, (a.evidence || []).filter((e: any) => e.ok)));
    return bad.length ? { pass: false, why: `figures from nowhere: ${bad.slice(0, 3).join(', ')}` } : { pass: true, why: 'answered, grounded' };
  }
  const misses: string[] = [];
  for (const alt of alts) {
    if (alt.list) {
      const h = hay(v); const got = alt.list.ids.filter((id) => h.includes(id.toLowerCase()));
      const recall = alt.list.ids.length ? got.length / alt.list.ids.length : 1;
      const firstRow = JSON.stringify(v.rows[0] || '').toLowerCase();
      const orderOk = !alt.list.oldestFirst || firstRow.includes(alt.list.oldestFirst.toLowerCase());
      if (recall >= 0.9 && orderOk) return { pass: true, why: `${got.length}/${alt.list.ids.length} bills${alt.list.oldestFirst ? ', oldest first' : ''}` };
      misses.push(`${alt.label}: ${got.length}/${alt.list.ids.length} bills${orderOk ? '' : ', not oldest first'}`); continue;
    }
    const h = hay(v);
    const missingVals = (alt.values || []).filter((t) => !v.nums.some((n) => states(n, t)));
    const missingNames = (alt.names || []).filter((nm) => !nm.toLowerCase().split('|').some((x) => h.includes(x)));
    if (!missingVals.length && !missingNames.length) return { pass: true, why: alt.label };
    misses.push(`${alt.label}: missing ${[...missingVals.map((x) => x.toLocaleString('en-IN', { maximumFractionDigits: 1 })), ...missingNames].join(', ')}`);
  }
  return { pass: false, why: misses.slice(0, 2).join(' | ') };
}

// ── the run ─────────────────────────────────────────────────────────────────────────────
const INFRA = /402|Insufficient Balance|401|invalid_api_key|LLM API key not set|429|rate.?limit|ECONNREFUSED|ENOTFOUND/i;
const stop = (why: string) => { console.error(`\n  STOPPED — this is the model account, not the build.\n  ${why.slice(0, 160)}\n  No score is reported, because none was measured.\n`); process.exit(2); };
const toolsOf = (a: any) => (a?.evidence || []).map((e: any) => e.tool);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };

async function judge(): Promise<void> {
  // The scorer decides the headline, so it is checked first, both ways, with no model call.
  let ok = 0, bad = 0;
  const fail = (m: string) => { bad++; console.log(`  ✗ ${m}`); };
  for (const c of CASES.filter((x) => x.truth)) {
    const alts = await c.truth!();
    const a0 = alts[0];
    const good = a0.list
      ? { kind: 'analysis', text: 'Here they are.', artifacts: [{ type: 'table', evidence: 0 }], evidence: [{ step: 0, ok: true, data: { rows: a0.list.ids.map((id) => ({ bill: id })) } }] }
      : { kind: 'analysis', text: `${(a0.values || []).map((x) => `₹${Math.round(x).toLocaleString('en-IN')}`).join(' and ')} ${(a0.names || []).map((n) => n.split('|')[0]).join(', ')}`, evidence: [] };
    const wrong = a0.list
      ? { ...good, evidence: [{ step: 0, ok: true, data: { rows: a0.list.ids.slice(0, Math.floor(a0.list.ids.length / 2)).map((id) => ({ bill: id })) } }] }
      : { kind: 'analysis', text: `${(a0.values || [1]).map((x) => `₹${Math.round(x * 100 + 7).toLocaleString('en-IN')}`).join(' and ')}`, evidence: [] };
    if (score(good, c, alts).pass) ok++; else fail(`${c.id}: the right answer was scored wrong — ${score(good, c, alts).why}`);
    if (!score(wrong, c, alts).pass || (a0.list && a0.list.ids.length < 2)) ok++; else fail(`${c.id}: a wrong answer was scored right`);
  }
  const n = (s: string) => numbersIn(s)[0];
  const unit: [boolean, boolean][] = [
    [states(n('₹1.3 lakh'), 132500), true], [states(n('₹1.32 lakh'), 132500), true], [states(n('₹1,32,500'), 132500), true],
    [states(n('₹1,32,000'), 132500), false], [states(n('₹13.2 lakh'), 132500), false], [states(n('76 months'), 76.39), true],
    [states(n('₹21.6L'), 2164246), true], [states(n('₹2.2 crore'), 2164246), false], [states(n('16.8K'), 16800), true],
  ];
  unit.forEach(([got, want], i) => (got === want ? ok++ : fail(`unit ${i}: precision rule`)));
  console.log(`\nJUDGE: ${ok} right, ${bad} wrong${bad ? ' — fix the scorer before trusting a score' : ''}`);
  process.exit(bad ? 1 : 0);
}

async function main(): Promise<void> {
  if (process.argv.includes('--judge')) return judge();
  const { llmJson } = require('./src/services/pulse/llm');
  try { await llmJson('Return JSON {"ok":true}', 'ping', { maxTokens: 20 }); } catch (e: any) { stop(String(e?.message || e)); }
  const K = Math.max(1, Number(process.env.PULSE_K) || 3);
  const only = (process.env.PULSE_ONLY || '').split(',').filter(Boolean);
  const cases = only.length ? CASES.filter((c) => only.includes(c.id)) : CASES;
  const out: any[] = [];
  for (const c of cases) {
    const runs: any[] = [];
    for (let k = 0; k < K; k++) {
      let state: any = {};
      for (const s of c.setup || []) { const a = await ask(s, state); if ((a as any)?.reason === 'unavailable') stop(String((a as any).unavailable)); state = a?.state || state; }
      const t0 = Date.now();
      let a: any;
      try { a = await ask(c.q, state); } catch (e: any) { if (INFRA.test(String(e?.message))) stop(String(e.message)); a = { kind: 'error', text: String(e?.message) }; }
      if (a?.reason === 'unavailable') stop(String(a.unavailable || ''));
      const ms = Date.now() - t0;
      const alts = c.truth ? await c.truth() : [];          // truth at the same moment as the answer
      const s = score(a, c, alts);
      runs.push({ pass: s.pass, why: s.why, ms, calls: a?.meta?.calls ?? a?.trace?.calls ?? 0, tools: toolsOf(a), kind: a?.kind, rounds: a?.meta?.rounds,
        // what the owner read, and what each step did — enough to debug a failure without re-running it
        text: seen(a).text.slice(0, 600), steps: (a?.evidence || []).map((e: any) => ({ tool: e.tool, ok: e.ok, label: e.label, args: undefined, error: e.error?.slice(0, 160),
          summary: JSON.stringify(e.summary ?? null).slice(0, 300) })), plan: a?.trace?.plan?.proposed });
    }
    const all = runs.every((r) => r.pass), any = runs.some((r) => r.pass);
    out.push({ id: c.id, q: c.q, kind: c.kind, heldOut: !!c.heldOut, all, any, runs });
    const mark = all ? '✓' : any ? '~' : '✗';
    if (!c.heldOut) {
      console.log(`${mark} ${c.id.padEnd(22)} ${runs.map((r) => `${Math.round(r.ms / 1000)}s/${r.calls}c`).join(' ').padEnd(22)} ${c.q.slice(0, 50)}`);
      for (const r of runs.filter((x) => !x.pass).slice(0, 1)) console.log(`     ↳ ${r.why}`);
    } else console.log(`${mark} ${c.id.padEnd(22)} (held out)`);
  }
  const line = (label: string, xs: any[]) => xs.length && console.log(`${label.padEnd(26)} pass-all ${xs.filter((x) => x.all).length}/${xs.length}   pass-any ${xs.filter((x) => x.any).length}/${xs.length}`);
  const runs = out.flatMap((x) => x.runs);
  console.log(`\n${'═'.repeat(72)}`);
  line('figures and lists', out.filter((x) => !x.heldOut && x.kind !== 'open'));
  line('open questions', out.filter((x) => !x.heldOut && x.kind === 'open'));
  line('HELD OUT', out.filter((x) => x.heldOut));
  const ms = runs.map((r) => r.ms), calls = runs.map((r) => r.calls), tools = runs.flatMap((r) => r.tools);
  console.log(`latency p50 ${(pct(ms, 0.5) / 1000).toFixed(1)}s  p90 ${(pct(ms, 0.9) / 1000).toFixed(1)}s   calls p50 ${pct(calls, 0.5)} max ${Math.max(0, ...calls)}   model-written SQL ${tools.length ? Math.round(tools.filter((t: string) => t === 'query').length / tools.length * 100) : 0}% of steps`);
  fs.mkdirSync('pulse-results', { recursive: true });
  const file = `pulse-results/real-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), K, out }, null, 1));
  console.log(`written ${file}`);
  process.exit(0);
}
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
