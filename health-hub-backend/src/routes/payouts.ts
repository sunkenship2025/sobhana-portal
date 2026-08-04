import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { branchContextMiddleware } from '../middleware/branch';
import { PayoutDoctorType, PaymentType } from '@prisma/client';
import * as payoutService from '../services/payoutService';
import { logAction } from '../services/auditService';
import {
  buildPayoutAggregateWorkbook,
  buildSinglePayoutWorkbook,
} from '../services/payoutExportService';
import * as externalLabService from '../services/externalLabService';
import * as notificationService from '../services/notificationService';
import { isWhatsAppEnabled } from '../services/whatsappCloudService';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

const VALID_DOCTOR_TYPES: PayoutDoctorType[] = ['REFERRAL', 'CLINIC', 'DIAGNOSTIC_CENTER', 'LAB'];
const VALID_PAYMENT_METHODS: PaymentType[] = ['CASH', 'ONLINE', 'CHEQUE'];

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function parseDoctorType(value: unknown): PayoutDoctorType | undefined {
  return typeof value === 'string' && VALID_DOCTOR_TYPES.includes(value as PayoutDoctorType)
    ? (value as PayoutDoctorType)
    : undefined;
}

// ============================================================================
// GET /api/payouts — list (server-side: q, page, sort, totals)
// Access: owner + staff
// ============================================================================
router.get('/', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const {
      doctorType,
      doctorId,
      isPaid,
      startDate,
      endDate,
      q,
      page,
      pageSize,
      sortBy,
      sortDir,
      includeTotals,
    } = req.query;

    const validatedDoctorType = doctorType ? parseDoctorType(doctorType) : undefined;
    if (doctorType && !validatedDoctorType) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorType must be REFERRAL, CLINIC, or DIAGNOSTIC_CENTER',
      });
    }

    const result = await payoutService.listPayouts(branchId, {
      doctorType: validatedDoctorType,
      doctorId: typeof doctorId === 'string' ? doctorId : undefined,
      isPaid: isPaid === 'true' ? true : isPaid === 'false' ? false : undefined,
      startDate: parseDate(startDate),
      endDate: parseDate(endDate),
      q: typeof q === 'string' ? q : undefined,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      sortBy: typeof sortBy === 'string' ? (sortBy as any) : undefined,
      sortDir: sortDir === 'asc' || sortDir === 'desc' ? sortDir : undefined,
      includeTotals: includeTotals === 'true',
    });

    return res.json({
      data: result.rows,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      totals: result.totals,
    });
  } catch (err: any) {
    console.error('List payouts error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list payouts' });
  }
});

// ============================================================================
// GET /api/payouts/summary-by-doctor — pivot: one row per doctor
// Access: owner + staff
// ============================================================================
router.get('/summary-by-doctor', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { doctorType, startDate, endDate, q } = req.query;

    const validatedDoctorType = doctorType ? parseDoctorType(doctorType) : undefined;
    if (doctorType && !validatedDoctorType) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorType must be REFERRAL, CLINIC, or DIAGNOSTIC_CENTER',
      });
    }

    const rows = await payoutService.groupPayoutsByDoctor(branchId, {
      doctorType: validatedDoctorType,
      startDate: parseDate(startDate),
      endDate: parseDate(endDate),
      q: typeof q === 'string' ? q : undefined,
    });

    return res.json({ data: rows });
  } catch (err: any) {
    console.error('Group by doctor error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to group payouts' });
  }
});

