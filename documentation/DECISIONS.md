# Architecture Decision Records (ADRs)

Significant architectural decisions and the reasoning behind them. New ADRs are appended at the end and never edited after merge — corrections happen in a follow-up ADR that supersedes the prior one.

Format: each entry has **Context** (why this decision was needed), **Options considered**, **Decision**, and **Consequences** (what we live with as a result).

---

## ADR-001 — Render + Docker for the backend

**Date:** 2025-12 · **Status:** Accepted

### Context
The backend uses Puppeteer to render PDFs from HTML. Puppeteer needs a long-lived Chromium process; cold-starting it on every request adds 2–3 s per PDF.

### Options
| | Pros | Cons |
|---|---|---|
| Render (Docker) | Persistent process; Chromium stays warm; managed Postgres in same region | Free tier sleeps after 15 min idle (~30 s cold start) |
| Lambda / Vercel Functions | No server management; instant scale | Per-invocation cold start fatal for Puppeteer; 15 min execution cap |
| Self-managed VPS | Full control | Sysadmin burden; manual deploy |
| Railway | Similar to Render | Smaller ecosystem |

### Decision
**Render + Dockerfile**, `node:20-slim` with system Chromium installed via `apt-get`. Container starts: `npx prisma migrate deploy && node dist/index.js`. Puppeteer is warmed at startup and reused across requests.

### Consequences
- `app.set('trust proxy', true)` is required because Render terminates TLS at a load balancer; without it, Express logs the wrong client IP and rate limiting breaks.
- Free tier sleep is fine while the load is light. Upgrade tier if cold start becomes user-visible.
- A Chromium crash kills PDF generation until container restart. Mitigated by Render's healthcheck-driven auto-restart.

---

## ADR-002 — Prisma ORM over raw SQL

**Date:** 2025-12 · **Status:** Accepted

### Context
~30 (now 47) related tables, all-TypeScript codebase. Need type-safe DB access.

### Options
| | Pros | Cons |
|---|---|---|
| Prisma | Generated types from schema; clean migrations | Some complex aggregations need raw SQL; `migrate dev` has quirks |
| Drizzle | Closer to SQL; lightweight | Smaller ecosystem at decision time |
| TypeORM | Mature | Decorator-heavy; migration foot-guns |
| Raw `pg` | Maximum control | No type safety; hand-written SQL everywhere |

### Decision
**Prisma.** `schema.prisma` is the source of truth for the DB shape. Generated client gives compile-time safety on queries.

### Consequences
- Singleton `PrismaClient` in `lib/prisma.ts`. Multiple instances exhaust connection pools.
- Complex aggregations use `prisma.$queryRaw` with tagged template literals (still parameterized — not injection-prone).
- Shadow-DB issues with Neon force occasional hand-written migrations + `migrate deploy`. See ADR-013.

---

## ADR-003 — Clone-on-edit versioning for `TestDefinition`

**Date:** 2025-12 · **Status:** Accepted

### Context
Lab test reference ranges and configurations evolve. Historical reports must reflect the configuration that was active when the result was entered, not whatever it is today.

### Options
| | Pros | Cons |
|---|---|---|
| Clone-on-edit | Old rows permanently locked; history self-contained | More rows; queries need `isLatest` filter |
| Audit / event sourcing | Full change history | Complex reconstruction |
| Soft-delete + timestamp | Simple | Hard to "what was active when X" |
| Edit in place | Simple | Destroys history; legally indefensible |

### Decision
Editing a `TestDefinition` creates a new row with `version+1` and the same `rootDefinitionId`. The old row's `status` becomes `LOCKED` once a finalized result references it. `TestResult` rows always reference a specific version, not "latest".

Constraint: `@@unique([rootDefinitionId, version])`.

