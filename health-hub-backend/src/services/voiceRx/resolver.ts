/**
 * Medication resolver — the layer that decides what a spoken drug name IS.
 *
 * THE ARCHITECTURAL POINT OF THIS FILE
 * The LLM never resolves a medicine. It reports "the doctor said a token that
 * sounds like Augmentin 625"; THIS file decides what that maps to, and hands back
 * candidates instead of a guess when it cannot tell. That separation is what makes
 * a cheap extraction model safe: we ask it to parse, never to know medicine.
 *
 * WHY IT NEVER AUTO-PICKS
 * 18 of 23 prescribers in one qualitative study reported having actually selected
 * the entry NEXT TO the one they meant from an autocomplete — juxtaposition error
 * is a lived failure, not a hypothetical. So: full names, never truncated, never
 * pre-selected, and ambiguity is surfaced rather than silently broken by score.
 *
 * MATCHING LADDER, cheapest first, stopping at the first tier that is decisive:
 *   1. exact canonical / generic / brand
 *   2. alias (clinic shorthand + recorded ASR mishearings)
 *   3. phonetic key (sound-alike: "azithral" ~ "azithral")
 *   4. trigram similarity (typos and partial hearings)
 *
 * The catalog is a few thousand rows of near-static data, so it is cached in
 * memory and matched there — the same call this codebase already made for
 * reference ranges, and for the same reason: it is catalog data, not patient data.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export type Resolution = 'RESOLVED' | 'AMBIGUOUS' | 'UNRESOLVED';

export interface MedicationRow {
  id: string;
  canonicalName: string;
  genericName: string | null;
  brandName: string | null;
  strength: string | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  route: string | null;
  aliases: string[];
  phoneticKey: string | null;
  isScheduleX: boolean;
  isNdps: boolean;
  scheduleClass: string | null;
}

export interface Candidate {
  medicationId: string;
  canonicalName: string;
  genericName: string | null;
  brandName: string | null;
  strength: string | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  route: string | null;
  score: number;
  matchedOn: 'exact' | 'alias' | 'phonetic' | 'fuzzy';
}

export interface ResolveResult {
  resolution: Resolution;
  /** Set only when RESOLVED. */
  match: Candidate | null;
  /** Populated when AMBIGUOUS (and kept for UNRESOLVED as "nearest, still wrong"). */
  candidates: Candidate[];
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

/** Lowercase, strip punctuation, collapse whitespace. */
export const norm = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9\s+]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * A crude phonetic key tuned for Indian pharmaceutical brand names rather than
 * English surnames (which is what Soundex and Metaphone were built for).
 *
 * The substitutions below are the ones that actually collide in drug names:
 * ph/f, c/k, z/s, x/ks, silent h, doubled letters, and the trailing vowel that
 * Indian brand names wear so often (Azithral / Azithrale / Azithra).
 *
 * ponytail: hand-rolled, ~30 lines, no new dependency. If sound-alike recall ever
 * measurably falls short on the benchmark, swap in double-metaphone — the
 * interface here does not change.
 */
export function phoneticKey(input: string): string {
  let s = norm(input).replace(/\s+/g, '');
  if (!s) return '';
  s = s
    .replace(/ph/g, 'f')
    .replace(/gh/g, 'g')
    .replace(/ck/g, 'k')
    .replace(/c(?=[eiy])/g, 's')
    .replace(/c/g, 'k')
    .replace(/q/g, 'k')
    .replace(/x/g, 'ks')
    .replace(/z/g, 's')
    .replace(/w/g, 'v')
    .replace(/h/g, '')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1'); // collapse doubles
  // Drop a trailing vowel: Indian brand names vary it freely.
  s = s.replace(/[aeiou]$/, '');
  return s;
}

/** Character trigrams, for similarity. */
function trigrams(s: string): Set<string> {
  const p = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < p.length - 2; i++) out.add(p.slice(i, i + 3));
  return out;
}

/**
 * Dice coefficient over trigrams — 0..1.
 *
 * Dice, NOT Jaccard. On a short word a single transposition destroys three
 * trigrams, and Jaccard punishes that so hard that "agumentin" vs "augmentin"
 * scores 0.43 — indistinguishable from noise, and below any floor worth setting.
 * Dice scores the same pair 0.60 while still leaving look-alike drug pairs
 * (amlodipine / amiodarone -> 0.27) far below the auto-resolve threshold.
 *
 * Caught by resolver.check.ts, which is why that file exists.
 */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = trigrams(a);
  const B = trigrams(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return (2 * inter) / (A.size + B.size);
}

