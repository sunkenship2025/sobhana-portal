/**
 * Pulse — the metric registry. The ONLY place these expressions exist.
 * Measured: the registry is worth +18 questions on conventions the schema cannot imply
 * (authoritative column, stable date column, cancelled rule, NULL denominators) and ~0 on
 * definitions the schema already implies. Every formula here is one of the former.
 */
export interface Metric {
  k: string; sql: string; tables: string[]; t: string | null; u: 'paise' | 'count' | 'ratio' | 'minutes';
  filt?: string; d: string;
}
/**
 * MONEY IS THE MONEY PAGE'S. These two derived tables are moneyFactsService's definitions written
 * out row by row, so a Pulse figure and the owner's own page can only ever agree — and so either
 * can be scoped to a test, department or modality and still add back up to the headline.
 * pulse-deterministic.ts checks both against the engine; a change to the engine fails it.
 *
 * COLLECTED: cash + online in, every refund out, by transaction date (cheques apart). Each
 * payment is shared across its bill's live tests by price — getCollectedSplits — one row per
 * (payment, live test); a bill with no live test keeps its money whole.
 */
const COLLECTED_ROWS = `(SELECT p0.id, p0."billId", p0."transactionDate", p0."paymentType", p0."transactionType", t.id AS "testOrderId",
    (CASE WHEN p0."transactionType" = 'REFUND' THEN -p0."amountInPaise" ELSE p0."amountInPaise" END)::numeric
      * COALESCE(greatest(t."priceInPaise", 0)::numeric / NULLIF(tot.total, 0), 1) AS amount
  FROM "PaymentTransaction" p0 JOIN "Bill" b0 ON b0.id = p0."billId"
  LEFT JOIN (SELECT "visitId", sum(greatest("priceInPaise", 0))::numeric AS total FROM "TestOrder"
             WHERE "replacedAt" IS NULL AND "cancelledAt" IS NULL GROUP BY 1) tot ON tot."visitId" = b0."visitId"
  LEFT JOIN "TestOrder" t ON t."visitId" = b0."visitId" AND t."replacedAt" IS NULL AND t."cancelledAt" IS NULL AND tot.total > 0
  WHERE (p0."transactionType" = 'PAYMENT' AND p0."paymentType" IN ('CASH', 'ONLINE')) OR p0."transactionType" = 'REFUND')`;
/**
 * COMMISSION: each live test's referral commission exactly as the payout statement computes it —
 * a percentage of price less the test's largest-remainder share of the bill's discount (counter +
 * offer code), floored at 0, or a fixed amount as frozen — plus the partner's cut, by test date;
 * and each clinic consultation's doctor share, by consultation date. liveOrderShares, unwindowed:
 * the shares are per visit, so computing them over every visit gives each test the same share.
 */
