-- Branch-scope the three referral rate tables.
-- branchId NULL = global default (every branch inherits it); a row with a
-- branchId is that branch's override. Existing rows all get NULL => they stay
-- the global default, so nothing changes until a branch override is added.
--
-- The compound uniques below are PLAIN unique indexes (portable to every
-- Postgres version — no NULLS NOT DISTINCT). They fully enforce uniqueness for
-- branch rows (branchId is never null there). Global (NULL-branch) rows are only
-- ever written through delete-then-recreate / find-then-write code paths that
-- already prevent duplicates, so no DB-level null handling is required.
-- Index names match Prisma's @@unique([branchId, ...]) so there is no drift.

-- ── ReferralCategoryRate ──────────────────────────────────────────────
ALTER TABLE "ReferralCategoryRate" ADD COLUMN "branchId" TEXT;

ALTER TABLE "ReferralCategoryRate" DROP CONSTRAINT IF EXISTS "ReferralCategoryRate_category_key";
DROP INDEX IF EXISTS "ReferralCategoryRate_category_key";

CREATE UNIQUE INDEX "ReferralCategoryRate_branchId_category_key"
  ON "ReferralCategoryRate" ("branchId", "category");
CREATE INDEX "ReferralCategoryRate_branchId_idx" ON "ReferralCategoryRate" ("branchId");

ALTER TABLE "ReferralCategoryRate"
  ADD CONSTRAINT "ReferralCategoryRate_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ReferralDoctorCategoryRule ────────────────────────────────────────
ALTER TABLE "ReferralDoctorCategoryRule" ADD COLUMN "branchId" TEXT;

ALTER TABLE "ReferralDoctorCategoryRule" DROP CONSTRAINT IF EXISTS "ReferralDoctorCategoryRule_referralDoctorId_category_key";
DROP INDEX IF EXISTS "ReferralDoctorCategoryRule_referralDoctorId_category_key";

CREATE UNIQUE INDEX "ReferralDoctorCategoryRule_referralDoctorId_branchId_category_key"
  ON "ReferralDoctorCategoryRule" ("referralDoctorId", "branchId", "category");
CREATE INDEX "ReferralDoctorCategoryRule_branchId_idx" ON "ReferralDoctorCategoryRule" ("branchId");

ALTER TABLE "ReferralDoctorCategoryRule"
  ADD CONSTRAINT "ReferralDoctorCategoryRule_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── ReferralDoctorProductRule ─────────────────────────────────────────
ALTER TABLE "ReferralDoctorProductRule" ADD COLUMN "branchId" TEXT;

ALTER TABLE "ReferralDoctorProductRule" DROP CONSTRAINT IF EXISTS "ReferralDoctorProductRule_referralDoctorId_productId_key";
DROP INDEX IF EXISTS "ReferralDoctorProductRule_referralDoctorId_productId_key";

CREATE UNIQUE INDEX "ReferralDoctorProductRule_referralDoctorId_branchId_productId_key"
  ON "ReferralDoctorProductRule" ("referralDoctorId", "branchId", "productId");
CREATE INDEX "ReferralDoctorProductRule_branchId_idx" ON "ReferralDoctorProductRule" ("branchId");

ALTER TABLE "ReferralDoctorProductRule"
  ADD CONSTRAINT "ReferralDoctorProductRule_branchId_fkey"
  FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE;
