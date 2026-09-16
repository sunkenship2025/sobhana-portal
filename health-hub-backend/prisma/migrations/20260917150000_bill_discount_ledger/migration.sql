-- BillDiscount: one row per concession GRANT.
--
-- Additive only: no existing column is touched, so a deploy that rolls back
-- leaves every current money path working exactly as it does now. Historical
-- discounts get no rows (nothing recorded when they happened), which is why
-- every reader falls back to Bill.billedAt when a bill has no ledger rows.

CREATE TYPE "BillDiscountStage" AS ENUM ('AT_BILLING', 'ON_DUE');

CREATE TABLE "BillDiscount" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "stage" "BillDiscountStage" NOT NULL DEFAULT 'AT_BILLING',
    "amountInPaise" INTEGER NOT NULL,
    "discountType" "BillDiscountType" NOT NULL,
    "percentage" DOUBLE PRECISION,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillDiscount_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BillDiscount_billId_idx" ON "BillDiscount"("billId");
CREATE INDEX "BillDiscount_visitId_idx" ON "BillDiscount"("visitId");
-- Serves the day sheet's per-window scan and the anomaly projector, which both
-- read (branch, time) and nothing else.
CREATE INDEX "BillDiscount_branchId_createdAt_idx" ON "BillDiscount"("branchId", "createdAt");

ALTER TABLE "BillDiscount" ADD CONSTRAINT "BillDiscount_billId_fkey"
    FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "BillDiscount" ADD CONSTRAINT "BillDiscount_visitId_fkey"
    FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
-- Restrict, like OrderRefund: the person who granted a concession must stay
-- resolvable for as long as the concession is on the books.
ALTER TABLE "BillDiscount" ADD CONSTRAINT "BillDiscount_createdByUserId_fkey"
    FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