### Consequences
- Earlier `@@unique([code, isLatest])` was buggy — a third version (v3) couldn't be created because v1 and v2 both had `isLatest=false` with the same `code`. Replaced by migration `20260302000000`.
- `clinicalDefinitionService.createNewVersion()` uses a `pick()` helper, **not** `??` null-coalescing, when copying fields. `null` is a meaningful intentional reset (e.g., removing a formula); `??` would silently keep the old value.

---

## ADR-004 — Immutable report snapshots

**Date:** 2025-12 · **Status:** Accepted

### Context
Once a diagnostic report is finalized and sent to a patient, the rendered content must never change. Editing patient demographics or reassigning signing doctors after the fact must not alter delivered reports.

### Options
| | Pros | Cons |
|---|---|---|
| JSON snapshot per ReportVersion (current) | Complete isolation; one DB read to render | Snapshot size; data duplication |
| FK references + write-locks | Normalized | Can't prevent editing referenced rows |
| Pre-render PDF and store in R2 | Final artifact frozen | Storage cost; can't re-render in new style |
| Render live each time | Simple | Legal risk; report changes after delivery |

### Decision
On finalize, write `panelsSnapshot`, `signaturesSnapshot`, `patientSnapshot`, `visitSnapshot`, `interpretationsSnapshot`, `externalUploadsSnapshot` (all `Json` columns on `ReportVersion`). All future PDF rendering reads from these snapshots — never live rows.

### Consequences
- `reportRendererService` accepts a snapshot, not a visit ID. Pipeline is fully deterministic.
- Signature images are stored as **filesystem path** in the snapshot; `inlineSignatureImage()` reads the file and inlines as base64 at render time. If the file is moved, the signature silently disappears.
- Snapshots are write-once — no `updatedAt` column.

---

## ADR-005 — Token-based public report access

**Date:** 2025-12 · **Status:** Accepted

### Context
Patients access reports via WhatsApp link without logging in.

### Options
| | Pros | Cons |
|---|---|---|
| Random opaque token (current) | No login; share-friendly | Tokens don't expire by default; if leaked, anyone can view |
| OTP via SMS/WhatsApp | Higher security | Friction for the patient |
| Patient portal with login | Full access control | Heavy onboarding for one-time access |
| Signed JWT in URL | Self-contained | Long URL; unusual for patient-facing |

### Decision
**12-character base64url bearer** generated with `nanoid(12)` (~72 bits entropy). Stored in `ReportAccessToken` as a **SHA-256 hash** — bearer is never persisted. Link pattern: `GET /reports/:token`.

### Consequences
- Token brute-force is computationally infeasible (~149 years at 1B guesses/sec).
- `expiresAt` exists in the schema but is `null` today. Adding expiry is a config change.
- The route is mounted before auth middleware. Anyone with the URL can download. By design — patients share it however they want.
- Every access logged to `ReportAccessLog` (IP, UA, accessType: VIEW/DOWNLOAD/PRINT).

---

## ADR-006 — Fire-and-forget WhatsApp notifications

**Date:** 2025-12 · **Status:** Accepted

### Context
Meta Cloud API can fail (invalid number, rate limits, transient outages). Report finalization must not depend on notification delivery.

### Options
| | Pros | Cons |
|---|---|---|
| Fire-and-forget (current) | Finalize always succeeds | Failures silent unless someone checks `MessageLog` |
| Await + fail on error | Visible failure | Blocks finalization on a notification problem |
| Queue (BullMQ) | Retry; resilient | Extra infrastructure |

### Decision
Call `notificationService.sendReportReady(visitId).catch(logger.error)` after finalization, **without** `await`. HTTP response returns immediately. Delivery state goes to `MessageLog` regardless of outcome.

### Consequences
- Staff have to check `MessageLog` to know if delivery actually happened.
- `notificationService` itself never throws — every internal call is wrapped. Violation crashes the server with `UnhandledPromiseRejection`.
- A real queue (BullMQ on the existing Redis) is on the roadmap for retries.

---

## ADR-007 — Singleton Puppeteer browser

**Date:** 2025-12 · **Status:** Accepted

