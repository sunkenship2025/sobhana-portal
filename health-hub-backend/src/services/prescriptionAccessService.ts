/**
 * Prescription Access Token Service
 *
 * The patient's link to their prescription. Mirrors billAccessService exactly —
 * 32 bytes of CSPRNG, only the SHA-256 hash stored, raw token in the URL.
 *
 * The one difference, and it is the important one: the token holds the ROOT
 * prescription id, never a version id, and resolution walks root -> latest
 * SIGNED. Reports already paid for the other design — a token pinned to one
 * version went on serving a superseded document after an amendment, which for a
 * prescription means a patient reading a dosage the doctor has since corrected.
 *
 *   1. createPrescriptionAccessToken(rootId) → raw token (put this in the URL)
 *   2. resolvePrescriptionToken(rawToken)    → the latest signed version, or null
 *   3. recordPrescriptionAccess(...)         → access count + last seen
 */

import crypto from 'crypto';
import prisma from '../lib/prisma';

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * The patient-facing URL for a prescription token.
 *
 * NOT PUBLIC_BILL_BASE_URL. That is the API host (reports.sobhanaportal.com),
 * which serves /bills/view and /reports itself and has no SPA behind it — only
 * /css, /images and /fonts are static there. `/rx/:token` is a CLIENT route, so
 * it resolves on the portal (www.sobhanaportal.com), where the SPA rewrite
 * serves index.html for every path. Building this on the bill base produced a
 * link that 404s, which is the sort of thing you only notice by opening it.
 *
 * One definition because two callers need it — the doctor's Share button and the
 * WhatsApp send — and a link that differs between them is a support ticket.
 */
export function prescriptionLink(token: string): string {
  const base = (process.env.PUBLIC_PORTAL_BASE_URL || 'https://www.sobhanaportal.com').replace(/\/+$/, '');
  return `${base}/rx/${token}`;
}

/**
 * Mints a link for a prescription. `prescriptionId` may be any version — it is
 * normalised to the root, so re-issuing after an amendment cannot fork the link.
 */
export async function createPrescriptionAccessToken(
  prescriptionId: string,
  expiresAt?: Date,
): Promise<string> {
  const rx = await prisma.prescription.findUnique({
    where: { id: prescriptionId },
    select: { rootId: true },
  });
  if (!rx) throw new Error('No such prescription');

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = generateToken();
    try {
      await prisma.prescriptionAccessToken.create({
        data: { token: hashToken(token), prescriptionId: rx.rootId, expiresAt: expiresAt || null },
      });
      return token;
    } catch (err: any) {
      if (err?.code === 'P2002') continue; // hash collision — vanishingly rare
      throw err;
    }
  }
  throw new Error('Failed to generate unique prescription access token');
}

/**
 * The document behind a raw token, or null.
 *
 * Returns the latest SIGNED version of the root. A root whose only version is a
 * draft resolves to null on purpose: an unsigned prescription is not a
 * prescription, and a link that rendered one would be handing a patient a
 * document no doctor has put their registration number to.
 */
export async function resolvePrescriptionToken(rawToken: string) {
  const record = await prisma.prescriptionAccessToken.findUnique({
    where: { token: hashToken(rawToken) },
    select: { prescriptionId: true, expiresAt: true, revokedAt: true },
  });
  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt && record.expiresAt < new Date()) return null;

  return prisma.prescription.findFirst({
    where: { rootId: record.prescriptionId, status: 'SIGNED' },
    orderBy: { version: 'desc' },
    select: {
      id: true, rootId: true, version: true, signedAt: true,
      diagnosis: true, notes: true, followUpDays: true, snapshot: true,
      // The visit's online-access switch, which the view route honours. Not sent
      // to the patient — the route builds its response field by field.
      visit: { select: { patientLinkDisabledAt: true, branch: { select: { name: true } } } },
      // The snapshot freezes WHO and FOR WHOM — doctor, branch, patient, visit —
      // but the medicines are a relation, and a signed prescription's items are
      // immutable by the same rule that forbids editing a signed row at all. So
      // the sheet needs both halves; returning only the snapshot renders a
      // letterhead with an empty ℞, which is the one thing worse than an error.
      //
      // PROJECTED, not the whole row. This endpoint is unauthenticated — the
      // token is the only credential — so the payload is exactly what the sheet
      // prints and nothing else. Whole-row would have shipped `candidates`, the
      // OTHER medicines the resolver weighed and the doctor did not prescribe,
      // onto a patient's prescription page, plus `sourceText`, `fieldStates` and
      // `resolution`, which are our workings and not the patient's document.
      items: {
        orderBy: { displayOrder: 'asc' },
        select: {
          id: true, displayOrder: true,
          canonicalName: true, genericName: true, brandName: true,
          strength: true, strengthUnit: true, dosageForm: true,
          doseQty: true, doseUnit: true,
          frequencyCode: true, frequencyText: true,
          route: true, timing: true,
          durationValue: true, durationUnit: true,
          instructions: true,
          // Rendered on the sheet as 'spoken as "…"', so it stays.
          spokenText: true,
        },
      },
    },
  });
}

/** Access count + last seen. Never throws into the request path. */
export async function recordPrescriptionAccess(rawToken: string, ipAddress?: string): Promise<void> {
  try {
    await prisma.prescriptionAccessToken.updateMany({
      where: { token: hashToken(rawToken) },
      data: {
        accessCount: { increment: 1 },
        lastAccessedAt: new Date(),
        lastAccessedIp: ipAddress ?? null,
      },
    });
  } catch (err) {
    console.error('recordPrescriptionAccess failed:', err);
  }
}
