/**
 * Corrections, discards and the staff-side record — end to end, on the real code.
 *
 *   sign v1 → the record says "signed v1"
 *   correct → v1 is STILL the prescription (link, record, history) until v2 is signed
 *   a second correction while one is open → refused
 *   discard the correction → v1 is the latest again, and its recording survives
 *   correct + sign → v1 superseded, v2 signed, the sheet says what it replaces
 *   the HTTP records routes (view / printed) and the doctor's profile PATCH
 *
 * Signing needs the visit's doctor linked to a login with a signature, and no
 * doctor in prod has either — so, like rx-signer-check, it borrows one: a temp
 * login linked to a real ClinicDoctor and a placeholder signature. EVERYTHING it
 * writes is removed in finally — the prescriptions, their tokens, the audit rows
 * they produced, the temp logins — and the doctor row and the medicine's usage
 * count are put back exactly as they were.
 *
 *   API_URL=https://reports.sobhanaportal.com npx tsx rx-records-check.ts
 */
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import prisma from './src/lib/prisma';
import { createDraft, sign, amend, discardDraft, listForPatient } from './src/services/voiceRx/prescriptionService';
import { rxSummaries } from './src/services/prescriptionRecords';
import { createPrescriptionAccessToken, resolvePrescriptionToken } from './src/services/prescriptionAccessService';

