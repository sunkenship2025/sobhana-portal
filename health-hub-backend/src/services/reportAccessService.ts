/**
 * E3-10: Report Access Token Service
 * 
 * Generates and validates secure access tokens for patient report links.
 * Tokens are cryptographically random and unguessable.
 */

import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

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

  // Check if token already exists
  const existing = await prisma.reportAccessToken.findFirst({
    where: { reportVersionId },
    select: { token: true },
  });

  if (existing) {
    return existing.token;
  }

  // Generate unique token
  let token = generateToken();
  let attempts = 0;
  const maxAttempts = 10;

  while (attempts < maxAttempts) {
    const exists = await prisma.reportAccessToken.findUnique({
      where: { token },
    });
    
    if (!exists) break;
    token = generateToken();
    attempts++;
  }

  if (attempts >= maxAttempts) {
    throw new Error('Failed to generate unique token');
  }

  // Create token record
  await prisma.reportAccessToken.create({
    data: {
      token,
      reportVersionId,
      expiresAt: expiresAt || null, // null = never expires
    },
  });

  return token;
}

/**
 * Validates a token and returns the associated report version ID.
 * Returns null if token is invalid or expired.
 */
export async function validateToken(token: string): Promise<string | null> {
  const accessToken = await prisma.reportAccessToken.findUnique({
    where: { token },
    select: {
      reportVersionId: true,
      expiresAt: true,
    },
  });

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
  const accessToken = await prisma.reportAccessToken.findUnique({
    where: { token },
    select: { id: true, reportVersionId: true },
  });

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

  // Create access log entry
  await prisma.reportAccessLog.create({
    data: {
      reportVersionId: accessToken.reportVersionId,
      accessType,
      accessedVia: userId ? 'STAFF_PORTAL' : 'TOKEN',
      ipAddress,
      userAgent,
      userId,
    },
  });
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
  const token = await prisma.reportAccessToken.findFirst({
    where: { reportVersionId },
    select: {
      accessCount: true,
      lastAccessedAt: true,
    },
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
    totalViews: token?.accessCount || 0,
    lastAccessed: token?.lastAccessedAt || null,
    accessHistory: logs.map(l => ({
      type: l.accessType,
      via: l.accessedVia,
      at: l.createdAt,
      ip: l.ipAddress,
    })),
  };
}
