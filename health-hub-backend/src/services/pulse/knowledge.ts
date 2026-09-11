/**
 * Pulse — everything the model is told about this business, and the deterministic
 * indexes built from live data at startup. Grounding is the only lever that ever moved
 * accuracy on this workload; this file IS the architecture.
 */
import { query, todayIST } from './db';
import { METRICS, METRIC_BLOCK } from './catalog';

// ── static blocks ──────────────────────────────────────────────────────────
export const SYS = () => `You write ONE read-only PostgreSQL SELECT for an Indian diagnostic-centre database.
Money columns are Int PAISE — never divide. Compare/bucket dates as: col AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'.
Identifiers are camelCase and MUST be double-quoted. Today is ${todayIST()} (IST).
Return JSON: {"sql":"...","assumptions":"one line"}.`;

export const SOFT = `REFERENCE METRIC DEFINITIONS — use ONLY if the question asks for exactly this quantity.
If it needs a different grain (per-patient, per-order, HAVING), IGNORE these and write SQL from the TABLES/SCHEMA.`;

const addDays = (iso: string, n: number) => { const [y, m, d] = iso.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, d) + n * 86400000); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}-${String(x.getUTCDate()).padStart(2, '0')}`; };
export const GLOSSARY = () => { const t = todayIST(); const [Y, M] = t.split('-').map(Number); const pm = M === 1 ? 12 : M - 1, py = M === 1 ? Y - 1 : Y;
  const lm = `${py}-${String(pm).padStart(2, '0')}-01`, tm = `${Y}-${String(M).padStart(2, '0')}-01`;
  return `OWNER VOCABULARY — the words the owner actually uses

  A word maps to a METRIC NAME. Use that metric's formula from REFERENCE METRIC DEFINITIONS
  exactly as written there — never restate or simplify it here.
  These are DEFAULTS, not overrides. If the question asks for something else — including
  cancelled rows, a raw row count, a different grain — follow the QUESTION, not the default.
  "how many test codes appear on orders" is a plain count of rows, not the test_orders metric.

  "collection", "collected", "kitna aaya"      the 'revenue' metric (money RECEIVED)
  "billing", "billed"                          the 'net_billed' metric (value INVOICED). NOT the same as collection.
  "case", "cases", "footfall"                  the 'visits' metric
  "due", "pending", "outstanding", "baaki"     the 'outstanding' metric
  "doctor wise", "which doctors", "who is sending", "referral"
                                               -> ReferralDoctor, via ReferralDoctor_Visit (deletedAt IS NULL).
                                               ClinicDoctor is the consultant who SEES the patient in OP/IP.
                                               Business SENT TO US is ALWAYS ReferralDoctor, never ClinicDoctor.
  "referral amount", "commission", "payout", "kitna dena hai"
                                               the 'commission' metric — DoctorPayoutLedger, the authoritative
                                               pay-run (doctorType='REFERRAL', deletedAt IS NULL).
                                               Do NOT recompute commission from order prices.
  "TAT", "turnaround", "report late"           ReportVersion.finalizedAt minus Visit.createdAt (see tat_p50)
  "repeat patient"                             a patient with more than one visit
  "new patient"                                a Patient RECORD created in the period (Patient.createdAt).
                                               Not "first visit in the period" — that is a different number.
  "lab", "diagnostics", "tests", "scans"       Visit.domain = 'DIAGNOSTICS' — the lab side of the
                                               business. "lab collection" EXCLUDES consultation fees.
  "OP", "IP", "clinic", "consultation",        Visit.domain = 'CLINIC' — the doctor-consultation side.
  "doctor visit", "consultation fee"           "IP" is an inpatient clinic visit (ClinicVisit.visitType).
                                               A centre-wide total is BOTH domains added together, so a
                                               question about one of them MUST filter v.domain. Reporting
                                               the combined figure as "lab" is wrong by the OP fees.
  "test", "investigation", "profile"           the 'test_orders' metric (excludes cancelled)

