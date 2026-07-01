-- Per-order cancel/refund feature: OrderRefund records (partial amounts), bill/
-- test-order refund fields, a REFUND transaction discriminator, and a
-- PARTIALLY_REFUNDED payment status. All additive and backward-compatible.

-- 1. Enum value on existing PaymentStatus (safe in-file: PARTIALLY_REFUNDED is
--    not referenced again in this migration).
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PARTIALLY_REFUNDED';

-- 2. New enums
CREATE TYPE "TransactionType" AS ENUM ('PAYMENT', 'REFUND');
CREATE TYPE "OrderRefundKind" AS ENUM ('CANCEL', 'REFUND');

-- 3. PaymentTransaction: PAYMENT vs REFUND discriminator (existing rows default PAYMENT)
ALTER TABLE "PaymentTransaction" ADD COLUMN     "transactionType" "TransactionType" NOT NULL DEFAULT 'PAYMENT';

-- 4. Bill: refund rollup + audit FK (mirrors discountedByUserId)
ALTER TABLE "Bill" ADD COLUMN     "refundedAmountInPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "refundedByUserId" TEXT;

-- 5. TestOrder: per-order cancel metadata
ALTER TABLE "TestOrder" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelReason" TEXT;

-- 6. OrderRefund table
CREATE TABLE "OrderRefund" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "testOrderId" TEXT,
    "branchId" TEXT NOT NULL,
    "kind" "OrderRefundKind" NOT NULL,
    "amountInPaise" INTEGER NOT NULL DEFAULT 0,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "paymentType" "PaymentType",
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderRefund_billId_idx" ON "OrderRefund"("billId");
CREATE INDEX "OrderRefund_visitId_idx" ON "OrderRefund"("visitId");
CREATE INDEX "OrderRefund_testOrderId_idx" ON "OrderRefund"("testOrderId");
CREATE INDEX "OrderRefund_branchId_createdAt_idx" ON "OrderRefund"("branchId", "createdAt");

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_refundedByUserId_fkey" FOREIGN KEY ("refundedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_visitId_fkey" FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_testOrderId_fkey" FOREIGN KEY ("testOrderId") REFERENCES "TestOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
