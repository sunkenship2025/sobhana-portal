CREATE TYPE "ReferralPayoutType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

ALTER TABLE "ReferralDoctor"
  ADD COLUMN "commissionType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
  ADD COLUMN "commissionAmountInPaise" INTEGER;

CREATE TABLE "ReferralDoctorProductRule" (
  "id" TEXT NOT NULL,
  "referralDoctorId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "commissionType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
  "commissionPercent" DOUBLE PRECISION,
  "commissionAmountInPaise" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ReferralDoctorProductRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReferralDoctorProductRule_referralDoctorId_productId_key"
  ON "ReferralDoctorProductRule"("referralDoctorId", "productId");

CREATE INDEX "ReferralDoctorProductRule_referralDoctorId_idx"
  ON "ReferralDoctorProductRule"("referralDoctorId");

CREATE INDEX "ReferralDoctorProductRule_productId_idx"
  ON "ReferralDoctorProductRule"("productId");

ALTER TABLE "ReferralDoctorProductRule"
  ADD CONSTRAINT "ReferralDoctorProductRule_referralDoctorId_fkey"
  FOREIGN KEY ("referralDoctorId") REFERENCES "ReferralDoctor"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ReferralDoctorProductRule"
  ADD CONSTRAINT "ReferralDoctorProductRule_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "BillableProduct"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TestOrder"
  ADD COLUMN "referralCommissionType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
  ADD COLUMN "referralCommissionAmountInPaise" INTEGER;

ALTER TABLE "TestOrder"
  ALTER COLUMN "referralCommissionPercentage" DROP NOT NULL;
