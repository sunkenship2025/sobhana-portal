/**
 * Three resolution architectures, benchmarked against each other.
 *
 *   npx tsx resolver-strategies.ts
 *
 * Text in, medicine out. No ASR, so this costs nothing and can be run on every
 * change — it isolates the RESOLVER from the microphone, which is the only way
 * to tell a mis-hearing apart from a mis-resolution.
 *
 * THE THREE
 *   A  tiered      — exact / alias / phonetic / fuzzy, first decisive tier wins,
 *                    then clinical preferences. What ships today.
 *   B  scored      — one pass, every candidate scored on several weighted
 *                    signals, top wins if it clears the runner-up. No tiers.
 *   C  formulary   — search the ~240-row CURATED formulary first and stop if it
 *                    answers; fall through to the 242k tail only when it cannot.
 *
 * C is the one worth taking seriously on principle: a clinic prescribes a couple
 * of hundred medicines, and the import exists for the unusual case. If C matches
 * A it is the better architecture, because it is smaller and its failure mode is
 * "asks about something rare" rather than "picks a lookalike from the tail".
 */
import prisma from './src/lib/prisma';
import { resolveMedication, norm, phoneticKey, similarity, type Candidate, type ResolveResult } from './src/services/voiceRx/resolver';
import { wordsToNumbers } from './src/services/voiceRx/normalize';

const SELECT = `
  id, "canonicalName", "genericName", "brandName", strength, "strengthUnit",
  "dosageForm", route, aliases, "phoneticKey", "isScheduleX", "isNdps",
  "scheduleClass", source, "usageCount"
`;
const LIVE = `"isActive" = true AND "deletedAt" IS NULL`;

type Row = any;

const toCand = (r: Row, score: number, via: Candidate['matchedOn']): Candidate => ({
  medicationId: r.id, canonicalName: r.canonicalName, genericName: r.genericName,
  brandName: r.brandName, strength: r.strength, strengthUnit: r.strengthUnit,
  dosageForm: r.dosageForm, route: r.route, score, matchedOn: via,
  source: r.source ?? 'IMPORTED',
});

function splitStrength(raw: string): { stem: string; strength: string | null } {
  // Number words FIRST, in every strategy. Strategy A does this inside
  // resolveMedication, so without it here the comparison would credit A for a
  // harness difference rather than an architectural one.
  const q = wordsToNumbers(raw);
  const m = norm(q).match(/^(.*?)\s*(\d+(?:\s*\+\s*\d+)?)\s*(?:mg|mcg|ml|g|iu)?$/);
  return m ? { stem: m[1].trim(), strength: m[2].replace(/\s+/g, '') } : { stem: norm(q), strength: null };
}

const digits = (s: string | null) => (s ?? '').replace(/[^0-9]/g, '');
const molecules = (c: Candidate) => ((c.genericName ?? c.canonicalName).match(/\+/g) ?? []).length;

// ---------------------------------------------------------------------------
// B — one scored pass
// ---------------------------------------------------------------------------

/**
 * No tiers. Pull a candidate pool once, then score every row on signals that are
 * each independently defensible, and resolve only when the winner is clear.
 *
 * The appeal is that a tier ordering is an implicit, unexaminable weighting;
 * here the weights are visible and tunable. The risk is that a weighted sum can
 * let three weak signals outvote one strong one — which is exactly what we must
 * not do with drug identity.
 */
