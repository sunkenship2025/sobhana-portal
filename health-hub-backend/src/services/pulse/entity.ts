/**
 * Pulse — the entity card. "tell me about Ramaswamy", "chintal kaisa chal raha hai",
 * "CBP this month": a profile for any named doctor, branch or test, built from registry
 * metrics for this month vs the same elapsed days last month. ZERO model calls.
 */
import { query, IST } from './db';
import { periods, fmt, addDays } from './diagnostic';
import type { Knowledge } from './knowledge';

const ENTITY_ASK = /\babout\b|overview|profile|kaisa|how is|how's|\bstill\b|ab bhi|dena hai|kitna dena|\bowed\b|kaise/i;
const GENERIC = new Set(['month', 'last', 'this', 'about', 'tell', 'doctor', 'branch', 'test', 'kaisa', 'chal', 'raha', 'hai', 'still', 'referring', 'overview', 'kitna', 'dena', 'kaise', 'the', 'how']);

export function findEntity(k: Knowledge, q: string): Knowledge['names'][number] | null {
  const words = q.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !GENERIC.has(w));
  const hits = new Map<string, Knowledge['names'][number]>();
  for (const n of k.names) {
    if (n.kind === 'department') continue;
    const toks = n.name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !/^(dr|mbbs|md|dnb|ms|dch|hospital|clinic|sobhana)$/.test(t));
    const sub = (n.sub || '').toLowerCase();
    if (words.some((w) => toks.includes(w) || (sub && sub === w))) hits.set(n.kind + ':' + n.id, n);
  }
  if (hits.size !== 1) return null;
  const only = [...hits.values()][0];
  // a bare name, or a name plus "about / how is / still" — anything more specific goes to SQL
  const rest = words.filter((w) => !only.name.toLowerCase().includes(w) && w !== (only.sub || '').toLowerCase());
  // a bare name ("ramaswamy", "chintal") or a profile-type ask; anything with a metric word goes to SQL
  const metricWord = /collection|revenue|billing|cases|visits|tests?|orders|due|discount|refund|commission|amount|wise|count|how (much|many)|kitn[ae]/i.test(q);
  return rest.length === 0 || (ENTITY_ASK.test(q) && !metricWord) || (ENTITY_ASK.test(q) && /dena hai|kitna dena|owed|still|ab bhi/i.test(q)) ? only : null;
}

