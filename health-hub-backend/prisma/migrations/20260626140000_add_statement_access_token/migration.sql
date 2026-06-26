-- Token-gated public access to payout statements (WhatsApp links), plus allowing
-- MessageLog rows with no patient (payout statements go to doctors/labs, not patients).

-- 1. MessageLog.patientId becomes nullable (FK stays valid for nullable columns)
ALTER TABLE "MessageLog" ALTER COLUMN "patientId" DROP NOT NULL;

-- 2. StatementAccessToken (mirrors BillAccessToken)
CREATE TABLE "StatementAccessToken" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "payoutId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "accessCount" INTEGER NOT NULL DEFAULT 0,
  "lastAccessedAt" TIMESTAMP(3),
  "lastAccessedIp" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StatementAccessToken_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StatementAccessToken_token_key" ON "StatementAccessToken"("token");
CREATE INDEX "StatementAccessToken_payoutId_idx" ON "StatementAccessToken"("payoutId");
CREATE INDEX "StatementAccessToken_expiresAt_idx" ON "StatementAccessToken"("expiresAt");
ALTER TABLE "StatementAccessToken" ADD CONSTRAINT "StatementAccessToken_payoutId_fkey" FOREIGN KEY ("payoutId") REFERENCES "DoctorPayoutLedger"("id") ON DELETE CASCADE ON UPDATE CASCADE;
