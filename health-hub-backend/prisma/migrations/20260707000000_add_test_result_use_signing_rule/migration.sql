-- Narrative/text reports: per-report choice of whether to sign with the
-- department's configured SigningRule (true) or the typed name + consultant
-- designation (false/null). Additive + nullable → safe on the live table, no
-- backfill; NULL rows keep the previous "rule always wins" render behavior.
ALTER TABLE "TestResult" ADD COLUMN "useSigningRule" BOOLEAN;
