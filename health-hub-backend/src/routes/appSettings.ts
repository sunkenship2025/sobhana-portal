import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';

const router = Router();

// Org-wide settings — not branch-scoped, so no branch context middleware.
router.use(authMiddleware);

// Cloud-sync default for narrative/text reports. Stored as "true"/"false".
const REPORT_AUTO_SYNC_KEY = 'report_auto_sync_default';

// ─── GET /api/app-settings/report-auto-sync ──────────────────────────
// The org-wide default any user falls back to when they have no personal
// override. Readable by every authenticated user. Defaults to on.
router.get('/report-auto-sync', async (_req: AuthRequest, res) => {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: REPORT_AUTO_SYNC_KEY },
    });
    const orgDefault = row ? row.value !== 'false' : true;
    res.json({ orgDefault });
  } catch (error) {
    console.error('GET /app-settings/report-auto-sync failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to read setting' });
  }
});

// ─── PUT /api/app-settings/report-auto-sync ──────────────────────────
// Set the org-wide default ("for all"). Only the lab incharge (lab technician
// head) can change it; owner/staff/sales set only their own personal override
// on the client.
router.put('/report-auto-sync', requireRole('lab_incharge'), async (req: AuthRequest, res) => {
  try {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'enabled (boolean) is required',
      });
      return;
    }
    const value = enabled ? 'true' : 'false';
    await prisma.appSetting.upsert({
      where: { key: REPORT_AUTO_SYNC_KEY },
      update: { value },
      create: { key: REPORT_AUTO_SYNC_KEY, value },
    });
    res.json({ orgDefault: enabled });
  } catch (error) {
    console.error('PUT /app-settings/report-auto-sync failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to save setting' });
  }
});

export default router;
