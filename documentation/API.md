# API catalog

Index of every backend route file, what it covers, and the most important endpoints. This is **not** a generated OpenAPI spec — when one exists it will live alongside this and be authoritative for request/response shapes. Until then, treat the route source files as truth.

> Source: [`health-hub-backend/src/routes/`](../health-hub-backend/src/routes/) (27 files). Mounted in [`src/index.ts`](../health-hub-backend/src/index.ts).

---

## Conventions

- **Base URL:** `https://<your-backend-host>` (e.g. `http://localhost:10000` in dev). All `/api/*` endpoints listed below are relative to this base.
- **Auth:** every `/api/*` endpoint requires `Authorization: Bearer <jwt>` and `X-Branch-Id: <branchId>` headers, except `/api/auth/login`. Public routes (`/reports/:token`, `/webhooks/whatsapp`) are deliberately mounted before auth middleware.
- **Errors:** consistent JSON shape — `{ "error": "<MACHINE_CODE>", "message": "<human readable>", "requestId": "<uuid>" }`. Status codes follow REST conventions: 400 validation, 401 unauthenticated, 403 forbidden, 404 not found, 409 conflict (optimistic-lock failures), 500 internal.
- **Optimistic locks:** version-creating endpoints (`POST /clinical-definitions/:rootId/new-version`) accept `If-Match: <updatedAt>`. A mismatch returns 409.
- **Request IDs:** every response includes `X-Request-Id`. Echo this when reporting bugs — it ties the FE request to the BE Pino log line and Sentry event.
- **No pagination conventions yet** — list endpoints return all matching rows.

---

## Public routes (no auth)

| Path | Method | What it does | Source |
|---|---|---|---|
| `/health` | GET | Liveness + dependency probes (Postgres / Redis / R2 / Puppeteer). Returns 503 only when Postgres is unhealthy. | `index.ts` |
| `/reports/:token` | GET | Streams the merged report PDF for a finalized visit. Token is the SHA-256-hashed bearer issued at finalize time. Logs every access to `ReportAccessLog`. | `reportDownload.ts` |
| `/webhooks/whatsapp` | GET / POST | Meta Cloud API webhook. GET for token verification (`hub.verify_token`), POST for delivery callbacks. | `webhooks.ts` |
| `/` | GET | Returns `{status: "ok", service, timestamp}` — Render's port-detection probe. | `index.ts` |

---

## Authenticated routes

### Auth — `/api/auth`

| Method | Path | Purpose |
|---|---|---|
| POST | `/login` | `{ email, password }` → `{ token, user }`. Rate-limited; lockout via Redis on repeated failures. |
| POST | `/logout` | Optional — JWT stateless invalidation is via expiry, not server-side blacklist |
| GET | `/me` | Returns the current user from the JWT |

Source: [`auth.ts`](../health-hub-backend/src/routes/auth.ts) → service: `authService`.

### Patients — `/api/patients`

| Method | Path | Purpose |
|---|---|---|
| GET | `/search?phone=…&name=…&aadhar=…` | Cross-branch patient search; deduplication helper |
| POST | `/` | Create a patient (auto-generates `patientNumber`); writes `PatientChangeLog` |
| GET | `/:id` | Get patient + identifiers + visit summary |
| PATCH | `/:id` | Update demographics; writes `PatientChangeLog` for IDENTITY changes (name/age/gender) |
| GET | `/:id/visits` | All visits across branches (Patient 360) |

Source: [`patients.ts`](../health-hub-backend/src/routes/patients.ts) → service: `patientService`, `patientMatchingService`.

### Diagnostic visits — `/api/visits/diagnostic`

