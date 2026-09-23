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
      // The snapshot freezes WHO and FOR WHOM — doctor, branch, patient, visit —
      // but the medicines are a relation, and a signed prescription's items are
      // immutable by the same rule that forbids editing a signed row at all. So
      // the sheet needs both halves; returning only the snapshot renders a
      // letterhead with an empty ℞, which is the one thing worse than an error.
      items: { orderBy: { displayOrder: 'asc' } },
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
