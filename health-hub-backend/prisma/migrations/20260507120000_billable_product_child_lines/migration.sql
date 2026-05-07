-- Allow BillableProductPanel rows to reference either a ClinicalPanel or
-- another BillableProduct (for packages that include bill-only items as
-- line items). Existing rows keep their panelId; new rows can set
-- childProductId instead. Exactly one of the two is enforced in app code.

-- 1. Drop the existing FK + unique on panelId so we can make it nullable
ALTER TABLE "BillableProductPanel" DROP CONSTRAINT "BillableProductPanel_panelId_fkey";

-- 2. Make panelId nullable
ALTER TABLE "BillableProductPanel" ALTER COLUMN "panelId" DROP NOT NULL;

-- 3. Re-add the FK on the now-nullable column
ALTER TABLE "BillableProductPanel"
  ADD CONSTRAINT "BillableProductPanel_panelId_fkey"
  FOREIGN KEY ("panelId") REFERENCES "ClinicalPanel"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Add the new childProductId column + FK
ALTER TABLE "BillableProductPanel" ADD COLUMN "childProductId" TEXT;

ALTER TABLE "BillableProductPanel"
  ADD CONSTRAINT "BillableProductPanel_childProductId_fkey"
  FOREIGN KEY ("childProductId") REFERENCES "BillableProduct"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- 5. Index + unique on (productId, childProductId)
CREATE INDEX "BillableProductPanel_childProductId_idx"
  ON "BillableProductPanel"("childProductId");

CREATE UNIQUE INDEX "BillableProductPanel_productId_childProductId_key"
  ON "BillableProductPanel"("productId", "childProductId");