The hot file — 17 endpoints, ~3,900 LOC (see [DECISIONS ADR-015](DECISIONS.md)).

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List visits (queue / pending / finalized filters) |
| GET | `/:id` | Full visit detail: bill, test orders, results, panel grouping, `inputConfig` per test |
| POST | `/` | Create visit. Accepts `productIds` (new arch) or `testIds` (legacy). Creates Visit + Bill + TestOrders in one transaction. |
| PATCH | `/:id` | Update demographics linked to visit |
| POST | `/:id/tests` | Add tests to an existing draft visit |
| DELETE | `/:id/tests/:testOrderId` | Remove a test (rejected if it would create overpayment) |
| POST | `/:id/results` | Save test results. Recomputes flags. Marks `manualOverride` if a derived value is hand-entered. Also called by the result-entry page's auto-save (1.5 s debounce + on-blur). |
| POST | `/:id/collect-sample` | Mark sample as collected |
| POST | `/:id/collect-due` | Additive payment collection on outstanding due |
| POST | `/:id/confirm-ready` | Mark report as ready for staff review |
| POST | `/:id/finalize` | Finalize: snapshot + token + WhatsApp fanout. Blocked if `due > 0`. |
| POST | `/:id/release-partial` | Finalize the current DRAFT as a partial release and open a fresh DRAFT for remaining work. Optional body `{ testOrderIds: string[] }` scopes the release to a subset; unselected draft results are carried forward into the next DRAFT. Snapshots are scoped to the selection (results + external uploads). Without a body, falls back to legacy "release every draft result" behaviour. |
| POST | `/:id/refund` | Cancel test orders and refund overpayment. Whole-order cancellation voids each selected order's remaining charge off the bill, and returns overpaid amount as a REFUND ledger row. |
| POST | `/:id/swap-product` | Replace a mistakenly billed product with a SAME-PRICE one (typo fixes). Money-neutral by construction. |
| GET | `/:id/preview-report` | Returns the merged PDF as a blob (matches what the patient gets). Optional `?testOrderIds=a,b,c` (or repeated query params) scopes the preview to a subset, used by the partial-release selector so the preview matches what `release-partial` will ship byte-for-byte. |
| GET | `/:id/report-snapshot` | JSON snapshot for the in-app preview screen |
| GET | `/:id/finalized-report` | Staff-only HTML view of the latest finalized version |
| GET | `/:id/finalized-report/pdf` | Staff-only PDF of the latest finalized version (digital or physical mode) |

Source: [`diagnosticVisits.ts`](../health-hub-backend/src/routes/diagnosticVisits.ts) → services: `productOrderService`, `billFinancialService`, `referenceRangeService`, `derivedParameterService`, `reportSnapshotService`, `reportRendererService`, `pdfGenerationService`, `mergedReportPdfService`, `notificationService`, `payoutService`.

### Clinic visits — `/api/visits/clinic`

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Visit queue per branch, filtered by status |
| GET | `/:id` | Full clinic visit detail |
| POST | `/` | Create visit (OP / IP) with consultation fee |
| PATCH | `/:id` | Update visit status (WAITING → IN_PROGRESS → COMPLETED) |
| POST | `/:id/revisit` | Create a follow-up visit linked to original via `originalVisitId` |

Source: [`clinicVisits.ts`](../health-hub-backend/src/routes/clinicVisits.ts).

### Bills — `/api/bills`

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List bills with filters |
| GET | `/:id` | Bill detail with payment transactions |
| POST | `/:id/payments` | Add a payment transaction |
| GET | `/view/:token` | Public, token-gated inline PDF download (WhatsApp in-app browser compatible) |

Source: [`bills.ts`](../health-hub-backend/src/routes/bills.ts) → service: `billFinancialService`.

### Reports — `/api/reports`

| Method | Path | Purpose |
|---|---|---|
| GET | `/:visitId` | List report versions for a visit |
| GET | `/version/:versionId` | Get a specific report version (with snapshot) |

Source: [`reports.ts`](../health-hub-backend/src/routes/reports.ts).

### Clinical Definitions — `/api/clinical-definitions`

