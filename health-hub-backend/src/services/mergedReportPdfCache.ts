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
 * - The "immutable forever" assumption has ONE sanctioned exception: post-billing
 *   corrections (see visitCorrectionService) deliberately amend a finalized
 *   snapshot. Those paths MUST call deleteCachedMergedPdf so the next download
 *   regenerates from the corrected snapshot instead of serving stale bytes.
 * - TTL is 7 days, sized for clinic volumes on a 25-30MB free-tier Redis.
 * - We rely on Redis `maxmemory-policy allkeys-lru` (default on most managed
 *   tiers) to evict cold entries when the budget fills.
 * - Failures are non-fatal: if Redis is unreachable we log and let the caller
 *   regenerate the PDF. Never break the user's download because of cache trouble.
 */

import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';

// v11 -> v12: one-time flush to drop merged PDFs cached from finalized
// snapshots that were later amended by a referral correction before
// deleteCachedMergedPdf existed.
// v12 -> v13: physical keys gained a signature variant (see `variant` below)
// and the lab-incharge show-on-print flag became live rather than frozen, so
// old physical entries used stale keys/logic. Cheap to regenerate at clinic volume.
// v13 -> v14: one-time flush after a manual value correction of a finalized
// report (MONTAZ ALI P-000807, CBP diff count) whose snapshot was patched
// directly; the external Redis has no in-app delete hook, so bump the prefix to
// invalidate the stale cached PDF on the patient's already-sent report link.
// v14 -> v15: report footer changed — note line is now "electronically
// authenticated" and the address/phone is per-branch. Bump to re-render every
// already-cached finalized report with the new footer.
// v15 -> v16: digital report QR moved to the header top-right (was bottom-right)
// and signatures now sit ~2cm above the footer. Re-render cached digital PDFs.
const KEY_PREFIX = 'merged-pdf:v16:';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const CACHE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — skip outliers so they don't flush LRU

export type MergedPdfMode = 'digital' | 'physical';

// Physical prints vary by the LIVE lab-incharge show-signature-on-print flag,
// so it is folded into the cache key as a variant ('sig1'/'sig0'). Flipping the
// toggle therefore reads a different key (miss → regenerate), which makes past
// and future physical prints follow the current setting with no explicit
// invalidation; the superseded entry just expires. Digital always signs, so it
// has no variant. All physical variants that can exist for a version:
const PHYSICAL_VARIANTS = ['sig1', 'sig0'] as const;

function buildKey(reportVersionId: string, mode: MergedPdfMode, variant?: string): string {
  return `${KEY_PREFIX}${mode}:${reportVersionId}${variant ? `:${variant}` : ''}`;
}

export async function getCachedMergedPdf(
  reportVersionId: string,
  mode: MergedPdfMode,
  variant?: string,
): Promise<Buffer | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    return await client.getBuffer(buildKey(reportVersionId, mode, variant));
  } catch (err: any) {
    logger.warn({ err, reportVersionId, mode, variant }, 'merged-pdf cache: get failed (falling through to regenerate)');
    return null;
  }
}

export async function setCachedMergedPdf(
  reportVersionId: string,
  mode: MergedPdfMode,
  buffer: Buffer,
  variant?: string,
): Promise<void> {
  if (buffer.length > CACHE_MAX_BYTES) {
    logger.warn(
      { reportVersionId, mode, variant, sizeBytes: buffer.length, capBytes: CACHE_MAX_BYTES },
      'merged-pdf cache: skipping write, buffer exceeds size cap',
    );
    return;
  }

  const client = getRedisClient();
  if (!client) return;

  try {
    await client.set(buildKey(reportVersionId, mode, variant), buffer, 'EX', TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ err, reportVersionId, mode, variant }, 'merged-pdf cache: set failed');
  }
}

/**
 * Drop every cached key for a report version — digital plus all physical
 * signature variants. Call after any correction that amends a finalized
 * snapshot, otherwise the public download keeps serving the pre-correction PDF
 * until its 7-day TTL lapses. Best-effort: a Redis miss or unreachable client
 * is fine (the entry simply expires / never existed).
 */
export async function deleteCachedMergedPdf(reportVersionId: string): Promise<void> {
  const client = getRedisClient();
  if (!client) return;

  try {
    await client.del(
      buildKey(reportVersionId, 'digital'),
      ...PHYSICAL_VARIANTS.map((variant) => buildKey(reportVersionId, 'physical', variant)),
    );
  } catch (err: any) {
    logger.warn({ err, reportVersionId }, 'merged-pdf cache: delete failed');
  }
}
