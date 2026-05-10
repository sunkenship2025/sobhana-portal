# File: src/services/notificationService.ts (+ whatsappCloudService.ts)

## Purpose
Orchestrates outbound messaging to patients. From the source comment:

> Supports:
> - Bill confirmation at billing time
> - Diagnostic report-ready notices for finalized report visits
>   - `lab_report_ready` → final/complete report (visit fully done)
>   - `lab_report_partial_ready` → partial release: some tests ready, more coming

## Dependencies / Imports

```ts
import {
  DiagnosticWorkflowMode,
  MessageContextType,
  Prisma,
} from '@prisma/client';
import {
  sendTemplate,
  isWhatsAppEnabled,
  formatPhoneForWhatsApp,
  type TemplateComponent,
} from './whatsappCloudService';
import prisma from '../lib/prisma';
import { createAccessToken } from './reportAccessService';
import { computeBillFinancialsFromPersisted } from './billFinancialService';
import { logger as rootLogger } from '../lib/logger';
```

Pino-style logger via `.child({ component: 'notificationService' })`.

## Provider Integrations (factual)

- **Provider:** Meta WhatsApp Cloud API (`graph.facebook.com/v21.0`).
- Wrapper module: `src/services/whatsappCloudService.ts` (HTTP via `axios`, 10-second timeout).
- API endpoint: `POST {phoneNumberId}/messages`.
- Authentication: `Authorization: Bearer ${WHATSAPP_ACCESS_TOKEN}`.
- Template-only (no free-form messaging): "Handles template message sending only — no free-form messaging." (source comment in `whatsappCloudService.ts`).
- Phone normalization: `formatPhoneForWhatsApp()` handles `9876543210`, `09876543210`, `+919876543210`, `919876543210` → returns `919876543210` (Indian-only logic — assumes country code 91 if 10 digits).
- Gated by `WHATSAPP_ENABLED === 'true'` env flag (defaults false). When disabled, all functions either return early with a "disabled" message or throw.

## SMS / Email Fallback Status

- The schema defines `MessageChannel` as `WHATSAPP | SMS`, but **the service has no SMS sending code path**. All `messageLog.create()` calls hard-code `channel: 'WHATSAPP'`.
- No email integration exists in this service.
- "WhatsApp + SMS fallback" is mentioned in the file's top docstring but the SMS path is **not implemented**.

## Retry Logic

- **No retry implementation in this service.**
- On send failure, `createAndSendTemplateMessage()` updates the `MessageLog` row to `status: FAILED` with `failureReason: error.message?.slice(0, 500)` and rethrows.
- Callers in `diagnosticVisits.ts` swallow the error in fire-and-forget `.catch()` blocks.
- Resend is manual via the staff-facing `resendReportNotification()` and `resendBillNotification()` exports.

## Template Handling

| Template name | When sent | Components passed |
| --- | --- | --- |
| `bill_receipt` | Bill creation (visit POST) and manual resend | `body` with `[patientName, billNumber, amount]` |
| `lab_report_ready` | Final finalize | `body` with `[patientName, billNumber]` + `button[sub_type=url, index=0]` carrying `[reportToken]` |
| `lab_report_partial_ready` | Partial release finalize, or manual resend on a non-COMPLETED visit | Same components as `lab_report_ready` |

Template selection in `dispatchDiagnosticCompletionNotification` is driven by:
```ts
const PARTIAL_TEMPLATE_NAME = 'lab_report_partial_ready';
const FINAL_TEMPLATE_NAME = 'lab_report_ready';
const templateName = kind === 'partial' ? PARTIAL_TEMPLATE_NAME : FINAL_TEMPLATE_NAME;
```

Template URL params include the report token (used to build a public URL via `PUBLIC_REPORT_BASE_URL`):
```ts
const reportUrl = `${process.env.PUBLIC_REPORT_BASE_URL || 'http://localhost:3000/reports'}/${link.reportToken}`;
```

## Synchronous vs Async Execution

- Within the service: synchronous in the sense that `await sendTemplate(...)` is awaited, and the `MessageLog` row is updated to `SENT` or `FAILED` before returning.
- **Outside the service** (callers in `diagnosticVisits.ts`): all calls use **dynamic `import("../services/notificationService")`** in fire-and-forget mode, with a `.catch()` swallow:

