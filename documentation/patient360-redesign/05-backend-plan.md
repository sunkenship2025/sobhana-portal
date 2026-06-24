# Patient360 Backend Implementation Plan — Glance + Paginated Timeline + Inspector

## 1. OVERVIEW

Patient360 currently loads every visit for a patient in one unbounded `findUnique` (`patientService.ts:306-456`), under-selects the bill (causing a `paymentType`-undefined bug), and returns no financial or report-state detail. This plan splits the read into a glance **summary** endpoint (aggregate-only, computed once on open and unaffected by paging) and a **cursor-paginated timeline** endpoint that returns rich per-visit fields (live due, discount, payment type, report state, abnormal-results boolean, workflow mode, delivery status) for an inspector panel. All money is read-only and reuses the authoritative `computeBillFinancialsFromPersisted`; the legacy `/360` route stays byte-compatible. One optional perf index is recommended; no schema migration is required for correctness.

---

## 2. API CONTRACT

Three endpoints, all `authMiddleware` + `branchContextMiddleware` (the view is global across branches; `req.branchId` is used only for audit, per the documented multi-tenancy gotcha). Doctors have no access (staff/owner only) — unchanged.

### 2a. `GET /api/patients/:id/360` — LEGACY, frozen (see §7)

Unchanged shape: `{ patient, visitTimeline[], totalVisits, branches[] }`. Keeps its current single-query implementation; only the `paymentType` select bug is fixed.

### 2b. `GET /api/patients/:id/360/summary` — NEW (glance)

Path param `:id` only. No query params.

```jsonc
{
  "patient": {
    "id": "...", "patientNumber": "...", "name": "...", "title": "...",
    "age": 45, "ageUnit": "YEARS", "ageDisplay": "45 Years",
    "dateOfBirth": null, "yearOfBirth": 1981, "gender": "MALE",
    "address": "...", "identifiers": [ /* full array */ ],
    "whatsappOptIn": true, "whatsappOptInAt": "2026-01-01T...", "createdAt": "2024-..."
  },
  "glance": {
    "outstandingDueInPaise": 125000,
    "totalVisits": 37,                       // non-cancelled
    "totalVisitsIncludingCancelled": 39,
    "lastVisit": { "visitId": "...", "domain": "DIAGNOSTICS", "branchName": "Main", "createdAt": "2026-06-20T..." },
    "reportCounts": { "finalized": 12, "notFinalized": 3, "billOnly": 5 }
  },
  "branches": [ { "id": "...", "name": "..." } ]
}
```

> `reportCounts.notFinalized` (renamed from "pending" per review) explicitly means "diagnostic visits with reportable/external orders that are not yet fully finalized" — it includes in-flight partially-finalized visits. It is NOT the same as the `RESULTS_PENDING` per-visit `reportState`.

### 2c. `GET /api/patients/:id/360/timeline` — NEW (paginated inspector list)

Query params (all optional):

| Param | Type | Default | Maps to |
|---|---|---|---|
| `cursor` | string (opaque base64) | none → newest page | keyset on `(createdAt, id)` |
| `pageSize` | int 1–50 | `20` | `take` (clamped) |
| `domain` | `DIAGNOSTICS\|CLINIC` | unset = both | `where.domain` |
| `from` | ISO date/datetime (UTC) | unset | `where.createdAt.gte` |
| `to` | ISO date/datetime (UTC) | unset | `where.createdAt.lte` (UTC end-of-day if date-only) |
| `branchId` | string | unset = all | `where.branchId` |
| `unpaidOnly` | bool | `false` | `where.bill.paymentStatus notIn [PAID, REFUNDED]` |
| `includeCancelled` | bool | `false` | omits `status != CANCELLED` filter |

**Cursor contract (explicit):** the cursor is opaque and bound to the filter set. **Any change to a filter param MUST reset `cursor` to none** — the frontend must drop a held cursor when filters change. Reusing a cursor across a filter change is unsupported and will silently skip rows.

```jsonc
{
  "items": [ /* VisitTimelineItem[] — §4 */ ],
  "pageInfo": { "nextCursor": "eyJjcmVhdGVkQXQiOiIuLi4iLCJpZCI6Ii4uLiJ9", "hasMore": true, "pageSize": 20 },
  "appliedFilters": { "domain": null, "from": null, "to": null, "branchId": null, "unpaidOnly": false, "includeCancelled": false }
}
```

---

## 3. ORDERED IMPLEMENTATION STEPS

Each step is independently testable. Backend services first (pure, unit-testable), then routes, then frontend types.

