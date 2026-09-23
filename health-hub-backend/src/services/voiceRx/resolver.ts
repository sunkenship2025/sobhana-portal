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
import { wordsToNumbers } from './normalize';

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
  /** CURATED · LEARNED · IMPORTED. A ranking signal, and a decision one. */
  source: string;
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
// Catalogue access — in Postgres, not in memory
//
// The first version loaded every row into a Map and matched there. That is
// correct and fast for a hand-written seed of 41, and an out-of-memory crash at
// 250,000 rows on a 512MB instance that has already been OOM-remediated once.
//
// So matching is now SQL against pg_trgm indexes. Each tier below is one indexed
// query that returns at most a handful of rows. The ladder, its ordering and its
// refusal to auto-pick are unchanged — only where the work happens moved.
// ---------------------------------------------------------------------------

const SELECT_COLS = `
  id, "canonicalName", "genericName", "brandName", strength, "strengthUnit",
  "dosageForm", route, aliases, "phoneticKey", "isScheduleX", "isNdps", "scheduleClass",
  source, "usageCount"
`;

type Raw = MedicationRow & { score?: number; source?: string; usageCount?: number };

/**
 * Where a row came from is a RANKING signal, and a strong one.
 *
 * The curated list is this clinic's actual formulary — a few hundred medicines
 * its doctors really prescribe. The 242,000-row import is the long tail, there
 * so that something unusual still resolves. Without this boost the tail drowns
 * the formulary: "dolo" returned "Dolo Drops" ahead of Dolo 650, and "augmentin
 * 625" went AMBIGUOUS across a dozen near-identical imported brands.
 *
 * LEARNED sits between them: a doctor here wrote it, so it beats an anonymous
 * import, but nobody has verified it so it does not beat the curated list.
 */
const SOURCE_BOOST: Record<string, number> = { CURATED: 0.15, LEARNED: 0.08, IMPORTED: 0 };
const boost = (r: Raw): number =>
  (SOURCE_BOOST[r.source ?? 'IMPORTED'] ?? 0) + Math.min(0.05, (Number(r.usageCount ?? 0)) * 0.005);

const WHERE_LIVE = `"isActive" = true AND "deletedAt" IS NULL`;

/**
 * Exact hit on any name or alias.
 *
 * The alias half is a word-boundary LIKE on the padded searchText rather than
 * `= ANY(unnest(aliases))`. The unnest version cannot use an index and cost
 * ~260ms across 242k rows while every other tier measured as free; this one
 * rides the GIN trigram index. Padding is why it works — searchText is stored
 * with a leading and trailing space so the first and last terms have boundaries.
 */
async function queryExact(needle: string, limit: number): Promise<Raw[]> {
  return prisma.$queryRawUnsafe<Raw[]>(
    `SELECT ${SELECT_COLS} FROM "Medication"
     WHERE ${WHERE_LIVE} AND (
       lower("canonicalName") = $1 OR lower("genericName") = $1 OR
       lower("brandName") = $1 OR "searchText" LIKE $2
     )
     ORDER BY "usageCount" DESC LIMIT $3`,
    needle, `% ${needle} %`, limit,
  );
}

/** Sound-alike, via the precomputed phonetic key. */
async function queryPhonetic(key: string, limit: number): Promise<Raw[]> {
  return prisma.$queryRawUnsafe<Raw[]>(
    `SELECT ${SELECT_COLS} FROM "Medication"
     WHERE ${WHERE_LIVE} AND "phoneticKey" = $1 LIMIT $2`,
    key, limit,
  );
}

/**
 * Fuzzy, by WORD similarity against searchText.
 *
 * `<%` / word_similarity, NOT `%` / similarity. searchText is a concatenation of
 * every name a row can be found by, so plain similarity() compares the needle
 * against the WHOLE string and dilutes to nothing: "augmentin" against a real
 * Augmentin row scores 0.169 — under the 0.3 threshold — while word_similarity
 * scores it 1.0. With `%` the fuzzy tier silently returned zero rows for every
 * query, which looked like "no typos found" rather than "the operator is wrong".
 *
 * `<%` uses the same GIN trigram index, so this is still an indexed lookup.
 */
async function queryFuzzy(needle: string, limit: number): Promise<Raw[]> {
  return prisma.$queryRawUnsafe<Raw[]>(
    `SELECT ${SELECT_COLS}, word_similarity($1, "searchText") AS score
     FROM "Medication"
     WHERE ${WHERE_LIVE} AND $1 <% "searchText"
     ORDER BY score DESC, "usageCount" DESC LIMIT $2`,
    needle, limit,
  );
}

