-- Owner-account audit fields (additive, nullable; backward-compatible)
-- B1: who authorized a discount; B2: refund reason/time (forward-compatible,
-- no refund flow writes these yet); B3: branch attribution for messages.

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "discountedByUserId" TEXT,
ADD COLUMN     "refundReason" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "MessageLog" ADD COLUMN     "branchId" TEXT;

-- CreateIndex
CREATE INDEX "MessageLog_branchId_idx" ON "MessageLog"("branchId");

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_discountedByUserId_fkey" FOREIGN KEY ("discountedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageLog" ADD CONSTRAINT "MessageLog_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE SET NULL ON UPDATE CASCADE;