const COMMISSION_ROWS = `(WITH o0 AS (
    SELECT t.id, t."visitId", t."branchId", t."createdAt", t."cancelledAt", t."replacedAt",
           greatest(round(t."priceInPaise"), 0)::bigint AS p, t."priceInPaise" AS price,
           t."referralCommissionType"::text AS ty, t."referralCommissionPercentage" AS pct,
           t."referralCommissionAmountInPaise" AS amt, coalesce(t."partnerCutInPaise", 0) AS cut,
           (least(greatest(coalesce(b."discountAmountInPaise", 0), 0), greatest(coalesce(b."totalAmountInPaise", 0), 0))
            + least(greatest(coalesce(b."couponDiscountInPaise", 0), 0),
                    greatest(greatest(coalesce(b."totalAmountInPaise", 0), 0)
                             - least(greatest(coalesce(b."discountAmountInPaise", 0), 0), greatest(coalesce(b."totalAmountInPaise", 0), 0)), 0)))::bigint AS disc
    FROM "TestOrder" t LEFT JOIN "Bill" b ON b."visitId" = t."visitId"),
  live AS (SELECT o0.*, (sum(p) OVER w)::bigint AS total, least(disc, (sum(p) OVER w)::bigint) AS d
           FROM o0 WHERE "replacedAt" IS NULL WINDOW w AS (PARTITION BY "visitId")),
  floored AS (SELECT live.*, CASE WHEN total > 0 THEN (d * p) / total ELSE 0 END AS fl,
                     CASE WHEN total > 0 THEN (d * p) % total ELSE 0 END AS rem FROM live),
  shared AS (SELECT floored.*, fl + CASE WHEN total > 0 AND row_number() OVER (PARTITION BY "visitId" ORDER BY rem DESC, id)
                     <= d - sum(fl) OVER (PARTITION BY "visitId") THEN 1 ELSE 0 END AS share FROM floored)
  SELECT id AS "testOrderId", "visitId", "branchId", "createdAt",
         (CASE WHEN ty = 'FIXED_AMOUNT' THEN greatest(0, round(coalesce(amt, 0)))
               ELSE greatest(0, round((price * coalesce(pct, 0) / 100)::numeric) - share) END + cut)::numeric AS amount
  FROM shared WHERE "cancelledAt" IS NULL
  UNION ALL
  SELECT NULL, cv."visitId", v0."branchId", cv."createdAt",
         (CASE WHEN d0."commissionType" = 'PERCENTAGE' THEN round((cv."consultationFeeInPaise" * coalesce(d0."commissionPercent", 0) / 100)::numeric)
               WHEN d0."commissionType" = 'FIXED_AMOUNT' THEN coalesce(d0."commissionAmountInPaise", 0) ELSE 0 END)::numeric
  FROM "ClinicVisit" cv JOIN "Visit" v0 ON v0.id = cv."visitId" JOIN "ClinicDoctor" d0 ON d0.id = cv."clinicDoctorId")`;

/**
 * What a patient still owes, as one expression — the Money page's: a bill not marked PAID whose
 * balance is above zero. The balance alone overstated nothing but disagreed with the owner's own
 * page by one bill (D-BLN-000979, marked PAID with ₹800 of arithmetic still open); the flag alone
 * counted 48 bills where 10 owed anything. Both conditions, everywhere, so Pulse and the Money
 * page can never show two dues totals.
 */
export const DUE = (b = 'b') =>
  `(${b}."totalAmountInPaise" - ${b}."discountAmountInPaise" - ${b}."couponDiscountInPaise" - ${b}."reversedChargeInPaise" - ${b}."paidAmountInPaise")`;
export const OWES = (b = 'b') => `${b}."paymentStatus" <> 'PAID' AND ${DUE(b)} > 0`;
/** A visit still waiting on its report — the Operations page's definition: a diagnostic visit not
 *  yet complete with a live reportable or outside-lab test not closed as films only. "Late" is
 *  that, registered more than 24 hours ago. Pulse used to count every report without a finalized
 *  version — cancelled, bill-only and no-report tests included — and showed 349 where the
 *  Operations page shows 13. */
export const OPEN_VISIT = (v = 'v') => `${v}.domain = 'DIAGNOSTICS' AND ${v}.status IN ('DRAFT', 'WAITING') AND EXISTS (SELECT 1 FROM "TestOrder" o9 WHERE o9."visitId" = ${v}.id AND o9."cancelledAt" IS NULL AND o9."noReportAt" IS NULL AND o9."workflowMode" IN ('REPORTABLE', 'EXTERNAL_UPLOAD'))`;