async function resolveScored(spoken: string, strengthIn?: string | null): Promise<ResolveResult> {
  const { stem, strength: parsed } = splitStrength(spoken);
  const strength = strengthIn ?? parsed;
  const q = norm(wordsToNumbers(spoken));
  const pk = phoneticKey(stem);

  const rows: Row[] = await prisma.$queryRawUnsafe(
    `SELECT * FROM (
       SELECT ${SELECT} FROM "Medication"
       WHERE ${LIVE} AND (lower("canonicalName") = $1 OR lower("brandName") = $1
             OR lower("genericName") = $1 OR "searchText" LIKE $2 OR "searchText" LIKE $3)
       ORDER BY CASE source WHEN 'CURATED' THEN 0 WHEN 'LEARNED' THEN 1 ELSE 2 END,
                "usageCount" DESC, length("canonicalName") ASC
       LIMIT 60
     ) a
     UNION ALL SELECT * FROM (
       SELECT ${SELECT} FROM "Medication"
       WHERE ${LIVE} AND ("phoneticKey" = $4 OR $5 <% "searchText")
       ORDER BY CASE source WHEN 'CURATED' THEN 0 WHEN 'LEARNED' THEN 1 ELSE 2 END,
                "usageCount" DESC
       LIMIT 40
     ) b`,
    q, `% ${q} %`, `% ${stem} %`, pk, stem,
  );

  const seen = new Set<string>();
  const scored = rows.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true))).map((r) => {
    const c = toCand(r, 0, 'fuzzy');
    let s = 0;
    const names = [r.canonicalName, r.brandName, r.genericName, ...(r.aliases ?? [])].filter(Boolean).map((x: string) => norm(x));
    // name match: the dominant signal, deliberately
    if (names.includes(q)) s += 50;
    else if (names.includes(stem)) s += 42;
    else if (names.some((n: string) => n.startsWith(stem))) s += 30;
    else if (r.phoneticKey === pk) s += 26;
    else s += Math.round(Math.max(...names.map((n: string) => similarity(stem, n))) * 24);
    // provenance: the clinic's own formulary over an anonymous import
    s += r.source === 'CURATED' ? 22 : r.source === 'LEARNED' ? 10 : 0;
    // strength agreement
    if (strength && digits(r.strength) === digits(strength)) s += 14;
    // simplest product, unless a combination was named
    if (!/\+|\bplus\b|\bd\b|\bsr\b|\bcv\b/i.test(q)) s -= molecules(c) * 6;
    // oral solid, absent a spoken form
    if (['tablet', 'capsule'].includes((r.dosageForm ?? '').toLowerCase())) s += 4;
    s += Math.min(6, Number(r.usageCount ?? 0));
    return { ...c, score: s / 100 };
  }).sort((a, b) => b.score - a.score);

  if (scored.length === 0) return { resolution: 'UNRESOLVED', match: null, candidates: [] };
  const top = scored.slice(0, 5);
  // Resolve only on a clear win. A narrow margin on drug identity is a question.
  if (top.length === 1 || top[0].score - top[1].score >= 0.10) {
    return { resolution: 'RESOLVED', match: top[0], candidates: top };
  }
  if (top[0].score < 0.35) return { resolution: 'UNRESOLVED', match: null, candidates: top };
  return { resolution: 'AMBIGUOUS', match: null, candidates: top };
}

// ---------------------------------------------------------------------------
// C — formulary first, tail as fallback
// ---------------------------------------------------------------------------

/**
 * Ask the clinic's own formulary first. It is ~240 rows, so it can be searched
 * exhaustively and ranked properly for nothing, and it covers the overwhelming
 * majority of what any clinic actually prescribes.
 *
 * Only when the formulary genuinely has no answer does the 242,000-row tail get
 * consulted — and there, an unconfident match ASKS rather than guessing, because
 * a lookalike from the long tail is precisely the wrong-drug failure mode.
 */
async function resolveFormularyFirst(spoken: string, strengthIn?: string | null): Promise<ResolveResult> {
  const { stem, strength: parsed } = splitStrength(spoken);
  const strength = strengthIn ?? parsed;
  const q = norm(wordsToNumbers(spoken));
  const pk = phoneticKey(stem);

  const pick = (rows: Row[], via: Candidate['matchedOn']): ResolveResult | null => {
    if (rows.length === 0) return null;
    let cands = rows.map((r) => toCand(r, 1, via));
    if (strength) {
      const hit = cands.filter((c) => digits(c.strength) === digits(strength));
      if (hit.length) cands = hit;
    }
    if (!/\+|\bplus\b|\bd\b|\bsr\b|\bcv\b/i.test(q)) {
      const fewest = Math.min(...cands.map(molecules));
      cands = cands.filter((c) => molecules(c) === fewest);
    }
    const solid = cands.filter((c) => ['tablet', 'capsule'].includes((c.dosageForm ?? '').toLowerCase()));
    if (solid.length) cands = solid;
    if (cands.length === 1) return { resolution: 'RESOLVED', match: cands[0], candidates: cands };
    return cands.length ? { resolution: 'AMBIGUOUS', match: null, candidates: cands.slice(0, 5) } : null;
  };

  // Stage 1 — the formulary, exhaustively.
  const curated: Row[] = await prisma.$queryRawUnsafe(
    `SELECT ${SELECT} FROM "Medication"
     WHERE ${LIVE} AND source <> 'IMPORTED'
       AND (lower("canonicalName") = $1 OR lower("brandName") = $1 OR lower("genericName") = $1
            OR "searchText" LIKE $2 OR "searchText" LIKE $3 OR "phoneticKey" = $4)
     ORDER BY "usageCount" DESC LIMIT 20`,
    q, `% ${q} %`, `% ${stem} %`, pk,
  );
  const fromCurated = pick(curated, 'exact');
  if (fromCurated) return fromCurated;

  // Stage 2 — the tail, only now.
  const tail: Row[] = await prisma.$queryRawUnsafe(
    `SELECT ${SELECT} FROM "Medication"
     WHERE ${LIVE} AND (lower("brandName") = $1 OR lower("canonicalName") = $1
           OR "searchText" LIKE $2 OR "phoneticKey" = $3)
     ORDER BY "usageCount" DESC, length("canonicalName") ASC LIMIT 25`,
    q, `% ${stem} %`, pk,
  );
  return pick(tail, 'alias') ?? { resolution: 'UNRESOLVED', match: null, candidates: [] };
}

