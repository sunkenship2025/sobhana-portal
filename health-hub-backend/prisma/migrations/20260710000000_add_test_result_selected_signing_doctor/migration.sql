-- Pin which signing doctor read a narrative/text report when the department has
-- multiple SigningRules (radiology). Additive, nullable — safe on a live table;
-- existing rows stay NULL and keep the "render all configured rules" behavior.
ALTER TABLE "TestResult" ADD COLUMN "selectedSigningDoctorId" TEXT;