### Context
`browser.launch()` takes 2–3 s. Bursts of PDF requests (multiple staff finalizing simultaneously) make per-request launch unworkable.

### Options
| | Pros | Cons |
|---|---|---|
| Singleton (current) | Fast; one Chromium | Crash kills PDF gen until restart |
| New browser per request | Crash-isolated | 2–3 s latency hit; memory pressure |
| Worker pool | Controlled parallelism | Extra complexity |
| WeasyPrint / wkhtmltopdf | No Chromium | Worse CSS coverage; design parity hard |

### Decision
Module-level `browser` in `pdfGenerationService.ts`. Warmed at startup via `warmupPdfService()`. New `Page` per request, closed after. Concurrency capped at 2.

### Consequences
- A Chromium crash makes PDFs fail until container restart — Render's healthcheck restarts on probe failure.
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` + `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true` keep the Docker image lean (saves ~200 MB).

---

## ADR-008 — Vercel for the SPA

**Date:** 2025-12 · **Status:** Accepted

### Context
Vite SPA needs HTTPS, a CDN, and auto-deploy from `main`.

### Decision
**Vercel.** Zero config for Vite. Edge CDN performs well across India. `vercel.json` adds the SPA-fallback rewrite so deep links don't 404.

### Consequences
- All env vars set in the Vercel dashboard, not in `.env`.
- One config file, one platform — simple. Vendor lock-in is acceptable here.

---

## ADR-009 — Zustand for frontend state

**Date:** 2025-12 · **Status:** Accepted

### Context
Auth state (JWT + user), active branch, minor UI state. Must persist across reload.

### Decision
**Zustand** with `persist` middleware: three small stores (`authStore`, `branchStore`, `appStore`), all under ~50 LOC. JWT and active branch stored in `localStorage`.

### Consequences
- No Provider — components import the hook directly. By design.
- Branch switch should clear server-state cache to avoid showing stale data from the old branch. We're not on react-query yet so this is moot today; will matter when we migrate.
- localStorage storage of JWT is XSS-vulnerable — see ADR-015.

---

## ADR-010 — Pino structured logging

**Date:** 2026-04 · **Status:** Accepted

### Context
`console.log` produces unstructured logs. Render's tail is the only log destination, and grepping unstructured output is painful. Sentry catches errors but not request lifecycles.

### Decision
**Pino** as the backend logger with `pino-http` middleware:
- All HTTP requests auto-logged as JSON (method, path, status, duration, requestId, userId, branchId).
- `/health` and `/healthz` skipped to avoid drowning the stream.
- Custom `customLogLevel` — 5xx → error, 4xx → warn, else info.
- Pretty-printed in dev (via `pino-pretty`), JSON in prod.

### Consequences
- Render logs are now greppable by structured fields.
- We're paying nothing for log aggregation today. When traffic justifies it, ship to Logtail / Datadog / Loki — Pino streams JSON to stdout, integrations are trivial.
- **Open issue:** PHI (patient names, identifiers) is *not* redacted. Pino has a `redact` config we should turn on.

---

## ADR-011 — Sentry on backend (and FE)

**Date:** 2026-04 · **Status:** Accepted

### Context
Production errors that don't crash the process are invisible without an aggregator.

### Decision
Initialize `@sentry/node` on the backend (DSN-gated by `SENTRY_DSN`). Tag every event with the `requestId` from `requestIdMiddleware`. 10% trace sample rate by default. Frontend uses `@sentry/react` separately.

### Consequences
- Backend errors and slow requests show up in Sentry with the requestId so we can correlate with Pino logs.
- **Open issue:** FE Sentry doesn't propagate the requestId across to BE. A frontend error and its corresponding backend error are two separate events. Generating a request ID on the FE and sending as `X-Request-Id` would close this loop.

---

## ADR-012 — Redis for rate limit + login lockout (+ optional cache)

**Date:** 2026-04 · **Status:** Accepted

### Context
Login brute-force, abusive clients, and the cost of regenerating finalized merged PDFs all argue for ephemeral state outside Postgres. Postgres-backed rate limiting works but bloats audit-quality data with per-request churn.

### Decision
**ioredis** singleton in `lib/redis.ts`. Required in production (`NODE_ENV=production` + `REDIS_URL` set), optional in dev (falls back to in-memory).

Three uses today:
1. Rate limiting (`middleware/rateLimit.ts`) — sliding window per IP.
2. Login lockout (`lib/loginLockout.ts`) — per-email failure counter.
3. Merged report PDF cache (`mergedReportPdfCache.ts`) — 7-day TTL keyed by snapshot ID + branding version.

### Consequences
- Optional in dev means tests/local can run without Redis. Production must enforce — `isRedisRequired()` check at startup.
- Redis availability is part of `/health` but a Redis blip marks the dep `degraded`, not unhealthy — so transient blips don't trigger restart loops.

---

## ADR-013 — `TestInputConfig` as a sibling table, not on `TestDefinition`

**Date:** 2026-05-03 · **Status:** Accepted

### Context
We needed per-test entry-time UI configuration: input type (`NUMERIC` / `FREE_TEXT` / `TEXT_WITH_PRESETS` / `SELECT_ONLY`), an optional default value, and a preset list of suggested values. Initial instinct was to add columns to `TestDefinition`.

### Why that would be wrong
`TestDefinition` is **versioned via clone-on-edit** (ADR-003). Once a row is `LOCKED`, mutating it is forbidden. If preset values lived on `TestDefinition`, every preset edit on a locked test would force a full clone-and-version cycle — so adding one phrasing to "RBC Morphology" would create v2, v3, v4 of the test for no clinical reason.

These fields are also **entry-time UI hints** — not part of the clinical contract. Changing the preset list does not retroactively change any stored result; the tech's typed value lands in `TestResult.textValue` exactly as entered. Versioning isn't needed; versioning is harmful.

### Decision
New table `TestInputConfig` keyed by `rootDefinitionId` (shared across all versions of a test):

```prisma
model TestInputConfig {
  rootDefinitionId String        @id
  inputType        TestInputType @default(NUMERIC)
  defaultValue     String?
  valueOptions     Json          @default("[]")
  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt
}
```

No FK to `TestDefinition` — `rootDefinitionId` isn't unique on that table (every version row carries the same value). The route layer reads/writes by `rootDefinitionId`. Lazy creation: no row → defaults (NUMERIC, no presets, no default).

### Consequences
- Admins can edit presets freely on any test, even `LOCKED` ones. No clone, no version bump.
- Schema is slightly less normalized (no FK). Acceptable — the trade-off is explicit and documented.
- The diagnostic-visit GET response eager-loads `TestInputConfig` keyed by `rootDefinitionId` so the result-entry frontend has it inline without a second roundtrip.

### Migration note
The `prisma migrate dev` command failed on Neon's shadow DB because of a pre-existing migration history quirk. Workaround: hand-write the migration SQL under `prisma/migrations/<timestamp>_add_test_input_config/migration.sql` and apply with `npx prisma migrate deploy`. This is documented in [`runbooks/database-migrations.md`](runbooks/database-migrations.md).

---

## ADR-014 — pdf.js (`react-pdf`) for in-app PDF preview

**Date:** 2026-05-03 · **Status:** Accepted

### Context
The report preview pane in `DiagnosticsReportPreview.tsx` originally used `<iframe src={pdfBlobUrl}>`. Each browser wraps this differently: Chrome shows its dark PDF chrome (toolbar, page count, zoom, download), Safari shows its own bar, Firefox shows a sidebar. Result: inconsistent and ugly.

`#toolbar=0` URL fragment fixes Chrome but Firefox/Safari ignore it.

