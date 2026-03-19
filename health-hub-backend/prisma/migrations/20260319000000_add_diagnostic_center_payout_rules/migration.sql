ALTER TABLE "DiagnosticReferralCenter"
  ADD COLUMN "commissionType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
  ADD COLUMN "commissionAmountInPaise" INTEGER;

ALTER TABLE "TestOrder"
  ADD COLUMN "diagnosticCenterCommissionType" "ReferralPayoutType",
  ADD COLUMN "diagnosticCenterCommissionPercentage" DOUBLE PRECISION,
  ADD COLUMN "diagnosticCenterCommissionAmountInPaise" INTEGER;

CREATE TABLE "DiagnosticCenterProductRule" (
  "id" TEXT NOT NULL,
  "diagnosticCenterId" TEXT NOT NULL,
  "productId" TEXT NOT NULL,
  "commissionType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
  "commissionPercent" DOUBLE PRECISION,
  "commissionAmountInPaise" INTEGER,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "DiagnosticCenterProductRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DiagnosticCenterProductRule_diagnosticCenterId_productId_key"
  ON "DiagnosticCenterProductRule"("diagnosticCenterId", "productId");

CREATE INDEX "DiagnosticCenterProductRule_diagnosticCenterId_idx"
  ON "DiagnosticCenterProductRule"("diagnosticCenterId");

CREATE INDEX "DiagnosticCenterProductRule_productId_idx"
  ON "DiagnosticCenterProductRule"("productId");

ALTER TABLE "DiagnosticCenterProductRule"
  ADD CONSTRAINT "DiagnosticCenterProductRule_diagnosticCenterId_fkey"
  FOREIGN KEY ("diagnosticCenterId") REFERENCES "DiagnosticReferralCenter"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "DiagnosticCenterProductRule"
  ADD CONSTRAINT "DiagnosticCenterProductRule_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "BillableProduct"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "TestOrder" AS "to"
SET
  "diagnosticCenterCommissionType" = 'PERCENTAGE',
  "diagnosticCenterCommissionPercentage" = "dc"."commissionPercent",
  "diagnosticCenterCommissionAmountInPaise" = NULL
FROM "DiagnosticCenter_Visit" AS "dcv"
JOIN "DiagnosticReferralCenter" AS "dc"
  ON "dc"."id" = "dcv"."diagnosticCenterId"
WHERE "dcv"."visitId" = "to"."visitId"
  AND "to"."diagnosticCenterCommissionType" IS NULL;