export const METRICS: Record<string, Metric> = {
  revenue: { k: 'revenue net income earned turnover sales money made collected cash received collection realised making',
    sql: 'SUM(pt.amount)',
    tables: ['PaymentTransaction', 'Bill', 'TestOrder'], t: 'pt."transactionDate"', u: 'paise',
    d: 'REVENUE = NET COLLECTED, the Money page headline: cash + online received, refunds out, cheques apart. '
       + 'Scoped to a test, department or modality it is that work\'s share of each payment, so the parts add up to the total. '
       + 'This is the answer to "how much did we make / collect / turnover", for the centre or for any kind of work.' },
  net_billed: { k: 'billed invoiced raised bill value gross billing',
    sql: 'SUM(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise")',
    tables: ['Bill', 'Visit'], t: 'b."billedAt"', u: 'paise',
    d: 'Amount BILLED after discount, coupon and voided charges. NOT revenue — revenue is cash collected.' },
  outstanding: { k: 'outstanding due unpaid owed receivable pending payment',
    sql: `SUM(CASE WHEN ${OWES()} THEN ${DUE()} ELSE 0 END)`,
    tables: ['Bill'], t: 'b."billedAt"', u: 'paise', d: 'What patients still owe: the balance on bills not marked PAID, where it is above zero — the Money page figure.' },
  visits: { k: 'visits patients seen footfall volume registrations came', sql: 'COUNT(DISTINCT v.id)',
    tables: ['Visit'], t: 'v."createdAt"', u: 'count', d: 'Registrations. One per visit, NOT per person.' },
  unique_patients: { k: 'unique distinct patients individuals people how many patients', sql: 'COUNT(DISTINCT v."patientId")',
    tables: ['Visit'], t: 'v."createdAt"', u: 'count', d: 'Distinct people, deduped across repeat visits.' },
  test_orders: { k: 'tests workload throughput ordered performed did investigations', sql: 'COUNT(*)',
    tables: ['TestOrder'], t: 'o."createdAt"', u: 'count', filt: 'o."cancelledAt" IS NULL AND o."replacedAt" IS NULL', d: 'Billed test lines, excluding cancelled and replaced.' },
  reports_finalized: { k: 'reports finalized released published issued completed reports', sql: 'COUNT(DISTINCT rv.id)',
    tables: ['ReportVersion', 'DiagnosticReport'], t: 'rv."finalizedAt"', u: 'count', filt: `rv.status='FINALIZED'`,
    d: 'Finalized report versions. Latest per report only.' },
  tat_p50: { k: 'turnaround tat time to report speed how long delay',
    sql: `percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (rv."finalizedAt"-v."createdAt"))/60)`,
    tables: ['ReportVersion', 'DiagnosticReport', 'Visit'], t: 'rv."finalizedAt"', u: 'minutes', filt: `rv.status='FINALIZED'`,
    d: 'Median minutes registration to finalize. SLA 1440.' },
  abnormal_rate: { k: 'abnormal rate percentage flagged out of range high low',
    sql: `COUNT(*) FILTER (WHERE r.flag IN ('HIGH','LOW','CRITICAL_HIGH','CRITICAL_LOW'))::float / NULLIF(COUNT(*) FILTER (WHERE r.flag IS NOT NULL),0)`,
    tables: ['TestResult'], t: null, u: 'ratio', d: 'DENOMINATOR EXCLUDES flag IS NULL (38% of rows).' },
  cancellation_rate: { k: 'cancellation cancelled rate cancel',
    sql: `COUNT(*) FILTER (WHERE o."cancelledAt" IS NOT NULL)::float/NULLIF(COUNT(*),0)`,
    tables: ['TestOrder'], t: 'o."createdAt"', u: 'ratio', d: 'Share of test orders cancelled.' },
  delivery_rate: { k: 'delivery whatsapp delivered rate message failed',
    sql: `COUNT(*) FILTER (WHERE m.status IN ('DELIVERED','READ'))::float/NULLIF(COUNT(*),0)`,
    tables: ['MessageLog'], t: 'm."createdAt"', u: 'ratio', filt: `m.channel='WHATSAPP'`,
    d: 'Share of outbound WhatsApp messages delivered or read. Filter channel=WHATSAPP.' },
  discount_total: { k: 'discount discounts concession rebate given', sql: 'SUM(b."discountAmountInPaise"+b."couponDiscountInPaise")',
    tables: ['Bill'], t: 'b."billedAt"', u: 'paise', d: 'Manual discount + coupon.' },
  refund_total: { k: 'refund refunds refunded money back', sql: 'SUM(orf."amountInPaise")',
    tables: ['OrderRefund'], t: 'orf."createdAt"', u: 'paise', d: 'Money returned to patients.' },
  /* TWO DIFFERENT REAL QUANTITIES, ONE NAME. What a doctor WAS PAID lives in the ledger and is
     scopeable by doctor, branch and period — and by nothing else, because a ledger row carries no
     link to a test order. Commission ATTRIBUTABLE TO WORK is frozen on each order and is scopeable
     by test, category, modality and service kind.
     Collapsed into one metric, "what share of imaging revenue goes out as commission" had no way
     to be asked: the only commission metric refused every imaging filter, so the analyst answered
     "at least 16.4%, and the true share is higher" against a true 21.4%. Naming them apart is the
     whole fix — each is exact within its own scope, and neither pretends to the other's reach. */
  /* THE DENOMINATOR A SCOPED RATIO NEEDS. net_billed is Bill-level and cannot be scoped to a
     test, category or modality — so "commission as a share of imaging revenue" and "revenue per
     imaging scan" had NO deterministic route and fell through to generated SQL every time. The
     same question then answered 21.4% on one run and 18.4% on the next, which is not a figure,
     it is a coin flip. Order-level billing, filterable exactly like test_orders and
     commission_on_orders, so a ratio over work has an exact expression. */
  billed_on_orders: { k: 'billed on orders order value work billed per test per category imaging billed gross of orders list price',
    sql: 'SUM(o."priceInPaise")', filt: 'o."cancelledAt" IS NULL AND o."replacedAt" IS NULL',
    tables: ['TestOrder'], t: 'o."createdAt"', u: 'paise',
    d: 'What the test orders were BILLED at list price, by test date. For questions about billing itself '
       + '("how much has X been billed for"). What the centre MADE is revenue.' },
  commission: { k: 'commission referral amount doctor share payable owed kitna dena partner cut', sql: 'SUM(c.amount)',
    tables: ['TestOrder', 'ClinicVisit'], t: 'c."createdAt"', u: 'paise',
    d: 'The Money page commission: each live test\'s referral commission as the payout statement computes it '
       + '(after the test\'s share of the bill discount) plus the partner\'s cut, plus clinic doctors\' share of '
       + 'consultation fees. Scopes to any test, department, modality, branch or referring doctor. '
       + 'Net to the centre is revenue minus commission.' },
  payouts_paid: { k: 'payout paid statement ledger settled run', sql: 'SUM(pl."derivedAmountInPaise")',
    tables: ['DoctorPayoutLedger'], t: 'pl."periodStartDate"', u: 'paise', filt: 'pl."deletedAt" IS NULL',
    d: 'What payout runs actually recorded for doctors, by statement period. Only for "what did we pay out"; '
       + 'what is owed on the work done is commission.' },
};

