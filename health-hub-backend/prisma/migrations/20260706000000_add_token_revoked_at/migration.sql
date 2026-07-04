-- Adds `revokedAt` to the three public access-token tables so a link can be
-- killed when its underlying document is voided (full bill cancellation/refund).
-- NULL = live (the default). Additive + nullable → safe on the live tables,
-- no backfill, no lock beyond a fast catalog update.
ALTER TABLE "ReportAccessToken" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "BillAccessToken" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "StatementAccessToken" ADD COLUMN "revokedAt" TIMESTAMP(3);
