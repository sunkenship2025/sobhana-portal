-- Swapping a test used to HARD-DELETE the outgoing TestOrder rows, cascading
-- their entered TestResult values away — the only correction path in the app
-- that destroyed data. It now voids them the way cancel/refund does.
--
-- replacedAt is set alongside cancelledAt so every existing "live orders"
-- filter (cancelledAt IS NULL) drops the row untouched, while money code can
-- still tell a replacement from a cancellation: a replacement reverses no
-- charge, and must be excluded from the bill-discount denominator because its
-- replacement now carries that price.
ALTER TABLE "TestOrder" ADD COLUMN "replacedAt" TIMESTAMP(3);
