-- Make exact-alias matching indexable.
--
-- The alias tier was `'x' = ANY(SELECT lower(a) FROM unnest(aliases) a)`, which
-- unnests an array for every one of 242,000 rows and cannot use any index. It
-- measured ~260ms of real work while every other tier was free.
--
-- searchText already contains every alias, so an exact alias match is a
-- word-boundary match on it — and that CAN use the GIN trigram index, as long as
-- the column is padded so the first and last words have boundaries too.
CREATE OR REPLACE FUNCTION medication_search_text() RETURNS trigger AS $$
BEGIN
  -- Leading and trailing spaces are deliberate: they let `LIKE '% word %'` find
  -- a term at either end of the string, which is where brand names live.
  NEW."searchText" := ' ' || lower(
    regexp_replace(
      coalesce(NEW."canonicalName", '') || ' ' || coalesce(NEW."genericName", '') || ' ' ||
      coalesce(NEW."brandName", '') || ' ' || coalesce(array_to_string(NEW."aliases", ' '), ''),
      '[^a-zA-Z0-9+ ]', ' ', 'g'
    )
  ) || ' ';
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Rewrite every row through the new trigger.
UPDATE "Medication" SET "canonicalName" = "canonicalName";
