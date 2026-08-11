-- Presence heartbeat for waiting-room TVs: refreshed while a screen holds the
-- SSE stream open. online = lastSeenAt within ~60s.
ALTER TABLE "DisplayScreen" ADD COLUMN "lastSeenAt" TIMESTAMP(3);