// ============================================================================
// POST /api/payouts/derive — derive a single payout (owner + staff)
// ============================================================================
router.post('/derive', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { doctorType, doctorId, periodStartDate, periodEndDate } = req.body;

    if (!doctorType || !doctorId || !periodStartDate || !periodEndDate) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorType, doctorId, periodStartDate, and periodEndDate are required',
      });
    }

    const validatedDoctorType = parseDoctorType(doctorType);
    if (!validatedDoctorType) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorType must be REFERRAL, CLINIC, or DIAGNOSTIC_CENTER',
      });
    }

    const startDate = parseDate(periodStartDate);
    const endDate = parseDate(periodEndDate);
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid date format' });
    }
    if (startDate > endDate) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'periodStartDate must be before periodEndDate',
      });
    }

    const result = await payoutService.derivePayout(
      validatedDoctorType,
      doctorId,
      branchId,
      startDate,
      endDate
    );

    if (result.isNew) {
      await logAction({
        branchId,
        actionType: 'PAYOUT_DERIVE',
        entityType: 'Payout',
        entityId: result.payout.id,
        userId: req.user?.id!,
        newValues: {
          payoutId: result.payout.id,
          doctorType,
          doctorId,
          periodStart: periodStartDate,
          periodEnd: periodEndDate,
          totalAmount: result.payout.derivedAmountInPaise / 100,
          lineItemCount: result.payout.lineItems?.length || 0,
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
    }

    return res.status(result.isNew ? 201 : 200).json({
      data: result.payout,
      isNew: result.isNew,
      message: result.isNew ? 'Payout derived successfully' : 'Existing payout found',
    });
  } catch (err: any) {
    console.error('Derive payout error:', err);
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: 'NOT_FOUND', message: err.message });
    }
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to derive payout' });
  }
});

// ============================================================================
// GET /api/payouts/derive/preview — preview bulk-derive buckets
// Access: owner + staff
// ============================================================================
router.get('/derive/preview', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { doctorType, doctorIds, periodStartDate, periodEndDate } = req.query;

    const validatedDoctorType = parseDoctorType(doctorType);
    if (!validatedDoctorType) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorType must be REFERRAL, CLINIC, or DIAGNOSTIC_CENTER',
      });
    }

    const startDate = parseDate(periodStartDate);
    const endDate = parseDate(periodEndDate);
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid date format' });
    }

    let resolvedDoctorIds: string[] | 'all';
    if (doctorIds === 'all' || doctorIds === undefined) {
      resolvedDoctorIds = 'all';
    } else if (typeof doctorIds === 'string') {
      resolvedDoctorIds = doctorIds.split(',').filter(Boolean);
    } else {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'doctorIds invalid' });
    }

    const preview = await payoutService.previewDerivePayouts({
      doctorType: validatedDoctorType,
      doctorIds: resolvedDoctorIds,
      branchId,
      periodStartDate: startDate,
      periodEndDate: endDate,
    });

    return res.json({ data: preview });
  } catch (err: any) {
    console.error('Preview derive error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to preview derive' });
  }
});

// ============================================================================
// POST /api/payouts/derive/bulk — derive for many doctors at once
// Access: owner + staff
// Body: { doctorType, doctorIds: string[] | 'all', periodStartDate, periodEndDate }
// ============================================================================
router.post('/derive/bulk', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { doctorType, doctorIds, periodStartDate, periodEndDate } = req.body;

    const validatedDoctorType = parseDoctorType(doctorType);
    if (!validatedDoctorType) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorType must be REFERRAL, CLINIC, or DIAGNOSTIC_CENTER',
      });
    }

    const startDate = parseDate(periodStartDate);
    const endDate = parseDate(periodEndDate);
    if (!startDate || !endDate) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid date format' });
    }
    if (startDate > endDate) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'periodStartDate must be before periodEndDate',
      });
    }

    let resolvedDoctorIds: string[] | 'all';
    if (doctorIds === 'all') {
      resolvedDoctorIds = 'all';
    } else if (Array.isArray(doctorIds)) {
      resolvedDoctorIds = doctorIds.filter((x) => typeof x === 'string');
      if (resolvedDoctorIds.length === 0) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'doctorIds must be a non-empty string array or "all"',
        });
      }
    } else {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorIds must be a string array or "all"',
      });
    }

    const result = await payoutService.derivePayoutsBulk({
      doctorType: validatedDoctorType,
      doctorIds: resolvedDoctorIds,
      branchId,
      periodStartDate: startDate,
      periodEndDate: endDate,
    });

    if (result.derived.length > 0) {
      await logAction({
        branchId,
        actionType: 'PAYOUT_DERIVE',
        entityType: 'Payout',
        entityId: 'BULK',
        userId: req.user?.id!,
        newValues: {
          mode: 'bulk',
          doctorType,
          periodStart: periodStartDate,
          periodEnd: periodEndDate,
          newCount: result.derived.length,
          existingCount: result.alreadyExisted.length,
          skippedCount: result.skipped.length,
          newPayoutIds: result.derived.map(p => p.id),
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
    }

    return res.json({ data: result });
  } catch (err: any) {
    console.error('Bulk derive error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to bulk derive' });
  }
});

