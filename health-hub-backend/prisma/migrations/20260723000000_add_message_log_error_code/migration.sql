-- MessageLog: store the Meta WhatsApp error code separately from the free-text
-- reason, so failures can be classified/aggregated (and later routed to a
-- retry/SMS-fallback layer) instead of only string-matched. Additive + nullable,
-- so no backfill and no table rewrite — historical rows keep errorCode = NULL.
ALTER TABLE "MessageLog" ADD COLUMN "errorCode" TEXT;