### Step 1 — Shared per-bill mapping helper with REFUNDED/CANCELLED guards
**File:** `health-hub-backend/src/services/patientService.ts` (new local helper near top of file).

Add a pure function `mapBillFinancials(bill, visitStatus)`:
- If `bill == null` → return zeros (`paidAmountInPaise: 0, dueAmountInPaise: 0, netAmountInPaise: 0`, `discount` nulls, `paymentStatus: null`, `paymentType: null`, `transactions: []`).
- Else call `computeBillFinancialsFromPersisted(bill)` (reused — see §4).
- **Force `dueAmountInPaise = 0` when `bill.paymentStatus === 'REFUNDED'`** OR `visitStatus === 'CANCELLED'`. This is required because `computeBillFinancialsFromPersisted` is refund-unaware (verified: `billFinancialService.ts:103-104` only ever returns PENDING/PAID) and would otherwise fabricate a positive due on a refunded or cancelled bill in a timeline page.
- `paymentType = bill.transactions?.[0]?.paymentType ?? null` (latest, transactions ordered desc).
- Return both flat discount fields (compat) and nested `discount {amount, type, reason}`.

**N+1:** none — operates on already-loaded data.

### Step 2 — `getPatient360Summary(patientId)` aggregate function
**File:** `health-hub-backend/src/services/patientService.ts` (new export).

Build the glance from aggregate queries only — never load a visit array. Run all of these inside one `prisma.$transaction([...])` (single round-trip):

1. `prisma.patient.findUnique` selecting only header fields + `identifiers` (no `visits` include).
2. Open bills for due (see §4 query) → reduce with `computeBillFinancialsFromPersisted`.
3. `visit.count({ where: { patientId, status: { not: 'CANCELLED' } } })` → `totalVisits`.
4. `visit.count({ where: { patientId } })` → `totalVisitsIncludingCancelled`.
5. `visit.findFirst` newest non-cancelled (`orderBy createdAt desc`, select id/domain/createdAt/branch.name) → `lastVisit`.
6. `finalized` = `visit.count` where `domain=DIAGNOSTICS, status=COMPLETED, report.versions.some(status=FINALIZED)` — mirrors `deriveDiagnosticVisitComposition` (`diagnosticWorkflowService.ts:66-68`).
7. `billOnly` = `visit.count` where `domain=DIAGNOSTICS, status != CANCELLED, testOrders: { every: { workflowMode: 'BILL_ONLY' }, some: {} }` (the `some: {}` guards against the vacuous-truth empty-relation match).
8. `diagnosticTotal` = `visit.count` where `domain=DIAGNOSTICS, status != CANCELLED`.
9. `notFinalized = diagnosticTotal - finalized - billOnly`.

Compute `age`/`ageDisplay` via `getPatientAge`/`getPatientAgeDisplay` (`validation.ts`, reused unchanged).

`branches` = `visit.findMany({ where: { patientId }, distinct: ['branchId'], select: { branch: { select: { id, name } } } })`.

**N+1:** none — all aggregate counts/findFirst; no per-visit loop. Stays correct after pagination because it is independent of timeline pages.

### Step 3 — Cursor + filter helpers
**File:** `health-hub-backend/src/services/patientService.ts` (or a small new `patient360Util.ts`).

- `decodeCursor(c?)` → `{ createdAt: Date, id } | null` from base64 JSON.
- `encodeCursor(createdAt, id)` → base64 JSON.
- `buildTimelineWhere(patientId, filters)` → `Prisma.VisitWhereInput` per §3 mapping in the design, with:
  - `unpaidOnly` → `{ bill: { is: { paymentStatus: { notIn: ['PAID', 'REFUNDED'] } } } }` (NOT `= PENDING` — must match the glance due predicate so the two never diverge; the enum also has FAILED).
  - `includeCancelled=false` → `status: { not: 'CANCELLED' }`.
  - keyset OR-predicate for the cursor.
- `parseTimelineQuery(req.query)` → validates/coerces, clamps `pageSize` to 1–50 (default 20), normalizes `to` to **UTC** end-of-day when date-only.

**N+1:** n/a (pure).

### Step 4 — `getPatient360Timeline(patientId, filters)` — page query + 3 batched lookups
**File:** `health-hub-backend/src/services/patientService.ts` (new export). Extends the include at `patientService.ts:313-335`.

