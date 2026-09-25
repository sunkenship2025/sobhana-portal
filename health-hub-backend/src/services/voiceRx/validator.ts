/**
 * Deterministic validation. No model runs here, ever.
 *
 * THE RULE THAT SHAPED THIS FILE
 * Published clinical-decision-support alert override rates run 49-96%. A warning
 * a doctor can wave away becomes trained-out noise within weeks — so it is not a
 * safety control, it is a liability that looks like one.
 *
 * Therefore every finding is exactly one of:
 *   BLOCK - signing is refused until it is resolved. Rare by design.
 *   ASK   - the doctor must make a choice; also blocks, but the fix is a click.
 *   NOTE  - shown, never blocking, and deliberately few.
 *
 * There is no dismissible warning tier, because that tier is where alert fatigue
 * lives. Severity-tiered alerting lifted compliance from 10% to 100% on the top
 * tier in the one study with a clean causal result; flat alerting decayed to
 * near-uselessness. So: concentrate the friction where being wrong is dangerous
 * (drug identity, strength, dose, route) and spend none of it elsewhere.
 *
 * This validator does NOT practise medicine. It checks structure, completeness
 * and one legal prohibition. It has no interaction database, no dosing table and
 * no allergy list, and it must not pretend otherwise — the portal has no allergy
 * field at all, so an "allergy check passed" would be a lie.
 */
import { getMedicationsByIds } from './resolver';
import { screenTelemedicineProhibited } from './controlled';
import { scheduleFrequency, FREQUENCY_TEXT } from './normalize';

export type Severity = 'BLOCK' | 'ASK' | 'NOTE';

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  /** PrescriptionItem id, when the finding belongs to one line. */
  itemId?: string;
  field?: string;
}

export interface ValidatableItem {
  id?: string;
  canonicalName: string | null;
  /** What the doctor actually said. Screened even when nothing resolved. */
  spokenText?: string | null;
  genericName?: string | null;
  brandName?: string | null;
  medicationId: string | null;
  strength: string | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  doseQty: string | null;
  doseUnit: string | null;
  frequencyCode: string | null;
  /** "1-0-1" — morning, afternoon, night. */
  doseSchedule?: string | null;
  route: string | null;
  timing: string | null;
  durationValue: number | null;
  durationUnit: string | null;
  instructions: string | null;
  resolution: string; // RESOLVED | AMBIGUOUS | UNRESOLVED | MANUAL
  isAlternative?: boolean;
}

export interface ValidatablePrescription {
  items: ValidatableItem[];
  diagnosis?: string | null;
  followUpDays?: number | null;
  /** In-person consultations are not telemedicine; the Schedule X gate is scoped. */
  isTelemedicine?: boolean;
  /**
   * The raw dictation, when there was one. Screened in full, because a
   * controlled substance the EXTRACTOR dropped is still a controlled substance
   * the doctor said out loud.
   */
  transcript?: string | null;
}

export interface ValidationResult {
  findings: Finding[];
  /** True when nothing BLOCKs or ASKs. The API refuses to sign when false. */
  canSign: boolean;
}

const FREQUENCY_CODES = new Set(['OD', 'BD', 'TID', 'QID', 'HS', 'SOS', 'STAT', 'WEEKLY', 'ALT_DAY', 'QH']);
const ROUTES = new Set(['oral', 'topical', 'IV', 'IM', 'SC', 'ophthalmic', 'otic', 'nasal', 'inhalation', 'vaginal', 'rectal']);
const DURATION_UNITS = new Set(['days', 'weeks', 'months']);
const TIMINGS = new Set(['before food', 'after food', 'with food', 'empty stomach', 'bedtime']);

/** Beyond this a duration is almost certainly a transcription error, not intent. */
const MAX_DURATION_DAYS = 365;

function durationInDays(v: number | null, u: string | null): number | null {
  if (v == null) return null;
  if (u === 'weeks') return v * 7;
  if (u === 'months') return v * 30;
  return v;
}

