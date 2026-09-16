-- Partners: one two-sided partner master replacing ExternalLab (we send out) and
-- DiagnosticReferralCenter (they send in) — the same relationship modelled twice
-- in opposite directions. Also adds the centre-wide per-product referral rate,
-- and removes payout settlement state.
--
-- Data at risk is nil: ExternalLab had 0 rows and 0 test orders;
-- DiagnosticReferralCenter had 8 rows, 4 visit links and 4 ledger rows worth ₹0.
-- Both are copied across rather than dropped blind.

-- ─── 1. Types ────────────────────────────────────────────────────────────────
CREATE TYPE "PartnerArrangementKind" AS ENUM ('INBOUND_BILLED_HERE', 'INBOUND_BILLED_THERE', 'OUTBOUND_VENDOR');
CREATE TYPE "PartnerRateBasis" AS ENUM ('PCT_OF_OUR_PRICE', 'PCT_OF_PARTNER_BILLED', 'FLAT');
CREATE TYPE "PartnerDoctorCommissionMode" AS ENUM ('NONE', 'OUR_SHARE', 'GROSS');

-- ─── 2. Tables ───────────────────────────────────────────────────────────────
CREATE TABLE "Partner" (
  "id"            TEXT NOT NULL,
  "partnerNumber" TEXT NOT NULL,
  "name"          TEXT NOT NULL,
  "contactPerson" TEXT,
  "phone"         TEXT,
  "email"         TEXT,
  "address"       TEXT,
  "isActive"      BOOLEAN NOT NULL DEFAULT true,
  "sendBill"      BOOLEAN NOT NULL DEFAULT false,
  "sendReport"    BOOLEAN NOT NULL DEFAULT true,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Partner_partnerNumber_key" ON "Partner"("partnerNumber");
CREATE INDEX "Partner_isActive_idx" ON "Partner"("isActive");
CREATE INDEX "Partner_createdAt_idx" ON "Partner"("createdAt");

CREATE TABLE "PartnerArrangement" (
  "id"                   TEXT NOT NULL,
  "partnerId"            TEXT NOT NULL,
  "kind"                 "PartnerArrangementKind" NOT NULL,
  "isActive"             BOOLEAN NOT NULL DEFAULT true,
  "weCollect"            BOOLEAN NOT NULL,
  "rateBasis"            "PartnerRateBasis" NOT NULL DEFAULT 'PCT_OF_OUR_PRICE',
  "ratePercent"          DOUBLE PRECISION,
  "rateAmountInPaise"    INTEGER,
  "doctorCommissionMode" "PartnerDoctorCommissionMode" NOT NULL DEFAULT 'OUR_SHARE',
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartnerArrangement_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartnerArrangement_partnerId_kind_key" ON "PartnerArrangement"("partnerId", "kind");
CREATE INDEX "PartnerArrangement_partnerId_idx" ON "PartnerArrangement"("partnerId");
ALTER TABLE "PartnerArrangement" ADD CONSTRAINT "PartnerArrangement_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PartnerCategoryRule" (
  "id"                   TEXT NOT NULL,
  "arrangementId"        TEXT NOT NULL,
  "branchId"             TEXT,
  "category"             TEXT NOT NULL,
  "rateBasis"            "PartnerRateBasis" NOT NULL,
  "ratePercent"          DOUBLE PRECISION,
  "rateAmountInPaise"    INTEGER,
  "doctorCommissionMode" "PartnerDoctorCommissionMode",
  "isActive"             BOOLEAN NOT NULL DEFAULT true,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartnerCategoryRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartnerCategoryRule_arrangementId_branchId_category_key" ON "PartnerCategoryRule"("arrangementId", "branchId", "category");
CREATE INDEX "PartnerCategoryRule_arrangementId_idx" ON "PartnerCategoryRule"("arrangementId");
CREATE INDEX "PartnerCategoryRule_branchId_idx" ON "PartnerCategoryRule"("branchId");
ALTER TABLE "PartnerCategoryRule" ADD CONSTRAINT "PartnerCategoryRule_arrangementId_fkey"
  FOREIGN KEY ("arrangementId") REFERENCES "PartnerArrangement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartnerCategoryRule" ADD CONSTRAINT "PartnerCategoryRule_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PartnerProductRule" (
  "id"                   TEXT NOT NULL,
  "arrangementId"        TEXT NOT NULL,
  "branchId"             TEXT,
  "productId"            TEXT NOT NULL,
  "rateBasis"            "PartnerRateBasis" NOT NULL,
  "ratePercent"          DOUBLE PRECISION,
  "rateAmountInPaise"    INTEGER,
  "doctorCommissionMode" "PartnerDoctorCommissionMode",
  "isActive"             BOOLEAN NOT NULL DEFAULT true,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PartnerProductRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartnerProductRule_arrangementId_branchId_productId_key" ON "PartnerProductRule"("arrangementId", "branchId", "productId");
CREATE INDEX "PartnerProductRule_arrangementId_idx" ON "PartnerProductRule"("arrangementId");
CREATE INDEX "PartnerProductRule_productId_idx" ON "PartnerProductRule"("productId");
CREATE INDEX "PartnerProductRule_branchId_idx" ON "PartnerProductRule"("branchId");
ALTER TABLE "PartnerProductRule" ADD CONSTRAINT "PartnerProductRule_arrangementId_fkey"
  FOREIGN KEY ("arrangementId") REFERENCES "PartnerArrangement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartnerProductRule" ADD CONSTRAINT "PartnerProductRule_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "BillableProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartnerProductRule" ADD CONSTRAINT "PartnerProductRule_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PartnerVisit" (
  "id"                   TEXT NOT NULL,
  "visitId"              TEXT NOT NULL,
  "partnerId"            TEXT NOT NULL,
  "branchId"             TEXT NOT NULL,
  "kind"                 "PartnerArrangementKind" NOT NULL,
  "partnerBilledInPaise" INTEGER,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PartnerVisit_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PartnerVisit_visitId_key" ON "PartnerVisit"("visitId");
CREATE INDEX "PartnerVisit_partnerId_idx" ON "PartnerVisit"("partnerId");
CREATE INDEX "PartnerVisit_branchId_idx" ON "PartnerVisit"("branchId");
CREATE INDEX "PartnerVisit_kind_idx" ON "PartnerVisit"("kind");
ALTER TABLE "PartnerVisit" ADD CONSTRAINT "PartnerVisit_visitId_fkey"
  FOREIGN KEY ("visitId") REFERENCES "Visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PartnerVisit" ADD CONSTRAINT "PartnerVisit_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PartnerVisit" ADD CONSTRAINT "PartnerVisit_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Centre-wide per-product referral rate: the missing rung.
CREATE TABLE "ReferralProductRate" (
  "id"                      TEXT NOT NULL,
  "branchId"                TEXT,
  "productId"               TEXT NOT NULL,
  "commissionType"          "ReferralPayoutType" NOT NULL DEFAULT 'PERCENTAGE',
  "commissionPercent"       DOUBLE PRECISION,
  "commissionAmountInPaise" INTEGER,
  "isActive"                BOOLEAN NOT NULL DEFAULT true,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ReferralProductRate_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ReferralProductRate_branchId_productId_key" ON "ReferralProductRate"("branchId", "productId");
CREATE INDEX "ReferralProductRate_productId_idx" ON "ReferralProductRate"("productId");
CREATE INDEX "ReferralProductRate_branchId_idx" ON "ReferralProductRate"("branchId");
CREATE INDEX "ReferralProductRate_isActive_idx" ON "ReferralProductRate"("isActive");
ALTER TABLE "ReferralProductRate" ADD CONSTRAINT "ReferralProductRate_productId_fkey"
  FOREIGN KEY ("productId") REFERENCES "BillableProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReferralProductRate" ADD CONSTRAINT "ReferralProductRate_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── 3. Carry the old rows across ────────────────────────────────────────────
-- Both old tables fold into Partner. A DiagnosticReferralCenter meant "they send
-- patients in, we bill" = INBOUND_BILLED_HERE; an ExternalLab meant "we send work
-- out" = OUTBOUND_VENDOR. An organisation present in BOTH becomes ONE partner
-- holding two arrangements — the whole point of the merge — matched on name,
-- case-insensitively.
--
-- Both old tables stored the OTHER party's cut; a partner rate is always OUR
-- share, so percentages invert. Every live row is PERCENTAGE (verified), so the
-- inversion is exact. A FIXED_AMOUNT cut cannot be restated as a share without a
-- price, so those carry 100% and a NULL rate for the owner to set — there are
-- none today, in either table.

CREATE TEMP TABLE _partner_src AS
SELECT c."id"      AS "srcId",
       'CENTRE'    AS "srcKind",
       c."name", c."contactPerson", c."phone", c."email", c."address",
       c."isActive", c."createdAt", c."updatedAt",
       c."commissionType" AS "rateType", c."commissionPercent" AS "ratePct"
FROM "DiagnosticReferralCenter" c
UNION ALL
SELECT l."id", 'LAB', l."name", l."contactPerson", l."phone", l."email", l."address",
       l."isActive", l."createdAt", l."updatedAt", l."rateType", l."ratePercent"
FROM "ExternalLab" l;

-- One Partner per distinct name; the earliest row wins the identity fields.
CREATE TEMP TABLE _partner_new AS
SELECT DISTINCT ON (LOWER(TRIM("name")))
       "srcId" AS "partnerId", LOWER(TRIM("name")) AS "nameKey",
       "name", "contactPerson", "phone", "email", "address", "isActive",
       "createdAt", "updatedAt"
FROM _partner_src
ORDER BY LOWER(TRIM("name")), "createdAt" ASC, "srcId" ASC;

INSERT INTO "Partner" ("id","partnerNumber","name","contactPerson","phone","email","address","isActive","sendBill","sendReport","createdAt","updatedAt")
SELECT "partnerId",
       'PT-' || LPAD((ROW_NUMBER() OVER (ORDER BY "createdAt", "partnerId"))::text, 5, '0'),
       "name", "contactPerson", "phone", "email", "address", "isActive",
       true,   -- both old shapes billed here, so the patient did get our bill
       true,
       "createdAt", "updatedAt"
FROM _partner_new;

-- srcId → partnerId, so arrangements and ledger rows land on the merged partner.
CREATE TEMP TABLE _partner_map AS
SELECT s."srcId", s."srcKind", n."partnerId"
FROM _partner_src s
JOIN _partner_new n ON n."nameKey" = LOWER(TRIM(s."name"));

INSERT INTO "PartnerArrangement" ("id","partnerId","kind","isActive","weCollect","rateBasis","ratePercent","rateAmountInPaise","doctorCommissionMode","createdAt","updatedAt")
SELECT s."srcId", m."partnerId",
       CASE s."srcKind" WHEN 'CENTRE' THEN 'INBOUND_BILLED_HERE'::"PartnerArrangementKind"
                        ELSE 'OUTBOUND_VENDOR'::"PartnerArrangementKind" END,
       s."isActive", true, 'PCT_OF_OUR_PRICE'::"PartnerRateBasis",
       CASE WHEN s."rateType" = 'PERCENTAGE' THEN 100 - COALESCE(s."ratePct", 0) ELSE NULL END,
       NULL, 'OUR_SHARE'::"PartnerDoctorCommissionMode", s."createdAt", s."updatedAt"
FROM _partner_src s JOIN _partner_map m ON m."srcId" = s."srcId";

INSERT INTO "PartnerProductRule" ("id","arrangementId","branchId","productId","rateBasis","ratePercent","rateAmountInPaise","doctorCommissionMode","isActive","createdAt","updatedAt")
SELECT r."id", r."diagnosticCenterId", NULL, r."productId", 'PCT_OF_OUR_PRICE'::"PartnerRateBasis",
       CASE WHEN r."commissionType" = 'PERCENTAGE' THEN 100 - COALESCE(r."commissionPercent", 0) ELSE NULL END,
       NULL::INTEGER, NULL::"PartnerDoctorCommissionMode", r."isActive", r."createdAt", r."updatedAt"
FROM "DiagnosticCenterProductRule" r
UNION ALL
SELECT r."id", r."externalLabId", NULL, r."productId", 'PCT_OF_OUR_PRICE'::"PartnerRateBasis",
       CASE WHEN r."rateType" = 'PERCENTAGE' THEN 100 - COALESCE(r."ratePercent", 0) ELSE NULL END,
       NULL::INTEGER, NULL::"PartnerDoctorCommissionMode", r."isActive", r."createdAt", r."updatedAt"
FROM "ExternalLabProductRule" r;

INSERT INTO "PartnerVisit" ("id","visitId","partnerId","branchId","kind","partnerBilledInPaise","createdAt")
SELECT DISTINCT ON (v."visitId")
       v."id", v."visitId", m."partnerId", v."branchId", 'INBOUND_BILLED_HERE'::"PartnerArrangementKind", NULL, v."createdAt"
FROM "DiagnosticCenter_Visit" v
JOIN _partner_map m ON m."srcId" = v."diagnosticCenterId" AND m."srcKind" = 'CENTRE'
ORDER BY v."visitId", v."createdAt" ASC;

-- ─── 4. TestOrder: partner snapshots replace the two old sets ────────────────
ALTER TABLE "TestOrder"
  ADD COLUMN "partnerId"          TEXT,
  ADD COLUMN "partnerArrangement" "PartnerArrangementKind",
  ADD COLUMN "ourShareBasis"      "PartnerRateBasis",
  ADD COLUMN "ourSharePercent"    DOUBLE PRECISION,
  ADD COLUMN "ourShareInPaise"    INTEGER,
  ADD COLUMN "partnerCutInPaise"  INTEGER;

CREATE INDEX "TestOrder_partnerId_idx" ON "TestOrder"("partnerId");
ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX IF EXISTS "TestOrder_externalLabId_idx";
ALTER TABLE "TestOrder" DROP CONSTRAINT IF EXISTS "TestOrder_externalLabId_fkey";
ALTER TABLE "TestOrder"
  DROP COLUMN "diagnosticCenterCommissionType",
  DROP COLUMN "diagnosticCenterCommissionPercentage",
  DROP COLUMN "diagnosticCenterCommissionAmountInPaise",
  DROP COLUMN "externalLabId",
  DROP COLUMN "labCostType",
  DROP COLUMN "labCostPercentage",
  DROP COLUMN "labCostAmountInPaise";

-- ─── 5. Ledger: one partner FK, one PARTNER payee type, no settlement state ──
ALTER TABLE "DoctorPayoutLedger" ADD COLUMN "partnerId" TEXT;
UPDATE "DoctorPayoutLedger" l SET "partnerId" = m."partnerId"
FROM _partner_map m
WHERE m."srcId" = COALESCE(l."diagnosticCenterId", l."externalLabId");

DROP INDEX IF EXISTS "DoctorPayoutLedger_active_payout_uniq";
DROP INDEX IF EXISTS "DoctorPayoutLedger_lookup_idx";
DROP INDEX IF EXISTS "DoctorPayoutLedger_diagnosticCenterId_idx";
DROP INDEX IF EXISTS "DoctorPayoutLedger_externalLabId_idx";
DROP INDEX IF EXISTS "DoctorPayoutLedger_paidAt_idx";
ALTER TABLE "DoctorPayoutLedger" DROP CONSTRAINT IF EXISTS "DoctorPayoutLedger_diagnosticCenterId_fkey";
ALTER TABLE "DoctorPayoutLedger" DROP CONSTRAINT IF EXISTS "DoctorPayoutLedger_externalLabId_fkey";
ALTER TABLE "DoctorPayoutLedger"
  DROP COLUMN "diagnosticCenterId",
  DROP COLUMN "externalLabId",
  DROP COLUMN "reviewedAt",
  DROP COLUMN "paidAt",
  DROP COLUMN "paymentMethod",
  DROP COLUMN "paymentReferenceId";

-- Postgres cannot drop an enum value, so the type is rebuilt.
ALTER TYPE "PayoutDoctorType" RENAME TO "PayoutDoctorType_old";
CREATE TYPE "PayoutDoctorType" AS ENUM ('REFERRAL', 'CLINIC', 'PARTNER');
ALTER TABLE "DoctorPayoutLedger"
  ALTER COLUMN "doctorType" TYPE "PayoutDoctorType"
  USING (CASE WHEN "doctorType"::text IN ('DIAGNOSTIC_CENTER', 'LAB') THEN 'PARTNER'
              ELSE "doctorType"::text END)::"PayoutDoctorType";
DROP TYPE "PayoutDoctorType_old";

CREATE UNIQUE INDEX "DoctorPayoutLedger_active_payout_uniq"
  ON "DoctorPayoutLedger"("doctorType","referralDoctorId","clinicDoctorId","partnerId","branchId","periodStartDate","periodEndDate")
  WHERE "deletedAt" IS NULL;
CREATE INDEX "DoctorPayoutLedger_lookup_idx"
  ON "DoctorPayoutLedger"("doctorType","referralDoctorId","clinicDoctorId","partnerId","branchId","periodStartDate","periodEndDate");
CREATE INDEX "DoctorPayoutLedger_partnerId_idx" ON "DoctorPayoutLedger"("partnerId");
ALTER TABLE "DoctorPayoutLedger" ADD CONSTRAINT "DoctorPayoutLedger_partnerId_fkey"
  FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── 6. Retire the old tables ────────────────────────────────────────────────
DROP TABLE "DiagnosticCenter_Visit";
DROP TABLE "DiagnosticCenterProductRule";
DROP TABLE "ExternalLabProductRule";
DROP TABLE "DiagnosticReferralCenter";
DROP TABLE "ExternalLab";
