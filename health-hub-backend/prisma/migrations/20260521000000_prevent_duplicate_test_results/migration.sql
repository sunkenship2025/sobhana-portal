-- Existing duplicates came from concurrent result-save requests that both
-- deleted the old row before either inserted the replacement. Keep the newest
-- row for each report-version/order/test tuple, then make the invariant
-- explicit at the database level.
WITH ranked AS (
  SELECT
    id,
    ROW_NUMBER() OVER (
      PARTITION BY "reportVersionId", "testOrderId", "testId"
      ORDER BY "createdAt" DESC, id DESC
    ) AS rn
  FROM "TestResult"
)
DELETE FROM "TestResult"
WHERE id IN (
  SELECT id
  FROM ranked
  WHERE rn > 1
);

CREATE UNIQUE INDEX "TestResult_reportVersionId_testOrderId_testId_key"
ON "TestResult"("reportVersionId", "testOrderId", "testId");
