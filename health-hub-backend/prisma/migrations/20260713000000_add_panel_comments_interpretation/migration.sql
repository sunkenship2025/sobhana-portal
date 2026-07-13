-- ClinicalPanel: split the single "interpretation" box into rich-text Comments (default)
-- + Interpretation (advanced). Additive; summaryInterpretationTemplate is retained for rollback.
ALTER TABLE "ClinicalPanel" ADD COLUMN "comments" TEXT;
ALTER TABLE "ClinicalPanel" ADD COLUMN "interpretation" TEXT;

-- Backfill: existing static interpretation text becomes COMMENTS (the new default section).
UPDATE "ClinicalPanel"
SET "comments" = "summaryInterpretationTemplate"
WHERE "summaryInterpretationTemplate" IS NOT NULL
  AND btrim("summaryInterpretationTemplate") <> '';
