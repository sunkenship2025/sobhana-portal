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
    where: { // @ts-ignore Prisma types
 id: visitId },
    include: {
      patient: {
        include: {
          identifiers: {
            where: { // @ts-ignore Prisma types
 type: 'PHONE', isPrimary: true },
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
    where: { // @ts-ignore Prisma types
 id: visitId },
    include: {
      patient: {
        include: {
          identifiers: {
            where: { // @ts-ignore Prisma types
 type: 'PHONE', isPrimary: true },
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
            where: { // @ts-ignore Prisma types
 status: 'FINALIZED' },
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
    where: { // @ts-ignore Prisma types
 visitId },
    select: {
      versions: {
        where: { // @ts-ignore Prisma types
 status: 'FINALIZED' },
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
    data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

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
      where: { // @ts-ignore Prisma types
 id: messageLog.id },
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        waMessageId: result.waMessageId,
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    return result;
  } catch (error: any) {
    await prisma.messageLog.update({
      where: { // @ts-ignore Prisma types
 id: messageLog.id },
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

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
    where: { // @ts-ignore Prisma types
 id: patientId },
    select: { whatsappOptIn: true },
  });

  if (patient && !patient.whatsappOptIn) {
    await prisma.patient.update({
      where: { // @ts-ignore Prisma types
 id: patientId },
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

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
              { type: 'text', text: info.patient.title ? info.patient.title + '. ' + info.patient.name : info.patient.name },
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
    where: { // @ts-ignore Prisma types
 id: visitId },
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
            { type: 'text', text: info.patient.title ? info.patient.title + '. ' + info.patient.name : info.patient.name },
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
