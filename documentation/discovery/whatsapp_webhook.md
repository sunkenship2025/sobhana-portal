# File: src/routes/webhooks.ts

## Purpose
Public-facing endpoint receiving Meta WhatsApp Cloud API webhooks. Two methods on `/webhooks/whatsapp`:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/webhooks/whatsapp` | Meta verification challenge (one-time setup) |
| POST | `/webhooks/whatsapp` | Delivery status updates (`sent`, `delivered`, `read`, `failed`) |

## Mount Point

From `src/index.ts`:
```ts
// WhatsApp webhook (public, no auth) - Meta delivery receipts
app.use('/webhooks/whatsapp', webhookRoutes);
```

Per source comment: "PUBLIC ROUTE — No auth middleware. Mounted before auth in index.ts."

## Verification Logic (GET)

```ts
router.get('/', (req, res) => {
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
```

- Reads `hub.mode`, `hub.verify_token`, `hub.challenge` query params.
- Echoes `hub.challenge` back when `hub.mode === 'subscribe'` AND `hub.verify_token` equals `WHATSAPP_VERIFY_TOKEN` env var (string-equality comparison, not constant-time).
- Returns 403 on mismatch.

## HMAC Signature Verification (POST)

Per source comment:
> The POST handler verifies Meta's `X-Hub-Signature-256` HMAC against the raw request body before doing anything. Without this, anyone can POST forged delivery statuses and corrupt MessageLog. We use express.raw on this route specifically so the signature can be computed over the exact bytes Meta sent (`JSON.stringify(req.body)` wouldn't reproduce key order or whitespace).

```ts
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
```

- Algorithm: HMAC-SHA256 over the raw request body, keyed with `WHATSAPP_APP_SECRET`.
- Header: `X-Hub-Signature-256: sha256=<hex>`.
- Comparison is via `crypto.timingSafeEqual` (constant time).
- Production policy: if `WHATSAPP_APP_SECRET` is unset in production, the request is **rejected** (logs `REJECTING`).
- Dev fallback: if `WHATSAPP_APP_SECRET` is unset in non-production, all requests are **accepted** with a warning.
- On signature mismatch: 401 `{ error: 'INVALID_SIGNATURE' }`.

## Inbound Webhook Body Parsing

```ts
router.post(
  '/',
  express.raw({ type: 'application/json', limit: '128kb' }),
  whatsappWebhookRateLimit,
  async (req, res) => {
    const rawBody: Buffer = Buffer.isBuffer(req.body) ? (req.body as Buffer) : Buffer.from('');
    if (!verifyMetaSignature(req, rawBody)) {
      console.warn('[Webhook] Rejected forged or unsigned WhatsApp webhook');
      return res.status(401).json({ error: 'INVALID_SIGNATURE' });
    }

    // Always return 200 immediately — Meta retries on non-200
    res.status(200).json({ status: 'received' });

    try {
      const body = JSON.parse(rawBody.toString('utf8') || '{}');
      if (body.object !== 'whatsapp_business_account') return;
      // ... process body.entry[].changes[].value.statuses[]
    } catch (error) {
      console.error('[Webhook] Error processing WhatsApp webhook:', error);
    }
  },
);
```

- Uses `express.raw({ type: 'application/json', limit: '128kb' })` so the body remains a `Buffer` for HMAC computation.
- Rate limiter: `whatsappWebhookRateLimit` (defined in `src/middleware/rateLimit.ts`).
- The handler **responds 200 immediately** before processing — per source comment: "Meta retries on non-200." Errors during processing are logged but never bubbled.

## Delivery Status Handling

Top-level filter: only processes `body.object === 'whatsapp_business_account'`.

Iterates `body.entry[].changes[].value.statuses[]` and switches on `status.status`:

| Meta status | MessageLog update |
| --- | --- |
| `sent` | `status = 'SENT'`, `sentAt = timestamp` |
| `delivered` | `status = 'DELIVERED'`, `deliveredAt = timestamp` |
| `read` | `status = 'READ'`, `readAt = timestamp` |
| `failed` | `status = 'FAILED'`, `failureReason = "${code}: ${title} — ${message}"` (or "Unknown failure") |
| anything else | logged "Unknown status" and skipped |

Timestamp: `new Date(parseInt(status.timestamp) * 1000)` (Meta sends Unix seconds).

```ts
const updated = await prisma.messageLog.updateMany({
  where: { waMessageId },
  data: updateData,
});
```

- Match key: `MessageLog.waMessageId` (indexed in schema).
- `updateMany` is used so the call is no-op if the message ID is unknown locally.
- No `where: { id: messageLog.id }` lookup — purely keyed by the Meta-assigned `waMessageId`.

## Event Persistence

- Updates land on `MessageLog` rows previously created by `notificationService.createAndSendTemplateMessage`. The webhook does **not** create new `MessageLog` rows.
- No separate event table for raw webhook payloads — only the latest status + timestamps are persisted on `MessageLog`.
- `MessageStatus` enum transitions are not enforced on the DB side (e.g., a `READ` callback could arrive before `DELIVERED` and would overwrite without warning). The handler treats each status callback independently.

## Provider-Specific Parsing

Hard-coded to Meta WhatsApp Cloud API webhook shape. No abstraction for other BSPs (Gupshup/Twilio/Wati). Specifically:
- Top-level shape: `{ object: 'whatsapp_business_account', entry: [{ changes: [{ value: { statuses: [...] } }] }] }`.
- `status.id` is the WhatsApp message ID (matches `MessageLog.waMessageId`).
- `status.errors[0]` carries `{ code, title, message }` for failures.

Inbound user messages (`change.value.messages`) are **not handled** — the handler only consumes `statuses`. Free-form replies from patients would be received but ignored.

## Environment Variables

| Variable | Used in | Required? |
| --- | --- | --- |
| `WHATSAPP_VERIFY_TOKEN` | GET handler | yes (else 403 on every challenge) |
| `WHATSAPP_APP_SECRET` | POST handler HMAC verify | required in production; dev accepts without |

## Architectural Observations (factual)

- The verify-token comparison in the GET handler is `===`, not constant-time — a millisecond timing oracle exists in theory, but Meta only calls this once.
- Webhook acks 200 before persisting; a process crash between ack and DB write loses the event with no replay (Meta won't retry on a 200).
- `body.object` filter only allows `whatsapp_business_account`. Other Meta product types are silently dropped without logging.
- Inbound replies (`messages` array on the same change payload) are not parsed — this means patient replies (consent revocations, "STOP", inbound free-form messages) are not captured.
- No idempotency tracking; if Meta retried a status callback after the 200 ack was lost in the network, the same status would be re-applied (idempotent on field overwrite — same value).

## Raw Source

```ts
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
```

## Notes

- The webhook is the only mechanism that flips `MessageLog.status` from `SENT` → `DELIVERED` → `READ`. Without it, all messages stay in `SENT`.
- Inbound free-form messages from patients are not parsed. Any opt-out / "STOP" message handling would need new code.
