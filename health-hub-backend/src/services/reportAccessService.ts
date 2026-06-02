/**
 * E3-10: Report Access Token Service
 * 
 * Generates and validates secure access tokens for patient report links.
 * Tokens are cryptographically random and unguessable.
 */

import crypto from 'crypto';
import prisma from '../lib/prisma';


/**
 * Generates a cryptographically secure random token.
 * Format: 8 characters, URL-safe (base62-like)
 */
function generateToken(): string {
  // Generate 32 bytes of randomness
  const bytes = crypto.randomBytes(32);
  // Convert to base64url and take first 8 characters
  return bytes
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 12);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

type TokenLookup = {
  id: string;
  reportVersionId: string;
  expiresAt: Date | null;
};

async function findTokenRecord(rawToken: string): Promise<TokenLookup | null> {
  const tokenHash = hashToken(rawToken);

  const hashedRecord = await prisma.reportAccessToken.findUnique({
    where: { // @ts-ignore Prisma types
 token: tokenHash },
    select: {
      id: true,
      reportVersionId: true,
      expiresAt: true,
    },
  });

  if (hashedRecord) {
    return hashedRecord;
  }

  const legacyRecord = await prisma.reportAccessToken.findUnique({
    where: { // @ts-ignore Prisma types
 token: rawToken },
    select: {
      id: true,
      reportVersionId: true,
      expiresAt: true,
    },
  });

  if (!legacyRecord) {
    return null;
  }

  try {
    await prisma.reportAccessToken.update({
      where: { // @ts-ignore Prisma types
 id: legacyRecord.id },
      data: { // @ts-ignore Prisma types
 token: tokenHash },
    });
  } catch (error) {
    console.error('[ReportAccess] Failed to migrate legacy plaintext token:', error);
  }

  return legacyRecord;
}

async function appendAccessLog(
  reportVersionId: string,
  accessType: 'VIEW' | 'DOWNLOAD' | 'PRINT',
  accessedVia: 'TOKEN' | 'STAFF_PORTAL',
  ipAddress?: string,
  userAgent?: string,
  userId?: string
): Promise<void> {
  await (prisma as any).reportAccessLog.create({
    data: { // @ts-ignore Prisma types

      reportVersionId,
      accessType,
      accessedVia,
      ipAddress,
      userAgent,
      userId,
    },
  });
}

/**
 * Creates a new access token for a finalized report.
 * Called during report finalization.
 */
export async function createAccessToken(
  reportVersionId: string,
  expiresAt?: Date
): Promise<string> {
  // Verify report is finalized
  const reportVersion = await prisma.reportVersion.findUnique({
    where: { // @ts-ignore Prisma types
 id: reportVersionId },
    select: { status: true },
  });

  if (!reportVersion) {
    throw new Error(`ReportVersion ${reportVersionId} not found`);
  }

  if (reportVersion.status !== 'FINALIZED') {
    throw new Error('Cannot create access token for non-finalized report');
  }

  // Generate unique token. Try create-then-catch-P2002 instead of pre-checking
  // for existence — the pre-check has a race window where two concurrent
  // create calls can both pass the findUnique and only the second hits a
  // P2002 that the loop wasn't catching, surfacing as a 500.
  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const token = generateToken();
    const tokenHash = hashToken(token);
    try {
      await (prisma as any).reportAccessToken.create({
        data: { // @ts-ignore Prisma types

          token: tokenHash,
          reportVersionId,
          expiresAt: expiresAt || null, // null = never expires (legacy default)
        },
      });
      return token;
    } catch (err: any) {
      if (err?.code === 'P2002') {
        // Collision on the unique `token` column — regenerate and retry.
        continue;
      }
      throw err;
    }
  }

  throw new Error('Failed to generate unique token');
}

/**
 * Validates a token and returns the associated report version ID.
 * Returns null if token is invalid or expired.
 */
export async function validateToken(token: string): Promise<string | null> {
  const accessToken = await findTokenRecord(token);

  if (!accessToken) {
    return null;
  }

  // Check expiry
  if (accessToken.expiresAt && accessToken.expiresAt < new Date()) {
    return null;
  }

  return accessToken.reportVersionId;
}

/**
 * Records an access event for a token.
 * Called when report is viewed or downloaded.
 */
export async function recordAccess(
  token: string,
  accessType: 'VIEW' | 'DOWNLOAD' | 'PRINT',
  ipAddress?: string,
  userAgent?: string,
  userId?: string
): Promise<void> {
  const accessToken = await findTokenRecord(token);

  if (!accessToken) return;

  // Update token access stats
  await prisma.reportAccessToken.update({
    where: { // @ts-ignore Prisma types
 id: accessToken.id },
    data: { // @ts-ignore Prisma types

      accessCount: { increment: 1 },
      lastAccessedAt: new Date(),
      lastAccessedIp: ipAddress,
    },
  });

  await appendAccessLog(
    accessToken.reportVersionId,
    accessType,
    userId ? 'STAFF_PORTAL' : 'TOKEN',
    ipAddress,
    userAgent,
    userId
  );
}

/**
 * Records a staff-portal access event without relying on a bearer token.
 */
export async function recordAccessByReportVersionId(
  reportVersionId: string,
  accessType: 'VIEW' | 'DOWNLOAD' | 'PRINT',
  ipAddress?: string,
  userAgent?: string,
  userId?: string
): Promise<void> {
  await appendAccessLog(
    reportVersionId,
    accessType,
    'STAFF_PORTAL',
    ipAddress,
    userAgent,
    userId
  );
}

/**
 * Gets access statistics for a report.
 */
export async function getAccessStats(reportVersionId: string): Promise<{
  totalViews: number;
  lastAccessed: Date | null;
  accessHistory: {
    type: string;
    via: string;
    at: Date;
    ip: string | null;
  }[];
}> {
  const totalViews = await prisma.reportAccessLog.count({
    where: { // @ts-ignore Prisma types
 reportVersionId },
  });

  const logs = await prisma.reportAccessLog.findMany({
    where: { // @ts-ignore Prisma types
 reportVersionId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      accessType: true,
      accessedVia: true,
      createdAt: true,
      ipAddress: true,
    },
  });

  return {
    totalViews,
    lastAccessed: logs[0]?.createdAt || null,
    accessHistory: logs.map(l => ({
      type: l.accessType,
      via: l.accessedVia,
      at: l.createdAt,
      ip: l.ipAddress,
    })),
  };
}
