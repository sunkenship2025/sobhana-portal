/*
  Warnings:

  - You are about to drop the column `userRole` on the `AuditLog` table. All the data in the column will be lost.
  - You are about to drop the column `accessToken` on the `ReportVersion` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AuditLog" DROP COLUMN "userRole";

-- AlterTable
ALTER TABLE "LabTest" ADD COLUMN     "displayOrder" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "isPanel" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "parentTestId" TEXT,
ADD COLUMN     "referenceText" TEXT;

-- AlterTable
ALTER TABLE "ReportVersion" DROP COLUMN "accessToken";

-- CreateIndex
CREATE INDEX "LabTest_parentTestId_idx" ON "LabTest"("parentTestId");

-- AddForeignKey
ALTER TABLE "LabTest" ADD CONSTRAINT "LabTest_parentTestId_fkey" FOREIGN KEY ("parentTestId") REFERENCES "LabTest"("id") ON DELETE SET NULL ON UPDATE CASCADE;
