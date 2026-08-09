import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import * as doctorService from '../services/doctorService';
import { normalizeReferralPayoutInput } from '../services/referralPayoutService';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ==================== REFERRAL CATEGORY RATE CARD ====================

// GET /api/referral-doctors/category-rates - the rate card for a scope.
// ?branchId=<id> returns that branch's overrides + the global rows (for
// inheritance display); omitted / "global" returns just the global rows.
// (declared before the /:id routes so "category-rates" is never read as an id)
router.get('/category-rates', async (req: AuthRequest, res) => {
  try {
    const scope =
      req.query.branchId && req.query.branchId !== 'global' ? String(req.query.branchId) : null;
    const rates = await doctorService.listReferralCategoryRates(scope);
    return res.json(rates);
  } catch (err: any) {
    console.error('List referral category rates error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list referral category rates',
    });
  }
});

// PUT /api/referral-doctors/category-rates - upsert the whole rate card
router.put('/category-rates', async (req: AuthRequest, res) => {
  try {
    const { rates } = req.body;
    if (!Array.isArray(rates)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'rates must be an array',
      });
    }

    let normalized;
    try {
      normalized = rates.map((rate: any) => ({
        category: rate.category,
        ...normalizeReferralPayoutInput({
          commissionType: rate.commissionType,
          commissionPercent: rate.commissionPercent,
          commissionAmount: rate.commissionAmount,
          commissionAmountInPaise: rate.commissionAmountInPaise,
        }),
      }));
    } catch (validationErr: any) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validationErr.message,
      });
    }

    // scope = which card is being edited (null = global default, or a branch id).
    // req.branchId! is the active branch context, used only for the audit log.
    const scope =
      req.body.branchId && req.body.branchId !== 'global' ? String(req.body.branchId) : null;
    const saved = await doctorService.setReferralCategoryRates(
      normalized,
      scope,
      req.branchId!,
      req.user?.id,
    );
    return res.json(saved);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({ error: err.error, message: err.message });
    }
    console.error('Set referral category rates error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to save referral category rates',
    });
  }
});

// ==================== REFERRAL DOCTORS ====================

// POST /api/referral-doctors - Create referral doctor
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, phone, email, clinicDoctorId, productRules, categoryRules, rulesBranchId } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Name is required'
      });
    }

    let normalizedPayout;
    let normalizedProductRules;
    let normalizedCategoryRules;
    try {
      normalizedPayout = normalizeReferralPayoutInput({
        commissionType: req.body.commissionType,
        commissionPercent: req.body.commissionPercent,
        commissionAmount: req.body.commissionAmount,
        commissionAmountInPaise: req.body.commissionAmountInPaise,
      });
      normalizedProductRules = Array.isArray(productRules)
        ? productRules.map((rule: any) => ({
            productId: rule.productId,
            ...normalizeReferralPayoutInput({
              commissionType: rule.commissionType,
              commissionPercent: rule.commissionPercent,
              commissionAmount: rule.commissionAmount,
              commissionAmountInPaise: rule.commissionAmountInPaise,
            }),
          }))
        : undefined;
      normalizedCategoryRules = Array.isArray(categoryRules)
        ? categoryRules.map((rule: any) => ({
            category: rule.category,
            ...normalizeReferralPayoutInput({
              commissionType: rule.commissionType,
              commissionPercent: rule.commissionPercent,
              commissionAmount: rule.commissionAmount,
              commissionAmountInPaise: rule.commissionAmountInPaise,
            }),
          }))
        : undefined;
    } catch (validationErr: any) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validationErr.message,
      });
    }

    // Check if this person is already a referral or clinic doctor
    const existingReferral = await doctorService.searchReferralDoctorByContact(phone, email);
    if (existingReferral) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `This person is already a referral doctor: ${existingReferral.name} (${existingReferral.doctorNumber})`
      });
    }

    const existingClinic = await doctorService.searchClinicDoctorByContact(phone, email);
    if (existingClinic && !clinicDoctorId) {
      return res.status(400).json({
        error: 'DUPLICATE_DETECTED',
        message: `This person is already a clinic doctor: ${existingClinic.name} (${existingClinic.doctorNumber}). Would you like to link them?`,
        clinicDoctor: existingClinic
      });
    }

    const doctor = await doctorService.createReferralDoctor({
      name,
      phone,
      email,
      ...normalizedPayout,
      productRules: normalizedProductRules,
      categoryRules: normalizedCategoryRules,
      rulesBranchId: rulesBranchId && rulesBranchId !== 'global' ? String(rulesBranchId) : null,
      clinicDoctorId,
      branchId: req.branchId!,
      userId: req.user?.id
    });

    return res.status(201).json(doctor);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Create referral doctor error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create referral doctor'
    });
  }
});

// GET /api/referral-doctors - List all referral doctors
router.get('/', async (req: AuthRequest, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const doctors = await doctorService.listReferralDoctors(includeInactive);
    return res.json(doctors);
  } catch (err: any) {
    console.error('List referral doctors error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list referral doctors'
    });
  }
});

// PATCH /api/referral-doctors/:id - Update referral doctor
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, isActive, productRules, categoryRules, rulesBranchId } = req.body;

    let normalizedPayout;
    let normalizedProductRules;
    let normalizedCategoryRules;
    try {
      normalizedPayout =
        req.body.commissionType !== undefined ||
        req.body.commissionPercent !== undefined ||
        req.body.commissionAmount !== undefined ||
        req.body.commissionAmountInPaise !== undefined
          ? normalizeReferralPayoutInput({
              commissionType: req.body.commissionType,
              commissionPercent: req.body.commissionPercent,
              commissionAmount: req.body.commissionAmount,
              commissionAmountInPaise: req.body.commissionAmountInPaise,
            })
          : undefined;

      normalizedProductRules = Array.isArray(productRules)
        ? productRules.map((rule: any) => ({
            productId: rule.productId,
            ...normalizeReferralPayoutInput({
              commissionType: rule.commissionType,
              commissionPercent: rule.commissionPercent,
              commissionAmount: rule.commissionAmount,
              commissionAmountInPaise: rule.commissionAmountInPaise,
            }),
          }))
        : undefined;
      normalizedCategoryRules = Array.isArray(categoryRules)
        ? categoryRules.map((rule: any) => ({
            category: rule.category,
            ...normalizeReferralPayoutInput({
              commissionType: rule.commissionType,
              commissionPercent: rule.commissionPercent,
              commissionAmount: rule.commissionAmount,
              commissionAmountInPaise: rule.commissionAmountInPaise,
            }),
          }))
        : undefined;
    } catch (validationErr: any) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validationErr.message,
      });
    }

    const updated = await doctorService.updateReferralDoctor(
      id,
      {
        name,
        phone,
        email,
        isActive,
        ...normalizedPayout,
        productRules: normalizedProductRules,
        categoryRules: normalizedCategoryRules,
        rulesBranchId: rulesBranchId && rulesBranchId !== 'global' ? String(rulesBranchId) : null,
      },
      req.branchId!,
      req.user?.id
    );

    return res.json(updated);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Update referral doctor error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to update referral doctor'
    });
  }
});

// DELETE /api/referral-doctors/:id - Deactivate referral doctor
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const updated = await doctorService.deactivateReferralDoctor(
      id,
      req.branchId!,
      req.user?.id
    );

    return res.json(updated);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Deactivate referral doctor error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to deactivate referral doctor'
    });
  }
});

export default router;