```ts
import("../services/notificationService").then(({ sendReportReady }) => {
  sendReportReady(visit.id, accessToken, kind).catch((err) =>
    console.error("[Notification] Report notification failed (non-blocking):", err),
  );
});
```

Notification failure never fails the originating HTTP request.

## Opt-in Gating

- Patients have `whatsappOptIn: Boolean` on the `Patient` model.
- `sendBillConfirmation` / automatic `sendReportReady` calls **early-return** when `!info.whatsappOptIn`.
- Manual triggers (`resendReportNotification` with `manual: true`, `resendBillNotification`) call `autoOptIn(patientId, source)` first; this updates the patient row with `whatsappOptIn: true`, `whatsappOptInAt: now`, `whatsappOptInSource: source`.
- Recognized opt-in sources: `STAFF_MANUAL_SEND` (and `PATIENT_REGISTRATION_FORM`, `POST_FINALIZE_AUTO` per schema comment).

## MessageLog Lifecycle

For every send, `createAndSendTemplateMessage` does:

1. `prisma.messageLog.create({ status: 'PENDING', channel: 'WHATSAPP', templateName, templateParams (Json), contextType, contextId })`.
2. `await sendTemplate(phone, templateName, components)`.
3. On success: `update({ waMessageId, status: 'SENT', sentAt: now })`.
4. On failure: `update({ status: 'FAILED', failureReason: error.message?.slice(0, 500) })` and rethrow.

`DELIVERED` and `READ` statuses are written by the **inbound webhook** handler (`routes/webhooks.ts`), not by this service.

## Exported Functions

| Export | Purpose |
| --- | --- |
| `autoOptIn(patientId, source)` | Idempotently set `whatsappOptIn=true` if not yet opted in |
| `sendReportReady(visitId, preIssuedToken?, kind?)` | Fire report-ready WhatsApp template (used by finalize flow) |
| `sendBillConfirmation(visitId)` | Fire `bill_receipt` WhatsApp template |
| `resendReportNotification(visitId, staffUserId?)` | Manual resend; auto-opt-ins patient; selects `partial`/`final` based on `Visit.status` |
| `resendBillNotification(visitId, staffUserId?)` | Manual bill resend; auto-opt-ins patient |
| Type alias: `ReportNotificationKind = 'partial' \| 'final'` |

## Error Handling

- `sendBillConfirmation`: try/catch returns void; logs `'failed to send bill notification'` and swallows.
- `dispatchDiagnosticCompletionNotification`: returns `{ success, error? }`. Logs `'report-ready notification sent'` or `'failed to send diagnostic report notification'`.
- `sendTemplate` (in whatsappCloudService): throws on disabled, missing creds, missing message ID, or network error.

## Architectural Observations (factual)

- The fire-and-forget pattern from callers means notification durability is not guaranteed; if the process restarts after the HTTP response but before `sendTemplate` resolves, the `MessageLog` row stays `PENDING` indefinitely.
- There is no background worker / job queue in this service. The "PENDING" status is reachable in the DB but is only transient inside one process.
- `templateParams` (Json) is stored alongside the rendered components — useful for replay/debug but not used by the send path.
- `bill_receipt` template body uses `Intl.toLocaleString('en-IN')` formatting for the amount text.
- Phone normalization assumes Indian numbering plan; non-Indian numbers passed in unmodified would be sent as-is and could produce errors at the provider.

## Raw Source: notificationService.ts

