/**
 * ANSWER SHAPE — what KIND of answer this question deserves, decided before a word is written.
 *
 * The failure this exists to kill: "where am i losing money" answered with 26 numbers in 5
 * sentences. Nothing was wrong with the analysis; every figure was correct. The response had no
 * declared shape, so there was no rule saying which numbers belong in prose and which belong on
 * screen, and the writer serialised all of them into a paragraph.
 *
 * The shape is a property of the ANSWER, not of the database result. "How much did revenue
 * change?" is a figure even when the query returns one row per branch; "show me revenue by
 * branch" is a breakdown even though it is the same query. So the question leads, the plan and
 * the evidence corroborate, and the conversation carries a shape forward on a follow-up.
 *
 * Each shape carries a CONTRACT that allocates information rather than counting sentences:
 * prose gets the conclusion, the interpretation and the implication; the artifact gets the
 * detailed rows and the supporting numbers. Three short sentences listing four branches and
 * their four deltas is still the wrong answer.
 */
import type { Evidence } from './tools';

export type AnswerShape =
  | 'figure'      // one number is the answer
  | 'comparison'  // this versus that
  | 'ranking'     // ordered members, the top one is the answer
  | 'breakdown'   // parts of a whole
  | 'trend'       // movement over time
  | 'list'        // rows the owner will act on
  | 'diagnosis'   // why something moved — genuinely a narrative
  | 'definition'  // what a term means here
  | 'prose';      // unknown: behave exactly as before

export interface Contract {
  shape: AnswerShape;
  /** what prose is FOR, in this shape */
  prose: string;
  /** what the artifact is FOR, in this shape */
  artifact: string;
  /** artifact types that must be present; the response is invalid without one of them */
  require: string[];
  /** ceiling on numbers carried in prose — the axis that actually failed, unlike sentence count */
  maxNumbers: number;
  /** may individual rows be spelled out in prose? */
  rowsInProse: boolean;
}

/** Prose is for the conclusion. The artifact is for the evidence behind it. */
export const CONTRACTS: Record<AnswerShape, Contract> = {
  figure: {
    shape: 'figure',
    prose: 'The number, its scope and its period, in one sentence. A second sentence only if the figure needs a caveat (partial period, unusual definition).',
    artifact: 'Nothing. The sentence already is the answer.',
    require: [], maxNumbers: 3, rowsInProse: true,
  },
  comparison: {
    shape: 'comparison',
    prose: 'Both figures, the direction and the size of the change. Then what it means.',
    artifact: 'Optional. A compare card when seeing the two side by side helps.',
    require: [], maxNumbers: 5, rowsInProse: true,
  },
  ranking: {
    shape: 'ranking',
    prose: 'The conclusion: who is top and by how much, and what that implies. Name the runner-up ONLY if the gap matters. The rest of the order does not belong in prose.',
    artifact: 'Every member, in order, with values. This is where the list lives.',
    require: ['ranking', 'table', 'breakdown'], maxNumbers: 6, rowsInProse: false,
  },
  breakdown: {
    shape: 'breakdown',
    prose: 'The total, and the one or two parts that carry it. Say what the split shows — never recite every part.',
    artifact: 'All parts with their shares. Required: this is the shape whose information IS the table.',
    require: ['breakdown', 'ranking', 'table', 'chart'], maxNumbers: 6, rowsInProse: false,
  },
  trend: {
    shape: 'trend',
    prose: 'Direction, size of the move, and the turning point if there is one. Not every bucket.',
    artifact: 'The series. Required — a shape over time is what words cannot carry.',
    require: ['chart', 'table'], maxNumbers: 5, rowsInProse: false,
  },
  list: {
    shape: 'list',
    prose: 'How many, the total, how it is sorted, and anything the owner should notice about the set. Individual rows NEVER go in prose.',
    artifact: 'The rows themselves, with names, numbers and amounts. Required.',
    require: ['table', 'ranking'], maxNumbers: 4, rowsInProse: false,
  },
  diagnosis: {
    shape: 'diagnosis',
    prose: 'A real explanation, in an analyst\'s voice: what moved, by how much, and what drove it. Prose is the right answer here — do not compress it into a card. Lead with the finding, then the driver, then what it means. Keep supporting detail out of the sentences; put it in an artifact if it is worth showing.',
    artifact: 'Optional. Attach one when the contributing split is worth seeing.',
    require: [], maxNumbers: 8, rowsInProse: false,
  },
  definition: {
    shape: 'definition',
    prose: 'What the term means in THIS business, and what it includes and excludes. Plain words.',
    artifact: 'Optional. The member list when the definition is a set.',
    require: [], maxNumbers: 4, rowsInProse: true,
  },
  prose: {
    shape: 'prose',
    prose: 'Answer plainly. Put the conclusion first.',
    artifact: 'Attach one only when the shape carries something words cannot.',
    require: [], maxNumbers: 8, rowsInProse: true,
  },
};

