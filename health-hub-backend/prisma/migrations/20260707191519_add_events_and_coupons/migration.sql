-- CreateEnum
CREATE TYPE "CouponStatus" AS ENUM ('ISSUED', 'REDEEMED', 'EXPIRED', 'VOID');

-- CreateEnum
CREATE TYPE "CouponScope" AS ENUM ('TESTS_ONLY', 'WHOLE_BILL');

-- AlterEnum
ALTER TYPE "DiagnosticWorkflowMode" ADD VALUE 'EVENT';

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "couponCode" TEXT,
ADD COLUMN     "couponDiscountInPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "couponId" TEXT;

-- AlterTable
ALTER TABLE "BillableProduct" ADD COLUMN     "couponCampaignId" TEXT;

-- CreateTable
CREATE TABLE "CouponCampaign" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "discountType" "BillDiscountType" NOT NULL DEFAULT 'PERCENTAGE',
    "discountPercentage" DOUBLE PRECISION DEFAULT 50,
    "discountReason" TEXT NOT NULL,
    "validityDays" INTEGER NOT NULL DEFAULT 30,
    "scope" "CouponScope" NOT NULL DEFAULT 'TESTS_ONLY',
    "whatsappTemplate" TEXT NOT NULL,
    "landingTheme" TEXT NOT NULL DEFAULT 'blood_donation',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CouponCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Coupon" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "CouponStatus" NOT NULL DEFAULT 'ISSUED',
    "patientId" TEXT,
    "phone" TEXT,
    "issuedVisitId" TEXT,
    "issuedByUserId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "redeemedVisitId" TEXT,
    "redeemedBillId" TEXT,
    "redeemedByUserId" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CouponCampaign_code_key" ON "CouponCampaign"("code");

-- CreateIndex
CREATE INDEX "CouponCampaign_code_idx" ON "CouponCampaign"("code");

-- CreateIndex
CREATE INDEX "CouponCampaign_isActive_idx" ON "CouponCampaign"("isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_code_key" ON "Coupon"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Coupon_token_key" ON "Coupon"("token");

-- CreateIndex
CREATE INDEX "Coupon_campaignId_idx" ON "Coupon"("campaignId");

-- CreateIndex
CREATE INDEX "Coupon_status_idx" ON "Coupon"("status");

-- CreateIndex
CREATE INDEX "Coupon_patientId_idx" ON "Coupon"("patientId");

-- CreateIndex
CREATE INDEX "Coupon_phone_idx" ON "Coupon"("phone");

-- CreateIndex
CREATE INDEX "Coupon_expiresAt_idx" ON "Coupon"("expiresAt");

-- AddForeignKey
ALTER TABLE "Coupon" ADD CONSTRAINT "Coupon_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "CouponCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillableProduct" ADD CONSTRAINT "BillableProduct_couponCampaignId_fkey" FOREIGN KEY ("couponCampaignId") REFERENCES "CouponCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