```ts
/**
 * Notification Service
 *
 * Orchestrates outbound messaging (WhatsApp + SMS fallback).
 * Supports:
 * - Bill confirmation at billing time
 * - Diagnostic report-ready notices for finalized report visits
 *   - lab_report_ready          → final/complete report (visit fully done)
 *   - lab_report_partial_ready  → partial release: some tests ready, more coming
 */

export type ReportNotificationKind = 'partial' | 'final';
const PARTIAL_TEMPLATE_NAME = 'lab_report_partial_ready';
const FINAL_TEMPLATE_NAME = 'lab_report_ready';

import {
  DiagnosticWorkflowMode,
  MessageContextType,
  Prisma,
} from '@prisma/client';
import {
  sendTemplate,
  isWhatsAppEnabled,
  formatPhoneForWhatsApp,
  type TemplateComponent,
} from './whatsappCloudService';
import prisma from '../lib/prisma';
import { createAccessToken } from './reportAccessService';
import { computeBillFinancialsFromPersisted } from './billFinancialService';
import { logger as rootLogger } from '../lib/logger';

const log = rootLogger.child({ component: 'notificationService' });

type NotificationInfo = Awaited<ReturnType<typeof getPatientNotificationInfo>>;
type DiagnosticNotificationInfo = Awaited<ReturnType<typeof getDiagnosticVisitNotificationInfo>>;

// ============================================================================
// HELPERS
// ============================================================================

async function getPatientNotificationInfo(visitId: string) {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      patient: {
        include: {
          identifiers: {
            where: { type: 'PHONE', isPrimary: true },
            take: 1,
          },
        },
      },
      bill: true,
    },
  });

  if (!visit) return null;

  const phone = visit.patient.identifiers[0]?.value;
  if (!phone) return null;

  return {
    visit,
    patient: visit.patient,
    phone,
    whatsappOptIn: visit.patient.whatsappOptIn,
    bill: visit.bill,
  };
}

async function getDiagnosticVisitNotificationInfo(visitId: string) {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      patient: {
        include: {
          identifiers: {
            where: { type: 'PHONE', isPrimary: true },
            take: 1,
          },
        },
      },
      bill: true,
      testOrders: {
        select: {
          workflowMode: true,
        },
      },
      report: {
        select: {
          versions: {
            where: { status: 'FINALIZED' },
            orderBy: { versionNum: 'desc' },
            take: 1,
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!visit) {
    return null;
  }

  const phone = visit.patient.identifiers[0]?.value;
  if (!phone) {
    return null;
  }

  const hasReportableOrders = visit.testOrders.some(
    (order) => order.workflowMode === DiagnosticWorkflowMode.REPORTABLE
  );
  const hasExternalUploadOrders = visit.testOrders.some(
    (order) => order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD
  );
  // The report-ready message ships when the visit produces a patient-facing
  // PDF — that's REPORTABLE values, EXTERNAL_UPLOAD attached PDFs, or both.
  const hasReportInclusionOrders = hasReportableOrders || hasExternalUploadOrders;
  return {
    visit,
    patient: visit.patient,
    phone,
    whatsappOptIn: visit.patient.whatsappOptIn,
    hasReportableOrders,
    hasExternalUploadOrders,
    hasReportInclusionOrders,
  };
}

async function issueReportLinkForVisit(
  visitId: string,
  preIssuedToken?: string
): Promise<{
  reportToken: string;
  reportVersionId: string;
} | null> {
  const report = await prisma.diagnosticReport.findUnique({
    where: { visitId },
    select: {
      versions: {
        where: { status: 'FINALIZED' },
        orderBy: { versionNum: 'desc' },
        take: 1,
        select: { id: true },
      },
    },
  });

  const reportVersionId = report?.versions?.[0]?.id;
  if (!reportVersionId) {
    return null;
  }

  const reportToken = preIssuedToken || await createAccessToken(reportVersionId);

  return {
    reportToken,
    reportVersionId,
  };
}

async function createAndSendTemplateMessage(input: {
  patientId: string;
  phone: string;
  templateName: string;
  templateParams: Prisma.InputJsonValue;
  contextId: string;
  contextType?: MessageContextType;
  components: TemplateComponent[];
}) {
  const messageLog = await prisma.messageLog.create({
    data: {
      patientId: input.patientId,
      phone: input.phone,
      channel: 'WHATSAPP',
      templateName: input.templateName,
      templateParams: input.templateParams,
      status: 'PENDING',
      contextType: input.contextType ?? MessageContextType.REPORT,
      contextId: input.contextId,
    },
  });

  try {
    const result = await sendTemplate(input.phone, input.templateName, input.components);

    await prisma.messageLog.update({
      where: { id: messageLog.id },
      data: {
        waMessageId: result.waMessageId,
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    return result;
  } catch (error: any) {
    await prisma.messageLog.update({
      where: { id: messageLog.id },
      data: {
        status: 'FAILED',
        failureReason: error.message?.slice(0, 500),
      },
    });

    throw error;
  }
}

/**
 * Auto opt-in a patient if they haven't explicitly opted in yet.
 * Used when staff triggers a manual send — implies consent.
 */
export async function autoOptIn(patientId: string, source: string) {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    select: { whatsappOptIn: true },
  });

  if (patient && !patient.whatsappOptIn) {
    await prisma.patient.update({
      where: { id: patientId },
      data: {
        whatsappOptIn: true,
        whatsappOptInAt: new Date(),
        whatsappOptInSource: source,
      },
    });
  }
}

// ============================================================================
// DIAGNOSTIC COMPLETION NOTIFICATIONS
// ============================================================================

async function dispatchDiagnosticCompletionNotification(input: {
  visitId: string;
  preIssuedToken?: string;
  staffUserId?: string;
  manual?: boolean;
  kind?: ReportNotificationKind;
}): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isWhatsAppEnabled()) {
      return { success: false, error: 'WhatsApp messaging is not enabled' };
    }

    const info = await getDiagnosticVisitNotificationInfo(input.visitId);
    if (!info) {
      return { success: false, error: 'Patient or phone not found' };
    }

    if (input.manual) {
      await autoOptIn(info.patient.id, 'STAFF_MANUAL_SEND');
    } else if (!info.whatsappOptIn) {
      log.info(
        { patientId: info.patient.id, visitId: input.visitId },
        'patient not opted in — skipping diagnostic report notification',
      );
      return { success: true };
    }

    if (!info.hasReportInclusionOrders) {
      return { success: false, error: 'This visit does not have a report-ready notification flow' };
    }

    const formattedPhone = formatPhoneForWhatsApp(info.phone);

    const link = await issueReportLinkForVisit(input.visitId, input.preIssuedToken);
    if (!link) {
      return { success: false, error: 'Report not finalized or no access token' };
    }

    const reportUrl = `${process.env.PUBLIC_REPORT_BASE_URL || 'http://localhost:3000/reports'}/${link.reportToken}`;
    const kind: ReportNotificationKind = input.kind ?? 'final';
    const templateName = kind === 'partial' ? PARTIAL_TEMPLATE_NAME : FINAL_TEMPLATE_NAME;

    await createAndSendTemplateMessage({
      patientId: info.patient.id,
      phone: formattedPhone,
      templateName,
      templateParams: {
        patientName: info.patient.name,
        billNumber: info.visit.billNumber,
        reportUrl,
        reportToken: link.reportToken,
        reportVersionId: link.reportVersionId,
        hasReportLink: true,
        kind,
        resendBy: input.staffUserId || null,
      },
      contextId: input.visitId,
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: info.patient.name },
            { type: 'text', text: info.visit.billNumber },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: 0,
          parameters: [
            { type: 'text', text: link.reportToken },
          ],
        },
      ],
    });

    log.info(
      { phone: formattedPhone, visitId: input.visitId, reportVersionId: link.reportVersionId, kind, templateName },
      'report-ready notification sent',
    );
    return { success: true };
  } catch (error: any) {
    log.error(
      { err: error, visitId: input.visitId },
      'failed to send diagnostic report notification',
    );
    return { success: false, error: error.message };
  }
}

/**
 * Backward-compatible wrapper used by report finalization flow.
 * `kind` defaults to 'final' (lab_report_ready template). Pass 'partial' from the
 * partial-release flow so the patient gets the lab_report_partial_ready template instead.
 */
export async function sendReportReady(
  visitId: string,
  preIssuedToken?: string,
  kind: ReportNotificationKind = 'final',
): Promise<void> {
  await dispatchDiagnosticCompletionNotification({
    visitId,
    preIssuedToken,
    manual: false,
    kind,
  });
}

// ============================================================================
// BILL CONFIRMATION NOTIFICATION
// ============================================================================

export async function sendBillConfirmation(visitId: string): Promise<void> {
  try {
    if (!isWhatsAppEnabled()) {
      log.info({ visitId }, 'WhatsApp disabled — skipping bill notification');
      return;
    }

    const info = await getPatientNotificationInfo(visitId);
    if (!info) {
      log.info({ visitId }, 'no patient/phone found — skipping bill notification');
      return;
    }

    if (!info.whatsappOptIn) {
      log.info({ patientId: info.patient.id, visitId }, 'patient not opted in — skipping bill notification');
      return;
    }

    if (!info.bill) {
      log.info({ visitId }, 'no bill found — skipping bill notification');
      return;
    }

    const formattedPhone = formatPhoneForWhatsApp(info.phone);
    const billFinancials = computeBillFinancialsFromPersisted(info.bill);
    const amountInRupees = (billFinancials.netAmountInPaise / 100).toLocaleString('en-IN');

    await createAndSendTemplateMessage({
      patientId: info.patient.id,
      phone: formattedPhone,
      templateName: 'bill_receipt',
      templateParams: {
        patientName: info.patient.name,
        billNumber: info.visit.billNumber,
        amount: `₹${amountInRupees}`,
      },
      contextId: visitId,
      contextType: MessageContextType.BILL,
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: info.patient.name },
            { type: 'text', text: info.visit.billNumber },
            { type: 'text', text: amountInRupees },
          ],
        },
      ],
    });

    log.info({ phone: formattedPhone, visitId }, 'bill confirmation sent');
  } catch (error: any) {
    log.error({ err: error, visitId }, 'failed to send bill notification');
  }
}

// ============================================================================
// STAFF MANUAL RESEND
// ============================================================================

/**
 * Backward-compatible manual resend entry point.
 * Picks the partial vs final template from the visit's current state — a visit
 * still IN_PROGRESS (or WAITING) means the latest finalized version is a partial
 * release, so the partial template is appropriate.
 */
export async function resendReportNotification(
  visitId: string,
  staffUserId?: string
): Promise<{ success: boolean; error?: string }> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: { status: true },
  });
  const kind: ReportNotificationKind = visit?.status === 'COMPLETED' ? 'final' : 'partial';
  return dispatchDiagnosticCompletionNotification({
    visitId,
    staffUserId,
    manual: true,
    kind,
  });
}

export async function resendBillNotification(
  visitId: string,
  staffUserId?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isWhatsAppEnabled()) {
      return { success: false, error: 'WhatsApp messaging is not enabled' };
    }

    const info = await getPatientNotificationInfo(visitId);
    if (!info || !info.bill) {
      return { success: false, error: 'Patient, phone, or bill not found' };
    }

    await autoOptIn(info.patient.id, 'STAFF_MANUAL_SEND');

    const formattedPhone = formatPhoneForWhatsApp(info.phone);
    const billFinancials = computeBillFinancialsFromPersisted(info.bill);
    const amountInRupees = (billFinancials.netAmountInPaise / 100).toLocaleString('en-IN');

    await createAndSendTemplateMessage({
      patientId: info.patient.id,
      phone: formattedPhone,
      templateName: 'bill_receipt',
      templateParams: {
        patientName: info.patient.name,
        billNumber: info.visit.billNumber,
        amount: `₹${amountInRupees}`,
        resendBy: staffUserId || null,
      },
      contextId: visitId,
      contextType: MessageContextType.BILL,
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: info.patient.name },
            { type: 'text', text: info.visit.billNumber },
            { type: 'text', text: amountInRupees },
          ],
        },
      ],
    });

    return { success: true };
  } catch (error: any) {
    log.error({ err: error, visitId }, 'staff bill resend failed');
    return { success: false, error: error.message };
  }
}
```

