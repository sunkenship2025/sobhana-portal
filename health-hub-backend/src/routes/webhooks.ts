/**
 * WhatsApp Webhook Route
 *
 * Handles Meta WhatsApp Cloud API webhooks:
 * - GET  /webhooks/whatsapp — Verification challenge (Meta setup)
 * - POST /webhooks/whatsapp — Delivery status updates (sent → delivered → read)
 *
 * PUBLIC ROUTE — No auth middleware. Mounted before auth in index.ts.
 *
 * The POST handler verifies Meta's `X-Hub-Signature-256` HMAC against the raw
 * request body before doing anything. Without this, anyone can POST forged
 * delivery statuses and corrupt MessageLog. We use express.raw on this route
 * specifically so the signature can be computed over the exact bytes Meta sent
 * (JSON.stringify(req.body) wouldn't reproduce key order or whitespace).
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 */

import crypto from 'crypto';
import express, { Router, Request, Response } from 'express';
import prisma from '../lib/prisma';
import { whatsappWebhookRateLimit } from '../middleware/rateLimit';

const router = Router();

/**
 * Verify Meta's `X-Hub-Signature-256` against the raw body.
 * If WHATSAPP_APP_SECRET is unset (dev / pre-onboarding), logs a warning and
 * accepts the call so onboarding flows still work — but production MUST set it.
 */
function verifyMetaSignature(req: Request, rawBody: Buffer): boolean {
  const appSecret = process.env.WHATSAPP_APP_SECRET || '';
  if (!appSecret) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[Webhook] WHATSAPP_APP_SECRET not set in production — REJECTING');
      return false;
    }
    console.warn('[Webhook] WHATSAPP_APP_SECRET not set — accepting payload (dev only)');
    return true;
  }
  const header = req.header('x-hub-signature-256') || '';
  if (!header.startsWith('sha256=')) return false;
  const provided = header.slice('sha256='.length);
  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex');
  if (provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

/**
 * GET /webhooks/whatsapp
 * Meta verification challenge — called once during webhook setup.
 * Returns hub.challenge if hub.verify_token matches our configured token.
 */
router.get('/', (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || '';

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[Webhook] WhatsApp verification successful');
    return res.status(200).send(challenge);
  }

  console.warn('[Webhook] WhatsApp verification failed — token mismatch');
  return res.status(403).json({ error: 'Verification failed' });
});

/**
 * POST /webhooks/whatsapp
 * Receives delivery status updates from Meta. Updates MessageLog with timestamps.
 *
 * `express.raw` runs BEFORE the global `express.json` for this route, so we
 * capture the unmodified bytes for HMAC verification. After signature check
 * passes, we parse the JSON ourselves.
 */
router.post(
  '/',
  express.raw({ type: 'application/json', limit: '128kb' }),
  whatsappWebhookRateLimit,
  async (req: Request, res: Response) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from('');

    if (!verifyMetaSignature(req, rawBody)) {
      console.warn('[Webhook] Rejected forged or unsigned WhatsApp webhook');
      return res.status(401).json({ error: 'INVALID_SIGNATURE' });
    }

    // Always return 200 immediately — Meta retries on non-200
    res.status(200).json({ status: 'received' });

    try {
      const body = JSON.parse(rawBody.toString('utf8') || '{}');

      if (body.object !== 'whatsapp_business_account') {
        return;
      }

      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const statuses = change.value?.statuses || [];

          for (const status of statuses) {
            const waMessageId = status.id;
            const statusValue = status.status;
            const timestamp = status.timestamp ? new Date(parseInt(status.timestamp) * 1000) : new Date();
            const errorInfo = status.errors?.[0];

            if (!waMessageId) continue;

            const updateData: any = {};

            switch (statusValue) {
              case 'sent':
                updateData.status = 'SENT';
                updateData.sentAt = timestamp;
                break;

              case 'delivered':
                updateData.status = 'DELIVERED';
                updateData.deliveredAt = timestamp;
                break;

              case 'read':
                updateData.status = 'READ';
                updateData.readAt = timestamp;
                break;

              case 'failed':
                updateData.status = 'FAILED';
                updateData.failureReason = errorInfo
                  ? `${errorInfo.code}: ${errorInfo.title} — ${errorInfo.message}`
                  : 'Unknown failure';
                break;

              default:
                console.log(`[Webhook] Unknown status "${statusValue}" for ${waMessageId}`);
                continue;
            }

            const updated = await prisma.messageLog.updateMany({
              where: { waMessageId },
              data: updateData,
            });

            if (updated.count > 0) {
              console.log(`[Webhook] Updated ${waMessageId} → ${statusValue}`);
            }
          }
        }
      }
    } catch (error) {
      // Don't throw — we already sent 200
      console.error('[Webhook] Error processing WhatsApp webhook:', error);
    }
    return;
  },
);

export default router;
