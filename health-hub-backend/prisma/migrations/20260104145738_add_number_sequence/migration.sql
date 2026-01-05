-- CreateTable
CREATE TABLE "NumberSequence" (
    "id" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastValue" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NumberSequence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NumberSequence_prefix_idx" ON "NumberSequence"("prefix");
