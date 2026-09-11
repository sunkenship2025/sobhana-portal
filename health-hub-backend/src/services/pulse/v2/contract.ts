/**
 * RESPONSE CONTRACT — how the answer allocates information, derived from the analytical job and
 * the shape of the evidence. No question text reaches this file.
 *
 * What this replaces: `deriveShape`, which ran an ordered ladder of regexes over the question to
 * pick a prose contract. It was the twin of the render-selection ladder that capability.ts
 * deleted, and it failed the same way — "break down discounts in the last 30 days by reason"
 * matched the trend pattern before the breakdown pattern, because of the words "last 30 days".
 * Leaving it in place meant the same failure would simply relocate one layer over.
 *
 * There was also a second enum. A question had a SHAPE (figure, ranking, breakdown…) for prose
 * and the plan carried a JOB (magnitude, concentration, composition…) for rendering, and the two
 * were the same idea maintained in two places, derived by two different mechanisms, free to
 * disagree. They are now one: the analyst declares the job, and the contract follows from it.
 *
 * Prose carries the conclusion, the interpretation and the implication. The artifact carries the
 * detailed rows and the supporting numbers. Three short sentences naming four branches and their
 * four deltas is still the wrong answer, so the budget is numbers, never sentences.
 */
import type { AnalyticalJob, EvidenceStructure } from './capability';

export interface Contract {
  job: AnalyticalJob;
  /** what prose is FOR, in this job */
  prose: string;
  /** what the artifact is FOR */
  artifact: string;
  /** does the owner get something on screen? WHICH type is capability.ts's decision, not this file's */
  needsArtifact: boolean;
  /** ceiling on numbers carried in prose — the axis that actually failed, unlike sentence count */
  maxNumbers: number;
  /** may individual rows be spelled out in prose? */
  rowsInProse: boolean;
  /** filled at runtime: the artifact types this evidence can truthfully support */
  canShow?: string[];
}

type Base = Omit<Contract, 'job' | 'canShow'>;

const BASE: Record<AnalyticalJob, Base> = {
  magnitude: {
    prose: 'The number, its scope and its period, in one sentence. A second sentence only if it needs a caveat — a partial period, an unusual definition.',
    artifact: 'Usually nothing; the sentence is the answer.',
    needsArtifact: false, maxNumbers: 3, rowsInProse: true,
  },
  comparison: {
    prose: 'Both figures, the direction, the size of the change, and then what it means for the business.',
    artifact: 'Optional — the two side by side, or the contributors if the change breaks down.',
    needsArtifact: false, maxNumbers: 5, rowsInProse: true,
  },
  composition: {
    prose: 'The total, and the one or two parts that carry it. Say what the split SHOWS. Never recite every part.',
    artifact: 'All the parts with their shares. This is where the detail lives.',
    needsArtifact: true, maxNumbers: 6, rowsInProse: false,
  },
  concentration: {
    prose: 'How few things account for how much — name the top one and what it implies. The rest of the order is not prose.',
    artifact: 'Every member in order, with the running share.',
    needsArtifact: true, maxNumbers: 6, rowsInProse: false,
  },
  attribution: {
    prose: 'What moved, by how much, and what drove it. At most three drivers, largest first. Anything immaterial beside the headline stays out of the sentences entirely.',
    artifact: 'The signed contributions, so the direction and the size are visible at a glance.',
    needsArtifact: true, maxNumbers: 8, rowsInProse: false,
  },
  progression: {
    prose: 'The direction, the size of the move, and the turning point if there is one. Not every bucket.',
    artifact: 'The series. Required — a shape over time is exactly what words cannot carry.',
    needsArtifact: true, maxNumbers: 5, rowsInProse: false,
  },
  variability: {
    prose: 'The typical value AND the tail. An average alone hides what the owner needs to act on.',
    artifact: 'The spread.',
    needsArtifact: true, maxNumbers: 5, rowsInProse: false,
  },
  conversion: {
    prose: 'How many entered, how many came through, and where the loss is concentrated.',
    artifact: 'The stages.',
    needsArtifact: true, maxNumbers: 5, rowsInProse: false,
  },
  relationship: {
    prose: 'Whether the two move together, how strongly, and which members break the pattern.',
    artifact: 'The pairs, when seeing the outliers matters.',
    needsArtifact: false, maxNumbers: 6, rowsInProse: false,
  },
  ranking: {
    prose: 'Who is top and by how much, and what that implies. Name the runner-up ONLY when the gap matters.',
    artifact: 'The full order with values.',
    needsArtifact: true, maxNumbers: 6, rowsInProse: false,
  },
  enumeration: {
    prose: 'You MUST state two figures: how many there are, and what they come to in total. Then how it is sorted and anything worth noticing about the set. Individual rows NEVER go in prose — a count without a total is half an answer.',
    artifact: 'The rows themselves, with names, numbers and amounts.',
    needsArtifact: true, maxNumbers: 5, rowsInProse: false,
  },
  explanation: {
    prose: "A real explanation, in an analyst's voice: what happened, what drove it, what it means. Prose IS the right answer here — do not compress it into a card. Lead with the conclusion, then at most three drivers, then the implication. Only material numbers; supporting detail belongs in an artifact if it is worth showing at all.",
    artifact: 'Optional, and often earned: the contributing split, when seeing it adds something the sentences cannot say.',
    needsArtifact: false, maxNumbers: 8, rowsInProse: false,
  },
};