// ---------------------------------------------------------------------------
// Catalog cache
// ---------------------------------------------------------------------------

interface CatalogIndex {
  rows: MedicationRow[];
  byExact: Map<string, MedicationRow[]>;
  byPhonetic: Map<string, MedicationRow[]>;
  loadedAt: number;
}

let CACHE: CatalogIndex | null = null;
const TTL_MS = 10 * 60 * 1000;

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const cur = m.get(k);
  if (cur) cur.push(v);
  else m.set(k, [v]);
}

async function loadCatalog(): Promise<CatalogIndex> {
  if (CACHE && Date.now() - CACHE.loadedAt < TTL_MS) return CACHE;

  const rows = (await prisma.medication.findMany({
    where: { isActive: true, deletedAt: null },
    select: {
      id: true, canonicalName: true, genericName: true, brandName: true,
      strength: true, strengthUnit: true, dosageForm: true, route: true,
      aliases: true, phoneticKey: true,
      isScheduleX: true, isNdps: true, scheduleClass: true,
    },
  })) as MedicationRow[];

  const byExact = new Map<string, MedicationRow[]>();
  const byPhonetic = new Map<string, MedicationRow[]>();

  for (const r of rows) {
    const names = [r.canonicalName, r.genericName, r.brandName, ...(r.aliases ?? [])].filter(Boolean) as string[];
    for (const n of names) {
      push(byExact, norm(n), r);
      push(byPhonetic, r.phoneticKey || phoneticKey(n), r);
    }
  }

  CACHE = { rows, byExact, byPhonetic, loadedAt: Date.now() };
  logger.info({ medications: rows.length }, 'voiceRx: medication catalog cached');
  return CACHE;
}