export async function validatePrescription(rx: ValidatablePrescription): Promise<ValidationResult> {
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  // --- prescription level ---------------------------------------------------
  const prescribed = rx.items.filter((i) => !i.isAlternative);

  if (rx.items.length === 0) {
    add({ severity: 'BLOCK', code: 'NO_MEDICATION', message: 'Add at least one medicine, or close the visit with "Done, no prescription".' });
  }

  // An unresolved either/or. This is the failure class reviewers catch least
  // often (4.5% in a 565-note audit): a choice recorded as two issued medicines.
  const alternatives = rx.items.filter((i) => i.isAlternative);
  if (alternatives.length > 0) {
    add({
      severity: 'ASK',
      code: 'ALTERNATIVES_UNRESOLVED',
      message: `You offered a choice between ${alternatives.map((a) => a.canonicalName || 'a medicine').join(' and ')}. Pick the one you are prescribing, or remove the others.`,
    });
  }

  // Duplicate medicine — the same drug twice is nearly always a dictation artefact.
  const seen = new Map<string, number>();
  for (const it of prescribed) {
    const key = (it.medicationId || (it.canonicalName ?? '').toLowerCase().trim());
    if (!key) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of seen) {
    if (count > 1) {
      const name = prescribed.find((i) => (i.medicationId || (i.canonicalName ?? '').toLowerCase().trim()) === key)?.canonicalName;
      add({ severity: 'ASK', code: 'DUPLICATE_MEDICATION', message: `${name ?? 'A medicine'} appears ${count} times. Keep one, or make the difference explicit.` });
    }
  }

  // --- legal prohibition ---------------------------------------------------
  // Telemedicine Practice Guidelines §3.7.4 forbids prescribing Schedule X drugs
  // and NDPS narcotics/psychotropics over telemedicine, absolutely, with no
  // exception in any source found. UN-OVERRIDABLE.
  //
  // Screening runs on the TEXT, not on resolved catalogue rows. The first
  // version checked isScheduleX on the matched Medication, which meant a
  // controlled drug we had not seeded carried no flags and passed the gate
  // untouched — the safety of the block depended on the completeness of the
  // catalogue. It fails CLOSED now: a token that looks like a controlled
  // substance blocks whether or not we have ever heard of it.
  if (rx.isTelemedicine) {
    const seenMolecules = new Set<string>();

    for (const it of rx.items) {
      // Everything the doctor said or wrote for this line, resolved or not.
      const surfaces = [it.canonicalName, it.spokenText, it.genericName, it.brandName, it.instructions]
        .filter(Boolean)
        .join(' ');
      for (const hit of screenTelemedicineProhibited(surfaces)) {
        if (seenMolecules.has(hit.entry.molecule)) continue;
        seenMolecules.add(hit.entry.molecule);
        add({
          severity: 'BLOCK',
          code: 'SCHEDULE_X_TELEMEDICINE',
          itemId: it.id,
          message: `${hit.entry.molecule} (matched "${hit.matched}") cannot be prescribed remotely. Telemedicine Practice Guidelines §3.7.4 prohibits Schedule X and NDPS medicines in a teleconsultation — this needs an in-person visit.`,
        });
      }
    }

    // And the transcript itself, for anything extraction dropped.
    for (const hit of screenTelemedicineProhibited(rx.transcript)) {
      if (seenMolecules.has(hit.entry.molecule)) continue;
      seenMolecules.add(hit.entry.molecule);
      add({
        severity: 'BLOCK',
        code: 'SCHEDULE_X_IN_DICTATION',
        message: `You mentioned ${hit.entry.molecule} ("${hit.matched}") in the dictation. Schedule X and NDPS medicines cannot be prescribed remotely (§3.7.4) — this needs an in-person visit.`,
      });
    }

    // Belt and braces: the catalogue flags, for anything the text screen missed
    // (a brand we have seeded and flagged but whose name shares no stem).
    const ids = rx.items.map((i) => i.medicationId).filter(Boolean) as string[];
    const meds = await getMedicationsByIds(ids);
    for (const it of rx.items) {
      const m = it.medicationId ? meds.get(it.medicationId) : null;
      if (!m || (!m.isScheduleX && !m.isNdps)) continue;
      if (seenMolecules.has(m.canonicalName)) continue;
      seenMolecules.add(m.canonicalName);
      add({
        severity: 'BLOCK',
        code: 'SCHEDULE_X_TELEMEDICINE',
        itemId: it.id,
        message: `${m.canonicalName} cannot be prescribed remotely. Telemedicine Practice Guidelines §3.7.4 prohibits Schedule X and NDPS medicines in a teleconsultation — this needs an in-person visit.`,
      });
    }
  }

  // --- item level -----------------------------------------------------------
  for (const it of rx.items) {
    const label = it.canonicalName || 'Unnamed medicine';
    const id = it.id;

    if (!it.canonicalName || !it.canonicalName.trim()) {
      add({ severity: 'BLOCK', code: 'MISSING_NAME', itemId: id, field: 'canonicalName', message: 'A medicine has no name.' });
      continue;
    }

    // Identity is the top friction tier — this is where being wrong is dangerous.
    if (it.resolution === 'AMBIGUOUS') {
      add({ severity: 'ASK', code: 'AMBIGUOUS_MEDICATION', itemId: id, field: 'canonicalName', message: `Confirm which medicine "${label}" is.` });
    }
    if (it.resolution === 'UNRESOLVED') {
      add({ severity: 'ASK', code: 'UNRESOLVED_MEDICATION', itemId: id, field: 'canonicalName', message: `"${label}" is not in the medicine list. Confirm it, or pick a match.` });
    }

    // Strength: blocking, because a wrong or missing strength is the classic harm.
    // Exempt forms that genuinely carry none (an ointment, a plain syrup).
    const formNeedsStrength = !['ointment', 'cream', 'gel', 'drops', 'lotion', 'powder'].includes((it.dosageForm ?? '').toLowerCase());
    if (!it.strength && formNeedsStrength) {
      add({ severity: 'ASK', code: 'MISSING_STRENGTH', itemId: id, field: 'strength', message: `${label}: strength not stated.` });
    }
    if (it.strength && !/^\d+(\.\d+)?(\+\d+(\.\d+)?)?$/.test(it.strength.replace(/\s/g, ''))) {
      add({ severity: 'BLOCK', code: 'INVALID_STRENGTH', itemId: id, field: 'strength', message: `${label}: "${it.strength}" is not a valid strength.` });
    }

    // Frequency: structural, and cheap to fix. Blocking as ASK.
    if (!it.frequencyCode) {
      add({ severity: 'ASK', code: 'MISSING_FREQUENCY', itemId: id, field: 'frequencyCode', message: `${label}: how often?` });
    } else if (!FREQUENCY_CODES.has(it.frequencyCode)) {
      add({ severity: 'BLOCK', code: 'INVALID_FREQUENCY', itemId: id, field: 'frequencyCode', message: `${label}: "${it.frequencyCode}" is not a valid frequency.` });
    }

    // "1-0-1" is twice a day. A grid and a frequency that disagree ("1-0-1",
    // "three times a day") is a mishearing of one of them: the doctor says which.
    const perDay = scheduleFrequency(it.doseSchedule);
    const counted = ['OD', 'BD', 'TID', 'QID', 'HS'].includes(it.frequencyCode ?? '');
    if (perDay && counted && it.frequencyCode !== perDay && !(it.frequencyCode === 'HS' && it.doseSchedule === '0-0-1')) {
      add({ severity: 'ASK', code: 'SCHEDULE_MISMATCH', itemId: id, field: 'frequencyCode', message: `${label}: ${it.doseSchedule} is ${FREQUENCY_TEXT[perDay]}, but the frequency says otherwise. Which is it?` });
    }

    if (it.route && !ROUTES.has(it.route)) {
      add({ severity: 'BLOCK', code: 'INVALID_ROUTE', itemId: id, field: 'route', message: `${label}: "${it.route}" is not a valid route.` });
    }
    if (it.timing && !TIMINGS.has(it.timing)) {
      add({ severity: 'BLOCK', code: 'INVALID_TIMING', itemId: id, field: 'timing', message: `${label}: "${it.timing}" is not a valid timing.` });
    }

    // Duration: a NOTE, not a block. A long-term antihypertensive legitimately has
    // none, and blocking here would train doctors to type a number to get past us.
    const isOngoing = it.frequencyCode === 'SOS' || it.frequencyCode === 'STAT';
    if (it.durationValue == null && !isOngoing) {
      add({ severity: 'NOTE', code: 'NO_DURATION', itemId: id, field: 'durationValue', message: `${label}: no duration — continuing until review.` });
    }
    if (it.durationValue != null) {
      if (!Number.isFinite(it.durationValue) || it.durationValue <= 0) {
        add({ severity: 'BLOCK', code: 'INVALID_DURATION', itemId: id, field: 'durationValue', message: `${label}: duration must be a positive number.` });
      }
      if (it.durationUnit && !DURATION_UNITS.has(it.durationUnit)) {
        add({ severity: 'BLOCK', code: 'INVALID_DURATION_UNIT', itemId: id, field: 'durationUnit', message: `${label}: "${it.durationUnit}" is not a valid duration unit.` });
      }
      const days = durationInDays(it.durationValue, it.durationUnit);
      if (days != null && days > MAX_DURATION_DAYS) {
        add({ severity: 'ASK', code: 'IMPLAUSIBLE_DURATION', itemId: id, field: 'durationValue', message: `${label}: ${it.durationValue} ${it.durationUnit} is over a year — confirm.` });
      }
    }

    if (it.doseQty != null && it.doseQty !== '' && !/^\d+(\.\d+)?(\/\d+)?$/.test(it.doseQty.trim())) {
      add({ severity: 'BLOCK', code: 'INVALID_DOSE', itemId: id, field: 'doseQty', message: `${label}: "${it.doseQty}" is not a valid dose quantity.` });
    }

    // Form/route coherence — catches a dictation slip, not a clinical judgement.
    const form = (it.dosageForm ?? '').toLowerCase();
    if (form && it.route) {
      const oralForms = ['tablet', 'capsule', 'syrup', 'suspension'];
      if (oralForms.includes(form) && ['topical', 'ophthalmic', 'otic'].includes(it.route)) {
        add({ severity: 'ASK', code: 'FORM_ROUTE_MISMATCH', itemId: id, message: `${label}: a ${form} given by ${it.route} route — confirm.` });
      }
      if (form === 'ointment' && it.route === 'oral') {
        add({ severity: 'ASK', code: 'FORM_ROUTE_MISMATCH', itemId: id, message: `${label}: an ointment taken orally — confirm.` });
      }
    }
  }

  const canSign = !findings.some((f) => f.severity === 'BLOCK' || f.severity === 'ASK');
  return { findings, canSign };
}