/** What the question asks for, read off its form. The strongest single signal. */
function fromQuestion(q: string): AnswerShape | null {
  const s = ` ${q.toLowerCase().replace(/[^a-z0-9%₹ ]+/g, ' ').replace(/\s+/g, ' ')} `;
  // "why" and "what caused" are causal even when the evidence is a plain breakdown
  if (/\b(why|what caused|what is driving|whats driving|reason for|explain the|how come)\b/.test(s)) return 'diagnosis';
  if (/\b(what do you mean|what does .* mean|what is meant|what all (is|are) included|what counts as|define)\b/.test(s)) return 'definition';
  if (/\b(list|names? and numbers?|name number|phone|contact|who owes|pull (out |up )?(a |the )?list)\b/.test(s)) return 'list';
  if (/\b(top \d+|top five|highest|lowest|best|worst|most|least|biggest|largest|rank|where am i losing|which branch|which doctor|which staff|which test)\b/.test(s)) return 'ranking';
  if (/\b(trend|over time|day by day|month by month|daily|weekly|monthly|trajectory|last \d+ (days|weeks|months))\b/.test(s)) return 'trend';
  if (/\b(break ?down|split|by branch|by doctor|by department|by type|by category|by payment|branch wise|doctor wise|wise)\b/.test(s)) return 'breakdown';
  if (/\b(vs|versus|compared to|compare|against last|than last|more than last|change from)\b/.test(s)) return 'comparison';
  if (/\b(how much|how many|what is the total|whats the total|total)\b/.test(s)) return 'figure';
  return null;
}

/** What the analysis actually produced. Corroborates the question, and decides when it is silent. */
function fromEvidence(ev: Evidence[]): AnswerShape | null {
  const ok = ev.filter((e) => e.ok);
  if (!ok.length) return null;
  const tools = new Set(ok.map((e) => e.tool));
  if (tools.has('worklist')) return 'list';
  if (tools.has('trend')) return 'trend';
  if (tools.has('rank') || tools.has('quiet_doctors')) return 'ranking';
  if (tools.has('breakdown') || tools.has('leakage') || tools.has('receivables')) return 'breakdown';
  if (tools.has('anomalies')) return 'ranking';
  if (tools.has('compare') || tools.has('baseline')) return 'comparison';
  // a free query that came back with many rows over a named dimension is a breakdown in disguise
  const q = ok.find((e) => e.tool === 'query');
  const rows = (q?.data as any)?.rows;
  if (Array.isArray(rows)) {
    if (rows.length >= 8) return 'list';
    if (rows.length >= 2) return 'breakdown';
    if (rows.length === 1) return 'figure';
  }
  if (tools.has('metric') || tools.has('derive')) return 'figure';
  return null;
}

/**
 * The shape of the answer, from the question first, then the plan, then what came back, then
 * what the conversation was already doing. The question leads because it states what the owner
 * wants to KNOW; the evidence only says what we happened to fetch.
 */
export function deriveShape(
  question: string,
  plan: { goal?: string; spec?: any } | null | undefined,
  evidence: Evidence[],
  ctx?: { lastShape?: AnswerShape | null; isFollowUp?: boolean },
): AnswerShape {
  const asked = fromQuestion(question) || fromQuestion(String(plan?.goal || ''));
  const got = fromEvidence(evidence);

  // Causal and definitional questions keep their shape whatever the tools returned — the
  // evidence for "why did revenue fall" is a breakdown, but the ANSWER is an explanation.
  if (asked === 'diagnosis' || asked === 'definition') return asked;

  // The owner asked for a list or a ranking: honour it if anything came back that can fill one.
  if (asked === 'list' && got) return 'list';
  if (asked === 'ranking' && (got === 'breakdown' || got === 'ranking' || got === 'list')) return 'ranking';

  // "How much did revenue change" is a figure even if the query returned a row per branch.
  if (asked === 'figure' && got !== 'list') return 'figure';

  if (asked && got) return asked === got ? asked : (asked === 'breakdown' || asked === 'trend' || asked === 'comparison') ? asked : got;
  if (asked) return asked;
  if (got) return got;
  // A bare follow-up ("and balanagar?") keeps doing what the last turn was doing.
  if (ctx?.isFollowUp && ctx.lastShape) return ctx.lastShape;
  return 'prose';
}