**Query 1 — the visit page (one query):**
```ts
const rows = await prisma.visit.findMany({
  where: buildTimelineWhere(patientId, filters),
  orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],   // (createdAt,id) composite — gap-safe across ties
  take: pageSize + 1,                                  // +1 sentinel → hasMore without a count()
  include: TIMELINE_INCLUDE,
});
```
`TIMELINE_INCLUDE` selects `branch`, `bill` (with all discount fields + `transactions { amountInPaise, paymentType, transactionDate } orderBy transactionDate desc`), `report.versions` (ALL versions, **not** `take:1`), `testOrders { workflowMode }`, `clinicVisit.clinicDoctor`. The `transactions` include is the fix for the `paymentType`-undefined bug.

Compute `hasMore`, slice to `pageSize`, build `nextCursor` from the last item.

**Query 2 — abnormal-results existence (one batched query for the page):**
```ts
const dxIds = page.filter(v => v.domain === 'DIAGNOSTICS').map(v => v.id);
const abnormalRows = await prisma.testResult.findMany({
  where: {
    flag: { in: ['HIGH','LOW','CRITICAL_HIGH','CRITICAL_LOW'] },   // CRITICAL_* count as abnormal
    reportVersion: { status: 'FINALIZED', report: { visitId: { in: dxIds } } }, // only finalized results
  },
  select: { reportVersion: { select: { report: { select: { visitId: true } } } } },
  distinct: ['reportVersionId'],
});
```
Selects only `visitId` — **no values, no flags-per-test, no test names** (privacy). The `status: 'FINALIZED'` filter ensures superseded DRAFT results don't fabricate an abnormal flag on a corrected report. Uses `TestResult @@index([reportVersionId])`.

**Query 3 — latest delivery MessageLog (one batched query for the page):**
```ts
const logs = await prisma.messageLog.findMany({
  where: { contextType: 'REPORT', contextId: { in: page.map(v => v.id) } },
  orderBy: { createdAt: 'desc' },
  select: { contextId: true, status: true, sentAt: true, deliveredAt: true, readAt: true },
});
// keep first (latest) per contextId
```
Uses `MessageLog @@index([contextType, contextId])` for the filter; the page-bounded result is sorted in memory (acceptable at pageSize ≤ 50 — confirm via EXPLAIN, §8). Clinic visits will correctly resolve to `delivery: null` (no REPORT log keyed by their visitId). Bill-receipt delivery is out of scope.

**Query 4 (conditional) — original-visit map for clinic revisits**, reusing the existing pattern at `patientService.ts:351-376`, only if the page contains revisits.

**Assemble each `VisitTimelineItem`** via Step 1 helper + Step 5 derivations.

**N+1:** total **3 queries** per page (4 only when revisits present), independent of `pageSize`. No per-visit loops.

### Step 5 — `reportState` and `workflowMode` derivation
**File:** `health-hub-backend/src/services/patientService.ts` (pure helper `deriveReportState(visit)`), mirroring `diagnosticWorkflowService.ts:51-85`.

Precedence (CLINIC visit → `reportState: null`):
1. No `testOrders` at all → `RESULTS_PENDING` (explicit zero-order branch; do not let it fall through).
2. `testOrders.length > 0` AND every order `BILL_ONLY` → `{ kind: 'BILL_ONLY' }`.
3. `visit.status === 'COMPLETED' && versions.some(status === 'FINALIZED')` → `{ kind: 'FINALIZED', version: maxFinalizedVersionNum }`. **`version` = `max(versionNum)` among `status === 'FINALIZED'` versions only — never `versions.length`** (a partial release leaves a trailing DRAFT v_n+1, verified `diagnosticWorkflowService.ts:61-65`, so length/maxVersionNum point at the unpublished draft).
4. `versions.some(status === 'FINALIZED') && visit.status !== 'COMPLETED'` → `{ kind: 'PARTIALLY_FINALIZED', finalized: countFinalizedVersions, total: reportableOrEnternalOrderCount }` where `total` = `testOrders` with `workflowMode !== 'BILL_ONLY'`.
5. Any `workflowMode === 'EXTERNAL_UPLOAD'` and no FINALIZED version → `{ kind: 'EXTERNAL_UPLOAD_PENDING' }`.
6. Reportable orders exist, no FINALIZED version → `{ kind: 'RESULTS_PENDING' }`.

Gate "FINALIZED" on `status === COMPLETED && some(FINALIZED)` exactly like the helper — do NOT test "latest version is FINALIZED" (it is false after a partial release because the latest version is the trailing DRAFT).

`workflowMode` rollup: single mode if `testOrders` homogeneous, else `'MIXED'`. `reportState` reads raw `testOrders`, never the rolled-up `workflowMode`.

