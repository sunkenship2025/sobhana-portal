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
import { cleanWaReason } from '../services/whatsappErrors';

const router = Router();

// ── Auto-reply config ──
// Generic auto-reply keeps patients from being ignored while the inbox UI is
// built. Toggle off without a deploy via WHATSAPP_AUTOREPLY_ENABLED=false.
const GENERIC_AUTOREPLY_ENABLED = process.env.WHATSAPP_AUTOREPLY_ENABLED !== 'false';
const GENERIC_AUTOREPLY_TEXT =
  'Thanks for messaging Sobhana Diagnostics 🙏 We have received your message and our team will reply during working hours (8 AM to 8 PM). For anything urgent, please call 040-2308 9999 or 9490 539006.';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Turn a Meta inbound message payload into a storable text body + type.
 * Media bodies are placeholders for Phase 0; the actual file is fetched & stored
 * to R2 in Phase 2.
 */
function extractInbound(msg: any): { body: string; messageType: string } {
  const type: string = msg?.type || 'text';
  switch (type) {
    case 'text':
      return { body: msg.text?.body || '', messageType: 'text' };
    case 'image':
      return { body: msg.image?.caption || '[Image]', messageType: 'image' };
    case 'document':
      return {
        body: msg.document?.caption || `[Document: ${msg.document?.filename || 'file'}]`,
        messageType: 'document',
      };
    case 'audio':
      return { body: '[Voice message]', messageType: 'audio' };
    case 'video':
      return { body: msg.video?.caption || '[Video]', messageType: 'video' };
    case 'location':
      return { body: '[Location]', messageType: 'location' };
    case 'contacts':
      return { body: '[Contact card]', messageType: 'contacts' };
    case 'sticker':
      return { body: '[Sticker]', messageType: 'sticker' };
    case 'button':
      return { body: msg.button?.text || '[Button reply]', messageType: 'button' };
    case 'interactive':
      return {
        body:
          msg.interactive?.button_reply?.title ||
          msg.interactive?.list_reply?.title ||
          '[Interactive reply]',
        messageType: 'interactive',
      };
    default:
      return { body: `[${type} message]`, messageType: 'other' };
  }
}

/**
 * Send a free-form auto-reply and record it on the conversation. Valid because
 * the patient's inbound message just opened the 24h customer-service window.
 */
async function sendAutoReply(
  phone: string,
  text: string,
  conversationId: string,
): Promise<void> {
  const { sendText } = await import('../services/whatsappCloudService');
  const result = await sendText(phone, text);
  const now = new Date();

  await prisma.conversationMessage.create({
    data: {
      conversationId,
      direction: 'OUT',
      body: text,
      messageType: 'text',
      isAutoReply: true,
      waMessageId: result.waMessageId,
    },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { autoRepliedAt: now, lastMessageAt: now },
  });
}

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
                updateData.errorCode = errorInfo?.code != null ? String(errorInfo.code) : null;
                updateData.failureReason = errorInfo ? cleanWaReason(errorInfo) : 'Unknown failure';
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

          // ── Inbound messages → capture + auto-reply ──
          // Every inbound is persisted to the Conversation inbox first (so it is
          // never lost), then answered once with a generic "we got your message"
          // reply, rate-limited to once per 24h per conversation.
          for (const msg of change.value?.messages || []) {
            const from = msg?.from;
            const waId: string | undefined = msg?.id;
            if (!from || msg.type === 'reaction') continue;

            try {
              // Idempotency: Meta retries webhooks — skip messages we've stored.
              if (waId) {
                const seen = await prisma.conversationMessage.findUnique({
                  where: { waMessageId: waId },
                  select: { id: true },
                });
                if (seen) continue;
              }

              const { body: inboundBody, messageType } = extractInbound(msg);
              const preview = inboundBody.slice(0, 200);
              const now = new Date();

              // Derive patient + branch from the most recent message we sent here.
              const lastOutbound = await prisma.messageLog.findFirst({
                where: { phone: from },
                orderBy: { createdAt: 'desc' },
                select: { patientId: true, branchId: true },
              });

              // Upsert the conversation thread.
              const convo = await prisma.conversation.upsert({
                where: { phone: from },
                create: {
                  phone: from,
                  patientId: lastOutbound?.patientId ?? null,
                  branchId: lastOutbound?.branchId ?? null,
                  status: 'OPEN',
                  lastInboundAt: now,
                  lastMessageAt: now,
                  lastPreview: preview,
                  unreadCount: 1,
                },
                update: {
                  // Backfill patient/branch if a later send resolved them.
                  ...(lastOutbound?.patientId ? { patientId: lastOutbound.patientId } : {}),
                  ...(lastOutbound?.branchId ? { branchId: lastOutbound.branchId } : {}),
                  status: 'OPEN',
                  lastInboundAt: now,
                  lastMessageAt: now,
                  lastPreview: preview,
                  unreadCount: { increment: 1 },
                },
              });

              // Persist the inbound message (never lost, even if the reply fails).
              await prisma.conversationMessage.create({
                data: {
                  conversationId: convo.id,
                  direction: 'IN',
                  body: inboundBody,
                  messageType,
                  waMessageId: waId ?? null,
                },
              });

              // ── Generic auto-reply (atomic once-per-24h claim) ──
              // Compare-and-set on autoRepliedAt so concurrent inbound webhooks
              // — e.g. a sender whose own number auto-replies — can't trigger a
              // double, and two bots can't ping-pong.
              if (GENERIC_AUTOREPLY_ENABLED) {
                const claim = await prisma.conversation.updateMany({
                  where: {
                    id: convo.id,
                    OR: [
                      { autoRepliedAt: null },
                      { autoRepliedAt: { lt: new Date(now.getTime() - DAY_MS) } },
                    ],
                  },
                  data: { autoRepliedAt: now },
                });
                if (claim.count === 1) {
                  await sendAutoReply(from, GENERIC_AUTOREPLY_TEXT, convo.id);
                  console.log(`[Webhook] Generic auto-reply sent to ${from}`);
                }
              }
            } catch (inboundErr) {
              console.error('[Webhook] Inbound message handling failed:', inboundErr);
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
