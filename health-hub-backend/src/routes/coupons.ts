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
    const v = await validateCouponByCode(code);
    if (!v.ok || !v.coupon || !v.campaign) {
      return res.json({
        ok: false,
        reason: v.reason,
        message:
          v.reason === 'ALREADY_REDEEMED'
            ? 'This coupon has already been used.'
            : v.reason === 'EXPIRED'
              ? 'This coupon has expired.'
              : v.reason === 'NOT_FOUND'
                ? 'No coupon found for that code.'
                : "This coupon can't be applied.",
      });
    }
    return res.json({
      ok: true,
      code: v.coupon.code,
      discountType: v.campaign.discountType,
      discountPercentage: v.campaign.discountPercentage,
      scope: v.campaign.scope,
      campaignName: v.campaign.name,
      discountReason: v.campaign.discountReason,
      expiresAt: v.coupon.expiresAt,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, message: 'Could not validate coupon.' });
  }
});

export default router;
