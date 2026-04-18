/**
 * Notification Service
 *
 * Orchestrates outbound messaging (WhatsApp + SMS fallback).
 * Supports:
 * - Bill confirmation at billing time
 * - Diagnostic report-ready notices for finalized report visits
 *   - lab_report_ready
 */

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
  return {
    visit,
    patient: visit.patient,
    phone,
    whatsappOptIn: visit.patient.whatsappOptIn,
    hasReportableOrders,
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
      console.log(`[Notification] Patient ${info.patient.id} not opted in — skipping diagnostic report notification`);
      return { success: true };
    }

    if (!info.hasReportableOrders) {
      return { success: false, error: 'This visit does not have a report-ready notification flow' };
    }

    const formattedPhone = formatPhoneForWhatsApp(info.phone);

    const link = await issueReportLinkForVisit(input.visitId, input.preIssuedToken);
    if (!link) {
      return { success: false, error: 'Report not finalized or no access token' };
    }

    const reportUrl = `${process.env.PUBLIC_REPORT_BASE_URL || 'http://localhost:3000/reports'}/${link.reportToken}`;

    await createAndSendTemplateMessage({
      patientId: info.patient.id,
      phone: formattedPhone,
      templateName: 'lab_report_ready',
      templateParams: {
        patientName: info.patient.name,
        billNumber: info.visit.billNumber,
        reportUrl,
        reportToken: link.reportToken,
        reportVersionId: link.reportVersionId,
        hasReportLink: true,
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

    console.log(
      `[Notification] Report-ready notification sent to ${formattedPhone} for visit ${input.visitId}`
    );
    return { success: true };
  } catch (error: any) {
    console.error(
      `[Notification] Failed to send diagnostic report notification for visit ${input.visitId}:`,
      error.message
    );
    return { success: false, error: error.message };
  }
}

/**
 * Backward-compatible wrapper used by report finalization flow.
 * Only finalized report visits use the existing lab_report_ready template.
 */
export async function sendReportReady(visitId: string, preIssuedToken?: string): Promise<void> {
  await dispatchDiagnosticCompletionNotification({
    visitId,
    preIssuedToken,
    manual: false,
  });
}

// ============================================================================
// BILL CONFIRMATION NOTIFICATION
// ============================================================================

export async function sendBillConfirmation(visitId: string): Promise<void> {
  try {
    if (!isWhatsAppEnabled()) {
      console.log(`[Notification] WhatsApp disabled — skipping bill notification for visit ${visitId}`);
      return;
    }

    const info = await getPatientNotificationInfo(visitId);
    if (!info) {
      console.log(`[Notification] No patient/phone found for visit ${visitId}`);
      return;
    }

    if (!info.whatsappOptIn) {
      console.log(`[Notification] Patient ${info.patient.id} not opted in — skipping bill notification`);
      return;
    }

    if (!info.bill) {
      console.log(`[Notification] No bill found for visit ${visitId}`);
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

    console.log(
      `[Notification] Bill confirmation sent to ${formattedPhone} for visit ${visitId}`
    );
  } catch (error: any) {
    console.error(
      `[Notification] Failed to send bill notification for visit ${visitId}:`,
      error.message
    );
  }
}

// ============================================================================
// STAFF MANUAL RESEND
// ============================================================================

/**
 * Backward-compatible manual resend entry point.
 * Only finalized report visits can send the report-ready template.
 */
export async function resendReportNotification(
  visitId: string,
  staffUserId?: string
): Promise<{ success: boolean; error?: string }> {
  return dispatchDiagnosticCompletionNotification({
    visitId,
    staffUserId,
    manual: true,
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
    console.error(`[Notification] Staff bill resend failed for visit ${visitId}:`, error.message);
    return { success: false, error: error.message };
  }
}