/**
 * The contract for this answer. The job says what kind of understanding is owed; the evidence
 * structure tunes it, because the same job over one row and over forty rows are not the same
 * answer.
 */
export function contractFor(job: AnalyticalJob, st?: EvidenceStructure | null): Contract {
  const c: Contract = { job, ...(BASE[job] || BASE.explanation) };
  if (!st) return c;

  // One figure has nothing to show. Requiring an artifact here invents one.
  if (st.cardinality === 'one' && !st.hasStages && !st.isTimeSeries) {
    c.needsArtifact = false;
    c.rowsInProse = true;
  }
  // Many members: prose must not recite them, and the budget tightens because the temptation to
  // serialise grows with the row count — 26 numbers in 5 sentences came from exactly this case.
  if (st.cardinality === 'many') {
    c.rowsInProse = false;
    c.maxNumbers = Math.max(3, c.maxNumbers - 1);
  }
  return c;
}

/**
 * Fallback when the analyst did not declare a job — from STRUCTURE only, never from the question.
 * A truncated plan used to drop the whole turn; now it degrades to the job the evidence implies.
 */
export function inferJob(sts: EvidenceStructure[]): AnalyticalJob {
  const any = (f: keyof EvidenceStructure) => sts.some((s) => !!s[f]);
  if (any('hasStages')) return 'conversion';
  if (any('isTimeSeries')) return 'progression';
  if (any('hasDeltas') && sts.some((s) => s.dimensions >= 1)) return 'attribution';
  if (any('partsOfWhole')) return 'composition';
  if (any('numericSpread')) return 'variability';
  if (sts.some((s) => s.dimensions >= 1 && s.cardinality === 'many')) return 'enumeration';
  if (sts.some((s) => s.dimensions >= 1)) return 'ranking';
  if (any('hasDeltas')) return 'comparison';
  return 'magnitude';
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
  if (largest && v >= Math.abs(largest)) return true;
  const asked = magnitudeAskedAbout(question);
  if (asked && v >= asked * 0.2) return true;
  if (total && v / Math.abs(total) >= 0.05) return true;
  return false;
}

/* ─────────────────────────── validation ──────────────────────────────────────────────────── */

export interface ContractCheck { ok: boolean; violations: string[]; note?: string }

const NUM = /₹\s?[\d,]+(?:\.\d+)?|\b\d+(?:\.\d+)?\s?%|\b\d[\d,]*(?:\.\d+)?\b/g;
const countNumbers = (t: string) => (String(t).match(NUM) || []).length;
const sentencesOf = (t: string) => String(t).split(/(?<=[.!?])\s+/).filter((s) => s.trim().length > 1);

/** Did the response honour its contract? About information allocation, not length. */
export function checkAnswer(c: Contract, text: string, artifacts: any[], allowed?: string[]): ContractCheck {
  const v: string[] = [];
  const t = String(text || '');
  const arts = Array.isArray(artifacts) ? artifacts : [];

  const n = countNumbers(t);
  if (n > c.maxNumbers) v.push(`prose carries ${n} numbers, more than the ${c.maxNumbers} this answer should; move the detail into the artifact`);

  const worst = sentencesOf(t).reduce((m, s) => Math.max(m, countNumbers(s)), 0);
  if (worst > 3) v.push(`one sentence carries ${worst} numbers; no sentence should carry more than 3`);

  // An artifact is owed only when the job wants one AND the evidence can actually support one.
  const ok = allowed && allowed.length ? allowed : null;
  if (c.needsArtifact && ok && !arts.some((a) => ok.includes(String(a?.type)))) {
    v.push(`this answer must show a ${ok.slice(0, 2).join(' or ')} — the detail belongs there, not in the sentences`);
  }
  return { ok: v.length === 0, violations: v, note: v.join('; ') };
}

/**
 * Last resort when a repair still breaks the contract. Never ship prose known to be a dump: keep
 * the sentences carrying the conclusion, drop the ones reciting detail.
 */
export function simplify(c: Contract, text: string, artifacts: any[]): { text: string; dropped: number } {
  const sents = sentencesOf(text);
  if (sents.length <= 1) return { text, dropped: 0 };
  const kept: string[] = [];
  let used = 0;
  for (const s of sents) {
    const n = countNumbers(s);
    if (n > 3 && kept.length) continue;
    if (used + n > c.maxNumbers && kept.length) continue;
    kept.push(s); used += n;
  }
  const out = kept.join(' ').trim();
  const dropped = sents.length - kept.length;
  const hasArt = Array.isArray(artifacts) && artifacts.length > 0;
  return { text: dropped && hasArt ? `${out} The full detail is in the table below.` : out || text, dropped };
}
