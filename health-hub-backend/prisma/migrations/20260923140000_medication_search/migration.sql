-- Medication search at catalogue scale.
--
-- WHY THIS MIGRATION EXISTS
-- The resolver originally loaded every Medication row into memory and matched
-- there — correct and fast for the 41-row hand-written seed, and an OOM waiting
-- to happen at 250,000 rows on a 512MB Render instance that has already been
-- OOM-remediated once. Search moves into Postgres, which is where a quarter of a
-- million rows belongs.
--
-- pg_trgm gives us fuzzy matching as an INDEXED operation rather than a full
-- scan in Node. It is a standard extension and is available on Neon.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One lowercased, punctuation-stripped column to match against, covering the
-- canonical name, generic, brand AND every alias. Generated rather than
-- maintained by hand so it can never drift from the row it describes.
ALTER TABLE "Medication" ADD COLUMN IF NOT EXISTS "searchText" TEXT;

UPDATE "Medication"
SET "searchText" = lower(
  regexp_replace(
    coalesce("canonicalName", '') || ' ' || coalesce("genericName", '') || ' ' ||
    coalesce("brandName", '') || ' ' || coalesce(array_to_string("aliases", ' '), ''),
    '[^a-zA-Z0-9+ ]', ' ', 'g'
  )
)
WHERE "searchText" IS NULL;

-- Trigram index: powers both ILIKE '%x%' and similarity() without a seq scan.
CREATE INDEX IF NOT EXISTS "Medication_searchText_trgm_idx"
  ON "Medication" USING GIN ("searchText" gin_trgm_ops);

-- Prefix search ("amo" -> Amoxicillin) wants a btree on the lowercased name.
CREATE INDEX IF NOT EXISTS "Medication_canonical_lower_idx"
  ON "Medication" (lower("canonicalName") text_pattern_ops);
CREATE INDEX IF NOT EXISTS "Medication_brand_lower_idx"
  ON "Medication" (lower("brandName") text_pattern_ops);

-- Manufacturer is worth searching once the catalogue carries 250k rows from
-- hundreds of companies.
CREATE INDEX IF NOT EXISTS "Medication_manufacturer_idx" ON "Medication" ("manufacturer");
