/**
 * The dictation path, the way the SCREEN takes it — not the way the other checks
 * seed it.
 *
 * voicerx-queue-check seeds drafts through createDraft, which resolves on the
 * server. The consultation page never calls that for dictation: it extracts, then
 * saves the new lines through updateDraft. Until this was fixed, that path
 * resolved nothing — the page stamped every spoken drug MANUAL and updateDraft
 * stored it — so every check passed while a doctor who said "Augmentin 625" got
 * "Aumintin 625 · Your choice" with no question and no options.
 *
 * This saves new lines WITHOUT a resolution, exactly as the page now sends them,
 * and asserts what gets stored. One temporary draft on a real visit, deleted in a
 * finally.
 *
 *   npx tsx dictation-path-check.ts
 */
import 'dotenv/config';
import prisma from './src/lib/prisma';
import { createDraft, updateDraft } from './src/services/voiceRx/prescriptionService';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

(async () => {
  let draftId: string | null = null;
  try {
    const cv = await prisma.clinicVisit.findFirst({
      where: { visit: { status: { not: 'CANCELLED' } } },
      orderBy: { createdAt: 'desc' },
      select: { visitId: true, clinicDoctorId: true, visit: { select: { branchId: true } } },
    });
    const user = await prisma.user.findFirst({ where: { role: 'owner', isActive: true }, select: { id: true } });
    if (!cv || !user) { console.log('no fixture'); return; }

    const d = await createDraft({ visitId: cv.visitId, branchId: cv.visit.branchId, clinicDoctorId: cv.clinicDoctorId, items: [] });
    draftId = d.id;

    // What the page sends after a dictation: no resolution, no candidates.
    const line = (spoken: string, extra: Record<string, unknown> = {}) => ({
      canonicalName: spoken, spokenText: spoken, doseQty: '1', frequencyCode: 'TID', durationValue: 5, durationUnit: 'days',
      ...extra,
    });
    const saved = await updateDraft(d.id, user.id, {
      items: [
        line('Aumintin 625'),                                  // the mishearing
        line('Augmentin 625'),                                 // said correctly
        line('azithromycin 500', { fieldStates: { isAlternative: true } }), // "either … or …"
        // A human decision must be left alone — typed as written.
        { ...line('My own mixture'), resolution: 'UNRESOLVED' },
        { ...line('Dolo 650'), resolution: 'MANUAL' },
      ] as any,
    });
    const byName = (n: string) => saved!.items.find((i: any) => (i.spokenText ?? i.canonicalName) === n) as any;

    const mis = byName('Aumintin 625');
    assert('a mishearing is NOT stored as the doctor\'s choice', mis?.resolution !== 'MANUAL', mis?.resolution);
    assert('…it is an open question', mis?.resolution === 'UNRESOLVED' || mis?.resolution === 'AMBIGUOUS', mis?.resolution);
    const opts = (mis?.candidates ?? []) as any[];
    assert('…that comes with options', opts.length > 0, `${opts.length} options`);
    assert('…and Augmentin 625 is the first', /augmentin 625/i.test(`${opts[0]?.brandName} ${opts[0]?.canonicalName}`),
      `${opts[0]?.brandName ?? opts[0]?.canonicalName}`);
    assert('…with the reason on the row for the queue', !!(mis?.fieldStates as any)?.askReason, JSON.stringify(mis?.fieldStates));

    const ok = byName('Augmentin 625');
    assert('said correctly, it is matched to the catalogue', ok?.resolution === 'RESOLVED' && !!ok?.medicationId, `${ok?.resolution} ${ok?.medicationId}`);
    assert('…as the molecule, not just the brand', /amoxicillin/i.test(ok?.canonicalName ?? ''), ok?.canonicalName);

    const alt = byName('azithromycin 500');
    assert('"either … or" survives the save', (alt?.fieldStates as any)?.isAlternative === true, JSON.stringify(alt?.fieldStates));

    assert('"write as typed" stays the doctor\'s decision', byName('My own mixture')?.resolution === 'UNRESOLVED');
    assert('a pick stays a pick', byName('Dolo 650')?.resolution === 'MANUAL');
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
