-- AlterEnum
ALTER TYPE "DiagnosticWorkflowMode" ADD VALUE 'EXTERNAL_UPLOAD';

-- AlterTable
ALTER TABLE "ReportVersion" ADD COLUMN     "externalUploadsSnapshot" JSONB;

-- CreateTable
CREATE TABLE "ExternalReportUpload" (
    "id" TEXT NOT NULL,
    "testOrderId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "r2Key" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "fileSizeBytes" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "uploadedByUserId" TEXT NOT NULL,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ExternalReportUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalReportUpload_testOrderId_idx" ON "ExternalReportUpload"("testOrderId");

-- CreateIndex
CREATE INDEX "ExternalReportUpload_visitId_idx" ON "ExternalReportUpload"("visitId");

-- CreateIndex
CREATE INDEX "ExternalReportUpload_deletedAt_idx" ON "ExternalReportUpload"("deletedAt");

-- AddForeignKey
ALTER TABLE "ExternalReportUpload" ADD CONSTRAINT "ExternalReportUpload_testOrderId_fkey" FOREIGN KEY ("testOrderId") REFERENCES "TestOrder"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalReportUpload" ADD CONSTRAINT "ExternalReportUpload_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalReportUpload" ADD CONSTRAINT "ExternalReportUpload_uploadedByUserId_fkey" FOREIGN KEY ("uploadedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
