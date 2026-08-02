-- Waiting-room ad creatives (photo / video / slideshow), media stored in R2.

CREATE TABLE "DisplayAd" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'IMAGE',
    "mediaKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mimeTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "fit" TEXT NOT NULL DEFAULT 'cover',
    "durationSec" INTEGER NOT NULL DEFAULT 10,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisplayAd_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DisplayAd_branchId_idx" ON "DisplayAd"("branchId");

-- AddForeignKey
ALTER TABLE "DisplayAd" ADD CONSTRAINT "DisplayAd_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
