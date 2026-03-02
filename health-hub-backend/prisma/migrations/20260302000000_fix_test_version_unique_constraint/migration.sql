-- DropIndex: Remove the problematic unique constraint on (code, isLatest)
-- This prevented creating a 3rd+ version because multiple locked versions
-- with the same code all have isLatest=false, violating the unique constraint.
DROP INDEX IF EXISTS "TestDefinition_code_isLatest_key";

-- CreateIndex: Add a unique constraint on (rootDefinitionId, version) instead
-- This correctly ensures each root definition can only have one of each version number.
CREATE UNIQUE INDEX "TestDefinition_rootDefinitionId_version_key" ON "TestDefinition"("rootDefinitionId", "version");

-- CreateIndex: Add a regular index on (code, isLatest) for fast lookups
-- Code uniqueness among latest versions is enforced at the application level.
CREATE INDEX IF NOT EXISTS "TestDefinition_code_isLatest_idx" ON "TestDefinition"("code", "isLatest");