/* The FROM goes with the expression: "SUM(pt.amount)" means nothing without the table it sums.
   Defined below; read lazily so a generated query copies the definition rather than guessing it. */
export const METRIC_BLOCK = () => Object.entries(METRICS).map(([n, m]) =>
  `${n} [${m.u}] ${m.d}\n  SELECT ${m.sql} FROM ${FROMS[n]?.[0] ?? '?'}${m.filt ? `\n  filter: ${m.filt}` : ''}${m.t ? `\n  time: ${m.t}` : ''}`).join('\n');

/** Which dimensions each metric can be broken down by — drives the action chips on a card. */
export const METRIC_DIMS: Record<string, string[]> = {
  revenue: ['branch', 'payment_type', 'referring_doctor', 'domain', 'test', 'payout_category', 'modality', 'service_kind', 'workflow_mode', 'weekday'],
  net_billed: ['branch', 'domain', 'referring_doctor'],
  outstanding: ['branch'],
  visits: ['branch', 'domain', 'referring_doctor', 'patient', 'weekday'],
  unique_patients: ['branch', 'domain'],
  test_orders: ['branch', 'test', 'payout_category', 'modality', 'service_kind', 'referring_doctor', 'workflow_mode', 'weekday'],
  reports_finalized: ['branch'],
  tat_p50: ['branch'],
  discount_total: ['branch'],
  refund_total: ['branch'],
  commission: ['branch', 'domain', 'referring_doctor', 'test', 'payout_category', 'modality', 'service_kind', 'workflow_mode', 'weekday'],
  payouts_paid: ['referring_doctor', 'branch'],
  billed_on_orders: ['branch', 'test', 'payout_category', 'modality', 'service_kind', 'referring_doctor', 'workflow_mode', 'weekday'],
};
export const DIM_LABEL: Record<string, string> = {
  branch: 'branch wise', payment_type: 'by payment mode', referring_doctor: 'doctor wise',
  domain: 'diagnostics vs clinic', test: 'by test', payout_category: 'by category',
  modality: 'by modality', service_kind: 'scans vs lab work', workflow_mode: 'by report type',
  weekday: 'by day of the week', patient: 'by patient',
};