**N+1:** none — pure, from included data.

### Step 6 — Routes
**File:** `health-hub-backend/src/routes/patients.ts:108-126`.

- Keep the existing `GET /:id/360` route; point it at the refactored legacy assembler (Step 8).
- Add `GET /:id/360/summary` → `getPatient360Summary`.
- Add `GET /:id/360/timeline` → parse/validate query (Step 3), call `getPatient360Timeline`. Echo `appliedFilters` (the coerced values, including clamped `pageSize`).

Both new routes wrapped in `authMiddleware + branchContextMiddleware` (same as existing).

### Step 7 — Frontend types
**File:** `health-hub/src/types/index.ts:524-565`. Additive only (see §6). Ship in the same change so TS consumers compile.

### Step 8 — Legacy `/360` compat refactor
**File:** `health-hub-backend/src/services/patientService.ts:306-456`.

**Keep the current single-query implementation for `/360`.** Do NOT route legacy through the paginated path (that would reload all visits AND run the 3 batched lookups per page — strictly more work than today and regresses large patients). The only change to `getPatient360View`: add `transactions: { select: { paymentType: true }, orderBy: { transactionDate: 'desc' } }` to the existing `bill` select so `paymentType` resolves (fixes the undefined bug). Because the legacy mapper expects a single `latestVersion`, keep deriving `reportStatus`/`reportVersionId`/`finalizedAt` from `versions[0]` — the current `take:1` on versions stays in the legacy query (it is independent of `TIMELINE_INCLUDE`).

---

## 4. DUE-CALC SPEC

**Authoritative source, reused verbatim:** `computeBillFinancialsFromPersisted` (`health-hub-backend/src/services/billFinancialService.ts:71-106`). Do NOT re-derive the formula.

Per bill: `net = max(0, total − discount)`; `paid` = sum of `transactions[].amountInPaise` when the array is non-empty, else cached `bill.paidAmountInPaise` (lines 85-91); `due = max(0, net − paid)` (line 93). The cached `paidAmountInPaise` is authoritative on its own because of the documented sync invariant (`billFinancialService.ts:60-70`) — so the **glance** due query omits the `transactions` join to avoid N+1.

**FAILED:** there is no `paymentStatus` field on `PaymentTransaction` (verified), so a failed *capture* never produces a transaction row and never inflates `paidAmountInPaise`. "FAILED don't count as paid" holds by construction.

**REFUNDED:** `computeBillFinancialsFromPersisted` is refund-unaware (verified: returns only PENDING/PAID, lines 103-104). Refunds are excluded from due in two enforced places:
1. **Glance query** excludes them: `paymentStatus: { notIn: ['PAID', 'REFUNDED'] }`.
2. **Timeline item mapping** (Step 1) forces `dueAmountInPaise = 0` when `bill.paymentStatus === 'REFUNDED'` (so a refunded bill rendered in an `includeCancelled`/unfiltered page never shows a fabricated due, and the timeline always sums to the glance).

**CANCELLED:** excluded everywhere from money — the glance query filters `visit.status != CANCELLED`, and Step 1 forces `dueAmountInPaise = 0` for cancelled visits even when shown via `includeCancelled=true`.

**Glance due query (single fetch, bounded per patient, then JS reduce):**
```ts
const bills = await prisma.bill.findMany({
  where: {
    visit: { patientId, status: { not: 'CANCELLED' } },
    paymentStatus: { notIn: ['PAID', 'REFUNDED'] },
  },
  select: { totalAmountInPaise: true, discountAmountInPaise: true, paidAmountInPaise: true },
});
const outstandingDueInPaise = bills.reduce(
  (s, b) => s + computeBillFinancialsFromPersisted(b).dueAmountInPaise, 0);
```

**Invariant the two predicates must share:** `unpaidOnly` (timeline) and the glance due query both use `paymentStatus notIn [PAID, REFUNDED]`. They must stay identical so `unpaidOnly` returns exactly the visit set whose dues sum to the glance number.

---

## 5. SCHEMA / MIGRATIONS

**No schema migration is required for correctness.** Every field the frontend needs already exists (`PaymentTransaction.paymentType`, `Bill.discount*`, `Bill.paidAmountInPaise`) — they were under-selected, fixed in the `include`/`select`. Verified existing indexes cover all access paths:

