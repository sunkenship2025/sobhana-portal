# Architecture

System design, data flow, and the rationale behind structural decisions.

For change rationale (why X was chosen) see [`DECISIONS.md`](DECISIONS.md). For operational procedures see [`runbooks/`](runbooks/).

---

## Contents

1. [System overview](#1-system-overview)
2. [Component diagram](#2-component-diagram)
3. [Backend architecture](#3-backend-architecture)
4. [Frontend architecture](#4-frontend-architecture)
5. [Database schema](#5-database-schema)
6. [Critical data flows](#6-critical-data-flows)
7. [Security model](#7-security-model)
8. [Infrastructure & deployment](#8-infrastructure--deployment)
9. [Known architectural debts](#9-known-architectural-debts)

---

## 1. System overview

A **multi-branch, role-based** healthcare portal for diagnostics and clinic visits. One Postgres instance serves all branches; isolation is enforced at the application layer via `branchId` filtering on every query.

**Roles** (`UserRole` enum in `prisma/schema.prisma`):

| Role | Capabilities |
|---|---|
| `staff` | Register patients, create bills/visits, enter results, finalize reports |
| `lab_incharge` | Review finalized reports, sign reports |
| `sales` | Manage outside labs and referral doctors |
| `owner` | Everything `staff`, `lab_incharge` and `sales` can do, plus payouts, audit logs, test catalog |
| `admin` | Reserved — used for cross-branch admin tooling |

**Domains**

- **Diagnostics** — lab work: register → order tests → enter results → finalize → deliver via WhatsApp
- **Clinic** — outpatient/inpatient consultations, prescription printing
- **Owner** — catalog, payouts, audit, signing-doctor configuration
- **Public** — token-protected report download (no login)

---

## 2. Component diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                  Browser (lab tech / doctor / owner)                 │
│                                                                      │
│  React 18 + TypeScript     Zustand stores (localStorage-persisted)   │
│  Vite dev server / build   ├─ authStore   ← JWT + user               │
│  React Router 6            ├─ branchStore ← active branch ID         │
│  Tailwind + shadcn/ui      └─ appStore                               │
└────────────────────────────────┬─────────────────────────────────────┘
                                 │ HTTPS
                                 │ Authorization: Bearer <JWT>
                                 │ X-Branch-Id: <branchId>
                                 │ X-Request-Id (echoed back)
                                 ▼
┌──────────────────────────────────────────────────────────────────────┐
│              Express API server (Node 20, TypeScript)                │
│                Render Docker container — system Chromium             │
│                                                                      │
│  Middleware chain                                                    │
│  ─ requestId → pino-http → helmet → CORS → no-store → json           │
│  ─ authMiddleware → branchContextMiddleware → route → rbac (inline)  │
│                                                                      │
│  27 route modules @ /api/*           28 services (business logic)    │
│  ─ auth, patients, visits/diagnostic, ─ patientService, billFinancialService
│    visits/clinic, bills, payouts,        productOrderService, payoutService,
│    clinical-definitions, clinical-       reportSnapshotService, reportRendererService,
│    panels, billable-products,            pdfGenerationService, mergedReportPdfService,
│    test-input-configs, external-         notificationService, whatsappService,
│    uploads, reports, …                   referenceRangeService, …
│                                                                      │
│  Public routes (no auth):                                            │
│  ─ GET  /reports/:token   ← patient PDF download                     │
│  ─ POST /webhooks/whatsapp ← Meta delivery callbacks                 │
└────┬───────────────┬──────────────┬──────────────┬─────────────┬─────┘
     │               │              │              │             │
     ▼               ▼              ▼              ▼             ▼
┌─────────┐    ┌──────────┐  ┌────────────┐ ┌──────────┐ ┌─────────────┐
│ Prisma  │    │  Redis   │  │   R2       │ │ Puppeteer│ │ WhatsApp    │
│ ORM     │    │ (ioredis)│  │(Cloudflare)│ │ Chromium │ │ Cloud API   │
│         │    │ rate-lim │  │ external   │ │ singleton│ │ (Meta Graph)│
│         │    │ lockout  │  │ uploads    │ │ + pdf-lib│ │             │
│         │    │ cache    │  │            │ │          │ │             │
└────┬────┘    └──────────┘  └────────────┘ └──────────┘ └─────────────┘
     ▼
┌─────────────────┐
│  PostgreSQL     │
│  Neon           │
│  47 models      │
└─────────────────┘
```

---

## 3. Backend architecture

### 3.1 Entry point — [`src/index.ts`](../health-hub-backend/src/index.ts)

In order:

1. **`dotenv.config()`** → loads `.env`.
2. `app.set('trust proxy', true)` — Render's load balancer sets `X-Forwarded-For`; without trust proxy, Express logs the wrong client IP and rate limiting breaks.
3. **Request-ID middleware** — assigns or echoes a UUID per request. Available as `req.requestId` and exposed in the `X-Request-Id` response header.
4. **Pino HTTP** — auto-logs every request as structured JSON. Skips `/health` / `/healthz` to avoid drowning the log stream in health probes.
5. **Helmet** — security headers. CSP currently disabled (`contentSecurityPolicy: false`) — see [Known architectural debts](#9-known-architectural-debts).
6. **CORS** — origin allowlist from `FRONTEND_URL` (comma-separated). Empty/unset → allow all (dev only). Headers explicitly include `Authorization`, `X-Branch-Id`, `If-Match`, `Cache-Control`.
7. **No-store cache headers** for all `/api/*` responses — prevents Arc/Safari caching bugs.
8. **`express.json()`** body parser.
9. **Routes** — auth-protected `/api/*` and public `/reports/:token`, `/webhooks/whatsapp`.
10. **Global error handler** — converts custom errors (`ValidationError`, `NotFoundError`, etc. from [`utils/errors.ts`](../health-hub-backend/src/utils/errors.ts)) to JSON with stable `error` / `message` / `requestId` shape. Tags Sentry with the request ID before reporting.
11. **Puppeteer warmup** — `warmupPdfService()` opens a Chromium process at startup so the first PDF render isn't a 2-3 s cold start.
12. **Graceful shutdown** — SIGTERM/SIGINT → close Puppeteer, close Redis, disconnect Prisma, exit.

### 3.2 Middleware

| File | Role |
|---|---|
| [`middleware/requestId.ts`](../health-hub-backend/src/middleware/requestId.ts) | Generates / echoes `X-Request-Id` |
| [`middleware/auth.ts`](../health-hub-backend/src/middleware/auth.ts) | Verifies JWT, sets `req.user = { id, email, role }` |
| [`middleware/branch.ts`](../health-hub-backend/src/middleware/branch.ts) | Reads `X-Branch-Id`, validates, sets `req.branchId` |
| [`middleware/rbac.ts`](../health-hub-backend/src/middleware/rbac.ts) | `requireRole('owner', 'staff')` factory |
| [`middleware/rateLimit.ts`](../health-hub-backend/src/middleware/rateLimit.ts) | Redis-backed rate limit (login + sensitive endpoints) |

### 3.3 Routes layer

27 files in [`src/routes/`](../health-hub-backend/src/routes/), one per resource. The biggest files have absorbed business logic that should live in services:

| Route file | LOC | Notes |
|---|---|---|
| `diagnosticVisits.ts` | ~3,800 | Visit lifecycle, results, finalize, snapshot. Hot spot — see [DECISIONS.md ADR-013](DECISIONS.md). |
| `clinicVisits.ts` | ~1,000 | Clinic visit lifecycle, queue, revisit logic |
| `labTests.ts` | ~640 | **Legacy** — superseded by `clinicalDefinitions` + `clinicalPanels` + `billableProducts`. Mounted only conditionally. |
| `patients.ts` | ~600 | Patient CRUD, identifier mgmt, deduplication |
| `clinicalDefinitions.ts` | ~360 | Versioned `TestDefinition` CRUD (clone-on-edit) |
| `clinicalPanels.ts` | ~500 | Panel definitions for report layout |
| `billableProducts.ts` | ~600 | Commercial-layer products (decoupled from clinical) |
| `testInputConfigs.ts` | ~140 | Entry-time UI config (presets, default values, input type) |
| `externalUploads.ts` | ~450 | PDF uploads to R2 for EXTERNAL_UPLOAD workflow |

### 3.4 Services layer

28 files in [`src/services/`](../health-hub-backend/src/services/) — all business logic. Routes are *thin*: extract input → call service(s) → return JSON.

| Service | Responsibility |
|---|---|
| `authService` | Login, JWT issuance, audit logging |
| `patientService`, `patientMatchingService` | Patient CRUD, deduplication |
| `numberService` | Sequential per-branch numbering (bills, patient IDs) |
| `billFinancialService` | Discount, partial payment, due computation |
| `productOrderService` | Maps `BillableProduct` → `ClinicalPanel` → `TestDefinition` at visit creation |
| `clinicalDefinitionService` | Clone-on-edit versioning of `TestDefinition` |
| `referenceRangeService` | Resolves the right reference range for patient age/gender |
| `derivedParameterService` | Evaluates formula expressions for calculated test results |
| `reportSnapshotService` | Captures immutable JSON snapshot at finalization |
| `reportRendererService` | Snapshot → fully self-contained HTML |
| `pdfGenerationService` | Puppeteer wrapper, max 2 concurrent jobs |
| `mergedReportPdfService` | Appends external PDF uploads to base report via pdf-lib |
| `mergedReportPdfCache` | 7-day Redis cache of rendered merged PDFs |
| `reportAccessService` | Token generation/validation for public report URLs |
| `notificationService` + `whatsappCloudService` | Fire-and-forget WhatsApp delivery |
| `payoutService` | Doctor commission derivation per finalized visit |
| `auditService` | Append to `AuditLog` (insert-only) |
| `signingDoctorService` | Signature image storage + signing rule resolution |
| `ownerDashboardService` | Aggregated metrics for owner dashboard |

### 3.5 Key patterns

**Singleton Prisma.** [`lib/prisma.ts`](../health-hub-backend/src/lib/prisma.ts) exports one `PrismaClient`. Importing `new PrismaClient()` anywhere else opens an unmanaged connection pool — never do that.

**Singleton Puppeteer.** [`services/pdfGenerationService.ts`](../health-hub-backend/src/services/pdfGenerationService.ts) maintains one Chromium process. New `Page` per request, closed after. If Chromium crashes, the next request fails and Render auto-restarts the container.

**Clone-on-edit `TestDefinition`.** Editing creates a new row (`version+1`) with the same `rootDefinitionId`. The old row's `status` flips to `LOCKED` once finalized results reference it. Queries always filter on `isLatest: true` for the active version, but `TestResult` rows pin the *exact* version they were entered against — so historical reports stay correct even after edits.

**Sibling tables for non-versioned config.** [`TestInputConfig`](../health-hub-backend/prisma/schema.prisma) lives in a separate table keyed by `rootDefinitionId`. Entry-time UI hints (presets, default values) don't belong in the versioned clinical contract — see [DECISIONS ADR-013](DECISIONS.md).

**Immutable report snapshots.** `ReportVersion.panelsSnapshot` (and friends) capture full JSON at finalization. PDF rendering reads only from snapshots, never from live rows. Editing a patient's name later doesn't change historical reports — by design. Both `createReportSnapshot` and `buildEphemeralSnapshot` accept an optional `{ selectedTestOrderIds }` filter so partial-release flows can scope the snapshot to a chosen subset of test orders — both the results AND the external uploads tied to unselected orders are excluded from the resulting snapshot, so an MRI/X-ray PDF the radiologist held back stays attached to its order for a later version rather than getting baked into today's merged PDF.

**Token-based public access.** `ReportAccessToken.token` is a SHA-256 hash of a 12-char base64url bearer token. The bearer is never stored — only the hash. Rotation: generate new token, soft-expire old.

**Fire-and-forget side effects.** WhatsApp delivery, audit log writes, payout derivation refresh — all wrapped with `.catch(logger.error)` and never awaited in the request handler. The user gets their response immediately; failures show up in `MessageLog` / Sentry.

---

## 4. Frontend architecture

### 4.1 Routing — [`App.tsx`](../health-hub/src/App.tsx)

React Router 6 with `<ProtectedRoute>`:
1. Checks `authStore.isAuthenticated`.
2. Calls `authStore.checkTokenExpiration()` → auto-logout on expired JWT.
3. Optional `allowedRoles` prop for role-gated pages.

| Path prefix | Roles |
|---|---|
| `/diagnostics/*` | `staff`, `owner`, `lab_incharge` |
| `/clinic/*` | `staff`, `owner` |
| `/owner/*` | `owner`, `sales` |
| `/bill-print/:visitId`, `/report/:visitId` | `staff`, `owner`, `lab_incharge` |
| `/reports/*` | public — served by backend, not React Router |

Code-splitting today: `AdminConfigCenter` lazy-loads its 5–7 admin tab pages, and `DiagnosticsReportPreview` lazy-loads `PdfPreview` (react-pdf is ~140 KB gzipped). Other routes are eagerly imported — see [Known architectural debts](#9-known-architectural-debts).

### 4.2 State

Five Zustand stores in [`src/store/`](../health-hub/src/store/):

- **`authStore`** — `token`, `user`, `isAuthenticated`. localStorage-persisted via `persist` middleware. JWT decoded client-side to detect expiry.
- **`branchStore`** — `activeBranchId`, `branches`. Persisted. Every API call includes `X-Branch-Id: activeBranchId`.
- **`appStore`** — minor UI state, not persisted.
- **`payoutPrefsStore`** — owner payout configuration and UI preferences. Persisted.
- **`visitDefaultsStore`** — front-desk operator's last choices for new visits (e.g. consulting doctor, payment mode). Persisted.

`@tanstack/react-query` is configured with a `QueryClient` in `App.tsx` and is incrementally being adopted (e.g. for global patient search and doctor lookups), but many older pages still call `fetch()` directly. This migration is ongoing; see [Known architectural debts](#9-known-architectural-debts).

### 4.3 Components

```
health-hub/src/
├── components/
│   ├── ui/                  shadcn primitives — do not edit
│   ├── layout/              AppLayout, Sidebar, ProtectedRoute
│   ├── diagnostics/         Domain widgets — RichTextNarrativeEditor, TestValueCombobox,
│   │                        TestInputConfigEditor, PdfPreview, PartialReleaseSelectorDialog,
│   │                        ProductSelector, TestSelector
│   ├── print/               BillReceipt, ClinicPrescriptionPrint
│   └── patient360/          Patient360-specific widgets
├── pages/                   One file per page — many >800 LOC (god files; see ADR-014)
├── store/                   Zustand
├── hooks/                   use-mobile, use-toast (sparse — most logic is inlined in pages)
├── lib/                     api, validation, referralPayouts, richText, formulaUtils
└── types/                   Single index.ts of shared interfaces
```

### 4.4 Result-entry auto-save

[`DiagnosticsResultEntry`](../health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx) persists draft results in the background so techs never have to think about saving:

- A 1.5 s debounce timer fires after the last keystroke; an `onBlur` listener on the form container also fires immediately when the user tabs out of a field.
- A single source of truth — `persistDraft()` — assembles the same payload the explicit-save button uses, so auto-save and click-save can never diverge.
- `inFlightSaveRef` guards against concurrent POSTs; the explicit save will `await` an in-flight auto-save before issuing its own request.
- An `autoSavePrimedRef` skips the very first results-changed render after `fetchVisit` populates state, so the initial load doesn't trigger a no-op POST.
- An inline status indicator (`Saving…` / `Saved · just now` / `Unsaved changes` / `Save failed — will retry`) sits above the action button. The action button itself flips between **Review & Finalize** and **Continue with Partial Report** based on whether every reportable test has a value AND every required external upload is attached.

### 4.5 Data fetching pattern (current)

```ts
const headers = { Authorization: `Bearer ${token}`, 'X-Branch-Id': branchId };
const res = await fetch(`${API_BASE}/foo`, { headers });
if (!res.ok) { toast.error('…'); return; }
const data = await res.json();
```

Repeated ~150 times across pages. Centralizing it in a `lib/apiClient.ts` + react-query wrapper is on the [refactor list](DECISIONS.md).

---

## 5. Database schema

> Full schema: [`prisma/schema.prisma`](../health-hub-backend/prisma/schema.prisma) — **47 models, 41 enums**. Architectural rules pinned at the top of that file.

### Core entities

| Model | Purpose |
|---|---|
| `Branch` | Physical location; scopes all data |
| `User` | Staff / doctor / owner / admin; has one `activeBranch` |
| `Patient` | Globally unique person (not branch-scoped) |
| `PatientIdentifier` | Phone / email / Aadhaar / other. *Indexed not unique* — multiple patients may share a phone (family). |
| `Visit` | Anchor row for diagnostic OR clinic activity |
| `Bill` + `PaymentTransaction` | Per-visit billing + payments ledger |

### Diagnostics

| Model | Purpose |
|---|---|
| `TestOrder` | One ordered test per visit. **Dual FK** during migration: `testId` (legacy `LabTest`) + `testDefinitionId` (new) |
| `TestResult` | One value per `TestOrder`. Same dual FK. Immutable once `ReportVersion.status = FINALIZED` |
| `DiagnosticReport` → `ReportVersion` | Versioned report container. `status: DRAFT \| FINALIZED`. `finalizedAt` set on finalize. |
| `ReportAccessToken` | SHA-256 hashed bearer token → `ReportVersion`. Used in patient-facing URLs. |
| `BillAccessToken` | Secure public access tokens for bill PDF links sent via WhatsApp |
| `ReportAccessLog` | Append-only — every view/download/print event |

### Clinical catalog (new architecture)

| Model | Purpose |
|---|---|
| `TestDefinition` | Versioned via clone-on-edit. `rootDefinitionId` groups versions. |
| `TestDefinitionRange` | Age/gender-specific reference ranges per `TestDefinition` |
| `InterpretationRule` | Auto-generated interpretation text per result |
| `ClinicalPanel` | Report rendering group (e.g. CBP). Has `layoutType` enum. |
| `ClinicalPanelItem` | Junction `Panel ↔ TestDefinition` with display rules (subgroup, indent, bold) |
| `BillableProduct` | Commercial product. `BillableProductPanel` joins to `ClinicalPanel`. |
| `ProductBranchPricing` | Per-branch price overrides |
| `TestInputConfig` | **Sibling table** (not versioned with TestDefinition). Holds `inputType` (NUMERIC/FREE_TEXT/TEXT_WITH_PRESETS/SELECT_ONLY), `defaultValue`, `valueOptions`. See ADR-013. |

### Clinical catalog (legacy, being phased out)

| Model | Purpose |
|---|---|
| `LabTest` | Original test model. New `TestDefinition` replaces it. Both still in use during migration. |
| `PanelDefinition` + `PanelTestItem` | Original panel layout. Superseded by `ClinicalPanel` + `ClinicalPanelItem`. |

### Doctors & signing

| Model | Purpose |
|---|---|
| `ReferralDoctor` + `ReferralDoctor_Visit` | External referrer. Visit access is **explicit** via the join table (no implicit `referralDoctorId` FK on Visit). |
| `ClinicDoctor` | In-house consulting doctor |
| `SigningDoctor` + `SigningRule` | Doctor whose signature appears on reports + assignment rules per department |
| `DiagnosticReferralCenter` + `DiagnosticCenter_Visit` | External diagnostic centers (referred-to / referred-from) |

### Operational

| Model | Purpose |
|---|---|
| `AuditLog` | Append-only — login, finalize, payout, edit. Insert-only by convention (no UPDATE/DELETE in code). |
| `MessageLog` | WhatsApp / SMS delivery log |
| `DoctorPayoutLedger` | Payout snapshots per period |
| `ExternalReportUpload` | PDFs uploaded for `EXTERNAL_UPLOAD` workflow, stored in R2, soft-deleted via `deletedAt` |

### Key constraints

- `Visit @@unique([branchId, billNumber])` — bill numbers are sequential per branch.
- `Bill.visitId @unique` — one bill per visit.
- `TestDefinition @@unique([rootDefinitionId, version])` — prevents duplicate versions per lineage.
- `ClinicalPanelItem @@unique([panelId, testDefinitionId])` — a test can't be in the same panel twice.
- `ReportVersion @@unique([reportId, versionNum])` — sequential version numbers.

---

## 6. Critical data flows

### 6.1 Diagnostic visit → report → patient

```
POST /api/visits/diagnostic
  patientMatchingService → find or create Patient
  numberService → next bill number for branch
  productOrderService → maps products → panels → test definitions
  Prisma transaction: Visit + Bill + TestOrders all-or-nothing
  → returns { visitId, billId }

POST /api/visits/diagnostic/:id/results
  for each TestOrder:
    referenceRangeService.resolve(testDef, patient.age, patient.gender)
    derivedParameterService.evaluate(formula, sibling results)   ← if calculated
    upsert TestResult (computes flag NORMAL/HIGH/LOW/CRITICAL_HIGH/CRITICAL_LOW)

POST /api/visits/diagnostic/:id/finalize
  reportSnapshotService.create(visitId)
    → fetch visit, patient, results, ranges, signing doctors
    → write panelsSnapshot, signaturesSnapshot, patientSnapshot, … to ReportVersion
    → status = FINALIZED, finalizedAt = now
  reportAccessService.createToken(reportVersionId)
    → SHA-256 hashed bearer token written to ReportAccessToken
  notificationService.sendReportReady(visitId)   ← fire-and-forget
    → WhatsApp template message with link

POST /api/visits/diagnostic/:id/release-partial
  body { testOrderIds?: string[] }   ← optional explicit selection from PartialReleaseSelectorDialog
  prisma.$transaction:
    1. If explicit selection: deleteMany draft TestResult rows whose testOrderId is NOT selected
       (their values still live in carryForwardData captured before mutation)
    2. updateMany draftVersion → FINALIZED   ← race-safe atomic flip
    3. create next ReportVersion (DRAFT, versionNum+1)
    4. createMany TestResults on the new draft from carryForwardData
       (every prior result, selected or not, so the next finalize() snapshot is cumulative
        and unselected rows stay editable)
  createReportSnapshot(finalizedVersion.id, { selectedTestOrderIds })
    → snapshot scoped to selection — unselected results AND external uploads are excluded
  reportAccessService.createToken(finalizedVersion.id)
  → returns { finalizedVersionId, finalizedVersionNum, nextDraftVersionId,
              readyReportableCount, pendingReportableCount }

GET /reports/:token   ← public, no auth
  reportAccessService.validate(token)
  mergedReportPdfService.generate(snapshot)
    → reportRendererService → HTML
    → pdfGenerationService → Puppeteer PDF buffer (digital mode)
    → if external uploads exist: pdf-lib appends them to the base
    → cached in Redis for 7 days
  → res.send(pdfBuffer)
  ReportAccessLog appended
```

### 6.2 New version of a TestDefinition

```
POST /api/clinical-definitions/:rootId/new-version
  Header: If-Match: <updatedAt>             ← optimistic lock

  clinicalDefinitionService.createNewVersion()
    → If-Match check (CONFLICT 409 if mismatched)
    → UPDATE existing version: isLatest = false, status = LOCKED
    → INSERT new TestDefinition:
        rootDefinitionId = same
        version = old.version + 1
        isLatest = true, status = ACTIVE
        + caller's payload (uses pick() helper, NOT ?? — null is a meaningful reset)
    → copy ranges + interpretation rules to new version
  → returns new TestDefinition
```

### 6.3 Authentication

```
POST /api/auth/login { email, password }
  authService.login()
    → Prisma find user
    → bcrypt.compare()
    → loginLockout check (Redis-backed; configurable failures-per-window)
    → audit LOGIN_SUCCESS / LOGIN_FAILED
    → jwt.sign({ id, email, role }, JWT_SECRET, { expiresIn: '7d' })
  → returns { token, user }

Frontend: authStore.login() → localStorage
Every fetch: Authorization: Bearer <token> + X-Branch-Id
authStore.checkTokenExpiration() → auto-logout on expired exp claim
```

---

## 7. Security model

### Authentication
- JWT bearer (HS256) signed with `JWT_SECRET`. 7-day expiry. **Stored in localStorage** — XSS-vulnerable; see [Known architectural debts](#9-known-architectural-debts).
- No refresh token; expiry forces re-login.
- bcrypt password hashing. No MFA.
- Login lockout via Redis (configurable thresholds in [`lib/loginLockout.ts`](../health-hub-backend/src/lib/loginLockout.ts)).

### Authorization
- `requireRole(...)` middleware factory.
- Branch isolation is **application-enforced** — every Prisma query filters by `branchId`. Not enforced at DB level (no Row Level Security). Consistency depends on developer discipline; one missed filter is a data leak.

### Public report & bill tokens
- 12-char base64url bearer (~72 bits entropy → infeasible to brute-force).
- Only the SHA-256 hash is stored (`ReportAccessToken.token`, `BillAccessToken.token`, `StatementAccessToken.token`). Bearer is not recoverable.
- Tokens currently do not expire (`expiresAt: null`). Setting `expiresAt` is supported by the schema with no code change.
- `revokedAt` is set when underlying item (bill, payout) is voided, blocking the public link.
- Every access logged to `ReportAccessLog` (IP, user-agent, accessType: VIEW/DOWNLOAD/PRINT).

### Transport
- HTTPS in production (Render terminates TLS).
- CORS origin allowlist via `FRONTEND_URL`. Headers explicitly include `Authorization`, `X-Branch-Id`, `If-Match`.
- Helmet headers — note **CSP is currently disabled**.

### Audit
- `AuditLog` is append-only (no UPDATE/DELETE in code; not enforced at DB level).
- Captures: `LOGIN_SUCCESS/FAILED`, `FINALIZE`, `CREATE`, `UPDATE`, `DELETE`, `PAYOUT_DERIVE`, `PAYOUT_PAID`, `REPORT_ACCESS`.
- Coverage uneven — some hot paths still missing audit hooks.

### Secrets
- `.env` is in `.gitignore`. **Anything previously committed must be rotated** — see [`SECURITY.md`](../SECURITY.md).
- Production secrets live in Render env vars / Vercel project settings.

---

## 8. Infrastructure & deployment

| Layer | Platform | Trigger |
|---|---|---|
| Frontend SPA | Vercel | push to `main` (verify per env) |
| Backend API | Render (Docker) | push to `main` |
| Database | Neon Postgres | manual via `prisma migrate deploy` at container start |
| Object storage | Cloudflare R2 | provisioned manually |
| Redis | Render Redis (or external) | provisioned manually |

### Backend Docker image (simplified)

```dockerfile
FROM node:20-slim
RUN apt-get update && apt-get install -y chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npx prisma generate && npx tsc
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
```

### Health check
- `GET /health` runs Postgres, Redis, R2, Puppeteer probes. Returns 503 only if Postgres is unhealthy (the one critical dep) — others mark `degraded` but return 200 so transient blips don't trigger restart loops.
- Render's healthcheck path: `/health` (verify per env).

### Migrations
- Applied automatically at container start. Migration files in [`prisma/migrations/`](../health-hub-backend/prisma/migrations/).
- For destructive or risky migrations: see [`runbooks/database-migrations.md`](runbooks/database-migrations.md).
- Never run `prisma migrate dev` against production — it can reset the DB.

### Vercel SPA fallback
- `health-hub/vercel.json` rewrites all paths to `/` so React Router handles deep links instead of returning 404.

---

## 9. Known architectural debts

These exist; they're tracked here so newcomers don't think they're invisible.

1. **`diagnosticVisits.ts` is ~3,800 LOC** — needs to be split per endpoint into a feature folder. Most "fix the bill" commits in git history land here.
2. **Dual FK migration in flight** — `TestOrder.testId` (legacy `LabTest`) and `TestOrder.testDefinitionId` (new) both populated. Code branches on which is present. Finishing the migration is a tracked refactor.
3. **`@tanstack/react-query` partial adoption** — while newer flows (patient search, doctor lookups) use React Query, many older pages still reconstruct `fetch()` calls inline (~150 sites). Migrating one page at a time is incremental.
4. **`react-hook-form` + `zod` installed, unused** — forms hand-rolled with `useState`. Same incremental migration plan.
5. **No automated test suite** — see [`TESTING.md`](TESTING.md) for the strategy.
6. **CSP disabled** in Helmet config — `contentSecurityPolicy: false`. Should be re-enabled with a tested policy.
7. **JWT in localStorage** — XSS-vulnerable. Long-term move to httpOnly cookie + CSRF token.
8. **No FE↔BE shared types** — `health-hub/src/types/index.ts` redeclares interfaces that exist in Prisma. Manual sync, drift-prone.
9. **God pages on the frontend** — `DiagnosticsNewVisit.tsx` 2,234 LOC, `ManagePanelDefinitions.tsx` 1,769, etc. Decomposition is a tracked refactor.
10. **No background-job runner** — WhatsApp, payouts, snapshot generation all run in-request. A proper queue (BullMQ etc.) is on the roadmap.
11. **Routes call Prisma directly** — should go through a `repositories/` layer. Repeated `include` patterns are duplicated across files.