// ---------------------------------------------------------------------------
// Runnable self-check — `npx tsx src/services/voiceRx/validator.ts`
// Uses no database: every case below avoids the Schedule X path, which is the
// only branch that reads the catalog.
// ---------------------------------------------------------------------------

const base: ValidatableItem = {
  canonicalName: 'Amlodipine 5 mg', medicationId: 'm1', strength: '5', strengthUnit: 'mg',
  dosageForm: 'tablet', doseQty: '1', doseUnit: 'tablet', frequencyCode: 'OD', route: 'oral',
  timing: null, durationValue: 30, durationUnit: 'days', instructions: null, resolution: 'RESOLVED',
};

export async function demo(): Promise<void> {
  const has = (r: ValidationResult, code: string) => r.findings.some((f) => f.code === code);
  const ok = (cond: boolean, label: string) => { if (!cond) throw new Error(`FAIL: ${label}`); };

  // A clean prescription signs, and a missing TIMING never blocks it — timing is
  // the field the system must never invent, so its absence cannot be an error.
  let r = await validatePrescription({ items: [{ ...base }] });
  ok(r.canSign, 'clean prescription can sign');
  ok(!has(r, 'MISSING_TIMING'), 'absent timing is not a finding');

  r = await validatePrescription({ items: [{ ...base, frequencyCode: 'BD', doseSchedule: '1-0-1' }] });
  ok(r.canSign && !has(r, 'SCHEDULE_MISMATCH'), '1-0-1 twice daily agrees');
  r = await validatePrescription({ items: [{ ...base, frequencyCode: 'HS', doseSchedule: '0-0-1' }] });
  ok(!has(r, 'SCHEDULE_MISMATCH'), '0-0-1 at bedtime agrees');
  r = await validatePrescription({ items: [{ ...base, frequencyCode: 'TID', doseSchedule: '1-0-1' }] });
  ok(!r.canSign && has(r, 'SCHEDULE_MISMATCH'), '1-0-1 with three times a day asks');

  r = await validatePrescription({ items: [] });
  ok(!r.canSign && has(r, 'NO_MEDICATION'), 'empty prescription blocks');

  r = await validatePrescription({ items: [{ ...base, resolution: 'AMBIGUOUS' }] });
  ok(!r.canSign && has(r, 'AMBIGUOUS_MEDICATION'), 'ambiguous medicine blocks signing');

  r = await validatePrescription({ items: [{ ...base, frequencyCode: null }] });
  ok(!r.canSign && has(r, 'MISSING_FREQUENCY'), 'missing frequency blocks');

  r = await validatePrescription({ items: [{ ...base, strength: null }] });
  ok(!r.canSign && has(r, 'MISSING_STRENGTH'), 'missing strength blocks');

  // An ointment has no strength and must NOT be blocked for it.
  r = await validatePrescription({ items: [{ ...base, canonicalName: 'Betnovate', strength: null, dosageForm: 'ointment', route: 'topical', frequencyCode: 'BD' }] });
  ok(r.canSign, 'ointment without strength still signs');

  // Duration is a NOTE, never a block.
  r = await validatePrescription({ items: [{ ...base, durationValue: null, durationUnit: null }] });
  ok(r.canSign && has(r, 'NO_DURATION'), 'absent duration notes but does not block');

  r = await validatePrescription({ items: [{ ...base, durationValue: 400, durationUnit: 'days' }] });
  ok(!r.canSign && has(r, 'IMPLAUSIBLE_DURATION'), 'over-a-year duration asks');

  r = await validatePrescription({ items: [{ ...base }, { ...base }] });
  ok(!r.canSign && has(r, 'DUPLICATE_MEDICATION'), 'duplicate medicine asks');

  // The either/or case — the failure reviewers miss most often.
  r = await validatePrescription({
    items: [
      { ...base, canonicalName: 'Azithromycin 500 mg', isAlternative: true },
      { ...base, canonicalName: 'Amoxiclav 625 mg', isAlternative: true },
    ],
  });
  ok(!r.canSign && has(r, 'ALTERNATIVES_UNRESOLVED'), 'unresolved either/or blocks signing');

  r = await validatePrescription({ items: [{ ...base, strength: 'five hundred' }] });
  ok(!r.canSign && has(r, 'INVALID_STRENGTH'), 'non-numeric strength blocks');

  r = await validatePrescription({ items: [{ ...base, dosageForm: 'tablet', route: 'topical' }] });
  ok(!r.canSign && has(r, 'FORM_ROUTE_MISMATCH'), 'tablet by topical route asks');

  // --- THE CATALOGUE-INDEPENDENCE TESTS ------------------------------------
  // These are the regression for a real hole: the first version checked
  // isScheduleX on the RESOLVED row, so a controlled drug we had never seeded
  // carried no flags and passed the §3.7.4 gate untouched. Every case below has
  // medicationId: null — nothing is in the catalogue — and every one must block.

  r = await validatePrescription({
    isTelemedicine: true,
    items: [{ ...base, canonicalName: 'Alprax 0.5', medicationId: null, resolution: 'UNRESOLVED' }],
  });
  ok(!r.canSign && has(r, 'SCHEDULE_X_TELEMEDICINE'), 'unseeded controlled BRAND blocks');

  r = await validatePrescription({
    isTelemedicine: true,
    items: [{ ...base, canonicalName: 'Tramadol 50 mg', medicationId: null, resolution: 'MANUAL' }],
  });
  ok(!r.canSign && has(r, 'SCHEDULE_X_TELEMEDICINE'), 'unseeded opioid blocks');

  // Typed as something harmless, but SPOKEN as a controlled drug.
  r = await validatePrescription({
    isTelemedicine: true,
    items: [{ ...base, canonicalName: 'Tablet', medicationId: null, spokenText: 'restyl point five', resolution: 'UNRESOLVED' }],
  });
  ok(!r.canSign && has(r, 'SCHEDULE_X_TELEMEDICINE'), 'spokenText alone is enough to block');

  // Mentioned in the dictation but dropped by extraction entirely.
  r = await validatePrescription({
    isTelemedicine: true,
    transcript: 'dolo 650 SOS aur etilaam point five raat ko',
    items: [{ ...base, canonicalName: 'Paracetamol 650 mg', medicationId: null }],
  });
  ok(!r.canSign && has(r, 'SCHEDULE_X_IN_DICTATION'), 'controlled drug in the transcript blocks even if extraction dropped it');

  // In PERSON, none of this applies — §3.7.4 is a telemedicine rule.
  r = await validatePrescription({
    isTelemedicine: false,
    items: [{ ...base, canonicalName: 'Alprax 0.5', medicationId: null }],
  });
  ok(r.canSign, 'in-person consultation is not telemedicine — no block');

  // And a safe prescription must not be caught by the screen.
  r = await validatePrescription({
    isTelemedicine: true,
    transcript: 'paracetamol 650 TID and pantoprazole 40 OD',
    items: [{ ...base, canonicalName: 'Paracetamol 650 mg', medicationId: null }],
  });
  ok(r.canSign, 'safe prescription over telemedicine still signs');

  // eslint-disable-next-line no-console
  console.log('validator.ts: all checks passed');
}

if (require.main === module) demo().catch((e) => { console.error(e); process.exit(1); });
