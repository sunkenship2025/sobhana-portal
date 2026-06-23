/**
 * Redis cache for finalized merged-report PDFs.
 *
 * Finalized snapshots are immutable — the merged PDF for a given
 * `reportVersionId` is therefore stable forever. We cache the bytes in Redis so
 * repeat downloads (patient re-opens, staff downloads, doctor views) skip the
 * entire pipeline.
 *
 * Design notes:
 * - Key is prefixed with a schema version so a branding/layout change can
 *   invalidate the entire cache by bumping the prefix (no scan-and-delete).
 * - TTL is 7 days, sized for clinic volumes on a 25-30MB free-tier Redis.
 * - We rely on Redis `maxmemory-policy allkeys-lru` (default on most managed
 *   tiers) to evict cold entries when the budget fills.
 * - Failures are non-fatal: if Redis is unreachable we log and let the caller
 *   regenerate the PDF. Never break the user's download because of cache trouble.
 */

import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';

const KEY_PREFIX = 'merged-pdf:v10:';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const CACHE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — skip outliers so they don't flush LRU

export type MergedPdfMode = 'digital' | 'physical';

function buildKey(reportVersionId: string, mode: MergedPdfMode): string {
  return `${KEY_PREFIX}${mode}:${reportVersionId}`;
}

export async function getCachedMergedPdf(
  reportVersionId: string,
  mode: MergedPdfMode,
): Promise<Buffer | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    return await client.getBuffer(buildKey(reportVersionId, mode));
  } catch (err: any) {
    logger.warn({ err, reportVersionId, mode }, 'merged-pdf cache: get failed (falling through to regenerate)');
    return null;
  }
}

export async function setCachedMergedPdf(
  reportVersionId: string,
  mode: MergedPdfMode,
  buffer: Buffer,
): Promise<void> {
  if (buffer.length > CACHE_MAX_BYTES) {
    logger.warn(
      { reportVersionId, mode, sizeBytes: buffer.length, capBytes: CACHE_MAX_BYTES },
      'merged-pdf cache: skipping write, buffer exceeds size cap',
    );
    return;
  }

  const client = getRedisClient();
  if (!client) return;

  try {
    await client.set(buildKey(reportVersionId, mode), buffer, 'EX', TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ err, reportVersionId, mode }, 'merged-pdf cache: set failed');
  }
}