- `Visit @@index([createdAt])`, `@@index([domain])`, `@@index([status])`, `@@index([branchId])`, `@@index([patientId])` — filters + cursor seek.
- `Bill @@index([paymentStatus])` — `unpaidOnly`.
- `MessageLog @@index([contextType, contextId])` — delivery batched lookup.
- `TestResult @@index([reportVersionId])` — abnormal existence lookup.
- `waMessageId` is already persisted immediately after `sendTemplate` (`notificationService.ts:194`). Patient360 only READS MessageLog — **no change to the send path, no migration.**

**RECOMMENDED optional index (perf, not correctness):**
```prisma
// Visit model
@@index([patientId, createdAt])
```
Every timeline page and every glance count filters on `patientId` first, and the keyset cursor sorts by `createdAt desc`. Without this composite, Postgres seeks the global `@@index([createdAt])` and filters `patientId` — costly on a busy multi-tenant DB. This is the single highest-value index for the feature. Ship it with the feature unless EXPLAIN on a large patient proves the single-column indexes suffice. It is a pure additive index (`prisma migrate` with no data change), safe to deploy ahead of the code.

---

## 6. TYPE CHANGES

**File:** `health-hub/src/types/index.ts`. All additive; nothing renamed or removed. Existing `VisitTimelineItem` flat discount fields (`discountAmountInPaise`, `discountType`, `discountPercentage`, `discountReason`), `paidAmountInPaise`, `netAmountInPaise`, `dueAmountInPaise`, and `transactions?` are already declared (lines 524-557) — they simply become populated. Add:

```ts
export type ReportState =
  | { kind: 'FINALIZED'; version: number }
  | { kind: 'PARTIALLY_FINALIZED'; finalized: number; total: number }
  | { kind: 'BILL_ONLY' }
  | { kind: 'EXTERNAL_UPLOAD_PENDING' }
  | { kind: 'RESULTS_PENDING' }
  | null;

export type VisitWorkflowMode = 'REPORTABLE' | 'BILL_ONLY' | 'EXTERNAL_UPLOAD' | 'MIXED';

export interface VisitDelivery {
  status: 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
  sentAt: string | null;
  deliveredAt: string | null;
  readAt: string | null;
}

export interface VisitDiscount {
  amount: number;                                  // discountAmountInPaise
  type: 'FLAT_AMOUNT' | 'PERCENTAGE' | null;
  reason: string | null;
}

// EXTEND VisitTimelineItem (all optional → old clients ignore them):
//   reportState?: ReportState;
//   hasAbnormalResults?: boolean;   // BOOLEAN ONLY — no values/test names
//   workflowMode?: VisitWorkflowMode;
//   delivery?: VisitDelivery | null;
//   discount?: VisitDiscount;       // nested; flat fields retained for compat

export interface Patient360Glance {
  outstandingDueInPaise: number;
  totalVisits: number;
  totalVisitsIncludingCancelled: number;
  lastVisit: { visitId: string; domain: VisitDomain; branchName: string; createdAt: string } | null;
  reportCounts: { finalized: number; notFinalized: number; billOnly: number };
}

export interface Patient360Summary {
  patient: Patient;
  glance: Patient360Glance;
  branches: { id: string; name: string }[];
}

export interface Patient360TimelinePage {
  items: VisitTimelineItem[];
  pageInfo: { nextCursor: string | null; hasMore: boolean; pageSize: number };
  appliedFilters: {
    domain: VisitDomain | null; from: string | null; to: string | null;
    branchId: string | null; unpaidOnly: boolean; includeCancelled: boolean;
  };
}
```

`Patient360View` (lines 560-565) is left exactly as-is for the legacy endpoint.

---

## 7. BACKWARD-COMPAT & ROLLOUT

1. **Legacy `/360` stays byte-compatible AND keeps its current single-query path** (Step 8). It is not routed through pagination, so large patients do not regress. Its `visitTimeline` items gain a correctly-populated `paymentType` (previously `undefined` due to the select bug) plus the now-populated discount/paid/due fields — all additive on the object; existing readers of `paymentStatus`/`billedAt`/`status` are unaffected. Confirm no legacy consumer branches on `paymentType === undefined` vs `null` (low risk; the frontend type already declares `paymentType?: PaymentType | null`).
2. **New endpoints are additive routes** — no existing route signature changes. Old web/mobile builds keep working against `/360`.
3. **Incremental adoption:** the new frontend can ship the glance strip (summary endpoint) first and migrate the timeline later; `/360` continues to serve the full list until then.
4. **Field additivity:** all new `VisitTimelineItem` fields are optional; flat discount fields are retained alongside the nested `discount` object so nothing breaks for deployed clients. Type edits (§6) ship in the same PR as the backend so TS compiles.
5. **Deprecation (non-blocking, future cycle):** once the frontend fully moves to summary+timeline, mark `/360` deprecated. Not done now.

