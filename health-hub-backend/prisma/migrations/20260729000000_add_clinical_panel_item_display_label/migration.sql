-- ClinicalPanelItem: per-panel row-label override so the Report Builder can
-- rename a test's label within ONE report without touching the canonical
-- TestDefinition. Additive + nullable, so no backfill and no table rewrite —
-- historical rows keep displayLabel = NULL and fall back to TestDefinition.name
-- at render (reportSnapshotService.buildPanelsAndDepartments).
ALTER TABLE "ClinicalPanelItem" ADD COLUMN "displayLabel" TEXT;
