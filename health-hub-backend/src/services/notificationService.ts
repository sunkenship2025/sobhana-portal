/**
 * Notification Service
 * 
 * Orchestrates outbound messaging (WhatsApp + SMS fallback).
 * Two immediate methods: sendReportReady and sendBillConfirmation.
 * 
 * All methods are fire-and-forget safe — they catch errors internally
 * and log to MessageLog with FAILED status. Callers should NOT await these
 * in the critical path (use .catch(() => {}) pattern).
 * 
 * Template tone: Purely informational. No marketing language.
 */

import {
  sendTemplate,
  isWhatsAppEnabled,
  formatPhoneForWhatsApp,
  type TemplateComponent,
} from './whatsappCloudService';
import prisma from '../lib/prisma';
import { createAccessToken } from './reportAccessService';


// ============================================================================
// HELPERS
// ============================================================================

/**
 * Look up patient phone + opt-in status for a visit.
 * Returns null if patient has no phone or hasn't opted in.
 */
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
// REPORT READY NOTIFICATION
// ============================================================================

/**
 * Send "Your diagnostic report is ready" WhatsApp message.
 * Called after report finalization (POST /:id/finalize).
 * 
 * Template: lab_report_ready
 * Params: patient name, bill number, report download URL
 * Tone: Informational only.
 */
