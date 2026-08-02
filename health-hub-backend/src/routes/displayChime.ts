/**
 * Quick waiting-room chime toggle for the reception queue page.
 *
 * Staff-accessible (not owner-only) since muting/unmuting the call sound is a
 * low-risk, everyday control. Reads/sets chimeSound across all of the branch's
 * active display screens at once.
 *
 *   GET /api/display-chime   -> { on, screenCount }
 *   PUT /api/display-chime   { on }  -> { on }
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);

router.get('/', async (req: AuthRequest, res) => {
  try {
    const screens = await prisma.displayScreen.findMany({
      where: { branchId: req.branchId!, isActive: true, revokedAt: null },
      select: { chimeSound: true },
    });
    return res.json({ on: screens.some((s) => s.chimeSound !== 'none'), screenCount: screens.length });
  } catch (err: any) {
    console.error('Get display chime error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to read chime setting' });
  }
});

router.put('/', async (req: AuthRequest, res) => {
  try {
    const on = req.body?.on === true;
    await prisma.displayScreen.updateMany({
      where: { branchId: req.branchId!, isActive: true, revokedAt: null },
      data: { chimeSound: on ? 'dingdong' : 'none' },
    });
    return res.json({ on });
  } catch (err: any) {
    console.error('Set display chime error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update chime setting' });
  }
});

export default router;
