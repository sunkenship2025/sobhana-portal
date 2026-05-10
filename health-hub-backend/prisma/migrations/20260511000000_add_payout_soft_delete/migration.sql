-- Soft-delete support for DoctorPayoutLedger.
--
-- Adds a deletedAt column. When set, the row is hidden from every query
-- (list, detail, summary, search, exports, doctor pivot) for both owner
-- and staff. Owners can restore via direct DB access only.
--
-- The original unique constraint on (doctorType, referralDoctorId, clinicDoctorId,
-- diagnosticCenterId, branchId, periodStartDate, periodEndDate) prevented
-- re-deriving a payout for a (doctor, period) once it existed. After soft-delete
-- we want re-derive to succeed, so the unique constraint is replaced with a
-- partial unique index that ignores soft-deleted rows.

ALTER TABLE "DoctorPayoutLedger"
  ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Drop the existing full unique constraint (auto-named by Prisma).
DROP INDEX "DoctorPayoutLedger_doctorType_referralDoctorId_clinicDoctor_key";

-- Replace with a partial unique that scopes to non-deleted rows only.
CREATE UNIQUE INDEX "DoctorPayoutLedger_active_payout_uniq"
  ON "DoctorPayoutLedger"(
    "doctorType",
    "referralDoctorId",
    "clinicDoctorId",
    "diagnosticCenterId",
    "branchId",
    "periodStartDate",
    "periodEndDate"
  )
  WHERE "deletedAt" IS NULL;

-- Add the regular index Prisma's schema declares (for query performance).
CREATE INDEX "DoctorPayoutLedger_lookup_idx"
  ON "DoctorPayoutLedger"(
    "doctorType",
    "referralDoctorId",
    "clinicDoctorId",
    "diagnosticCenterId",
    "branchId",
    "periodStartDate",
    "periodEndDate"
  );

-- Index for soft-delete filter scans.
CREATE INDEX "DoctorPayoutLedger_deletedAt_idx"
  ON "DoctorPayoutLedger"("deletedAt");

-- Audit action type for payout deletion (used by routes/payouts.ts DELETE handlers).
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'PAYOUT_DELETE';

-- The frontend has always offered CHEQUE as a payment method but the enum
-- never included it (a latent bug — submitting CHEQUE would 500). Adding it.
ALTER TYPE "PaymentType" ADD VALUE IF NOT EXISTS 'CHEQUE';