RELATIVE TIME — today is ${t} (IST)
  "last month"  = the previous WHOLE calendar month = ${lm} .. ${tm}
  "this month"  = ${tm} .. today       "yesterday" = ${addDays(t, -1)}
  "last week"   = the previous 7 whole days
  Always apply these as (col AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') >= 'YYYY-MM-DD'.
  Never compare a timestamp column against a TIMESTAMPTZ literal — it shifts the boundary.
  Hinglish: "pichhle mahine" = last month, "is mahine" = this month, "kal" = yesterday,
            "kitna/kitne" = how much/how many, "ab bhi" = still, "zyada" = too much/more

COMPARISONS
  "X vs Y", "compare", "ab bhi" (still), "pehle se" (than before) all ask for TWO periods.
  Return BOTH as separate columns or rows. A comparison answered with a single number is wrong.
`; };

export const CONVENTIONS = `JOIN AND GRAIN CONVENTIONS — follow these exactly

MONEY COLUMN NAMING — not optional
  Every money value in this database is stored in PAISE (1 rupee = 100 paise). Whatever you
  name a money output column, the name MUST end in "_paise" — "net_billed_paise",
  "collected_paise", "due_paise". This holds through CTEs: if an outer SELECT re-aliases a
  money column, the new alias ends in "_paise" too.
  Nothing downstream can tell paise from rupees by looking at the number. A column named
  "netBilledAfterDiscount" holding 435954453 was read as rupees and shown to the owner as
  ₹43,59,54,453 — a hundred times the true ₹43,59,544.53. The suffix is what prevents that.
  Never divide by 100 yourself; return paise and let the caller format it.


TWO DIFFERENT QUESTIONS ABOUT THE SAME DIMENSION — read which one is being asked

  (a) BREAKING A TOTAL DOWN: "by department", "branch wise", "per doctor", "split by".
      Every fact must be accounted for, so LEFT JOIN the dimension and COALESCE the label to
      '(none)'. An INNER JOIN silently drops facts whose foreign key is NULL, the parts stop
      adding up to the total, and the missing group is invisible. The parts MUST sum to the
      overall figure.

  (b) RANKING OR PICKING A DIMENSION MEMBER: "which department earned most", "top 5 doctors",
      "which branch is busiest". The answer has to BE a real member of that dimension, so rows
      with no dimension value are correctly excluded — an INNER JOIN is right here, and a
      '(none)' bucket must never be returned as the winner.

  The test: does the question ask what the total is MADE OF (a), or WHO IS TOP (b)?

"AVERAGE PER X" AND "HOW MANY PER X"
  Drive the query FROM the parent and LEFT JOIN the children, so parents with zero children
  are counted as 0 and pull the average down. An INNER JOIN answers a different question:
  "average among those that have at least one".

TURNAROUND TIME
  Measure to the FIRST finalization of a visit's report — MIN(finalizedAt) per visit — not to
  every version. A corrected report creates a second version; averaging over all versions
  double-counts the slow ones and inflates TAT.

COUNTING A PARENT THROUGH A ONE-TO-MANY CHILD
  Use EXISTS, or aggregate the child in a subquery first. Joining and then counting the parent
  multiplies it by the number of children.
`;

export const ONTOLOGY = `BUSINESS ONTOLOGY — how the business concepts relate

WHAT COUNTS AS A SCAN — a definition, not a guess
  A "scan" is an IMAGING order. It is identified by TestOrder."payoutCategorySnapshot" being
  one of: 'Ultrasound', 'Ultrasound Tiffa', 'X-Ray', 'Dental X-Ray', 'CT / MRI', '2D Echo'.
  Everything in 'Laboratory' is a blood or sample test and is NOT a scan.
  "scan", "scans", "imaging", "radiology" all mean this set. "ultrasound" alone means
  'Ultrasound' plus 'Ultrasound Tiffa' plus '2D Echo' (an echo is an ultrasound of the heart);
  say which you counted. "x-ray" means 'X-Ray' plus 'Dental X-Ray'.
  Counting every diagnostics test order as a scan overstates it by roughly ten times — most
  orders are lab work. Never answer a scan question with a plain test-order count.
  payoutCategorySnapshot is NULL on orders placed before 2026-08-01, when the field was
  introduced. For a scan count on any period reaching into July, say that those orders carry
  no category rather than silently dropping or including them.


CONCEPT HIERARCHY
  Patient ──has many──> Visit ──is one of──> { Diagnostics visit, Clinic visit }
  Visit   ──has one───> Bill ──has many──> PaymentTransaction, OrderRefund
  Visit   ──has many──> TestOrder ──produces──> TestResult (inside a ReportVersion)
  Visit   ──has one───> DiagnosticReport ──has many──> ReportVersion (only the LATEST counts)
  Visit   ──attributed to──> ReferralDoctor (via ReferralDoctor_Visit, soft-deletable)

METRIC DEPENDENCIES (what a number is built from)
  revenue          ← PaymentTransaction (net of REFUND rows)          ← Bill ← Visit
  outstanding      ← net_billed − paid                                ← Bill
  collection rate  ← revenue ÷ net_billed                             (two tables, one ratio)
  commission       ← TestOrder price × rate, per payout category      ← DoctorPayoutLedger
  turnaround       ← ReportVersion.finalizedAt − Visit.createdAt      (spans two tables)
  abnormal rate    ← TestResult.flag, denominator = flagged rows only
  workload         ← TestOrder rows, excluding cancelled

GRAIN RULES (the same noun at different grains)
  a VISIT has one bill but many test orders and many results
  a REPORT has many versions; a VERSION has many results
  counting money at test-order grain and at bill grain gives different, both-valid answers
  never SUM a parent column across a join to its children — aggregate the child, or subquery

LIFECYCLE
  Visit  DRAFT → WAITING → IN_PROGRESS → COMPLETED (or CANCELLED)
  Report DRAFT → FINALIZED (immutable once finalized)
  Order  active → cancelled (money reversed) | no-report (films only, money kept)
`;

export const DIM_BLOCK = `DIMENSION DEFINITIONS — the authoritative column for each business concept
test identity     TestOrder."testCodeSnapshot"  (frozen at order time; NOT testDefinitionId, which
                  is versioned — one analyte has many definition rows and undercounts)
test department   TestOrder."testDefinitionId" → TestDefinition."departmentId" → Department.name
payout category   TestOrder."payoutCategorySnapshot"  (frozen at billing; NOT BillableProduct.payoutCategory)
scan / imaging    NOT a test-name match — no test is literally called "ultrasound"; the names are
                  'USG OF ABDOMEN', 'X-RAY CHEST PA' and so on, so ILIKE '%ultrasound%' returns 0.
                  Use the payout category. Copy these exactly:
                    a scan       o."payoutCategorySnapshot" IN ('Ultrasound','Ultrasound Tiffa','2D Echo','X-Ray','Dental X-Ray','CT / MRI')
                    ultrasound   o."payoutCategorySnapshot" IN ('Ultrasound','Ultrasound Tiffa','2D Echo')
                    x-ray        o."payoutCategorySnapshot" IN ('X-Ray','Dental X-Ray')
                    lab work     o."payoutCategorySnapshot" = 'Laboratory'
branch            Branch."code" (CNT/BLN/JGG/IDPL); Branch."name" is the long form
product           TestOrder."productId" → BillableProduct.name
referring doctor  ReferralDoctor_Visit (deletedAt IS NULL) → ReferralDoctor.name
clinic doctor     ClinicVisit."clinicDoctorId" → ClinicDoctor.name
patient           Visit."patientId"  (ReportVersion has no patientId — go via DiagnosticReport→Visit)
bill value        NET: Bill."totalAmountInPaise" - "discountAmountInPaise" - "couponDiscountInPaise"
                  - "reversedChargeInPaise". Never the raw totalAmountInPaise on its own.
report grain      ReportVersion.id is ONE VERSION; a report can have several. Count versions,
                  not "reportId", unless the question asks about reports as documents.
`;

export const FEWSHOT = `WORKED EXAMPLES (patterns, not answers)

Q: How many visits happened on a given day?
SQL: SELECT count(*) FROM "Visit" v
     WHERE (v."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') >= '2026-07-04'
       AND (v."createdAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') <  '2026-07-05';

Q: How many distinct patients had a report finalized in a period?
SQL: SELECT count(DISTINCT v."patientId") FROM "ReportVersion" rv
     JOIN "DiagnosticReport" dr ON dr.id = rv."reportId"
     JOIN "Visit" v            ON v.id  = dr."visitId"
     WHERE rv.status='FINALIZED'
       AND (rv."finalizedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') >= '2026-07-01';

Q: Test volume by department?
SQL: SELECT d.name, count(*) FROM "TestOrder" o
     JOIN "TestDefinition" td ON td.id = o."testDefinitionId"
     JOIN "Department" d      ON d.id  = td."departmentId"
     WHERE o."cancelledAt" IS NULL GROUP BY 1 ORDER BY 2 DESC;

Q: Revenue by branch?
SQL: SELECT br.code, SUM(CASE WHEN pt."transactionType"='REFUND'
                              THEN -pt."amountInPaise" ELSE pt."amountInPaise" END)
     FROM "PaymentTransaction" pt
     JOIN "Bill" b   ON b.id  = pt."billId"
     JOIN "Branch" br ON br.id = b."branchId" GROUP BY 1;

Q: What share of results are flagged high?
SQL: SELECT ROUND(100.0 * count(*) FILTER (WHERE r.flag='HIGH')
                / NULLIF(count(*) FILTER (WHERE r.flag IS NOT NULL),0), 2)
     FROM "TestResult" r;      -- denominator excludes unflagged rows

Q: How many visits came through a referring doctor?
SQL: SELECT count(DISTINCT rv."visitId") FROM "ReferralDoctor_Visit" rv
     WHERE rv."deletedAt" IS NULL;   -- soft delete must be filtered

Q: Consultations per clinic doctor?
SQL: SELECT cd.name, count(*) FROM "ClinicVisit" cv
     JOIN "ClinicDoctor" cd ON cd.id = cv."clinicDoctorId" GROUP BY 1;

Q: Patients who visited more than one branch?
SQL: SELECT count(*) FROM (SELECT v."patientId" FROM "Visit" v
     GROUP BY 1 HAVING count(DISTINCT v."branchId") > 1) t;
`;

const ADVANCED_INTENT = new RegExp(['running total', 'cumulative', 'rank', 'ranked', 'moving average', 'rolling', 'month[- ]over[- ]month',
  'year[- ]over[- ]year', 'growth', 'percentile', 'median', 'quartile', 'iqr', 'interquartile', 'distribution',
  'first (ever |time )?visit', 'came back', 'returned', 'retention', 'cohort', '\\bboth\\b', '\\bneither\\b',
  '\\bnever\\b', 'alongside', 'together', 'same day', 'day of the week', 'compared with', 'proportion of',
  'share of', 'average number of', 'interval', 'between .* and .* visit'].join('|'), 'i');
export const needsAdvanced = (q: string) => ADVANCED_INTENT.test(String(q).replace(/\n/g, ' '));
export const ADVANCED = `ADVANCED PATTERNS

Running total:      SELECT d, SUM(v) OVER (ORDER BY d) FROM (...) t;
Rank within group:  SELECT k, RANK() OVER (ORDER BY n DESC) FROM (...) t;
Period-over-period: SELECT m, ROUND(100.0*(n - LAG(n) OVER (ORDER BY m))
                             / NULLIF(LAG(n) OVER (ORDER BY m),0), 2) FROM (...) t;
Moving average:     AVG(n) OVER (ORDER BY d ROWS BETWEEN 6 PRECEDING AND CURRENT ROW)
Percentile:         percentile_cont(0.9) WITHIN GROUP (ORDER BY expr)
IQR:                percentile_cont(0.75) WITHIN GROUP (ORDER BY c)
                  - percentile_cont(0.25) WITHIN GROUP (ORDER BY c)
First-ever event:   SELECT "patientId", min("createdAt") f FROM "Visit" GROUP BY 1  -- then filter f
Anti-join:          ... WHERE NOT EXISTS (SELECT 1 FROM y WHERE y.fk = x.id)
Both-of-two:        GROUP BY entity HAVING count(DISTINCT dim) = 2
Share of total:     ROUND(100.0*max(s)/NULLIF(sum(s),0),2) FROM (per-group sums) t
Group then average: SELECT AVG(c) FROM (SELECT k, count(*) c FROM ... GROUP BY 1) t;
`;

// ── live-built indexes ─────────────────────────────────────────────────────
const GRANTED = ['AnomalyEvent', 'AuditLog', 'Bill', 'BillableProduct', 'BillableProductPanel', 'Branch', 'ClinicalPanel', 'ClinicalPanelItem',
  'ClinicDoctor', 'ClinicVisit', 'Coupon', 'CouponCampaign', 'Department', 'DiagnosticReport', 'DoctorPayoutLedger', 'ExternalReportUpload',
  'MessageLog', 'OrderRefund', 'Patient', 'PatientChangeLog', 'PaymentTransaction', 'ReferralDoctor_Visit', 'ReferralDoctor', 'ReportVersion',
  'SmartReport', 'TestDefinition', 'TestOrder', 'TestResult', 'User', 'Visit'];
// column-granted tables: only these columns are readable, so only these are shown
const COLGRANT: Record<string, string[]> = {
  Patient: ['id', 'gender', 'yearOfBirth', 'ageUnit', 'createdAt', 'patientNumber'],
  User: ['id', 'name', 'role', 'activeBranchId', 'isActive'],
};
const DEAD_COLS = new Set(['testId', 'panelId']);
const TIMECOL: Record<string, string> = { Visit: 'createdAt', Bill: 'billedAt', TestOrder: 'createdAt', PaymentTransaction: 'transactionDate',
  OrderRefund: 'createdAt', ReportVersion: 'finalizedAt', ClinicVisit: 'createdAt', MessageLog: 'createdAt', TestResult: '(via reportVersion)',
  DiagnosticReport: 'createdAt', AnomalyEvent: 'occurredAt', AuditLog: 'createdAt', DoctorPayoutLedger: 'periodStartDate', Patient: 'createdAt', SmartReport: 'generatedAt' };
const TYPE = (d: string) => /timestamp/.test(d) ? 'ts' : /^date$/.test(d) ? 'date' : /int/.test(d) ? 'int' : /double|numeric|real/.test(d) ? 'float' :
  /bool/.test(d) ? 'bool' : /json/.test(d) ? 'json' : /USER-DEFINED/.test(d) ? 'enum' : 'str';

export interface Knowledge {
  builtAt: number; namesAt: number; fingerprint: string; registryHealth: Record<string, string>; enums: string; graphSchema: string; coverage: string;
  vidx: Record<string, { tab: string; col: string; val: string; exact: boolean }[]>;
  idents: string[]; names: { kind: 'doctor' | 'clinicDoctor' | 'branch' | 'test' | 'department'; id: string; name: string; sub?: string }[];
}
let K: Knowledge | null = null;
let building: Promise<Knowledge> | null = null;
const TTL = 6 * 3600 * 1000;          // schema shape, coverage, row counts — slow (~60 queries)
const NAMES_TTL = 60 * 60 * 1000;     // doctors, tests, branches, value index — cheap (6 queries)

export async function ensureKnowledge(): Promise<Knowledge> {
  if (K && Date.now() - K.builtAt < TTL) {
    if (Date.now() - K.namesAt >= NAMES_TTL) refreshNames().catch(() => {});   // never blocks an answer
    return K;
  }
  if (!building) building = build().then((k) => { K = k; building = null; return k; }).catch((e) => { building = null; throw e; });
  return building;
}
/** One cheap query that changes whenever a doctor, test, branch or department is added or
 *  renamed, or the schema gains/loses a column. Compared on every panel open. */
async function fingerprint(): Promise<string> {
  const r = await query(`SELECT
    (SELECT count(*) FROM "ReferralDoctor") rd, (SELECT max("updatedAt") FROM "ReferralDoctor") rdu,
    (SELECT count(*) FROM "ClinicDoctor") cd, (SELECT max("updatedAt") FROM "ClinicDoctor") cdu,
    (SELECT count(*) FROM "Branch") br, (SELECT count(*) FROM "Department") dp,
    (SELECT count(DISTINCT "testCodeSnapshot") FROM "TestOrder") tc,
    (SELECT count(*) FROM information_schema.columns WHERE table_schema='public') cols`);
  return r.err ? '' : JSON.stringify(r.rows?.[0] ?? {});
}
/** Called when Pulse OPENS (from /today). If nothing changed, nothing happens. A new doctor or
 *  test triggers a name refresh; a schema change triggers a full rebuild. Throttled to 30s so a
 *  panel opened ten times in a row costs one query. Never blocks the answer. */
let lastCheck = 0;
export function touchNames(): void {
  if (!K || Date.now() - lastCheck < 30_000) return; lastCheck = Date.now();
  fingerprint().then((fp) => {
    if (!K || !fp || fp === K.fingerprint) return;
    const before = JSON.parse(K.fingerprint || '{}'), now = JSON.parse(fp);
    if (before.cols !== now.cols) { console.log('[pulse] schema changed — full rebuild'); refreshKnowledge().catch(() => {}); }
    else { console.log('[pulse] names changed — refreshing'); refreshNames(fp).catch(() => {}); }
  }).catch(() => {});
}
/** Force a full rebuild — the owner's "I just added a doctor / changed the schema" button. */
export async function refreshKnowledge(): Promise<Knowledge> { K = null; return ensureKnowledge(); }
let refreshingNames = false;
async function refreshNames(fp?: string): Promise<void> {
  if (!K || refreshingNames) return; refreshingNames = true;
  try { const { vidx, names } = await buildNames(); K = { ...K, vidx, names, namesAt: Date.now(), fingerprint: fp ?? K.fingerprint }; console.log(`[pulse] names refreshed — ${names.length} names`); }
  finally { refreshingNames = false; }
}

/** Run every registry formula once over a tiny window. A schema change that breaks a formula
 *  must show up here, on /health, not in an owner's answer. */
async function checkRegistry(): Promise<Record<string, string>> {
  const { METRICS: M, FROMS: F } = await import('./catalog');
  const out: Record<string, string> = {};
  const today = todayIST();
  await Promise.all(Object.entries(M).map(async ([name, m]) => {
    const fr = F[name]; if (!fr) { out[name] = 'unchecked'; return; }
    const w: string[] = []; if (m.filt) w.push(m.filt); if (fr[1]) w.push(`(${fr[1]} AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata') >= '${today}'`);
    const r = await query(`SELECT ${m.sql} AS v FROM ${fr[0]}${w.length ? ` WHERE ${w.join(' AND ')}` : ''}`);
    out[name] = r.err ? `BROKEN: ${r.err}` : 'ok';
    if (r.err) console.error(`[pulse] registry metric '${name}' is broken: ${r.err}`);
  }));
  return out;
}

async function build(): Promise<Knowledge> {
  const t0 = Date.now();
  // enums
  const en = await query(`SELECT t.typname n, string_agg(e.enumlabel,'|' ORDER BY e.enumsortorder) v FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid GROUP BY 1`, [], 100000);
  const enums = (en.rows || []).map((r) => `${r.n}=${r.v}`).join('\n');
  // columns
  const cols = await query(`SELECT table_name t, column_name c, data_type d FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position`, [], 100000);
  const byT: Record<string, { c: string; d: string }[]> = {};
  const idents = new Set<string>();
  for (const r of cols.rows || []) {
    const t = String(r.t), c = String(r.c);
    if (/[a-z][A-Z]/.test(c)) idents.add(c);
    if (!GRANTED.includes(t)) continue;
    if (COLGRANT[t] && !COLGRANT[t].includes(c)) continue;
    if (DEAD_COLS.has(c)) continue;
    (byT[t] ||= []).push({ c, d: String(r.d) });
  }
  // counts → fact vs dimension
  const fact: string[] = [], dim: string[] = [];
  for (const t of GRANTED) {
    if (!byT[t]) continue;
    const n = await query(`SELECT count(*)::int n FROM "${t}"`, [], 100000);
    const cnt = Number(n.rows?.[0]?.n || 0);
    const line = `  ${t}(${byT[t].map((x) => `${x.c}:${TYPE(x.d)}`).join(',')})${TIMECOL[t] ? `\n     TIME: ${TIMECOL[t]}` : ''}`;
    (cnt > 500 ? fact : dim).push(line);   // FK edges deliberately NOT emitted: lost 3/3 reps, cost 583 tok/q
  }
  const graphSchema = `FACT TABLES (events you count, sum and bucket by time)\n${fact.join('\n')}\n\nDIMENSION TABLES (labels you group by)\n${dim.join('\n')}`;
  // coverage — columns that exist but are never filled in
  const WATCH: Record<string, string[]> = {
    TestOrder: ['labCostAmountInPaise', 'labCostPercentage', 'externalLabId', 'testDefinitionId', 'productId', 'payoutCategorySnapshot', 'noReportAt', 'reopenedAt'],
    Bill: ['couponId', 'discountedByUserId', 'refundedByUserId', 'refundedAmountInPaise', 'reversedChargeInPaise'],
    Visit: ['patientLinkDisabledAt', 'heightCm', 'weightKg'], TestResult: ['value', 'textValue', 'flag', 'testDefinitionId'], Patient: ['dateOfBirth'],
  };
  const hollow: string[] = [];
  for (const [t, cs] of Object.entries(WATCH)) {
    const ok = cs.filter((c) => byT[t]?.some((x) => x.c === c) || (t === 'Patient' && c === 'dateOfBirth' && false));
    if (!ok.length) continue;
    const tr = await query(`SELECT count(*)::int n FROM "${t}"`, [], 100000); const tot = Number(tr.rows?.[0]?.n || 0); if (tot < 100) continue;
    const counts = await Promise.all(ok.map((c) => query(`SELECT count("${c}")::int n FROM "${t}"`)));
    for (let i = 0; i < ok.length; i++) { const c = ok[i]; if (counts[i].err) { console.warn(`[pulse] coverage ${t}.${c}: ${counts[i].err}`); continue; }
      const f = Number(counts[i].rows?.[0]?.n || 0); const pct = f / tot * 100;
      if (pct < 5) hollow.push(f === 0 ? `  ${t}.${c} — NEVER populated (0 of ${tot.toLocaleString('en-IN')} rows)` : `  ${t}.${c} — populated on only ${f.toLocaleString('en-IN')} of ${tot.toLocaleString('en-IN')} rows (${pct.toFixed(1)}%)`); }
  }
  const coverage = hollow.length ? `COLUMNS THAT EXIST BUT ARE NOT FILLED IN
These columns are in the schema and look usable. They are not. Any metric built on one is
meaningless, and a query over one returns a confident zero rather than an error.
${hollow.join('\n')}
If a question needs one of these, say the business does not record it and ask the owner for
the figure. Do NOT substitute a different column and label it as the thing they asked for.` : '';
  const { vidx, names } = await buildNames();
  CONCEPTS = await buildConcepts();
  const registryHealth = await checkRegistry();
  console.log(`[pulse] knowledge built in ${Date.now() - t0}ms — ${fact.length} fact, ${dim.length} dim tables, ${hollow.length} hollow columns, ${Object.keys(vidx).length} value terms, ${Object.values(registryHealth).filter((v) => v !== 'ok').length} broken metrics`);
  return { builtAt: Date.now(), namesAt: Date.now(), fingerprint: await fingerprint(), registryHealth, enums, graphSchema, coverage, vidx, idents: [...idents], names };
}

async function buildNames(): Promise<{ vidx: Knowledge['vidx']; names: Knowledge['names'] }> {
  const COMMON = new Set(('time with rate the and for from that this these those have has had was were are is be been all any both each few more most other some such only own same than too very can will just now new old one two three first last next total sub main top low high full part end start over under out up down value values count number amount level type kind form line list set group order test tests result results report reports visit visits patient patients doctor branch bill month year day week time date name code left right front back side inner outer upper lower single double multi non pre post anti semi mid').split(' '));
  const vidx: Knowledge['vidx'] = {};
  const put = (term: unknown, tab: string, col: string, val: string, exact = false) => {
    const k = String(term || '').toLowerCase().trim(); if (k.length < 3) return; if (!exact && COMMON.has(k)) return;
    (vidx[k] ||= []).push({ tab, col, val, exact });
  };
  const names: Knowledge['names'] = [];
  for (const r of (await query('SELECT id, code, name FROM "Branch"', [], 100000)).rows || []) { put(r.code, 'Branch', 'code', String(r.code)); for (const w of String(r.name).split(/[^A-Za-z0-9]+/)) put(w, 'Branch', 'code', String(r.code)); names.push({ kind: 'branch', id: String(r.id), name: String(r.name), sub: String(r.code) }); }
  for (const r of (await query('SELECT id, name FROM "Department" WHERE "isActive"', [], 100000)).rows || []) { for (const w of String(r.name).split(/[^A-Za-z0-9]+/)) put(w, 'Department', 'name', String(r.name)); names.push({ kind: 'department', id: String(r.id), name: String(r.name) }); }
  for (const r of (await query('SELECT DISTINCT "payoutCategorySnapshot" v FROM "TestOrder" WHERE "payoutCategorySnapshot" IS NOT NULL', [], 100000)).rows || []) for (const w of String(r.v).split(/[^A-Za-z0-9]+/)) put(w, 'TestOrder', 'payoutCategorySnapshot', String(r.v));
  for (const r of (await query('SELECT DISTINCT "testCodeSnapshot" c, "testNameSnapshot" n FROM "TestOrder" WHERE "testCodeSnapshot" IS NOT NULL', [], 100000)).rows || []) { put(r.c, 'TestOrder', 'testCodeSnapshot', String(r.c), true); for (const w of String(r.n).split(/[^A-Za-z0-9]+/)) if (w.length > 3) put(w, 'TestOrder', 'testCodeSnapshot', String(r.c)); names.push({ kind: 'test', id: String(r.c), name: String(r.n), sub: String(r.c) }); }
  for (const r of (await query('SELECT id, name FROM "ClinicDoctor"', [], 100000)).rows || []) { for (const w of String(r.name).split(/[^A-Za-z0-9]+/)) if (w.length > 3) put(w, 'ClinicDoctor', 'name', String(r.name)); names.push({ kind: 'clinicDoctor', id: String(r.id), name: String(r.name) }); }
  for (const r of (await query('SELECT id, name FROM "ReferralDoctor"', [], 100000)).rows || []) { for (const w of String(r.name).split(/[^A-Za-z0-9]+/)) if (w.length > 3 && w.toLowerCase() !== 'name') put(w, 'ReferralDoctor', 'name', String(r.name)); names.push({ kind: 'doctor', id: String(r.id), name: String(r.name) }); }
  return { vidx, names };
}


/* ── SEMANTIC INDEX ──────────────────────────────────────────────────────────
   Every term the business actually uses, mapped to what it means in the data: enum values,
   department and test names, branch codes, payout categories, doctor names, plus the owner's
   synonyms. Built from live data at startup, so a new department or test is resolvable the day
   it is created. The analyst carries a compact summary of it and calls resolve() only for a
   term it does not recognise — semantic context is always available, semantic reasoning is not
   always run. */
export interface Concept { term: string; dimension: string | null; value: string | null; meaning: string; source: string; }
let CONCEPTS: Concept[] = [];
export const concepts = () => CONCEPTS;

/** The owner's words that are not literal data values — synonyms a lookup cannot discover. */
const SYNONYMS: Concept[] = [
  { term: 'lab', dimension: 'domain', value: 'DIAGNOSTICS', meaning: 'the lab side — tests and scans, excluding consultation fees', source: 'glossary' },
  { term: 'scan', dimension: 'service_kind', value: 'IMAGING', meaning: 'an imaging order — ultrasound, x-ray, CT/MRI or echo. NOT lab work', source: 'glossary' },
  { term: 'scans', dimension: 'service_kind', value: 'IMAGING', meaning: 'imaging orders — ultrasound, x-ray, CT/MRI, echo. Excludes Laboratory', source: 'glossary' },
  { term: 'imaging', dimension: 'service_kind', value: 'IMAGING', meaning: 'ultrasound, x-ray, CT/MRI and echo orders', source: 'glossary' },
  { term: 'radiology', dimension: 'service_kind', value: 'IMAGING', meaning: 'the imaging orders — same as scans', source: 'glossary' },
  { term: 'ultrasound', dimension: 'modality', value: 'Ultrasound', meaning: 'ultrasound orders, including Tiffa and 2D Echo (a cardiac ultrasound)', source: 'glossary' },
  { term: 'usg', dimension: 'modality', value: 'Ultrasound', meaning: 'ultrasound — including Tiffa and 2D Echo', source: 'glossary' },
  { term: 'x-ray', dimension: 'modality', value: 'X-Ray', meaning: 'x-ray orders, including dental x-ray', source: 'glossary' },
  { term: 'xray', dimension: 'modality', value: 'X-Ray', meaning: 'x-ray orders, including dental x-ray', source: 'glossary' },
  { term: 'diagnostics', dimension: 'domain', value: 'DIAGNOSTICS', meaning: 'the lab side of the business', source: 'glossary' },
  { term: 'tests', dimension: 'domain', value: 'DIAGNOSTICS', meaning: 'lab work', source: 'glossary' },
  { term: 'scans', dimension: 'domain', value: 'DIAGNOSTICS', meaning: 'imaging, part of the lab side', source: 'glossary' },
  { term: 'op', dimension: 'domain', value: 'CLINIC', meaning: 'outpatient doctor consultation', source: 'glossary' },
  { term: 'ip', dimension: 'domain', value: 'CLINIC', meaning: 'inpatient clinic visit', source: 'glossary' },
  { term: 'clinic', dimension: 'domain', value: 'CLINIC', meaning: 'the consultation side of the business', source: 'glossary' },
  { term: 'consultation', dimension: 'domain', value: 'CLINIC', meaning: 'doctor consultation fees', source: 'glossary' },
  { term: 'consultations', dimension: 'domain', value: 'CLINIC', meaning: 'doctor consultation fees', source: 'glossary' },
  { term: 'collection', dimension: null, value: 'revenue', meaning: 'money RECEIVED — the revenue metric', source: 'glossary' },
  { term: 'billing', dimension: null, value: 'net_billed', meaning: 'value INVOICED, not collected', source: 'glossary' },
  { term: 'cases', dimension: null, value: 'visits', meaning: 'visits, not tests', source: 'glossary' },
  { term: 'footfall', dimension: null, value: 'visits', meaning: 'visits', source: 'glossary' },
  { term: 'due', dimension: null, value: 'outstanding', meaning: 'unpaid balance', source: 'glossary' },
  { term: 'referral amount', dimension: null, value: 'commission', meaning: 'doctor payout from the ledger', source: 'glossary' },
];

async function buildConcepts(): Promise<Concept[]> {
  const out: Concept[] = [...SYNONYMS];
  const add = (term: unknown, dimension: string | null, value: string, meaning: string, source: string) => {
    const t = String(term || '').toLowerCase().trim();
    if (t.length < 2 || out.some((c) => c.term === t)) return;
    out.push({ term: t, dimension, value, meaning, source });
  };
  // enum values are literal filters: DIAGNOSTICS, CLINIC, CASH, ONLINE, FINALIZED…
  for (const [dim, sql] of [['domain', `SELECT DISTINCT domain::text v FROM "Visit"`],
    ['payment_type', `SELECT DISTINCT "paymentType"::text v FROM "PaymentTransaction"`],
    ['payout_category', `SELECT DISTINCT "payoutCategorySnapshot" v FROM "TestOrder" WHERE "payoutCategorySnapshot" IS NOT NULL`]] as [string, string][]) {
    for (const r of (await query(sql, [], 300)).rows || []) add(r.v, dim, String(r.v), `${dim} = ${r.v}`, 'enum');
  }
  for (const r of (await query('SELECT code, name FROM "Branch"', [], 100)).rows || []) {
    add(r.code, 'branch', String(r.code), `the ${r.name} branch`, 'branch');
    for (const w of String(r.name).split(/[^A-Za-z0-9]+/)) if (w.length > 3 && !/sobhana|kidcare/i.test(w)) add(w, 'branch', String(r.code), `the ${r.name} branch`, 'branch');
  }
  for (const r of (await query('SELECT name FROM "Department" WHERE "isActive"', [], 100)).rows || [])
    add(r.name, null, String(r.name), `a department — filter tests by TestDefinition.departmentId`, 'department');
  for (const r of (await query('SELECT DISTINCT "testCodeSnapshot" c, "testNameSnapshot" n FROM "TestOrder" WHERE "testCodeSnapshot" IS NOT NULL', [], 2000)).rows || [])
    add(r.c, 'test', String(r.c), `test ${r.n}`, 'test');
  return out;
}

/** What does this word mean here? Deterministic, no model call. */
export function resolveTerm(term: string): Concept[] {
  const t = String(term || '').toLowerCase().trim();
  if (!t) return [];
  const exact = CONCEPTS.filter((c) => c.term === t);
  if (exact.length) return exact;
  return CONCEPTS.filter((c) => c.term.includes(t) || t.includes(c.term)).slice(0, 6);
}
/** Scope terms the question uses, whatever they are — no hardcoded list. */
export function scopeTermsIn(q: string): Concept[] {
  const words = String(q).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 2);
  const hits: Concept[] = [];
  for (const w of words) { if (VSTOP.has(w)) continue;
    for (const c of CONCEPTS) if (c.term === w && c.dimension && !hits.some((h) => h.term === c.term)) hits.push(c); }
  return hits;
}
/** The compact list the analyst always carries, so a known term costs no lookup. */
export function conceptSummary(): string {
  const byDim: Record<string, string[]> = {};
  for (const c of CONCEPTS) { if (!c.dimension) continue; (byDim[c.dimension] ||= []).push(`${c.term}→${c.value}`); }
  return Object.entries(byDim).map(([d, xs]) => `  ${d}: ${xs.slice(0, 14).join('  ')}${xs.length > 14 ? `  …+${xs.length - 14}` : ''}`).join('\n');
}

