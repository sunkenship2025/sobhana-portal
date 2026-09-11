-- Automated messages: configurable scheduled WhatsApp sends (nightly day sheet).

CREATE TABLE "ScheduledMessage" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "sendAtMinutes" INTEGER NOT NULL DEFAULT 1350,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ScheduledMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ScheduledMessage_kind_branchId_domain_key"
    ON "ScheduledMessage"("kind", "branchId", "domain");

CREATE TABLE "ScheduledMessageRun" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "runDate" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "detail" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ScheduledMessageRun_pkey" PRIMARY KEY ("id")
);

-- The idempotency key: one attempt per night, per branch, per domain.
CREATE UNIQUE INDEX "ScheduledMessageRun_kind_branchId_domain_runDate_key"
    ON "ScheduledMessageRun"("kind", "branchId", "domain", "runDate");

CREATE INDEX "ScheduledMessageRun_sentAt_idx" ON "ScheduledMessageRun"("sentAt");
