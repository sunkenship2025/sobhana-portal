BEGIN;

-- CreateTable first so we don't err
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

ALTER TABLE "Bill" ALTER COLUMN "paymentType" DROP DEFAULT;
ALTER TABLE "DoctorPayoutLedger" ALTER COLUMN "paymentMethod" TYPE "PaymentType_new" USING ("paymentMethod"::text::"PaymentType_new");
ALTER TYPE "PaymentType" RENAME TO "PaymentType_old";
ALTER TYPE "PaymentType_new" RENAME TO "PaymentType";
DROP TYPE "PaymentType_old";

-- Now set PaymentTransaction enum
ALTER TABLE "PaymentTransaction" ALTER COLUMN "paymentType" TYPE "PaymentType" USING ("paymentType"::text::"PaymentType");

-- AlterTable
ALTER TABLE "Bill" DROP COLUMN "paymentType";


-- CreateIndex
CREATE INDEX "PaymentTransaction_billId_idx" ON "PaymentTransaction"("billId");
CREATE INDEX "PaymentTransaction_transactionDate_idx" ON "PaymentTransaction"("transactionDate");
CREATE INDEX "PaymentTransaction_paymentType_idx" ON "PaymentTransaction"("paymentType");

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_collectedByUserId_fkey" FOREIGN KEY ("collectedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
