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
 * Format: ~43 chars, URL-safe base64url (256 bits of entropy).
 */
function generateToken(): string {
  // 32 bytes of CSPRNG → full base64url (~256 bits). No truncation: an
  // unauthenticated bearer token needs >=128 bits of entropy. Only the SHA-256
  // hash is stored, so token length doesn't change storage, and existing
  // shorter tokens keep validating.
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

type TokenLookup = {
  id: string;
  reportVersionId: string;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

async function findTokenRecord(rawToken: string): Promise<TokenLookup | null> {
  const tokenHash = hashToken(rawToken);

  const hashedRecord = await prisma.reportAccessToken.findUnique({
    where: { token: tokenHash },
    select: {
      id: true,
      reportVersionId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (hashedRecord) {
    return hashedRecord;
  }

  const legacyRecord = await prisma.reportAccessToken.findUnique({
    where: { token: rawToken },
    select: {
      id: true,
      reportVersionId: true,
      expiresAt: true,
      revokedAt: true,
    },
  });

  if (!legacyRecord) {
    return null;
  }

  try {
    await prisma.reportAccessToken.update({
      where: { id: legacyRecord.id },
      data: { token: tokenHash },
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
  await prisma.reportAccessLog.create({
    data: {
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
    where: { id: reportVersionId },
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
      await prisma.reportAccessToken.create({
        data: {
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

  // Revoked when the underlying bill/report was voided (full cancellation/refund).
  if (accessToken.revokedAt) {
    return null;
  }

  // Check expiry
  if (accessToken.expiresAt && accessToken.expiresAt < new Date()) {
    return null;
  }

  // Follow the REPORT, not the version the token was minted against.
  //
  // The patient's WhatsApp link is created with no expiresAt (= never expires),
  // pinned to one reportVersionId. Without this, a report amended/corrected/
  // reissued after that message went out would keep serving the SUPERSEDED
  // version from that link forever — the patient re-opens the old WhatsApp
  // message and reads withdrawn medical results.
  //
  // Resolving to the newest FINALIZED version of the same report is exactly the
  // rule the bill-QR gateway already applies on every scan, so the two public
  // entry points now agree. Scoped through `report.versions.some(id)`, so it can
  // only ever move within the report this token was issued for.
  //
  // Partial releases upgrade the same way by design: a link handed out after a
  // partial release starts showing the full report once it is finalized.
  const latestFinalized = await prisma.reportVersion.findFirst({
    where: {
      status: 'FINALIZED',
      report: { versions: { some: { id: accessToken.reportVersionId } } },
    },
    orderBy: { versionNum: 'desc' },
    select: { id: true },
  });

  // Fall back to the pinned version if the lookup finds nothing (tokens are only
  // minted for FINALIZED versions, so this is defensive) — never fail a valid
  // patient link over this.
  return latestFinalized?.id ?? accessToken.reportVersionId;
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
    where: { id: accessToken.id },
    data: {
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
    where: { reportVersionId },
  });

  const logs = await prisma.reportAccessLog.findMany({
    where: { reportVersionId },
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