export async function sendReportReady(visitId: string, preIssuedToken?: string): Promise<void> {
  try {
    if (!isWhatsAppEnabled()) {
      console.log(`[Notification] WhatsApp disabled — skipping report notification for visit ${visitId}`);
      return;
    }

    const info = await getPatientNotificationInfo(visitId);
    if (!info) {
      console.log(`[Notification] No patient/phone found for visit ${visitId}`);
      return;
    }

    if (!info.whatsappOptIn) {
      console.log(`[Notification] Patient ${info.patient.id} not opted in — skipping report notification`);
      return;
    }

    const link = await issueReportLinkForVisit(visitId, preIssuedToken);
    if (!link) {
      console.log(`[Notification] No report token for visit ${visitId} — skipping`);
      return;
    }

    const formattedPhone = formatPhoneForWhatsApp(info.phone);

    // Build template components
    // Template: lab_report_ready
    // Body params: {{1}} = patient name, {{2}} = bill number, {{3}} = report URL
    const components: TemplateComponent[] = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: info.patient.name },
          { type: 'text', text: info.visit.billNumber },
        ],
      },
      // URL button with dynamic suffix (the report token)
      {
        type: 'button',
        sub_type: 'url',
        index: 0,
        parameters: [
          { type: 'text', text: link.reportToken },
        ],
      },
    ];

    // Create MessageLog entry
    const messageLog = await prisma.messageLog.create({
      data: {
        patientId: info.patient.id,
        phone: formattedPhone,
        channel: 'WHATSAPP',
        templateName: 'lab_report_ready',
        templateParams: {
          patientName: info.patient.name,
          billNumber: info.visit.billNumber,
          reportVersionId: link.reportVersionId,
          hasReportLink: true,
        },
        status: 'PENDING',
        contextType: 'REPORT',
        contextId: visitId,
      },
    });

    // Send via WhatsApp Cloud API
    const result = await sendTemplate(formattedPhone, 'lab_report_ready', components);

    // Update with success
    await prisma.messageLog.update({
      where: { id: messageLog.id },
      data: {
        waMessageId: result.waMessageId,
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    console.log(`[Notification] Report ready sent to ${formattedPhone} for visit ${visitId} (wamid: ${result.waMessageId})`);
  } catch (error: any) {
    console.error(`[Notification] Failed to send report notification for visit ${visitId}:`, error.message);

    // Try to log the failure
    try {
      await prisma.messageLog.updateMany({
        where: {
          contextType: 'REPORT',
          contextId: visitId,
          status: 'PENDING',
        },
        data: {
          status: 'FAILED',
          failureReason: error.message?.slice(0, 500),
        },
      });
    } catch (logError) {
      console.error('[Notification] Failed to update MessageLog:', logError);
    }
  }
}

// ============================================================================
// BILL CONFIRMATION NOTIFICATION
// ============================================================================

/**
 * Send "Your bill has been generated" WhatsApp message.
 * Called after visit creation (POST /).
 * 
 * Template: bill_receipt
 * Params: patient name, bill number, total amount
 * Tone: Informational only. No link, no PDF.
 */
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
    const amountInRupees = (info.bill.totalAmountInPaise / 100).toLocaleString('en-IN');

    // Build template components
    // Template: bill_receipt
    // Body params: {{1}} = patient name, {{2}} = bill number, {{3}} = amount
    // Note: template already includes ₹ symbol before {{3}}, so don't prefix it here
    const components: TemplateComponent[] = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: info.patient.name },
          { type: 'text', text: info.visit.billNumber },
          { type: 'text', text: amountInRupees },
        ],
      },
    ];

    // Create MessageLog entry
    const messageLog = await prisma.messageLog.create({
      data: {
        patientId: info.patient.id,
        phone: formattedPhone,
        channel: 'WHATSAPP',
        templateName: 'bill_receipt',
        templateParams: {
          patientName: info.patient.name,
          billNumber: info.visit.billNumber,
          amount: `₹${amountInRupees}`,
        },
        status: 'PENDING',
        contextType: 'BILL',
        contextId: visitId,
      },
    });

    // Send via WhatsApp Cloud API
    const result = await sendTemplate(formattedPhone, 'bill_receipt', components);

    // Update with success
    await prisma.messageLog.update({
      where: { id: messageLog.id },
      data: {
        waMessageId: result.waMessageId,
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    console.log(`[Notification] Bill confirmation sent to ${formattedPhone} for visit ${visitId} (wamid: ${result.waMessageId})`);
  } catch (error: any) {
    console.error(`[Notification] Failed to send bill notification for visit ${visitId}:`, error.message);

    // Try to log the failure
    try {
      await prisma.messageLog.updateMany({
        where: {
          contextType: 'BILL',
          contextId: visitId,
          status: 'PENDING',
        },
        data: {
          status: 'FAILED',
          failureReason: error.message?.slice(0, 500),
        },
      });
    } catch (logError) {
      console.error('[Notification] Failed to update MessageLog:', logError);
    }
  }
}

// ============================================================================
// STAFF MANUAL RESEND
// ============================================================================

/**
 * Resend a report notification manually (staff action).
 * Auto-opts in the patient (staff sending implies consent).
 * Skips the whatsappOptIn check since this is an explicit staff action.
 */
export async function resendReportNotification(visitId: string, staffUserId?: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isWhatsAppEnabled()) {
      return { success: false, error: 'WhatsApp messaging is not enabled' };
    }

    const info = await getPatientNotificationInfo(visitId);
    if (!info) {
      return { success: false, error: 'Patient or phone not found' };
    }

    // Auto opt-in on staff action
    await autoOptIn(info.patient.id, 'STAFF_MANUAL_SEND');

    const link = await issueReportLinkForVisit(visitId);
    if (!link) {
      return { success: false, error: 'Report not finalized or no access token' };
    }

    const formattedPhone = formatPhoneForWhatsApp(info.phone);

    const components: TemplateComponent[] = [
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
    ];

    const messageLog = await prisma.messageLog.create({
      data: {
        patientId: info.patient.id,
        phone: formattedPhone,
        channel: 'WHATSAPP',
        templateName: 'lab_report_ready',
        templateParams: {
          patientName: info.patient.name,
          billNumber: info.visit.billNumber,
          reportVersionId: link.reportVersionId,
          hasReportLink: true,
          resendBy: staffUserId || 'unknown',
        },
        status: 'PENDING',
        contextType: 'REPORT',
        contextId: visitId,
      },
    });

    const result = await sendTemplate(formattedPhone, 'lab_report_ready', components);

    await prisma.messageLog.update({
      where: { id: messageLog.id },
      data: {
        waMessageId: result.waMessageId,
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    return { success: true };
  } catch (error: any) {
    console.error(`[Notification] Staff resend failed for visit ${visitId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Resend a bill confirmation manually (staff action).
 * Auto-opts in the patient.
 */
export async function resendBillNotification(visitId: string, staffUserId?: string): Promise<{ success: boolean; error?: string }> {
  try {
    if (!isWhatsAppEnabled()) {
      return { success: false, error: 'WhatsApp messaging is not enabled' };
    }

    const info = await getPatientNotificationInfo(visitId);
    if (!info || !info.bill) {
      return { success: false, error: 'Patient, phone, or bill not found' };
    }

    // Auto opt-in on staff action
    await autoOptIn(info.patient.id, 'STAFF_MANUAL_SEND');

    const formattedPhone = formatPhoneForWhatsApp(info.phone);
    const amountInRupees = (info.bill.totalAmountInPaise / 100).toLocaleString('en-IN');

    // Note: template already includes ₹ symbol before {{3}}, so don't prefix it here
    const components: TemplateComponent[] = [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: info.patient.name },
          { type: 'text', text: info.visit.billNumber },
          { type: 'text', text: amountInRupees },
        ],
      },
    ];

    const messageLog = await prisma.messageLog.create({
      data: {
        patientId: info.patient.id,
        phone: formattedPhone,
        channel: 'WHATSAPP',
        templateName: 'bill_receipt',
        templateParams: {
          patientName: info.patient.name,
          billNumber: info.visit.billNumber,
          amount: `₹${amountInRupees}`,
          resendBy: staffUserId || 'unknown',
        },
        status: 'PENDING',
        contextType: 'BILL',
        contextId: visitId,
      },
    });

    const result = await sendTemplate(formattedPhone, 'bill_receipt', components);

    await prisma.messageLog.update({
      where: { id: messageLog.id },
      data: {
        waMessageId: result.waMessageId,
        status: 'SENT',
        sentAt: new Date(),
      },
    });

    return { success: true };
  } catch (error: any) {
    console.error(`[Notification] Staff bill resend failed for visit ${visitId}:`, error.message);
    return { success: false, error: error.message };
  }
}
