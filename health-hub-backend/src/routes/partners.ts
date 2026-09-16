/**
 * Partner master API. Replaces /diagnostic-centers and /external-labs, which
 * were two endpoints for the two directions of one relationship.
 *
 * Kept mounted at /external-labs as well, so the existing "Outside Labs" screen
 * and its React Query keys keep working while the frontend moves over.
 */
import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import * as partnerService from '../services/partnerService';
import { emitCatalogChange } from '../lib/displayEvents';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);

/** Rupees → paise, and drop the field that does not apply to this basis. */
function normalizeRate(src: any) {
  const rateBasis = src.rateBasis ?? 'PCT_OF_OUR_PRICE';
  if (rateBasis === 'FLAT') {
    const paise =
      src.rateAmountInPaise != null
        ? Number(src.rateAmountInPaise)
        : Math.round(Number(src.rateAmount ?? 0) * 100);
    return { rateBasis, ratePercent: null, rateAmountInPaise: paise };
  }
  return { rateBasis, ratePercent: Number(src.ratePercent ?? 0), rateAmountInPaise: null };
}

function normalizeRules(rules: any, key: 'productId' | 'category') {
  if (!Array.isArray(rules)) return undefined;
  return rules.map((r: any) => ({
    [key]: r[key],
    branchId: r.branchId ?? null,
    ...normalizeRate(r),
    doctorCommissionMode: r.doctorCommissionMode ?? null,
  }));
}

function normalizeArrangements(arrangements: any) {
  if (!Array.isArray(arrangements)) return undefined;
  return arrangements.map((a: any) => ({
    kind: a.kind,
    weCollect: a.weCollect,
    isActive: a.isActive ?? true,
    doctorCommissionMode: a.doctorCommissionMode ?? 'OUR_SHARE',
    ...normalizeRate(a),
    productRules: normalizeRules(a.productRules, 'productId'),
    categoryRules: normalizeRules(a.categoryRules, 'category'),
  }));
}

function fail(res: Response, error: any, what: string) {
  if (error?.statusCode) {
    return res.status(error.statusCode).json({ error: error.error, message: error.message });
  }
  console.error(`Error ${what}:`, error);
  return res.status(500).json({ error: 'INTERNAL_ERROR', message: `Failed to ${what}` });
}

router.get('/', async (req: AuthRequest, res: Response) => {
  try {
    const { includeInactive, search } = req.query;
    return res.json(
      await partnerService.listPartners(
        includeInactive === 'true',
        typeof search === 'string' ? search : undefined,
      ),
    );
  } catch (e) {
    return fail(res, e, 'fetch partners');
  }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const partner = await partnerService.getPartnerById(req.params.id);
    if (!partner) return res.status(404).json({ error: 'NOT_FOUND', message: 'Partner not found' });
    return res.json(partner);
  } catch (e) {
    return fail(res, e, 'fetch partner');
  }
});

router.post('/', async (req: AuthRequest, res: Response) => {
  try {
    const { name, contactPerson, phone, email, address, sendBill, sendReport } = req.body;
    if (!name?.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Partner name is required' });
    }
    const partner = await partnerService.createPartner({
      name,
      contactPerson,
      phone,
      email,
      address,
      sendBill,
      sendReport,
      arrangements: normalizeArrangements(req.body.arrangements),
      branchId: req.branchId!,
      userId: req.user?.id,
    });
    if (req.branchId) emitCatalogChange(req.branchId, 'partners');
    return res.status(201).json(partner);
  } catch (e) {
    return fail(res, e, 'create partner');
  }
});

router.patch('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const { name, contactPerson, phone, email, address, sendBill, sendReport, isActive } = req.body;
    const updated = await partnerService.updatePartner(
      req.params.id,
      {
        name,
        contactPerson,
        phone,
        email,
        address,
        sendBill,
        sendReport,
        isActive,
        arrangements: normalizeArrangements(req.body.arrangements),
      },
      req.branchId!,
      req.user?.id,
    );
    if (req.branchId) emitCatalogChange(req.branchId, 'partners');
    return res.json(updated);
  } catch (e) {
    return fail(res, e, 'update partner');
  }
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  try {
    const result = await partnerService.deactivatePartner(
      req.params.id,
      req.branchId!,
      req.user?.id,
    );
    if (req.branchId) emitCatalogChange(req.branchId, 'partners');
    return res.json(result);
  } catch (e) {
    return fail(res, e, 'delete partner');
  }
});

export default router;
