/*
  Warnings:

  - A unique constraint covering the columns `[doctorType,referralDoctorId,clinicDoctorId,branchId,periodStartDate,periodEndDate]` on the table `DoctorPayoutLedger` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `doctorType` to the `DoctorPayoutLedger` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "PayoutDoctorType" AS ENUM ('REFERRAL', 'CLINIC');

-- DropIndex
DROP INDEX "DoctorPayoutLedger_referralDoctorId_branchId_periodStartDat_key";

-- AlterTable
ALTER TABLE "DoctorPayoutLedger" ADD COLUMN     "clinicDoctorId" TEXT,
ADD COLUMN     "doctorType" "PayoutDoctorType" NOT NULL,
ADD COLUMN     "paymentMethod" "PaymentType",
ALTER COLUMN "referralDoctorId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "DoctorPayoutLedger_doctorType_idx" ON "DoctorPayoutLedger"("doctorType");

-- CreateIndex
CREATE INDEX "DoctorPayoutLedger_clinicDoctorId_idx" ON "DoctorPayoutLedger"("clinicDoctorId");

-- CreateIndex
CREATE UNIQUE INDEX "DoctorPayoutLedger_doctorType_referralDoctorId_clinicDoctor_key" ON "DoctorPayoutLedger"("doctorType", "referralDoctorId", "clinicDoctorId", "branchId", "periodStartDate", "periodEndDate");

-- AddForeignKey
ALTER TABLE "DoctorPayoutLedger" ADD CONSTRAINT "DoctorPayoutLedger_clinicDoctorId_fkey" FOREIGN KEY ("clinicDoctorId") REFERENCES "ClinicDoctor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