Versioned `TestDefinition` CRUD (clone-on-edit).

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List latest active definitions (filterable by department, status, code) |
| GET | `/check-code?code=…` | Real-time uniqueness check for new test codes |
| GET | `/:id` | Get specific version detail (ranges + interpretation rules + panel usages) |
| GET | `/:rootId/versions` | All versions of a definition |
| POST | `/` | Create v1 |
| POST | `/:rootId/new-version` | Clone-on-edit. **Requires `If-Match: <updatedAt>` header.** Returns 409 on conflict. |
| PATCH | `/:id/status` | Transition status (ACTIVE → LOCKED → DEPRECATED → ARCHIVED) |
| PATCH | `/:id/toggle-visibility` | Hide/show in clinical forms (doesn't change versioning) |
| GET | `/:rootId/impact` | Impact analysis (where is this used) |
| GET | `/:rootId/dependents` | Tests whose formulas reference this test's code |
| POST | `/:id/preview` | Sandbox: pass a test value, see resolved range + interpretation |
| DELETE | `/:rootId` | Soft-delete (archive) all versions; rejected if panel items still reference it |

Source: [`clinicalDefinitions.ts`](../health-hub-backend/src/routes/clinicalDefinitions.ts) → service: `clinicalDefinitionService`.

### Clinical Panels — `/api/clinical-panels`

`ClinicalPanel` + `ClinicalPanelItem` CRUD (the report rendering layout layer).

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List panels |
| GET | `/:id` | Panel + items |
| POST | `/` | Create panel |
| PUT | `/:id` | Update panel + items (item ordering, subgroups, indents, methods) |
| DELETE | `/:id` | Delete panel |

Source: [`clinicalPanels.ts`](../health-hub-backend/src/routes/clinicalPanels.ts).

### Test Input Configs — `/api/test-input-configs`

Per-test entry-time UI configuration (input type, default value, presets). Sibling table to `TestDefinition` — see [DECISIONS ADR-013](DECISIONS.md).

| Method | Path | Purpose |
|---|---|---|
| GET | `/:rootDefinitionId` | Get config for a test (returns defaults if no row exists) |
| GET | `/?rootIds=a,b,c` | Bulk fetch by comma-separated root IDs |
| PUT | `/:rootDefinitionId` | Upsert. Body: `{ inputType, defaultValue, valueOptions }`. Validates inputType enum and dedups options. |

Source: [`testInputConfigs.ts`](../health-hub-backend/src/routes/testInputConfigs.ts).

### Billable Products — `/api/billable-products`

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List products (filterable by branch, active, workflow mode) |
| GET | `/:id` | Product + linked panels + branch pricing |
| POST | `/` | Create product (single test or bundle) |
| PUT | `/:id` | Update (now supports updating `code` with validation and uniqueness checks; returns 409 on conflict) |
| PATCH | `/:id/toggle-active` | Soft enable/disable |
| DELETE | `/:id` | Delete |

Source: [`billableProducts.ts`](../health-hub-backend/src/routes/billableProducts.ts).

### Users — `/api/users`

Owner-only user management, globally scoped (not branch-scoped).

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List team members |
| PATCH | `/:id/role` | Change a member's role (staff, lab_incharge, sales) |

Source: [`users.ts`](../health-hub-backend/src/routes/users.ts).

### External Uploads — `/api/external-uploads`

PDF uploads for `EXTERNAL_UPLOAD` workflow mode (e.g. outsourced reports).

| Method | Path | Purpose |
|---|---|---|
| POST | `/` | Multipart upload to R2; writes `ExternalReportUpload` row |
| GET | `/by-visit/:visitId` | List uploads for a visit |
| GET | `/:id` | Get metadata + signed URL |
| DELETE | `/:id` | Soft-delete (sets `deletedAt`) |

Source: [`externalUploads.ts`](../health-hub-backend/src/routes/externalUploads.ts).

### Doctors — `/api/referral-doctors`, `/api/clinic-doctors`, `/api/doctors`, `/api/signing-doctors`, `/api/signing-rules`

| Path | Purpose |
|---|---|
| `/api/referral-doctors` | External referrer CRUD; commission rules per product |
| `/api/clinic-doctors` | In-house consulting doctor CRUD |
| `/api/doctors` | Cross-search (referral + clinic) for visit creation |
| `/api/signing-doctors` | Signing-doctor CRUD + signature image upload |
| `/api/signing-rules` | Department → signing-doctor assignment |

Sources: `referralDoctors.ts`, `clinicDoctors.ts`, `doctors.ts`, `signingDoctors.ts`, `signingRules.ts` → service: `signingDoctorService`.

### External Labs — `/api/external-labs`

Outside lab management for outsourced tests and their specific payout rules.

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List outside labs |
| GET | `/:id` | Single outside lab detail |
| POST | `/` | Create outside lab |
| PATCH | `/:id` | Update outside lab |
| DELETE | `/:id` | Deactivate outside lab |

Source: [`externalLabs.ts`](../health-hub-backend/src/routes/externalLabs.ts).

### Diagnostic Centers — `/api/diagnostic-centers`

External diagnostic centers (referred-to / referred-from). CRUD + per-product commission rules.

Source: [`diagnosticCenters.ts`](../health-hub-backend/src/routes/diagnosticCenters.ts).

### Departments — `/api/departments`

`Department` CRUD (used as report-section headers and signing-rule scopes).

Source: [`departments.ts`](../health-hub-backend/src/routes/departments.ts).

### Branches — `/api/branches`

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List branches the current user can access |
| POST | `/switch` | Update `User.activeBranchId` (used by FE branch switcher) |

Source: [`branches.ts`](../health-hub-backend/src/routes/branches.ts).

### Payouts — `/api/payouts`

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | List payout ledger entries (filter by doctor, period) |
| GET | `/:id` | Detail with derivation breakdown |
| POST | `/derive` | Re-derive payouts for a period (idempotent — refreshes `DoctorPayoutLedger`) |
| POST | `/:id/mark-paid` | Mark as paid (immutable thereafter) |
| POST | `/:id/send-statement` | WhatsApp the statement to the payee |

Source: [`payouts.ts`](../health-hub-backend/src/routes/payouts.ts) → service: `payoutService`.

### Audit Logs — `/api/audit-logs`

Read-only browse of `AuditLog`. Owner-only.

Source: [`auditLogs.ts`](../health-hub-backend/src/routes/auditLogs.ts).

### Messages — `/api/messages`

Read-only browse of `MessageLog` (WhatsApp delivery). Owner-only.

Source: [`messages.ts`](../health-hub-backend/src/routes/messages.ts).

### Owner Dashboard — `/api/owner`

Aggregated metrics for the owner dashboard (visits per day, revenue, payouts owed, etc.). Owner-only.

Source: [`ownerDashboard.ts`](../health-hub-backend/src/routes/ownerDashboard.ts) → service: `ownerDashboardService`.

### Report Download — `/api/reports`

Internal report-rendering endpoints used by the FE preview screen. Public-facing PDF download is via the unauthenticated `/reports/:token` route, not here.

Source: [`reportDownload.ts`](../health-hub-backend/src/routes/reportDownload.ts).

---

## Legacy / superseded

These exist but are being phased out. New code should not depend on them:

- **`/api/lab-tests`** ([`labTests.ts`](../health-hub-backend/src/routes/labTests.ts)) — original `LabTest` model. Replaced by `clinical-definitions` + `clinical-panels` + `billable-products`. Currently mounted only conditionally (the import is commented out in `index.ts`).
- **`/api/panels`** ([`panels.ts`](../health-hub-backend/src/routes/panels.ts)) — original `PanelDefinition`. Replaced by `clinical-panels`. Mount commented out.

`TestOrder` and `TestResult` carry **dual FKs** during this migration: `testId` (legacy) and `testDefinitionId` (new). Code branches on which is present. See [`DECISIONS.md`](DECISIONS.md) ADR-015 for the dual-FK exit plan.

---

## Things this catalog doesn't yet have

- Request and response schemas — full payload shapes. Will land when we generate OpenAPI from the backend.
- Per-endpoint role / permission matrix — currently inferred from `requireRole(...)` calls inline in each route file.
- Per-endpoint rate-limit configuration — currently only login is rate-limited.

When OpenAPI / tRPC / Pact lands ([`DECISIONS.md`](DECISIONS.md) — tracked debts), this file becomes a curated index pointing at the generated spec.