// ============================================================================
// POST /api/payouts/mark-paid/bulk — apply ONE payment record to N rows
// Access: owner + staff
// Body: { ids: string[], paymentMethod, paymentReferenceId?, notes? }
// ============================================================================
router.post('/mark-paid/bulk', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { ids, paymentMethod, paymentReferenceId, notes } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'ids must be a non-empty array',
      });
    }
    const cleanIds = ids.filter((x: any) => typeof x === 'string');
    if (cleanIds.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'ids must contain strings' });
    }

    if (!paymentMethod || !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `paymentMethod must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`,
      });
    }

    const paidOn = parseDate(req.body.paidOn);
    if (req.body.paidOn && !paidOn) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'paidOn must be a valid date' });
    }
    if (paidOn && paidOn.getTime() > Date.now()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'paidOn cannot be in the future' });
    }

    const result = await payoutService.markPayoutsPaidBulk(cleanIds, branchId, {
      paymentMethod: paymentMethod as PaymentType,
      paymentReferenceId,
      notes,
      paidOn,
    });

    if (result.paidIds.length > 0) {
      await logAction({
        branchId,
        actionType: 'PAYOUT_PAID',
        entityType: 'Payout',
        entityId: 'BULK',
        userId: req.user?.id!,
        newValues: {
          mode: 'bulk',
          paidCount: result.paidIds.length,
          paidIds: result.paidIds,
          totalAmount: result.totalPaidInPaise / 100,
          paymentMethod,
          paymentReferenceId,
          conflictIds: result.conflictIds,
          notFoundIds: result.notFoundIds,
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
    }

    return res.json({ data: result });
  } catch (err: any) {
    console.error('Bulk mark paid error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to bulk mark paid' });
  }
});

// ============================================================================
// DELETE /api/payouts/bulk — soft-delete many payouts (OWNER ONLY)
// Body: { ids: string[] }
// ============================================================================
router.delete('/bulk', requireRole('owner'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'ids must be a non-empty array',
      });
    }
    const cleanIds = ids.filter((x: any) => typeof x === 'string');

    const result = await payoutService.bulkSoftDeletePayouts(cleanIds, branchId);

    if (result.deletedCount > 0) {
      await logAction({
        branchId,
        actionType: 'PAYOUT_DELETE',
        entityType: 'Payout',
        entityId: 'BULK',
        userId: req.user?.id!,
        oldValues: { ids: cleanIds },
        newValues: { mode: 'bulk', deletedCount: result.deletedCount },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
    }

    return res.json({ data: result });
  } catch (err: any) {
    console.error('Bulk delete error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete payouts' });
  }
});

// ============================================================================
// DELETE /api/payouts/by-doctor — soft-delete a payee's rows in a range (OWNER)
// Body: { payees: [{ payeeType, payeeId }], startDate, endDate }
// The grouped worklist rows are per-doctor aggregates, so deleting selected
// doctors voids every ledger row they have inside the selected period.
// ============================================================================
router.delete('/by-doctor', requireRole('owner'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { payees, startDate, endDate } = req.body;

    const start = parseDate(startDate);
    const end = parseDate(endDate);
    if (!Array.isArray(payees) || payees.length === 0 || !start || !end) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'payees (non-empty), startDate and endDate are required',
      });
    }

    const cleanPayees = payees
      .filter((p: any) => p && parseDoctorType(p.payeeType) && typeof p.payeeId === 'string')
      .map((p: any) => ({ payeeType: parseDoctorType(p.payeeType)!, payeeId: p.payeeId as string }));
    if (cleanPayees.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'No valid payees' });
    }

    const result = await payoutService.bulkSoftDeletePayoutsByDoctorRange(
      cleanPayees,
      branchId,
      start,
      end
    );

    if (result.deletedCount > 0) {
      await logAction({
        branchId,
        actionType: 'PAYOUT_DELETE',
        entityType: 'Payout',
        entityId: 'BY_DOCTOR',
        userId: req.user?.id!,
        oldValues: { payees: cleanPayees, startDate, endDate },
        newValues: { mode: 'by-doctor', deletedCount: result.deletedCount },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
    }

    return res.json({ data: result });
  } catch (err: any) {
    console.error('Delete payouts by doctor error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete payouts' });
  }
});

