-- Keep Medication."searchText" correct without anyone remembering to.
--
-- The column was being set by whichever writer happened to think of it — the
-- bulk importer did, the seed script did not, and a row missing it is invisible
-- to fuzzy and prefix search while looking perfectly fine in the table. That is
-- the worst kind of bug: a medicine that exists but cannot be found.
--
-- A trigger is the shared guard. Every INSERT and UPDATE goes through it, so
-- there is exactly one place the rule lives and no writer can forget it.
-- (A GENERATED column would be tidier, but array_to_string is not IMMUTABLE and
-- Postgres refuses it.)
CREATE OR REPLACE FUNCTION medication_search_text() RETURNS trigger AS $$
BEGIN
  NEW."searchText" := lower(
    regexp_replace(
      coalesce(NEW."canonicalName", '') || ' ' || coalesce(NEW."genericName", '') || ' ' ||
      coalesce(NEW."brandName", '') || ' ' || coalesce(array_to_string(NEW."aliases", ' '), ''),
      '[^a-zA-Z0-9+ ]', ' ', 'g'
    )
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS medication_search_text_trg ON "Medication";
CREATE TRIGGER medication_search_text_trg
  BEFORE INSERT OR UPDATE OF "canonicalName", "genericName", "brandName", "aliases"
  ON "Medication"
  FOR EACH ROW EXECUTE FUNCTION medication_search_text();

-- Backfill anything written between the previous migration and this trigger.
UPDATE "Medication" SET "canonicalName" = "canonicalName" WHERE "searchText" IS NULL;
