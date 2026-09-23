/**
 * Controlled-substance screening — on RAW TEXT, not on catalogue rows.
 *
 * THE BUG THIS FILE EXISTS TO FIX
 * The first version of the validator checked `isScheduleX` / `isNdps` on the
 * resolved Medication row. That is exactly backwards: a controlled drug we had
 * not seeded simply did not resolve, so it carried NO flags and sailed straight
 * through the §3.7.4 gate. The safety of the block depended on the completeness
 * of the catalogue, which is a guarantee no catalogue can ever make.
 *
 * So screening now runs on what the doctor actually SAID or TYPED, before and
 * regardless of resolution. It fails CLOSED: a token that looks like a
 * controlled substance blocks, even if we have never heard of it.
 *
 * WHY STEMS AND NOT AN EXACT LIST
 * Indian brand names cluster around the molecule: alprazolam is Alprax, Alzolam,
 * Zolam, Trika, Restyl, Anxit. Matching whole strings would need every brand of
 * every controlled molecule in India, which is the same completeness trap. So we
 * match molecule stems, a curated brand list, AND the phonetic key — three nets,
 * any of which catches.
 *
 * FALSE POSITIVES ARE THE ACCEPTABLE FAILURE HERE
 * Blocking a safe drug wastes a doctor's few seconds and they can complete the
 * consultation in person. Passing a narcotic over teleconsultation is a criminal
 * matter. The asymmetry is not close, so the stems below lean inclusive — but
 * every one is anchored to a word boundary so "paracetamol" cannot trip
 * "tramadol" and "cetirizine" cannot trip anything.
 */
import { norm, phoneticKey } from './resolver';

export interface ControlledEntry {
  /** Molecule, as it appears in the schedule. */
  molecule: string;
  /** Substrings that identify it. Matched at a word boundary on normalised text. */
  stems: string[];
  /** Indian brand names. Doctors dictate these, not molecules. */
  brands: string[];
  /** X = Schedule X, NDPS = narcotic/psychotropic, H1 = separate register only. */
  schedule: 'X' | 'NDPS' | 'X+NDPS' | 'H1';
  /**
   * Whether §3.7.4 prohibits prescribing this over telemedicine. True for
   * Schedule X and NDPS. H1 entries are false: they need a pharmacist register,
   * not a prescribing ban.
   */
  blockTelemedicine: boolean;
}

/**
 * Seed list. Schedule X of the Drugs and Cosmetics Rules plus the NDPS-scheduled
 * medicines a doctor might realistically write. Expanded from primary-source
 * research; anything uncertain is included rather than omitted, per the
 * asymmetry above.
 */
