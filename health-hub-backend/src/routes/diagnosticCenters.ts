import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import * as diagnosticCenterService from '../services/diagnosticCenterService';
import { normalizeReferralPayoutInput } from '../services/referralPayoutService';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── GET / — List all diagnostic referral centers ────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { includeInactive, search } = req.query;
    const centers = await diagnosticCenterService.listDiagnosticCenters(
      includeInactive === 'true',
      typeof search === 'string' ? search : undefined
    );

    return res.json(centers);
  } catch (error) {
    console.error('Error fetching diagnostic centers:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch diagnostic centers' });
  }
});

// ─── GET /:id — Get a single diagnostic center with details ─────
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const center = await diagnosticCenterService.getDiagnosticCenterById(req.params.id);

    if (!center) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Diagnostic center not found' });
    }

    return res.json(center);
  } catch (error) {
    console.error('Error fetching diagnostic center:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch diagnostic center' });
  }
});

// ─── POST / — Create a new diagnostic referral center ────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const {
      name,
      contactPerson,
      phone,
      email,
      address,
      productRules,
    } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Center name is required' });
    }

    let normalizedPayout;
    let normalizedProductRules;
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
    } catch (validationErr: any) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validationErr.message,
      });
    }

    const center = await diagnosticCenterService.createDiagnosticCenter({
      name,
      contactPerson,
      phone,
      email,
      address,
      ...normalizedPayout,
      productRules: normalizedProductRules,
      branchId: req.branchId!,
      userId: req.user?.id,
    });

    return res.status(201).json(center);
  } catch (error) {
    if ((error as any).statusCode) {
      return res.status((error as any).statusCode).json({
        error: (error as any).error,
        message: (error as any).message,
      });
    }
    console.error('Error creating diagnostic center:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create diagnostic center' });
  }
});

// ─── PATCH /:id — Update a diagnostic referral center ────────────
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name, contactPerson, phone, email, address, isActive, productRules } = req.body;

    let normalizedPayout;
    let normalizedProductRules;
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
    } catch (validationErr: any) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: validationErr.message,
      });
    }

    const updated = await diagnosticCenterService.updateDiagnosticCenter(
      req.params.id,
      {
        name,
        contactPerson,
        phone,
        email,
        address,
        isActive,
        ...normalizedPayout,
        productRules: normalizedProductRules,
      },
      req.branchId!,
      req.user?.id
    );

    return res.json(updated);
  } catch (error) {
    if ((error as any).statusCode) {
      return res.status((error as any).statusCode).json({
        error: (error as any).error,
        message: (error as any).message,
      });
    }
    console.error('Error updating diagnostic center:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update diagnostic center' });
  }
});

// ─── DELETE /:id — Soft-delete a diagnostic referral center ──────
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await diagnosticCenterService.deactivateDiagnosticCenter(
      req.params.id,
      req.branchId!,
      req.user?.id
    );

    return res.json(result);
  } catch (error) {
    if ((error as any).statusCode) {
      return res.status((error as any).statusCode).json({
        error: (error as any).error,
        message: (error as any).message,
      });
    }
    console.error('Error deleting diagnostic center:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete diagnostic center' });
  }
});

export default router;
