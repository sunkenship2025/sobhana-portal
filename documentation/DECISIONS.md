# Architecture Decision Records (ADRs)

This document captures significant architectural decisions made in the Sobhana Health Hub project. Each entry explains the context, the options considered, the chosen approach, and the consequences.

---

## ADR-001: Render + Docker over serverless for the backend

**Date:** 2025-12 (initial deployment)
**Status:** Accepted

### Context

We needed to host an Express + Puppeteer backend. Puppeteer requires a Chromium process for PDF generation.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Render (Docker)** | Persistent process; Chromium stays warm; free tier available | Spins down on free tier after 15min inactivity (cold start ~30s) |
| **AWS Lambda / Vercel Functions** | No server management; instant scale | Cold start per request for Puppeteer is 2-3s; 15-min execution limit; harder to bundle Chromium |
| **VPS (Hetzner/DigitalOcean)** | Full control; no cold starts | Requires sysadmin; no auto-deploy |
| **Railway** | Similar to Render | Smaller ecosystem; less docs |

### Decision

Use **Render with a Dockerfile** (`node:18-slim` + system Chromium via `apt-get`). This gives:
- Persistent Puppeteer browser instance (warmed up at startup, reused across requests)
- Git-push auto-deploy via Render's GitHub integration
- Managed PostgreSQL in the same region reduces DB latency
- `prisma migrate deploy` runs automatically in the Docker CMD before the server starts

### Consequences

- Render free tier sleeps after 15 minutes of inactivity → ~30-second cold start on first request after sleep. Acceptable for current scale; upgrade to paid tier if this becomes a problem.
- We set `app.set('trust proxy', true)` because Render uses a reverse proxy — without this, Express reports the wrong client IP.

---

## ADR-002: Prisma ORM over raw SQL or raw query builders

**Date:** 2025-12
**Status:** Accepted

### Context

The data model has ~30 related tables. We needed type-safe DB access across a TypeScript codebase.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Prisma** | Full TypeScript types generated from schema; good migrations; readable queries | Some raw SQL still needed for complex aggregations; migration system can be tricky |
| **Drizzle ORM** | Lightweight; closer to SQL | Smaller ecosystem; less documentation at time of decision |
| **TypeORM** | Mature; good ecosystem | Decorators pattern feels heavy; known migration issues |
| **Knex.js** | Flexible query builder | No type generation; more boilerplate |
| **Raw pg driver** | Maximum control | No type safety; all SQL manual |

### Decision

**Prisma** was chosen for:
- Schema-first development: `schema.prisma` is the single source of truth for the DB shape
- Generated TypeScript types are immediately usable in service files — no hand-written interfaces needed for DB entities
- Migration history in `prisma/migrations/` provides a clear, auditable change log
- `npx prisma migrate deploy` in Docker CMD gives zero-friction production deploys

### Consequences

- We use a singleton pattern (`lib/prisma.ts`) to avoid `PrismaClient` connection pool exhaustion in a long-running Node process. Without this, each `new PrismaClient()` opens a pool of connections that are never closed.
- For complex aggregations (e.g., payout calculations), we use Prisma's `$queryRaw` with tagged template literals (still parameterized, not injectable).

---

## ADR-003: Clone-on-write versioning for TestDefinition

**Date:** 2025-12
**Status:** Accepted

### Context

Lab test reference ranges and configurations change over time (e.g., an age threshold is adjusted, a formula is corrected). We needed historical reports to reflect the configuration that was active when the report was generated, not the current configuration.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Clone-on-write (current)** | Old rows permanently locked; history is self-contained in the DB | More rows in DB; queries must filter to `isActive=true` versions |
| **Audit table / event sourcing** | Full change history | Complex reconstruction; queries need to replay history |
| **Soft-delete with timestamp** | Simple | Hard to reconstruct "what was active when" |
| **No versioning (edit in place)** | Simple | Destroys history; historical reports would show wrong ranges |

### Decision

**Clone-on-write**: editing a `TestDefinition` creates a new row (v+1) and locks the old row. The old row's `status` is set to `INACTIVE`. References from `TestResult` records point to the specific `TestDefinitionId` (not the "latest"), so historical results always know what ranges were valid.

Key implementation: `@@unique([rootDefinitionId, version])` ensures you can't have two records with the same version for the same test lineage.

### Consequences

