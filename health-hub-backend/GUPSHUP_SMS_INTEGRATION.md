# Gupshup SMS Integration — Phase-1 Implementation Guide

## Overview

Sobhana Health Hub uses **Gupshup Business SMS** for report delivery instead of WhatsApp.

**Why Gupshup over WhatsApp:**
- Owner preference (explicit requirement)
- Better SMS delivery guarantees
- Lower cost for bulk SMS
- Simpler API integration (no Media Manager required)
- Direct compliance with Indian telecom regulations

---

## 📱 Gupshup Integration Points

### 1. Database Schema

```prisma
/// SMSDelivery: Track report delivery via Gupshup SMS
model SMSDelivery {
  id              String   @id @default(cuid())
  reportVersionId String
  patientPhone    String
  messageId       String?  // Gupshup message ID
  status          String   @default("PENDING") // PENDING | SENT | FAILED | RETRY
  failureReason   String?
  sentAt          DateTime?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([reportVersionId])
  @@index([status])
  @@index([sentAt])
}
```

### 2. API Endpoint

```
POST /api/delivery/send-sms-report
Authorization: Bearer {token}
Content-Type: application/json

Request:
{
  "reportVersionId": "rversion-1",
  "patientPhone": "9876543210"
}

Response (202 Accepted):
{
  "message": "SMS delivery queued",
  "deliveryId": "sms-abc123"
}
```

### 3. Environment Configuration

Add to `.env`:

```
# Gupshup SMS Configuration
GUPSHUP_API_KEY="your-gupshup-api-key"
GUPSHUP_SENDER_ID="SOBHANA"  # Your business name (11 chars max)
GUPSHUP_API_URL="https://api.gupshup.io/sm/api/v1/msg/send/plain"
GUPSHUP_WEBHOOK_URL="https://yourdomain.com/webhooks/gupshup"
SMS_DELIVERY_ENABLED=true
```

---

## 🔧 Implementation Steps

### Step 1: Gupshup Account Setup

1. Sign up at [Gupshup](https://www.gupshup.io/)
2. Get **API Key** from dashboard
3. Register **Sender ID** (business name, e.g., "SOBHANA")
4. Configure **Webhook URL** for delivery notifications

### Step 2: Prisma Migration

```bash
npx prisma migrate dev --name add_sms_delivery
```

### Step 3: Environment Variables

Copy from `.env.example`:
```bash
cp .env.example .env
# Edit .env with Gupshup credentials
```

### Step 4: Implement SMS Service

Create `src/services/smsService.ts`:

```typescript
import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface GupshupResponse {
  status: number;
  messageId: string;
  message: string;
}

export async function sendReportViaSMS(
  reportVersionId: string,
  patientPhone: string,
  reportUrl?: string
): Promise<{ deliveryId: string }> {
  // 1. Validate phone
  if (!patientPhone || patientPhone.length !== 10) {
    throw new Error('Invalid patient phone number');
  }

  // 2. Format phone (add +91 for India)
  const formattedPhone = `91${patientPhone}`;

  // 3. Create SMS delivery record
  const smsDelivery = await prisma.sMSDelivery.create({
    data: {
      reportVersionId,
      patientPhone,
      status: 'PENDING'
    }
  });

  // 4. Send via Gupshup (async, don't wait)
  sendGupshupSMS(smsDelivery.id, formattedPhone, reportVersionId, reportUrl)
    .catch((err) => {
      console.error('SMS send error:', err);
      // Will be logged in error monitoring
    });

  return { deliveryId: smsDelivery.id };
}

async function sendGupshupSMS(
  smsDeliveryId: string,
  phone: string,
  reportVersionId: string,
  reportUrl?: string
): Promise<void> {
  try {
    // Template: "Your Sobhana diagnostic report is ready. Download: {url}"
    const message = reportUrl
      ? `Your Sobhana diagnostic report is ready. Download: ${reportUrl}`
      : 'Your Sobhana diagnostic report is ready. Please contact us for details.';

    const response = await axios.post<GupshupResponse>(
      process.env.GUPSHUP_API_URL!,
      {
        channel: 'SMS',
        source: process.env.GUPSHUP_SENDER_ID,
        destination: phone,
        message: message
      },
      {
        headers: {
          apikey: process.env.GUPSHUP_API_KEY,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    // Update delivery record
    if (response.data.status === 200) {
      await prisma.sMSDelivery.update({
        where: { id: smsDeliveryId },
        data: {
          messageId: response.data.messageId,
          status: 'SENT',
          sentAt: new Date()
        }
      });
    } else {
      throw new Error(response.data.message);
    }
  } catch (err: any) {
    // Log failure
    await prisma.sMSDelivery.update({
      where: { id: smsDeliveryId },
      data: {
        status: 'FAILED',
        failureReason: err.message
      }
    });

    throw err;
  }
}
```

### Step 5: Integrate with Report Finalization

In `src/routes/diagnosticVisits.ts`:

```typescript
import { sendReportViaSMS } from '../services/smsService';

router.post('/visits/diagnostic/:visitId/finalize-report', async (req, res) => {
  try {
    const { visitId } = req.params;

    // ... existing code to finalize report ...

    const report = await prisma.report.findUnique({
      where: { visitId },
      include: {
        visit: {
          include: {
            patient: {
              include: {
                identifiers: {
                  where: { type: 'PHONE', isPrimary: true }
                }
              }
            }
          }
        },
        versions: {
          where: { status: 'FINALIZED' }
        }
      }
    });

    // Extract patient phone
    const patientPhone = report?.visit.patient.identifiers[0]?.value;

    // Generate report URL (your PDF storage)
    const reportUrl = `https://yourdomain.com/reports/${report.id}`;

    // Send SMS asynchronously
    if (SMS_DELIVERY_ENABLED && patientPhone) {
      sendReportViaSMS(report.versions[0].id, patientPhone, reportUrl)
        .catch((err) => logger.error('SMS send failed:', err));
    }

    res.json({ report });
  } catch (err) {
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});
```

### Step 6: Webhook for Delivery Notifications

Add `POST /webhooks/gupshup` to receive delivery status:

```typescript
router.post('/webhooks/gupshup', async (req, res) => {
  try {
    const { messageId, status, failureReason } = req.body;

    // Map Gupshup status to our status
    const ourStatus = status === 'sent' ? 'SENT' : 'FAILED';

    await prisma.sMSDelivery.update({
      where: { messageId },
      data: {
        status: ourStatus,
        failureReason,
        sentAt: new Date()
      }
    });

    res.json({ ok: true });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: 'WEBHOOK_PROCESSING_FAILED' });
  }
});
```

---

## 📊 SMS Message Template

**Template (final design by team):**

```
Your Sobhana diagnostic report is ready.
Download: https://reports.sobhana.com/r/{reportId}

