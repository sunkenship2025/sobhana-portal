/**
 * Pulse — the profit ladder. Refusing "profit kitna" throws away information the owner is
 * entitled to; reporting revenue-minus-commission AS profit is the most dangerous answer this
 * system ever produced. So: walk every rung we CAN stand on, then state where the data stops.
 * Every figure is computed here and pre-formatted; the model narrates STRINGS, and any sentence
 * containing a rupee figure it was not given is dropped. Structural, not a plea.
 */
import { query, IST, langOf } from './db';
import { llmJson } from './llm';
import { periods } from './diagnostic';

const R = (v: number) => '₹' + (Math.round(v || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 });
export interface Ladder { period: string; rungs: { label: string; amount: string; amountPaise: number; leaves?: string }[]; remaining: string; remainingPaise: number; missing: string[]; }

export async function contributionLadder(from: string, to: string): Promise<Ladder> {
  const coll = await query(`SELECT COALESCE(SUM(CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" ELSE pt."amountInPaise" END),0)::bigint v FROM "PaymentTransaction" pt WHERE (pt."transactionDate" ${IST}) >= '${from}' AND (pt."transactionDate" ${IST}) < '${to}'`);
  const payouts = await query(`SELECT pl."doctorType"::text k, COALESCE(SUM(pl."derivedAmountInPaise"),0)::bigint v FROM "DoctorPayoutLedger" pl WHERE pl."deletedAt" IS NULL AND (pl."periodStartDate" ${IST}) >= '${from}' AND (pl."periodStartDate" ${IST}) < '${to}' GROUP BY 1 ORDER BY 2 DESC`);
  const lab = await query(`SELECT count(*) FILTER (WHERE o."labCostAmountInPaise" > 0)::int amt, count(*)::int total FROM "TestOrder" o`);
  const collected = Number(coll.rows?.[0]?.v || 0);
  const by: Record<string, number> = {}; for (const r of payouts.rows || []) by[String(r.k)] = Number(r.v);
  const rungs: Ladder['rungs'] = [{ label: 'Collected', amount: R(collected), amountPaise: collected }];
  let running = collected;
  for (const [k, label] of [['REFERRAL', 'referring-doctor commission'], ['CLINIC', 'clinic-doctor payouts'], ['DIAGNOSTIC_CENTER', 'partner-centre commission'], ['LAB', 'outside-lab charges']] as const) {
    if (!by[k]) continue; running -= by[k]; rungs.push({ label: `− ${label}`, amount: R(by[k]), amountPaise: -by[k], leaves: R(running) });
  }
  const missing = ['salaries', 'rent', 'consumables and reagents', 'equipment and utilities'];
  if (!by.LAB) missing.unshift('outside-lab charges');
  if (Number(lab.rows?.[0]?.amt || 0) === 0) missing.unshift(`per-test vendor cost (recorded on 0 of ${Number(lab.rows?.[0]?.total || 0).toLocaleString('en-IN')} orders)`);
  return { period: `${from} to ${to}`, rungs, remaining: R(running), remainingPaise: running, missing };
}

const SYS = `A diagnostic-centre owner asked what their profit is. You cannot tell them — the business
does not record its costs. You are given a LADDER of the money that IS recorded, already formatted.
RULES
 · Reproduce the given amounts EXACTLY as strings. Never compute, round or invent any figure.
 · Walk the rungs in order: what came in, what each payout took out, what is left.
 · Then say plainly that the remainder is NOT profit, and name what is missing.
 · Offer to work out the real figure if they supply those costs.
 · 3-5 sentences, in the LANGUAGE given in the input. English means plain business English. Never switch on your own.
Return JSON {"answer":"..."}.`;

export async function ladderAnswer(q: string, periodKind: string) {
  const P = periods(periodKind === 'week' ? 'week' : periodKind);
  const L = await contributionLadder(P.cur.from, P.cur.to);
  const allowed = new Set<string>(); for (const r of L.rungs) { allowed.add(r.amount.replace(/\D/g, '')); if (r.leaves) allowed.add(r.leaves.replace(/\D/g, '')); } allowed.add(L.remaining.replace(/\D/g, ''));
  let text = '';
  try { const j = await llmJson<{ answer?: string }>(SYS, JSON.stringify({ LANGUAGE: langOf(q), question: q, ladder: L.rungs, leftAfterRecordedPayouts: L.remaining, notRecorded: L.missing, period: L.period }), { maxTokens: 500 }); text = String(j.answer || ''); } catch { /* the card stands on its own */ }
  // structural guard: any sentence carrying a rupee figure we did not supply is dropped
  const kept: string[] = []; for (const s of text.split(/(?<=[.!?])\s+/)) { const bad = [...s.matchAll(/₹\s?[\d,]+/g)].some((m) => !allowed.has(m[0].replace(/\D/g, ''))); if (!bad) kept.push(s); }
  return { kind: 'ladder' as const, text: kept.join(' '), ladder: L, period: periodKind, window: P };
}