- The previous constraint `@@unique([code, isLatest])` caused a bug where creating a third version (v3) failed because both v1 and v2 had `isLatest=false` with the same code. Fixed in migration `20260302000000`.
- `clinicalDefinitionService.createNewVersion()` uses a `pick()` helper (not `??` null-coalescing) when copying fields to the new version. This matters because `null` is a valid intentional value for optional fields like `formula`; using `??` would accidentally keep the old formula when the user intends to remove it.

---

## ADR-004: Immutable report snapshots

**Date:** 2025-12
**Status:** Accepted

### Context

Once a diagnostic report is finalized and sent to a patient, we must guarantee that the patient always downloads the same content. Editing patient demographics, reassigning signing doctors, or modifying test configurations after finalization must not alter finalized reports.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Full JSON snapshot (current)** | Complete isolation; one DB read to render | Snapshot size can be large; data duplication |
| **Foreign key references + DB constraints** | Normalized; no duplication | Cannot prevent soft-edit of referenced rows |
| **Signed PDF stored on S3** | Final artifact stored; no re-render | Storage cost; PDF generation unavoidable |
| **Nothing (render live)** | Simple | Legal risk; report changes after delivery |

### Decision

**`ReportSnapshot`** captures the complete report state as a JSON blob at finalization time:
- Patient name, DOB, gender, identifier
- Branch name, address
- All test results with values, units, reference ranges
- Signing doctor full name, degrees, designation, signature image path

All future PDF renders use this snapshot. The live DB rows for patient, doctor, etc. are completely ignored.

### Consequences

- `reportRendererService` only needs to accept a `ReportSnapshot` object, not a visit ID. This makes the PDF pipeline fully deterministic and testable.
- Signature images are stored by **filesystem path** in the snapshot (not base64, to keep snapshot size manageable). `inlineSignatureImage()` reads the file at render time and converts to base64. If the file is deleted from the server, the signature will be missing in the rendered PDF (logged as a warning).
- Snapshots have no `updatedAt` field in the schema — they are intentionally write-once.

---

## ADR-005: Token-based public report access

**Date:** 2025-12
**Status:** Accepted

### Context

Patients need to access their lab reports without creating an account or knowing any credentials. The delivery channel is a WhatsApp link.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Random token in URL (current)** | No login needed; easy to share; works in any browser | Token never expires by default; if shared, anyone can view |
| **OTP via SMS/WhatsApp** | Higher security | Patient must actively retrieve OTP; friction |
| **Patient portal with login** | Full access control | Requires patient account creation; friction |
| **Signed JWT link** | Self-contained; can encode expiry | Longer URL; patient-facing JWT is unusual |

### Decision

**12-character base64url random token** (`nanoid(12)`) stored in `ReportAccessToken`, linked 1:1 to a `ReportSnapshot`. The URL pattern is:

```
GET /reports/<token>  →  PDF streamed
```

72 bits of entropy makes brute-forcing infeasible (at 1 billion guesses/second, would take ~149 years to exhaust the space).

`expiresAt` is stored in the `ReportAccessToken` table and currently set to `null` (no expiry). Future expiry can be added by setting a timestamp without changing the architecture.

### Consequences

- Tokens do not require authentication. Anyone with the URL can download the report. This is by design — the patient shares the URL however they want (forward to family, save, print).
- Production: `PUBLIC_REPORT_BASE_URL` must be set to the backend's public URL (`https://reports.sobhanaportal.com/reports`) so the correct link is sent in WhatsApp messages.
- The `/reports/:token` route is explicitly listed before auth middleware in `index.ts` so it does not require a JWT.

---

## ADR-006: Fire-and-forget WhatsApp notifications

**Date:** 2025-12
**Status:** Accepted

### Context

WhatsApp message delivery via Meta Cloud API can fail for many reasons: invalid number, network issues, WhatsApp not installed, API rate limits. Report finalization must not fail because of a notification error.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Fire-and-forget (current)** | Finalization always succeeds; patient UX is fast | Notification failures silently logged; staff may not notice |
| **Await and fail on error** | Visible failure if WA down | Blocks the main operation for notification failure |
| **Queue (BullMQ/Redis)** | Retry logic; resilient | Added infrastructure (Redis); complexity |
| **Polling / retry in the same request** | No extra infra | Slower user response; complex code |

### Decision

`notificationService.sendReportReady()` is called with `.catch(console.error)` but **not awaited** in the route handler. The HTTP response returns immediately after report finalization. Delivery is logged to `MessageLog` regardless of success or failure.

