-- DropIndex
DROP INDEX "PatientChangeLog_patientId_createdAt_idx";

-- AlterTable
ALTER TABLE "PatientChangeLog" ADD COLUMN     "requestId" TEXT;

-- CreateIndex
CREATE INDEX "PatientChangeLog_patientId_idx" ON "PatientChangeLog"("patientId");

-- CreateIndex
CREATE INDEX "PatientChangeLog_createdAt_idx" ON "PatientChangeLog"("createdAt");

-- CreateIndex
CREATE INDEX "PatientChangeLog_requestId_idx" ON "PatientChangeLog"("requestId");
