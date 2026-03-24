import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { getOwnerDashboardData } from '../services/ownerDashboardService';

const router = Router();

router.use(authMiddleware);
router.use(requireRole('owner'));

router.get('/dashboard', async (_req: AuthRequest, res) => {
  try {
    const data = await getOwnerDashboardData();
    return res.json(data);
  } catch (err: any) {
    console.error('Owner dashboard error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to load owner dashboard',
    });
  }
});

export default router;
