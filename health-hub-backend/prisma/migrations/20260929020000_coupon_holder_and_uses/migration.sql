-- Who may use a code, how many times, and one row per use. Strictly additive.

CREATE TYPE "CouponHolder" AS ENUM ('ANYONE', 'ISSUED_PATIENT_ONLY', 'NOT_ISSUED_PATIENT');

ALTER TABLE "CouponCampaign"
  ADD COLUMN "holder" "CouponHolder" NOT NULL DEFAULT 'ANYONE',
  ADD COLUMN "maxUsesPerCode" INTEGER NOT NULL DEFAULT 1;

-- bindToPatient → holder, in SQL (a prisma/ script would run main() on import against prod).
UPDATE "CouponCampaign" SET "holder" = 'ISSUED_PATIENT_ONLY' WHERE "bindToPatient" = true;

ALTER TABLE "Coupon"
  ADD COLUMN "maxUses" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "useCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "reservedPerUseInPaise" INTEGER NOT NULL DEFAULT 0;

UPDATE "Coupon" SET "useCount" = 1 WHERE "status" = 'REDEEMED';

CREATE TABLE "CouponRedemption" (
    "id" TEXT NOT NULL,
    "couponId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "patientId" TEXT,
    "phone" TEXT,
    "redeemedByUserId" TEXT,
    "discountInPaise" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reversedAt" TIMESTAMP(3),
    "reversedReason" TEXT,
    CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CouponRedemption_couponId_billId_key" ON "CouponRedemption"("couponId", "billId");
CREATE INDEX "CouponRedemption_couponId_idx" ON "CouponRedemption"("couponId");
CREATE INDEX "CouponRedemption_patientId_idx" ON "CouponRedemption"("patientId");
CREATE INDEX "CouponRedemption_visitId_idx" ON "CouponRedemption"("visitId");

ALTER TABLE "CouponRedemption" ADD CONSTRAINT "CouponRedemption_couponId_fkey"
    FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Existing uses become rows. INNER JOIN on the bill: a redemption whose bill no longer
-- exists (prod has one — a July test whose visit and bill were hard-deleted) was never a
-- real use, and stays REDEEMED with no row rather than inventing one.
INSERT INTO "CouponRedemption" ("id", "couponId", "visitId", "billId", "patientId", "redeemedByUserId", "discountInPaise", "createdAt")
SELECT 'bk_' || c."id", c."id", c."redeemedVisitId", c."redeemedBillId", v."patientId",
       c."redeemedByUserId", COALESCE(b."couponDiscountInPaise", 0), COALESCE(c."redeemedAt", c."updatedAt")
FROM "Coupon" c
JOIN "Bill" b ON b."id" = c."redeemedBillId"
JOIN "Visit" v ON v."id" = c."redeemedVisitId"
WHERE c."status" = 'REDEEMED';

-- Spent budget was never recorded anywhere; start it from the uses that exist.
UPDATE "CouponCampaign" cc SET "committedInPaise" = s.total
FROM (
  SELECT c."campaignId", SUM(r."discountInPaise") AS total
  FROM "CouponRedemption" r JOIN "Coupon" c ON c."id" = r."couponId"
  WHERE r."reversedAt" IS NULL GROUP BY c."campaignId"
) s
WHERE s."campaignId" = cc."id";
