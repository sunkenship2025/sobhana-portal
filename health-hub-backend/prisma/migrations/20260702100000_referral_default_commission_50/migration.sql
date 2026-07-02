-- Referral doctor default commission is 50%, not 10% (column default only;
-- existing rows are corrected by scripts/fix-referral-commissions-50.ts)
ALTER TABLE "ReferralDoctor" ALTER COLUMN "commissionPercent" SET DEFAULT 50.0;
