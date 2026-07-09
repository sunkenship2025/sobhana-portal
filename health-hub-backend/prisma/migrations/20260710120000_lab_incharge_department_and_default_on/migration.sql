-- "Show lab incharge" (SigningRule.showLabInchargeNote) now drives whether the
-- Lab Incharge block appears on a department's report (it replaces the retired
-- Department.showLabIncharge toggle). Default flips OFF -> ON, and existing rules
-- are backfilled to ON so current reports keep showing the block.
ALTER TABLE "SigningRule" ALTER COLUMN "showLabInchargeNote" SET DEFAULT true;
UPDATE "SigningRule" SET "showLabInchargeNote" = true;

-- Lab Incharge rules gain a department dimension: at most one active incharge per
-- (branch, department) slot. NULL departmentId = All Departments (branch default).
ALTER TABLE "LabInchargeRule" ADD COLUMN "departmentId" TEXT;

-- Replace the per-branch unique with a per-(branch, department) unique.
DROP INDEX "LabInchargeRule_branchId_key";
CREATE UNIQUE INDEX "LabInchargeRule_branchId_departmentId_key" ON "LabInchargeRule"("branchId", "departmentId");
CREATE INDEX "LabInchargeRule_departmentId_idx" ON "LabInchargeRule"("departmentId");

ALTER TABLE "LabInchargeRule" ADD CONSTRAINT "LabInchargeRule_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "Department"("id") ON DELETE CASCADE ON UPDATE CASCADE;
