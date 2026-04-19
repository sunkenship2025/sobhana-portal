BEGIN;

-- Drop dependent columns first to release ENUM dependency
ALTER TABLE "Bill" DROP COLUMN IF EXISTS "paymentType";

-- CreateTable
CREATE TABLE IF NOT EXISTS "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amountInPaise" INTEGER NOT NULL,
    "paymentType" TEXT NOT NULL,
    "transactionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referenceData" TEXT,
    "collectedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- AlterEnum
CREATE TYPE "PaymentType_new" AS ENUM ('CASH', 'ONLINE');

ALTER TABLE "DoctorPayoutLedger" ALTER COLUMN "paymentMethod" TYPE "PaymentType_new" USING ("paymentMethod"::text::"PaymentType_new");
ALTER TYPE "PaymentType" RENAME TO "PaymentType_old";
ALTER TYPE "PaymentType_new" RENAME TO "PaymentType";
DROP TYPE "PaymentType_old" CASCADE;

-- Set PaymentTransaction enum
ALTER TABLE "PaymentTransaction" ALTER COLUMN "paymentType" TYPE "PaymentType" USING ("paymentType"::text::"PaymentType");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PaymentTransaction_billId_idx" ON "PaymentTransaction"("billId");
CREATE INDEX IF NOT EXISTS "PaymentTransaction_transactionDate_idx" ON "PaymentTransaction"("transactionDate");
CREATE INDEX IF NOT EXISTS "PaymentTransaction_paymentType_idx" ON "PaymentTransaction"("paymentType");

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_collectedByUserId_fkey" FOREIGN KEY ("collectedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
