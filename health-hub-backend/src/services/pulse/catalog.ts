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
export const METRICS: Record<string, Metric> = {
  revenue: { k: 'revenue net income earned turnover sales money made collected cash received collection realised',
    sql: `SUM(CASE WHEN pt."transactionType"='REFUND' THEN -pt."amountInPaise" ELSE pt."amountInPaise" END)`,
    tables: ['PaymentTransaction', 'Bill'], t: 'pt."transactionDate"', u: 'paise',
    d: 'REVENUE = NET COLLECTED. Cash actually received in the period, refunds netted out. This is the house definition of revenue — do NOT use billed amounts for "revenue".' },
  net_billed: { k: 'billed invoiced raised bill value gross billing',
    sql: 'SUM(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise")',
    tables: ['Bill', 'Visit'], t: 'b."billedAt"', u: 'paise',
    d: 'Amount BILLED after discount, coupon and voided charges. NOT revenue — revenue is cash collected.' },
  outstanding: { k: 'outstanding due unpaid owed receivable pending payment',
    sql: 'SUM(b."totalAmountInPaise"-b."discountAmountInPaise"-b."couponDiscountInPaise"-b."reversedChargeInPaise"-b."paidAmountInPaise")',
    tables: ['Bill'], t: 'b."billedAt"', u: 'paise', d: 'Net billed minus paid, on open bills.' },
  visits: { k: 'visits patients seen footfall volume registrations came', sql: 'COUNT(DISTINCT v.id)',
    tables: ['Visit'], t: 'v."createdAt"', u: 'count', d: 'Registrations. One per visit, NOT per person.' },
  unique_patients: { k: 'unique distinct patients individuals people how many patients', sql: 'COUNT(DISTINCT v."patientId")',
    tables: ['Visit'], t: 'v."createdAt"', u: 'count', d: 'Distinct people, deduped across repeat visits.' },
  test_orders: { k: 'tests workload throughput ordered performed did investigations', sql: 'COUNT(*)',
    tables: ['TestOrder'], t: 'o."createdAt"', u: 'count', filt: 'o."cancelledAt" IS NULL', d: 'Billed test lines, excluding cancelled.' },
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
  commission: { k: 'commission payout doctor owed payable', sql: 'SUM(pl."derivedAmountInPaise")',
    tables: ['DoctorPayoutLedger'], t: 'pl."periodStartDate"', u: 'paise', filt: 'pl."deletedAt" IS NULL',
    d: 'Derived doctor commission. SOFT DELETE guarded.' },
};

export const METRIC_BLOCK = Object.entries(METRICS).map(([n, m]) =>
  `${n} [${m.u}] ${m.d}\n  expr: ${m.sql}${m.filt ? `\n  filter: ${m.filt}` : ''}${m.t ? `\n  time: ${m.t}` : ''}`).join('\n');

/** Which dimensions each metric can be broken down by — drives the action chips on a card. */
export const METRIC_DIMS: Record<string, string[]> = {
  revenue: ['branch', 'payment_type', 'referring_doctor', 'domain'],
  net_billed: ['branch', 'domain', 'referring_doctor'],
  outstanding: ['branch'],
  visits: ['branch', 'domain', 'referring_doctor'],
  unique_patients: ['branch', 'domain'],
  test_orders: ['branch', 'test', 'payout_category', 'modality', 'service_kind', 'referring_doctor'],
  reports_finalized: ['branch'],
  tat_p50: ['branch'],
  discount_total: ['branch'],
  refund_total: ['branch'],
  commission: ['referring_doctor', 'branch'],
};
export const DIM_LABEL: Record<string, string> = {
  branch: 'branch wise', payment_type: 'by payment mode', referring_doctor: 'doctor wise',
  domain: 'diagnostics vs clinic', test: 'by test', payout_category: 'by category',
  modality: 'by modality', service_kind: 'scans vs lab work',
};

