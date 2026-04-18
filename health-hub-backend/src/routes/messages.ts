/**
 * Messages Route — Staff message management
 * 
 * Endpoints for staff to manually send/resend WhatsApp notifications.
 * All routes require auth + branch context.
 * 
 * Routes:
 * - POST /api/messages/:visitId/send-report  — Send diagnostic completion notification
 * - POST /api/messages/:visitId/send-bill    — Send bill notification
 * - GET  /api/messages/:visitId              — Get message history for a visit
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import {
  resendReportNotification,
  resendBillNotification,
} from '../services/notificationService';
import { isWhatsAppEnabled } from '../services/whatsappCloudService';
import prisma from '../lib/prisma';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

/**
 * POST /api/messages/:visitId/send-report
 * Send (or resend) the diagnostic completion WhatsApp notification.
 * Dispatches by visit composition:
 * - reportable/mixed => report collection link
 * - pure bill-only   => collection notice without link
 * Auto-opts in the patient.
 */
router.post('/:visitId/send-report', async (req: AuthRequest, res) => {
  try {
    const { visitId } = req.params;

    // Verify visit exists and belongs to this branch
    const visit = await prisma.visit.findFirst({
      where: { id: visitId, branchId: req.branchId },
    });

    if (!visit) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    if (!isWhatsAppEnabled()) {
      return res.status(400).json({
        error: 'WHATSAPP_DISABLED',
        message: 'WhatsApp messaging is not enabled. Configure WHATSAPP_ENABLED=true in environment.',
      });
    }

    const result = await resendReportNotification(visitId, req.user?.id);

    if (result.success) {
      return res.json({ success: true, message: 'Completion notification sent' });
    } else {
      return res.status(400).json({ success: false, error: result.error });
    }
  } catch (err: any) {
    console.error('Send report notification error:', err);
    return res.status(500).json({ error: 'Failed to send notification' });
  }
});

/**
 * POST /api/messages/:visitId/send-bill
 * Send (or resend) bill confirmation WhatsApp notification.
 * Auto-opts in the patient.
 */
router.post('/:visitId/send-bill', async (req: AuthRequest, res) => {
  try {
    const { visitId } = req.params;

    const visit = await prisma.visit.findFirst({
      where: { id: visitId, branchId: req.branchId },
    });

    if (!visit) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    if (!isWhatsAppEnabled()) {
      return res.status(400).json({
        error: 'WHATSAPP_DISABLED',
        message: 'WhatsApp messaging is not enabled.',
      });
    }

    const result = await resendBillNotification(visitId, req.user?.id);

    if (result.success) {
      return res.json({ success: true, message: 'Bill notification sent' });
    } else {
      return res.status(400).json({ success: false, error: result.error });
    }
  } catch (err: any) {
    console.error('Send bill notification error:', err);
    return res.status(500).json({ error: 'Failed to send notification' });
  }
});

/**
 * GET /api/messages/:visitId
 * Get message history for a visit (all channels, all types).
 */
router.get('/:visitId', async (req: AuthRequest, res) => {
  try {
    const { visitId } = req.params;

    const messages = await prisma.messageLog.findMany({
      where: { contextId: visitId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        channel: true,
        templateName: true,
        status: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
        failureReason: true,
        contextType: true,
        createdAt: true,
      },
    });

    return res.json(messages);
  } catch (err: any) {
    console.error('Get message history error:', err);
    return res.status(500).json({ error: 'Failed to get message history' });
  }
});

export default router;
