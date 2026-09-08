-- Height/weight move to the VISIT.
--
-- They lived on Patient and were read LIVE at render time, so a finalized Smart
-- Report recomputed its BMI from whatever the patient weighed today. Re-weighing
-- someone silently rewrote every past report — the mutation panelsSnapshot /
-- patientSnapshot / visitSnapshot exist to prevent.
--
-- Nullable and not backfilled on purpose: an old visit has no recorded weight, and
-- inventing one from Patient.weightKg would assert a measurement that was never
-- taken at that visit. present.ts falls back to Patient for pre-existing reports.
ALTER TABLE "Visit" ADD COLUMN IF NOT EXISTS "heightCm" DOUBLE PRECISION;
ALTER TABLE "Visit" ADD COLUMN IF NOT EXISTS "weightKg" DOUBLE PRECISION;