/** Deterministic FROM clauses for the diagnostic engine (registry-generated queries). */
export const FROMS: Record<string, [string, string]> = {
  revenue: [`${COLLECTED_ROWS} pt JOIN "Bill" b ON b.id=pt."billId" JOIN "Visit" v ON v.id=b."visitId" JOIN "Branch" br ON br.id=b."branchId" LEFT JOIN "TestOrder" o ON o.id=pt."testOrderId"`, 'pt."transactionDate"'],
  net_billed: ['"Bill" b JOIN "Visit" v ON v.id=b."visitId" JOIN "Branch" br ON br.id=b."branchId"', 'b."billedAt"'],
  outstanding: ['"Bill" b JOIN "Visit" v ON v.id=b."visitId" JOIN "Branch" br ON br.id=b."branchId"', 'b."billedAt"'],
  visits: ['"Visit" v JOIN "Branch" br ON br.id=v."branchId"', 'v."createdAt"'],
  unique_patients: ['"Visit" v JOIN "Branch" br ON br.id=v."branchId"', 'v."createdAt"'],
  test_orders: ['"TestOrder" o JOIN "Visit" v ON v.id=o."visitId" JOIN "Branch" br ON br.id=o."branchId"', 'o."createdAt"'],
  reports_finalized: ['"ReportVersion" rv JOIN "DiagnosticReport" dr ON dr.id=rv."reportId" JOIN "Visit" v ON v.id=dr."visitId" JOIN "Branch" br ON br.id=v."branchId"', 'rv."finalizedAt"'],
  tat_p50: ['"ReportVersion" rv JOIN "DiagnosticReport" dr ON dr.id=rv."reportId" JOIN "Visit" v ON v.id=dr."visitId" JOIN "Branch" br ON br.id=v."branchId"', 'rv."finalizedAt"'],
  discount_total: ['"Bill" b JOIN "Visit" v ON v.id=b."visitId" JOIN "Branch" br ON br.id=b."branchId"', 'b."billedAt"'],
  refund_total: ['"OrderRefund" orf JOIN "Visit" v ON v.id=orf."visitId" JOIN "Branch" br ON br.id=orf."branchId"', 'orf."createdAt"'],
  commission: [`${COMMISSION_ROWS} c JOIN "Visit" v ON v.id=c."visitId" JOIN "Branch" br ON br.id=c."branchId" LEFT JOIN "TestOrder" o ON o.id=c."testOrderId"`, 'c."createdAt"'],
  payouts_paid: ['"DoctorPayoutLedger" pl JOIN "Branch" br ON br.id=pl."branchId"', 'pl."periodStartDate"'],
  billed_on_orders: ['"TestOrder" o JOIN "Visit" v ON v.id=o."visitId" JOIN "Branch" br ON br.id=o."branchId"', 'o."createdAt"'],
  // rate metrics: no Branch join, so no breakdowns — but the formula is still exercised by the self-check
  abnormal_rate: ['"TestResult" r', ''],
  cancellation_rate: ['"TestOrder" o', 'o."createdAt"'],
  delivery_rate: ['"MessageLog" m', 'm."createdAt"'],
};
/** Branches left out of every Pulse figure — EMPTY, because the dashboard and the Money page count
 *  every branch and Pulse must agree with them. On 11 Sep 2026 the owner said the two Kidcare
 *  branches (JGG, IDPL) were test-only; by then they had collected ₹32k in August and went on to
 *  ₹29k in September, all of it on the dashboard. If they are test entries, put 'JGG','IDPL' back
 *  here AND take them out of the money engine, or the two will disagree again. */
