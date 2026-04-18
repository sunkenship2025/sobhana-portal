CREATE TYPE "DiagnosticWorkflowMode" AS ENUM ('REPORTABLE', 'BILL_ONLY');

ALTER TABLE "BillableProduct"
ADD COLUMN "workflowMode" "DiagnosticWorkflowMode" NOT NULL DEFAULT 'REPORTABLE';

ALTER TABLE "TestOrder"
ADD COLUMN "workflowMode" "DiagnosticWorkflowMode" NOT NULL DEFAULT 'REPORTABLE';

CREATE INDEX "BillableProduct_workflowMode_idx" ON "BillableProduct"("workflowMode");
CREATE INDEX "TestOrder_workflowMode_idx" ON "TestOrder"("workflowMode");
