/**
 * Pulse — the empty state. Not a feature: it is the STATUS path rendered without narration.
 * Fixed metric set on every page (page-aware numbers were the one thing that would have
 * made this too complex). Zero model calls. Cached 5 minutes; prefetched on hover.
 */
import { query, todayIST, IST } from './db';
import { addDays } from './diagnostic';

export interface Today { date: string; sofar: boolean; collectionToday: number; vsUsual: number | null; cases: number; due: number; lateReports: number; chips: { label: string; q: string }[]; builtAt: number; }
let cache: Today | null = null;
const TTL = 5 * 60 * 1000;

export async function todayPack(): Promise<Today> {
  if (cache && Date.now() - cache.builtAt < TTL) return cache;
  const t = todayIST(), tomorrow = addDays(t, 1);
  const num = async (sql: string) => Number((await query(sql)).rows?.[0]?.v ?? 0);
  const coll = (from: string, to: string) => num(`SELECT COALESCE(SUM(CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" ELSE pt."amountInPaise" END),0) v FROM "PaymentTransaction" pt WHERE (pt."transactionDate" ${IST}) >= '${from}' AND (pt."transactionDate" ${IST}) < '${to}'`);
  const [collectionToday, cases, due, lateReports] = await Promise.all([
    coll(t, tomorrow),
    num(`SELECT count(*) v FROM "Visit" v WHERE (v."createdAt" ${IST}) >= '${t}' AND (v."createdAt" ${IST}) < '${tomorrow}'`),
    num(`SELECT COALESCE(SUM(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise"),0) v FROM "Bill" b WHERE b."paymentStatus"<>'PAID'`),
    num(`SELECT count(*) v FROM "Visit" v JOIN "DiagnosticReport" dr ON dr."visitId"=v.id WHERE v."createdAt" < now() - interval '24 hours' AND v."createdAt" > now() - interval '14 days' AND NOT EXISTS (SELECT 1 FROM "ReportVersion" rv WHERE rv."reportId"=dr.id AND rv.status='FINALIZED')`),
  ]);
  // "vs usual": the same weekday over the last 8 weeks, same elapsed hours would be better but
  // whole prior days are honest enough for a first look and cost 8 cheap queries
  const hist = await Promise.all(Array.from({ length: 8 }, (_, i) => { const d = addDays(t, -7 * (i + 1)); return coll(d, addDays(d, 1)); }));
  const valid = hist.filter((x) => x > 0); const mean = valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : 0;
  const hourIST = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
  // comparing 9am's takings against whole prior days would read as a crash every morning
  const vsUsual = mean && hourIST >= 17 ? Number(((collectionToday - mean) / mean * 100).toFixed(0)) : null;
  const chips: Today['chips'] = [];
  if (lateReports > 0) chips.push({ label: 'which reports are late', q: 'reports late kitne hain branch wise' });
  if (vsUsual !== null && vsUsual < -15) chips.push({ label: 'why is collection low today', q: 'why is collection down today' });
  if (due > 0) chips.push({ label: 'due branch wise', q: 'due branch wise' });
  if (!chips.length) chips.push({ label: 'collection this month', q: 'this month collection how much' }, { label: 'doctor wise', q: 'doctor wise cases this month top 5' });
  cache = { date: t, sofar: hourIST < 17, collectionToday, vsUsual, cases, due, lateReports, chips: chips.slice(0, 2), builtAt: Date.now() };
  return cache;
}
