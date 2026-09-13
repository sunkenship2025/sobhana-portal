-- Automations engine. STRICTLY ADDITIVE: new tables, new nullable columns, new
-- indexes. Nothing is dropped, renamed or backfilled, so this is safe to apply to
-- a live database while the old code is still running.

-- ── Consent, split by purpose ──────────────────────────────────────────────
-- Patient.whatsappOptIn keeps its meaning and becomes SERVICE consent only.
-- Marketing consent starts false for everyone: it has never been asked for, and
-- inferring it from a report send is exactly the thing this column exists to stop.
ALTER TABLE "Patient" ADD COLUMN "marketingOptIn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Patient" ADD COLUMN "marketingOptInAt" TIMESTAMP(3);
ALTER TABLE "Patient" ADD COLUMN "marketingOptInSource" TEXT;
ALTER TABLE "Patient" ADD COLUMN "deceasedAt" TIMESTAMP(3);
ALTER TABLE "Patient" ADD COLUMN "deceasedByUserId" TEXT;

-- ── The clinic-visit → diagnostics link ────────────────────────────────────
-- Null on every existing row and that is correct: null means "we do not know",
-- never "no". Suppression keeps using the generous time window; attribution uses
-- this column (or a coupon redemption) and stays strict.
ALTER TABLE "Visit" ADD COLUMN "sourceVisitId" TEXT;
CREATE INDEX "Visit_sourceVisitId_idx" ON "Visit"("sourceVisitId");

-- ── Message attribution, classification and body snapshot ──────────────────
ALTER TABLE "MessageLog" ADD COLUMN "automationRunId" TEXT;
ALTER TABLE "MessageLog" ADD COLUMN "automationStep" INTEGER;
ALTER TABLE "MessageLog" ADD COLUMN "templateCategory" TEXT;
ALTER TABLE "MessageLog" ADD COLUMN "templateBody" TEXT;
CREATE INDEX "MessageLog_automationRunId_idx" ON "MessageLog"("automationRunId");
CREATE INDEX "MessageLog_patientId_templateCategory_createdAt_idx"
    ON "MessageLog"("patientId", "templateCategory", "createdAt");

-- The send-idempotency key. PARTIAL so the millions of non-automation rows are
-- unaffected: a replayed tick finds this row and does not send a second message.
CREATE UNIQUE INDEX "MessageLog_run_step_key"
    ON "MessageLog"("automationRunId", "automationStep")
    WHERE "automationRunId" IS NOT NULL;

-- ── Coupons: run attribution, and the same idempotency guarantee ───────────
ALTER TABLE "Coupon" ADD COLUMN "automationRunId" TEXT;
ALTER TABLE "Coupon" ADD COLUMN "automationStep" INTEGER;
CREATE INDEX "Coupon_automationRunId_idx" ON "Coupon"("automationRunId");

-- Without this a retried step mints a second code against the same budget.
CREATE UNIQUE INDEX "Coupon_run_step_key"
    ON "Coupon"("automationRunId", "automationStep")
    WHERE "automationRunId" IS NOT NULL;

ALTER TYPE "CouponStatus" ADD VALUE IF NOT EXISTS 'PENDING';
ALTER TYPE "CouponStatus" ADD VALUE IF NOT EXISTS 'REFUNDED';

-- ── Campaign: the money switch, binding, and the liability caps ────────────
-- referrerSharePct defaults to 0 = "the centre absorbs it", which is exactly the
-- behaviour today. The default changes nothing; it just makes it a decision.
ALTER TABLE "CouponCampaign" ADD COLUMN "referrerSharePct" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CouponCampaign" ADD COLUMN "distribution" TEXT NOT NULL DEFAULT 'UNIQUE_PER_PATIENT';
ALTER TABLE "CouponCampaign" ADD COLUMN "bindToPatient" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "CouponCampaign" ADD COLUMN "maxRedemptions" INTEGER;
ALTER TABLE "CouponCampaign" ADD COLUMN "maxDiscountBudgetInPaise" INTEGER;
ALTER TABLE "CouponCampaign" ADD COLUMN "maxDiscountPerBillInPaise" INTEGER;
ALTER TABLE "CouponCampaign" ADD COLUMN "reservedInPaise" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "CouponCampaign" ADD COLUMN "committedInPaise" INTEGER NOT NULL DEFAULT 0;

-- ── Bill: the discount that lost ───────────────────────────────────────────
ALTER TABLE "Bill" ADD COLUMN "rejectedDiscountInPaise" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Bill" ADD COLUMN "rejectedDiscountReason" TEXT;

-- ── Clinical: retest interval belongs with the ranges ──────────────────────
ALTER TABLE "TestDefinition" ADD COLUMN "retestIntervalDays" INTEGER;

