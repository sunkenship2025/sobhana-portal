-- Per-screen playback (hold + track QR) and per-screen ad targeting.

ALTER TABLE "DisplayScreen" ADD COLUMN "holdSeconds" INTEGER NOT NULL DEFAULT 18;
ALTER TABLE "DisplayScreen" ADD COLUMN "showTrackQr" BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE "DisplayAd" ADD COLUMN "screenIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
