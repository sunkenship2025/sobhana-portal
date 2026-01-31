-- JIRA-15: Bill Immutability Enforcement
-- Prevents modification of bill IDENTITY fields (billNumber, branchId, visitId)
-- Allows updates to: paymentStatus, paymentType, totalAmountInPaise (before report finalization)
-- After report finalization, totalAmountInPaise also becomes immutable

-- Create function to protect bill identity fields
CREATE OR REPLACE FUNCTION prevent_bill_identity_update()
RETURNS TRIGGER AS $$
BEGIN
  -- Block changes to identity fields (these should NEVER change after bill creation)
  IF OLD."billNumber" IS DISTINCT FROM NEW."billNumber" THEN
    RAISE EXCEPTION 'Cannot modify bill number. Bill numbers are immutable once assigned.';
  END IF;
  
  IF OLD."branchId" IS DISTINCT FROM NEW."branchId" THEN
    RAISE EXCEPTION 'Cannot modify bill branch. Branch assignment is immutable.';
  END IF;
  
  IF OLD."visitId" IS DISTINCT FROM NEW."visitId" THEN
    RAISE EXCEPTION 'Cannot modify bill visit association. Visit link is immutable.';
  END IF;
  
  -- Allow updates to paymentStatus, paymentType, totalAmountInPaise
  -- Note: totalAmountInPaise changes are allowed until report finalization
  -- (enforced at application level based on report status)
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on Bill table
DROP TRIGGER IF EXISTS enforce_bill_immutability ON "Bill";

CREATE TRIGGER enforce_bill_immutability
BEFORE UPDATE ON "Bill"
FOR EACH ROW
EXECUTE FUNCTION prevent_bill_identity_update();

-- Note: DELETE is still allowed for cascading deletes when Visit is deleted
-- Full bill deletion is handled by visit lifecycle, not individual bill deletion
