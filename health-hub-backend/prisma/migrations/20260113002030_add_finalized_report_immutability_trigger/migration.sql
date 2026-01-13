-- CreateFunction: Prevent mutation of FINALIZED report versions
CREATE OR REPLACE FUNCTION prevent_finalized_report_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- Prevent any updates to FINALIZED reports (except status change is also blocked)
  IF OLD.status = 'FINALIZED' THEN
    RAISE EXCEPTION 'Cannot modify FINALIZED report version. ID: %, Status: FINALIZED. Medical records are immutable after finalization.', 
      OLD.id
      USING ERRCODE = '23505', -- unique_violation code
            HINT = 'Create a new report version instead of modifying finalized records';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- CreateTrigger: Enforce report immutability at database level
CREATE TRIGGER enforce_report_immutability
  BEFORE UPDATE ON "ReportVersion"
  FOR EACH ROW
  EXECUTE FUNCTION prevent_finalized_report_mutation();
