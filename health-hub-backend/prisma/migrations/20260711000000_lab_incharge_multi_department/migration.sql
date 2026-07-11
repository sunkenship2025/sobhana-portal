-- Lab Incharge rules move from a single department per rule to a SET of
-- departments per rule. A rule with NO department rows now means All Departments.
-- Cross-rule "one incharge per (branch, dept) slot" is enforced in the app layer
-- (a branch may keep an All-Departments catch-all plus specific overrides), so
-- the old (branchId, departmentId) unique slot is retired.

-- 1. New join table: which departments a rule covers.
CREATE TABLE "LabInchargeRuleDepartment" (
    "ruleId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    CONSTRAINT "LabInchargeRuleDepartment_pkey" PRIMARY KEY ("ruleId", "departmentId")
);

CREATE INDEX "LabInchargeRuleDepartment_departmentId_idx" ON "LabInchargeRuleDepartment"("departmentId");

ALTER TABLE "LabInchargeRuleDepartment"
    ADD CONSTRAINT "LabInchargeRuleDepartment_ruleId_fkey"
    FOREIGN KEY ("ruleId") REFERENCES "LabInchargeRule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LabInchargeRuleDepartment"
    ADD CONSTRAINT "LabInchargeRuleDepartment_departmentId_fkey"
    FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 2. Backfill: each rule that targeted a single department becomes one join row.
--    Rules with NULL departmentId (All Departments) get no rows.
INSERT INTO "LabInchargeRuleDepartment" ("ruleId", "departmentId")
SELECT "id", "departmentId" FROM "LabInchargeRule" WHERE "departmentId" IS NOT NULL;

-- 3. Retire the single-department column, its FK, index, and the per-slot unique.
DROP INDEX "LabInchargeRule_branchId_departmentId_key";
DROP INDEX "LabInchargeRule_departmentId_idx";
ALTER TABLE "LabInchargeRule" DROP CONSTRAINT "LabInchargeRule_departmentId_fkey";
ALTER TABLE "LabInchargeRule" DROP COLUMN "departmentId";