/**
 * Typeahead — WORD-START anchored, not unanchored substring.
 *
 * `searchText LIKE '%amox%'` made the planner choose a Seq Scan over 242,000
 * rows: it estimates a lot of matches, so the index looks unprofitable, and it
 * only came back in 4ms because LIMIT 12 found twelve early. For a term whose
 * matches sit late in the table that is a full scan.
 *
 * `LIKE '% amox%'` — note the space — is anchored to a word start. It is far more
 * selective, so the planner uses the GIN trigram index, AND it is what a
 * typeahead should do anyway: typing "amox" wants Amoxicillin, not Cefamoxin.
 *
 * Under three characters there are no trigrams to index, so short queries hit
 * the btree prefix indexes on the name columns instead of touching searchText.
 */
async function queryLike(needle: string, limit: number): Promise<Candidate[]> {
  // Ordered by match quality, then by how often THIS clinic has prescribed it.
  // A 250,000-row catalogue against a forty-drug reality: without the usage tiebreak
  // the picker surfaces the long tail ahead of what the doctor actually writes.
  // TWO BRANCHES, EACH ABLE TO STOP EARLY.
  //
  // A single query with `ORDER BY CASE source ...` cost 103-261ms: the sort must
  // find EVERY match before it can take twelve, so LIMIT stops terminating the
  // scan early and a common prefix like "amox" walks thousands of rows.
  //
  // The two populations are nothing alike, so query them separately. CURATED is a
  // few hundred rows — a human-chosen formulary — so it can be searched
  // exhaustively for nothing. IMPORTED is the 242,000-row tail, which needs no
  // ranking beyond "matched", and its LIMIT then terminates the scan early.
  // Merged in JS, which is free at these sizes.
  const pattern = needle.length < 3 ? `${needle}%` : `% ${needle}%`;
  const col = needle.length < 3 ? 'lower("brandName")' : '"searchText"';

  const [curated, rest] = await Promise.all([
    prisma.$queryRawUnsafe<Raw[]>(
      `SELECT ${SELECT_COLS},
         CASE WHEN lower("brandName") = $1 OR lower("canonicalName") = $1 THEN 1.0
              WHEN lower("brandName") LIKE $2 THEN 0.9 ELSE 0.7 END AS score
       FROM "Medication"
       WHERE ${WHERE_LIVE} AND source <> 'IMPORTED' AND ${col} LIKE $3
       ORDER BY score DESC, "usageCount" DESC LIMIT $4`,
      needle, `${needle}%`, pattern, limit,
    ),
    prisma.$queryRawUnsafe<Raw[]>(
      // No ORDER BY on purpose — this is the branch that must stop early.
      `SELECT ${SELECT_COLS}, 0.5::float8 AS score
       FROM "Medication"
       WHERE ${WHERE_LIVE} AND source = 'IMPORTED' AND ${col} LIKE $1
       LIMIT $2`,
      pattern, limit * 3,
    ),
  ]);

  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const r of curated) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(toCandidate(r, Number(r.score ?? 0.7), 'exact'));
  }
  // Shortest name first: "Dolo 650 Tablet" before "Dolo 650 Plus Kit".
  const tail = rest
    .filter((r) => !seen.has(r.id))
    .sort((a, b) => a.canonicalName.length - b.canonicalName.length)
    .slice(0, Math.max(0, limit - out.length));
  for (const r of tail) out.push(toCandidate(r, 0.5, 'exact'));

  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const toCandidate = (r: Raw, score: number, matchedOn: Candidate['matchedOn']): Candidate => ({
  medicationId: r.id,
  canonicalName: r.canonicalName,
  genericName: r.genericName,
  brandName: r.brandName,
  strength: r.strength,
  strengthUnit: r.strengthUnit,
  dosageForm: r.dosageForm,
  route: r.route,
  // Curated rows and drugs this clinic actually uses rank above the long tail.
  score: Math.min(1, score + boost(r)),
  matchedOn,
  source: r.source ?? 'IMPORTED',
});

/**
 * Narrow by a spoken strength.
 *
 * "Augmentin 625" should not stay ambiguous between the 625 tablet and the 457
 * syrup when the doctor SAID 625. But a strength matching nothing never empties
 * the list — an unmatched strength means our catalogue is incomplete, not that
 * the doctor is wrong.
 */