// ── question-time helpers ──────────────────────────────────────────────────
export const VSTOP = new Set(('the and for how many much what which show list top all last this our we us in on of by per each with from at as it that did do does are was were test tests volume order orders compare between total count revenue value rate share average number report reports result results patient patients visit visits branch department bill bills month year week day time high low new').split(' '));
export function resolveValues(k: Knowledge, q: string): string {
  const seen = new Map<string, Set<string>>();
  for (const raw of String(q).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')) {
    if (!raw || VSTOP.has(raw)) continue;
    const hit = k.vidx[raw]; if (!hit) continue;
    const distinct = new Set(hit.map((h) => h.tab + '.' + h.col + '|' + h.val)); if (distinct.size > 4) continue;
    for (const h of hit) { const key = h.tab + '.' + h.col; if (!seen.has(key)) seen.set(key, new Set()); seen.get(key)!.add(h.val); }
  }
  if (!seen.size) return '';
  const lines = [...seen.entries()].map(([key, vs]) => `${key} IN (${[...vs].slice(0, 8).map((x) => `'${x}'`).join(', ')})`);
  return `\n\nRESOLVED VALUES — the question names these; use these EXACT literals\n${lines.join('\n')}`;
}
const HOLLOW_TERMS = /\b(profit|margin|cost|kharcha|lab ?cost|outsourc|external lab|coupon|height|weight|link disabled|reopen)\w*/i;
export const coverageFor = (k: Knowledge, q: string) => k.coverage && HOLLOW_TERMS.test(q) ? `\n${k.coverage}\n` : '';

