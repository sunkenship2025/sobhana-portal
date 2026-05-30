-- Create SigningLabIncharge table
CREATE TABLE "SigningLabIncharge" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "designation" TEXT NOT NULL DEFAULT 'Lab Incharge',
    "signatureImagePath" TEXT,
    "signatureImageBase64" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SigningLabIncharge_pkey" PRIMARY KEY ("id")
);

-- Create index on isActive for SigningLabIncharge
CREATE INDEX "SigningLabIncharge_isActive_idx" ON "SigningLabIncharge"("isActive");

-- Create LabInchargeRule table
CREATE TABLE "LabInchargeRule" (
    "id" TEXT NOT NULL,
    "signingLabInchargeId" TEXT NOT NULL,
    "branchId" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LabInchargeRule_pkey" PRIMARY KEY ("id")
);

-- Create unique index for branchId (null branchId = All Branches, at most one active rule per branch)
CREATE UNIQUE INDEX "LabInchargeRule_branchId_key" ON "LabInchargeRule"("branchId");

-- Create indexes
CREATE INDEX "LabInchargeRule_signingLabInchargeId_idx" ON "LabInchargeRule"("signingLabInchargeId");
CREATE INDEX "LabInchargeRule_branchId_idx" ON "LabInchargeRule"("branchId");

-- Add foreign key constraints
ALTER TABLE "LabInchargeRule" ADD CONSTRAINT "LabInchargeRule_signingLabInchargeId_fkey" 
    FOREIGN KEY ("signingLabInchargeId") REFERENCES "SigningLabIncharge"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "LabInchargeRule" ADD CONSTRAINT "LabInchargeRule_branchId_fkey" 
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE CASCADE ON UPDATE CASCADE;