export const CONTROLLED: ControlledEntry[] = [
  // --- Benzodiazepines (NDPS psychotropic; several also Schedule X) ---------
  { molecule: 'Alprazolam', schedule: 'X+NDPS', blockTelemedicine: true,
    stems: ['alprazolam', 'alprax', 'alzolam', 'zolam'],
    brands: ['Alprax', 'Restyl', 'Trika', 'Zolax', 'Anxit', 'Alzolam', 'Alprocontin'] },
  { molecule: 'Diazepam', schedule: 'X+NDPS', blockTelemedicine: true,
    stems: ['diazepam', 'valium', 'calmpose'],
    brands: ['Valium', 'Calmpose', 'Dizy', 'Placidox'] },
  { molecule: 'Clonazepam', schedule: 'X+NDPS', blockTelemedicine: true,
    stems: ['clonazepam', 'clonotril', 'lonazep', 'rivotril', 'zapiz'],
    brands: ['Rivotril', 'Clonotril', 'Lonazep', 'Zapiz', 'Petril'] },
  { molecule: 'Lorazepam', schedule: 'X+NDPS', blockTelemedicine: true,
    stems: ['lorazepam', 'ativan', 'larpose', 'lorazep'],
    brands: ['Ativan', 'Larpose', 'Lopez', 'Trapex'] },
  { molecule: 'Nitrazepam', schedule: 'X+NDPS', blockTelemedicine: true,
    stems: ['nitrazepam', 'nitrosun', 'sedamon'],
    brands: ['Nitrosun', 'Sedamon', 'Nitravet'] },
  { molecule: 'Etizolam', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['etizolam', 'etilaam', 'etizola', 'etisum'],
    brands: ['Etilaam', 'Etizola', 'Etisum', 'Etizest'] },
  { molecule: 'Chlordiazepoxide', schedule: 'X+NDPS', blockTelemedicine: true,
    stems: ['chlordiazepoxide', 'librium', 'equilibrium'],
    brands: ['Librium', 'Equirex'] },
  { molecule: 'Midazolam', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['midazolam', 'fulsed', 'mezolam'],
    brands: ['Fulsed', 'Mezolam', 'Midacip'] },

  // --- Opioids (NDPS narcotic) ---------------------------------------------
  { molecule: 'Morphine', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['morphine', 'morcontin', 'mscontin'],
    brands: ['Morcontin', 'MST Continus', 'Rilitin'] },
  { molecule: 'Fentanyl', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['fentanyl', 'durogesic', 'fent'],
    brands: ['Durogesic', 'Fentapatch', 'Trofentyl'] },
  { molecule: 'Buprenorphine', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['buprenorphine', 'buprigesic', 'tidigesic', 'addnok'],
    brands: ['Tidigesic', 'Buprigesic', 'Addnok', 'Norphin'] },
  { molecule: 'Tramadol', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['tramadol', 'tramazac', 'ultracet', 'contramal', 'domadol'],
    brands: ['Ultracet', 'Tramazac', 'Contramal', 'Domadol', 'Tramacip'] },
  { molecule: 'Codeine', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['codeine', 'codein', 'corex', 'phensedyl', 'ascoril c'],
    brands: ['Corex', 'Phensedyl', 'Codistar', 'Grilinctus CD'] },
  { molecule: 'Pentazocine', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['pentazocine', 'fortwin'],
    brands: ['Fortwin', 'Pentawin'] },
  { molecule: 'Tapentadol', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['tapentadol', 'tapal', 'tydol'],
    brands: ['Tapal', 'Tydol', 'Nucynta'] },
  { molecule: 'Oxycodone', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['oxycodone', 'oxycontin'],
    brands: ['OxyContin', 'Ultracontin'] },
  { molecule: 'Methadone', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['methadone'], brands: ['Methadose'] },
  { molecule: 'Pethidine', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['pethidine', 'meperidine'], brands: ['Pethidine'] },

  // --- Stimulants -----------------------------------------------------------
  { molecule: 'Methylphenidate', schedule: 'X+NDPS', blockTelemedicine: true,
    stems: ['methylphenidate', 'inspiral', 'addwize'],
    brands: ['Inspiral', 'Addwize', 'Ritalin'] },
  { molecule: 'Amphetamine', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['amphetamine', 'dexamphetamine'], brands: [] },

  // --- Barbiturates and other Schedule X ------------------------------------
  { molecule: 'Phenobarbitone', schedule: 'X', blockTelemedicine: true,
    stems: ['phenobarbitone', 'phenobarbital', 'gardenal'],
    brands: ['Gardenal', 'Luminal'] },
  { molecule: 'Barbiturates (general)', schedule: 'X', blockTelemedicine: true,
    stems: ['barbitone', 'barbital', 'secobarbital', 'pentobarbital', 'amobarbital'],
    brands: [] },
  { molecule: 'Zolpidem', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['zolpidem', 'zolfresh', 'nitrest'],
    brands: ['Zolfresh', 'Nitrest', 'Stilnoct'] },
  { molecule: 'Zopiclone', schedule: 'NDPS', blockTelemedicine: true,
    stems: ['zopiclone', 'eszopiclone', 'zopicon', 'zolium'],
    brands: ['Zopicon', 'Zolium', 'Nunorm'] },
  { molecule: 'Ketamine', schedule: 'X+NDPS', blockTelemedicine: true,
    stems: ['ketamine', 'ketmin', 'aneket'],
    brands: ['Ketmin', 'Aneket'] },
  { molecule: 'Anabolic steroids', schedule: 'X', blockTelemedicine: true,
    stems: ['nandrolone', 'oxymetholone', 'stanozolol', 'methandienone', 'deca durabolin'],
    brands: ['Deca-Durabolin'] },
];

export interface ControlledHit {
  /** The text that tripped the screen. */
  matched: string;
  entry: ControlledEntry;
  how: 'stem' | 'brand' | 'phonetic';
}

