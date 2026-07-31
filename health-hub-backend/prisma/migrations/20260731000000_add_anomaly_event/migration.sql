-- AnomalyEvent: materialized read-model for the Audit & Anomalies page. Additive,
-- no FK, no backfill — populated by the projector (anomalyProjectorService).
CREATE TABLE "AnomalyEvent" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "severity" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "event" TEXT NOT NULL,
    "detail" TEXT NOT NULL DEFAULT '',
    "actorUserId" TEXT,
    "actorName" TEXT,
    "actorRole" TEXT,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "patientName" TEXT,
    "amountInPaise" INTEGER,
    "reason" TEXT,
    "drillTo" TEXT,
    "sourceKind" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AnomalyEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AnomalyEvent_dedupeKey_key" ON "AnomalyEvent"("dedupeKey");
CREATE INDEX "AnomalyEvent_branchId_occurredAt_idx" ON "AnomalyEvent"("branchId", "occurredAt");
CREATE INDEX "AnomalyEvent_branchId_severity_occurredAt_idx" ON "AnomalyEvent"("branchId", "severity", "occurredAt");
CREATE INDEX "AnomalyEvent_branchId_category_occurredAt_idx" ON "AnomalyEvent"("branchId", "category", "occurredAt");
CREATE INDEX "AnomalyEvent_branchId_actorUserId_occurredAt_idx" ON "AnomalyEvent"("branchId", "actorUserId", "occurredAt");