---

## 8. VERIFICATION PLAN

### Build / typecheck
```bash
# backend
cd "/Users/pranavreddy/Desktop/sobhana portal/health-hub-backend" && npx tsc --noEmit
# frontend types
cd "/Users/pranavreddy/Desktop/sobhana portal/health-hub" && npx tsc --noEmit
# if the optional index is added:
cd "/Users/pranavreddy/Desktop/sobhana portal/health-hub-backend" && npx prisma validate && npx prisma migrate dev --name patient360_patientid_createdat_index
```

### Due-number correctness against known bills
Seed (or pick from a dev DB) a patient with one PENDING, one PAID, one REFUNDED, one CANCELLED, and one PARTIALLY-paid bill. Then assert the endpoint matches a hand-computed control:
```bash
PID=<patientId>
# control: sum of (net - paid) over non-cancelled, non-PAID, non-REFUNDED bills via raw SQL
psql "$DATABASE_URL" -c "
  SELECT COALESCE(SUM(GREATEST(0,(b.\"totalAmountInPaise\"-b.\"discountAmountInPaise\")-b.\"paidAmountInPaise\")),0) AS expected_due
  FROM \"Bill\" b JOIN \"Visit\" v ON v.id=b.\"visitId\"
  WHERE v.\"patientId\"='$PID' AND v.status<>'CANCELLED' AND b.\"paymentStatus\" NOT IN ('PAID','REFUNDED');"
# actual:
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/api/patients/$PID/360/summary" | jq '.glance.outstandingDueInPaise'
```
`expected_due` must equal `outstandingDueInPaise`. Add a Jest unit test calling `getPatient360Summary` against a seeded fixture asserting the same, plus a test that a REFUNDED bill in the timeline returns `dueAmountInPaise: 0` and `unpaidOnly` returns exactly the PENDING-visit set.

### No-N+1 confirmation (query counts)
Enable Prisma query logging and count queries per request:
```ts
const prisma = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
let n = 0; prisma.$on('query', () => n++);
```
- `getPatient360Summary`: assert ≤ 1 round-trip (the `$transaction([...])` batch) regardless of visit count.
- `getPatient360Timeline` (page with no revisits): assert **exactly 3** queries (visit page, abnormal batch, delivery batch) for `pageSize=20` AND `pageSize=50` — the count must NOT scale with page size. Add a fixture with revisits and assert exactly 4.
Alternatively, run against a logging DB and grep the count:
```bash
DEBUG=prisma:query node dist/...  # then count "SELECT" lines per request
```

### Pagination correctness
- **Timestamp ties:** seed ≥3 visits with identical `createdAt` straddling a `pageSize=2` boundary. Page through with the returned `nextCursor`; assert the union of pages has no duplicate and no missing `visitId` (set equality against `SELECT id FROM "Visit" WHERE "patientId"=...`).
- **Exhaustion:** last page returns `nextCursor: null`, `hasMore: false`.
- **Glance stable after load-older (explicit scope requirement):** call `/summary`, page the entire timeline, call `/summary` again — assert the two glance objects are byte-identical.
- **Filter-change resets cursor (contract):** document/test that supplying a cursor from an unfiltered page with `domain=CLINIC` is unsupported; the frontend integration test must drop the cursor on filter change.

### Per-field smoke test
Seed visits covering each branch and assert via `curl ... /timeline | jq`:
- **reportState — partial release:** visit with v1 FINALIZED + v2 DRAFT, status WAITING → `{ kind: 'PARTIALLY_FINALIZED', finalized: 1, total: <Y> }` and a separate COMPLETED visit that had a mid-way partial → `{ kind: 'FINALIZED', version: 1 }` (v{n} points at the finalized v1, NOT the trailing DRAFT).
- **reportState — zero-order diagnostic visit** → `RESULTS_PENDING` (not undefined).
- **reportState — external-upload-only, not finalized** → `EXTERNAL_UPLOAD_PENDING`; **all-BILL_ONLY** → `BILL_ONLY`; **mixed REPORTABLE+EXTERNAL** → `workflowMode: 'MIXED'` while `reportState` still reflects the raw orders.
- **hasAbnormalResults privacy:** a visit with a CRITICAL_HIGH result → `hasAbnormalResults: true`; assert the response JSON contains NO `value`/`textValue`/`flag`/test-name keys anywhere; a visit whose old DRAFT was HIGH but current FINALIZED is NORMAL → `false`.
- **paymentType:** visit with a CASH then ONLINE transaction → `paymentType: 'ONLINE'` (latest); `/360` legacy also now returns it (regression check for the undefined bug).
- **delivery:** diagnostic visit with a READ MessageLog → `delivery.status: 'READ'` with timestamps; clinic visit → `delivery: null`.

