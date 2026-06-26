/**
 * Statement Access Token Service
 *
 * Generates and validates secure access tokens for payout-statement links sent to
 * referral doctors / clinics / diagnostic centers / outside labs via WhatsApp.
 * Mirrors billAccessService.ts exactly — SHA-256 hash stored; raw token sent out.
 *
 * Token lifecycle:
 *   1. createStatementAccessToken(payoutId) → raw token (send this in the WhatsApp URL)
 *   2. validateStatementToken(rawToken)     → payoutId (null if invalid/expired)
 *   3. recordStatementAccess(...)           → access-count/lastAccessed update per view
 *
 * Token semantics (inherited from BillAccessToken): reusable (not single-use),
 * optional expiry (NULL = never); the token IS the access control.
 */

import crypto from 'crypto';
import prisma from '../lib/prisma';

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
  payoutId: string;
  expiresAt: Date | null;
} | null> {
  const tokenHash = hashToken(rawToken);
  return prisma.statementAccessToken.findUnique({
    where: { token: tokenHash },
    select: { id: true, payoutId: true, expiresAt: true },
  });
}

/**
 * Creates a new access token for a payout statement.
 * Returns the raw (unhashed) token — this is what goes in the WhatsApp URL.
 * The DB stores only the SHA-256 hash.
 */
export async function createStatementAccessToken(
  payoutId: string,
  expiresAt?: Date,
): Promise<string> {
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const token = generateToken();
    const tokenHash = hashToken(token);
    try {
      await prisma.statementAccessToken.create({
        data: {
          token: tokenHash,
          payoutId,
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
  throw new Error('Failed to generate unique statement access token');
}

/**
 * Validates a raw statement access token.
 * Returns the associated payoutId if valid and not expired; null otherwise.
 */
export async function validateStatementToken(rawToken: string): Promise<string | null> {
  const record = await findTokenRecord(rawToken);
  if (!record) return null;
  if (record.expiresAt && record.expiresAt < new Date()) return null;
  return record.payoutId;
}

/**
 * Records an access event for a statement token (access count + lastAccessedAt/Ip).
 */
export async function recordStatementAccess(
  rawToken: string,
  ipAddress?: string,
): Promise<void> {
  const record = await findTokenRecord(rawToken);
  if (!record) return;

  await prisma.statementAccessToken.update({
    where: { id: record.id },
    data: {
      accessCount: { increment: 1 },
      lastAccessedAt: new Date(),
      lastAccessedIp: ipAddress || null,
    },
  });
}
