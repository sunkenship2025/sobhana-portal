/**
 * Coupon Routes  —  /api/coupons
 *
 * Staff-facing coupon validation used by the billing screens. Redemption itself
 * happens atomically inside bill creation (see diagnosticVisits/clinicVisits);
 * this endpoint just previews a code so the UI can auto-fill the coupon line.
 */

import { Router } from 'express';
import { authMiddleware } from '../middleware/auth';
import { validateCouponByCode } from '../services/couponService';

const router = Router();
router.use(authMiddleware);

// GET /api/coupons/validate?code=BLOOD-4K9X2
router.get('/validate', async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) {
    return res.status(400).json({ ok: false, reason: 'NOT_FOUND', message: 'Enter a coupon code.' });
  }
  try {
    // Who is being billed. Without it a coupon bound to its patient was refused for
    // EVERYONE, the patient it was sent to included: the check reads a missing patient
    // as the wrong one, which is the safe direction and was hitting every bound code.
    const patientId = typeof req.query.patientId === 'string' && req.query.patientId ? req.query.patientId : null;
    const v = await validateCouponByCode(code, patientId);
    if (!v.ok || !v.coupon || !v.campaign) {
      return res.json({
        ok: false,
        reason: v.reason,
        message:
          v.reason === 'ALREADY_REDEEMED'
            ? 'This code has already been used up.'
            : v.reason === 'EXPIRED'
              ? 'This coupon has expired.'
              : v.reason === 'NOT_FOUND'
                ? 'No coupon found for that code.'
                : v.reason === 'WRONG_PATIENT'
                  ? 'This coupon was issued to a different patient.'
                  : v.reason === 'OWN_CODE'
                    ? "This code is for the patient's family and friends — it can't be used by the person it was given to."
                    : v.reason === 'BUDGET_USED_UP'
                      ? "This offer's budget has been used up."
                      : "This coupon can't be applied.",
      });
    }
    return res.json({
      ok: true,
      code: v.coupon.code,
      usesLeft: v.coupon.usesLeft,
      discountType: v.campaign.discountType,
      discountPercentage: v.campaign.discountPercentage,
      scope: v.campaign.scope,
      // The counter's preview applies these exactly as the bill will. Without them it
      // showed 50% of the whole test total while the bill took the capped amount, and
      // the difference surfaced as a due nobody had explained to the patient.
      maxDiscountPerBillInPaise: v.campaign.maxDiscountPerBillInPaise,
      allowedProductIds: v.coupon.allowedProductIds,
      campaignName: v.campaign.name,
      discountReason: v.campaign.discountReason,
      expiresAt: v.coupon.expiresAt,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Could not validate coupon.' });
  }
});

export default router;
