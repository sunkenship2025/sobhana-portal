-- Per-coupon product scope: when non-empty, the 50% discount applies ONLY to
-- bill line items whose productId is in this set (the patient's abnormal panels).
-- Empty [] = fall back to the campaign scope (all in-scope tests) — unchanged behaviour.
ALTER TABLE "Coupon" ADD COLUMN "allowedProductIds" TEXT[] NOT NULL DEFAULT '{}';
