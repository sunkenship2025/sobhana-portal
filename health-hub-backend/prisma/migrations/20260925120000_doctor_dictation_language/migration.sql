-- What a doctor speaks when dictating ('te' | 'hi' | 'en'; null = detect), so the
-- recogniser is told what reads their speech best.
ALTER TABLE "ClinicDoctor" ADD COLUMN IF NOT EXISTS "dictationLanguage" TEXT;
