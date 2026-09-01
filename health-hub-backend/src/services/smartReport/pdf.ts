/**
 * Lazy PDF render + Redis cache. NEVER called at finalize — this repo has already
 * had one Puppeteer OOM on a 512MB box, so generation writes a row and the browser
 * only starts when someone actually asks for the PDF.
 */
import { createHash } from 'node:crypto';
import { generatePdfFromHtml } from '../pdfGenerationService';
import { getRedisClient } from '../../lib/redis';
import { logger } from '../../lib/logger';

const KEY_PREFIX = 'smartpdf:v1';
const TTL_SECONDS = 60 * 60 * 24 * 7;

export async function smartReportPdf(reportVersionId: string, html: string): Promise<Buffer> {
  const key = `${KEY_PREFIX}:${reportVersionId}:${createHash('sha1').update(html).digest('hex').slice(0, 12)}`;
  try {
    const redis = getRedisClient();
    if (redis) {
      const hit = await redis.getBuffer(key);
      if (hit) return hit;
    }
  } catch (err) {
    logger.warn({ err }, 'smart report pdf cache read failed'); // Redis down must not 500
  }

  const pdf = await generatePdfFromHtml(html, { mode: 'digital' });

  try {
    const redis = getRedisClient();
    if (redis) await redis.set(key, pdf, 'EX', TTL_SECONDS);
  } catch { /* cache write is best-effort */ }

  return pdf;
}
