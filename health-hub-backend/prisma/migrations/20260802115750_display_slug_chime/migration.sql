-- Readable per-screen URL slug + per-screen call chime.

ALTER TABLE "DisplayScreen" ADD COLUMN "slug" TEXT;
ALTER TABLE "DisplayScreen" ADD COLUMN "chimeSound" TEXT NOT NULL DEFAULT 'dingdong';

-- Backfill a slug for any screens created before this (fall back to the code).
UPDATE "DisplayScreen" SET "slug" = "code" WHERE "slug" IS NULL;