/** Called after any catalog write so a correction takes effect immediately. */
export function invalidateCatalog(): void {
  CACHE = null;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const toCandidate = (r: MedicationRow, score: number, matchedOn: Candidate['matchedOn']): Candidate => ({
  medicationId: r.id,
  canonicalName: r.canonicalName,
  genericName: r.genericName,
  brandName: r.brandName,
  strength: r.strength,
  strengthUnit: r.strengthUnit,
  dosageForm: r.dosageForm,
  route: r.route,
  score,
  matchedOn,
});

/**
 * Narrow a candidate set by a spoken strength.
 *
 * "Augmentin 625" should not stay ambiguous between the 625 tablet and the 457
 * syrup when the doctor SAID 625. But a strength that matches nothing is never
 * used to empty the list — an unmatched strength means our catalog is incomplete,
 * not that the doctor is wrong.
 */
function narrowByStrength(cands: Candidate[], strength: string | null): Candidate[] {
  if (!strength) return cands;
  const want = strength.replace(/[^0-9]/g, '');
  if (!want) return cands;
  const hit = cands.filter((c) => (c.strength ?? '').replace(/[^0-9]/g, '') === want);
  return hit.length > 0 ? hit : cands;
}

/**
 * Narrow by dosage form. Same rule: only when it actually discriminates.
 * A "syrup" heard for a child is a real signal; an unmatched form is not.
 */
function narrowByForm(cands: Candidate[], form: string | null): Candidate[] {
  if (!form) return cands;
  const want = norm(form);
  const hit = cands.filter((c) => norm(c.dosageForm ?? '') === want);
  return hit.length > 0 ? hit : cands;
}

const MAX_CANDIDATES = 5;
/** Below this, a fuzzy hit is noise rather than a near-miss worth showing.
 *  Tuned for Dice: a one-character transposition lands near 0.60, unrelated
 *  drug names near 0.20, and known look-alike pairs near 0.27. */
const FUZZY_FLOOR = 0.5;
/** A fuzzy match this strong, and clear of the runner-up, resolves on its own. */
const FUZZY_CONFIDENT = 0.82;
const FUZZY_MARGIN = 0.12;

export interface ResolveInput {
  /** What the doctor said / typed, e.g. "augmentin 625" or "amoxi clav". */
  spoken: string;
  strength?: string | null;
  dosageForm?: string | null;
}

export async function resolveMedication(input: ResolveInput): Promise<ResolveResult> {
  const idx = await loadCatalog();
  const q = norm(input.spoken);
  if (!q) return { resolution: 'UNRESOLVED', match: null, candidates: [] };

  const dedupe = (cs: Candidate[]): Candidate[] => {
    const seen = new Set<string>();
    return cs.filter((c) => (seen.has(c.medicationId) ? false : (seen.add(c.medicationId), true)));
  };

  const decide = (cands: Candidate[], _tier: string): ResolveResult | null => {
    let narrowed = narrowByForm(narrowByStrength(dedupe(cands), input.strength ?? null), input.dosageForm ?? null);
    narrowed = narrowed.sort((a, b) => b.score - a.score).slice(0, MAX_CANDIDATES);
    if (narrowed.length === 0) return null;
    if (narrowed.length === 1) return { resolution: 'RESOLVED', match: narrowed[0], candidates: narrowed };
    // Several survive. Only a clear winner resolves; otherwise ASK.
    if (narrowed[0].score >= FUZZY_CONFIDENT && narrowed[0].score - narrowed[1].score >= FUZZY_MARGIN) {
      return { resolution: 'RESOLVED', match: narrowed[0], candidates: narrowed };
    }
    return { resolution: 'AMBIGUOUS', match: null, candidates: narrowed };
  };

  // --- 1 + 2. exact / alias -------------------------------------------------
  const exact = idx.byExact.get(q);
  if (exact?.length) {
    const d = decide(exact.map((r) => toCandidate(r, 1, 'exact')), 'exact');
    if (d) return d;
  }

  // The spoken token often carries the strength: "augmentin 625", "pantop 40".
  // Strip a trailing number and retry — that number is a strength signal, not
  // part of the name, and it also narrows the candidate set below.
  const m = q.match(/^(.*?)\s*(\d+(?:\s*\+\s*\d+)?)\s*(?:mg|mcg|ml|g|iu)?$/);
  const stem = m ? m[1].trim() : q;
  const spokenStrength = input.strength ?? (m ? m[2].replace(/\s+/g, '') : null);

  if (stem && stem !== q) {
    const viaStem = idx.byExact.get(stem);
    if (viaStem?.length) {
      const d = decide(viaStem.map((r) => toCandidate(r, 0.98, 'alias')), 'alias');
      if (d) return { ...d, candidates: narrowByStrength(d.candidates, spokenStrength) };
    }
  }

  // --- 3. phonetic ----------------------------------------------------------
  const pk = phoneticKey(stem);
  const phon = pk ? idx.byPhonetic.get(pk) : undefined;
  if (phon?.length) {
    const cands = phon.map((r) => toCandidate(r, 0.9, 'phonetic'));
    const d = decide(narrowByStrength(cands, spokenStrength), 'phonetic');
    if (d) return d;
  }

  // --- 4. fuzzy -------------------------------------------------------------
  const scored: Candidate[] = [];
  for (const r of idx.rows) {
    const names = [r.canonicalName, r.genericName, r.brandName, ...(r.aliases ?? [])].filter(Boolean) as string[];
    let best = 0;
    for (const n of names) {
      const s = similarity(stem, norm(n));
      if (s > best) best = s;
    }
    if (best >= FUZZY_FLOOR) scored.push(toCandidate(r, best, 'fuzzy'));
  }
  if (scored.length) {
    const d = decide(narrowByStrength(scored, spokenStrength), 'fuzzy');
    if (d) return d;
  }

  return { resolution: 'UNRESOLVED', match: null, candidates: [] };
}

/** Look up rows by id — used by the validator for the Schedule X / NDPS gate. */
export async function getMedicationsByIds(ids: string[]): Promise<Map<string, MedicationRow>> {
  if (ids.length === 0) return new Map();
  const idx = await loadCatalog();
  const want = new Set(ids);
  return new Map(idx.rows.filter((r) => want.has(r.id)).map((r) => [r.id, r]));
}

/**
 * The biasing prompt handed to the ASR: the clinic's own vocabulary.
 *
 * Both Groq and Sarvam accept a hint, and telling the decoder that "Augmentin"
 * and "Azithral" are words it might hear is the single cheapest accuracy gain
 * available — far cheaper than a better model, and it targets exactly the tokens
 * that matter. Capped because a prompt that is mostly noise biases nothing.
 */
export async function buildAsrHint(limit = 120): Promise<string> {
  const idx = await loadCatalog();
  const names = idx.rows
    .map((r) => r.brandName || r.genericName || r.canonicalName)
    .filter(Boolean)
    .slice(0, limit);
  if (names.length === 0) return '';
  return `Indian clinical prescription dictation, English and Hindi mixed. Medicines: ${names.join(', ')}.`;
}
