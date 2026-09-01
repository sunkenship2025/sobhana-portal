-- Rows that describe the SAMPLE rather than the patient must not be scored.
-- Urine volume was being reported to a patient as "Very high", which says
-- something is wrong with them when nothing is.
ALTER TABLE "SmartReportConfig"
  ADD COLUMN "excludedTestCodes" TEXT[] NOT NULL DEFAULT ARRAY['CUE_QTY','CUE_COL','CUE_APP','CUE_RXN','CUE_SG']::TEXT[];
