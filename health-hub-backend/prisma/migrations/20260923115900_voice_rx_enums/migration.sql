-- VoiceRx, part 1 of 2: enum values only.
--
-- Split from the table migration on purpose. Postgres refuses to USE a newly
-- added enum value inside the transaction that added it, and Prisma runs each
-- migration in one transaction — so new values land here and everything that
-- could reference them lands in the next migration. Adding a value is additive
-- and reversible-by-ignoring: nothing reads these until code does.

-- Prescription lifecycle events, distinct from FINALIZE (which reports use)
-- because a signature carries a named human and a registration number.
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'SIGN';
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'AMEND';
-- A doctor opened a patient outside their own care relationship, with a stated
-- reason. Rare by design; every row is meant to be read.
ALTER TYPE "AuditActionType" ADD VALUE IF NOT EXISTS 'BREAK_GLASS';

-- A signed prescription sent to a patient. The template MUST carry the
-- prescriber's registration number (Telemedicine Practice Guidelines §3.2.5
-- covers "electronic communication (WhatsApp/email etc.)", not just the sheet).
ALTER TYPE "MessageContextType" ADD VALUE IF NOT EXISTS 'PRESCRIPTION';