## Raw Source: whatsappCloudService.ts

```ts
/**
 * WhatsApp Cloud API Service
 * 
 * Thin wrapper around Meta's WhatsApp Cloud API (graph.facebook.com/v21.0).
 * Handles template message sending only — no free-form messaging.
 * 
 * Gated by WHATSAPP_ENABLED env var (defaults to false).
 * All failures throw — caller is responsible for error handling and logging.
 * 
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api/guides/send-messages
 */

import axios from 'axios';

// ============================================================================
// CONFIGURATION
// ============================================================================

const WHATSAPP_API_VERSION = 'v21.0';
const WHATSAPP_API_BASE = `https://graph.facebook.com/${WHATSAPP_API_VERSION}`;

function getConfig() {
  return {
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
    enabled: process.env.WHATSAPP_ENABLED === 'true',
  };
}

// ============================================================================
// TYPES
// ============================================================================

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  sub_type?: 'url' | 'quick_reply';
  index?: number;
  parameters: TemplateParameter[];
}

export interface TemplateParameter {
  type: 'text' | 'document' | 'image';
  text?: string;
  document?: { link: string; filename: string };
  image?: { link: string };
}

export interface SendTemplateResult {
  waMessageId: string;
  success: boolean;
}

// ============================================================================
// CORE API
// ============================================================================