// ============================================================================
// GET /api/payouts/export — Excel of the pay-run (ONE row per doctor, ranged)
// Access: owner + staff. Optional ?payeeIds= restricts to the ticked doctors.
// ============================================================================
router.get('/export', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { doctorType, startDate, endDate, q } = req.query;

    const validatedDoctorType = doctorType ? parseDoctorType(doctorType) : undefined;
    if (doctorType && !validatedDoctorType) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorType must be REFERRAL, CLINIC, or DIAGNOSTIC_CENTER',
      });
    }

    // Reuse the worklist aggregation so the export matches the grouped screen
    // exactly (one row per doctor for the range, no per-day duplicates).
    const worklist = await payoutService.getPayRunWorklist(branchId, {
      payeeType: validatedDoctorType,
      startDate: parseDate(startDate),
      endDate: parseDate(endDate),
      q: typeof q === 'string' ? q : undefined,
    });

    // Optional selection: restrict the export to the ticked doctors.
    const rawPayeeIds = req.query.payeeIds;
    const payeeIdList =
      typeof rawPayeeIds === 'string' && rawPayeeIds.trim()
        ? rawPayeeIds.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    const wanted = payeeIdList.length > 0 ? new Set(payeeIdList) : null;

    const rows = worklist.rows
      .filter((r) => !wanted || wanted.has(r.payeeId))
      .map((r) => ({
        doctorName: r.payeeName,
        doctorType: r.payeeType,
        amountInPaise: r.amountInPaise,
      }));

    const buffer = await buildPayoutAggregateWorkbook(rows);
    const filename = `payouts-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err: any) {
    console.error('Export payouts error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to export' });
  }
});

// ============================================================================
// Doctor dropdown endpoints (unchanged, but moved here so /:id matches last)
// ============================================================================
router.get('/doctors/referral', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchScope = req.query.scope === 'branch' ? req.branchId : undefined;
    const doctors = await payoutService.getReferralDoctors(true, branchScope);
    return res.json({ data: doctors });
  } catch (err: any) {
    console.error('Get referral doctors error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get referral doctors' });
  }
});

router.get('/doctors/clinic', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchScope = req.query.scope === 'branch' ? req.branchId : undefined;
    const doctors = await payoutService.getClinicDoctors(true, branchScope);
    return res.json({ data: doctors });
  } catch (err: any) {
    console.error('Get clinic doctors error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get clinic doctors' });
  }
});

router.get('/doctors/diagnostic-centers', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchScope = req.query.scope === 'branch' ? req.branchId : undefined;
    const centers = await payoutService.getDiagnosticCenters(true, branchScope);
    return res.json({ data: centers });
  } catch (err: any) {
    console.error('Get diagnostic centers error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get diagnostic centers' });
  }
});

// ============================================================================
// GET /api/payouts/worklist — grouped pay-run worklist (two non-net hero totals)
// ============================================================================
router.get('/worklist', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const worklist = await payoutService.getPayRunWorklist(branchId, {
      startDate: parseDate(req.query.startDate),
      endDate: parseDate(req.query.endDate),
      payeeType: parseDoctorType(req.query.payeeType),
      q: typeof req.query.q === 'string' ? req.query.q : undefined,
      view: req.query.view === 'flat' ? 'flat' : 'grouped',
    });
    return res.json({ data: worklist });
  } catch (err: any) {
    console.error('Get pay-run worklist error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get worklist' });
  }
});

// ============================================================================
// GET /api/payouts/statement — per-doctor banded statement over a date range
// Query: payeeType, payeeId, startDate, endDate. Used by the grouped worklist,
// whose rows are per-doctor aggregates (no single ledger id) linked to the
// range at the top of the page.
// ============================================================================
router.get('/statement', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const payeeType = parseDoctorType(req.query.payeeType);
    const payeeId = typeof req.query.payeeId === 'string' ? req.query.payeeId : undefined;
    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    if (!payeeType || !payeeId || !startDate || !endDate) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'payeeType, payeeId, startDate and endDate are required',
      });
    }

    const statement = await payoutService.getPayoutStatementForDoctorRange(
      payeeType,
      payeeId,
      branchId,
      startDate,
      endDate
    );
    return res.json({ data: statement });
  } catch (err: any) {
    console.error('Get range statement error:', err);
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: 'NOT_FOUND', message: err.message });
    }
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get statement' });
  }
});

// ============================================================================
// GET /api/payouts/export/doctor — per-doctor statement xlsx over a date range
// Query: payeeType, payeeId, startDate, endDate, [visitIds]
// ============================================================================
router.get('/export/doctor', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const payeeType = parseDoctorType(req.query.payeeType);
    const payeeId = typeof req.query.payeeId === 'string' ? req.query.payeeId : undefined;
    const startDate = parseDate(req.query.startDate);
    const endDate = parseDate(req.query.endDate);

    if (!payeeType || !payeeId || !startDate || !endDate) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'payeeType, payeeId, startDate and endDate are required',
      });
    }

    const payout = await payoutService.getPayoutDetailForDoctorRange(
      payeeType,
      payeeId,
      branchId,
      startDate,
      endDate
    );

    // Optional selection: export only the chosen patients' visits.
    const rawVisitIds = req.query.visitIds;
    const visitIdList =
      typeof rawVisitIds === 'string' && rawVisitIds.trim()
        ? rawVisitIds.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    let exportPayout = payout;
    if (visitIdList.length > 0) {
      const wanted = new Set(visitIdList);
      const lineItems = payout.lineItems.filter((li) => wanted.has(li.visitId));
      exportPayout = {
        ...payout,
        lineItems,
        derivedAmountInPaise: lineItems.reduce((s, li) => s + li.derivedCommissionInPaise, 0),
      };
    }

    const buffer = await buildSinglePayoutWorkbook(exportPayout);
    const filename = `payout-${payout.doctorName.replace(/\s+/g, '_')}-${new Date(startDate)
      .toISOString()
      .slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err: any) {
    console.error('Export range payout error:', err);
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: 'NOT_FOUND', message: err.message });
    }
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to export payout' });
  }
});

