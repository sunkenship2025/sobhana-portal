-- Learn from what doctors actually write.
--
-- When a doctor prescribes something the catalogue does not have, that is not a
-- dead end — it is the single most valuable signal in the system. The research
-- put in-domain adaptation at ~6 WER points against 1.9 for 1,800 hours of
-- generic Hindi data. A doctor correcting "as it real" to Azithral IS in-domain
-- adaptation, one row at a time, and it costs nothing.
--
-- So: a free-text medicine becomes a LEARNED row, findable next time. A
-- correction (heard X, doctor picked Y) becomes an alias on Y.

-- Where a row came from. CURATED rows are hand-written with clinic shorthand and
-- known ASR mishearings; IMPORTED came from the bulk catalogue; LEARNED was
-- written by a doctor here and has never been verified by anyone.
ALTER TABLE "Medication" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'IMPORTED';

-- How often it has actually been prescribed here. Ranks the clinic's own
-- vocabulary above the long tail, which is the whole point of having a 250k-row
-- catalogue and a 40-drug reality.
ALTER TABLE "Medication" ADD COLUMN IF NOT EXISTS "usageCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Medication" ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);

-- Who first wrote it, for a LEARNED row. Not for blame — so an owner reviewing
-- unverified entries knows whom to ask.
ALTER TABLE "Medication" ADD COLUMN IF NOT EXISTS "learnedByUserId" TEXT;

ALTER TABLE "Medication" DROP CONSTRAINT IF EXISTS "Medication_learnedByUserId_fkey";
ALTER TABLE "Medication" ADD CONSTRAINT "Medication_learnedByUserId_fkey"
  FOREIGN KEY ("learnedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing hand-written rows are curated, not imported.
UPDATE "Medication" SET "source" = 'CURATED'
WHERE "source" = 'IMPORTED' AND array_length("aliases", 1) > 3;

CREATE INDEX IF NOT EXISTS "Medication_source_idx" ON "Medication" ("source");
-- Ranking index: the clinic's own most-used first.
CREATE INDEX IF NOT EXISTS "Medication_usage_idx" ON "Medication" ("usageCount" DESC, "lastUsedAt" DESC);