### Options
| | Pros | Cons |
|---|---|---|
| Native iframe + `#toolbar=0` | Trivial | Browser-dependent; only Chrome respects |
| `react-pdf` (pdf.js) | Identical rendering everywhere | +470 KB chunk for pdf.js |
| Server-side rasterize to images | No client code | Backend cost; no text selection |

### Decision
**`react-pdf`** in a custom `<PdfPreview>` component. All pages stacked vertically in a scroll container — no toolbar, no buttons, just pages. `devicePixelRatio={Math.max(2, window.devicePixelRatio)}` to avoid aliasing on the report's thin striped header band (which renders as pink-tinged at 1×).

`PdfPreview` is loaded via `React.lazy()` so pdf.js doesn't ship to users who never open a preview.

### Consequences
- Identical preview in Chrome, Safari, Firefox, Edge.
- First-open shows a "Loading viewer…" spinner while the chunk + worker download (~140 KB gzipped). Subsequent opens are instant (cached).
- Print and download remain on the existing page-level buttons (which use the merged-PDF endpoint), so we don't lose the byte-for-byte-with-external-uploads guarantee.

---

## ADR-015 — Tracked debts (deferred decisions)

**Date:** 2026-05 · **Status:** Documented

These decisions have been explicitly deferred. Calling them out so newcomers don't think they're invisible — and so we can debate them again with full context when capacity allows.

