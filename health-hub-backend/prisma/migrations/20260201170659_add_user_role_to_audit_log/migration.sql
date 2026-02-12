/*
  Warnings:

  - The values [MERGE,ROLLBACK] on the enum `AuditActionType` will be removed. If these variants are still used in the database, this will fail.

*/
-- AlterEnum
BEGIN;
CREATE TYPE "AuditActionType_new" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'FINALIZE', 'PAYOUT_DERIVE', 'PAYOUT_PAID');
ALTER TABLE "AuditLog" ALTER COLUMN "actionType" TYPE "AuditActionType_new" USING ("actionType"::text::"AuditActionType_new");
ALTER TYPE "AuditActionType" RENAME TO "AuditActionType_old";
ALTER TYPE "AuditActionType_new" RENAME TO "AuditActionType";
DROP TYPE "AuditActionType_old";
COMMIT;

-- DropIndex
DROP INDEX "Patient_yearOfBirth_idx";

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "userRole" "UserRole";