function narrowByStrength(cands: Candidate[], strength: string | null): Candidate[] {
  if (!strength) return cands;
  const want = strength.replace(/[^0-9]/g, '');
  if (!want) return cands;
  const hit = cands.filter((c) => (c.strength ?? '').replace(/[^0-9]/g, '') === want);
  return hit.length > 0 ? hit : cands;
}

/** Same rule for dosage form: only when it actually discriminates. */
function narrowByForm(cands: Candidate[], form: string | null): Candidate[] {
  if (!form) return cands;
  const want = norm(form);
  const hit = cands.filter((c) => norm(c.dosageForm ?? '') === want);
  return hit.length > 0 ? hit : cands;
}

const MAX_CANDIDATES = 5;
/** A fuzzy hit below this is noise, not a near-miss worth showing. Tuned for Dice. */
const FUZZY_FLOOR = 0.5;
/** This strong, and clear of the runner-up, resolves on its own. */
const FUZZY_CONFIDENT = 0.82;
const FUZZY_MARGIN = 0.12;

export interface ResolveInput {
  /** What the doctor said or typed, e.g. "augmentin 625". */
  spoken: string;
  strength?: string | null;
  dosageForm?: string | null;
}

/**
 * All four matching tiers in ONE query.
 *
 * The ladder used to be four sequential round trips — exact, stem, phonetic,
 * fuzzy — each waiting on the last. Co-located with the database that is ~4ms
 * and nobody notices; it is still four times the latency of one, and over any
 * real network it is the difference between instant and sluggish.
 *
 * The tiers keep their exact meaning and precedence: the caller takes the LOWEST
 * tier that returned anything, which is precisely what stopping at the first
 * decisive tier did before.
 */
async function queryAllTiers(needle: string, stem: string, pkey: string, limit = 40): Promise<(Raw & { tier: number })[]> {
  return prisma.$queryRawUnsafe<(Raw & { tier: number })[]>(
    `SELECT * FROM (
       SELECT ${SELECT_COLS}, 1 AS tier, 1.0::float8 AS score
       FROM "Medication"
       WHERE ${WHERE_LIVE} AND (lower("canonicalName") = $1 OR lower("genericName") = $1
             OR lower("brandName") = $1 OR "searchText" LIKE $2)
       LIMIT 40
     ) t1
     UNION ALL SELECT * FROM (
       SELECT ${SELECT_COLS}, 2 AS tier, 0.98::float8 AS score
       FROM "Medication"
       WHERE $3 <> $1 AND ${WHERE_LIVE} AND (lower("canonicalName") = $3 OR lower("genericName") = $3
             OR lower("brandName") = $3 OR "searchText" LIKE $4)
       LIMIT 40
     ) t2
     UNION ALL SELECT * FROM (
       SELECT ${SELECT_COLS}, 3 AS tier, 0.9::float8 AS score
       FROM "Medication"
       WHERE $5 <> '' AND ${WHERE_LIVE} AND "phoneticKey" = $5
       LIMIT 40
     ) t3
     UNION ALL SELECT * FROM (
       SELECT ${SELECT_COLS}, 4 AS tier, word_similarity($3, "searchText")::float8 AS score
       FROM "Medication"
       WHERE ${WHERE_LIVE} AND $3 <% "searchText"
       LIMIT 40
     ) t4`,
    needle, `% ${needle} %`, stem, `% ${stem} %`, pkey,
  );
}

