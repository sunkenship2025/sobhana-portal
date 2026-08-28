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
import { createBillAccessToken } from './billAccessService';
import { issueCoupon } from './couponService';
import { createStatementAccessToken } from './statementAccessService';
import { getPayoutStatement, getPayoutPayeePhone } from './payoutService';
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
  patientId?: string | null;
  phone: string;
  templateName: string;
  templateParams: Prisma.InputJsonValue;
  contextId: string;
  contextType?: MessageContextType;
  branchId?: string | null;
  components: TemplateComponent[];
}) {
  const resolvedContextType = input.contextType ?? MessageContextType.REPORT;

  // Branch attribution: prefer an explicit branchId (e.g. PAYMENT rows whose
  // contextId is a payoutId, not a visitId). Otherwise derive it from the visit
  // for REPORT/BILL. Never throw on a missing visit — fall back to null.
  let branchId: string | null = input.branchId ?? null;
  if (
    branchId === null &&
    (resolvedContextType === MessageContextType.REPORT ||
      resolvedContextType === MessageContextType.BILL)
  ) {
    try {
      const visit = await prisma.visit.findUnique({
        where: { id: input.contextId },
        select: { branchId: true },
      });
      branchId = visit?.branchId ?? null;
    } catch (branchErr: any) {
      log.warn(
        { err: branchErr, contextId: input.contextId },
        'failed to resolve branch for message log — falling back to null',
      );
      branchId = null;
    }
  }

  const messageLog = await prisma.messageLog.create({
    data: {
      patientId: input.patientId ?? null,
      phone: input.phone,
      channel: 'WHATSAPP',
      templateName: input.templateName,
      templateParams: input.templateParams,
      status: 'PENDING',
      contextType: resolvedContextType,
      contextId: input.contextId,
      branchId,
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
    // A Meta API rejection carries a structured error ({ code, message,
    // error_data.details }); a local/network failure (disabled, timeout) does
    // not — then errorCode stays null and we keep the raw message.
    const meta = error?.response?.data?.error;
    const reason: string =
      meta?.error_data?.details || meta?.message || error.message || 'Send failed';
    await prisma.messageLog.update({
      where: { id: messageLog.id },
      data: {
        status: 'FAILED',
        errorCode: meta?.code != null ? String(meta.code) : null,
        failureReason: reason.slice(0, 500),
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

    // Online access switched off for this visit — the link would land the patient
    // on the "collect at the centre" page, so don't send (or bill for) it at all.
    if (info.visit.patientLinkDisabledAt) {
      log.info({ visitId: input.visitId }, 'patient link disabled — skipping report notification');
      return { success: false, error: 'Online access is switched off for this visit' };
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
            { type: 'text', text: info.patient.title ? info.patient.title + '. ' + info.patient.name : info.patient.name },
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

    if (info.visit.patientLinkDisabledAt) {
      log.info({ visitId }, 'patient link disabled — skipping bill notification');
      return;
    }

    const formattedPhone = formatPhoneForWhatsApp(info.phone);
    const billFinancials = computeBillFinancialsFromPersisted(info.bill);
    const amountInRupees = (billFinancials.netAmountInPaise / 100).toLocaleString('en-IN');
    const patientDisplayName = info.patient.title ? info.patient.title + '. ' + info.patient.name : info.patient.name;

    // Try to generate a bill access token for the PDF link (new template with URL button).
    // If token creation fails, fall back to the old text-only bill_receipt template.
    let billToken: string | null = null;
    try {
      billToken = await createBillAccessToken(visitId);
    } catch (tokenErr: any) {
      log.warn({ err: tokenErr, visitId }, 'bill token creation failed — falling back to bill_receipt template');
    }

    const billPublicBaseUrl = process.env.PUBLIC_BILL_BASE_URL || '';
    const usePdfTemplate = Boolean(billToken && billPublicBaseUrl);

    const templateName = 'bill_receipt'; // User overwrote the original template in Meta
    const templateParams: any = {
      patientName: info.patient.name,
      billNumber: info.visit.billNumber,
      amount: `₹${amountInRupees}`,
    };
    if (usePdfTemplate) templateParams.billToken = billToken;

    const components: TemplateComponent[] = usePdfTemplate
      ? [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: patientDisplayName },
              { type: 'text', text: info.visit.billNumber },
              { type: 'text', text: amountInRupees },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: 0,
            parameters: [
              { type: 'text', text: billToken! },
            ],
          },
        ]
      : [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: patientDisplayName },
              { type: 'text', text: info.visit.billNumber },
              { type: 'text', text: amountInRupees },
            ],
          },
        ];

    await createAndSendTemplateMessage({
      patientId: info.patient.id,
      phone: formattedPhone,
      templateName,
      templateParams,
      contextId: visitId,
      contextType: MessageContextType.BILL,
      components,
    });

    log.info({ phone: formattedPhone, visitId, templateName }, 'bill confirmation sent');
  } catch (error: any) {
    log.error({ err: error, visitId }, 'failed to send bill notification');
  }
}

// ============================================================================
// EVENT COUPON  (blood-donation drive, and future campaign events)
// ============================================================================

const COUPON_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function formatCouponExpiry(d: Date): string {
  return `${d.getDate()} ${COUPON_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * EVENT visit → mint a one-time campaign coupon and send its WhatsApp reward.
 * Replaces the bill-receipt send for EVENT visits (e.g. the blood-donation camp).
 * Fire-and-forget from the visit-create post-commit hook. See EVENTS_AND_COUPONS.md.
 */
export async function sendEventCoupon(visitId: string): Promise<void> {
  try {
    if (!isWhatsAppEnabled()) {
      log.info({ visitId }, 'WhatsApp disabled — skipping event coupon');
      return;
    }
    const info = await getPatientNotificationInfo(visitId);
    if (!info) {
      log.info({ visitId }, 'no patient/phone — skipping event coupon');
      return;
    }

    // Which EVENT product was billed → which campaign to mint from.
    const visitInfo = await prisma.visit.findUnique({
      where: { id: visitId },
      select: {
        branchId: true,
        testOrders: {
          where: { workflowMode: DiagnosticWorkflowMode.EVENT },
          select: { productId: true },
          take: 1,
        },
      },
    });
    const productId = visitInfo?.testOrders[0]?.productId ?? null;
    if (!productId) {
      log.info({ visitId }, 'no EVENT order on visit — skipping event coupon');
      return;
    }
    const product = await prisma.billableProduct.findUnique({
      where: { id: productId },
      select: { couponCampaignId: true },
    });
    if (!product?.couponCampaignId) {
      log.warn({ visitId, productId }, 'EVENT product has no couponCampaignId — cannot mint coupon');
      return;
    }
    const campaign = await prisma.couponCampaign.findUnique({
      where: { id: product.couponCampaignId },
      select: { id: true, whatsappTemplate: true, isActive: true },
    });
    if (!campaign || !campaign.isActive) {
      log.warn({ visitId, campaignId: product.couponCampaignId }, 'coupon campaign missing/inactive');
      return;
    }

    // Mint the one-time coupon (own connection — safe post-commit).
    const issued = await issueCoupon({
      campaignId: campaign.id,
      patientId: info.patient.id,
      phone: info.phone,
      issuedVisitId: visitId,
    });

    const formattedPhone = formatPhoneForWhatsApp(info.phone);
    const patientDisplayName = info.patient.title
      ? info.patient.title + '. ' + info.patient.name
      : info.patient.name;
    const expiry = formatCouponExpiry(issued.expiresAt);

    await createAndSendTemplateMessage({
      patientId: info.patient.id,
      phone: formattedPhone,
      templateName: campaign.whatsappTemplate,
      templateParams: { name: info.patient.name, expiry, code: issued.code },
      contextId: visitId,
      contextType: MessageContextType.CAMPAIGN,
      branchId: visitInfo?.branchId ?? null,
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: patientDisplayName },
            { type: 'text', text: expiry },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: 0,
          parameters: [{ type: 'text', text: issued.rawToken }],
        },
      ],
    });

    log.info(
      { visitId, code: issued.code, templateName: campaign.whatsappTemplate },
      'event coupon issued + sent',
    );
  } catch (error: any) {
    log.error({ err: error, visitId }, 'failed to issue/send event coupon');
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

    if (info.visit.patientLinkDisabledAt) {
      return { success: false, error: 'Online access is switched off for this visit' };
    }

    await autoOptIn(info.patient.id, 'STAFF_MANUAL_SEND');

    const formattedPhone = formatPhoneForWhatsApp(info.phone);
    const billFinancials = computeBillFinancialsFromPersisted(info.bill);
    const amountInRupees = (billFinancials.netAmountInPaise / 100).toLocaleString('en-IN');
    const patientDisplayName = info.patient.title ? info.patient.title + '. ' + info.patient.name : info.patient.name;

    // Try to generate a bill access token for the PDF link.
    let billToken: string | null = null;
    try {
      billToken = await createBillAccessToken(visitId);
    } catch (tokenErr: any) {
      log.warn({ err: tokenErr, visitId }, 'bill token creation failed — falling back to bill_receipt template');
    }

    const billPublicBaseUrl = process.env.PUBLIC_BILL_BASE_URL || '';
    const usePdfTemplate = Boolean(billToken && billPublicBaseUrl);

    const templateName = 'bill_receipt'; // User overwrote the original template in Meta
    const templateParams: any = {
      patientName: info.patient.name,
      billNumber: info.visit.billNumber,
      amount: `₹${amountInRupees}`,
      resendBy: staffUserId || null,
    };
    if (usePdfTemplate) templateParams.billToken = billToken;

    const components: TemplateComponent[] = usePdfTemplate
      ? [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: patientDisplayName },
              { type: 'text', text: info.visit.billNumber },
              { type: 'text', text: amountInRupees },
            ],
          },
          {
            type: 'button',
            sub_type: 'url',
            index: 0,
            parameters: [
              { type: 'text', text: billToken! },
            ],
          },
        ]
      : [
          {
            type: 'body',
            parameters: [
              { type: 'text', text: patientDisplayName },
              { type: 'text', text: info.visit.billNumber },
              { type: 'text', text: amountInRupees },
            ],
          },
        ];

    await createAndSendTemplateMessage({
      patientId: info.patient.id,
      phone: formattedPhone,
      templateName,
      templateParams,
      contextId: visitId,
      contextType: MessageContextType.BILL,
      components,
    });

    return { success: true };
  } catch (error: any) {
    log.error({ err: error, visitId }, 'staff bill resend failed');
    return { success: false, error: error.message };
  }
}

// ============================================================================
// PAYOUT STATEMENT NOTIFICATION (to referral doctors / clinics / centers / labs)
// ============================================================================

function formatStatementPeriod(start: string | Date, end: string | Date): string {
  const fmt = (d: Date) =>
    new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(d);
  return `${fmt(new Date(start))} – ${fmt(new Date(end))}`;
}

/**
 * Send a payout statement to its payee on WhatsApp: a summary + a tokenized
 * link to a public read-only statement page. Owner-triggered (manual) — B2B
 * recipient, so no patient opt-in applies. Mirrors resendBillNotification.
 */
export async function sendPayoutStatement(
  payoutId: string,
  branchId: string,
  staffUserId?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isWhatsAppEnabled()) {
      return { success: false, error: 'WhatsApp messaging is not enabled' };
    }

    const statement = await getPayoutStatement(payoutId, branchId);
    if (!statement) {
      return { success: false, error: 'Payout not found' };
    }

    const phone = await getPayoutPayeePhone(payoutId);
    if (!phone) {
      return { success: false, error: 'This payee has no phone number on file' };
    }
    const formattedPhone = formatPhoneForWhatsApp(phone);

    const token = await createStatementAccessToken(payoutId);
    const periodLabel = formatStatementPeriod(statement.periodStartDate, statement.periodEndDate);

    // Message intentionally carries NO amount — just a notice + the secure link;
    // the payee taps through to see the full statement (incl. the amount due).
    await createAndSendTemplateMessage({
      patientId: null,
      phone: formattedPhone,
      templateName: 'payout_statement',
      templateParams: {
        payeeName: statement.payeeName,
        period: periodLabel,
        statementToken: token,
        sentBy: staffUserId || null,
      },
      contextId: payoutId,
      contextType: MessageContextType.PAYMENT,
      branchId,
      components: [
        {
          type: 'body',
          parameters: [
            { type: 'text', text: statement.payeeName },
            { type: 'text', text: periodLabel },
          ],
        },
        {
          type: 'button',
          sub_type: 'url',
          index: 0,
          parameters: [{ type: 'text', text: token }],
        },
      ],
    });

    log.info({ phone: formattedPhone, payoutId }, 'payout statement sent on WhatsApp');
    return { success: true };
  } catch (error: any) {
    log.error({ err: error, payoutId }, 'failed to send payout statement');
    return { success: false, error: error.message };
  }
}
