-- Org-wide key/value settings (not branch-scoped). First use: the cloud-sync
-- default for narrative/text reports, which the lab incharge can set "for all".
-- Additive new table → safe on the live database, no backfill, no lock on
-- existing tables.
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);