### Perf / EXPLAIN on a large patient
Seed (or identify) a patient with 500+ visits and many report MessageLogs, then:
```bash
psql "$DATABASE_URL" -c "EXPLAIN ANALYZE SELECT * FROM \"Visit\" WHERE \"patientId\"='$PID' AND status<>'CANCELLED' ORDER BY \"createdAt\" DESC, id DESC LIMIT 21;"
```
Confirm it uses `Visit_patientId_createdAt_idx` (if added) rather than a global `createdAt` index-scan + filter. Also EXPLAIN the delivery query (`contextType='REPORT' AND contextId IN (...) ORDER BY createdAt DESC`) and the `finalized` count subquery (`report.versions.some(FINALIZED)`) to validate the §5 index decision before shipping.

---

## 9. RISKS / OPEN QUESTIONS FOR THE OWNER

1. **"Unpaid" definition.** Implemented as `paymentStatus notIn [PAID, REFUNDED]` (matches glance due exactly, indexed). If the owner wants `unpaidOnly` to mean live-computed `due > 0` regardless of stored status, that cannot be pushed into SQL cleanly — it would require post-assembly JS filtering and would break exact page sizing. Recommend keeping the persisted-status definition.
2. **Glance `reportCounts.notFinalized` semantics.** It is `diagnosticTotal − finalized − billOnly`, so it includes in-flight partially-finalized visits — it is NOT the per-visit `RESULTS_PENDING` count. Confirm the glance label reads "not yet finalized," not "results pending."
3. **`hasAbnormalResults` scope.** Computed over FINALIZED versions only (a corrected report won't false-flag). Confirm abnormal should not surface for DRAFT/partial results.
4. **Delivery channel.** Only REPORT-context MessageLog (report-ready WhatsApp) is surfaced; bill-receipt delivery (`contextType='BILL'`, `contextId=billId`) is out of scope. Clinic visits therefore always show `delivery: null`. Confirm that is acceptable to the frontend, or scope-in BILL delivery as a 4th batched query.
5. **`workflowMode` rollup.** Visit-level (`MIXED` when heterogeneous). Per-order modes are available in the include if the inspector later needs them.
6. **Optional `@@index([patientId, createdAt])`.** Recommended to ship with the feature; the only open question is whether the team prefers to gate it behind an EXPLAIN result on production-scale data first.
7. **`totalVisits` header count.** Both non-cancelled and cancelled-inclusive counts are returned; confirm the header should display the non-cancelled figure.


---

## 10. ADDENDUM — Smart-search entry page (GlobalPatientSearch)

Backend additions for the unified smart search bar (replaces the phone/name toggle). Phone / name / email already work via `searchPatients` (`patientService.ts:228-281`, which delegates to `patientMatching.findPatientsByIdentifier`). Two additions:

### 10a. Patient-ID (patientNumber) search — [small]
**Files:** `health-hub-backend/src/routes/patients.ts:58` (the `/search` handler) + `searchPatients` (`patientService.ts:228`).
- Add `patientNumber?: string` to the `searchPatients` query type and to the route's `req.query` destructure (line 58 currently reads `{ phone, email, name, limit }`).
- `patientNumber` is an exact/unique key, so do NOT route it through fuzzy `findPatientsByIdentifier`. Branch: if `patientNumber` is present, run a direct `prisma.patient.findUnique({ where: { patientNumber }, include: { identifiers, visits: { include: { branch }, orderBy createdAt desc } } })` and map it into the **same** search-result shape (`{ patient, historySnapshot, totalVisits }`) the existing code returns (lines 255-280) — reuse `getPatientAge`/`getPatientAgeDisplay`. Return `[]` (not 404) when no match, so the frontend shows the same "no match → register" state.
- **N+1:** none (single findUnique).

### 10b. Bill-number lookup → resolve to patient + visit — [small]
**Files:** new handler in `health-hub-backend/src/routes/patients.ts` (e.g. `GET /api/patients/by-bill/:billNumber`) or co-locate in `bills.ts`.
- A bill number identifies ONE visit, not a patient. Look up the visit by its bill number. `billNumber` lives on both `Visit.billNumber` and `Bill.billNumber` (seen in `bills.ts`); query `prisma.visit.findFirst({ where: { OR: [{ billNumber }, { bill: { is: { billNumber } } }] }, include: { patient: { include: { identifiers } }, branch, bill: { select: { paymentStatus, totalAmountInPaise, billedAt } } } })`.
- Response shape (powers wireframe Frame 3 — "Open visit in Patient 360"):
  ```jsonc
  {
    "patient": { "id": "...", "patientNumber": "...", "name": "...", "ageDisplay": "...", "gender": "..." },
    "visit":   { "visitId": "...", "domain": "DIAGNOSTICS", "branchName": "MPR",
                 "createdAt": "...", "billNumber": "MPR-2231",
                 "totalAmountInPaise": 240000, "paymentStatus": "PAID" }
  }
  ```
- **Uniqueness caveat (verify):** confirm whether `billNumber` is globally unique or per-branch. If not globally unique, return the best/most-recent match and flag ambiguity (or return a short list). Validate against the schema before building. **Open question O8.**
- **N+1:** none (single findFirst with includes).

### 10c. Frontend type-detection (no backend)
Detection runs client-side before choosing which call to make: `@`→email · `^P-?\d+`→patientNumber · branch-prefix+digits / leading `#`→bill lookup · all-digits len≥7→phone · else→name. **Decision: live type-ahead, debounced ~300ms** — debounce per keystroke; a wrong guess is one tap to override. Each detected type maps to: phone/name/email/patientNumber → `/patients/search`; bill → `/patients/by-bill/:billNumber`.

### 10d. Verification (search additions)
- `patientNumber` search: `curl ".../patients/search?patientNumber=P-01432"` → exactly that patient in search-result shape; unknown number → `[]`.
- Shared phone: `curl ".../patients/search?phone=<shared>"` → all family members (already works; smoke-test the disambiguation list).
- Bill lookup: `curl ".../patients/by-bill/MPR-2231"` → correct patient + visit; unknown → 404 (this one IS a 404, since the frontend treats it differently from a patient search miss).
- Debounce/type-ahead is a frontend concern — covered in the frontend plan, not here.


---

## 11. RECONCILIATION WITH FRONTEND PLAN (pre-execution)

The frontend plan (`06-frontend-plan.md`) was authored after this plan; these points are reconciled and BINDING for the build. They override any conflicting detail above.

1. **Branch header on the new endpoints — RESOLVED (verified in code).** `branchContextMiddleware` (`src/middleware/branch.ts:79-97`) uses the `x-branch-id` header when present and otherwise **falls back to `user.activeBranchId`** — the header is optional, a missing header does NOT 400. Therefore:
   - The new endpoints (`/patients/:id/360/summary`, `/360/timeline`) attach `authMiddleware + branchContextMiddleware` for auth + audit ONLY. **Their query `where` clauses MUST NOT reference `req.branchId`** — results are global/cross-branch (matching the existing `/360`).
   - The frontend calls them via `apiCall` (no `X-Branch-Id`); the middleware resolves `req.branchId` from the user for audit. Safe. This resolves frontend Q1.
   - Same for `/patients/search` (already global today) and the new `/patients/by-bill/:billNumber`.

2. **Response shapes are the canonical contract.** The §6 types here (`Patient360Summary`, `Patient360Glance`, `Patient360TimelinePage`, extended `VisitTimelineItem`, `ReportState`, `VisitDelivery`, `VisitDiscount`) and the §10b `BillLookupResult` (`{ patient, visit }`) are the source of truth. The frontend `types/index.ts` mirrors them exactly; the FE build reads the implemented backend to confirm. Do not rename fields without updating both.

3. **`reportState.version` = the max FINALIZED `versionNum`** (never the trailing DRAFT) — matches FE Q6 and §5 here.

4. **`ApiError{status}` is a frontend-only change** (FE Step 0, `src/lib/utils.ts`); no backend impact. Backend keeps returning JSON `{ error, message }` with proper HTTP status codes (already does), which is what the FE `ApiError` reads.

5. **Legacy `/360` stays** (with the `paymentType` select-bug fix) until the frontend fully migrates to summary + timeline; retained afterward for rollback. Not deleted in this work.

6. **Collect-payment route (FE Q5):** the inspector's "Collect payment" deep-link is a FRONTEND concern; backend exposes nothing new for it. If `/money/bills` can't take a visit filter, FE ships print-bill only — no backend change either way.
