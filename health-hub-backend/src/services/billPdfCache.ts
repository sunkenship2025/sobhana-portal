/**
 * Redis cache for rendered bill PDFs.
 *
 * A bill's PDF is expensive to produce (Puppeteer/Chromium render — the app's
 * main memory driver) but its content is stable: the same bill re-rendered
 * yields identical bytes. Patient-facing WhatsApp bill links are opened
 * repeatedly (and re-opened after the fact), so without a cache every click
 * re-launches a Chromium render for output we already produced.
 *
 * Self-invalidating by design:
 * - The cache key is a hash of the exact HTML that will be rendered, NOT the
 *   bill id. Any change to the bill (discount, refund, void, an added/cancelled
 *   test, a payment) changes the HTML → changes the hash → automatic miss →
 *   re-render. A change to the bill *template* likewise changes the HTML for
 *   every bill, so layout edits self-bust too. There is deliberately NO delete
 *   hook to remember to call — stale entries are simply never read again and
 *   expire via TTL. (Contrast mergedReportPdfCache, which keys on an id and
 *   therefore needs manual deleteCachedMergedPdf on the one mutable path.)
 * - KEY_PREFIX carries a schema version only for changes the HTML can't capture
 *   (e.g. the bill PDFOptions in pdfGenerationService); bump it to invalidate
 *   every cached bill at once with no scan-and-delete.
 * - TTL is 7 days, sized for clinic volumes on the shared free-tier Redis.
 * - Relies on Redis `maxmemory-policy allkeys-lru` to evict cold entries.
 * - Failures are non-fatal: if Redis is unreachable we log and let the caller
 *   render. Never break a patient's bill download because of cache trouble.
 */

import { createHash } from 'crypto';
import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';

// v1: initial bill-PDF cache. Bump only for changes the rendered HTML does NOT
// encode (e.g. the `mode: 'bill'` PDFOptions), since HTML-encoded changes
// (data + template) already bust the content hash on their own.
const KEY_PREFIX = 'bill-pdf:v1:';
const TTL_SECONDS = 7 * 24 * 60 * 60;
const CACHE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — skip outliers so they don't flush LRU

/**
 * Content fingerprint for a bill render: sha256 of the exact HTML. Same HTML →
 * same key → cache hit; any data/template change → different key → miss.
 */
export function billPdfCacheKeyFor(html: string): string {
  return createHash('sha256').update(html).digest('hex');
}

function buildKey(hash: string): string {
  return `${KEY_PREFIX}${hash}`;
}

export async function getCachedBillPdf(hash: string): Promise<Buffer | null> {
  const client = getRedisClient();
  if (!client) return null;

  try {
    return await client.getBuffer(buildKey(hash));
  } catch (err: any) {
    logger.warn({ err, hash }, 'bill-pdf cache: get failed (falling through to render)');
    return null;
  }
}

export async function setCachedBillPdf(hash: string, buffer: Buffer): Promise<void> {
  if (buffer.length > CACHE_MAX_BYTES) {
    logger.warn(
      { hash, sizeBytes: buffer.length, capBytes: CACHE_MAX_BYTES },
      'bill-pdf cache: skipping write, buffer exceeds size cap',
    );
    return;
  }

  const client = getRedisClient();
  if (!client) return;

  try {
    await client.set(buildKey(hash), buffer, 'EX', TTL_SECONDS);
  } catch (err: any) {
    logger.warn({ err, hash }, 'bill-pdf cache: set failed');
  }
}