/** Quote any known camelCase identifier the model left bare. */
export function repairIdents(k: Knowledge, sql: string): string {
  let o = String(sql || '');
  for (const id of k.idents) o = o.replace(new RegExp(`(?<!")\\b${id}\\b(?!")`, 'g'), `"${id}"`);
  return o;
}

/**
 * Entity ambiguity — the 4-tier policy. A surname matching many doctors returns a PICKER
 * ranked by recent activity; a name matching exactly one resolves silently; two near-identical
 * names (KidCare / Kid Care) are ENUMERATED rather than asked about.
 */
export function ambiguousEntity(k: Knowledge, q: string): { term: string; options: Knowledge['names'] } | null {
  const words = String(q).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !VSTOP.has(w) && !/^(doctor|referral|branch|month|last|this|week|kitna|kitne|amount|cases|collection|referrals)$/.test(w));
  for (const w of words) {
    const hits = k.names.filter((n) => n.kind === 'doctor' && n.name.toLowerCase().split(/[^a-z0-9]+/).includes(w));
    if (hits.length >= 2) return { term: w, options: hits.sort((a, b) => a.name.localeCompare(b.name)) };
  }
  return null;
}
/** Does the question mention any doctor, branch or test we know by name? */
export function mentionsKnown(k: Knowledge, q: string): boolean {
  const words = new Set(String(q).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 4 && !VSTOP.has(w)));
  return k.names.some((n) => n.name.toLowerCase().split(/[^a-z0-9]+/).some((t) => t.length >= 4 && words.has(t)) || (n.sub && words.has(n.sub.toLowerCase())));
}
export function assemble(k: Knowledge, q: string): string {
  const adv = needsAdvanced(q) ? `\n${ADVANCED}` : '';
  return `DATABASE SCHEMA\n${k.graphSchema}\n\nENUMS\n${k.enums}\n${coverageFor(k, q)}\n${GLOSSARY()}\n${ONTOLOGY}\n${CONVENTIONS}\n${SOFT}\n${METRIC_BLOCK}\n\n${DIM_BLOCK}\n${FEWSHOT}${adv}${resolveValues(k, q)}\n\nQUESTION\n${q}`;
}
export { METRICS };
