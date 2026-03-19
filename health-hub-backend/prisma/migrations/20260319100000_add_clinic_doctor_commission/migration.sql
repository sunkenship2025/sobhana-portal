-- Add commission fields to ClinicDoctor for consultation fee percentage/fixed amount
ALTER TABLE "ClinicDoctor" ADD COLUMN "commissionType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE';
ALTER TABLE "ClinicDoctor" ADD COLUMN "commissionPercent" DOUBLE PRECISION NOT NULL DEFAULT 100.0;
ALTER TABLE "ClinicDoctor" ADD COLUMN "commissionAmountInPaise" INTEGER;
