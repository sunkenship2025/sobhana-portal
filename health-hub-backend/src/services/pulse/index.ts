/**
 * Pulse — one question in, one answer out, through one analyst.
 *
 * There used to be a second pipeline behind this one: a router that picked among fixed intents,
 * and a fallback that caught anything the analyst threw. It was deleted because a fallback that
 * answers a DIFFERENT question is worse than no answer. When the analyst failed on "how much of
 * that is the second doctor", the old path had no idea what "that" pointed at and confidently
 * answered something else — with the pre-2c193be dues definition, test branches included, and
 * none of the evidence the investigation had just gathered. Silence is recoverable; a confident
 * wrong number is not.
 *
 * Two cheap exact guards still run first — the entity picker and the entity card — because they
 * are deterministic and cost nothing. Everything else is the analyst.
 */
import { ensureKnowledge, knowledgeReady, ambiguousEntity, mentionsKnown } from './knowledge';
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

export async function ask(rawQ: string, state: PulseState = {}, opts: { onProgress?: (t: string, kind?: string) => void } = {}): Promise<Answer> {
  let q = String(rawQ || '').trim().slice(0, 500);
  if (!q) return { kind: 'refuse', reason: 'empty', text: 'Ask me something about the business.', state };
  const chat = smallTalk(q, state); if (chat) return chat;
  const k = await ensureKnowledge();

  // PRECEDENCE. Entity resolution is no longer a universal first gate. "in that table" is a
  // conversation problem, not an entity problem — it used to reach ambiguousEntity(), which
  // matched "MBBS" across several doctor names and replied "Which mbbs?" twice without ever
  // running an analysis. A question that points at what is already on screen goes straight to
  // the analyst, which is given the artifact and its meaning.
  const refersToArtifact = hasArtifactReference(q, (state as any).lastTurn);
  // A pasted block is not an entity mention either. Someone pasting a table back in is quoting
  // it, and every doctor name in it should not become a disambiguation prompt.
  const pasted = q.length > 180 || (q.match(/₹/g) || []).length >= 3 || /\t|\n.*\n/.test(rawQ || '');
  // FOLLOW-UP: a short fragment ("and kompally?", "branch wise", "vs july") inherits the last
  // question — the model sees both, the card family stays, one field changes.
  let followUp = false;
  const rawFollowUp = String(rawQ || '').trim().slice(0, 500);   // what the owner actually typed
  if (!refersToArtifact && state.lastQ && isFragment(q, mentionsKnown(k, q))) {
    const frag = q.replace(/^(and|aur|what about|kya)\s+/i, '').replace(/\?+$/, '').trim();
    // "and kompally?" — a place or name we do not know cannot be filtered on; say so instead of guessing
    const tok = frag.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
    if (/^[a-z]{4,}$/.test(tok) && !DIM_PHRASE.test(frag) && !k.vidx[tok] && !mentionsKnown(k, tok) && !/week|month|today|yesterday|year|july|august|september|june/.test(tok))
      return { kind: 'refuse', reason: 'unknown_entity', text: `I don't know a branch, doctor or test called "${frag}". Branches are ${k.names.filter((n) => n.kind === 'branch').map((n) => n.name).join(', ')}.`, state };
    // a new dimension REPLACES the old one ("doctor wise" after "branch wise" is not branch x doctor)
    const base = DIM_PHRASE.test(frag) ? state.lastQ.replace(DIM_PHRASE, '').replace(/\s+—\s*$/, '').replace(/\s+/g, ' ').trim() : state.lastQ;
    q = `${base} — ${frag}`;
    followUp = true;
  }
  const next: PulseState = { lastQ: q, lastSql: null, metric: guessMetric(q) || state.metric || null, period: state.period || null, kind: null };

  const amb = refersToArtifact || pasted ? null : ambiguousEntity(k, q);
  if (amb) return { kind: 'pick', term: amb.term, options: amb.options.slice(0, 20).map((o) => ({ id: o.id, name: o.name, kind: o.kind })), text: `Which ${amb.term}?`, state: { ...state, lastQ: q } };

  const ent = followUp || refersToArtifact ? null : await entityCard(k, q);
  if (ent) return { ...ent, state: { ...next, kind: 'entity' } };

  // The analyst carries the previous QUESTION and PLAN, so it decides what a follow-up changes.
  try { return await analyse(rawFollowUp || q, { ...state, lastQ: state.lastQ || null }, opts.onProgress); }
  catch (e) {
    console.warn('[pulse] analysis failed:', (e as any)?.message);
    return { kind: 'refuse', reason: refersToArtifact ? 'reference_failed' : 'failed',
      text: refersToArtifact
        ? "I lost track of what you were pointing at there. Ask it again naming the row — the doctor, the branch or the test — and I'll pick it up."
        : "That analysis failed part way through, so I have nothing I can stand behind. Ask it again, or ask for a narrower piece of it.",
      state: { ...next, kind: 'refuse' } };
  }
}
