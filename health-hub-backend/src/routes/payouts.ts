import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { branchContextMiddleware } from '../middleware/branch';
import { PayoutDoctorType, PaymentType } from '@prisma/client';
import * as payoutService from '../services/payoutService';
import { logAction } from '../services/auditService';

const router = Router();

// All routes require authentication and branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ===========================================================================
// GET /api/payouts - List payouts for current branch
// Query params: doctorType, isPaid, startDate, endDate
// Access: owner, staff
// ===========================================================================
router.get('/', requireRole('owner', 'staff'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { doctorType, isPaid, startDate, endDate } = req.query;

    // Validate doctorType if provided
    let validatedDoctorType: PayoutDoctorType | undefined;
    if (doctorType) {
      if (doctorType !== 'REFERRAL' && doctorType !== 'CLINIC') {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'doctorType must be REFERRAL or CLINIC',
        });
      }
      validatedDoctorType = doctorType as PayoutDoctorType;
    }

    // Parse isPaid
    let validatedIsPaid: boolean | undefined;
    if (isPaid !== undefined) {
      validatedIsPaid = isPaid === 'true';
    }

    // Parse dates
    let validatedStartDate: Date | undefined;
    let validatedEndDate: Date | undefined;
    if (startDate) {
      validatedStartDate = new Date(startDate as string);
      if (isNaN(validatedStartDate.getTime())) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Invalid startDate format',
        });
      }
    }
    if (endDate) {
      validatedEndDate = new Date(endDate as string);
      if (isNaN(validatedEndDate.getTime())) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Invalid endDate format',
        });
      }
    }

    const payouts = await payoutService.listPayouts(branchId, {
      doctorType: validatedDoctorType,
      isPaid: validatedIsPaid,
      startDate: validatedStartDate,
      endDate: validatedEndDate,
    });

    return res.json({
      data: payouts,
      count: payouts.length,
    });
  } catch (err: any) {
    console.error('List payouts error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list payouts',
    });
  }
});

// ===========================================================================
// POST /api/payouts/derive - Derive a new payout
// Body: { doctorType, doctorId, periodStartDate, periodEndDate }
// Access: owner only
// ===========================================================================
router.post('/derive', requireRole('owner'), async (req: AuthRequest, res) => {
  try {
    const branchId = req.branchId!;
    const { doctorType, doctorId, periodStartDate, periodEndDate } = req.body;

    // Validate required fields
    if (!doctorType || !doctorId || !periodStartDate || !periodEndDate) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorType, doctorId, periodStartDate, and periodEndDate are required',
      });
    }

    // Validate doctorType
    if (doctorType !== 'REFERRAL' && doctorType !== 'CLINIC') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'doctorType must be REFERRAL or CLINIC',
      });
    }

    // Parse dates
    const startDate = new Date(periodStartDate);
    const endDate = new Date(periodEndDate);

    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid date format',
      });
    }

    if (startDate > endDate) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'periodStartDate must be before periodEndDate',
      });
    }

    const result = await payoutService.derivePayout(
      doctorType as PayoutDoctorType,
      doctorId,
      branchId,
      startDate,
      endDate
    );

    // Audit log: Payout derivation
    if (result.isNew) {
      await logAction({
        branchId: req.branchId!,
        actionType: 'PAYOUT_DERIVE',
        entityType: 'Payout',
        entityId: result.payout.id,
        userId: req.userId!,
        newValues: {
          payoutId: result.payout.id,
          doctorType,
          doctorId,
          periodStart: periodStartDate,
          periodEnd: periodEndDate,
          totalAmount: result.payout.totalAmountInPaise / 100,
          lineItemCount: result.payout.lineItems?.length || 0,
        },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });
    }

    return res.status(result.isNew ? 201 : 200).json({
      data: result.payout,
      isNew: result.isNew,
      message: result.isNew
        ? 'Payout derived successfully'
        : 'Existing payout found for this period',
    });
  } catch (err: any) {
    console.error('Derive payout error:', err);
    if (err.message?.includes('not found')) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: err.message,
      });
    }
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to derive payout',
    });
  }
});

// ===========================================================================
// GET /api/payouts/doctors/referral - Get all referral doctors for dropdown
// Access: owner, staff
// NOTE: Must come BEFORE /:id route to avoid matching "doctors" as an id
// ===========================================================================
router.get('/doctors/referral', requireRole('owner', 'staff'), async (_req: AuthRequest, res) => {
  try {
    const doctors = await payoutService.getReferralDoctors(true);
    return res.json({ data: doctors });
  } catch (err: any) {
    console.error('Get referral doctors error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get referral doctors',
    });
  }
});

// ===========================================================================
// GET /api/payouts/doctors/clinic - Get all clinic doctors for dropdown
// Access: owner, staff
// ===========================================================================
router.get('/doctors/clinic', requireRole('owner', 'staff'), async (_req: AuthRequest, res) => {
  try {
    const doctors = await payoutService.getClinicDoctors(true);
    return res.json({ data: doctors });
  } catch (err: any) {
    console.error('Get clinic doctors error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get clinic doctors',
    });
  }
});

// ===========================================================================
// GET /api/payouts/:id - Get payout detail with line items
// Access: owner, staff
// ===========================================================================
router.get('/:id', requireRole('owner', 'staff'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;

    const payout = await payoutService.getPayoutDetail(id);

    if (!payout) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Payout not found',
      });
    }

    // Verify payout belongs to current branch
    if (payout.branchId !== branchId) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Payout belongs to a different branch',
      });
    }

    return res.json({ data: payout });
  } catch (err: any) {
    console.error('Get payout detail error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get payout detail',
    });
  }
});

// ===========================================================================
// POST /api/payouts/:id/mark-paid - Mark payout as paid
// Body: { paymentMethod, paymentReferenceId?, notes? }
// Access: owner, staff
// IMMUTABILITY: Once paid, cannot be modified
// ===========================================================================
router.post('/:id/mark-paid', requireRole('owner', 'staff'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;
    const { paymentMethod, paymentReferenceId, notes } = req.body;

    // Validate paymentMethod
    if (!paymentMethod) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'paymentMethod is required',
      });
    }

    const validPaymentMethods: PaymentType[] = ['CASH', 'ONLINE', 'CHEQUE'];
    if (!validPaymentMethods.includes(paymentMethod)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `paymentMethod must be one of: ${validPaymentMethods.join(', ')}`,
      });
    }

    // Get existing payout to verify branch
    const existing = await payoutService.getPayoutDetail(id);
    if (!existing) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Payout not found',
      });
    }

    if (existing.branchId !== branchId) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Payout belongs to a different branch',
      });
    }

    const payout = await payoutService.markPayoutPaid(
      id,
      paymentMethod as PaymentType,
      paymentReferenceId,
      notes
    );

    // Audit log: Payout marked as paid
    await logAction({
      branchId: req.branchId!,
      actionType: 'PAYOUT_PAID',
      entityType: 'Payout',
      entityId: id,
      userId: req.userId!,
      oldValues: {
        isPaid: false,
      },
      newValues: {
        isPaid: true,
        paymentMethod,
        paymentReferenceId,
        notes,
        paidAt: new Date().toISOString(),
        totalAmount: payout.totalAmountInPaise / 100,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({
      data: payout,
      message: 'Payout marked as paid successfully',
    });
  } catch (err: any) {
    console.error('Mark payout paid error:', err);
    if (err.message?.includes('already marked as paid')) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'Payout has already been paid and cannot be modified',
      });
    }
    if (err.message?.includes('not found')) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: err.message,
      });
    }
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to mark payout as paid',
    });
  }
});

export default router;
