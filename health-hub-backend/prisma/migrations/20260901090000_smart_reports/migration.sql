-- Smart Reports module. Additive only: three new tables + four nullable/defaulted columns.

CREATE TYPE "SmartReportStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'SKIPPED');

CREATE TABLE "SmartReport" (
    "id" TEXT NOT NULL,
    "reportVersionId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" "SmartReportStatus" NOT NULL DEFAULT 'PENDING',
    "skipReason" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "score" INTEGER,
    "scoreBand" TEXT,
    "scoredCount" INTEGER NOT NULL DEFAULT 0,
    "outOfRangeCount" INTEGER NOT NULL DEFAULT 0,
    "borderlineCount" INTEGER NOT NULL DEFAULT 0,
    "withinRangeCount" INTEGER NOT NULL DEFAULT 0,
    "shownNotScored" INTEGER NOT NULL DEFAULT 0,
    "referredOnly" INTEGER NOT NULL DEFAULT 0,
    "hasCritical" BOOLEAN NOT NULL DEFAULT false,
    "findings" JSONB,
    "content" JSONB,
    "usedFallbackCopy" BOOLEAN NOT NULL DEFAULT false,
    "validationFailures" JSONB,
    "model" TEXT,
    "promptVersion" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "generationMs" INTEGER,
    "configSnapshot" JSONB,
    "generatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SmartReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmartReport_reportVersionId_key" ON "SmartReport"("reportVersionId");
CREATE INDEX "SmartReport_visitId_idx" ON "SmartReport"("visitId");
CREATE INDEX "SmartReport_patientId_idx" ON "SmartReport"("patientId");
CREATE INDEX "SmartReport_branchId_createdAt_idx" ON "SmartReport"("branchId", "createdAt");
CREATE INDEX "SmartReport_status_idx" ON "SmartReport"("status");
ALTER TABLE "SmartReport" ADD CONSTRAINT "SmartReport_reportVersionId_fkey"
    FOREIGN KEY ("reportVersionId") REFERENCES "ReportVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "SmartReportConfig" (
    "id" TEXT NOT NULL,
    "branchId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "recommendationsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "futureTestsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "trendsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "essentialsEnabled" BOOLEAN NOT NULL DEFAULT true,
    "language" TEXT NOT NULL DEFAULT 'en',
    "accentColor" TEXT NOT NULL DEFAULT '#3FA34D',
    "tagline" TEXT,
    "websiteLine" TEXT,
    "disclaimerOverride" TEXT,
    "minScoredParameters" INTEGER NOT NULL DEFAULT 5,
    "minPatientAgeYears" INTEGER NOT NULL DEFAULT 18,
    "maxFindingPages" INTEGER NOT NULL DEFAULT 3,
    "model" TEXT NOT NULL DEFAULT 'deepseek-v4-flash',
    "monthlyBudgetPaise" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SmartReportConfig_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SmartReportConfig_branchId_key" ON "SmartReportConfig"("branchId");

CREATE TABLE "HealthContentRule" (
    "id" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "testCode" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "tier" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "whatItMeans" TEXT NOT NULL,
    "dos" JSONB NOT NULL DEFAULT '[]',
    "donts" JSONB NOT NULL DEFAULT '[]',
    "lifestyle" JSONB NOT NULL DEFAULT '[]',
    "suggestedTestCodes" JSONB NOT NULL DEFAULT '[]',
    "followUpWeeks" INTEGER,
    "severity" TEXT NOT NULL DEFAULT 'STANDARD',
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HealthContentRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HealthContentRule_language_testCode_direction_key" ON "HealthContentRule"("language", "testCode", "direction");
CREATE INDEX "HealthContentRule_testCode_direction_idx" ON "HealthContentRule"("testCode", "direction");
CREATE INDEX "HealthContentRule_isActive_idx" ON "HealthContentRule"("isActive");

ALTER TABLE "Patient" ADD COLUMN "heightCm" DOUBLE PRECISION;
ALTER TABLE "Patient" ADD COLUMN "weightKg" DOUBLE PRECISION;
ALTER TABLE "BillableProduct" ADD COLUMN "smartReportEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ClinicalPanel" ADD COLUMN "icon" TEXT;
