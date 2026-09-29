-- Where enrolment has read up to, per automation, so each sweep reads forward.
-- Null means "from activatedAt": the first sweep after this deploy walks forward from
-- activation and so reaches every visit the old first-page-only sweep never looked at.
ALTER TABLE "Automation" ADD COLUMN "sweepState" JSONB;
