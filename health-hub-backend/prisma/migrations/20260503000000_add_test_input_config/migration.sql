-- CreateEnum
CREATE TYPE "TestInputType" AS ENUM ('NUMERIC', 'FREE_TEXT', 'TEXT_WITH_PRESETS', 'SELECT_ONLY');

-- CreateTable
CREATE TABLE "TestInputConfig" (
    "rootDefinitionId" TEXT NOT NULL,
    "inputType" "TestInputType" NOT NULL DEFAULT 'NUMERIC',
    "defaultValue" TEXT,
    "valueOptions" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TestInputConfig_pkey" PRIMARY KEY ("rootDefinitionId")
);
