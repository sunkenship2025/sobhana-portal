-- Index the two join keys the AnomalyEvent reversal self-join actually matches on.
--
-- The audit/anomaly report joins each flagged event to any LATER event sharing one of
-- three keys: (entityType, entityId), (sourceKind, sourceId) or dedupeKey. Only
-- dedupeKey was indexed. So the planner drove the join off
-- AnomalyEvent_branchId_occurredAt_idx using nothing but `occurredAt > b.occurredAt` —
-- and since an all-branches report constrains no branchId, that is close to a full
-- index scan, repeated once per outer row, with the key pairs applied afterwards as a
-- filter. Measured at 7.6s against 47k rows, 0.4s short of the analytics role's 8s
-- statement_timeout.
--
-- Plain CREATE INDEX rather than CONCURRENTLY: 47k rows builds in well under a second,
-- and `prisma migrate deploy` runs migrations in a transaction, which CONCURRENTLY
-- cannot join.
CREATE INDEX IF NOT EXISTS "AnomalyEvent_entityType_entityId_idx" ON "AnomalyEvent"("entityType", "entityId");
CREATE INDEX IF NOT EXISTS "AnomalyEvent_sourceKind_sourceId_idx" ON "AnomalyEvent"("sourceKind", "sourceId");

-- Redundant duplicate: "DiagnosticReport"."visitId" is @unique, so
-- DiagnosticReport_visitId_key already covers every lookup this served. Two btrees on
-- one column were being written on every report insert and update.
DROP INDEX IF EXISTS "DiagnosticReport_visitId_idx";
