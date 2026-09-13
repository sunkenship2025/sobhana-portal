// BENCHMARK v5 — THE CEILING SET.  Written for one purpose: to FAIL.
// The previous suites all sit at 88-100%, which means they have stopped measuring anything.
// Every question here is in a reasoning class the architecture has NEVER been shown:
// window functions, cohort/retention, distributions, anti-joins, self-joins, zero-fill
// calendars, fan-out traps, version-latest semantics, durations and NULL semantics.
// FROZEN: written before any run, scored once, never tuned.
const IST=`AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'`;
const AUG=c=>`(${c} ${IST}) >= '2026-08-01' AND (${c} ${IST}) < '2026-09-01'`;
const JUL=c=>`(${c} ${IST}) >= '2026-07-01' AND (${c} ${IST}) < '2026-08-01'`;
const NET=`(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise")`;
const COLL=`CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" ELSE pt."amountInPaise" END`;
const PB=`"PaymentTransaction" pt JOIN "Bill" b ON b.id=pt."billId"`;

export const CEIL=[
// ── WINDOW / period-over-period inside one query ────────────────────────────
{id:'W01',cat:'window',attack:'two periods pivoted per branch',
 q:'For each branch, how much did we collect in August 2026 and how much in July 2026?',
 sql:`SELECT b."branchId",
   COALESCE(SUM(${COLL}) FILTER (WHERE ${AUG('pt."transactionDate"')}),0)::bigint aug,
   COALESCE(SUM(${COLL}) FILTER (WHERE ${JUL('pt."transactionDate"')}),0)::bigint jul
   FROM ${PB} WHERE (pt."transactionDate" ${IST}) >= '2026-07-01' AND (pt."transactionDate" ${IST}) < '2026-09-01'
   GROUP BY 1 ORDER BY 1`},
{id:'W02',cat:'window',attack:'argmax over a grouped aggregate',
 q:'Which single day in August 2026 had the highest total collection, and how much was collected that day?',
 sql:`SELECT (pt."transactionDate" ${IST})::date d, SUM(${COLL})::bigint n FROM "PaymentTransaction" pt
   WHERE ${AUG('pt."transactionDate"')} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`},
{id:'W03',cat:'window',attack:'running total then threshold crossing',
 q:'On which day of the month did cumulative collections during August 2026 first pass half of the whole month’s total? Give the day number.',
 sql:`WITH d AS (SELECT (pt."transactionDate" ${IST})::date dt, SUM(${COLL}) s FROM "PaymentTransaction" pt
     WHERE ${AUG('pt."transactionDate"')} GROUP BY 1),
   r AS (SELECT dt, SUM(s) OVER (ORDER BY dt) c, (SELECT SUM(s) FROM d) tot FROM d)
   SELECT EXTRACT(day FROM dt)::int n FROM r WHERE c >= tot/2.0 ORDER BY dt LIMIT 1`},
{id:'W04',cat:'window',attack:'share of a whole computed inside the query',
 q:'For each branch, what percentage of all August 2026 collections did that branch account for?',
 sql:`SELECT b."branchId", ROUND(100.0*SUM(${COLL})/SUM(SUM(${COLL})) OVER (),2) pct
   FROM ${PB} WHERE ${AUG('pt."transactionDate"')} GROUP BY 1 ORDER BY 1`},
{id:'W05',cat:'window',attack:'top-N WITHIN each group (needs row_number)',
 q:'In August 2026, who were the two referring doctors with the most referrals in each branch, and how many referrals did each send?',
 sql:`SELECT t."branchId", t."referralDoctorId", t.n FROM (SELECT r."branchId", r."referralDoctorId", count(*)::int n,
     row_number() OVER (PARTITION BY r."branchId" ORDER BY count(*) DESC, r."referralDoctorId") rk
   FROM "ReferralDoctor_Visit" r WHERE r."deletedAt" IS NULL AND ${AUG('r."createdAt"')}
   GROUP BY 1,2) t WHERE t.rk<=2 ORDER BY t."branchId", t.rk`},

// ── COHORT / RETENTION — set membership across two periods ──────────────────
{id:'C01',cat:'cohort',attack:'intersection of two period cohorts',
 q:'How many patients who had a visit in July 2026 also came back for a visit in August 2026?',
 sql:`SELECT count(*)::int n FROM (
   SELECT v."patientId" FROM "Visit" v WHERE ${JUL('v."createdAt"')} GROUP BY 1
   INTERSECT
   SELECT v."patientId" FROM "Visit" v WHERE ${AUG('v."createdAt"')} GROUP BY 1) t`},
{id:'C02',cat:'cohort',attack:'brand-new vs returning, as a share',
 q:'What percentage of August 2026 visits were by patients who had never visited before August 2026?',
 sql:`SELECT ROUND(100.0*COUNT(*) FILTER (WHERE NOT EXISTS (
     SELECT 1 FROM "Visit" p WHERE p."patientId"=v."patientId" AND (p."createdAt" ${IST}) < '2026-08-01'))
   /NULLIF(COUNT(*),0),2) pct FROM "Visit" v WHERE ${AUG('v."createdAt"')}`},
{id:'C03',cat:'cohort',attack:'first-visit cohort + relative window',
 q:'Of the patients whose first ever visit was in June 2026, how many came back again within 60 days of that first visit?',
 sql:`WITH f AS (SELECT v."patientId" pid, MIN(v."createdAt" ${IST}) fv FROM "Visit" v GROUP BY 1)
   SELECT count(*)::int n FROM f WHERE fv >= '2026-06-01' AND fv < '2026-07-01'
   AND EXISTS (SELECT 1 FROM "Visit" v2 WHERE v2."patientId"=f.pid
     AND (v2."createdAt" ${IST}) > f.fv AND (v2."createdAt" ${IST}) <= f.fv + interval '60 days')`},

// ── DISTRIBUTION — not an average ───────────────────────────────────────────
{id:'D01',cat:'distribution',attack:'median, not mean',
 q:'What was the median net bill value in August 2026?',
 sql:`SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ${NET}) m FROM "Bill" b WHERE ${AUG('b."billedAt"')}`},
{id:'D02',cat:'distribution',attack:'p90 of a derived duration',
 q:'For test orders created in August 2026, what is the 90th percentile turnaround time in hours from order to a finalized result?',
 sql:`WITH x AS (SELECT o.id, MIN(o."createdAt") c, MIN(rv."finalizedAt") f
     FROM "TestOrder" o JOIN "TestResult" tr ON tr."testOrderId"=o.id
     JOIN "ReportVersion" rv ON rv.id=tr."reportVersionId" AND rv.status='FINALIZED'
     WHERE ${AUG('o."createdAt"')} AND o."cancelledAt" IS NULL GROUP BY 1)
   SELECT ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (f-c))/3600.0)::numeric,2) p90 FROM x`},
{id:'D03',cat:'distribution',attack:'share below a threshold',
 q:'What share of August 2026 bills were under ₹500 net?',
 sql:`SELECT ROUND(100.0*COUNT(*) FILTER (WHERE ${NET} < 50000)/NULLIF(COUNT(*),0),2) pct
   FROM "Bill" b WHERE ${AUG('b."billedAt"')}`},

// ── ANTI-JOIN — absence, "never", "stopped" ─────────────────────────────────
{id:'N01',cat:'antijoin',attack:'referred last month, silent this month',
 q:'How many referring doctors sent us at least one referral in July 2026 but none at all in August 2026?',
 sql:`SELECT count(*)::int n FROM (
   SELECT r."referralDoctorId" FROM "ReferralDoctor_Visit" r WHERE r."deletedAt" IS NULL AND ${JUL('r."createdAt"')} GROUP BY 1
   EXCEPT
   SELECT r."referralDoctorId" FROM "ReferralDoctor_Visit" r WHERE r."deletedAt" IS NULL AND ${AUG('r."createdAt"')} GROUP BY 1) t`},
{id:'N02',cat:'antijoin',attack:'catalogue rows with zero facts',
 q:'How many active tests in our catalogue have never once been ordered?',
 sql:`SELECT count(*)::int n FROM "TestDefinition" td WHERE td."isLatest"=true AND td.status='ACTIVE'
   AND NOT EXISTS (SELECT 1 FROM "TestOrder" o WHERE o."testDefinitionId"=td.id)`},
{id:'N03',cat:'antijoin',attack:'two-hop absence',
 q:'How many patients registered during 2026 have never had a bill raised for them?',
 sql:`SELECT count(*)::int n FROM "Patient" p
   WHERE (p."createdAt" ${IST}) >= '2026-01-01' AND (p."createdAt" ${IST}) < '2027-01-01'
   AND NOT EXISTS (SELECT 1 FROM "Visit" v JOIN "Bill" b ON b."visitId"=v.id WHERE v."patientId"=p.id)`},

// ── SELF-JOIN / multi-membership ────────────────────────────────────────────
{id:'S01',cat:'selfjoin',attack:'same entity twice on different visits',
 q:'How many patients have had the same test ordered on more than one separate visit?',
 sql:`SELECT count(DISTINCT t.pid)::int n FROM (
   SELECT v."patientId" pid, o."testDefinitionId" td FROM "TestOrder" o JOIN "Visit" v ON v.id=o."visitId"
   WHERE o."cancelledAt" IS NULL AND o."testDefinitionId" IS NOT NULL
   GROUP BY 1,2 HAVING count(DISTINCT o."visitId") > 1) t`},
{id:'S02',cat:'selfjoin',attack:'distinct-count inside HAVING across a join',
 q:'How many visits in August 2026 included tests from more than one department?',
 sql:`SELECT count(*)::int n FROM (
   SELECT o."visitId" FROM "TestOrder" o JOIN "TestDefinition" td ON td.id=o."testDefinitionId"
   WHERE o."cancelledAt" IS NULL AND ${AUG('o."createdAt"')} AND td."departmentId" IS NOT NULL
   GROUP BY 1 HAVING count(DISTINCT td."departmentId") > 1) t`},

// ── ZERO-FILL — days that produced no rows at all ───────────────────────────
{id:'Z01',cat:'zerofill',attack:'absent days must be generated, not grouped',
 q:'How many days in August 2026 had no visits at all?',
 sql:`SELECT count(*)::int n FROM generate_series('2026-08-01'::date,'2026-08-31'::date,'1 day') d
   WHERE NOT EXISTS (SELECT 1 FROM "Visit" v WHERE (v."createdAt" ${IST})::date = d::date)`},
{id:'Z02',cat:'zerofill',attack:'calendar x dimension cross join',
 q:'Counting every branch and every day of August 2026, on how many branch-days was nothing collected?',
 sql:`SELECT count(*)::int n FROM generate_series('2026-08-01'::date,'2026-08-31'::date,'1 day') d
   CROSS JOIN "Branch" br WHERE NOT EXISTS (SELECT 1 FROM ${PB}
     WHERE b."branchId"=br.id AND (pt."transactionDate" ${IST})::date = d::date)`},

// ── FAN-OUT TRAPS — the naive join double counts ────────────────────────────
{id:'F01',cat:'fanout',attack:'order value by department, not bill totals',
 q:'What was the total value of tests ordered in August 2026, broken down by department?',
 sql:`SELECT COALESCE(td."departmentId",'(none)') k, SUM(o."priceInPaise")::bigint n FROM "TestOrder" o
   LEFT JOIN "TestDefinition" td ON td.id=o."testDefinitionId"
   WHERE o."cancelledAt" IS NULL AND ${AUG('o."createdAt"')} GROUP BY 1 ORDER BY 2 DESC`},
{id:'F02',cat:'fanout',attack:'multi-row child must become EXISTS, not JOIN',
 q:'How much money was collected in August 2026 on visits that came through a referring doctor?',
 sql:`SELECT COALESCE(SUM(${COLL}),0)::bigint n FROM ${PB}
   WHERE ${AUG('pt."transactionDate"')} AND EXISTS (SELECT 1 FROM "ReferralDoctor_Visit" r
     WHERE r."visitId"=b."visitId" AND r."deletedAt" IS NULL)`},
{id:'F03',cat:'fanout',attack:'average per parent including parents with none',
 q:'On average, how many tests were on a diagnostics visit in August 2026?',
 sql:`SELECT ROUND(AVG(c),2) n FROM (SELECT v.id, count(o.id) FILTER (WHERE o."cancelledAt" IS NULL) c
   FROM "Visit" v LEFT JOIN "TestOrder" o ON o."visitId"=v.id
   WHERE v.domain='DIAGNOSTICS' AND ${AUG('v."createdAt"')} GROUP BY 1) t`},

// ── VERSIONED ENTITY — latest-version-only semantics ────────────────────────
{id:'L01',cat:'latest',attack:'status of the LATEST version, not any version',
 q:'How many diagnostic reports are finalized right now, counting only each report’s latest version?',
 sql:`SELECT count(*)::int n FROM (SELECT DISTINCT ON (rv."reportId") rv."reportId", rv.status
   FROM "ReportVersion" rv ORDER BY rv."reportId", rv."versionNum" DESC) t WHERE t.status='FINALIZED'`},
{id:'L02',cat:'latest',attack:'amended after finalization',
 q:'How many reports have had a new version created after they were first finalized?',
 sql:`SELECT count(*)::int n FROM (SELECT rv."reportId",
     MIN(rv."finalizedAt") FILTER (WHERE rv.status='FINALIZED') f, MAX(rv."createdAt") mc
   FROM "ReportVersion" rv GROUP BY 1) t WHERE t.f IS NOT NULL AND t.mc > t.f`},

// ── TIME IN STATE — duration between two events on different tables ─────────
{id:'T01',cat:'duration',attack:'avg hours across a 3-table chain',
 q:'For visits created in August 2026, what is the average number of hours from visit creation to the report being finalized?',
 sql:`SELECT ROUND(AVG(EXTRACT(EPOCH FROM (x.f - v."createdAt"))/3600.0)::numeric,2) n
   FROM "Visit" v JOIN "DiagnosticReport" dr ON dr."visitId"=v.id
   JOIN LATERAL (SELECT MIN(rv."finalizedAt") f FROM "ReportVersion" rv
     WHERE rv."reportId"=dr.id AND rv.status='FINALIZED') x ON TRUE
   WHERE ${AUG('v."createdAt"')} AND x.f IS NOT NULL`},
{id:'T02',cat:'duration',attack:'count over a duration threshold',
 q:'How many visits created in August 2026 took more than 24 hours to have their report finalized?',
 sql:`SELECT count(*)::int n FROM "Visit" v JOIN "DiagnosticReport" dr ON dr."visitId"=v.id
   JOIN LATERAL (SELECT MIN(rv."finalizedAt") f FROM "ReportVersion" rv
     WHERE rv."reportId"=dr.id AND rv.status='FINALIZED') x ON TRUE
   WHERE ${AUG('v."createdAt"')} AND x.f IS NOT NULL AND x.f - v."createdAt" > interval '24 hours'`},

// ── NULL SEMANTICS ──────────────────────────────────────────────────────────
{id:'U01',cat:'nulls',attack:'IS NULL on an optional FK',
 q:'How many live test orders are not linked to any test definition?',
 sql:`SELECT count(*)::int n FROM "TestOrder" o WHERE o."cancelledAt" IS NULL AND o."testDefinitionId" IS NULL`},
{id:'U02',cat:'nulls',attack:'parent with zero children, not parent with zero sum',
 q:'How many bills raised in August 2026 have had no payment transaction recorded against them at all?',
 sql:`SELECT count(*)::int n FROM "Bill" b WHERE ${AUG('b."billedAt"')}
   AND NOT EXISTS (SELECT 1 FROM "PaymentTransaction" pt WHERE pt."billId"=b.id)`},

// ── MULTI-HOP — 4+ tables ───────────────────────────────────────────────────
{id:'M01',cat:'multihop',attack:'order -> definition -> department, argmax',
 q:'Which department brought in the most order value in August 2026, and how much?',
 sql:`SELECT d.name, SUM(o."priceInPaise")::bigint n FROM "TestOrder" o
   JOIN "TestDefinition" td ON td.id=o."testDefinitionId" JOIN "Department" d ON d.id=td."departmentId"
   WHERE o."cancelledAt" IS NULL AND ${AUG('o."createdAt"')} GROUP BY 1 ORDER BY 2 DESC LIMIT 1`},
{id:'M02',cat:'multihop',attack:'payment -> bill -> visit -> patient, derived age',
 q:'How much money did we collect in August 2026 from patients aged 60 or over?',
 sql:`SELECT COALESCE(SUM(${COLL}),0)::bigint n FROM ${PB}
   JOIN "Visit" v ON v.id=b."visitId" JOIN "Patient" p ON p.id=v."patientId"
   WHERE ${AUG('pt."transactionDate"')} AND (2026 - p."yearOfBirth") >= 60`},
{id:'M03',cat:'multihop',attack:'result -> version -> report -> branch',
 q:'How many critical results were recorded in August 2026, by branch?',
 sql:`SELECT dr."branchId", count(*)::int n FROM "TestResult" tr
   JOIN "ReportVersion" rv ON rv.id=tr."reportVersionId" JOIN "DiagnosticReport" dr ON dr.id=rv."reportId"
   WHERE tr.flag IN ('CRITICAL_HIGH','CRITICAL_LOW') AND ${AUG('tr."createdAt"')} GROUP BY 1 ORDER BY 1`},

// ── ORDERING / FILTERED SHARE ───────────────────────────────────────────────
{id:'X01',cat:'ordering',attack:'top-3 with a deterministic tie-break',
 q:'What were the three most frequently ordered tests in August 2026, and how many times was each ordered?',
 sql:`SELECT o."testNameSnapshot" nm, count(*)::int n FROM "TestOrder" o
   WHERE o."cancelledAt" IS NULL AND ${AUG('o."createdAt"')} GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 3`},
{id:'X02',cat:'ordering',attack:'share of a filtered subset of the same metric',
 q:'Of all the money collected in August 2026, what percentage came in as cash?',
 sql:`SELECT ROUND(100.0*SUM(${COLL}) FILTER (WHERE pt."paymentType"='CASH')/NULLIF(SUM(${COLL}),0),2) pct
   FROM "PaymentTransaction" pt WHERE ${AUG('pt."transactionDate"')}`},
];
