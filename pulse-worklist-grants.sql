-- Pulse work lists: the owner chasing their own dues needs names and phone numbers.
-- Granted narrowly: Patient.name, and PatientIdentifier only for PHONE rows via a view —
-- the base table stays ungranted so email, Aadhaar and the rest remain unreachable.
GRANT SELECT ("name") ON "Patient" TO analytics_ro;

CREATE OR REPLACE VIEW "PatientPhone" AS
  SELECT DISTINCT ON ("patientId") "patientId", "value" AS phone
  FROM "PatientIdentifier" WHERE "type" = 'PHONE' ORDER BY "patientId", "createdAt" DESC;
GRANT SELECT ON "PatientPhone" TO analytics_ro;
