/**
 * Statement View Route (public)
 *
 * Token-gated, no-auth read access to a payout statement for the WhatsApp link
 * sent to referral doctors / clinics / diagnostic centers / outside labs.
 * The token IS the access control. Mirrors billDownload.ts (rate-limited,
 * no-store), but returns JSON for the public React statement page rather than a
 * streamed PDF (there is no server-side statement PDF renderer).
 *
 *   GET /statements/view/:token  → { data: PayoutStatement }
 */

import { Router, Request, Response } from 'express';
import { createRateLimiter, getClientIp } from '../middleware/rateLimit';
import { validateStatementToken, recordStatementAccess } from '../services/statementAccessService';
import { getPayoutDetail, buildPayoutStatementDetail } from '../services/payoutService';

const router = Router();

const ipRateLimit = createRateLimiter({
  namespace: 'public-statement-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

const tokenRateLimit = createRateLimiter({
  namespace: 'public-statement-token',
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

router.get(
  '/:token',
  ipRateLimit,
  tokenRateLimit,
  async (req: Request, res: Response) => {
    const { token } = req.params;
    try {
      const payoutId = await validateStatementToken(token);
      if (!payoutId) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Statement not found' });
      }

      // getPayoutDetail returns null for soft-deleted payouts → 404 (link dies with the payout).
      const detail = await getPayoutDetail(payoutId);
      if (!detail) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).json({ error: 'NOT_FOUND', message: 'Statement not found' });
      }

      const statement = buildPayoutStatementDetail(detail);
      await recordStatementAccess(token, req.ip);

      res.setHeader('Cache-Control', 'no-store');
      return res.json({ data: statement });
    } catch (error) {
      console.error('Public statement view error:', error);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load statement' });
    }
  },
);

export default router;
