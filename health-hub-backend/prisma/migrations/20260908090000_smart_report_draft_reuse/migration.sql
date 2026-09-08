-- Draft Smart Reports: persist what the preview produced so finalize can reuse it.
-- Hand-written (not `migrate dev`) so nothing touches the production database from
-- a developer machine; Render applies it on deploy.

-- DRAFT must not collide with READY, which notificationService and reportGateway
-- both treat as "show the patient the smart link".
-- PG12+ allows ADD VALUE inside a transaction as long as the value is not USED in
-- the same transaction; this migration only adds columns, so that holds.
ALTER TYPE "SmartReportStatus" ADD VALUE IF NOT EXISTS 'DRAFT';

ALTER TABLE "SmartReport" ADD COLUMN IF NOT EXISTS "inputHash" TEXT;
ALTER TABLE "SmartReport" ADD COLUMN IF NOT EXISTS "previewedAt" TIMESTAMP(3);
