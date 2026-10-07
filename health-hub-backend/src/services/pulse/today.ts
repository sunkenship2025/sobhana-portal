/**
 * Pulse — the empty state. Not a feature: it is the STATUS path rendered without narration.
 * Fixed metric set on every page. Zero model calls. Cached 5 minutes; prefetched on hover.
 *
 * Collection comes from the money engine and dues from the Money page's definition, so the first
 * number the owner sees in Pulse is the number the dashboard shows — not a near neighbour of it.
 */
import { query, todayIST } from './db';
import { addDays } from './diagnostic';
import { DUE, OWES, OPEN_VISIT } from './catalog';
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
    num(`SELECT count(*) v FROM "Visit" v WHERE ${OPEN_VISIT()} AND v."createdAt" < now() - interval '24 hours'`),
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

/**
 * The month so far, in three or four plain lines — the digest the owner would otherwise have to
 * ask for. Built from the insights tool, so every figure is the Money page's, and no model is
 * called. Cached 15 minutes; it is also the body of the daily WhatsApp digest once Meta approves
 * the template.
 */
let digestCache: { at: number; lines: string[] } | null = null;
export async function digestLines(): Promise<string[]> {
  if (digestCache && Date.now() - digestCache.at < 15 * 60 * 1000) return digestCache.lines;
  const { TOOLS } = await import('./v2/tools');
  const r: any = await TOOLS.insights({}, null as any);
  if (!r.ok) return [];
  const s = r.summary;
  const [from, to] = s.window.split(',')[0].split(' to ');
  const day = (d: string) => Number(d.slice(8)), mon = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' });
  const span = mon(from) === mon(to) ? `${day(from)}–${day(to)} ${mon(to)}` : `${day(from)} ${mon(from)} – ${day(to)} ${mon(to)}`;
  const lines = [`Collected ${s.collected.now} over ${span}, ${s.collected.changePct} on the same days last month.`];
  const up = (s.parts || []).find((p: any) => p.change.startsWith('+')), down = (s.parts || []).find((p: any) => p.change.startsWith('-'));
  if (up || down) lines.push(`Biggest moves: ${[up && `${up.name} ${up.change}`, down && `${down.name} ${down.change}`].filter(Boolean).join('; ')}.`);
  const leak = (s.leaks || []).find((l: any) => l.name !== 'Referral commission');
  if (leak) lines.push(`${leak.name}: ${leak.value} — ${leak.note}.`);
  if (s.reportsLate > 0) lines.push(`${s.reportsLate} report${s.reportsLate === 1 ? '' : 's'} past 24 hours.`);
  digestCache = { at: Date.now(), lines };
  return lines;
}
