-- AlterTable: Replace minAgeYears/maxAgeYears with minAgeDays/maxAgeDays
-- for newborn/infant precision (age stored in total days)

-- Drop old unique constraint
DROP INDEX IF EXISTS "TestAgeRange_testId_minAgeYears_maxAgeYears_gender_key";

-- Rename columns
ALTER TABLE "TestAgeRange" RENAME COLUMN "minAgeYears" TO "minAgeDays";
ALTER TABLE "TestAgeRange" RENAME COLUMN "maxAgeYears" TO "maxAgeDays";

-- Add new unique constraint
CREATE UNIQUE INDEX "TestAgeRange_testId_minAgeDays_maxAgeDays_gender_key" ON "TestAgeRange"("testId", "minAgeDays", "maxAgeDays", "gender");
