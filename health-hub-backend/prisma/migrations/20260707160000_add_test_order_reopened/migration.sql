-- Per-order reopen trace: last reversal of a "no report needed" (films-only)
-- close. Surfaced in Patient 360 and the owner audit feed. Cleared again if the
-- order is re-waived. Additive/nullable — safe on a live table.
ALTER TABLE "TestOrder" ADD COLUMN     "reopenedAt" TIMESTAMP(3),
ADD COLUMN     "reopenedByUserId" TEXT;

ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_reopenedByUserId_fkey" FOREIGN KEY ("reopenedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