export async function resolveMedication(input: ResolveInput): Promise<ResolveResult> {
  // Number words first: the extractor normalises before calling, but a doctor
  // typing "dolo six fifty" or any other caller reaching this directly must get
  // the same answer. "Six fifty" is 650 everywhere or the system is inconsistent
  // about the one thing it cannot be inconsistent about.
  const q = norm(wordsToNumbers(input.spoken));
  if (!q) return { resolution: 'UNRESOLVED', match: null, candidates: [] };

  // The spoken token usually carries the strength: "augmentin 625", "pantop 40".
  // Pull it out UP FRONT so every tier narrows by it consistently — doing this
  // per-tier once let the alias path decide AMBIGUOUS across {5 mg, 10 mg} and
  // only then narrow the displayed list to one, which reads as "confirm which"
  // beside a single option.
  const strengthMatch = q.match(/^(.*?)\s*(\d+(?:\s*\+\s*\d+)?)\s*(?:mg|mcg|ml|g|iu)?$/);
  const stem = strengthMatch ? strengthMatch[1].trim() : q;
  const spokenStrength = input.strength ?? (strengthMatch ? strengthMatch[2].replace(/\s+/g, '') : null);

  const dedupe = (cs: Candidate[]): Candidate[] => {
    const seen = new Set<string>();
    return cs.filter((c) => (seen.has(c.medicationId) ? false : (seen.add(c.medicationId), true)));
  };

  const decide = (cands: Candidate[]): ResolveResult | null => {
    let narrowed = narrowByForm(narrowByStrength(dedupe(cands), spokenStrength), input.dosageForm ?? null);
    const rank = (c: Candidate) => (c.source === 'CURATED' ? 0 : c.source === 'LEARNED' ? 1 : 2);
    narrowed = narrowed.sort((a, b) => rank(a) - rank(b) || b.score - a.score).slice(0, MAX_CANDIDATES);
    if (narrowed.length === 0) return null;
    if (narrowed.length === 1) return { resolution: 'RESOLVED', match: narrowed[0], candidates: narrowed };

    // Exactly one curated row in the running: that is the clinic's formulary
    // answering. Asking the doctor to choose between it and a dozen
    // near-identical imported brands is noise dressed as caution — and noise is
    // what trains people to click through the questions that matter.
    const curated = narrowed.filter((c) => c.source === 'CURATED');
    if (curated.length === 1) return { resolution: 'RESOLVED', match: curated[0], candidates: narrowed };

    if (narrowed[0].score >= FUZZY_CONFIDENT && narrowed[0].score - narrowed[1].score >= FUZZY_MARGIN) {
      return { resolution: 'RESOLVED', match: narrowed[0], candidates: narrowed };
    }
    return { resolution: 'AMBIGUOUS', match: null, candidates: narrowed };
  };

  const pk = phoneticKey(stem);
  const rows = await queryAllTiers(q, stem, pk);

  const MATCHED_ON: Record<number, Candidate['matchedOn']> = { 1: 'exact', 2: 'alias', 3: 'phonetic', 4: 'fuzzy' };
  for (const tier of [1, 2, 3, 4]) {
    const inTier = rows.filter((r) => Number(r.tier) === tier);
    if (inTier.length === 0) continue;

    let cands = inTier.map((r) => toCandidate(r, Number(r.score ?? 0), MATCHED_ON[tier]));
    // The fuzzy tier alone has a quality floor — the others are literal matches.
    if (tier === 4) cands = cands.filter((c) => c.score >= FUZZY_FLOOR);
    if (cands.length === 0) continue;

    const d = decide(cands);
    if (d) return d;
  }

  return { resolution: 'UNRESOLVED', match: null, candidates: [] };
}

export async function searchMedications(q: string, limit = 12): Promise<Candidate[]> {
  const needle = norm(q);
  if (needle.length < 2) return [];

  const literal = await queryLike(needle, limit);
  if (literal.length >= limit || needle.length < 3) return literal;

  // Top up with typo-tolerant hits, always BELOW every literal match.
  const fuzzy = await queryFuzzy(needle, limit - literal.length + 5);
  const seen = new Set(literal.map((c) => c.medicationId));
  for (const r of fuzzy) {
    if (seen.has(r.id)) continue;
    literal.push(toCandidate(r, Number(r.score ?? 0) * 0.3, 'fuzzy'));
    if (literal.length >= limit) break;
  }
  return literal;
}

/** Look up rows by id — used by the validator for the Schedule X / NDPS gate. */
export async function getMedicationsByIds(ids: string[]): Promise<Map<string, MedicationRow>> {
  if (ids.length === 0) return new Map();
  const rows = (await prisma.medication.findMany({
    where: { id: { in: ids } },
    select: {
      id: true, canonicalName: true, genericName: true, brandName: true,
      strength: true, strengthUnit: true, dosageForm: true, route: true,
      aliases: true, phoneticKey: true, isScheduleX: true, isNdps: true, scheduleClass: true,
    },
  })) as MedicationRow[];
  return new Map(rows.map((r) => [r.id, r]));
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
  // The most common brands, not a slice of whatever the catalogue returns first.
  // A hint that is mostly long-tail names biases nothing; one full of the drugs
  // this clinic actually prescribes is the cheapest accuracy gain available.
  const rows = await prisma.medication.findMany({
    where: { isActive: true, deletedAt: null, brandName: { not: null } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    select: { brandName: true, genericName: true, canonicalName: true },
  });
  const names = rows.map((r) => r.brandName || r.genericName || r.canonicalName).filter(Boolean);
  if (names.length === 0) return '';
  return `Indian clinical prescription dictation, English and Hindi mixed. Medicines: ${names.join(', ')}.`;
}
