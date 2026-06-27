-- Per-product payout-statement category (owner-set grouping bucket).
-- Nullable: when unset, the payout statement falls back to the test's department.
ALTER TABLE "BillableProduct" ADD COLUMN "payoutCategory" TEXT;
