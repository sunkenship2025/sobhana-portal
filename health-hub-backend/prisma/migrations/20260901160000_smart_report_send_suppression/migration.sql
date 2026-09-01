-- Staff kill switch for a Smart Report that reads wrong.
-- Separate migration rather than editing 20260901090000_smart_reports, which may
-- already be applied somewhere; editing an applied migration breaks the checksum.
ALTER TABLE "SmartReport" ADD COLUMN "sendSuppressedAt" TIMESTAMP(3);
ALTER TABLE "SmartReport" ADD COLUMN "sendSuppressedBy" TEXT;
ALTER TABLE "SmartReport" ADD COLUMN "sendSuppressedReason" TEXT;
