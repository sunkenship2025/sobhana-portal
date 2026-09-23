-- VoiceRx, part 2 of 2: the first structured prescription this portal has had.
--
-- Nothing here touches an existing row's behaviour. Before this migration a
-- "prescription" was a BLANK Rx sheet printed on letterhead, and that stays
-- true for every visit with no Prescription row — the print button is unchanged
-- and every historical visit keeps it forever. This is purely additive.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE "PrescriptionStatus" AS ENUM ('DRAFT', 'SIGNED', 'SUPERSEDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "MedicationResolution" AS ENUM ('RESOLVED', 'AMBIGUOUS', 'UNRESOLVED', 'MANUAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- ClinicDoctor gains a login, a signature, and an optional HPR id
-- ---------------------------------------------------------------------------
-- userId is NULLABLE so all ~40 existing ClinicDoctor rows stay valid with no
-- login, and UNIQUE so one login is exactly one doctor — a prescription
-- signature must be attributable to a single human.
ALTER TABLE "ClinicDoctor" ADD COLUMN IF NOT EXISTS "userId" TEXT;
-- Same base64 storage as SigningDoctor/SigningLabIncharge: survives a Render
-- deploy, and feeds the SignatureEditor background-removal pipeline unchanged.
ALTER TABLE "ClinicDoctor" ADD COLUMN IF NOT EXISTS "signatureImageBase64" TEXT;
-- ABDM Healthcare Professionals Registry id. Optional and staying optional:
-- HPR registration is voluntary and most clinic doctors do not hold one.
ALTER TABLE "ClinicDoctor" ADD COLUMN IF NOT EXISTS "hprId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "ClinicDoctor_userId_key" ON "ClinicDoctor"("userId");

ALTER TABLE "ClinicDoctor" DROP CONSTRAINT IF EXISTS "ClinicDoctor_userId_fkey";
ALTER TABLE "ClinicDoctor" ADD CONSTRAINT "ClinicDoctor_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Medication catalogue — the layer that decides what a spoken name IS.
-- Deliberately not model-derived: it must be inspectable and correctable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Medication" (
  "id"            TEXT NOT NULL,
  "canonicalName" TEXT NOT NULL,
  "genericName"   TEXT,
  "brandName"     TEXT,
  "manufacturer"  TEXT,
  "strength"      TEXT,
  "strengthUnit"  TEXT,
  "dosageForm"    TEXT,
  "route"         TEXT,
  "aliases"       TEXT[] DEFAULT ARRAY[]::TEXT[],
  "phoneticKey"   TEXT,
  -- Telemedicine Practice Guidelines §3.7.4 prohibits prescribing these
  -- remotely, absolutely. The validator treats them as an UN-OVERRIDABLE block.
  "isScheduleX"   BOOLEAN NOT NULL DEFAULT false,
  "isNdps"        BOOLEAN NOT NULL DEFAULT false,
  "scheduleClass" TEXT,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  "deletedAt"     TIMESTAMP(3),
  CONSTRAINT "Medication_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Medication_canonicalName_idx" ON "Medication"("canonicalName");
CREATE INDEX IF NOT EXISTS "Medication_genericName_idx"   ON "Medication"("genericName");
CREATE INDEX IF NOT EXISTS "Medication_brandName_idx"     ON "Medication"("brandName");
CREATE INDEX IF NOT EXISTS "Medication_phoneticKey_idx"   ON "Medication"("phoneticKey");
CREATE INDEX IF NOT EXISTS "Medication_isActive_deletedAt_idx" ON "Medication"("isActive", "deletedAt");

-- ---------------------------------------------------------------------------
-- Prescription — revisioned, and immutable once signed
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "Prescription" (
  "id"                 TEXT NOT NULL,
  "visitId"            TEXT NOT NULL,
  "clinicDoctorId"     TEXT NOT NULL,
  "branchId"           TEXT NOT NULL,
  -- rootId groups every revision; the patient link resolves rootId -> latest
  -- SIGNED, never a pinned version. Reports already learned that a token pinned
  -- to one version keeps serving a superseded document.
  "rootId"             TEXT NOT NULL,
  "version"            INTEGER NOT NULL DEFAULT 1,
  "isLatest"           BOOLEAN NOT NULL DEFAULT true,
  "previousVersionId"  TEXT,
  "revisionReason"     TEXT,
  "status"             "PrescriptionStatus" NOT NULL DEFAULT 'DRAFT',
  "diagnosis"          TEXT,
  "notes"              TEXT,
  "followUpDays"       INTEGER,
  "signedAt"           TIMESTAMP(3),
  "signedByUserId"     TEXT,
  -- EVERYTHING the signed sheet renders from. Immutability is a frozen payload,
  -- not a status column: a doctor editing their qualification next month must
  -- not rewrite a document they signed in September.
  "snapshot"           JSONB,
  "transcript"         TEXT,
  "transcriptSegments" JSONB,
  "asrProvider"        TEXT,
  "asrModel"           TEXT,
  "asrLanguage"        TEXT,
  "extractionModel"    TEXT,
  "audioKey"           TEXT,
  "audioDurationSec"   DOUBLE PRECISION,
  "audioDeletedAt"     TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"          TIMESTAMP(3) NOT NULL,
  "deletedAt"          TIMESTAMP(3),
  CONSTRAINT "Prescription_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "Prescription_visitId_idx"        ON "Prescription"("visitId");
CREATE INDEX IF NOT EXISTS "Prescription_clinicDoctorId_idx" ON "Prescription"("clinicDoctorId");
CREATE INDEX IF NOT EXISTS "Prescription_branchId_idx"       ON "Prescription"("branchId");
CREATE INDEX IF NOT EXISTS "Prescription_rootId_isLatest_idx" ON "Prescription"("rootId", "isLatest");
CREATE INDEX IF NOT EXISTS "Prescription_status_idx"         ON "Prescription"("status");
CREATE INDEX IF NOT EXISTS "Prescription_createdAt_idx"      ON "Prescription"("createdAt");
CREATE INDEX IF NOT EXISTS "Prescription_deletedAt_idx"      ON "Prescription"("deletedAt");

-- ---------------------------------------------------------------------------
-- PrescriptionItem — one medicine, with per-field provenance
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PrescriptionItem" (
  "id"             TEXT NOT NULL,
  "prescriptionId" TEXT NOT NULL,
  "displayOrder"   INTEGER NOT NULL DEFAULT 0,
  -- What the doctor actually said, kept verbatim even after normalisation, so a
  -- later reader can tell dictation from normalisation.
  "spokenText"     TEXT,
  "medicationId"   TEXT,
  "canonicalName"  TEXT NOT NULL,
  "genericName"    TEXT,
  "brandName"      TEXT,
  "strength"       TEXT,
  "strengthUnit"   TEXT,
  "dosageForm"     TEXT,
  "doseQty"        TEXT,
  "doseUnit"       TEXT,
  "frequencyCode"  TEXT,
  "frequencyText"  TEXT,
  "route"          TEXT,
  "timing"         TEXT,
  "durationValue"  INTEGER,
  "durationUnit"   TEXT,
  "instructions"   TEXT,
  "resolution"     "MedicationResolution" NOT NULL DEFAULT 'MANUAL',
  -- Candidates when AMBIGUOUS. Rendered stacked and spelt out in full, never
  -- truncated and never pre-selected.
  "candidates"     JSONB,
  -- Per-field provenance: SPOKEN / NORMALIZED / UNKNOWN. "Not stated" is a
  -- VALUE, never a silent default.
  "fieldStates"    JSONB,
  "sourceText"     TEXT,
  "sourceStart"    DOUBLE PRECISION,
  "sourceEnd"      DOUBLE PRECISION,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PrescriptionItem_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "PrescriptionItem_prescriptionId_idx" ON "PrescriptionItem"("prescriptionId");
CREATE INDEX IF NOT EXISTS "PrescriptionItem_medicationId_idx"   ON "PrescriptionItem"("medicationId");

-- ---------------------------------------------------------------------------
-- PrescriptionAccessToken — mirrors BillAccessToken exactly
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "PrescriptionAccessToken" (
  "id"             TEXT NOT NULL,
  "token"          TEXT NOT NULL,
  "prescriptionId" TEXT NOT NULL,
  "expiresAt"      TIMESTAMP(3),
  "revokedAt"      TIMESTAMP(3),
  "accessCount"    INTEGER NOT NULL DEFAULT 0,
  "lastAccessedAt" TIMESTAMP(3),
  "lastAccessedIp" TEXT,
  "createdAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PrescriptionAccessToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PrescriptionAccessToken_token_key" ON "PrescriptionAccessToken"("token");
CREATE INDEX IF NOT EXISTS "PrescriptionAccessToken_prescriptionId_idx" ON "PrescriptionAccessToken"("prescriptionId");
CREATE INDEX IF NOT EXISTS "PrescriptionAccessToken_expiresAt_idx" ON "PrescriptionAccessToken"("expiresAt");

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------
ALTER TABLE "Prescription" DROP CONSTRAINT IF EXISTS "Prescription_visitId_fkey";
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_visitId_fkey"
  FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Prescription" DROP CONSTRAINT IF EXISTS "Prescription_clinicDoctorId_fkey";
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_clinicDoctorId_fkey"
  FOREIGN KEY ("clinicDoctorId") REFERENCES "ClinicDoctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Prescription" DROP CONSTRAINT IF EXISTS "Prescription_branchId_fkey";
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Prescription" DROP CONSTRAINT IF EXISTS "Prescription_signedByUserId_fkey";
ALTER TABLE "Prescription" ADD CONSTRAINT "Prescription_signedByUserId_fkey"
  FOREIGN KEY ("signedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PrescriptionItem" DROP CONSTRAINT IF EXISTS "PrescriptionItem_prescriptionId_fkey";
ALTER TABLE "PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_prescriptionId_fkey"
  FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PrescriptionItem" DROP CONSTRAINT IF EXISTS "PrescriptionItem_medicationId_fkey";
ALTER TABLE "PrescriptionItem" ADD CONSTRAINT "PrescriptionItem_medicationId_fkey"
  FOREIGN KEY ("medicationId") REFERENCES "Medication"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "PrescriptionAccessToken" DROP CONSTRAINT IF EXISTS "PrescriptionAccessToken_prescriptionId_fkey";
ALTER TABLE "PrescriptionAccessToken" ADD CONSTRAINT "PrescriptionAccessToken_prescriptionId_fkey"
  FOREIGN KEY ("prescriptionId") REFERENCES "Prescription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Diagnostics are OFF by default for doctor logins.
-- Server-enforced: when false the doctor endpoints do not FETCH test data at
-- all, because a hidden field is still a payload.
-- ---------------------------------------------------------------------------
INSERT INTO "AppSetting" ("key", "value", "updatedAt")
VALUES ('doctor_view_diagnostics', 'false', CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO NOTHING;
