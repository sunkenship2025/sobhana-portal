/**
 * Bill Access Token Service
 *
 * Generates and validates secure access tokens for patient bill PDF links sent via WhatsApp.
 * Mirrors reportAccessService.ts exactly — SHA-256 hash stored; raw token sent to patient.
 *
 * Token lifecycle:
 *   1. createBillAccessToken(visitId)  → raw token (send this in WhatsApp URL)
 *   2. validateBillToken(rawToken)     → visitId (null if invalid/expired)
 *   3. recordBillAccess(...)           → audit log update on each view
 */

import crypto from 'crypto';
import prisma from '../lib/prisma';

// ============================================================================
// INTERNALS
// ============================================================================

function generateToken(): string {
  const bytes = crypto.randomBytes(32);
  return bytes
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 12);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function findTokenRecord(rawToken: string): Promise<{
  id: string;
  visitId: string;
  expiresAt: Date | null;
} | null> {
  const tokenHash = hashToken(rawToken);
  return prisma.billAccessToken.findUnique({
    where: { token: tokenHash },
    select: { id: true, visitId: true, expiresAt: true },
  });
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Creates a new access token for a bill (linked to visitId).
 * Returns the raw (unhashed) token — this is what goes in the WhatsApp URL.
 * The DB stores only the SHA-256 hash.
 */
export async function createBillAccessToken(
  visitId: string,
  expiresAt?: Date,
): Promise<string> {
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const token = generateToken();
    const tokenHash = hashToken(token);
    try {
      await prisma.billAccessToken.create({
        data: {
          token: tokenHash,
          visitId,
          expiresAt: expiresAt || null,
        },
      });
      return token;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Hash collision — extremely rare; retry
        continue;
      }
      throw err;
    }
  }
  throw new Error('Failed to generate unique bill access token');
}

/**
 * Validates a raw bill access token.
 * Returns the associated visitId if valid and not expired; null otherwise.
 */
export async function validateBillToken(rawToken: string): Promise<string | null> {
  const record = await findTokenRecord(rawToken);
  if (!record) return null;
  if (record.expiresAt && record.expiresAt < new Date()) return null;
  return record.visitId;
}

/**
 * Records an access event for a bill token (updates access count + lastAccessedAt/Ip).
 */
export async function recordBillAccess(
  rawToken: string,
  ipAddress?: string,
): Promise<void> {
  const record = await findTokenRecord(rawToken);
  if (!record) return;

  await prisma.billAccessToken.update({
    where: { id: record.id },
    data: {
      accessCount: { increment: 1 },
      lastAccessedAt: new Date(),
      lastAccessedIp: ipAddress || null,
    },
  });
}
