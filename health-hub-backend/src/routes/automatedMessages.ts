/**
 * GET/PUT /api/automated-messages — the Config Center's Automated messages tab.
 * Owner-only: these rows decide who gets a WhatsApp carrying a day's takings.
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import { logAction } from '../services/auditService';
import { listAutomatedMessages, saveAutomatedMessage, sendNow } from '../services/automatedMessageService';

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
    const { domain, enabled, sendAtMinutes, branchIds } = req.body ?? {};
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
    if (!Array.isArray(branchIds) || branchIds.some((b) => typeof b !== 'string')) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'branchIds must be an array of ids' });
    }
    if (enabled && branchIds.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Pick at least one branch, or turn the automation off' });
    }

    await saveAutomatedMessage({ domain, enabled, sendAtMinutes: minutes, branchIds });
    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'ScheduledMessage',
      entityId: `DAY_SHEET:${domain}`,
      userId: req.user?.id,
      newValues: { domain, enabled, sendAtMinutes: minutes, branchIds },
    });
    return res.json(await listAutomatedMessages());
  } catch (err) {
    console.error('Save automated message error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to save' });
  }
});

// POST /api/automated-messages/send-now — fire one automation immediately.
// Writes no run row, so testing now never cancels tonight's scheduled send.
router.post('/send-now', async (req: AuthRequest, res) => {
  try {
    const { domain, branchIds } = req.body ?? {};
    if (domain !== 'DIAGNOSTICS' && domain !== 'CLINIC') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'domain must be DIAGNOSTICS or CLINIC' });
    }
    if (!Array.isArray(branchIds) || branchIds.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Pick at least one branch first' });
    }
    const result = await sendNow(domain, branchIds);
    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'ScheduledMessage',
      entityId: `DAY_SHEET:${domain}`,
      userId: req.user?.id,
      newValues: { action: 'SEND_NOW', domain, branchIds, ...result },
    });
    return res.json(result);
  } catch (err) {
    console.error('Send now error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to send' });
  }
});

export default router;
