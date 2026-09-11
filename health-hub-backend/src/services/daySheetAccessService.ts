/**
 * Day Sheet Access Token Service
 *
 * Mirrors billAccessService.ts / reportAccessService.ts exactly — 32 bytes of
 * CSPRNG, only the SHA-256 hash stored, raw token goes in the WhatsApp URL.
 *
 * One difference, deliberate: expiry is REQUIRED, not optional. A bill link is
 * the patient's own receipt and may live forever; this link is a branch's
 * takings for one day, so it dies on a clock whether or not anyone remembers it.
 */
import crypto from 'crypto';
import prisma from '../lib/prisma';

/** How long a nightly link stays usable. Long enough to open it the next morning. */
export const DAY_SHEET_TOKEN_TTL_HOURS = 72;

function generateToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createDaySheetToken(input: {
  branchId: string;
  domain: string;
  sheetDate: string;
  ttlHours?: number;
}): Promise<string> {
  const expiresAt = new Date(
    Date.now() + (input.ttlHours ?? DAY_SHEET_TOKEN_TTL_HOURS) * 3600 * 1000,
  );
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = generateToken();
    try {
      await prisma.daySheetAccessToken.create({
        data: {
          token: hashToken(token),
          branchId: input.branchId,
          domain: input.domain,
          sheetDate: input.sheetDate,
          expiresAt,
        },
      });
      return token;
    } catch (err: any) {
      if (err?.code === 'P2002') continue; // hash collision — vanishingly rare
      throw err;
    }
  }
  throw new Error('Failed to generate unique day sheet access token');
}

export async function validateDaySheetToken(rawToken: string): Promise<{
  id: string;
  branchId: string;
  domain: string;
  sheetDate: string;
} | null> {
  const record = await prisma.daySheetAccessToken.findUnique({
    where: { token: hashToken(rawToken) },
    select: {
      id: true,
      branchId: true,
      domain: true,
      sheetDate: true,
      expiresAt: true,
      revokedAt: true,
    },
  });
  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt < new Date()) return null;
  return {
    id: record.id,
    branchId: record.branchId,
    domain: record.domain,
    sheetDate: record.sheetDate,
  };
}

export async function recordDaySheetAccess(id: string, ipAddress?: string): Promise<void> {
  await prisma.daySheetAccessToken
    .update({
      where: { id },
      data: {
        accessCount: { increment: 1 },
        lastAccessedAt: new Date(),
        lastAccessedIp: ipAddress || null,
      },
    })
    .catch(() => {}); // never let an audit write break the page
}

/** The public URL that goes in the message. Same env shape as reports/bills. */
export function daySheetUrl(rawToken: string): string {
  const base =
    process.env.PUBLIC_DAY_SHEET_BASE_URL ||
    `${new URL(process.env.PUBLIC_REPORT_BASE_URL || 'http://localhost:3000/reports').origin}/day-sheet`;
  return `${base.replace(/\/+$/, '')}/${rawToken}`;
}
