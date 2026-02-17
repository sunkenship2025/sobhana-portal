/**
 * WhatsApp Webhook Route
 * 
 * Handles Meta WhatsApp Cloud API webhooks:
 * - GET  /webhooks/whatsapp — Verification challenge (Meta setup)
 * - POST /webhooks/whatsapp — Delivery status updates (sent → delivered → read)
 * 
 * PUBLIC ROUTE — No auth middleware. Mounted before auth in index.ts.
 * 
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';

const router = Router();
const prisma = new PrismaClient();

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
 * Receives delivery status updates from Meta.
 * Updates MessageLog: SENT → DELIVERED → READ with timestamps.
 * 
 * Payload structure:
 * {
 *   object: "whatsapp_business_account",
 *   entry: [{
 *     changes: [{
 *       value: {
 *         statuses: [{
 *           id: "wamid.xxx",
 *           status: "sent" | "delivered" | "read" | "failed",
 *           timestamp: "1234567890",
 *           errors: [{ code, title, message }]
 *         }]
 *       }
 *     }]
 *   }]
 * }
 */
router.post('/', async (req: Request, res: Response) => {
  // Always return 200 immediately — Meta retries on non-200
  res.status(200).json({ status: 'received' });

  try {
    const body = req.body;

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

          // Map Meta status to our MessageStatus enum
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

          // Update MessageLog by waMessageId
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
});

export default router;
