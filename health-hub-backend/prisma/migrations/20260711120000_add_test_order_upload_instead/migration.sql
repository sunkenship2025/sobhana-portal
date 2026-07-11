-- "Upload instead": per-order trace for a REPORTABLE narrative/text report that
-- was switched to being fulfilled by an uploaded PDF (workflowMode flips to
-- EXTERNAL_UPLOAD; these columns record who/when and distinguish a SWITCHED order
-- from one born EXTERNAL_UPLOAD). Cleared on toggle-back to typing.
-- Additive/nullable — safe on a live table.
ALTER TABLE "TestOrder" ADD COLUMN     "uploadInsteadAt" TIMESTAMP(3),
ADD COLUMN     "uploadInsteadByUserId" TEXT;

ALTER TABLE "TestOrder" ADD CONSTRAINT "TestOrder_uploadInsteadByUserId_fkey" FOREIGN KEY ("uploadInsteadByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
