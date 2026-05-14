-- Per-narrative-report signer override on TestResult.
--
-- Free-text doctor name the radiologist types in the dedicated input below
-- the framed editor. When set, the PDF signature block prints just this
-- name above the department designation (no degrees / reg-no), overriding
-- any configured SigningRule for that page.
--
-- Nullable because:
--   (a) only narrative reports surface the input — numeric results have no
--       use for it.
--   (b) the field is optional even for narratives; an empty value falls
--       back to the existing rule/placeholder logic.

ALTER TABLE "TestResult"
  ADD COLUMN "signerNameOverride" TEXT;
