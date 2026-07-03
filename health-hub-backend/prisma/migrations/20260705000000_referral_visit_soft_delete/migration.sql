-- Soft-delete support for ReferralDoctor_Visit.
--
-- Converting a visit to SELF (or re-referring it) used to hard-delete the
-- referral link, losing the history. Now the link is kept and marked with
-- deletedAt/deletedReason/deletedBy. Every referral-attribution read filters
-- `deletedAt IS NULL`, so the visit looks Self on the UI, drops out of the
-- doctor's payout, and drops off the doctors dashboard, while the row remains
-- in the DB as history.
--
-- The original unique constraint on (visitId, referralDoctorId) would block
-- re-referring a visit to the same doctor after a soft-delete, so it is
-- replaced with a partial unique index that ignores soft-deleted rows.

ALTER TABLE "ReferralDoctor_Visit"
  ADD COLUMN "deletedAt" TIMESTAMP(3),
  ADD COLUMN "deletedReason" TEXT,
  ADD COLUMN "deletedBy" TEXT;

-- Drop the original full unique constraint.
DROP INDEX "ReferralDoctor_Visit_visitId_referralDoctorId_key";

-- Replace with a partial unique that scopes to non-deleted rows only.
CREATE UNIQUE INDEX "ReferralDoctor_Visit_active_uniq"
  ON "ReferralDoctor_Visit"("visitId", "referralDoctorId")
  WHERE "deletedAt" IS NULL;

-- Plain index Prisma's schema declares (for query performance).
CREATE INDEX "ReferralDoctor_Visit_visitId_referralDoctorId_idx"
  ON "ReferralDoctor_Visit"("visitId", "referralDoctorId");

-- Index for soft-delete filter scans.
CREATE INDEX "ReferralDoctor_Visit_deletedAt_idx"
  ON "ReferralDoctor_Visit"("deletedAt");
