-- Patients whose abnormal results have NOT since normalized, rolled up to the
-- PANEL they got the abnormal in (one row per patient; each panel listed once).
--
-- Panel resolution per abnormal analyte:  TestOrder.panelId -> ClinicalPanel.displayName
--   fallback -> BillableProduct.name  -> TestOrder.testNameSnapshot
-- STRING_AGG(DISTINCT ...) collapses "CBP, CBP" and multi-analyte panels to one label.
SELECT
    p.id,
    p.name  AS patient_name,
    pi.value AS phone_number,
    STRING_AGG(
        DISTINCT COALESCE(cp."displayName", bp.name, tord."testNameSnapshot"),
        ', '
    ) AS abnormal_panels
FROM "TestResult" tr
JOIN "TestOrder"      tord ON tr."testOrderId"      = tord.id
JOIN "Visit"         v    ON tord."visitId"         = v.id
JOIN "Patient"       p    ON v."patientId"          = p.id
LEFT JOIN "ClinicalPanel"   cp ON cp.id = tord."panelId"
LEFT JOIN "BillableProduct" bp ON bp.id = tord."productId"
LEFT JOIN "PatientIdentifier" pi
       ON p.id = pi."patientId"
      AND pi.type = 'PHONE'
      AND pi."isPrimary" = true
WHERE tr.flag IN ('HIGH', 'LOW', 'CRITICAL_HIGH', 'CRITICAL_LOW')
  AND NOT EXISTS (                    -- exclude analytes that later came back normal
      SELECT 1
      FROM "TestResult" tr2
      JOIN "TestOrder" tord2 ON tr2."testOrderId" = tord2.id
      JOIN "Visit"     v2    ON tord2."visitId"    = v2.id
      WHERE v2."patientId"          = v."patientId"
        AND tr2."testDefinitionId"  = tr."testDefinitionId"
        AND tr2."createdAt"         > tr."createdAt"
        AND tr2.flag NOT IN ('HIGH', 'LOW', 'CRITICAL_HIGH', 'CRITICAL_LOW')
  )
GROUP BY p.id, p.name, pi.value
ORDER BY p.name;
-- Optional recency bound (avoid messaging year-old results): add before GROUP BY
--   AND tr."createdAt" >= now() - interval '90 days'
