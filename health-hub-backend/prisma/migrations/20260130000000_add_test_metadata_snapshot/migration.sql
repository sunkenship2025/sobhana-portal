-- E3-03: Test Order Creation per Visit - Add test metadata snapshot
-- This migration adds columns to snapshot test metadata at order time,
-- ensuring that test details are preserved even if the master catalog changes.

-- Add metadata snapshot columns to TestOrder
ALTER TABLE "TestOrder" ADD COLUMN "testNameSnapshot" TEXT;
ALTER TABLE "TestOrder" ADD COLUMN "testCodeSnapshot" TEXT;
ALTER TABLE "TestOrder" ADD COLUMN "referenceMinSnapshot" DOUBLE PRECISION;
ALTER TABLE "TestOrder" ADD COLUMN "referenceMaxSnapshot" DOUBLE PRECISION;
ALTER TABLE "TestOrder" ADD COLUMN "referenceUnitSnapshot" TEXT;

-- Backfill existing TestOrders with current test metadata
UPDATE "TestOrder" 
SET 
  "testNameSnapshot" = "LabTest"."name",
  "testCodeSnapshot" = "LabTest"."code",
  "referenceMinSnapshot" = "LabTest"."referenceMin",
  "referenceMaxSnapshot" = "LabTest"."referenceMax",
  "referenceUnitSnapshot" = "LabTest"."referenceUnit"
FROM "LabTest"
WHERE "TestOrder"."testId" = "LabTest"."id";

-- Make snapshot columns non-nullable after backfill
ALTER TABLE "TestOrder" ALTER COLUMN "testNameSnapshot" SET NOT NULL;
ALTER TABLE "TestOrder" ALTER COLUMN "testCodeSnapshot" SET NOT NULL;

-- Add index on branchId for efficient queries
CREATE INDEX IF NOT EXISTS "TestOrder_branchId_createdAt_idx" ON "TestOrder"("branchId", "createdAt");
