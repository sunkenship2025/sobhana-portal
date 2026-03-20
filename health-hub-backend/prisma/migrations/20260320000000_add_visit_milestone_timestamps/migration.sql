-- Add explicit milestone timestamps for billing and clinic visit lifecycle
ALTER TABLE "Bill" ADD COLUMN "billedAt" TIMESTAMP(3);
ALTER TABLE "ClinicVisit" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "ClinicVisit" ADD COLUMN "completedAt" TIMESTAMP(3);

-- Backfill bill timestamps from the original creation time
UPDATE "Bill"
SET "billedAt" = "createdAt"
WHERE "billedAt" IS NULL;

-- Backfill clinic started/completed milestones from audit logs when available
UPDATE "ClinicVisit" AS cv
SET "startedAt" = started_logs."startedAt"
FROM (
  SELECT
    "entityId" AS "visitId",
    MIN("createdAt") AS "startedAt"
  FROM "AuditLog"
  WHERE "entityType" = 'VISIT'
    AND "actionType" = 'UPDATE'
    AND "newValues" IS NOT NULL
    AND ("newValues"::jsonb ->> 'status') = 'IN_PROGRESS'
  GROUP BY "entityId"
) AS started_logs
WHERE cv."visitId" = started_logs."visitId"
  AND cv."startedAt" IS NULL;

UPDATE "ClinicVisit" AS cv
SET "completedAt" = completed_logs."completedAt"
FROM (
  SELECT
    "entityId" AS "visitId",
    MIN("createdAt") AS "completedAt"
  FROM "AuditLog"
  WHERE "entityType" = 'VISIT'
    AND "actionType" = 'UPDATE'
    AND "newValues" IS NOT NULL
    AND ("newValues"::jsonb ->> 'status') = 'COMPLETED'
  GROUP BY "entityId"
) AS completed_logs
WHERE cv."visitId" = completed_logs."visitId"
  AND cv."completedAt" IS NULL;

-- Fallback for existing rows where audit history is missing
UPDATE "ClinicVisit"
SET "startedAt" = "updatedAt"
WHERE "startedAt" IS NULL
  AND "status" = 'IN_PROGRESS';

UPDATE "ClinicVisit"
SET "completedAt" = "updatedAt"
WHERE "completedAt" IS NULL
  AND "status" = 'COMPLETED';

ALTER TABLE "Bill" ALTER COLUMN "billedAt" SET NOT NULL;
ALTER TABLE "Bill" ALTER COLUMN "billedAt" SET DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "Bill_billedAt_idx" ON "Bill"("billedAt");
CREATE INDEX "ClinicVisit_startedAt_idx" ON "ClinicVisit"("startedAt");
CREATE INDEX "ClinicVisit_completedAt_idx" ON "ClinicVisit"("completedAt");