/** Deterministic FROM clauses for the diagnostic engine (registry-generated queries). */
export const FROMS: Record<string, [string, string]> = {
  revenue: ['"PaymentTransaction" pt JOIN "Bill" b ON b.id=pt."billId" JOIN "Visit" v ON v.id=b."visitId" JOIN "Branch" br ON br.id=b."branchId"', 'pt."transactionDate"'],
  net_billed: ['"Bill" b JOIN "Visit" v ON v.id=b."visitId" JOIN "Branch" br ON br.id=b."branchId"', 'b."billedAt"'],
  outstanding: ['"Bill" b JOIN "Visit" v ON v.id=b."visitId" JOIN "Branch" br ON br.id=b."branchId"', 'b."billedAt"'],
  visits: ['"Visit" v JOIN "Branch" br ON br.id=v."branchId"', 'v."createdAt"'],
  unique_patients: ['"Visit" v JOIN "Branch" br ON br.id=v."branchId"', 'v."createdAt"'],
  test_orders: ['"TestOrder" o JOIN "Visit" v ON v.id=o."visitId" JOIN "Branch" br ON br.id=o."branchId"', 'o."createdAt"'],
  reports_finalized: ['"ReportVersion" rv JOIN "DiagnosticReport" dr ON dr.id=rv."reportId" JOIN "Visit" v ON v.id=dr."visitId" JOIN "Branch" br ON br.id=v."branchId"', 'rv."finalizedAt"'],
  tat_p50: ['"ReportVersion" rv JOIN "DiagnosticReport" dr ON dr.id=rv."reportId" JOIN "Visit" v ON v.id=dr."visitId" JOIN "Branch" br ON br.id=v."branchId"', 'rv."finalizedAt"'],
  discount_total: ['"Bill" b JOIN "Visit" v ON v.id=b."visitId" JOIN "Branch" br ON br.id=b."branchId"', 'b."billedAt"'],
  refund_total: ['"OrderRefund" orf JOIN "Visit" v ON v.id=orf."visitId" JOIN "Branch" br ON br.id=orf."branchId"', 'orf."createdAt"'],
  commission: ['"DoctorPayoutLedger" pl JOIN "Branch" br ON br.id=pl."branchId"', 'pl."periodStartDate"'],
  // rate metrics: no Branch join, so no breakdowns — but the formula is still exercised by the self-check
  abnormal_rate: ['"TestResult" r', ''],
  cancellation_rate: ['"TestOrder" o', 'o."createdAt"'],
  delivery_rate: ['"MessageLog" m', 'm."createdAt"'],
};
/** Branches that exist only for testing. The owner told us; the row counts do not say it — JGG
 *  has 29 lifetime visits and IDPL 8, against CNT's 3,011. They are excluded from dimension
 *  SPLITS, where their movement reads as a business finding, but never from a centre-wide total,
 *  where silently changing what a total covers would be the worse sin. */
export const TEST_BRANCHES = ['JGG', 'IDPL'];

/**
 * What a patient still owes, as one expression. Written down once because writing it per tool
 * meant fixing it three times: the worklist filtered on paymentStatus, then generated SQL did,
 * then receivables was still doing it after both. The flag disagrees with the arithmetic on live
 * rows — 48 bills carry a non-PAID status while 10 actually owe anything — so every place that
 * trusted the flag reported nearly five times too many debtors and the wrong money.
 */
export const DUE = (b = 'b') =>
  `(${b}."totalAmountInPaise" - ${b}."discountAmountInPaise" - ${b}."couponDiscountInPaise" - ${b}."reversedChargeInPaise" - ${b}."paidAmountInPaise")`;
export const OWES = (b = 'b') => `${DUE(b)} > 0`;

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
  referring_doctor: `COALESCE(rd.name,'(none)')`,
  payment_type: 'pt."paymentType"::text',
};
export const DIMJOIN: Record<string, string> = {
  referring_doctor: ' LEFT JOIN "ReferralDoctor_Visit" rdv ON rdv."visitId"=v.id AND rdv."deletedAt" IS NULL LEFT JOIN "ReferralDoctor" rd ON rd.id=rdv."referralDoctorId"',
};
/** Some metrics reach a dimension by a different path. commission already carries the doctor id. */
export const DIMJOIN_FOR: Record<string, Record<string, string>> = {
  commission: { referring_doctor: ' LEFT JOIN "ReferralDoctor" rd ON rd.id=pl."referralDoctorId"' },
};
export const dimJoin = (metric: string, dim: string) => DIMJOIN_FOR[metric]?.[dim] ?? DIMJOIN[dim] ?? '';
export function dimOk(metric: string, dim: string): boolean {
  if (DIMJOIN_FOR[metric]?.[dim]) return true;
  const from = FROMS[metric]?.[0] || '';
  if (dim === 'payout_category' || dim === 'test' || dim === 'modality' || dim === 'service_kind') return /"TestOrder"/.test(from);
  if (dim === 'payment_type') return /"PaymentTransaction"/.test(from);
  if (dim === 'domain' || dim === 'referring_doctor') return /"Visit"/.test(from);
  return /"Branch"/.test(from);
}
