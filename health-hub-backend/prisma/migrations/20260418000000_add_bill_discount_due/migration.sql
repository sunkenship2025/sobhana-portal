-- Add diagnostic bill discount and partial-payment support.

CREATE TYPE "BillDiscountType" AS ENUM ('FLAT_AMOUNT', 'PERCENTAGE');

ALTER TABLE "Bill"
  ADD COLUMN "discountType" "BillDiscountType",
  ADD COLUMN "discountPercentage" DOUBLE PRECISION,
  ADD COLUMN "discountAmountInPaise" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "paidAmountInPaise" INTEGER NOT NULL DEFAULT 0;

UPDATE "Bill"
SET
  "discountAmountInPaise" = 0,
  "discountType" = NULL,
  "discountPercentage" = NULL,
  "paidAmountInPaise" = CASE
    WHEN "paymentStatus" = 'PAID' THEN "totalAmountInPaise"
    ELSE 0
  END;
