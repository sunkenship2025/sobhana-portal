/**
 * Bulk import of the Indian medicine catalogue (~254k brand rows).
 *
 * Usage:
 *   npx tsx prisma/import-indian-medicines.ts <path-to-csv> [--limit N] [--dry]
 *
 * PROVENANCE — READ THIS BEFORE SHIPPING COMMERCIALLY
 * The CSV is the widely-reposted `indian_medicine_data` set (GitHub
 * junioralive/Indian-Medicine-Dataset, also on Kaggle under several names). The
 * repository carries an MIT licence, but that is the UPLOADER'S tag: the
 * underlying rows are a scrape of a commercial pharmacy site, and an uploader
 * cannot licence data they did not own. India publishes no open brand-level drug
 * registry — NLEM is a molecule-only PDF, CDSCO has no queryable formulary,
 * NPPA covers 540 price-controlled formulations, and RxNorm carries no Indian
 * brands — so there is no clean alternative at this scale. That is a commercial
 * and legal judgement for the product owner, not a technical one.
 *
 * WHAT THIS IMPORT IS FOR, AND WHAT IT IS NOT
 * It makes typing and dictation resolve across the long tail. It is NOT a safety
 * boundary: controlled-substance blocking reads the raw TEXT (controlled.ts), so
 * an unseeded narcotic still blocks, and anything absent is still prescribable as
 * free text. A bigger catalogue makes the product faster, never safer.
 *
 * The curated rows seeded by seed-medications.ts are preserved untouched — they
 * carry clinic shorthand and known ASR mishearings that no scrape contains.
 */
import { readFileSync } from 'fs';
import { PrismaClient, Prisma } from '@prisma/client';
import { phoneticKey } from '../src/services/voiceRx/resolver';
import { screenControlled } from '../src/services/voiceRx/controlled';

const prisma = new PrismaClient();

const FORMS: [RegExp, string][] = [
  [/\btablets?\b/i, 'tablet'], [/\bcapsules?\b/i, 'capsule'],
  [/\bsyrup\b/i, 'syrup'], [/\bsuspension\b/i, 'suspension'],
  [/\binjection\b/i, 'injection'], [/\bcreams?\b/i, 'cream'],
  [/\bointment\b/i, 'ointment'], [/\bgel\b/i, 'gel'], [/\blotion\b/i, 'lotion'],
  [/\bdrops?\b/i, 'drops'], [/\bsolution\b/i, 'solution'], [/\bpowder\b/i, 'powder'],
  [/\bsachet\b/i, 'sachet'], [/\binhaler\b/i, 'inhaler'], [/\brespules?\b/i, 'respules'],
  [/\bshampoo\b/i, 'shampoo'], [/\bsoap\b/i, 'soap'], [/\bspray\b/i, 'spray'],
  [/\bpessar(y|ies)\b/i, 'pessary'], [/\bgranules?\b/i, 'granules'],
  [/\bkit\b/i, 'kit'], [/\bpatch\b/i, 'patch'],
];

