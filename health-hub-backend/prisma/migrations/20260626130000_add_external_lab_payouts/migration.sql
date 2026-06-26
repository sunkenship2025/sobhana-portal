-- Add Outside-Lab vendor payouts: ExternalLab + ExternalLabProductRule, TestOrder
-- vendor-cost snapshot, and a LAB payout type on DoctorPayoutLedger.

-- 1. Enum value (safe in-file: 'LAB' is not referenced again in this migration)
ALTER TYPE "PayoutDoctorType" ADD VALUE IF NOT EXISTS 'LAB';

-- 2. ExternalLab vendor master
CREATE TABLE "ExternalLab" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "labNumber" TEXT NOT NULL,
  "contactPerson" TEXT,
  "phone" TEXT,
  "email" TEXT,
  "address" TEXT,
  "rateType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
  "ratePercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "rateAmountInPaise" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalLab_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExternalLab_labNumber_key" ON "ExternalLab"("labNumber");
CREATE INDEX "ExternalLab_isActive_idx" ON "ExternalLab"("isActive");
CREATE INDEX "ExternalLab_createdAt_idx" ON "ExternalLab"("createdAt");

-- 3. ExternalLabProductRule (per-product rate + optional reduced doctor commission)
CREATE TABLE "ExternalLabProductRule" (
  "id" TEXT NOT NULL,
  "externalLabId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "rateType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
  "ratePercent" DOUBLE PRECISION,
  "rateAmountInPaise" INTEGER,
  "reducedReferralCommissionType" "ReferralPayoutType",
  "reducedReferralCommissionPercent" DOUBLE PRECISION,
  "reducedReferralCommissionAmountInPaise" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExternalLabProductRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ExternalLabProductRule_externalLabId_productId_key" ON "ExternalLabProductRule"("externalLabId", "productId");
CREATE INDEX "ExternalLabProductRule_externalLabId_idx" ON "ExternalLabProductRule"("externalLabId");
CREATE INDEX "ExternalLabProductRule_productId_idx" ON "ExternalLabProductRule"("productId");
ALTER TABLE "ExternalLabProductRule" ADD CONSTRAINT "ExternalLabProductRule_externalLabId_fkey" FOREIGN KEY ("externalLabId") REFERENCES "ExternalLab"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalLabProductRule" ADD CONSTRAINT "ExternalLabProductRule_productId_fkey" FOREIGN KEY ("productId") REFERENCES "BillableProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. TestOrder outsource FK + immutable vendor-cost snapshot
ALTER TABLE "TestOrder"
  ADD COLUMN "externalLabId" TEXT,
  ADD COLUMN "labCostType" "ReferralPayoutType",
  ADD COLUMN "labCostPercentage" DOUBLE PRECISION,
  ADD COLUMN "labCostAmountInPaise" INTEGER;
CREATE INDEX "TestOrder_externalLabId_idx" ON "TestOrder"("externalLabId");
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_externalLabId_fkey" FOREIGN KEY ("externalLabId") REFERENCES "ExternalLab"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. DoctorPayoutLedger LAB FK
ALTER TABLE "DoctorPayoutLedger" ADD COLUMN "externalLabId" TEXT;
CREATE INDEX "DoctorPayoutLedger_externalLabId_idx" ON "DoctorPayoutLedger"("externalLabId");
ALTER TABLE "DoctorPayoutLedger" ADD CONSTRAINT "DoctorPayoutLedger_externalLabId_fkey" FOREIGN KEY ("externalLabId") REFERENCES "ExternalLab"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 6. Rebuild partial-unique to include externalLabId (PLAIN columns — match existing index semantics)
DROP INDEX "DoctorPayoutLedger_active_payout_uniq";
CREATE UNIQUE INDEX "DoctorPayoutLedger_active_payout_uniq" ON "DoctorPayoutLedger"(
  "doctorType", "referralDoctorId", "clinicDoctorId", "diagnosticCenterId", "externalLabId", "branchId", "periodStartDate", "periodEndDate"
) WHERE "deletedAt" IS NULL;

-- 7. Rebuild perf lookup index to match schema @@index column set
DROP INDEX "DoctorPayoutLedger_lookup_idx";
CREATE INDEX "DoctorPayoutLedger_lookup_idx" ON "DoctorPayoutLedger"(
  "doctorType", "referralDoctorId", "clinicDoctorId", "diagnosticCenterId", "externalLabId", "branchId", "periodStartDate", "periodEndDate"
);
