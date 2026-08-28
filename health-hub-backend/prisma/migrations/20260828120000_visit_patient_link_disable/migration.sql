-- Visit-level kill switch for the patient's online access (report link, bill QR
-- gateway, bill PDF, patient app). NULL = live (the default for every existing
-- row), so this migration is a no-op for current data.
ALTER TABLE "Visit" ADD COLUMN "patientLinkDisabledAt" TIMESTAMP(3);
ALTER TABLE "Visit" ADD COLUMN "patientLinkDisabledReason" TEXT;
ALTER TABLE "Visit" ADD COLUMN "patientLinkDisabledByUserId" TEXT;

ALTER TABLE "Visit" ADD CONSTRAINT "Visit_patientLinkDisabledByUserId_fkey"
  FOREIGN KEY ("patientLinkDisabledByUserId") REFERENCES "User"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