// GET /api/payouts/payees/external-labs — dropdown source (active labs)
router.get('/payees/external-labs', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (_req: AuthRequest, res) => {
  try {
    const labs = await externalLabService.listExternalLabs(false);
    return res.json({ data: labs });
  } catch (err: any) {
    console.error('Get external labs error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get external labs' });
  }
});

// ============================================================================
// GET /api/payouts/:id — detail (owner + staff)
// ============================================================================
router.get('/:id', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;
    const payout = await payoutService.getPayoutDetail(id);

    if (!payout) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Payout not found' });
    }
    if (payout.branchId !== branchId) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Payout belongs to a different branch',
      });
    }
    return res.json({ data: payout });
  } catch (err: any) {
    console.error('Get payout detail error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get payout detail' });
  }
});

// ============================================================================
// GET /api/payouts/:id/statement — category-banded statement (owner + staff)
// ============================================================================
router.get('/:id/statement', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const statement = await payoutService.getPayoutStatement(req.params.id, req.branchId!);
    if (!statement) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Payout not found' });
    }
    return res.json({ data: statement });
  } catch (err: any) {
    console.error('Get payout statement error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to get statement' });
  }
});

// ============================================================================
// POST /api/payouts/:id/send-statement — WhatsApp the statement to the payee
// (owner + staff + lab incharge; sales is excluded — sales cannot send WhatsApp)
// ============================================================================
router.post('/:id/send-statement', requireRole('owner', 'staff', 'lab_incharge'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;

    if (!isWhatsAppEnabled()) {
      return res.status(400).json({ error: 'WHATSAPP_DISABLED', message: 'WhatsApp messaging is not enabled' });
    }

    // Ownership/branch guard (also yields a clean 404/403 before attempting a send).
    const existing = await payoutService.getPayoutDetail(id);
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Payout not found' });
    }
    if (existing.branchId !== branchId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Wrong branch' });
    }

    const result = await notificationService.sendPayoutStatement(id, branchId, req.user?.id);
    if (!result.success) {
      return res.status(400).json({ error: 'SEND_FAILED', message: result.error ?? 'Failed to send statement' });
    }
    // The send is recorded in MessageLog (contextType=PAYMENT, contextId=payoutId).
    return res.json({ data: { success: true } });
  } catch (err: any) {
    console.error('Send payout statement error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to send statement' });
  }
});

