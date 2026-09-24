-- Prescription records on the staff side: Patient 360 and Finalized OP/IP show,
-- print and send a signed prescription the way they already do bills and reports.

-- How a clinic visit closed without a digital prescription while the module was
-- on: 'NONE' (the doctor said no prescription) or 'PAPER' (reception closed it).
ALTER TABLE "ClinicVisit" ADD COLUMN IF NOT EXISTS "rxOutcome" TEXT;

-- When staff last printed it, so Print turns green like the bill and report.
ALTER TABLE "Prescription" ADD COLUMN IF NOT EXISTS "printedAt" TIMESTAMP(3);
