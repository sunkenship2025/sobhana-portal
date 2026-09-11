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
import { analyse } from './v2/run';
import { hasArtifactReference } from './v2/artifacts';

export interface PulseState { lastQ?: string | null; lastSql?: string | null; metric?: string | null; period?: string | null; kind?: string | null; }
export type Answer = any;

const FRAGMENT = /^(and|aur|what about|kya)?\s*[a-z0-9 .'-]{2,40}\??$/i;

/* Someone saying hello is not a failed analysis. Answered here, instantly, for nothing. */
const GREETING = /^(hi|hey|hello+|yo|hola|namaste|namaskar|salaam|good (morning|afternoon|evening)|gm|ge)\b[\s!.,]*$/i;
const THANKS = /^(thanks|thank you|thx|ty|shukriya|dhanyavad|nice|good|great|cool|ok|okay|got it|perfect)\b[\s!.,]*$/i;
const CAPABILITY = /what can (you|u) do|what do (you|u) do|how do (i|you) (use|work)|help me|^help\b|who are (you|u)|what are (you|u)/i;
const OPENERS = [
  { label: 'Collection today', q: 'how much have we collected today' },
  { label: 'Where am I losing money', q: 'where am i losing money' },
  { label: 'Who owes money', q: 'list of patients with dues' },
  { label: 'Top doctors', q: 'doctor wise how many cases last month top 5' },
];
function smallTalk(q: string, state: PulseState): Answer | null {
  const t = q.trim();
  if (GREETING.test(t)) return { kind: 'chat', text: 'Hello. Ask me anything about the centre — money, cases, referrals, reports, or what needs attention.', chips: OPENERS, state: { ...state, lastQ: null } };
  if (THANKS.test(t) && state.lastQ) return { kind: 'chat', text: 'Anytime.', chips: [], state };
  if (CAPABILITY.test(t)) return { kind: 'chat', state: { ...state, lastQ: null },
    text: 'I read your centre\'s data and answer in plain words. Money — collection, billing, dues, discounts, doctor payouts. Volume — cases, tests, patients, reports and turnaround. Why a number moved, and what is worth your attention. I can also pull a working list of who owes money or whose report is late, with names and phone numbers. Ask the way you would say it out loud; Hinglish is fine.',
    chips: OPENERS };
  return null;
}
const DIM_PHRASE = /\b(branch|doctor|payment|test|department|category|month|day|week)[- ]?wise\b|\bby (branch|doctor|payment( mode)?|test|department|category|month|day|week)\b|\bper (branch|doctor|test|department)\b/gi;
/** A fragment is a continuation, not a question: no metric noun, no question word, or an explicit "and …". */
function isFragment(q: string, namesKnown: boolean): boolean {
  const words = q.trim().split(/\s+/); if (words.length > 4 || !FRAGMENT.test(q)) return false;
  if (/^(and|aur|what about|kya)\b/i.test(q)) return true;
  if (namesKnown) return false;   // "sharma referrals this month" is a whole question, not a continuation
  if (/\b(how|what|which|why|when|kitn[ae]|kaisa|kyun)\b/i.test(q) || guessMetric(q)) return false;
  return true;
}

export async function ask(rawQ: string, state: PulseState = {}, opts: { v2?: boolean } = {}): Promise<Answer> {
  // V2: one general analyst that plans the analysis, instead of a router that picks a fixed path.
  // The guards below (picker, entity card) still run first — they are cheaper and exact.
  const useV2 = opts.v2 ?? process.env.PULSE_V2 !== '0';
  let q = String(rawQ || '').trim().slice(0, 500);
  if (!q) return { kind: 'refuse', reason: 'empty', text: 'Ask me something about the business.', state };
  const chat = smallTalk(q, state); if (chat) return chat;
  const k = await ensureKnowledge();

  // PRECEDENCE. Entity resolution is no longer a universal first gate. "in that table" is a
  // conversation problem, not an entity problem — it used to reach ambiguousEntity(), which
  // matched "MBBS" across several doctor names and replied "Which mbbs?" twice without ever
  // running an analysis. A question that points at what is already on screen goes straight to
  // the analyst, which is given the artifact and its meaning.
  const refersToArtifact = useV2 && hasArtifactReference(q, (state as any).lastTurn);
  // A pasted block is not an entity mention either. Someone pasting a table back in is quoting
  // it, and every doctor name in it should not become a disambiguation prompt.
  const pasted = q.length > 180 || (q.match(/₹/g) || []).length >= 3 || /\t|\n.*\n/.test(rawQ || '');
  // FOLLOW-UP: a short fragment ("and kompally?", "branch wise", "vs july") inherits the last
  // question — the model sees both, the card family stays, one field changes.
  let followUp = false, forceSql = false;
  const rawFollowUp = String(rawQ || '').trim().slice(0, 500);   // what the owner actually typed
  if (!refersToArtifact && state.lastQ && isFragment(q, mentionsKnown(k, q))) {
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
  const next: PulseState = { lastQ: q, lastSql: null, metric: guessMetric(q) || state.metric || null, period: state.period || null, kind: null };

  const amb = refersToArtifact || pasted ? null : ambiguousEntity(k, q);
  if (amb) return { kind: 'pick', term: amb.term, options: amb.options.slice(0, 20).map((o) => ({ id: o.id, name: o.name, kind: o.kind })), text: `Which ${amb.term}?`, state: { ...state, lastQ: q } };

  const ent = followUp || refersToArtifact ? null : await entityCard(k, q);
  if (ent) return { ...ent, state: { ...next, kind: 'entity' } };

  if (useV2 && !forceSql) {
    // V2 carries the previous QUESTION and PLAN, so the analyst decides what a follow-up changes.
    // The V1 fragment rewriting was for a path with no such memory; splicing "— only balanagar"
    // onto the last question here loses the subject and the analyst answers something else.
    try { return await analyse(rawFollowUp || q, { ...state, lastQ: state.lastQ || null }); }
    catch (e) {
      console.warn('[pulse] v2 failed:', (e as any)?.message);
      // V1 has no idea what "the second one" points at, so it answers a DIFFERENT question with
      // full confidence. For a question about what is already on screen, saying so beats that.
      if (refersToArtifact) return { kind: 'refuse', reason: 'reference_failed',
        text: "I lost track of what you were pointing at there. Ask it again naming the row — the doctor, the branch or the test — and I'll pick it up.",
        state: { ...state, lastQ: q } };
    }
  }
  const r = forceSql ? null : await routeIntent(q, mentionsKnown(k, q));
  if (r?.mode === 'OUT_OF_SCOPE') return { kind: 'refuse', reason: 'out_of_scope', text: "I can't see that — only what happens inside your centre is recorded. I didn't run a query, so there's no number to give you.",
    chips: [{ label: 'patients who did not return in 90 days', q: 'how many patients have not returned in 90 days' }, { label: 'first-visit patients this month', q: 'new patients this month' }], state: { ...next, kind: 'refuse' } };
  if (r?.mode === 'LADDER') { const a = await ladderAnswer(q, r.period); return { ...a, state: { ...next, kind: 'ladder', period: r.period } }; }
  if (r) { const a = await runDiagnostic(q, r, state, followUp); return { ...a, state: { ...next, kind: a.kind, metric: a.metric || next.metric, period: a.period } }; }

  const a = await sqlAnswer(k, q, { lastQ: state.lastQ, lastSql: state.lastSql });
  if (a.kind === 'error') {
    // patient-level output is blocked by design — say which page has it rather than sounding evasive
    const phi = /patient-level table requires an aggregate|column not granted/i.test(a.text) || /\b(name|phone|number|contact|list of (all )?(patients|dues|bills))\b/i.test(q);
    return { kind: 'refuse', reason: phi ? 'patient_level' : 'not_answerable',
      text: phi ? "I can give you totals and counts, never a list of patients with names or phone numbers — Pulse has no access to those columns. For a working list of dues, open Money → Bills and filter to unpaid; it has the names, numbers and amounts, and it can be exported."
                : "I couldn't turn that into a query. Try naming the number you want — collection, cases, due, referrals.",
      chips: phi ? [{ label: 'total due', q: 'total due how much' }, { label: 'due branch wise', q: 'due branch wise' }, { label: 'open Money → Bills', q: '/money/bills' }] : undefined,
      provenance: a.provenance, state: next };
  }
  if (a.shape === 'empty') return { kind: 'refuse', reason: 'no_rows', text: 'Nothing matched for that. If this is something the centre does not record, the answer is that we do not have it — not that it is zero.', provenance: a.provenance, state: next };
  return { ...a, followUp, state: { ...next, kind: 'sql', lastSql: a.provenance?.sql || null } };
}