-- ── The engine ─────────────────────────────────────────────────────────────
CREATE TABLE "Automation" (
    "id"          TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "group"       TEXT NOT NULL,
    "definition"  JSONB NOT NULL,
    "version"     INTEGER NOT NULL DEFAULT 1,
    "enabled"     BOOLEAN NOT NULL DEFAULT false,
    "activatedAt" TIMESTAMP(3),
    "holdoutPct"  INTEGER NOT NULL DEFAULT 0,
    "priority"    INTEGER NOT NULL DEFAULT 3,
    "branchIds"   TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Automation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Automation_key_key" ON "Automation"("key");
CREATE INDEX "Automation_enabled_idx" ON "Automation"("enabled");

CREATE TABLE "AutomationRun" (
    "id"                    TEXT NOT NULL,
    "automationId"          TEXT NOT NULL,
    "version"               INTEGER NOT NULL,
    "subjectType"           TEXT NOT NULL,
    "subjectId"             TEXT NOT NULL,
    "cycleKey"              TEXT NOT NULL,
    "patientId"             TEXT,
    "branchId"              TEXT,
    "definition"            JSONB NOT NULL,
    "stepIndex"             INTEGER NOT NULL DEFAULT 0,
    "state"                 TEXT NOT NULL DEFAULT 'PENDING',
    "stopReason"            TEXT,
    "holdout"               BOOLEAN NOT NULL DEFAULT false,
    "attempts"              INTEGER NOT NULL DEFAULT 0,
    "triggeredAt"           TIMESTAMP(3) NOT NULL,
    "nextActionAt"          TIMESTAMP(3),
    "convertedAt"           TIMESTAMP(3),
    "convertedBranchId"     TEXT,
    "convertedValueInPaise" INTEGER,
    "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"             TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AutomationRun_pkey" PRIMARY KEY ("id")
);

-- Re-entry, idempotency and deduplication, in one index. A duplicated trigger, a
-- retried request and a second instance all converge on exactly one run.
CREATE UNIQUE INDEX "AutomationRun_automationId_subjectId_cycleKey_key"
    ON "AutomationRun"("automationId", "subjectId", "cycleKey");

-- The ticker's only query. Partial: PENDING is a small slice of a growing table.
CREATE INDEX "AutomationRun_due_idx"
    ON "AutomationRun"("nextActionAt")
    WHERE "state" = 'PENDING';

CREATE INDEX "AutomationRun_automationId_state_idx" ON "AutomationRun"("automationId", "state");
CREATE INDEX "AutomationRun_patientId_idx"   ON "AutomationRun"("patientId");
CREATE INDEX "AutomationRun_convertedAt_idx" ON "AutomationRun"("convertedAt");

ALTER TABLE "AutomationRun" ADD CONSTRAINT "AutomationRun_automationId_fkey"
    FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AutomationStepLog" (
    "id"           TEXT NOT NULL,
    "runId"        TEXT NOT NULL,
    "stepIndex"    INTEGER NOT NULL,
    "kind"         TEXT NOT NULL,
    "outcome"      TEXT NOT NULL,
    "detail"       JSONB,
    "messageLogId" TEXT,
    "at"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutomationStepLog_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "AutomationStepLog_runId_at_idx" ON "AutomationStepLog"("runId", "at");
CREATE INDEX "AutomationStepLog_at_idx"       ON "AutomationStepLog"("at");
ALTER TABLE "AutomationStepLog" ADD CONSTRAINT "AutomationStepLog_runId_fkey"
    FOREIGN KEY ("runId") REFERENCES "AutomationRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One automation may hold one phone line. The primary key is the whole feature.
CREATE TABLE "AwaitingReply" (
    "phone"           TEXT NOT NULL,
    "automationRunId" TEXT NOT NULL,
    "patientId"       TEXT NOT NULL,
    "expiresAt"       TIMESTAMP(3) NOT NULL,
    "match"           JSONB NOT NULL,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AwaitingReply_pkey" PRIMARY KEY ("phone")
);
CREATE UNIQUE INDEX "AwaitingReply_automationRunId_key" ON "AwaitingReply"("automationRunId");
CREATE INDEX "AwaitingReply_expiresAt_idx" ON "AwaitingReply"("expiresAt");

-- Opt-out is per NUMBER. Families share a handset, so a per-patient column could
-- not express "this phone said stop".
CREATE TABLE "PhoneOptOut" (
    "phone"      TEXT NOT NULL,
    "optedOutAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source"     TEXT NOT NULL,
    "byUserId"   TEXT,
    "reason"     TEXT,
    CONSTRAINT "PhoneOptOut_pkey" PRIMARY KEY ("phone")
);
