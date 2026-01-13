-- JIRA-15: Bill Immutability Enforcement
-- Prevents any updates to Bill records once created (payment workflows are finalized at creation)
-- Bills should be cancelled/refunded via new records, not modifications

-- Create function to block Bill updates
CREATE OR REPLACE FUNCTION prevent_bill_update()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Bills are immutable once created. Create a refund or adjustment record instead.';
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on Bill table
DROP TRIGGER IF EXISTS enforce_bill_immutability ON "Bill";

CREATE TRIGGER enforce_bill_immutability
BEFORE UPDATE ON "Bill"
FOR EACH ROW
EXECUTE FUNCTION prevent_bill_update();

-- Note: DELETE is still allowed for cascading deletes when Visit is deleted
-- If you also want to prevent deletes, uncomment the following:
-- CREATE TRIGGER prevent_bill_delete
-- BEFORE DELETE ON "Bill"
-- FOR EACH ROW
-- WHEN (OLD.id IS NOT NULL)
-- EXECUTE FUNCTION prevent_bill_update();
