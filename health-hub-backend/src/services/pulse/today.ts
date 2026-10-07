/**
 * Pulse — the empty state. Not a feature: it is the STATUS path rendered without narration.
 * Fixed metric set on every page. Zero model calls. Cached 5 minutes; prefetched on hover.
 *
 * Collection comes from the money engine and dues from the Money page's definition, so the first
 * number the owner sees in Pulse is the number the dashboard shows — not a near neighbour of it.
 */
import { query, todayIST } from './db';
import { addDays } from './diagnostic';
import { DUE, OWES } from './catalog';
import { getMoneyFacts, totalsOf } from '../moneyFactsService';

export interface Today { date: string; sofar: boolean; collectionToday: number; vsUsual: number | null; cases: number; due: number; lateReports: number; chips: { label: string; q: string }[]; builtAt: number }
let cache: Today | null = null;
const TTL = 5 * 60 * 1000;
const istMidnight = (d: string) => new Date(`${d}T00:00:00+05:30`);

export async function todayPack(): Promise<Today> {
  if (cache && Date.now() - cache.builtAt < TTL) return cache;
  const t = todayIST(), tomorrow = addDays(t, 1);
  const num = async (sql: string) => Number((await query(sql)).rows?.[0]?.v ?? 0);
  // today and the same weekday over the last 8 weeks, in one pass of the engine
  const [{ days }, due, lateReports] = await Promise.all([
    getMoneyFacts({ start: istMidnight(addDays(t, -56)), end: istMidnight(tomorrow), branchId: null, domain: null }),
    num(`SELECT COALESCE(SUM(${DUE()}),0) v FROM "Bill" b WHERE ${OWES()}`),
    num(`SELECT count(*) v FROM "Visit" v JOIN "DiagnosticReport" dr ON dr."visitId"=v.id WHERE v."createdAt" < now() - interval '24 hours' AND v."createdAt" > now() - interval '14 days' AND NOT EXISTS (SELECT 1 FROM "ReportVersion" rv WHERE rv."reportId"=dr.id AND rv.status='FINALIZED')`),
  ]);
  const on = (d: string) => totalsOf(days.filter((f) => f.date === d));
  const now = on(t);
  const collectionToday = now.netCollected, cases = now.visits;
  const hist = Array.from({ length: 8 }, (_, i) => on(addDays(t, -7 * (i + 1))).netCollected).filter((x) => x > 0);
  const mean = hist.length ? hist.reduce((a, b) => a + b, 0) / hist.length : 0;
  const hourIST = new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours();
  // comparing 9am's takings against whole prior days would read as a crash every morning
  const vsUsual = mean && hourIST >= 17 ? Number(((collectionToday - mean) / mean * 100).toFixed(0)) : null;
  const chips: Today['chips'] = [];
  if (lateReports > 0) chips.push({ label: 'which reports are late', q: 'reports late kitne hain branch wise' });
  if (vsUsual !== null && vsUsual < -15) chips.push({ label: 'why is collection low today', q: 'why is collection down today' });
  if (due > 0) chips.push({ label: 'who owes money', q: 'list of patients with dues' });
  if (!chips.length) chips.push({ label: 'collection this month', q: 'this month collection how much' }, { label: 'doctor wise', q: 'doctor wise cases this month top 5' });
  cache = { date: t, sofar: hourIST < 17, collectionToday, vsUsual, cases, due, lateReports, chips: chips.slice(0, 2), builtAt: Date.now() };
  return cache;
}