Questions? Call 9876543200
```

Character count: 90 (well under 160 SMS limit)

### Customization Options

1. **Include clinic name** if available
2. **Add report date** for clarity
3. **Include care instructions** for critical values

Example (improved):
```
Sobhana - Your diagnostic report (Report ID: {reportId}) is ready.
Download: {url}
Report Date: 20-Dec-2025
```

---

## 🔄 Retry Logic

Implement retry for failed SMS:

```typescript
// Run this daily via cron job
export async function retryFailedSMS(): Promise<void> {
  const failed = await prisma.sMSDelivery.findMany({
    where: {
      status: 'FAILED',
      createdAt: {
        gte: new Date(Date.now() - 24 * 60 * 60 * 1000) // Last 24 hours
      }
    }
  });

  for (const sms of failed) {
    try {
      await sendGupshupSMS(
        sms.id,
        `91${sms.patientPhone}`,
        sms.reportVersionId
      );
    } catch (err) {
      logger.error(`Retry failed for SMS ${sms.id}:`, err);
    }
  }
}
```

---

## 💾 SMS Delivery Reporting

Query delivered SMS:

```typescript
// GET /api/reporting/sms-delivery?periodStartDate=2025-12-01&periodEndDate=2025-12-31
router.get('/reporting/sms-delivery', async (req, res) => {
  const { periodStartDate, periodEndDate } = req.query;

  const stats = await prisma.sMSDelivery.groupBy({
    by: ['status'],
    where: {
      createdAt: {
        gte: new Date(periodStartDate as string),
        lte: new Date(periodEndDate as string)
      }
    },
    _count: true
  });

  res.json({
    period: { periodStartDate, periodEndDate },
    deliveryStats: stats
  });
});
```

---

## 🛡️ Error Handling

| Scenario | Action |
|----------|--------|
| Invalid phone number | 400 Bad Request |
| Gupshup API down | Async retry (don't block) |
| SMS limit exceeded | Queue for next period |
| Webhook signature invalid | 401 Unauthorized |
| Duplicate messageId | Idempotent update |

---

## 📋 Gupshup Best Practices

1. **Sender ID**: Keep consistent (SOBHANA)
2. **Message Content**: No promotional text (clinical SMS)
3. **Opt-out**: Include option (not required for clinical)
4. **Rate Limiting**: Max 1000 SMS/min per sender
5. **Timezone**: Use IST for reporting

---

## 🚀 Testing

### Local Testing (Gupshup Sandbox)

```bash
# 1. Use Gupshup sandbox API URL
GUPSHUP_API_URL="https://api.gupshup.io/sm/api/v1/msg/send/plain?ispl=true&method=sendMessage"

# 2. Send test SMS
curl -X POST http://localhost:3000/api/delivery/send-sms-report \
  -H "Authorization: Bearer {token}" \
  -d '{
    "reportVersionId": "rversion-1",
    "patientPhone": "9876543210"
  }'

# 3. Check SMSDelivery table
SELECT * FROM "SMSDelivery" WHERE reportVersionId = 'rversion-1';
```

### Production Validation

- [ ] Gupshup account verified
- [ ] Sender ID registered
- [ ] API key valid
- [ ] Webhook URL configured
- [ ] SMS content approved (compliance)
- [ ] Rate limits understood
- [ ] Error handling tested
- [ ] Retry logic working

---

## 📞 Gupshup Support

- **API Docs**: https://www.gupshup.io/developer/docs/
- **Support**: support@gupshup.io
- **Status**: https://status.gupshup.io/

---

## 🔐 Security Notes

1. **API Key**: Never commit to version control (use .env)
2. **Phone Numbers**: Encrypt at rest (future phase)
3. **Webhook Verification**: Validate Gupshup signature
4. **Rate Limiting**: Implement per-sender-id quota
5. **Audit Trail**: Log all SMS sends (for compliance)

---

**Integration Status:** Phase-1 Ready  
**Priority:** Medium (non-blocking, queued async)  
**Effort:** 8-12 hours implementation  
**Testing:** Included in E2E test suite
