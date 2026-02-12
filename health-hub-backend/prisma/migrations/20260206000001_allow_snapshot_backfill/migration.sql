-- AlterFunction: Allow one-time snapshot initialization on FINALIZED reports
-- Snapshots are frozen at finalization but may need backfilling for reports
-- finalized before snapshot code was deployed.
CREATE OR REPLACE FUNCTION prevent_finalized_report_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.status = 'FINALIZED' THEN
    -- Allow one-time snapshot field initialization (NULL -> value)
    -- Once snapshot fields are set, they become immutable too
    IF OLD."panelsSnapshot" IS NULL 
       AND OLD."patientSnapshot" IS NULL 
       AND OLD."visitSnapshot" IS NULL 
       AND OLD."signaturesSnapshot" IS NULL
       AND NEW.status = 'FINALIZED'
       AND NEW."reportId" = OLD."reportId"
       AND NEW."versionNum" = OLD."versionNum"
    THEN
      -- Allow: this is a snapshot backfill operation
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Cannot modify FINALIZED report version. ID: %, Status: FINALIZED. Medical records are immutable after finalization.', 
      OLD.id
      USING ERRCODE = '23505',
            HINT = 'Create a new report version instead of modifying finalized records';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
