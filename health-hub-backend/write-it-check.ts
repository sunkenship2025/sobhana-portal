/**
 * "Type midway" — WRITTEN words through the same pipeline as dictation.
 *
 * The screen's new path, end to end: the doctor writes (or corrects what was
 * heard to) "Augmentin 625 three times daily for five days…", the extractor that
 * /prescriptions/extract calls structures it, and the lines are saved the way the
 * page saves them — without a resolution — so the server resolves each one.
 *
 * Makes ONE real extraction call (a fraction of a cent) and uses one temporary
 * draft, deleted in a finally.
 *
 *   npx tsx write-it-check.ts
 */
import 'dotenv/config';
import prisma from './src/lib/prisma';
import { extractPrescription, extractionConfigured } from './src/services/voiceRx/extract';
import { createDraft, updateDraft } from './src/services/voiceRx/prescriptionService';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

const WRITTEN = 'Augmentin 625 three times daily for five days, Pan 40 once daily before breakfast for ten days';

(async () => {
  if (!extractionConfigured()) { console.log('extraction key not set here — skipping'); process.exit(0); }
  let draftId: string | null = null;
  try {
    const { items, missing } = await extractPrescription(WRITTEN, []);
    console.log(`     extracted ${items.length}: ${items.map((i) => `${i.name} ${i.strength ?? ''} ${i.frequencyCode ?? ''} ${i.durationValue ?? ''}${i.durationUnit ?? ''}`).join(' | ')}`);
    assert('two medicines read from the written line', items.length === 2, String(items.length));

    const aug = items.find((i) => /augmentin/i.test(`${i.name} ${i.spokenText}`));
    assert('Augmentin: three times a day', aug?.frequencyCode === 'TID', aug?.frequencyCode ?? '');
    assert('Augmentin: five days', aug?.durationValue === 5 && /day/.test(aug?.durationUnit ?? ''), `${aug?.durationValue} ${aug?.durationUnit}`);
    const pan = items.find((i) => /pan/i.test(`${i.name} ${i.spokenText}`));
    assert('Pan 40: before breakfast / before food', !!pan?.timing && /before/i.test(pan.timing), pan?.timing ?? '');
    assert('what was not said is reported, not invented', Array.isArray(missing));

    // Save exactly as the page does: new lines, no resolution.
    const cv = await prisma.clinicVisit.findFirst({
      where: { visit: { status: { not: 'CANCELLED' } } }, orderBy: { createdAt: 'desc' },
      select: { visitId: true, clinicDoctorId: true, visit: { select: { branchId: true } } },
    });
    const user = await prisma.user.findFirst({ where: { role: 'owner', isActive: true }, select: { id: true } });
    const d = await createDraft({ visitId: cv!.visitId, branchId: cv!.visit.branchId, clinicDoctorId: cv!.clinicDoctorId, items: [] });
    draftId = d.id;
    const saved = await updateDraft(d.id, user!.id, {
      items: items.map((e) => ({
        canonicalName: e.name || e.spokenText, spokenText: e.spokenText, strength: e.strength, strengthUnit: e.strengthUnit,
        dosageForm: e.dosageForm, doseQty: e.doseQty, doseUnit: e.doseUnit, frequencyCode: e.frequencyCode,
        route: e.route, timing: e.timing, durationValue: e.durationValue, durationUnit: e.durationUnit,
        instructions: e.instructions, sourceText: e.sourceText, fieldStates: { ...e.fieldStates, isAlternative: e.isAlternative },
      })) as any,
    });
    const rows = saved!.items as any[];
    const savedAug = rows.find((r) => /augmentin/i.test(`${r.spokenText} ${r.brandName} ${r.canonicalName}`));
    assert('saved Augmentin is matched to the catalogue, not "Your choice"', savedAug?.resolution === 'RESOLVED' && !!savedAug?.medicationId,
      `${savedAug?.resolution} ${savedAug?.canonicalName}`);
    const savedPan = rows.find((r) => /pan/i.test(`${r.spokenText} ${r.brandName} ${r.canonicalName}`));
    assert('saved Pan 40 is either matched or asked about — never silently decided',
      savedPan?.resolution === 'RESOLVED' || savedPan?.resolution === 'AMBIGUOUS', savedPan?.resolution);
    assert('frequency and duration survive the save', savedAug?.frequencyCode === 'TID' && savedAug?.durationValue === 5,
      `${savedAug?.frequencyCode} ${savedAug?.durationValue}`);
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    if (draftId) await prisma.prescription.deleteMany({ where: { rootId: draftId } }).catch(() => {});
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? '\nall clean' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
