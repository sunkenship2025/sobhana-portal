import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import * as externalLabService from '../services/externalLabService';
import { normalizeReferralPayoutInput } from '../services/referralPayoutService';
import { emitCatalogChange } from '../lib/displayEvents';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// Map the rate fields (rateType/ratePercent/rateAmount[InPaise]) through the
// shared payout normalizer (which validates + converts rupees → paise).
function normalizeRate(src: any) {
  const r = normalizeReferralPayoutInput({
    commissionType: src.rateType,
    commissionPercent: src.ratePercent,
    commissionAmount: src.rateAmount,
    commissionAmountInPaise: src.rateAmountInPaise,
  });
  return {
    rateType: r.commissionType,
    ratePercent: r.commissionPercent,
    rateAmountInPaise: r.commissionAmountInPaise,
  };
}

// Optional reduced referring-doctor commission for tests outsourced to this lab.
function normalizeReduced(src: any) {
  const hasReduced =
    src.reducedReferralCommissionType != null ||
    src.reducedReferralCommissionPercent != null ||
    src.reducedReferralCommissionAmount != null ||
    src.reducedReferralCommissionAmountInPaise != null;
  if (!hasReduced) {
    return {
      reducedReferralCommissionType: null,
      reducedReferralCommissionPercent: null,
      reducedReferralCommissionAmountInPaise: null,
    };
  }
  const r = normalizeReferralPayoutInput({
    commissionType: src.reducedReferralCommissionType,
    commissionPercent: src.reducedReferralCommissionPercent,
    commissionAmount: src.reducedReferralCommissionAmount,
    commissionAmountInPaise: src.reducedReferralCommissionAmountInPaise,
  });
  return {
    reducedReferralCommissionType: r.commissionType,
    reducedReferralCommissionPercent: r.commissionPercent,
    reducedReferralCommissionAmountInPaise: r.commissionAmountInPaise,
  };
}

function normalizeRules(productRules: any): any[] | undefined {
  if (!Array.isArray(productRules)) return undefined;
  return productRules.map((rule: any) => ({
    productId: rule.productId,
    ...normalizeRate(rule),
    ...normalizeReduced(rule),
  }));
}

// ─── GET / — List outside labs ──────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { includeInactive, search } = req.query;
    const labs = await externalLabService.listExternalLabs(
      includeInactive === 'true',
      typeof search === 'string' ? search : undefined
    );
    return res.json(labs);
  } catch (error) {
    console.error('Error fetching outside labs:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch outside labs' });
  }
});

// ─── GET /:id — Single outside lab ──────────────────────────────
router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const lab = await externalLabService.getExternalLabById(req.params.id);
    if (!lab) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Outside lab not found' });
    }
    return res.json(lab);
  } catch (error) {
    console.error('Error fetching outside lab:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch outside lab' });
  }
});

// ─── POST / — Create outside lab ────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, contactPerson, phone, email, address, productRules } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Lab name is required' });
    }

    let normalizedRate;
    let normalizedRules;
    try {
      normalizedRate = normalizeRate(req.body);
      normalizedRules = normalizeRules(productRules);
    } catch (validationErr: any) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: validationErr.message });
    }

    const lab = await externalLabService.createExternalLab({
      name,
      contactPerson,
      phone,
      email,
      address,
      ...normalizedRate,
      productRules: normalizedRules,
      branchId: req.branchId!,
      userId: req.user?.id,
    });

    if (req.branchId) emitCatalogChange(req.branchId, 'external-labs');
    return res.status(201).json(lab);
  } catch (error) {
    if ((error as any).statusCode) {
      return res.status((error as any).statusCode).json({
        error: (error as any).error,
        message: (error as any).message,
      });
    }
    console.error('Error creating outside lab:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create outside lab' });
  }
});

// ─── PATCH /:id — Update outside lab ────────────────────────────
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name, contactPerson, phone, email, address, isActive, productRules } = req.body;

    let normalizedRate;
    let normalizedRules;
    try {
      normalizedRate =
        req.body.rateType !== undefined ||
        req.body.ratePercent !== undefined ||
        req.body.rateAmount !== undefined ||
        req.body.rateAmountInPaise !== undefined
          ? normalizeRate(req.body)
          : undefined;
      normalizedRules = normalizeRules(productRules);
    } catch (validationErr: any) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: validationErr.message });
    }

    const updated = await externalLabService.updateExternalLab(
      req.params.id,
      {
        name,
        contactPerson,
        phone,
        email,
        address,
        isActive,
        ...normalizedRate,
        productRules: normalizedRules,
      },
      req.branchId!,
      req.user?.id
    );

    if (req.branchId) emitCatalogChange(req.branchId, 'external-labs');
    return res.json(updated);
  } catch (error) {
    if ((error as any).statusCode) {
      return res.status((error as any).statusCode).json({
        error: (error as any).error,
        message: (error as any).message,
      });
    }
    console.error('Error updating outside lab:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update outside lab' });
  }
});

// ─── DELETE /:id — Deactivate outside lab ───────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await externalLabService.deactivateExternalLab(
      req.params.id,
      req.branchId!,
      req.user?.id
    );
    if (req.branchId) emitCatalogChange(req.branchId, 'external-labs');
    return res.json(result);
  } catch (error) {
    if ((error as any).statusCode) {
      return res.status((error as any).statusCode).json({
        error: (error as any).error,
        message: (error as any).message,
      });
    }
    console.error('Error deleting outside lab:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete outside lab' });
  }
});

export default router;
