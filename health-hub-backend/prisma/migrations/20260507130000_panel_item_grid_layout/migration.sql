-- ClinicalPanelItem: side-by-side layout fields.
-- joinPrevious=true makes an item render on the same line as its predecessor
-- (by displayOrder). gridWidth is the relative width within the row in 12-grid
-- units; null = even split. Fully backward compatible — existing rows default
-- to joinPrevious=false / gridWidth=NULL and keep one-per-row rendering.

ALTER TABLE "ClinicalPanelItem" ADD COLUMN "joinPrevious" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ClinicalPanelItem" ADD COLUMN "gridWidth" INTEGER;