// ---------------------------------------------------------------------------
// Bench
// ---------------------------------------------------------------------------

/** [spoken, expected substring | null for "must not resolve"] */
const CASES: [string, string | null][] = [
  ['Amlodipine 5', 'Amlodipine'], ['amlodipine five', 'Amlodipine'],
  ['Metformin 500', 'Metformin'], ['Glycomet 500', 'Metformin'],
  ['Pantoprazole 40', 'Pantoprazole'], ['Pantop 40', 'Pantoprazole'],
  ['Pan top 40', 'Pantop'], ['Cetirizine 10', 'Cetirizine'],
  ['Azithromycin 500', 'Azithromycin'], ['Azithral 500', 'Azithromycin'],
  ['as it real 500', 'Azithromycin'], ['Paracetamol 650', 'Paracetamol'],
  ['Dolo 650', 'Paracetamol'], ['dolo six fifty', 'Paracetamol'],
  ['Augmentin 625', 'Clavulanic'], ['augmentin six twenty five', 'Clavulanic'],
  ['agumentin 625', 'Clavulanic'], ['amoxi clav', 'Clavulanic'],
  ['Telma 40', 'Telmisartan'], ['Zerodol P', 'Aceclofenac'],
  ['Montek LC', 'Montelukast'], ['Shelcal', 'Calcium'],
  ['Ciplox 500', 'Ciprofloxacin'], ['Emeset 4', 'Ondansetron'],
  ['Taxim O 200', 'Cefixime'], ['Zifi 200', 'Cefixime'],
  ['Alprax 0.5', 'Alprazolam'], ['Tramadol 50', 'Tramadol'],
  ['Levocetirizine 5', 'Levocetirizine'], ['Atorvastatin 10', 'Atorvastatin'],
  ['Telmisartan 40', 'Telmisartan'], ['Ondansetron 4', 'Ondansetron'],
  ['Metronidazole 400', 'Metronidazole'], ['Domperidone 10', 'Domperidone'],
  ['zibblewotsit 200', null], ['plenty of fluids and rest', null],
  ['qwerty unknown brand', null],
];

(async () => {
  const strategies: [string, (s: string) => Promise<ResolveResult>][] = [
    ['A tiered (ships)', (s) => resolveMedication({ spoken: s })],
    ['B scored', (s) => resolveScored(s)],
    ['C formulary-first', (s) => resolveFormularyFirst(s)],
  ];

  const results: Record<string, { right: number; wrong: number; asked: number; missed: number; ms: number; bad: string[] }> = {};

  for (const [name, fn] of strategies) {
    const r = { right: 0, wrong: 0, asked: 0, missed: 0, ms: 0, bad: [] as string[] };
    for (const [spoken, want] of CASES) {
      const t0 = Date.now();
      const out = await fn(spoken);
      r.ms += Date.now() - t0;
      const got = out.match?.canonicalName ?? '';
      const ok = want === null
        ? out.resolution !== 'RESOLVED'
        : norm(got).includes(norm(want));

      if (ok) r.right++;
      else if (out.resolution === 'RESOLVED') { r.wrong++; r.bad.push(`WRONG  "${spoken}" -> ${got}`); }
      else if (out.resolution === 'AMBIGUOUS') { r.asked++; r.bad.push(`ASKED  "${spoken}" -> ${out.candidates.slice(0,2).map(c=>c.canonicalName).join(' | ')}`); }
      else { r.missed++; r.bad.push(`MISSED "${spoken}"`); }
    }
    results[name] = r;
  }

  const n = CASES.length;
  console.log(`${n} cases, text only (no ASR)\n`);
  console.log('STRATEGY'.padEnd(20) + 'RIGHT'.padEnd(8) + 'WRONG'.padEnd(8) + 'ASKED'.padEnd(8) + 'MISSED'.padEnd(8) + 'ms/case');
  for (const [name, r] of Object.entries(results)) {
    console.log(
      name.padEnd(20) +
      `${r.right}/${n}`.padEnd(8) +
      String(r.wrong).padEnd(8) +
      String(r.asked).padEnd(8) +
      String(r.missed).padEnd(8) +
      Math.round(r.ms / n),
    );
  }
  console.log('\nWRONG is the only column that can hurt a patient. ASKED costs a click.');
  for (const [name, r] of Object.entries(results)) {
    if (!r.bad.length) continue;
    console.log(`\n${name}:`);
    for (const b of r.bad.slice(0, 8)) console.log(`   ${b}`);
  }
  await prisma.$disconnect();
})();
