import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { getOwnerMetrics, MetricsWindow } from '../services/ownerMetricsService';
import { getOwnerDashboardV2, PeriodKey as DashboardV2Period } from '../services/ownerDashboardV2Service';
import {
  getOwnerMoney,
  getMoneyDaySheet,
  PeriodKey as MoneyPeriod,
  CustomRange as MoneyCustomRange,
  DaySheetDomain as MoneyDaySheetDomain,
} from '../services/ownerMoneyService';
import { buildDaySheetWorkbook } from '../services/moneyDaySheetExportService';
import { getOwnerDoctors, PeriodKey as DoctorsPeriod } from '../services/ownerDoctorsService';
import { getOwnerOperations } from '../services/ownerOperationsService';
import { getAuditEvents } from '../services/ownerAuditService';

const router = Router();

router.use(authMiddleware);

// GET /api/owner/operations?branch=<id|all>
// Operations is the live ops worklist — available to the owner AND the lab
// in-charge (ops oversight). Registered BEFORE the owner-only gate below so
// lab_incharge requests aren't rejected by it.
router.get('/operations', requireRole('owner', 'lab_incharge'), async (req: AuthRequest, res) => {
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

// GET /api/owner/audit/events — paginated Audit & Anomalies feed for /ops/audit.
// Owner AND lab_incharge (like /operations); registered BEFORE the owner-only
// gate. Keyset (cursor) paginated, date-time range up to 1 year, branch / actor
// / category / free-text filterable; returns only display fields (no blobs).
router.get('/audit/events', requireRole('owner', 'lab_incharge'), async (req: AuthRequest, res) => {
  try {
    const rawBranch = (req.query.branch as string) || 'all';
    const branchId = rawBranch === 'all' ? null : rawBranch;
    const limitRaw = req.query.limit as string | undefined;
    const data = await getAuditEvents({
      branchId,
      category: (req.query.category as string) ?? null,
      actor: (req.query.actor as string) ?? null,
      q: (req.query.q as string) ?? null,
      from: (req.query.from as string) ?? null,
      to: (req.query.to as string) ?? null,
      cursor: (req.query.cursor as string) ?? null,
      limit: limitRaw ? Number(limitRaw) : null,
    });
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner audit events load failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load audit events' });
  }
});

router.use(requireRole('owner'));

// GET /api/owner/dashboard-v2?period=today|yesterday|7d|30d|mtd|ytd|custom&branch=<id>
//   custom also takes &start=YYYY-MM-DD&end=YYYY-MM-DD (IST calendar days, inclusive).
// The period slicer scopes the money summary, revenue trend/mix and branch table;
// the action queue, receivables, payout liability and ops pulse stay live.
// branch=all (or omitted) returns cross-branch totals.
router.get('/dashboard-v2', async (req: AuthRequest, res) => {
  try {
    const { period, branchId, range } = parseMoneyQuery(req);
    const data = await getOwnerDashboardV2(branchId, period as DashboardV2Period, range);
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner dashboard v2 load failed');
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to load owner dashboard',
    });
  }
});

// GET /api/owner/money?period=today|yesterday|7d|30d|mtd|ytd|custom&branch=<id|all>
//   custom also takes &start=YYYY-MM-DD&end=YYYY-MM-DD (IST calendar days, inclusive)
const MONEY_PERIODS: MoneyPeriod[] = ['today', 'yesterday', '7d', '30d', 'mtd', 'ytd', 'custom'];
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

// Shared period + branch + custom-range parsing for the money endpoints.
function parseMoneyQuery(req: AuthRequest): {
  period: MoneyPeriod;
  branchId: string | null;
  range: MoneyCustomRange | null;
} {
  const rawPeriod = (req.query.period as string) || '30d';
  let period: MoneyPeriod = MONEY_PERIODS.includes(rawPeriod as MoneyPeriod)
    ? (rawPeriod as MoneyPeriod)
    : '30d';
  const rawBranch = (req.query.branch as string) || 'all';
  const branchId = rawBranch === 'all' ? null : rawBranch;

  let range: MoneyCustomRange | null = null;
  if (period === 'custom') {
    const start = (req.query.start as string) || '';
    const end = (req.query.end as string) || '';
    if (DATE_KEY.test(start) && DATE_KEY.test(end)) {
      // Tolerate a reversed range so the picker never yields an empty window.
      range = start <= end ? { startKey: start, endKey: end } : { startKey: end, endKey: start };
    } else {
      period = '30d'; // incomplete custom range → fall back to the default preset
    }
  }
  return { period, branchId, range };
}

router.get('/money', async (req: AuthRequest, res) => {
  try {
    const { period, branchId, range } = parseMoneyQuery(req);
    const rawDomain = (req.query.domain as string) || 'all';
    const domain: MoneyDaySheetDomain | null =
      rawDomain === 'diagnostics' ? 'DIAGNOSTICS' : rawDomain === 'clinic' ? 'CLINIC' : null;
    const data = await getOwnerMoney(period, branchId, range, domain);
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner money load failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load money page' });
  }
});

// GET /api/owner/money/day-sheet?period=...&branch=...&start=...&end=...&format=xlsx
//   Per-bill register for the selected window. JSON by default (drives the
//   printable sheet); format=xlsx streams an Excel workbook.
router.get('/money/day-sheet', async (req: AuthRequest, res) => {
  try {
    const { period, branchId, range } = parseMoneyQuery(req);
    const rawDomain = (req.query.domain as string) || 'all';
    const domain: MoneyDaySheetDomain | null =
      rawDomain === 'diagnostics' ? 'DIAGNOSTICS' : rawDomain === 'clinic' ? 'CLINIC' : null;
    const data = await getMoneyDaySheet(period, branchId, range, domain);

    if ((req.query.format as string) === 'xlsx') {
      const buffer = await buildDaySheetWorkbook(data);
      const stamp = new Date().toISOString().slice(0, 10);
      const tag = domain === 'DIAGNOSTICS' ? 'diagnostic-' : domain === 'CLINIC' ? 'op-' : '';
      const filename = `${tag}day-sheet-${stamp}.xlsx`;
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      return res.send(buffer);
    }

    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner money day-sheet load failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load day sheet' });
  }
});

// GET /api/owner/doctors?period=today|yesterday|7d|30d|mtd|ytd|custom&branch=<id|all>
//   custom also takes &start=YYYY-MM-DD&end=YYYY-MM-DD (IST calendar days, inclusive)
router.get('/doctors', async (req: AuthRequest, res) => {
  try {
    const { period, branchId, range } = parseMoneyQuery(req);
    const data = await getOwnerDoctors(period as DoctorsPeriod, branchId, range);
    return res.json(data);
  } catch (err: any) {
    req.log.error({ err }, 'owner doctors load failed');
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load doctors page' });
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
