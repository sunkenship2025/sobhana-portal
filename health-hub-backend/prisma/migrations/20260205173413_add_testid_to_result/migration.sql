-- Step 1: Add column as nullable
ALTER TABLE "TestResult" ADD COLUMN "testId" TEXT;

-- Step 2: Populate testId from TestOrder.testId for existing results
UPDATE "TestResult" SET "testId" = (
  SELECT "testId" FROM "TestOrder" WHERE "TestOrder"."id" = "TestResult"."testOrderId"
);

-- Step 3: Make column NOT NULL
ALTER TABLE "TestResult" ALTER COLUMN "testId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "TestResult_testId_idx" ON "TestResult"("testId");

-- AddForeignKey
ALTER TABLE "TestResult" ADD CONSTRAINT "TestResult_testId_fkey" FOREIGN KEY ("testId") REFERENCES "LabTest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
