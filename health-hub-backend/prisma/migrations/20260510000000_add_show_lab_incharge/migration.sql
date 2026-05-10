-- Per-department toggle: whether the Lab Incharge sign-off block appears on
-- the printed report when this department is part of the report.
-- Radiology defaults OFF (radiologist signs out, no lab incharge needed).

ALTER TABLE "Department"
  ADD COLUMN "showLabIncharge" BOOLEAN NOT NULL DEFAULT true;

UPDATE "Department"
  SET "showLabIncharge" = false
  WHERE "name" = 'RADIOLOGY';
