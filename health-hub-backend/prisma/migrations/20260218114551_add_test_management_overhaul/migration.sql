-- CreateEnum
CREATE TYPE "StockTransactionType" AS ENUM ('CREDIT', 'DEBIT', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "ReferralSourceType" AS ENUM ('SELF', 'REFERRED_TO', 'REFERRED_FROM');

-- AlterEnum
ALTER TYPE "PayoutDoctorType" ADD VALUE 'DIAGNOSTIC_CENTER';

-- DropIndex
DROP INDEX "DoctorPayoutLedger_doctorType_referralDoctorId_clinicDoctor_key";

-- AlterTable
ALTER TABLE "DoctorPayoutLedger" ADD COLUMN     "diagnosticCenterId" TEXT;

-- AlterTable
ALTER TABLE "LabTest" ADD COLUMN     "defaultReferralType" "ReferralSourceType" NOT NULL DEFAULT 'SELF',
ADD COLUMN     "departmentId" TEXT,
ADD COLUMN     "method" TEXT,
ADD COLUMN     "sampleType" TEXT;

-- CreateTable
CREATE TABLE "TestAgeRange" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "minAgeYears" INTEGER,
    "maxAgeYears" INTEGER,
    "gender" "Gender",
    "referenceMin" DOUBLE PRECISION,
    "referenceMax" DOUBLE PRECISION,
    "referenceUnit" TEXT,
    "referenceText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestAgeRange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DerivedParameter" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "parameterName" TEXT NOT NULL,
    "formula" TEXT NOT NULL,
    "dependsOnTestCodes" JSONB NOT NULL,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DerivedParameter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticReferralCenter" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "centerNumber" TEXT NOT NULL,
    "contactPerson" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DiagnosticReferralCenter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DiagnosticCenter_Visit" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "diagnosticCenterId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "referralType" "ReferralSourceType" NOT NULL DEFAULT 'SELF',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiagnosticCenter_Visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "currentQuantity" INTEGER NOT NULL DEFAULT 0,
    "reorderLevel" INTEGER NOT NULL DEFAULT 10,
    "branchId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestStockRequirement" (
    "id" TEXT NOT NULL,
    "testId" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "quantityPerTest" DOUBLE PRECISION NOT NULL DEFAULT 1,

    CONSTRAINT "TestStockRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockTransaction" (
    "id" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "type" "StockTransactionType" NOT NULL,
    "quantity" INTEGER NOT NULL,
    "referenceId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockAlert" (
    "id" TEXT NOT NULL,
    "stockItemId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "alertType" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockAlert_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TestAgeRange_testId_idx" ON "TestAgeRange"("testId");

-- CreateIndex
CREATE UNIQUE INDEX "TestAgeRange_testId_minAgeYears_maxAgeYears_gender_key" ON "TestAgeRange"("testId", "minAgeYears", "maxAgeYears", "gender");

-- CreateIndex
CREATE UNIQUE INDEX "DerivedParameter_testId_key" ON "DerivedParameter"("testId");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosticReferralCenter_centerNumber_key" ON "DiagnosticReferralCenter"("centerNumber");

-- CreateIndex
CREATE INDEX "DiagnosticCenter_Visit_diagnosticCenterId_idx" ON "DiagnosticCenter_Visit"("diagnosticCenterId");

-- CreateIndex
CREATE INDEX "DiagnosticCenter_Visit_branchId_idx" ON "DiagnosticCenter_Visit"("branchId");

-- CreateIndex
CREATE UNIQUE INDEX "DiagnosticCenter_Visit_visitId_diagnosticCenterId_key" ON "DiagnosticCenter_Visit"("visitId", "diagnosticCenterId");

-- CreateIndex
CREATE INDEX "StockItem_branchId_idx" ON "StockItem"("branchId");

-- CreateIndex
CREATE INDEX "TestStockRequirement_stockItemId_idx" ON "TestStockRequirement"("stockItemId");

-- CreateIndex
CREATE UNIQUE INDEX "TestStockRequirement_testId_stockItemId_key" ON "TestStockRequirement"("testId", "stockItemId");

-- CreateIndex
CREATE INDEX "StockTransaction_stockItemId_idx" ON "StockTransaction"("stockItemId");

-- CreateIndex
CREATE INDEX "StockTransaction_createdAt_idx" ON "StockTransaction"("createdAt");

-- CreateIndex
CREATE INDEX "StockAlert_stockItemId_idx" ON "StockAlert"("stockItemId");

-- CreateIndex
CREATE INDEX "StockAlert_branchId_idx" ON "StockAlert"("branchId");

-- CreateIndex
CREATE INDEX "StockAlert_isRead_idx" ON "StockAlert"("isRead");

-- CreateIndex
CREATE INDEX "DoctorPayoutLedger_diagnosticCenterId_idx" ON "DoctorPayoutLedger"("diagnosticCenterId");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorPayoutLedger_doctorType_referralDoctorId_clinicDoctor_key" ON "DoctorPayoutLedger"("doctorType", "referralDoctorId", "clinicDoctorId", "diagnosticCenterId", "branchId", "periodStartDate", "periodEndDate");

-- CreateIndex
CREATE INDEX "LabTest_departmentId_idx" ON "LabTest"("departmentId");

-- AddForeignKey
ALTER TABLE "LabTest" ADD CONSTRAINT "LabTest_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoctorPayoutLedger" ADD CONSTRAINT "DoctorPayoutLedger_diagnosticCenterId_fkey" FOREIGN KEY ("diagnosticCenterId") REFERENCES "DiagnosticReferralCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestAgeRange" ADD CONSTRAINT "TestAgeRange_testId_fkey" FOREIGN KEY ("testId") REFERENCES "LabTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DerivedParameter" ADD CONSTRAINT "DerivedParameter_testId_fkey" FOREIGN KEY ("testId") REFERENCES "LabTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticCenter_Visit" ADD CONSTRAINT "DiagnosticCenter_Visit_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticCenter_Visit" ADD CONSTRAINT "DiagnosticCenter_Visit_diagnosticCenterId_fkey" FOREIGN KEY ("diagnosticCenterId") REFERENCES "DiagnosticReferralCenter"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DiagnosticCenter_Visit" ADD CONSTRAINT "DiagnosticCenter_Visit_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockItem" ADD CONSTRAINT "StockItem_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestStockRequirement" ADD CONSTRAINT "TestStockRequirement_testId_fkey" FOREIGN KEY ("testId") REFERENCES "LabTest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestStockRequirement" ADD CONSTRAINT "TestStockRequirement_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockTransaction" ADD CONSTRAINT "StockTransaction_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockAlert" ADD CONSTRAINT "StockAlert_stockItemId_fkey" FOREIGN KEY ("stockItemId") REFERENCES "StockItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
