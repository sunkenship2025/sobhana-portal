-- Day sheet bearer link. Split into its own migration because
-- 20260911100000_automated_messages had already been applied in production
-- when this table was added — an applied migration must never be edited.

-- Bearer link to one night's sheet. Mirrors BillAccessToken/ReportAccessToken:
-- only the SHA-256 hash is stored, never the token itself.
CREATE TABLE "DaySheetAccessToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "sheetDate" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "accessCount" INTEGER NOT NULL DEFAULT 0,
    "lastAccessedAt" TIMESTAMP(3),
    "lastAccessedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DaySheetAccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DaySheetAccessToken_token_key" ON "DaySheetAccessToken"("token");
CREATE INDEX "DaySheetAccessToken_branchId_sheetDate_idx" ON "DaySheetAccessToken"("branchId", "sheetDate");
CREATE INDEX "DaySheetAccessToken_expiresAt_idx" ON "DaySheetAccessToken"("expiresAt");
