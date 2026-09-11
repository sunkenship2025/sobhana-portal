/**
 * GET/PUT /api/automated-messages — the Config Center's Automated messages tab.
 * Owner-only: these rows decide who gets a WhatsApp carrying a day's takings.
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import { logAction } from '../services/auditService';
import { listAutomatedMessages, saveAutomatedMessage } from '../services/automatedMessageService';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

router.get('/', async (_req: AuthRequest, res) => {
  try {
    return res.json(await listAutomatedMessages());
  } catch (err) {
    console.error('List automated messages error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load automated messages' });
  }
});

router.put('/', async (req: AuthRequest, res) => {
  try {
    const { branchId, domain, enabled, sendAtMinutes } = req.body ?? {};
    if (typeof branchId !== 'string' || !branchId) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'branchId is required' });
    }
    if (domain !== 'DIAGNOSTICS' && domain !== 'CLINIC') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'domain must be DIAGNOSTICS or CLINIC' });
    }
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'enabled must be a boolean' });
    }
    const minutes = Number(sendAtMinutes);
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1439) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'sendAtMinutes must be 0-1439' });
    }

    const saved = await saveAutomatedMessage({ branchId, domain, enabled, sendAtMinutes: minutes });
    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'ScheduledMessage',
      entityId: saved.id,
      userId: req.user?.id,
      newValues: { kind: saved.kind, branchId, domain, enabled, sendAtMinutes: minutes },
    });
    return res.json({ data: saved });
  } catch (err) {
    console.error('Save automated message error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to save' });
  }
});

export default router;
