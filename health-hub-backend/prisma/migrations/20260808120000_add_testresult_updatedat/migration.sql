-- Track last-edit time per result value (audit: "when was this re-edited").
-- Backfill existing rows to createdAt; Prisma @updatedAt maintains it thereafter.
ALTER TABLE "TestResult" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "TestResult" SET "updatedAt" = "createdAt";
