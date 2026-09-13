-- ============================================================================
-- analytics_ro — read-only role for the AI Analytics Layer
-- Run against the Neon prod branch. Plain CREATE ROLE (NOT the Neon API), because
-- roles created through Neon's API are granted neon_superuser — the opposite of what we want.
-- Replace CHANGE_ME with a generated password before running.
-- ============================================================================

CREATE ROLE analytics_ro LOGIN PASSWORD 'CHANGE_ME';
ALTER ROLE analytics_ro SET default_transaction_read_only = on;
ALTER ROLE analytics_ro SET statement_timeout = '8s';
ALTER ROLE analytics_ro SET idle_in_transaction_session_timeout = '15s';

GRANT CONNECT ON DATABASE neondb TO analytics_ro;
GRANT USAGE   ON SCHEMA public   TO analytics_ro;

-- Fact + dimension tables the analytics layer may read in full
GRANT SELECT ON
  "Visit","Bill","TestOrder","PaymentTransaction","OrderRefund","TestResult",
  "ReportVersion","DiagnosticReport","ClinicVisit","Branch","Department",
  "ClinicalPanel","ClinicalPanelItem","BillableProduct","BillableProductPanel",
  "TestDefinition","ReferralDoctor","ReferralDoctor_Visit","ClinicDoctor",
  "MessageLog","AnomalyEvent","AuditLog","DoctorPayoutLedger","SmartReport",
  "Coupon","CouponCampaign","ExternalReportUpload","PatientChangeLog"
TO analytics_ro;

-- Column-limited: demographics only, never name/address/DOB
GRANT SELECT ("id","gender","yearOfBirth","ageUnit","createdAt","patientNumber")
  ON "Patient" TO analytics_ro;

-- Column-limited: attribution only, never passwordHash/email/phone
GRANT SELECT ("id","name","role","activeBranchId","isActive")
  ON "User" TO analytics_ro;

-- Deliberately granted NOTHING (bearer tokens, identifiers, access logs, config):
--   ReportAccessToken, BillAccessToken, StatementAccessToken, PatientIdentifier,
--   AppSetting, PatientAuthEvent, Conversation, ConversationMessage,
--   ReportAccessLog, BillAccessLog, LinkAccessLog
-- Future tables must be granted explicitly — no blanket ALL TABLES grant, and no
-- ALTER DEFAULT PRIVILEGES, so a new table is invisible until someone opts it in.

-- ---------------------------------------------------------------------------
-- Verify (each of these must FAIL for analytics_ro):
--   INSERT INTO "Visit" DEFAULT VALUES;
--   SELECT * FROM "ReportAccessToken";
--   SELECT "passwordHash" FROM "User";
-- And each of these must SUCCEED:
--   SELECT count(*) FROM "Visit";
--   SELECT u."name", count(*) FROM "PaymentTransaction" pt
--     JOIN "User" u ON u.id = pt."collectedByUserId" GROUP BY 1;
-- ---------------------------------------------------------------------------
