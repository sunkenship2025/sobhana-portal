-- E2-09: Add dateOfBirth (optional) and yearOfBirth (required)
-- Step 1: Add new columns as nullable first
ALTER TABLE "Patient" ADD COLUMN IF NOT EXISTS "dateOfBirth" TIMESTAMP(3);
ALTER TABLE "Patient" ADD COLUMN IF NOT EXISTS "yearOfBirth" INTEGER;

-- Step 2: Migrate existing age data to yearOfBirth (if age column exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Patient' AND column_name = 'age') THEN
    UPDATE "Patient" 
    SET "yearOfBirth" = EXTRACT(YEAR FROM CURRENT_DATE)::INTEGER - age
    WHERE "yearOfBirth" IS NULL;
  END IF;
END $$;

-- Step 3: Set default yearOfBirth for any remaining NULL values
UPDATE "Patient" SET "yearOfBirth" = 1990 WHERE "yearOfBirth" IS NULL;

-- Step 4: Make yearOfBirth NOT NULL now that data is migrated
ALTER TABLE "Patient" ALTER COLUMN "yearOfBirth" SET NOT NULL;

-- Step 5: Add index on yearOfBirth for queries (if not exists)
CREATE INDEX IF NOT EXISTS "Patient_yearOfBirth_idx" ON "Patient"("yearOfBirth");

-- Step 6: Drop the old age column if it exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'Patient' AND column_name = 'age') THEN
    ALTER TABLE "Patient" DROP COLUMN "age";
  END IF;
END $$;