const API = process.env.API_URL ?? 'http://localhost:3000';
const PW = 'RxRecords@2026';
const PLACEHOLDER_SIG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let failures = 0;
const assert = (label: string, cond: boolean, detail = '') => {
  if (cond) console.log(`ok   ${label}`);
  else { failures += 1; console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
};

async function login(email: string) {
  const r = await fetch(`${API}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: PW }),
  });
  const body = await r.json() as { token?: string; accessToken?: string };
  return body.token ?? body.accessToken ?? '';
}

(async () => {
  const tempUsers: string[] = [];
  let rootId: string | null = null;
  let doctor: { id: string; userId: string | null; signatureImageBase64: string | null; qualification: string } | null = null;
  let med: { id: string; usageCount: number; lastUsedAt: Date | null } | null = null;
  const t0 = new Date();

  try {
    // A real consultation whose doctor nobody is linked to yet.
    const cv = await prisma.clinicVisit.findFirst({
      where: { status: 'COMPLETED', clinicDoctor: { isActive: true, userId: null }, visit: { status: { not: 'CANCELLED' } } },
      orderBy: { createdAt: 'desc' },
      select: { visitId: true, visit: { select: { branchId: true, patientId: true } }, clinicDoctor: { select: { id: true, userId: true, signatureImageBase64: true, qualification: true } } },
    });
    if (!cv) { console.log('no consultation to test on'); return; }
    doctor = cv.clinicDoctor;
    med = await prisma.medication.findFirst({ where: { source: 'CURATED' }, orderBy: { usageCount: 'desc' }, select: { id: true, usageCount: true, lastUsedAt: true, canonicalName: true } as any }) as any;
    if (!med) { console.log('no curated medicine'); return; }

    const mk = async (role: 'doctor' | 'owner', tag: string) => {
      const u = await prisma.user.create({
        data: { email: `rxrecords.${tag}.${Date.now()}@sobhana.local`, name: `Rx Records ${tag}`, role,
                passwordHash: await bcrypt.hash(PW, 10), activeBranchId: cv.visit.branchId, isActive: true },
        select: { id: true, email: true },
      });
      tempUsers.push(u.id);
      return u;
    };
    const doc = await mk('doctor', 'doctor');
    await prisma.clinicDoctor.update({ where: { id: doctor.id }, data: { userId: doc.id, signatureImageBase64: PLACEHOLDER_SIG } });

    // ── v1 ───────────────────────────────────────────────────────────────────
    const d1 = (await createDraft({ visitId: cv.visitId, branchId: cv.visit.branchId, clinicDoctorId: doctor.id, userId: doc.id, items: [] }))!;
    rootId = d1.rootId;
    const m = await prisma.medication.findUnique({ where: { id: med.id }, select: { canonicalName: true, genericName: true, brandName: true, strength: true, strengthUnit: true, dosageForm: true, route: true } as any }) as any;
    await prisma.prescriptionItem.create({
      data: {
        prescriptionId: d1.id, displayOrder: 0, medicationId: med.id, canonicalName: m.canonicalName,
        genericName: m.genericName, brandName: m.brandName, strength: m.strength ?? '500', strengthUnit: m.strengthUnit ?? 'mg',
        dosageForm: m.dosageForm ?? 'tablet', route: m.route ?? 'oral', doseQty: '1', doseUnit: 'tablet',
        frequencyCode: 'BD', frequencyText: 'twice a day', durationValue: 3, durationUnit: 'days', resolution: 'RESOLVED',
      } as any,
    });
    const v1 = await sign(d1.id, doc.id);
    assert('v1 signs', v1?.status === 'SIGNED', String(v1?.status));
    let s = (await rxSummaries([cv.visitId])).get(cv.visitId);
    assert('record: signed v1, no draft', s?.signed?.id === d1.id && s.signed.version === 1 && !s.draft);

    const token = await createPrescriptionAccessToken(rootId);

    // ── open a correction ────────────────────────────────────────────────────
    const c1 = await amend(d1.id, doc.id, 'check: dose');
    assert('correction opens as v2 draft', c1?.status === 'DRAFT' && c1.version === 2);
    const v1row = await prisma.prescription.findUnique({ where: { id: d1.id }, select: { status: true, isLatest: true } });
    assert('v1 stays SIGNED while the correction is open', v1row?.status === 'SIGNED' && v1row.isLatest === false, JSON.stringify(v1row));
    s = (await rxSummaries([cv.visitId])).get(cv.visitId);
    assert('record: still signed v1, with a correction draft', s?.signed?.id === d1.id && !!s.draft?.isCorrection);
    assert("patient's link still shows v1", (await resolvePrescriptionToken(token))?.id === d1.id);
    const hist = await listForPatient(cv.visit.patientId, 50);
    assert("doctor's history still has v1", hist.some((h) => h.id === d1.id));

    let refused = false;
    try { await amend(d1.id, doc.id, 'check: second'); } catch { refused = true; }
    assert('a second correction while one is open is refused', refused);

    // ── discard it ───────────────────────────────────────────────────────────
    await prisma.prescription.update({ where: { id: d1.id }, data: { audioKey: `check/${d1.id}.webm` } });
    await prisma.prescription.update({ where: { id: c1!.id }, data: { audioKey: `check/${d1.id}.webm` } });
    await discardDraft(c1!.id, doc.id);
    const afterDiscard = await prisma.prescription.findUnique({ where: { id: d1.id }, select: { isLatest: true, audioKey: true } });
    assert('discarding the correction makes v1 latest again', afterDiscard?.isLatest === true);
    assert("v1's shared recording is kept", !!afterDiscard?.audioKey);
    await prisma.prescription.update({ where: { id: d1.id }, data: { audioKey: null } });

    // ── correct and sign ─────────────────────────────────────────────────────
    const c2 = await amend(d1.id, doc.id, 'check: frequency');
    const v2 = await sign(c2!.id, doc.id);
    const old = await prisma.prescription.findUnique({ where: { id: d1.id }, select: { status: true } });
    assert('signing the correction supersedes v1', old?.status === 'SUPERSEDED' && v2?.status === 'SIGNED');
    const snap = v2?.snapshot as any;
    assert('the sheet says what it replaces', snap?.revises?.version === 1 && !!snap?.revises?.signedAt, JSON.stringify(snap?.revises));
    assert("patient's link now shows v2", (await resolvePrescriptionToken(token))?.id === c2!.id);
    s = (await rxSummaries([cv.visitId])).get(cv.visitId);
    assert('record: signed v2, revised', s?.signed?.id === c2!.id && s.signed.revised === true && !s.draft);

    // ── over HTTP, on the deployed API ───────────────────────────────────────
    const own = await mk('owner', 'owner');
    const ownerToken = await login(own.email);
    const H = { Authorization: `Bearer ${ownerToken}`, 'X-Branch-Id': cv.visit.branchId, 'Content-Type': 'application/json' };
    const rec = await fetch(`${API}/api/prescription-records/visit/${cv.visitId}`, { headers: H }).then((r) => r.json()) as any;
    assert('GET records: the signed sheet with its medicines', rec?.prescription?.id === c2!.id && rec.prescription.items?.length === 1, JSON.stringify(rec).slice(0, 160));
    const pr = await fetch(`${API}/api/prescription-records/${c2!.id}/printed`, { method: 'POST', headers: H }).then((r) => r.json()) as any;
    const printed = await prisma.prescription.findUnique({ where: { id: c2!.id }, select: { printedAt: true } });
    assert('POST printed: Print turns green', pr?.ok === true && !!printed?.printedAt);
    const list = await fetch(`${API}/api/visits/clinic?status=COMPLETED&page=1&pageSize=50`, { headers: H }).then((r) => r.json()) as any;
    const row = (list.items ?? []).find((v: any) => v.id === cv.visitId);
    assert('Finalized list carries the record', !row || row.prescription?.signed?.version === 2, JSON.stringify(row?.prescription ?? null).slice(0, 160));

    const docToken = await login(doc.email);
    const DH = { Authorization: `Bearer ${docToken}`, 'X-Branch-Id': cv.visit.branchId, 'Content-Type': 'application/json' };
    const patched = await fetch(`${API}/api/doctor/me`, { method: 'PATCH', headers: DH, body: JSON.stringify({ qualification: `${doctor.qualification} (check)` }) });
    const pBody = await patched.json() as any;
    assert("doctor edits their own profile", patched.ok && pBody?.qualification === `${doctor.qualification} (check)`, `${patched.status} ${JSON.stringify(pBody).slice(0, 120)}`);
    const auditRow = await prisma.auditLog.findFirst({ where: { entityType: 'ClinicDoctor', entityId: doctor.id, userId: doc.id }, orderBy: { createdAt: 'desc' }, select: { oldValues: true, newValues: true } });
    assert('…and the change is audited with before and after', (auditRow?.oldValues as any)?.qualification === doctor.qualification);
    const blank = await fetch(`${API}/api/doctor/me`, { method: 'PATCH', headers: DH, body: JSON.stringify({ registrationNumber: '  ' }) });
    assert('a blank registration number is refused', blank.status === 400);
  } catch (err: any) {
    failures += 1;
    console.log('FAIL ran to completion —', err?.stack ?? err);
  } finally {
    if (rootId) {
      const ids = (await prisma.prescription.findMany({ where: { rootId }, select: { id: true } })).map((r) => r.id);
      await prisma.prescriptionAccessToken.deleteMany({ where: { prescriptionId: rootId } }).catch(() => {});
      await prisma.auditLog.deleteMany({ where: { entityType: { in: ['Prescription', 'PrescriptionAccessToken'] }, entityId: { in: [...ids, rootId] } } }).catch(() => {});
      await prisma.prescription.deleteMany({ where: { rootId } }).catch((e) => { failures += 1; console.error('COULD NOT DELETE the test prescriptions', e); });
    }
    if (doctor) {
      await prisma.clinicDoctor.update({ where: { id: doctor.id }, data: { userId: doctor.userId, signatureImageBase64: doctor.signatureImageBase64, qualification: doctor.qualification } })
        .catch((e) => { failures += 1; console.error('COULD NOT RESTORE the doctor', e); });
      await prisma.auditLog.deleteMany({ where: { entityType: 'ClinicDoctor', entityId: doctor.id, createdAt: { gte: t0 } } }).catch(() => {});
    }
    if (med) await prisma.medication.update({ where: { id: med.id }, data: { usageCount: med.usageCount, lastUsedAt: med.lastUsedAt } }).catch(() => {});
    for (const id of tempUsers) {
      await prisma.auditLog.deleteMany({ where: { userId: id } }).catch(() => {});
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
    console.log('\nrestored: test prescriptions, tokens and audit rows removed; doctor, medicine and logins as they were');
    await prisma.$disconnect();
  }
  console.log(failures === 0 ? 'all clean' : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