/**
 * Send a WhatsApp template message to a phone number.
 * 
 * @param phone - Phone number in international format (e.g., "919876543210")
 * @param templateName - HSM template name approved by Meta (e.g., "lab_report_ready")
 * @param components - Template variable components (header, body, button params)
 * @param languageCode - Template language (default: "en")
 * @returns waMessageId for tracking delivery status
 * @throws Error if WHATSAPP_ENABLED is false or API call fails
 */
export async function sendTemplate(
  phone: string,
  templateName: string,
  components: TemplateComponent[] = [],
  languageCode: string = 'en',
): Promise<SendTemplateResult> {
  const config = getConfig();

  if (!config.enabled) {
    throw new Error('WhatsApp messaging is disabled (WHATSAPP_ENABLED != true)');
  }

  if (!config.phoneNumberId || !config.accessToken) {
    throw new Error('WhatsApp Cloud API credentials not configured');
  }

  // Normalize phone: strip leading + if present, ensure starts with country code
  const normalizedPhone = phone.replace(/^\+/, '').replace(/\s/g, '');

  const payload: any = {
    messaging_product: 'whatsapp',
    to: normalizedPhone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
    },
  };

  // Only include components if there are any
  if (components.length > 0) {
    payload.template.components = components;
  }

  const response = await axios.post(
    `${WHATSAPP_API_BASE}/${config.phoneNumberId}/messages`,
    payload,
    {
      headers: {
        'Authorization': `Bearer ${config.accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000, // 10s timeout
    },
  );

  // Meta returns: { messaging_product: "whatsapp", contacts: [...], messages: [{ id: "wamid.xxx" }] }
  const waMessageId = response.data?.messages?.[0]?.id;

  if (!waMessageId) {
    throw new Error(`WhatsApp API returned no message ID. Response: ${JSON.stringify(response.data)}`);
  }

  return {
    waMessageId,
    success: true,
  };
}

/**
 * Check if WhatsApp messaging is enabled.
 * Use this to gate UI buttons and skip notification calls.
 */
export function isWhatsAppEnabled(): boolean {
  return getConfig().enabled;
}

/**
 * Format an Indian phone number for WhatsApp API.
 * Accepts: "9876543210", "09876543210", "+919876543210", "919876543210"
 * Returns: "919876543210" (no + prefix, with country code)
 */
export function formatPhoneForWhatsApp(phone: string): string {
  const cleaned = phone.replace(/[\s\-\+\(\)]/g, '');

  // Already has country code
  if (cleaned.startsWith('91') && cleaned.length === 12) {
    return cleaned;
  }

  // Strip leading 0 if present
  const withoutLeadingZero = cleaned.startsWith('0') ? cleaned.slice(1) : cleaned;

  // Add country code if 10 digits
  if (withoutLeadingZero.length === 10) {
    return `91${withoutLeadingZero}`;
  }

  // Return as-is if we can't normalize
  return cleaned;
}
```

## Notes

- The doc comment claims SMS fallback support; the implementation does not include any SMS sending.
- Configuration is read on every call via `getConfig()` (no module-load caching) — env-var changes between calls would be picked up.
- BSP details (Meta Cloud API direct, not via Twilio/Gupshup/Wati) are confirmed by `graph.facebook.com/v21.0` URL.
