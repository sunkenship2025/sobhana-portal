-- AnomalyTriage: per-event Acknowledge/Resolve workqueue state. Separate table so
-- re-projecting AnomalyEvent never wipes it. Absence of a row = "new".
CREATE TABLE "AnomalyTriage" (
    "id" TEXT NOT NULL,
    "anomalyEventId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "note" TEXT,
    "actorUserId" TEXT,
    "actorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AnomalyTriage_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AnomalyTriage_anomalyEventId_key" ON "AnomalyTriage"("anomalyEventId");
CREATE INDEX "AnomalyTriage_status_idx" ON "AnomalyTriage"("status");
ALTER TABLE "AnomalyTriage" ADD CONSTRAINT "AnomalyTriage_anomalyEventId_fkey" FOREIGN KEY ("anomalyEventId") REFERENCES "AnomalyEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
