/**
 * The catalogue learns from what doctors actually prescribe.
 *
 * WHY THIS IS THE HIGHEST-VALUE MECHANISM IN THE WHOLE FEATURE
 * The research put in-domain adaptation at roughly 6 WER points, against 1.9 for
 * 1,800 hours of generic Hindi data. A doctor correcting "as it real" to Azithral
 * IS in-domain adaptation — one row at a time, for free, improving without anyone
 * retraining anything. No model change available to us is worth as much.
 *
 * Three things happen when a prescription is signed:
 *
 *   1. UNRESOLVED free text becomes a LEARNED row, so the next doctor finds it by
 *      typing. Marked unverified, never silently promoted to look curated.
 *   2. A CORRECTION — heard X, doctor chose Y — appends X as an alias on Y. This
 *      is the ASR-error dictionary, written by the people who know.
 *   3. Every resolved medicine's usageCount goes up, so the clinic's own forty
 *      drugs outrank a quarter-million-row long tail in the picker.
 *
 * All of it runs AFTER signing and never throws into it. A prescription is a
 * clinical record; the catalogue getting smarter is a nice-to-have, and a
 * nice-to-have must never be able to fail a signature.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { phoneticKey, norm } from './resolver';
import { screenControlled } from './controlled';

export interface LearnableItem {
  canonicalName: string;
  spokenText: string | null;
  medicationId: string | null;
  genericName: string | null;
  brandName: string | null;
  strength: string | null;
  strengthUnit: string | null;
  dosageForm: string | null;
  route: string | null;
  resolution: string;
}

/** Tokens too generic to be worth learning as a medicine name. */
const JUNK = new Set(['tablet', 'tab', 'cap', 'capsule', 'syrup', 'medicine', 'med', 'drug', 'test']);

function worthLearning(name: string): boolean {
  const n = norm(name);
  if (n.length < 3 || n.length > 120) return false;
  if (JUNK.has(n)) return false;
  // Pure numbers, or a bare strength, are not medicine names.
  if (/^[\d\s.+mgclu%]+$/i.test(n)) return false;
  return true;
}

/**
 * A free-text medicine becomes a findable row.
 *
 * Deliberately conservative about what it records: the doctor's own text as the
 * canonical name, no invented generic, no guessed schedule. Controlled screening
 * still runs on it — a LEARNED row for something the screen flags is recorded
 * with those flags so it cannot become a laundering route for a narcotic.
 */
async function learnMedication(item: LearnableItem, userId: string): Promise<void> {
  const name = item.canonicalName.trim();
  if (!worthLearning(name)) return;

  // "Already known" means under ANY name it goes by — not just the canonical one.
  // A doctor who types "augmentin 625" and chooses "write as typed" has not
  // discovered a new drug: the curated row is "Amoxicillin 500 mg + Clavulanic
  // acid 125 mg" with brand "Augmentin 625". Matching the canonical name alone
  // missed that and minted a duplicate LEARNED row for one of the most prescribed
  // drugs in the catalogue. The real row gets the usage instead.
  const existing = await prisma.medication.findFirst({
    where: {
      deletedAt: null,
      OR: [
        { canonicalName: { equals: name, mode: 'insensitive' } },
        { brandName: { equals: name, mode: 'insensitive' } },
        { genericName: { equals: name, mode: 'insensitive' } },
        { aliases: { has: name } },
      ],
    },
    // The curated row first when a brand exists as both.
    orderBy: [{ source: 'asc' }, { usageCount: 'desc' }],
    select: { id: true },
  });
  if (existing) {
    await prisma.medication.update({
      where: { id: existing.id },
      data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
    });
    return;
  }

  const hits = screenControlled(`${name} ${item.spokenText ?? ''}`);
  const worst = hits.find((h) => h.entry.blockTelemedicine);

  await prisma.medication.create({
    data: {
      canonicalName: name,
      genericName: item.genericName,
      brandName: item.brandName,
      strength: item.strength,
      strengthUnit: item.strengthUnit,
      dosageForm: item.dosageForm,
      route: item.route,
      // What the doctor SAID is the most valuable alias we will ever get: it is a
      // real mishearing, from a real microphone, in a real room.
      aliases: item.spokenText && norm(item.spokenText) !== norm(name) ? [item.spokenText] : [],
      phoneticKey: phoneticKey(name),
      source: 'LEARNED',
      learnedByUserId: userId,
      usageCount: 1,
      lastUsedAt: new Date(),
      scheduleClass: worst ? worst.entry.schedule : null,
      isScheduleX: !!worst?.entry.schedule.includes('X'),
      isNdps: worst?.entry.schedule === 'NDPS',
    },
  });

  logger.info({ name, learnedBy: userId }, 'voiceRx: learned a new medicine');
}

