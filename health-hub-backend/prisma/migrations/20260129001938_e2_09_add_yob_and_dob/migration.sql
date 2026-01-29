-- AlterEnum
-- Remove REVERT from AuditActionType enum
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'TEMP_PLACEHOLDER';
UPDATE "PatientChangeLog" SET action = 'TEMP_PLACEHOLDER' WHERE action = 'REVERT';
ALTER TYPE "AuditActionType" RENAME TO "AuditActionType_old";
CREATE TYPE "AuditActionType" AS ENUM ('CREATE', 'UPDATE', 'MERGE', 'ROLLBACK');
ALTER TABLE "PatientChangeLog" ALTER COLUMN "action" TYPE "AuditActionType" USING ("action"::text::"AuditActionType");
DROP TYPE "AuditActionType_old";

-- E2-09: Add dateOfBirth (optional) and yearOfBirth (required)
-- Step 1: Add new columns as nullable first
ALTER TABLE "Patient" ADD COLUMN "dateOfBirth" TIMESTAMP(3);
ALTER TABLE "Patient" ADD COLUMN "yearOfBirth" INTEGER;

-- Step 2: Migrate existing age data to yearOfBirth
-- Calculate yearOfBirth = current year - age
UPDATE "Patient" 
SET "yearOfBirth" = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER - age
WHERE "yearOfBirth" IS NULL;

-- Step 3: Make yearOfBirth NOT NULL now that data is migrated
ALTER TABLE "Patient" ALTER COLUMN "yearOfBirth" SET NOT NULL;

-- Step 4: Add index on yearOfBirth for queries
CREATE INDEX "Patient_yearOfBirth_idx" ON "Patient"("yearOfBirth");

-- Step 5: Drop the old age column
ALTER TABLE "Patient" DROP COLUMN "age";