/* ─────────────────────────── materiality ─────────────────────────────────────────────────── */

/** A figure the owner named in the question, e.g. "what caused the ₹2,000 increase". */
function magnitudeAskedAbout(q: string): number | null {
  const m = String(q).match(/₹\s?([\d,]+(?:\.\d+)?)\s*(l|lakh|k|cr|crore)?/i);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = (m[2] || '').toLowerCase();
  return u.startsWith('l') ? n * 1e5 : u === 'k' ? n * 1e3 : u.startsWith('c') ? n * 1e7 : n;
}

/**
 * Is this item worth a sentence? Never magnitude alone — ₹1,952 is noise beside a ₹10L rise and
 * is the entire story when the owner asked what caused a ₹2,000 increase. Materiality is
 * relative to the total, to the largest item, and to what was actually asked.
 */
export function isMaterial(value: number, total: number, largest: number, question: string): boolean {
  const v = Math.abs(Number(value) || 0);
  if (!v) return false;
  if (largest && v >= Math.abs(largest)) return true;                 // the top item always is
  const asked = magnitudeAskedAbout(question);
  if (asked && v >= asked * 0.2) return true;                         // the owner named this size
  if (total && v / Math.abs(total) >= 0.05) return true;              // ≥5% of the relevant total
  return false;
}

/* ─────────────────────────── validation ──────────────────────────────────────────────────── */

export interface ShapeCheck { ok: boolean; violations: string[]; note?: string }

const NUM = /₹\s?[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%|\b\d[\d,]*(?:\.\d+)?\b/g;
const countNumbers = (t: string) => (String(t).match(NUM) || []).length;
const sentencesOf = (t: string) => String(t).split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 1);

/**
 * Did the response honour its contract? Deterministic, and about information allocation rather
 * than length: too many numbers serialised into prose, rows recited instead of shown, or a
 * required artifact missing.
 */
export function checkAnswer(c: Contract, text: string, artifacts: any[]): ShapeCheck {
  const v: string[] = [];
  const t = String(text || '');
  const arts = Array.isArray(artifacts) ? artifacts : [];

  const n = countNumbers(t);
  if (n > c.maxNumbers) v.push(`prose carries ${n} numbers, more than the ${c.maxNumbers} this answer should; move the detail into the artifact`);

  // density matters even when the total is within budget — 4 numbers in one sentence is a dump
  const worst = sentencesOf(t).reduce((m, s) => Math.max(m, countNumbers(s)), 0);
  if (worst > 3) v.push(`one sentence carries ${worst} numbers; no sentence should carry more than 3`);

  if (c.require.length && !arts.some((a) => c.require.includes(String(a?.type)))) {
    v.push(`this answer must show a ${c.require.slice(0, 2).join(' or ')} — the detail belongs there, not in the sentences`);
  }
  return { ok: v.length === 0, violations: v, note: v.join('; ') };
}

/**
 * Last resort when a repair still violates the contract. Never ship prose known to be a dump:
 * keep the sentences that carry the conclusion, drop the ones that are reciting detail, and let
 * the artifact carry what was dropped.
 */
export function simplify(c: Contract, text: string, artifacts: any[]): { text: string; dropped: number } {
  const sents = sentencesOf(text);
  if (sents.length <= 1) return { text, dropped: 0 };
  const kept: string[] = [];
  let used = 0;
  for (const s of sents) {
    const n = countNumbers(s);
    if (n > 3 && kept.length) continue;                 // a detail-recital sentence, after the lead
    if (used + n > c.maxNumbers && kept.length) continue;
    kept.push(s); used += n;
  }
  const out = kept.join(' ').trim();
  const dropped = sents.length - kept.length;
  const hasArt = Array.isArray(artifacts) && artifacts.length > 0;
  return { text: dropped && hasArt ? `${out} The full detail is in the table below.` : out || text, dropped };
}