/**
 * Heard X, doctor chose Y -> X becomes an alias on Y.
 *
 * This is the ASR-error dictionary, and it is written by the only people who can
 * write it correctly. Appended, never replacing, and only when the spoken form
 * genuinely differs from what was picked.
 */
async function learnAlias(medicationId: string, spoken: string): Promise<void> {
  const spokenNorm = norm(spoken);
  if (spokenNorm.length < 3 || JUNK.has(spokenNorm)) return;

  const med = await prisma.medication.findUnique({
    where: { id: medicationId },
    select: { id: true, canonicalName: true, brandName: true, genericName: true, aliases: true },
  });
  if (!med) return;

  // Already known under any of its names? Nothing to learn.
  const known = new Set(
    [med.canonicalName, med.brandName, med.genericName, ...med.aliases]
      .filter(Boolean)
      .map((x) => norm(x as string)),
  );
  if (known.has(spokenNorm)) return;

  await prisma.medication.update({
    where: { id: med.id },
    data: { aliases: { push: spoken.trim() } },
  });
  logger.info({ medicationId, alias: spoken, as: med.canonicalName }, 'voiceRx: learned an alias');
}

/**
 * Called once, after a prescription is signed.
 *
 * Never throws. A catalogue improvement is not worth failing a signature over,
 * and the caller has already written the clinical record by this point.
 */
export async function learnFromSignedPrescription(
  items: LearnableItem[],
  userId: string,
): Promise<{ learned: number; aliases: number; used: number }> {
  const result = { learned: 0, aliases: 0, used: 0 };

  for (const item of items) {
    try {
      if (item.medicationId) {
        await prisma.medication.update({
          where: { id: item.medicationId },
          data: { usageCount: { increment: 1 }, lastUsedAt: new Date() },
        });
        result.used++;

        // A correction worth remembering: the microphone heard one thing and the
        // doctor chose another.
        if (item.spokenText && norm(item.spokenText) !== norm(item.canonicalName)) {
          await learnAlias(item.medicationId, item.spokenText);
          result.aliases++;
        }
      } else if (item.resolution === 'UNRESOLVED' || item.resolution === 'MANUAL') {
        await learnMedication(item, userId);
        result.learned++;
      }
    } catch (err) {
      // One bad row must not stop the rest, and none of it must reach the caller.
      logger.error({ err, name: item.canonicalName }, 'voiceRx: learning failed for one item');
    }
  }

  return result;
}

/**
 * Unverified rows, for an owner to review.
 *
 * A LEARNED row is a doctor's free text that nobody has checked. Most will be
 * perfectly good; some will be typos that are now permanently searchable. This
 * is the surface that lets someone fix that, and the reason LEARNED is a
 * distinct source rather than being quietly folded in with the rest.
 */
export async function listLearned(limit = 100) {
  return prisma.medication.findMany({
    where: { source: 'LEARNED', deletedAt: null },
    orderBy: [{ usageCount: 'desc' }, { createdAt: 'desc' }],
    take: limit,
    select: {
      id: true, canonicalName: true, genericName: true, strength: true, strengthUnit: true,
      dosageForm: true, aliases: true, usageCount: true, lastUsedAt: true, createdAt: true,
      isScheduleX: true, isNdps: true,
      learnedBy: { select: { id: true, name: true } },
    },
  });
}
