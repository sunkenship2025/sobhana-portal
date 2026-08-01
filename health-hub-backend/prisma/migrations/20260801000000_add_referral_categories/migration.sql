-- AlterTable: category on the clinical panel (set in Report Builder / panel definitions)
ALTER TABLE "ClinicalPanel" ADD COLUMN "payoutCategory" TEXT;

-- AlterTable: frozen panel + payout-category snapshot on each test order
ALTER TABLE "TestOrder" ADD COLUMN "panelId" TEXT;
ALTER TABLE "TestOrder" ADD COLUMN "payoutCategorySnapshot" TEXT;

-- CreateTable: centre-wide default referral rate per category (the base rate card)
CREATE TABLE "ReferralCategoryRate" (
    "id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "commissionType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
    "commissionPercent" DOUBLE PRECISION,
    "commissionAmountInPaise" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralCategoryRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable: per-doctor override of a category's referral rate
CREATE TABLE "ReferralDoctorCategoryRule" (
    "id" TEXT NOT NULL,
    "referralDoctorId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "commissionType" "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
    "commissionPercent" DOUBLE PRECISION,
    "commissionAmountInPaise" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralDoctorCategoryRule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCategoryRate_category_key" ON "ReferralCategoryRate"("category");

-- CreateIndex
CREATE INDEX "ReferralCategoryRate_isActive_idx" ON "ReferralCategoryRate"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralDoctorCategoryRule_referralDoctorId_category_key" ON "ReferralDoctorCategoryRule"("referralDoctorId", "category");

-- CreateIndex
CREATE INDEX "ReferralDoctorCategoryRule_referralDoctorId_idx" ON "ReferralDoctorCategoryRule"("referralDoctorId");

-- AddForeignKey
ALTER TABLE "ReferralDoctorCategoryRule" ADD CONSTRAINT "ReferralDoctorCategoryRule_referralDoctorId_fkey" FOREIGN KEY ("referralDoctorId") REFERENCES "ReferralDoctor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
