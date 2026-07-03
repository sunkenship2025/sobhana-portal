-- AlterEnum
-- Adds two new roles to UserRole: lab_incharge (the only non-owner who can
-- finalize reports) and sales (referrals + payouts only, no WhatsApp send).
-- PostgreSQL 12+ executes enum-only migrations outside a transaction, so the
-- two ADD VALUE statements in one file are safe.
ALTER TYPE "UserRole" ADD VALUE 'lab_incharge';
ALTER TYPE "UserRole" ADD VALUE 'sales';
