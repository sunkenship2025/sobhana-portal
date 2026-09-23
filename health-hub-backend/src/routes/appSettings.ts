import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { logAction } from '../services/auditService';
import { digitalRxEnabled, DIGITAL_RX_KEY } from '../lib/clinicModule';
import { availableProviders } from '../services/voiceRx/asr';
import { extractionConfigured } from '../services/voiceRx/extract';

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

// ─── Digital prescriptions — the clinic module master switch ─────────
//
// One row decides whether the doctor portal, voice dictation and structured
// prescriptions exist at all. Off (the shipped default) the clinic runs exactly
// as it did before any of it was built.
//
// GET is deliberately open to every signed-in user, and deliberately NOT behind
// requireDigitalRx: the UI has to be able to ask "is this on?" precisely when it
// is off, or a doctor lands on a dead screen with no explanation instead of one
// that says the module is switched off.

// ─── GET /api/app-settings/digital-prescriptions ─────────────────────
router.get('/digital-prescriptions', async (_req: AuthRequest, res) => {
  try {
    // Whether dictation will actually work once the module is on. Readable HERE,
    // outside the module gate, because the owner deciding whether to switch it on
    // needs to know if doctors will get a mic or only the typed editor — and
    // /prescriptions/capabilities is unreachable while the module is off.
    const voiceEnabled = availableProviders().some((p) => p.configured) && extractionConfigured();
    res.json({ enabled: await digitalRxEnabled(), voiceEnabled });
  } catch (error) {
    console.error('GET /app-settings/digital-prescriptions failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to read setting' });
  }
});

// ─── PUT /api/app-settings/digital-prescriptions ─────────────────────
// Owner only. This turns a whole workflow on and off for every doctor in the
// clinic, so it is logged like any other owner action — "who switched the
// prescription module off last Tuesday" has to be answerable.
router.put('/digital-prescriptions', requireRole('owner'), async (req: AuthRequest, res) => {
  try {
    const { enabled } = req.body ?? {};
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'VALIDATION_ERROR', message: 'enabled (boolean) is required' });
      return;
    }
    const was = await digitalRxEnabled();
    const value = enabled ? 'true' : 'false';
    await prisma.appSetting.upsert({
      where: { key: DIGITAL_RX_KEY },
      update: { value },
      create: { key: DIGITAL_RX_KEY, value },
    });
    // AuditLog.branchId is a required FK and this router is org-wide by design
    // (no branch middleware), so the row is anchored to the oldest active branch.
    // The branch is not the signal here — who flipped it, and when, is.
    const anchor =
      req.branchId ??
      (await prisma.branch.findFirst({
        where: { isActive: true }, select: { id: true }, orderBy: { createdAt: 'asc' },
      }))?.id;
    if (was !== enabled && anchor) {
      await logAction({
        branchId: anchor,
        actionType: 'UPDATE',
        entityType: 'AppSetting',
        entityId: DIGITAL_RX_KEY,
        userId: req.user?.id!,
        oldValues: { enabled: was },
        newValues: { enabled },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
    }
    res.json({ enabled });
  } catch (error) {
    console.error('PUT /app-settings/digital-prescriptions failed:', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to save setting' });
  }
});

export default router;
