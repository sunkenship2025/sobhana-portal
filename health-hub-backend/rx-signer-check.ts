/**
 * Who may sign a prescription — signerCheck(), the one rule sign() enforces and
 * the consultation screen reads.
 *
 * The case this exists for: an OWNER must not be able to sign. The sheet carries
 * the visit doctor's name, registration number and signature image, so an owner
 * pressing Sign put a doctor's credentials on an order the doctor never saw. That
 * was possible until canAct's "owners may unstick a visit" pass stopped covering
 * signing.
 *
 * The owner cases are read-only. The doctor's own cases need that doctor linked
 * to a login and a signature on file — no doctor in prod has either — so they
 * borrow one: a temp login linked to a real ClinicDoctor, a placeholder signature,
 * both put back to exactly what they were in a finally.
 *
 *   npx tsx rx-signer-check.ts
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { signerCheck } from './src/services/voiceRx/prescriptionService';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

// 1×1 transparent PNG. Never rendered on a real sheet: it exists only between the
// set and the restore below, and no prescription is signed while it is there.
const PLACEHOLDER_SIG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

(async () => {
  let tempUserId: string | null = null;
  let doctor: { id: string; name: string; userId: string | null; signatureImageBase64: string | null } | null = null;

  try {
    // A doctor nobody is linked to yet — every one in prod, as of Sep 24.
    doctor = await prisma.clinicDoctor.findFirst({
      where: { isActive: true, userId: null },
      select: { id: true, name: true, userId: true, signatureImageBase64: true },
    });
    if (!doctor) { console.log('no unlinked active consulting doctor to test against'); return; }
    console.log(`testing against ${doctor.name}\n`);

    // ── owners: read-only ────────────────────────────────────────────────────
    const owners = await prisma.user.findMany({ where: { role: 'owner', isActive: true }, select: { id: true, email: true } });
    assert(`${owners.length} active owner(s) to test`, owners.length > 0);
    for (const o of owners) {
      const r = await signerCheck(doctor.id, o.id);
      assert(`owner ${o.email} cannot sign`, !r.ok && r.code === 'NOT_THE_PRESCRIBER', r.ok ? 'was allowed' : r.code);
    }

    const stranger = await signerCheck(doctor.id, 'not-a-user-' + Date.now());
    assert('an unknown user cannot sign', !stranger.ok && stranger.code === 'NOT_THE_PRESCRIBER');
    assert('…and is told who can', !stranger.ok && stranger.reason.includes(doctor.name));

    const missing = await signerCheck('no-such-doctor', 'x');
    assert('a missing doctor is refused, not thrown', !missing.ok && missing.code === 'NO_DOCTOR');

    // ── the doctor's own login: reversible ───────────────────────────────────
    const branch = await prisma.branch.findFirst({ where: { isActive: true }, select: { id: true } });
    const u = await prisma.user.create({
      data: {
        email: `signercheck.${Date.now()}@sobhana.local`, name: 'Signer Check', role: 'doctor',
        passwordHash: await bcrypt.hash(String(Math.random()), 10), activeBranchId: branch!.id, isActive: true,
      },
      select: { id: true },
    });
    tempUserId = u.id;
    await prisma.clinicDoctor.update({ where: { id: doctor.id }, data: { userId: u.id } });

    // No signature on file — the same refusal radiology makes with no signer.
    const noSig = doctor.signatureImageBase64
      ? null
      : await signerCheck(doctor.id, u.id);
    if (noSig) {
      assert('the doctor, with no signature on file, is refused', !noSig.ok && noSig.code === 'NO_SIGNATURE', noSig.ok ? 'was allowed' : noSig.code);
      assert('…and told to add one', !noSig.ok && /signature on file/.test(noSig.reason));
    }

    // With a signature: the one person who may sign, can.
    await prisma.clinicDoctor.update({ where: { id: doctor.id }, data: { signatureImageBase64: PLACEHOLDER_SIG } });
    const own = await signerCheck(doctor.id, u.id);
    assert('the doctor, through their own login and with a signature, CAN sign', own.ok, own.ok ? '' : own.reason);

    // Still no owner, even now that the doctor is fully set up.
    for (const o of owners) {
      const r = await signerCheck(doctor.id, o.id);
      assert(`owner ${o.email} still cannot sign a set-up doctor's prescription`, !r.ok && r.code === 'NOT_THE_PRESCRIBER');
    }
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.message ?? err);
  } finally {
    // Put the doctor back exactly as found, THEN remove the temp login.
    if (doctor) {
      await prisma.clinicDoctor.update({
        where: { id: doctor.id },
        data: { userId: doctor.userId, signatureImageBase64: doctor.signatureImageBase64 },
      }).catch((e) => { failures += 1; console.error('COULD NOT RESTORE', doctor!.name, e); });
    }
    if (tempUserId) await prisma.user.delete({ where: { id: tempUserId } }).catch(() => {});
    console.log('\nrestored: doctor unlinked and signature as it was, temp login removed');
    await prisma.$disconnect();
  }

  console.log(failures === 0 ? 'all clean' : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
