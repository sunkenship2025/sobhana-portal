/**
 * Bill Download Route
 *
 * Public, token-gated bill PDF download for patient-facing WhatsApp links.
 * No authentication required — the token IS the access control.
 *
 * Routes:
 *   GET /bills/view/:token  → Inline PDF (WhatsApp in-app browser opens directly)
 *
 * Rate limiting mirrors reportDownload.ts:
 *   - 30 requests per IP per minute (landing)
 *   - 10 requests per IP+token per minute (per-document)
 */

import { Router, Request, Response } from 'express';
import {
  createRateLimiter,
  getClientIp,
} from '../middleware/rateLimit';
import { validateBillToken, recordBillAccess } from '../services/billAccessService';
import { generateBillPdf, fetchBillData } from '../services/billPdfService';
import { trackLinkAccess } from '../services/linkAccessService';

const router = Router();

// ── Rate limiters ──────────────────────────────────────────────────────────

const billIpRateLimit = createRateLimiter({
  namespace: 'public-bill-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

const billTokenRateLimit = createRateLimiter({
  namespace: 'public-bill-token',
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

// ── Route ──────────────────────────────────────────────────────────────────

/**
 * GET /bills/view/:token
 *
 * Validates the token, fetches bill data, renders the bill as a PDF,
 * and serves it inline so WhatsApp in-app browsers open it directly.
 */
router.get(
  '/:token',
  billIpRateLimit,
  billTokenRateLimit,
  async (req: Request, res: Response) => {
    const { token } = req.params;

    try {
      // 1. Validate token → get visitId
      const visitId = await validateBillToken(token);

      if (!visitId) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).end();
      }

      // 2. Determine domain — try DIAGNOSTICS first, then CLINIC
      //    (bills.ts uses the domain from the URL; we need to detect it here)
      const visit = await import('../lib/prisma').then((m) =>
        m.default.visit.findUnique({
          where: { id: visitId },
          select: { domain: true, billNumber: true },
        }),
      );

      if (!visit) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).end();
      }

      const domain = visit.domain as 'CLINIC' | 'DIAGNOSTICS';

      // 3. Generate PDF — reuse this same token for the report QR (it already
      //    identifies the visit), so no extra token is minted.
      const baseUrl = `${req.protocol}://${req.get('host')}`;
      const result = await generateBillPdf(visitId, domain, { baseUrl, token });

      if (!result) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(404).end();
      }

      // 4. Record access (token counter + unified access log)
      await recordBillAccess(token, req.ip);
      trackLinkAccess(req, { linkType: 'BILL', linkToken: token, contextId: visitId }).catch(() => {});

      // 5. Serve inline PDF (WhatsApp in-app browser opens it)
      const billNumber = result.billData.visit.billNumber || result.billData.visit.visitRef || 'bill';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="Bill-${billNumber}.pdf"`);
      res.setHeader('Content-Length', result.pdfBuffer.length);
      res.setHeader('Cache-Control', 'no-store');
      return res.send(result.pdfBuffer);
    } catch (error) {
      console.error('Error generating bill PDF:', error);
      res.setHeader('Cache-Control', 'no-store');
      return res.status(500).end();
    }
  },
);

export default router;
