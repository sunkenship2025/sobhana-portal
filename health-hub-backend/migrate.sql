-- AlterEnum
BEGIN;
CREATE TYPE "PaymentType_new" AS ENUM ('CASH', 'ONLINE');
ALTER TABLE "Bill" ALTER COLUMN "paymentType" DROP DEFAULT;
ALTER TABLE "PaymentTransaction" ALTER COLUMN "paymentType" TYPE "PaymentType_new" USING ("paymentType"::text::"PaymentType_new");
ALTER TABLE "DoctorPayoutLedger" ALTER COLUMN "paymentMethod" TYPE "PaymentType_new" USING ("paymentMethod"::text::"PaymentType_new");
ALTER TYPE "PaymentType" RENAME TO "PaymentType_old";
ALTER TYPE "PaymentType_new" RENAME TO "PaymentType";
DROP TYPE "PaymentType_old";
COMMIT;

-- AlterTable
ALTER TABLE "Bill" DROP COLUMN "paymentType";

-- CreateTable
CREATE TABLE "PaymentTransaction" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amountInPaise" INTEGER NOT NULL,
    "paymentType" "PaymentType" NOT NULL,
    "transactionDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referenceData" TEXT,
    "collectedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PaymentTransaction_billId_idx" ON "PaymentTransaction"("billId");

-- CreateIndex
CREATE INDEX "PaymentTransaction_transactionDate_idx" ON "PaymentTransaction"("transactionDate");

-- CreateIndex
CREATE INDEX "PaymentTransaction_paymentType_idx" ON "PaymentTransaction"("paymentType");

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentTransaction" ADD CONSTRAINT "PaymentTransaction_collectedByUserId_fkey" FOREIGN KEY ("collectedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

