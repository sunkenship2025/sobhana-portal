-- Relabel AnomalyEvent rows projected before the classifier learned these events
-- (old "Updated Patient" / "Created VISIT" etc.). Joins each row to its source
-- AuditLog. Runs once on deploy. The drawer recomputes field diffs live; this
-- just fixes the LIST label for historical rows.

UPDATE "AnomalyEvent" ae
SET "event" = 'Patient details edited', "category" = 'identity', "severity" = 'low'
FROM "AuditLog" al
WHERE ae."sourceKind" = 'audit' AND ae."sourceId" = al."id"
  AND al."actionType" = 'UPDATE' AND lower(al."entityType") = 'patient';

UPDATE "AnomalyEvent" ae
SET "event" = 'Patient registered', "category" = 'identity', "severity" = 'low'
FROM "AuditLog" al
WHERE ae."sourceKind" = 'audit' AND ae."sourceId" = al."id"
  AND al."actionType" = 'CREATE' AND lower(al."entityType") = 'patient';

UPDATE "AnomalyEvent" ae
SET "event" = 'Visit billed', "category" = 'money', "severity" = 'low'
FROM "AuditLog" al
WHERE ae."sourceKind" = 'audit' AND ae."sourceId" = al."id"
  AND al."actionType" = 'CREATE' AND lower(al."entityType") = 'visit';

UPDATE "AnomalyEvent" ae
SET "event" = 'Clinical definition edited', "category" = 'report', "severity" = 'low'
FROM "AuditLog" al
WHERE ae."sourceKind" = 'audit' AND ae."sourceId" = al."id"
  AND al."actionType" = 'UPDATE' AND lower(al."entityType") = 'testdefinition';

UPDATE "AnomalyEvent" ae
SET "event" = 'Clinical definition created', "category" = 'report', "severity" = 'low'
FROM "AuditLog" al
WHERE ae."sourceKind" = 'audit' AND ae."sourceId" = al."id"
  AND al."actionType" = 'CREATE' AND lower(al."entityType") = 'testdefinition';

UPDATE "AnomalyEvent" ae
SET "event" = 'Clinical panel edited', "category" = 'report', "severity" = 'low'
FROM "AuditLog" al
WHERE ae."sourceKind" = 'audit' AND ae."sourceId" = al."id"
  AND al."actionType" = 'UPDATE' AND lower(al."entityType") = 'clinicalpanel';

UPDATE "AnomalyEvent" ae
SET "event" = 'Clinical panel created', "category" = 'report', "severity" = 'low'
FROM "AuditLog" al
WHERE ae."sourceKind" = 'audit' AND ae."sourceId" = al."id"
  AND al."actionType" = 'CREATE' AND lower(al."entityType") = 'clinicalpanel';
