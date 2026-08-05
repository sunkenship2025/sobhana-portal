-- CreateTable
CREATE TABLE "LinkAccessLog" (
    "id" TEXT NOT NULL,
    "linkType" TEXT NOT NULL,
    "linkToken" TEXT NOT NULL,
    "contextId" TEXT,
    "ipAddress" TEXT,
    "userAgentRaw" TEXT,
    "deviceModel" TEXT,
    "deviceVendor" TEXT,
    "osName" TEXT,
    "osVersion" TEXT,
    "browserName" TEXT,
    "browserVersion" TEXT,
    "referrer" TEXT,
    "acceptLanguage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LinkAccessLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinkAccessLog_linkType_createdAt_idx" ON "LinkAccessLog"("linkType", "createdAt");

-- CreateIndex
CREATE INDEX "LinkAccessLog_linkToken_idx" ON "LinkAccessLog"("linkToken");

-- CreateIndex
CREATE INDEX "LinkAccessLog_contextId_idx" ON "LinkAccessLog"("contextId");

-- CreateIndex
CREATE INDEX "LinkAccessLog_createdAt_idx" ON "LinkAccessLog"("createdAt");