export const TEST_BRANCHES: string[] = [];
export const TEST_BRANCH_NAMES: string[] = [];
export const isTestBranch = (v: any) => {
  const t = String(v ?? '').trim();
  return TEST_BRANCHES.includes(t) || TEST_BRANCH_NAMES.includes(t);
};


export const DIMS: Record<string, string> = {
  branch: 'br.code',
  domain: 'v.domain::text',
  payout_category: `COALESCE(o."payoutCategorySnapshot",'(none)')`,
  // The raw payout categories split one modality across several rows — 'Ultrasound' and
  // 'Ultrasound Tiffa' and '2D Echo' are all ultrasound, an echo being a cardiac one. Asked
  // "how many ultrasound scans", a single-value filter on the raw column silently answers a
  // third of the question. These two roll them up so a set can be filtered with one value.
  modality: `CASE
      WHEN o."payoutCategorySnapshot" IN ('Ultrasound','Ultrasound Tiffa','2D Echo') THEN 'Ultrasound'
      WHEN o."payoutCategorySnapshot" IN ('X-Ray','Dental X-Ray') THEN 'X-Ray'
      WHEN o."payoutCategorySnapshot" = 'CT / MRI' THEN 'CT / MRI'
      WHEN o."payoutCategorySnapshot" = 'ECG / Cardiology' THEN 'ECG / Cardiology'
      WHEN o."payoutCategorySnapshot" = 'Laboratory' THEN 'Laboratory'
      ELSE '(uncategorised)' END`,
  service_kind: `CASE
      WHEN o."payoutCategorySnapshot" IN ('Ultrasound','Ultrasound Tiffa','2D Echo','X-Ray','Dental X-Ray','CT / MRI') THEN 'IMAGING'
      WHEN o."payoutCategorySnapshot" = 'Laboratory' THEN 'LABORATORY'
      ELSE '(uncategorised)' END`,
  test: 'o."testCodeSnapshot"',
  workflow_mode: 'o."workflowMode"::text',
  // {t} is the metric's own date column, substituted by dimSql — Friday's collection and Friday's
  // tests are read off different columns
  weekday: `trim(to_char({t} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata', 'Day'))`,
  patient: `pa.name || ' (' || pa."patientNumber" || ')'`,
  referring_doctor: `COALESCE(rd.name,'(none)')`,
  payment_type: 'pt."paymentType"::text',
};
export const DIMJOIN: Record<string, string> = {
  patient: ' JOIN "Patient" pa ON pa.id=v."patientId"',
  referring_doctor: ' LEFT JOIN "ReferralDoctor_Visit" rdv ON rdv."visitId"=v.id AND rdv."deletedAt" IS NULL LEFT JOIN "ReferralDoctor" rd ON rd.id=rdv."referralDoctorId"',
};
/** Some metrics reach a dimension by a different path. commission already carries the doctor id. */
export const DIMJOIN_FOR: Record<string, Record<string, string>> = {
  payouts_paid: { referring_doctor: ' LEFT JOIN "ReferralDoctor" rd ON rd.id=pl."referralDoctorId"' },
};
export const dimJoin = (metric: string, dim: string) => DIMJOIN_FOR[metric]?.[dim] ?? DIMJOIN[dim] ?? '';
export function dimOk(metric: string, dim: string): boolean {
  if (DIMJOIN_FOR[metric]?.[dim]) return true;
  const from = FROMS[metric]?.[0] || '';
  if (dim === 'payout_category' || dim === 'test' || dim === 'modality' || dim === 'service_kind' || dim === 'workflow_mode') return /"TestOrder"/.test(from);
  if (dim === 'weekday') return !!FROMS[metric]?.[1];
  if (dim === 'patient') return /"Visit"/.test(from);
  if (dim === 'payment_type') return /"PaymentTransaction"/.test(from);
  if (dim === 'domain' || dim === 'referring_doctor') return /"Visit"/.test(from);
  return /"Branch"/.test(from);
}

/** A dimension's SQL for one metric — the weekday is read off that metric's own date column. */
export const dimSql = (metric: string, dim: string) => (DIMS[dim] || '').replace('{t}', FROMS[metric]?.[1] || 'NULL');