Pattern:
```typescript
await finalizeReport(visitId);
notificationService.sendReportReady(visitId).catch(console.error); // fire-and-forget
res.json({ success: true });
```

### Consequences

- If WhatsApp is down or the patient's number is invalid, the finalization succeeds and the error is logged to `MessageLog`. Staff can check `MessageLog` to identify undelivered reports.
- `notificationService` never throws — all internal calls are wrapped in try/catch. This is a hard rule; violating it would cause the server to crash with an "UnhandledPromiseRejection".
- Future improvement: add a retry queue using BullMQ if reliable delivery becomes critical.

---

## ADR-007: Singleton Puppeteer browser

**Date:** 2025-12
**Status:** Accepted

### Context

Puppeteer's `browser.launch()` takes 2-3 seconds and spawns a Chromium process. For lab report downloads, which may happen in bursts (multiple staff generating PDFs simultaneously), launching a new browser per request is too slow and too resource-intensive.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Singleton browser (current)** | Fast; one Chromium process | Must handle browser crashes; no parallel PDF limit |
| **New browser per request** | Isolated; crash-safe | 2-3s startup per request; memory pressure |
| **Worker pool** | Controlled parallelism | Complex implementation |
| **WeasyPrint / wkhtmltopdf** | No Chromium needed | CSS coverage significantly worse; harder to match design |

### Decision

`pdfGenerationService.ts` maintains a **module-level `browser` variable**. It is:
- Initialized at server startup in `index.ts` (`warmupBrowser()`)
- Reused for all subsequent requests (one `browser.newPage()` per request, page closed after done)
- Reconnected if it crashes (the page creation will fail and the error surfaces to the caller)

### Consequences

- If the Chromium process crashes, subsequent PDF requests fail until the server restarts. Render's health checks and auto-restart mitigate this on the hosted environment.
- A new `Page` is opened and closed per PDF request — this prevents state leakage between reports.
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium` is set in the Dockerfile to use the system Chromium installed via `apt-get` instead of the bundled one (saves ~200MB in the Docker image).

---

## ADR-008: Vercel for frontend hosting

**Date:** 2025-12
**Status:** Accepted

### Context

The frontend is a pure SPA (React + Vite). It needs HTTPS, a CDN, and auto-deploy from GitHub.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Vercel (current)** | Zero config for Vite; global CDN; free tier generous; auto-deploy | Vendor lock-in |
| **Netlify** | Similar to Vercel | Slightly less TypeScript/Vite native |
| **Render Static Sites** | Same platform as backend; simpler billing | Slower CDN |
| **AWS CloudFront + S3** | Maximum control; cheap at scale | Manual setup; complex CI/CD |
| **Serve from backend** | One platform | Misses CDN benefits; couples deployments |

### Decision

**Vercel** — zero configuration needed for a Vite project, global edge CDN for low latency across India, auto-deploys on push to `main`, generous free tier, and `vercel.json` handles the SPA fallback with two lines.

### Consequences

- `vercel.json` must contain the SPA rewrite rule, or direct navigation to React routes (e.g., `/diagnostics/result-entry`) will return 404 from Vercel's static file server.
- All environment variables must be set in the Vercel dashboard (not in `.env` committed to the repo).

---

## ADR-009: Zustand over Redux for frontend state

**Date:** 2025-12
**Status:** Accepted

### Context

The frontend needs to manage auth state (JWT token + user), active branch, and minor UI state across components. This state must persist across page refreshes.

### Options Considered

| Option | Pros | Cons |
|--------|------|------|
| **Zustand (current)** | Minimal boilerplate; built-in persist middleware; simple API | Less ecosystem tooling vs Redux |
| **Redux Toolkit** | Mature; Redux DevTools; good for complex state | Boilerplate even with RTK; overkill for 3 stores |
| **Context API** | No dependency | Re-renders on any change; no persistence built-in |
| **Jotai** | Atomic; lightweight | Different mental model; less common |

### Decision

**Zustand** — three stores (`authStore`, `branchStore`, `appStore`) each under 50 lines. Persist middleware handles `localStorage` serialization. Entire auth state is restored on page load without a loading flash.

### Consequences

- Stores are imported directly by components — no Provider needed. This is a Zustand feature, not a bug.
- Branch switching in `branchStore.setActiveBranch()` should always be followed by `queryClient.clear()` to flush TanStack Query's cache (otherwise stale data from the previous branch may be shown).
