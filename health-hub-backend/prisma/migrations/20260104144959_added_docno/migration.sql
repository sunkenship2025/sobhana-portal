/*
  Warnings:

  - A unique constraint covering the columns `[doctorNumber]` on the table `ClinicDoctor` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[patientNumber]` on the table `Patient` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[doctorNumber]` on the table `ReferralDoctor` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `doctorNumber` to the `ClinicDoctor` table without a default value. This is not possible if the table is not empty.
  - Added the required column `patientNumber` to the `Patient` table without a default value. This is not possible if the table is not empty.
  - Added the required column `doctorNumber` to the `ReferralDoctor` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "ClinicDoctor" ADD COLUMN     "doctorNumber" TEXT NOT NULL,
ADD COLUMN     "referralDoctorId" TEXT;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "patientNumber" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "ReferralDoctor" ADD COLUMN     "clinicDoctorId" TEXT,
ADD COLUMN     "doctorNumber" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "ClinicDoctor_doctorNumber_key" ON "ClinicDoctor"("doctorNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Patient_patientNumber_key" ON "Patient"("patientNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralDoctor_doctorNumber_key" ON "ReferralDoctor"("doctorNumber");
