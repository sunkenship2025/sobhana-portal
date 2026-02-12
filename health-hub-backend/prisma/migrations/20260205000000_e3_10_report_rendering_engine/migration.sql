-- E3-10: Diagnostic Report Rendering Engine
-- This migration adds all tables required for:
-- 1. Panel-driven report layout configuration
-- 2. Department-based grouping
-- 3. Signing rules and doctor signatures
-- 4. Interpretation templates
-- 5. Report access tokens
-- 6. Report snapshot storage

-- ============================================================================
-- ENUMS
-- ============================================================================

-- Panel layout types
CREATE TYPE "PanelLayoutType" AS ENUM (
  'STANDARD_TABLE',    -- Simple test name | value | unit | reference table
  'CBP',               -- Composite: main table + differential + peripheral smear
  'WIDAL',             -- Dilution format with multiple antigens
  'INTERPRETATION_SINGLE',  -- Single test with interpretation block
  'TEXT_ONLY'          -- Text block (peripheral smear comment, MP result)
);

-- ============================================================================
-- DEPARTMENT (Groups panels for section headers)
-- ============================================================================

CREATE TABLE "Department" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,                          -- e.g., "HAEMATOLOGY", "BIOCHEMISTRY"
  "reportHeaderText" TEXT NOT NULL,              -- e.g., "DEPARTMENT OF HAEMATOLOGY"
  "displayOrder" INTEGER NOT NULL DEFAULT 0,     -- Sort order on report
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Department_name_key" ON "Department"("name");
CREATE INDEX "Department_displayOrder_idx" ON "Department"("displayOrder");
CREATE INDEX "Department_isActive_idx" ON "Department"("isActive");

-- ============================================================================
-- PANEL DEFINITION (Configurable report sections)
-- ============================================================================

CREATE TABLE "PanelDefinition" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,                          -- e.g., "LFT", "CBP", "WIDAL"
  "displayName" TEXT NOT NULL,                   -- e.g., "LIVER FUNCTION TEST"
  "departmentId" TEXT NOT NULL,
  "layoutType" "PanelLayoutType" NOT NULL,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,     -- Order within department
  "showMethodColumn" BOOLEAN NOT NULL DEFAULT false,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "PanelDefinition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PanelDefinition_departmentId_fkey" FOREIGN KEY ("departmentId") 
    REFERENCES "Department"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "PanelDefinition_name_key" ON "PanelDefinition"("name");
CREATE INDEX "PanelDefinition_departmentId_idx" ON "PanelDefinition"("departmentId");
CREATE INDEX "PanelDefinition_displayOrder_idx" ON "PanelDefinition"("displayOrder");
CREATE INDEX "PanelDefinition_isActive_idx" ON "PanelDefinition"("isActive");

-- ============================================================================
-- PANEL TEST ITEM (Tests within a panel, with display rules)
-- ============================================================================

