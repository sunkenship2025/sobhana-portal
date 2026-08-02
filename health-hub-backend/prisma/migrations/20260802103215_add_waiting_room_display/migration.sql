-- Waiting-room TV display: OP queue token, optional doctor room, paired screens.

-- AlterTable: optional room/cabin shown on the display (blank = hidden)
ALTER TABLE "ClinicDoctor" ADD COLUMN "roomLabel" TEXT;

-- AlterTable: daily-reset OP queue token (null for IP)
ALTER TABLE "ClinicVisit" ADD COLUMN "tokenNumber" INTEGER;

-- CreateTable: a physical waiting-room TV paired to a branch
CREATE TABLE "DisplayScreen" (
    "id" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'OP',
    "doctorIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DisplayScreen_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DisplayScreen_code_key" ON "DisplayScreen"("code");

-- CreateIndex
CREATE INDEX "DisplayScreen_branchId_idx" ON "DisplayScreen"("branchId");

-- AddForeignKey
ALTER TABLE "DisplayScreen" ADD CONSTRAINT "DisplayScreen_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
