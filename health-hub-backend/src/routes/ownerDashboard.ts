import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { getOwnerDashboardData } from '../services/ownerDashboardService';
import { getOwnerMetrics, MetricsWindow } from '../services/ownerMetricsService';
import { getOwnerDashboardV2 } from '../services/ownerDashboardV2Service';
import { getOwnerMoney, PeriodKey as MoneyPeriod } from '../services/ownerMoneyService';
import { getOwnerDoctors, PeriodKey as DoctorsPeriod } from '../services/ownerDoctorsService';
import { getOwnerOperations } from '../services/ownerOperationsService';

const router = Router();

router.use(authMiddleware);
router.use(requireRole('owner'));

// GET /api/owner/dashboard-v2?branch=<id>
// Decision-first aggregations for the rebuilt owner home page.
// branch=all (or omitted) returns cross-branch totals.
router.get('/dashboard-v2', async (req: AuthRequest, res) => {
  try {
    const raw = (req.query.branch as string) || 'all';
    const branchId = raw === 'all' ? null : raw;
    const data = await getOwnerDashboardV2(branchId);
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner dashboard v2 load failed');
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to load owner dashboard',
    });
  }
});

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

// GET /api/owner/money?period=7d|30d|mtd|ytd&branch=<id|all>
router.get('/money', async (req: AuthRequest, res) => {
  try {
    const rawPeriod = (req.query.period as string) || '30d';
    const period: MoneyPeriod =
      rawPeriod === '7d' || rawPeriod === '30d' || rawPeriod === 'mtd' || rawPeriod === 'ytd'
        ? rawPeriod
        : '30d';
    const rawBranch = (req.query.branch as string) || 'all';
    const branchId = rawBranch === 'all' ? null : rawBranch;
    const data = await getOwnerMoney(period, branchId);
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner money load failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load money page' });
  }
});

// GET /api/owner/doctors?period=7d|30d|mtd|ytd&branch=<id|all>
router.get('/doctors', async (req: AuthRequest, res) => {
  try {
    const rawPeriod = (req.query.period as string) || '30d';
    const period: DoctorsPeriod =
      rawPeriod === '7d' || rawPeriod === '30d' || rawPeriod === 'mtd' || rawPeriod === 'ytd'
        ? rawPeriod
        : '30d';
    const rawBranch = (req.query.branch as string) || 'all';
    const branchId = rawBranch === 'all' ? null : rawBranch;
    const data = await getOwnerDoctors(period, branchId);
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner doctors load failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load doctors page' });
  }
});

// GET /api/owner/operations?branch=<id|all>
router.get('/operations', async (req: AuthRequest, res) => {
  try {
    const rawBranch = (req.query.branch as string) || 'all';
    const branchId = rawBranch === 'all' ? null : rawBranch;
    const data = await getOwnerOperations(branchId);
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner operations load failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load operations page' });
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