CREATE TABLE "PanelTestItem" (
  "id" TEXT NOT NULL,
  "panelId" TEXT NOT NULL,
  "testId" TEXT NOT NULL,
  "displayOrder" INTEGER NOT NULL DEFAULT 0,
  "showMethod" BOOLEAN NOT NULL DEFAULT false,   -- Show method line under test
  "methodText" TEXT,                             -- e.g., "Method: ECLIA"
  "indentLevel" INTEGER NOT NULL DEFAULT 0,      -- For sub-tests (0=main, 1=sub)
  "isBold" BOOLEAN NOT NULL DEFAULT false,       -- Bold formatting
  "isItalic" BOOLEAN NOT NULL DEFAULT false,     -- Italic formatting
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PanelTestItem_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PanelTestItem_panelId_fkey" FOREIGN KEY ("panelId") 
    REFERENCES "PanelDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "PanelTestItem_testId_fkey" FOREIGN KEY ("testId") 
    REFERENCES "LabTest"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "PanelTestItem_panelId_idx" ON "PanelTestItem"("panelId");
CREATE INDEX "PanelTestItem_testId_idx" ON "PanelTestItem"("testId");
CREATE UNIQUE INDEX "PanelTestItem_panelId_testId_key" ON "PanelTestItem"("panelId", "testId");

-- ============================================================================
-- SIGNING DOCTOR (Doctors who sign reports)
-- ============================================================================

CREATE TABLE "SigningDoctor" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "degrees" TEXT NOT NULL,                       -- e.g., "MBBS, MD (Pathology)"
  "designation" TEXT NOT NULL,                   -- e.g., "Consultant Pathologist"
  "registrationNumber" TEXT,                     -- Medical council registration
  "signatureImagePath" TEXT NOT NULL,            -- Path to signature PNG in storage
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "SigningDoctor_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "SigningDoctor_isActive_idx" ON "SigningDoctor"("isActive");

-- ============================================================================
-- SIGNING RULE (Which doctor signs which department)
-- ============================================================================

CREATE TABLE "SigningRule" (
  "id" TEXT NOT NULL,
  "departmentId" TEXT NOT NULL,
  "signingDoctorId" TEXT NOT NULL,
  "showLabInchargeNote" BOOLEAN NOT NULL DEFAULT false,  -- "Lab Incharge" text
  "displayOrder" INTEGER NOT NULL DEFAULT 0,            -- Multiple signers order
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "SigningRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SigningRule_departmentId_fkey" FOREIGN KEY ("departmentId") 
    REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SigningRule_signingDoctorId_fkey" FOREIGN KEY ("signingDoctorId") 
    REFERENCES "SigningDoctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "SigningRule_departmentId_idx" ON "SigningRule"("departmentId");
CREATE INDEX "SigningRule_signingDoctorId_idx" ON "SigningRule"("signingDoctorId");
CREATE UNIQUE INDEX "SigningRule_departmentId_signingDoctorId_key" ON "SigningRule"("departmentId", "signingDoctorId");

-- ============================================================================
-- INTERPRETATION TEMPLATE (Range-based interpretation text)
-- ============================================================================

CREATE TABLE "InterpretationTemplate" (
  "id" TEXT NOT NULL,
  "testId" TEXT NOT NULL,
  "minValue" FLOAT,                              -- NULL = no lower bound
  "maxValue" FLOAT,                              -- NULL = no upper bound
  "interpretationText" TEXT NOT NULL,            -- The interpretation text
  "displayOrder" INTEGER NOT NULL DEFAULT 0,     -- Order for multiple interpretations
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "InterpretationTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "InterpretationTemplate_testId_fkey" FOREIGN KEY ("testId") 
    REFERENCES "LabTest"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "InterpretationTemplate_testId_idx" ON "InterpretationTemplate"("testId");
CREATE INDEX "InterpretationTemplate_isActive_idx" ON "InterpretationTemplate"("isActive");

-- ============================================================================
-- REPORT ACCESS TOKEN (Secure patient access links)
-- ============================================================================

CREATE TABLE "ReportAccessToken" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,                         -- Cryptographically random token
  "reportVersionId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),                      -- NULL = never expires
  "accessCount" INTEGER NOT NULL DEFAULT 0,      -- Number of times accessed
  "lastAccessedAt" TIMESTAMP(3),
  "lastAccessedIp" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReportAccessToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReportAccessToken_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") 
    REFERENCES "ReportVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "ReportAccessToken_token_key" ON "ReportAccessToken"("token");
CREATE INDEX "ReportAccessToken_reportVersionId_idx" ON "ReportAccessToken"("reportVersionId");
CREATE INDEX "ReportAccessToken_expiresAt_idx" ON "ReportAccessToken"("expiresAt");

-- ============================================================================
-- REPORT VERSION SNAPSHOT (Frozen rendering data)
-- ============================================================================

-- Add snapshot columns to ReportVersion
ALTER TABLE "ReportVersion" ADD COLUMN "panelsSnapshot" JSONB;
ALTER TABLE "ReportVersion" ADD COLUMN "signaturesSnapshot" JSONB;
ALTER TABLE "ReportVersion" ADD COLUMN "patientSnapshot" JSONB;
ALTER TABLE "ReportVersion" ADD COLUMN "visitSnapshot" JSONB;
ALTER TABLE "ReportVersion" ADD COLUMN "interpretationsSnapshot" JSONB;

-- Add access token relation
ALTER TABLE "ReportVersion" ADD COLUMN "accessToken" TEXT;

-- ============================================================================
-- REPORT ACCESS LOG (Audit trail for report views/downloads)
-- ============================================================================

CREATE TABLE "ReportAccessLog" (
  "id" TEXT NOT NULL,
  "reportVersionId" TEXT NOT NULL,
  "accessType" TEXT NOT NULL,                    -- 'VIEW', 'DOWNLOAD', 'PRINT'
  "accessedVia" TEXT NOT NULL,                   -- 'TOKEN', 'STAFF_PORTAL', 'DIRECT'
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT,                                 -- Staff user if authenticated
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ReportAccessLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ReportAccessLog_reportVersionId_fkey" FOREIGN KEY ("reportVersionId") 
    REFERENCES "ReportVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "ReportAccessLog_reportVersionId_idx" ON "ReportAccessLog"("reportVersionId");
CREATE INDEX "ReportAccessLog_accessType_idx" ON "ReportAccessLog"("accessType");
CREATE INDEX "ReportAccessLog_createdAt_idx" ON "ReportAccessLog"("createdAt");

-- ============================================================================
-- ADD userRole TO AUDIT LOG (if not exists - may have been added in E3-17)
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'AuditLog' AND column_name = 'userRole'
  ) THEN
    ALTER TABLE "AuditLog" ADD COLUMN "userRole" "UserRole";
  END IF;
END $$;

-- Add REPORT_ACCESS action type
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'REPORT_ACCESS';
