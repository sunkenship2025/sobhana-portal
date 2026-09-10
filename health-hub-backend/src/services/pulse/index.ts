/**
 * Pulse — one question in, one answer out. Five paths, chosen by the router; the card is
 * chosen by the shape of what came back. The model decides what to compute, never how to
 * show it. Conversation state is four fields the client echoes back; history is never resent.
 */
import { ensureKnowledge, ambiguousEntity, mentionsKnown } from './knowledge';
import { routeIntent } from './router';
import { sqlAnswer } from './sqlPath';
import { runDiagnostic } from './diagnostic';
import { ladderAnswer } from './ladder';
import { entityCard } from './entity';
import { guessMetric } from './shapes';
export { todayPack } from './today';

export interface PulseState { lastQ?: string | null; metric?: string | null; period?: string | null; kind?: string | null; }
export type Answer = any;

const FRAGMENT = /^(and|aur|what about|kya)?\s*[a-z0-9 .'-]{2,40}\??$/i;
const DIM_PHRASE = /\b(branch|doctor|payment|test|department|category|month|day|week)[- ]?wise\b|\bby (branch|doctor|payment( mode)?|test|department|category|month|day|week)\b|\bper (branch|doctor|test|department)\b/gi;
/** A fragment is a continuation, not a question: no metric noun, no question word, or an explicit "and …". */
function isFragment(q: string, namesKnown: boolean): boolean {
  const words = q.trim().split(/\s+/); if (words.length > 4 || !FRAGMENT.test(q)) return false;
  if (/^(and|aur|what about|kya)\b/i.test(q)) return true;
  if (namesKnown) return false;   // "sharma referrals this month" is a whole question, not a continuation
  if (/\b(how|what|which|why|when|kitn[ae]|kaisa|kyun)\b/i.test(q) || guessMetric(q)) return false;
  return true;
}

export async function ask(rawQ: string, state: PulseState = {}): Promise<Answer> {
  const k = await ensureKnowledge();
  let q = String(rawQ || '').trim().slice(0, 500);
  if (!q) return { kind: 'refuse', reason: 'empty', text: 'Ask me something about the business.', state };
  // FOLLOW-UP: a short fragment ("and kompally?", "branch wise", "vs july") inherits the last
  // question — the model sees both, the card family stays, one field changes.
  let followUp = false, forceSql = false;
  if (state.lastQ && isFragment(q, mentionsKnown(k, q))) {
    const frag = q.replace(/^(and|aur|what about|kya)\s+/i, '').replace(/\?+$/, '').trim();
    // "and kompally?" — a place or name we do not know cannot be filtered on; say so instead of guessing
    const tok = frag.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
    if (/^[a-z]{4,}$/.test(tok) && !DIM_PHRASE.test(frag) && !k.vidx[tok] && !mentionsKnown(k, tok) && !/week|month|today|yesterday|year|july|august|september|june/.test(tok))
      return { kind: 'refuse', reason: 'unknown_entity', text: `I don't know a branch, doctor or test called "${frag}". Branches are ${k.names.filter((n) => n.kind === 'branch').map((n) => n.name).join(', ')}.`, state };
    if ((state.kind === 'diagnose' || state.kind === 'status') && /wise|by |branch|doctor|payment|test|department/i.test(frag)) {
      // "branch wise" after "why is collection down this week" = the diagnosed metric, that period, by branch
      const MP: Record<string, string> = { revenue: 'collection', visits: 'cases', test_orders: 'tests', net_billed: 'billing', discount_total: 'discount', reports_finalized: 'reports finalized', commission: 'referral amount', outstanding: 'due', unique_patients: 'unique patients' };
      const per = state.period === 'week' ? 'last 7 days' : state.period === 'month' ? 'this month' : /^\d{4}-\d{2}$/.test(state.period || '') ? `in ${new Date(state.period + '-15').toLocaleString('en-IN', { month: 'long', year: 'numeric' })}` : '';
      q = `${MP[state.metric || 'revenue'] || 'collection'} ${per} ${frag}`.replace(/\s+/g, ' ').trim(); forceSql = true;
    } else {
      // a new dimension REPLACES the old one ("doctor wise" after "branch wise" is not branch x doctor)
      const base = DIM_PHRASE.test(frag) ? state.lastQ.replace(DIM_PHRASE, '').replace(/\s+—\s*$/, '').replace(/\s+/g, ' ').trim() : state.lastQ;
      q = `${base} — ${frag}`;
    }
    followUp = true;
  }
  const next: PulseState = { lastQ: q, metric: guessMetric(q) || state.metric || null, period: state.period || null, kind: null };

  const amb = ambiguousEntity(k, q);
  if (amb) return { kind: 'pick', term: amb.term, options: amb.options.slice(0, 20).map((o) => ({ id: o.id, name: o.name, kind: o.kind })), text: `Which ${amb.term}?`, state: { ...state, lastQ: q } };

  const ent = followUp ? null : await entityCard(k, q);
  if (ent) return { ...ent, state: { ...next, kind: 'entity' } };

  const r = forceSql ? null : await routeIntent(q, mentionsKnown(k, q));
  if (r?.mode === 'OUT_OF_SCOPE') return { kind: 'refuse', reason: 'out_of_scope', text: "I can't see that — only what happens inside your centre is recorded. I didn't run a query, so there's no number to give you.",
    chips: [{ label: 'patients who did not return in 90 days', q: 'how many patients have not returned in 90 days' }, { label: 'first-visit patients this month', q: 'new patients this month' }], state: { ...next, kind: 'refuse' } };
  if (r?.mode === 'LADDER') { const a = await ladderAnswer(q, r.period); return { ...a, state: { ...next, kind: 'ladder', period: r.period } }; }
  if (r) { const a = await runDiagnostic(q, r, state, followUp); return { ...a, state: { ...next, kind: a.kind, metric: a.metric || next.metric, period: a.period } }; }

  const a = await sqlAnswer(k, q);
  if (a.kind === 'error') return { kind: 'refuse', reason: 'not_answerable', text: "I couldn't turn that into a query the safety rules allow. Try naming the number you want — collection, cases, due, referrals.", provenance: a.provenance, state: next };
  if (a.shape === 'empty') return { kind: 'refuse', reason: 'no_rows', text: 'Nothing matched for that. If this is something the centre does not record, the answer is that we do not have it — not that it is zero.', provenance: a.provenance, state: next };
  return { ...a, followUp, state: { ...next, kind: 'sql' } };
}
