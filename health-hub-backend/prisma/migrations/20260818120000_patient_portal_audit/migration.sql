-- Patient-portal audit persistence: actor phone on report access, bill access log,
-- and a persisted auth-event trail (logins etc). All additive — no existing data touched.

-- AlterTable
ALTER TABLE "ReportAccessLog" ADD COLUMN     "actorPhone" TEXT;

-- CreateTable
CREATE TABLE "BillAccessLog" (
    "id" TEXT NOT NULL,
    "visitId" TEXT NOT NULL,
    "billNumber" TEXT,
    "patientName" TEXT,
    "accessType" TEXT NOT NULL,
    "accessedVia" TEXT NOT NULL,
    "actorPhone" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PatientAuthEvent" (
    "id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "phone" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PatientAuthEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BillAccessLog_visitId_idx" ON "BillAccessLog"("visitId");

-- CreateIndex
CREATE INDEX "BillAccessLog_createdAt_idx" ON "BillAccessLog"("createdAt");

-- CreateIndex
CREATE INDEX "PatientAuthEvent_event_idx" ON "PatientAuthEvent"("event");

-- CreateIndex
CREATE INDEX "PatientAuthEvent_createdAt_idx" ON "PatientAuthEvent"("createdAt");
