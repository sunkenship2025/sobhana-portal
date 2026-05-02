import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { getOwnerDashboardData } from '../services/ownerDashboardService';
import { getOwnerMetrics, MetricsWindow } from '../services/ownerMetricsService';

const router = Router();

router.use(authMiddleware);
router.use(requireRole('owner'));

router.get('/dashboard', async (req: AuthRequest, res) => {
  try {
    const data = await getOwnerDashboardData();
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner dashboard load failed');
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to load owner dashboard',
    });
  }
});

// GET /api/owner/metrics?window=today|7d|30d
// Aggregated business KPIs. Cached server-side for 5 minutes per window.
router.get('/metrics', async (req: AuthRequest, res) => {
  try {
    const raw = (req.query.window as string) || '7d';
    const window: MetricsWindow =
      raw === 'today' || raw === '7d' || raw === '30d' ? raw : '7d';
    const data = await getOwnerMetrics(window);
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner metrics load failed');
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to load owner metrics',
    });
  }
});

export default router;
