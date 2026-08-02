/**
 * Waiting-room Screens admin (owner only)
 *
 * Pair and manage the physical TVs for a branch. Creating a screen mints a
 * random `code`; the TV opens /display/<code> once and remembers it. Revoking a
 * screen kills that code (e.g. a lost device).
 */
import { Router } from 'express';
import crypto from 'crypto';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

function newCode(): string {
  // ~16 URL-safe chars — the code IS the display credential, so keep it random.
  return crypto.randomBytes(12).toString('base64url');
}

// GET / — screens for the active branch
router.get('/', async (req: AuthRequest, res) => {
  try {
    const screens = await prisma.displayScreen.findMany({
      where: { branchId: req.branchId! },
      orderBy: { createdAt: 'desc' },
    });
    return res.json(screens);
  } catch (err: any) {
    console.error('List display screens error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list screens' });
  }
});

// POST / — create + pair a new screen
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, scope, doctorIds } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Screen name is required' });
    }
    const screen = await prisma.displayScreen.create({
      data: {
        branchId: req.branchId!,
        name: name.trim(),
        code: newCode(),
        scope: scope === 'OP_IP' ? 'OP_IP' : 'OP',
        doctorIds: Array.isArray(doctorIds)
          ? doctorIds.filter((x: unknown) => typeof x === 'string')
          : [],
      },
    });
    return res.status(201).json(screen);
  } catch (err: any) {
    console.error('Create display screen error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create screen' });
  }
});

// PATCH /:id — rename / re-scope / re-pick doctors / enable-disable
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.displayScreen.findFirst({
      where: { id, branchId: req.branchId! },
    });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Screen not found' });

    const { name, scope, doctorIds, isActive } = req.body || {};
    const data: Record<string, unknown> = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (scope === 'OP' || scope === 'OP_IP') data.scope = scope;
    if (Array.isArray(doctorIds)) {
      data.doctorIds = doctorIds.filter((x: unknown) => typeof x === 'string');
    }
    if (typeof isActive === 'boolean') data.isActive = isActive;

    const screen = await prisma.displayScreen.update({ where: { id }, data });
    return res.json(screen);
  } catch (err: any) {
    console.error('Update display screen error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update screen' });
  }
});

// POST /:id/revoke — unpair a lost / decommissioned TV
router.post('/:id/revoke', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.displayScreen.findFirst({
      where: { id, branchId: req.branchId! },
    });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Screen not found' });

    const screen = await prisma.displayScreen.update({
      where: { id },
      data: { revokedAt: new Date(), isActive: false },
    });
    return res.json(screen);
  } catch (err: any) {
    console.error('Revoke display screen error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to revoke screen' });
  }
});

export default router;
