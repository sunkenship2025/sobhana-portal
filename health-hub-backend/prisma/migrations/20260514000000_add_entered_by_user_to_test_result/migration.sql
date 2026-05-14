-- Per-technician attribution on TestResult.
--
-- Adds enteredByUserId so we can answer "who entered this result?" for every
-- new row. Nullable because:
--   (a) all pre-migration rows are honestly unknown — backfilling with a
--       placeholder user would corrupt future quality-control analytics
--       (clustering, technician-error rates, drift detection).
--   (b) on report re-issue, the new ReportVersion carries forward the
--       *original* entrant's id, not the user who triggered the re-version.
--
-- ON DELETE SET NULL: if a staff user is removed, the result row is kept
-- (clinical data is immutable) but the attribution is dropped.

ALTER TABLE "TestResult"
  ADD COLUMN "enteredByUserId" TEXT;

CREATE INDEX "TestResult_enteredByUserId_idx"
  ON "TestResult"("enteredByUserId");

ALTER TABLE "TestResult"
  ADD CONSTRAINT "TestResult_enteredByUserId_fkey"
  FOREIGN KEY ("enteredByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