| Debt | Reason for deferral | Impact if left |
|---|---|---|
| **JWT in localStorage**, no refresh token, no MFA | Worked at MVP; full revamp is a quarter-scale project | XSS → full account takeover, indefinitely |
| **CSP disabled in Helmet** | Inline scripts (Vite dev) and shadcn injection complicated the policy | XSS surface unrestricted |
| **react-query installed, unused** | ~150 inline `fetch()` calls — incremental migration only | Repeated boilerplate; no caching |
| **react-hook-form + zod installed, unused** | Same — pages use `useState` + manual validation | Form bugs; runtime validation gaps |
| **No automated tests** | Net negative effort to add to god files first; refactor + tests together | Finance regressions ship silently |
| **God files** (`diagnosticVisits.ts` 3.8k LOC, several pages >1.5k LOC) | Decomposition is high-risk without tests | Most "fix" commits cluster here |
| **Dual FK migration** (`testId` + `testDefinitionId`) | Mid-migration; can't drop legacy yet | Branching logic everywhere |
| **No CI pipeline** | Solo dev iteration speed wins today | Anyone can break `main` silently |
| **Secrets historically in git** | Old `.env` was committed | Must rotate everything in `SECURITY.md` |
| **No background job runner** | Synchronous works at current scale | Slow user response on WhatsApp/PDF/payout fan-out |

