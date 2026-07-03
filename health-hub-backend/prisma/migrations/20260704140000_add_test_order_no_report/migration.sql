-- Per-order "no written report needed" (films only) closure. Money-neutral:
-- NOT a refund/cancel. Excludes the order from the report, entry screen, and
-- finalize completeness. Reversible until the report is finalized.
ALTER TABLE "TestOrder" ADD COLUMN     "noReportAt" TIMESTAMP(3),
ADD COLUMN     "noReportReason" TEXT,
ADD COLUMN     "noReportByUserId" TEXT;

ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_noReportByUserId_fkey" FOREIGN KEY ("noReportByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