const ROUTE: Record<string, string> = {
  tablet: 'oral', capsule: 'oral', syrup: 'oral', suspension: 'oral', sachet: 'oral',
  powder: 'oral', solution: 'oral', granules: 'oral',
  cream: 'topical', ointment: 'topical', gel: 'topical', lotion: 'topical',
  shampoo: 'topical', soap: 'topical', spray: 'topical', patch: 'topical',
  injection: 'IV', inhaler: 'inhalation', respules: 'inhalation', pessary: 'vaginal',
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9+ ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Split a CSV line honouring quoted fields. */
function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === ',' && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** "Amoxycillin  (500mg) " -> { molecule, strength, unit } */
function parseComposition(raw: string): { molecule: string; strength: string | null; unit: string | null } | null {
  const t = (raw ?? '').trim();
  if (!t) return null;
  const m = t.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  const molecule = (m ? m[1] : t).trim().replace(/\s+/g, ' ');
  if (!molecule) return null;
  let strength: string | null = null;
  let unit: string | null = null;
  if (m) {
    const s = m[2].match(/([\d.]+)\s*(mg|mcg|g|ml|iu|%|w\/w|w\/v)?/i);
    if (s) { strength = s[1]; unit = (s[2] ?? null)?.toLowerCase() === 'iu' ? 'IU' : (s[2] ?? null); }
  }
  return { molecule, strength, unit };
}

/** "Augmentin 625 Duo Tablet" -> "Augmentin 625 Duo" */
function brandStem(name: string): string {
  let s = name;
  for (const [re] of FORMS) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

function detectForm(name: string, pack: string): string | null {
  for (const [re, form] of FORMS) if (re.test(name)) return form;
  for (const [re, form] of FORMS) if (re.test(pack)) return form;
  return null;
}

interface Row {
  canonicalName: string; genericName: string | null; brandName: string | null;
  manufacturer: string | null; strength: string | null; strengthUnit: string | null;
  dosageForm: string | null; route: string | null; aliases: string[];
  phoneticKey: string; scheduleClass: string | null;
  isScheduleX: boolean; isNdps: boolean;
}

async function main() {
  const csvPath = process.argv[2];
  if (!csvPath) { console.error('usage: import-indian-medicines.ts <csv> [--limit N] [--dry]'); process.exit(1); }
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : Infinity;
  const dry = process.argv.includes('--dry');

  console.log('reading…');
  const lines = readFileSync(csvPath, 'utf8').split('\n');
  const header = splitCsv(lines[0]).map((h) => h.trim());
  const col = (n: string) => header.indexOf(n);
  const iName = col('name'), iDisc = col('Is_discontinued'), iMfr = col('manufacturer_name');
  const iType = col('type'), iPack = col('pack_size_label');
  const iC1 = col('short_composition1'), iC2 = col('short_composition2');

  // Anything already in the catalogue wins. The curated rows carry clinic
  // shorthand and ASR mishearings a scrape never will.
  const existing = new Set(
    (await prisma.medication.findMany({ select: { canonicalName: true } })).map((m) => norm(m.canonicalName)),
  );
  console.log(`${existing.size} rows already present — those names are preserved`);

  const seen = new Set<string>(existing);
  const batch: Row[] = [];
  let scanned = 0, skippedDisc = 0, skippedDupe = 0, skippedType = 0, inserted = 0, controlled = 0;

  const flush = async () => {
    if (batch.length === 0 || dry) { batch.length = 0; return; }
    await prisma.medication.createMany({
      data: batch.map((r) => ({ ...r, isActive: true })) as Prisma.MedicationCreateManyInput[],
      skipDuplicates: true,
    });
    inserted += batch.length;
    batch.length = 0;
    if (inserted % 20000 === 0) console.log(`   …${inserted.toLocaleString()} inserted`);
  };

  for (let i = 1; i < lines.length && scanned < limit; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const f = splitCsv(line);
    if (f.length < header.length) continue;
    scanned++;

    if ((f[iType] ?? '').trim().toLowerCase() !== 'allopathy') { skippedType++; continue; }
    if ((f[iDisc] ?? '').trim().toUpperCase() === 'TRUE') { skippedDisc++; continue; }

    const name = (f[iName] ?? '').trim();
    if (!name || name.length > 180) continue;

    const key = norm(name);
    if (!key || seen.has(key)) { skippedDupe++; continue; }
    seen.add(key);

    const c1 = parseComposition(f[iC1] ?? '');
    const c2 = parseComposition(f[iC2] ?? '');
    const molecules = [c1?.molecule, c2?.molecule].filter(Boolean) as string[];
    const generic = molecules.length ? molecules.join(' + ') : null;

    const form = detectForm(name, f[iPack] ?? '');
    const stem = brandStem(name);

    // Aliases: the brand without its form word, and each molecule alone.
    const aliases = new Set<string>();
    if (stem && norm(stem) !== key) aliases.add(stem);
    for (const m of molecules) if (m.length > 3) aliases.add(m);
    // The brand's first word is what a doctor usually says ("Augmentin").
    const firstWord = stem.split(' ')[0];
    if (firstWord && firstWord.length > 3) aliases.add(firstWord);

    const hits = screenControlled(`${name} ${generic ?? ''} ${[...aliases].join(' ')}`);
    const worst = hits.find((h) => h.entry.blockTelemedicine);
    if (worst) controlled++;

    batch.push({
      canonicalName: name,
      genericName: generic,
      brandName: stem || null,
      manufacturer: (f[iMfr] ?? '').trim() || null,
      strength: c1?.strength ?? null,
      strengthUnit: c1?.unit ?? null,
      dosageForm: form,
      route: form ? (ROUTE[form] ?? null) : null,
      aliases: [...aliases],
      phoneticKey: phoneticKey(firstWord || stem || name),
      scheduleClass: worst ? worst.entry.schedule : null,
      isScheduleX: !!worst?.entry.schedule.includes('X'),
      isNdps: !!worst?.entry.schedule.includes('NDPS'),
    });

    if (batch.length >= 2000) await flush();
  }
  await flush();

  const total = await prisma.medication.count({ where: { isActive: true, deletedAt: null } });
  console.log(`
scanned        ${scanned.toLocaleString()}
skipped: type  ${skippedType.toLocaleString()} (non-allopathy)
skipped: disc  ${skippedDisc.toLocaleString()} (discontinued)
skipped: dupe  ${skippedDupe.toLocaleString()} (same name already seen)
inserted       ${inserted.toLocaleString()}${dry ? '  (DRY RUN — nothing written)' : ''}
controlled     ${controlled.toLocaleString()} flagged by the text screen
catalogue now  ${total.toLocaleString()} active rows`);

  await prisma.$disconnect();
}

main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
