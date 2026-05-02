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

const KEY_PREFIX = 'merged-pdf:v1:';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const CACHE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — skip outliers so they don't flush LRU

function buildKey(reportVersionId: string): string {
  return `${KEY_PREFIX}${reportVersionId}`;
}

export async function getCachedMergedPdf(
  reportVersionId: string,
): Promise<Buffer | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    return await client.getBuffer(buildKey(reportVersionId));
  } catch (err: any) {
    console.warn('[mergedReportPdfCache] get failed:', err?.message);
    return null;
  }
}

export async function setCachedMergedPdf(
  reportVersionId: string,
  buffer: Buffer,
): Promise<void> {
  if (buffer.length > CACHE_MAX_BYTES) {
    console.warn(
      `[mergedReportPdfCache] skipping cache write: buffer ${buffer.length}B exceeds ${CACHE_MAX_BYTES}B cap`,
    );
    return;
  }

  const client = getRedisClient();
  if (!client) return;

  try {
    await client.set(buildKey(reportVersionId), buffer, 'EX', TTL_SECONDS);
  } catch (err: any) {
    console.warn('[mergedReportPdfCache] set failed:', err?.message);
  }
}