export async function entityCard(k: Knowledge, q: string) {
  const e = findEntity(k, q); if (!e) return null;
  const P = periods('month'); const cur = P.cur, prev = P.prev;
  const num = async (sql: string) => Number((await query(sql)).rows?.[0]?.v ?? 0);
  const win = (col: string, p: { from: string; to: string }) => `(${col} ${IST}) >= '${p.from}' AND (${col} ${IST}) < '${p.to}'`;
  const pct = (a: number, b: number) => b ? Number(((a - b) / Math.abs(b) * 100).toFixed(1)) : null;
  const facts: { label: string; value: string; deltaPct?: number | null }[] = []; let note = ''; const chips: { label: string; q: string }[] = [];
  if (e.kind === 'doctor') {
    const ref = (p: any) => num(`SELECT count(DISTINCT r."visitId") v FROM "ReferralDoctor_Visit" r WHERE r."deletedAt" IS NULL AND r."referralDoctorId"='${e.id}' AND ${win('r."createdAt"', p)}`);
    const owed = num(`SELECT COALESCE(SUM(pl."derivedAmountInPaise"),0) v FROM "DoctorPayoutLedger" pl WHERE pl."deletedAt" IS NULL AND pl."doctorType"='REFERRAL' AND pl."referralDoctorId"='${e.id}' AND ${win('pl."periodStartDate"', cur)}`);
    const rev = num(`SELECT COALESCE(SUM(CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" ELSE pt."amountInPaise" END),0) v FROM "PaymentTransaction" pt JOIN "Bill" b ON b.id=pt."billId" WHERE ${win('pt."transactionDate"', cur)} AND EXISTS (SELECT 1 FROM "ReferralDoctor_Visit" r WHERE r."visitId"=b."visitId" AND r."deletedAt" IS NULL AND r."referralDoctorId"='${e.id}')`);
    const last = await query(`SELECT max(r."createdAt" ${IST})::date::text d FROM "ReferralDoctor_Visit" r WHERE r."deletedAt" IS NULL AND r."referralDoctorId"='${e.id}'`);
    const rank = await query(`SELECT rk FROM (SELECT r."referralDoctorId" id, rank() OVER (ORDER BY count(*) DESC) rk FROM "ReferralDoctor_Visit" r WHERE r."deletedAt" IS NULL AND ${win('r."createdAt"', cur)} GROUP BY 1) t WHERE id='${e.id}'`);
    const [a, b, o, rv] = await Promise.all([ref(cur), ref(prev), owed, rev]);
    facts.push({ label: 'Referrals this month', value: String(a), deltaPct: pct(a, b) }, { label: 'Collected via them', value: fmt(rv, 'paise') }, { label: 'Owed this month', value: fmt(o, 'paise') });
    const lastD = last.rows?.[0]?.d as string | undefined; const rk = rank.rows?.[0]?.rk;
    note = `${rk ? `#${rk} referrer this month · ` : ''}${lastD ? `last referral ${lastD === P.cur.to ? 'today' : lastD === addDays(P.cur.to, -1) ? 'yesterday' : lastD}` : 'no referrals recorded'}`;
    chips.push({ label: 'vs last month', q: `${e.name} referrals this month vs last month` }, { label: 'by test', q: `which tests does ${e.name} refer most` }, { label: 'open Payouts', q: '/owner/payouts' });
  } else if (e.kind === 'branch') {
    const code = e.sub;
    const rev = (p: any) => num(`SELECT COALESCE(SUM(CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" ELSE pt."amountInPaise" END),0) v FROM "PaymentTransaction" pt JOIN "Bill" b ON b.id=pt."billId" JOIN "Branch" br ON br.id=b."branchId" WHERE br.code='${code}' AND ${win('pt."transactionDate"', p)}`);
    const vis = (p: any) => num(`SELECT count(*) v FROM "Visit" v JOIN "Branch" br ON br.id=v."branchId" WHERE br.code='${code}' AND ${win('v."createdAt"', p)}`);
    const due = num(`SELECT COALESCE(SUM(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise"),0) v FROM "Bill" b JOIN "Branch" br ON br.id=b."branchId" WHERE br.code='${code}' AND b."paymentStatus"<>'PAID'`);
    const late = num(`SELECT count(*) v FROM "Visit" v JOIN "Branch" br ON br.id=v."branchId" JOIN "DiagnosticReport" dr ON dr."visitId"=v.id WHERE br.code='${code}' AND v."createdAt" < now() - interval '24 hours' AND v."createdAt" > now() - interval '14 days' AND NOT EXISTS (SELECT 1 FROM "ReportVersion" rv WHERE rv."reportId"=dr.id AND rv.status='FINALIZED')`);
    const [ra, rb, va, vb, d, l] = await Promise.all([rev(cur), rev(prev), vis(cur), vis(prev), due, late]);
    facts.push({ label: 'Collection this month', value: fmt(ra, 'paise'), deltaPct: pct(ra, rb) }, { label: 'Cases', value: String(va), deltaPct: pct(va, vb) }, { label: 'Due', value: fmt(d, 'paise') });
    note = l ? `${l} reports pending past 24h` : 'no reports pending past 24h'; chips.push({ label: 'why up/down?', q: `why is ${e.name} collection changing this month` }, { label: 'doctor wise', q: `${e.name} collection doctor wise this month` });
  } else if (e.kind === 'test') {
    const code = e.sub;
    const ord = (p: any) => num(`SELECT count(*) v FROM "TestOrder" o WHERE o."cancelledAt" IS NULL AND o."testCodeSnapshot"='${code}' AND ${win('o."createdAt"', p)}`);
    const val = num(`SELECT COALESCE(SUM(o."priceInPaise"),0) v FROM "TestOrder" o WHERE o."cancelledAt" IS NULL AND o."testCodeSnapshot"='${code}' AND ${win('o."createdAt"', cur)}`);
    const all = num(`SELECT count(*) v FROM "TestOrder" o WHERE o."cancelledAt" IS NULL AND ${win('o."createdAt"', cur)}`);
    const [a, b, v, t] = await Promise.all([ord(cur), ord(prev), val, all]);
    facts.push({ label: 'Orders this month', value: String(a), deltaPct: pct(a, b) }, { label: 'Order value', value: fmt(v, 'paise') }, { label: 'Share of orders', value: t ? (a / t * 100).toFixed(1) + '%' : '—' });
    chips.push({ label: 'by branch', q: `${e.name} orders by branch this month` }, { label: 'monthly', q: `${e.name} orders monthly` });
  } else return null;
  return { kind: 'entity' as const, entity: { kind: e.kind, name: e.name, id: e.id }, period: 'month', window: P, facts, note, chips };
}
