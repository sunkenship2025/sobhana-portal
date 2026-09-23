/**
 * The question queue's data contract, end to end against the real database.
 *
 *   npx tsx voicerx-queue-check.ts
 *
 * WHY THIS EXISTS
 * The queue rebuilds itself from the stored draft — it holds no state of its own,
 * on purpose, so that a reload cannot lose a question or invent one. That makes the
 * ROUND TRIP the load-bearing part, and the round trip is invisible to a typecheck:
 * a draft save that dropped `candidates` still compiled, still passed lint, and
 * still rendered — it just came back asking "which medicine?" with nothing left to
 * choose from. This is the thing that fails when that happens again.
 *
 * It creates one draft on the branch it finds, asserts the contract, and deletes it.
 */
import prisma from './src/lib/prisma';
import { createDraft, updateDraft, getById, validateById } from './src/services/voiceRx/prescriptionService';

const ok = (cond: unknown, label: string) => {
  if (!cond) throw new Error(`FAIL: ${label}`);
  // eslint-disable-next-line no-console
  console.log(`  ok  ${label}`);
};

/** The frontend's openQuestions(), duplicated deliberately — see the note below. */
const openQuestions = (items: any[]) =>
  items.filter((i) => i.resolution !== 'RESOLVED' && i.resolution !== 'MANUAL');

async function main(): Promise<void> {
  const visit = await prisma.visit.findFirst({
    orderBy: { createdAt: 'desc' },
    select: { id: true, branchId: true },
  });
  const doctor = await prisma.clinicDoctor.findFirst({ where: { isActive: true }, select: { id: true } });
  if (!visit || !doctor) { console.log('SKIP: no visit or clinic doctor in this database'); return; }

  let id = '';
  try {
    // One line per reason the queue knows how to render, so a regression in any
    // single arm fails here rather than only in the arm someone happened to try.
    const draft = await createDraft({
      visitId: visit.id, branchId: visit.branchId, clinicDoctorId: doctor.id,
      items: [
        // STRENGTH_NOT_STOCKED — matched the medicine, not the strength.
        { name: 'pantop', strength: '55', spokenText: 'pantop fifty five' } as any,
        // MULTIPLE_MATCHES — several real products, a closed choice.
        { name: 'amlodipine', spokenText: 'amlodipine' } as any,
        // NO_MATCH — nothing matched; the doctor may keep what they said.
        { name: 'qwerty unknown brand', spokenText: 'qwerty unknown brand' } as any,
      ],
    });
    id = draft.id;

    console.log('\n1. a dictated ambiguity produces an answerable question');
    const q0 = openQuestions(draft.items);
    ok(q0.length === 3, `${q0.length} of ${draft.items.length} items need an answer`);
    const reasons = new Set(q0.map((i) => (i.fieldStates as any)?.askReason));
    for (const r of ['STRENGTH_NOT_STOCKED', 'MULTIPLE_MATCHES', 'NO_MATCH']) {
      ok(reasons.has(r), `the ${r} arm is exercised`);
    }
    for (const it of q0) {
      const reason = (it.fieldStates as any)?.askReason ?? (it.resolution === 'UNRESOLVED' ? 'NO_MATCH' : null);
      ok(!!reason, `"${it.canonicalName}" carries a reason (${reason})`);
      // An AMBIGUOUS line with no candidates is the unanswerable question.
      if (it.resolution === 'AMBIGUOUS') {
        ok(Array.isArray(it.candidates) && it.candidates.length > 0,
          `"${it.canonicalName}" offers ${(it.candidates as any[])?.length} options`);
      }
    }

    console.log('\n2. the question survives a draft save WITH its options');
    await updateDraft(id, 'check', {
      diagnosis: 'round-trip check',
      items: draft.items.map((i: any) => ({ id: i.id, canonicalName: i.canonicalName, resolution: i.resolution })),
    });
    const after = await getById(id);
    const q1 = openQuestions(after!.items);
    ok(q1.length === q0.length, `still ${q1.length} question(s) after a save`);
    for (const it of q1) {
      ok(!!((it.fieldStates as any)?.askReason) || it.resolution === 'UNRESOLVED',
        `"${it.canonicalName}" kept its reason`);
      if (it.resolution === 'AMBIGUOUS') {
        ok(Array.isArray(it.candidates) && (it.candidates as any[]).length > 0,
          `"${it.canonicalName}" KEPT its options across the save`);
      }
    }

    console.log('\n3. an unanswered question blocks signing');
    const before = await validateById(id);
    ok(before.findings.some((f) => f.severity !== 'NOTE'), 'validator refuses while a question is open');

    console.log('\n4. answering it clears the question and drops the options');
    await updateDraft(id, 'check', {
      items: after!.items.map((i: any) => ({
        id: i.id, canonicalName: i.canonicalName, resolution: 'MANUAL',
      })),
    });
    const answered = await getById(id);
    ok(openQuestions(answered!.items).length === 0, 'the queue is empty');
    ok(answered!.items.every((i: any) => !i.candidates), 'answered lines carry no stale options');

    console.log('\nvoicerx-queue-check.ts: the contract holds.');
  } finally {
    if (id) await prisma.prescription.deleteMany({ where: { id } });
    await prisma.$disconnect();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
