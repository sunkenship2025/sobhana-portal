-- CreateEnum
CREATE TYPE "PatientChangeType" AS ENUM ('IDENTITY', 'NON_IDENTITY');

-- CreateTable
CREATE TABLE "PatientChangeLog" (
    "id" TEXT NOT NULL,
    "patientId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "oldValue" TEXT,
    "newValue" TEXT,
    "changeType" "PatientChangeType" NOT NULL,
    "changeReason" TEXT,
    "changedBy" TEXT NOT NULL,
    "changedRole" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PatientChangeLog_patientId_createdAt_idx" ON "PatientChangeLog"("patientId", "createdAt");

-- CreateIndex
CREATE INDEX "PatientChangeLog_changedBy_idx" ON "PatientChangeLog"("changedBy");

-- CreateIndex
CREATE INDEX "PatientChangeLog_changeType_idx" ON "PatientChangeLog"("changeType");

-- AddForeignKey
ALTER TABLE "PatientChangeLog" ADD CONSTRAINT "PatientChangeLog_patientId_fkey" FOREIGN KEY ("patientId") REFERENCES "Patient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
