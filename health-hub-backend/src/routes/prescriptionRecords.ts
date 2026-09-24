/**
 * Staff-side prescription records: view, print and send a SIGNED prescription.
 *
 * Separate from /api/prescriptions because that router is the doctor's module and
 * sits behind the owner's switch. These three do not: a prescription signed while
 * the module was on is a record, and it stays viewable, printable and sendable
 * after the module is turned off. Nothing here can create, edit or sign anything.
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { emitWorklistOnMutation } from '../lib/displayEvents';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { logAction } from '../services/auditService';
import { sendPrescriptionReady } from '../services/notificationService';
import { getById } from '../services/voiceRx/prescriptionService';
import { rxSummaries } from '../services/prescriptionRecords';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
// Printed / sent changes what the lists show, on every open screen.
router.use(emitWorklistOnMutation);

// GET /api/prescription-records/visit/:visitId — the summary + the signed sheet
router.get('/visit/:visitId', async (req: AuthRequest, res) => {
  try {
    const summary = (await rxSummaries([req.params.visitId])).get(req.params.visitId) ?? null;
    const prescription = summary?.signed ? await getById(summary.signed.id) : null;
    res.json({ summary, prescription });
  } catch (err) {
    logger.error({ err }, 'prescription-records: get failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not load the prescription' });
  }
});

// POST /api/prescription-records/:id/printed — Print turns green
router.post('/:id/printed', async (req: AuthRequest, res) => {
  try {
    const { count } = await prisma.prescription.updateMany({
      where: { id: req.params.id, status: 'SIGNED', deletedAt: null },
      data: { printedAt: new Date() },
    });
    res.json({ ok: count > 0 });
  } catch (err) {
    logger.error({ err }, 'prescription-records: mark printed failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not mark it printed' });
  }
});

// POST /api/prescription-records/:id/send — WhatsApp the patient their link.
// Reception and the doctor alike, SIGNED only. Explicit, never automatic: the
// link always resolves to the latest signed version, so sending once after any
// correction is settled is simpler and safer than sending on every signature.
router.post('/:id/send', async (req: AuthRequest, res) => {
  try {
    const rx = await prisma.prescription.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, status: true, rootId: true, branchId: true },
    });
    if (!rx) { res.status(404).json({ error: 'NOT_FOUND', message: 'Prescription not found' }); return; }
    if (rx.status !== 'SIGNED') {
      res.status(409).json({ error: 'NOT_SIGNED', message: 'Only a signed prescription can be sent' }); return;
    }

    // Delivery is REPORTED, not assumed — "sent" on screen always means sent.
    const delivery = await sendPrescriptionReady(rx.id);
    await logAction({
      branchId: rx.branchId,
      actionType: 'UPDATE',
      entityType: 'Prescription',
      entityId: rx.rootId,
      userId: req.user!.id,
      newValues: { sentToPatient: delivery.success, ...(delivery.error ? { reason: delivery.error } : {}) },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });
    res.json({ sent: delivery });
  } catch (err) {
    logger.error({ err }, 'prescription-records: send failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not send the prescription' });
  }
});

export default router;