Each of these has a specific exit plan tracked in the [README's docs structure](../README.md) — see the relevant runbook or the individual ADR when one is written.

---

## ADR-016 — Scoped partial release with carry-forward + preview-mandatory finalize gate

**Date:** 2026-05-09 · **Status:** Accepted

### Context
The original partial-release flow (`POST /api/visits/diagnostic/:id/release-partial`) finalized every test order that had a draft result. In practice the lab needs finer control:

- A radiologist may have uploaded an MRI PDF earlier in the day for a panel, but the consultant wants only the CBP results released today and the MRI held back for a follow-up version.
- A tech might enter ~5 of 7 ordered tests, intend to release just 3, and have the remaining 4 ride to the next batch — without losing the 2 already-typed-but-unreleased values.

The all-or-nothing "release everything in draft" behaviour also made the preview screen lie: the preview rendered every draft result, but the released version might in practice match what was previewed only if the tech happened to want to release everything.

A second, separate problem: the preview screen used to show **Finalize** and **Release Partial** buttons directly on the page beside a JSON-shaped on-screen card. Staff occasionally clicked Finalize without ever opening the rendered-PDF preview modal.

### Options

#### For scoping
| | Pros | Cons |
|---|---|---|
| Always release every draft result (status quo) | Simple — one path | No fine-grained control; surprise for radiology workflow |
| Add a `selected` flag to `TestResult` rows | Persisted intent | Schema change; intent is per-release-event, not per-row |
| Per-call `testOrderIds` body on release-partial (chosen) | No schema change; explicit per-event | Caller must remember to pass it; legacy callers shouldn't break |

#### For the preview gate
| | Pros | Cons |
|---|---|---|
| sessionStorage flag toggled by opening the preview (prior attempt) | Buttons visible after first preview | Cross-tab confusion; flag lifetime quirks; staff still clicked without opening once |
| Move Finalize / Release into the preview modal only (chosen) | Single source of truth: if you saw it, you reviewed it | Modal is now load-bearing; can't bypass |

### Decision

**Scoping.** `POST /api/visits/diagnostic/:id/release-partial` accepts an optional `{ testOrderIds: string[] }` body. With an explicit selection:

1. The matching subset of draft `TestResult` rows is finalized inside the current DRAFT version.
2. The unselected draft rows are deleted from the current DRAFT *before* its `updateMany` flip to FINALIZED, but their values are captured in `carryForwardData` first.
3. Every original draft row (selected + unselected) is re-inserted on the next DRAFT version (`versionNum+1`), so unselected work stays editable and no data is lost.
4. `createReportSnapshot(versionId, { selectedTestOrderIds })` filters both the test results and the external uploads on the snapshot path, so unselected uploads (e.g. the held-back MRI) don't get baked into the finalized merged PDF.

`GET /api/visits/diagnostic/:id/preview-report` accepts the same scoping via `?testOrderIds=a,b,c` so the preview matches what release will ship byte-for-byte. `buildEphemeralSnapshot(visitId, { selectedTestOrderIds })` carries the same filter into the ephemeral path.

Without a body, behaviour is unchanged — release every draft result. Preserved for backwards compatibility with any caller that hasn't migrated.

**Preview gate.** The Finalize and Release-Partial buttons are removed from the preview page itself; both live exclusively inside the `<PdfPreview>` modal alongside the rendered PDF. Staff cannot trigger a release without first viewing the rendered output. The previous `hasReviewedPreview` sessionStorage flag is removed.

### Consequences

- **Carry-forward is the invariant.** The transaction always re-creates every draft result on the next DRAFT version, even though some were just "released" — because the next finalize() snapshot must be cumulative (the final report has to contain results from every batch, not just the last one).
- **`reportableOrders` filter is applied to the selection too.** The route uses `effectiveReadyReportableCount` and `effectivePendingReportableCount` (computed against the selection set) for gating decisions, so an explicit selection bypasses the legacy "must have at least one ready test" guard — pure external-upload-only releases are valid.
- **`USE_FINALIZE_INSTEAD` is suppressed for explicit selections.** When the dialog ticks every order, the caller has explicitly chosen the partial path; we respect that rather than forcing them through `/finalize`.
- **The dialog is the only entry point for the body.** No public docs encourage passing `testOrderIds` directly — the FE construction lives in [`PartialReleaseSelectorDialog`](../health-hub/src/components/diagnostics/PartialReleaseSelectorDialog.tsx) and `DiagnosticsResultEntry`.
- **Preview modal is now a finalize gate.** If we ever ship a "release without preview" mode (e.g. for an automation), it has to live on a separate route — the page UI deliberately forbids it.
- **Audit log captures the explicit selection.** `auditLog.metadata.explicitSelection` is the array (or `null` for legacy callers) so we can reconstruct exactly what was released after the fact.

---

## Adding a new ADR

1. Take the next number (ADR-017, etc.).
2. Heading and four sections: **Context** / **Options** / **Decision** / **Consequences**.
3. Don't edit prior ADRs after merge — append a follow-up that supersedes if the decision changes. Mark superseded ADRs with `Status: Superseded by ADR-NNN`.
4. Reference the ADR from the code where it matters (`// rationale: see DECISIONS.md ADR-013`).