// ============================================================================
// GET /api/payouts/:id/export — single payout xlsx
// Access: owner + staff
// ============================================================================
router.get('/:id/export', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;
    const payout = await payoutService.getPayoutDetail(id);
    if (!payout) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Payout not found' });
    }
    if (payout.branchId !== branchId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Wrong branch' });
    }

    // Optional selection: export only the chosen patients' visits. Total is
    // recomputed from the filtered rows so the workbook stays internally
    // consistent (a partial export won't match the full period, by design).
    const rawVisitIds = req.query.visitIds;
    const visitIdList =
      typeof rawVisitIds === 'string' && rawVisitIds.trim()
        ? rawVisitIds.split(',').map((s) => s.trim()).filter(Boolean)
        : [];
    let exportPayout = payout;
    if (visitIdList.length > 0) {
      const wanted = new Set(visitIdList);
      const lineItems = payout.lineItems.filter((li) => wanted.has(li.visitId));
      exportPayout = {
        ...payout,
        lineItems,
        derivedAmountInPaise: lineItems.reduce(
          (s, li) => s + li.derivedCommissionInPaise,
          0
        ),
      };
    }

    const buffer = await buildSinglePayoutWorkbook(exportPayout);
    const filename = `payout-${payout.doctorName.replace(/\s+/g, '_')}-${new Date(payout.periodStartDate)
      .toISOString()
      .slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (err: any) {
    console.error('Export payout detail error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to export payout' });
  }
});

// ============================================================================
// POST /api/payouts/:id/mark-paid — single mark-paid (owner + staff)
// ============================================================================
router.post('/:id/mark-paid', requireRole('owner', 'staff', 'lab_incharge', 'sales'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;
    const { paymentMethod, paymentReferenceId, notes } = req.body;

    if (!paymentMethod || !VALID_PAYMENT_METHODS.includes(paymentMethod)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `paymentMethod must be one of: ${VALID_PAYMENT_METHODS.join(', ')}`,
      });
    }

    const paidOn = parseDate(req.body.paidOn);
    if (req.body.paidOn && !paidOn) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'paidOn must be a valid date' });
    }
    if (paidOn && paidOn.getTime() > Date.now()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'paidOn cannot be in the future' });
    }

    const existing = await payoutService.getPayoutDetail(id);
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Payout not found' });
    }
    if (existing.branchId !== branchId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Wrong branch' });
    }

    const payout = await payoutService.markPayoutPaid(
      id,
      paymentMethod as PaymentType,
      paymentReferenceId,
      notes,
      paidOn
    );

    await logAction({
      branchId,
      actionType: 'PAYOUT_PAID',
      entityType: 'Payout',
      entityId: id,
      userId: req.user?.id!,
      oldValues: { isPaid: false },
      newValues: {
        isPaid: true,
        paymentMethod,
        paymentReferenceId,
        notes,
        paidAt: new Date().toISOString(),
        totalAmount: payout.derivedAmountInPaise / 100,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ data: payout, message: 'Payout marked as paid successfully' });
  } catch (err: any) {
    console.error('Mark payout paid error:', err);
    if (err.message?.includes('already marked as paid')) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'Payout has already been paid and cannot be modified',
      });
    }
    if (err.message?.includes('not found')) {
      return res.status(404).json({ error: 'NOT_FOUND', message: err.message });
    }
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to mark paid' });
  }
});

// ============================================================================
// DELETE /api/payouts/:id — soft-delete single (OWNER ONLY)
// ============================================================================
router.delete('/:id', requireRole('owner'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;
    const result = await payoutService.softDeletePayout(id, branchId);
    if (!result) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Payout not found or already deleted' });
    }

    await logAction({
      branchId,
      actionType: 'PAYOUT_DELETE',
      entityType: 'Payout',
      entityId: id,
      userId: req.user?.id!,
      oldValues: { id },
      newValues: { deleted: true },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ data: result });
  } catch (err: any) {
    console.error('Delete payout error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete payout' });
  }
});

export default router;