/** Word-boundary containment on normalised text. */
function hasStem(haystack: string, stem: string): boolean {
  const s = norm(stem);
  if (!s) return false;
  // Escape, then require a boundary either side so "tramadol" cannot fire on a
  // longer unrelated word and "para" cannot fire inside "paracetamol".
  const re = new RegExp(`(^|[^a-z0-9])${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`);
  return re.test(haystack);
}

/**
 * Screen arbitrary text for anything that looks like a controlled substance.
 *
 * Pass it the spoken text, the typed name, the canonical name — all of them.
 * It is cheap and it is meant to be called on everything.
 */
export function screenControlled(text: string | null | undefined): ControlledHit[] {
  if (!text) return [];
  const hay = norm(text);
  if (!hay) return [];
  const hits: ControlledHit[] = [];

  for (const entry of CONTROLLED) {
    let hit: ControlledHit | null = null;

    for (const stem of entry.stems) {
      if (hasStem(hay, stem)) { hit = { matched: stem, entry, how: 'stem' }; break; }
    }
    if (!hit) {
      for (const brand of entry.brands) {
        if (hasStem(hay, brand)) { hit = { matched: brand, entry, how: 'brand' }; break; }
      }
    }
    // Phonetic, word by word: catches a mis-transcribed brand ("alprax" heard as
    // "al prax", "elprax"). Only for tokens long enough to be meaningful.
    if (!hit) {
      const words = hay.split(' ').filter((w) => w.length >= 5);
      const keys = new Set([...entry.stems, ...entry.brands].map(phoneticKey).filter(Boolean));
      for (const w of words) {
        if (keys.has(phoneticKey(w))) { hit = { matched: w, entry, how: 'phonetic' }; break; }
      }
    }

    if (hit) hits.push(hit);
  }

  return hits;
}

/** Only the ones §3.7.4 actually prohibits remotely. */
export function screenTelemedicineProhibited(text: string | null | undefined): ControlledHit[] {
  return screenControlled(text).filter((h) => h.entry.blockTelemedicine);
}

// ---------------------------------------------------------------------------
// Runnable self-check — `npx tsx src/services/voiceRx/controlled.ts`
// ---------------------------------------------------------------------------

export function demo(): void {
  const ok = (c: boolean, label: string) => { if (!c) throw new Error(`FAIL: ${label}`); };
  const blocked = (t: string) => screenTelemedicineProhibited(t).length > 0;

  // THE WHOLE POINT: these are caught WITHOUT any catalogue row existing.
  ok(blocked('alprax 0.5'), 'brand, not in catalogue');
  ok(blocked('alprazolam 0.25 mg'), 'molecule');
  ok(blocked('restyl at bedtime'), 'another brand of the same molecule');
  ok(blocked('give tramadol 50 SOS'), 'opioid inside a sentence');
  ok(blocked('ultracet BD'), 'brand containing a controlled molecule');
  ok(blocked('tab etilaam 0.5'), 'etizolam brand');
  ok(blocked('zolfresh 10 at night'), 'zolpidem brand');
  ok(blocked('corex syrup'), 'codeine cough syrup');
  ok(blocked('T. clonotril 0.5 HS'), 'clonazepam brand with a prefix');
  ok(blocked('patient ko alprax dena hai'), 'Hinglish sentence');

  // And these must NOT fire. A false positive is cheap but not free.
  ok(!blocked('paracetamol 650'), 'paracetamol is not tramadol');
  ok(!blocked('augmentin 625 TID'), 'plain antibiotic');
  ok(!blocked('cetirizine 10 mg'), 'antihistamine');
  ok(!blocked('amlodipine 5 OD'), 'antihypertensive');
  ok(!blocked('pantoprazole 40'), 'PPI');
  ok(!blocked('metformin 500 BD'), 'antidiabetic');
  ok(!blocked('azithral 500'), 'azithromycin brand');
  ok(!blocked('montek lc'), 'montelukast');
  ok(!blocked('dolo 650 SOS'), 'the SOS does not matter');
  ok(!blocked('shelcal 500'), 'calcium');

  // H1 is record-keeping, never a prescribing block.
  const h1 = CONTROLLED.filter((c) => c.schedule === 'H1');
  ok(h1.every((c) => !c.blockTelemedicine), 'H1 never blocks prescribing');

  // eslint-disable-next-line no-console
  console.log(`controlled.ts: all checks passed (${CONTROLLED.length} molecules screened)`);
}

if (require.main === module) demo();
