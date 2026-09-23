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
import { RESTRICTED_INDIA, type RestrictedEntry } from './controlled-data';

/** The generated shape, re-exported under this file's original name. */
export type ControlledEntry = RestrictedEntry;

/**
 * Primary-sourced: 83 molecules, 43 of which §3.7.4 prohibits remotely. Replaces
 * the hand-written list, which had the right BLOCK outcomes for the common cases
 * but the wrong schedule labels — it called alprazolam and diazepam Schedule X
 * when they are legally Schedule H1 that block by virtue of being NDPS.
 */
export const CONTROLLED: ControlledEntry[] = RESTRICTED_INDIA;

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

  // --- SCHEDULE CORRECTIONS, from primary sources ---------------------------
  // Each of these is a place the intuitive answer is wrong, and each would be a
  // real bug — two over-blocking, one under-blocking.

  // Tapentadol is H1 ONLY, confirmed by multiple High Court rulings, unlike its
  // close cousin tramadol. The hand-written list blocked it. It must not.
  ok(!blocked('tapentadol 50'), 'tapentadol is H1, not NDPS — does NOT block');
  ok(blocked('tramadol 50'), 'tramadol IS NDPS since 2018 — blocks');

  // H1 antibiotics need the pharmacist's register, not a prescribing ban.
  // §3.7.4's list is Schedule X + NDPS only, and these are on neither.
  ok(!blocked('levofloxacin 500 BD'), 'H1 antibiotic does not block telemedicine');
  ok(!blocked('meropenem 1g'), 'H1 antibiotic does not block telemedicine');

  // Banned outright since 2013 — should never appear as a legitimate prescription.
  ok(blocked('dextropropoxyphene'), 'banned molecule blocks');

  // Unconfirmed psychotropics fail CLOSED. Better to send a patient in person
  // than to discover the schedule mattered after the fact.
  ok(blocked('zopiclone 7.5'), 'unconfirmed psychotropic still blocks');

  // H1 is record-keeping, never a prescribing block. This is the invariant that
  // caught a cross-listed duplicate: Midazolam appeared twice, once labelled H1
  // with block=true, because its real entry lives in the NDPS bucket.
  const h1 = CONTROLLED.filter((c) => c.schedule === 'H1');
  ok(h1.every((c) => !c.blockTelemedicine), 'H1 never blocks prescribing');
  ok(h1.length > 30, 'the H1 list is actually populated');

  // Schedule X really is small. The "~40 entries" figure online is a stale
  // pre-1998 version; deletions moved most items out.
  const x = CONTROLLED.filter((c) => c.schedule === 'X');
  ok(x.length === 16, `Schedule X has 16 entries, got ${x.length}`);

  // eslint-disable-next-line no-console
  console.log(`controlled.ts: all checks passed (${CONTROLLED.length} molecules screened)`);
}

if (require.main === module) demo();
