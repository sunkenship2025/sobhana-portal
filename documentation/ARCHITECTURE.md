# Architecture — Sobhana Health Hub

This document describes the system design, data flow, key architectural patterns, and the rationale behind the structural decisions made in this project.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Component Diagram](#2-component-diagram)
3. [Backend Architecture](#3-backend-architecture)
4. [Frontend Architecture](#4-frontend-architecture)
5. [Database Schema Summary](#5-database-schema-summary)
6. [Key Data Flows](#6-key-data-flows)
7. [Security Model](#7-security-model)
8. [Infrastructure & Deployment](#8-infrastructure--deployment)

---

## 1. System Overview

Sobhana Health Hub is a **multi-branch, role-based healthcare portal** that serves three distinct user types:

| Role | What they do |
|------|-------------|
| `staff` | Register patients, create bills, enter lab results, finalize reports |
| `doctor` | Review finalized reports, access Doctor Dashboard |
| `owner` | Full access — plus payouts, audit logs, test catalog management, signing-doctor management |

Every piece of data is **branch-scoped**. A single database serves all branches, but staff at Branch A cannot see or modify Branch B's patients, visits, or bills.

---

## 2. Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Staff / Doctor Browser                       │
│                                                                     │
│  React 18 + TypeScript                  Zustand Stores              │
│  TanStack Query (data fetching)         ┌─────────────┐            │
│  React Router 6                         │ authStore   │ ← JWT token │
│  Shadcn/ui + Tailwind CSS              │ branchStore │ ← active    │
│  Vite build (deployed on Vercel)        │ appStore    │   branch ID │
│                                         └─────────────┘            │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          │ HTTPS
                          │ Authorization: Bearer <JWT>
                          │ X-Branch-Id: <branchId>
                          │
┌─────────────────────────▼───────────────────────────────────────────┐
│                    Express API Server (Node 18)                     │
│                  Deployed on Render via Docker                       │
│                                                                     │
│  ┌────────────────────────────────────────────────────────────┐    │
│  │                     Middleware Stack                        │    │
│  │  cors → helmet → json → morgan → auth → branchContext      │    │
│  └────────────────────────────────────────────────────────────┘    │
│                                                                     │
│  ┌──────────────┐  ┌──────────────────────────────────────────┐   │
│  │   24 Route   │  │              Service Layer                │   │
│  │   Modules    │──│  authService    reportRendererService     │   │
│  │  /api/*      │  │  patientService  pdfGenerationService     │   │
│  └──────────────┘  │  clinicalDef.   notificationService       │   │
│                    │  reportSnapshot  auditService              │   │
│                    └──────────────┬───────────────────────────┘   │
│                                   │                                 │
│  ┌──────────────────┐             │ Puppeteer  ┌─────────────────┐ │
│  │ /reports/:token  │             │ (PDF gen.) │  public/css/    │ │
│  │ (public route —  │             │            │  report-*.css   │ │
│  │  no auth needed) │             │            └─────────────────┘ │
│  └──────────────────┘             │                                 │
└───────────────────────────────────┼─────────────────────────────────┘
                                    │
                         ┌──────────▼──────────┐
                         │  Prisma ORM         │
                         │  (type-safe queries)│
                         └──────────┬──────────┘
                                    │
                         ┌──────────▼──────────┐
                         │  PostgreSQL          │
                         │  (Render managed DB) │
                         │  30+ models          │
                         └─────────────────────┘

   ┌─────────────────────┐
   │ WhatsApp Cloud API  │◄── notificationService (fire-and-forget)
   │ Meta Graph API      │    on report finalization
   └─────────────────────┘

   ┌─────────────────────┐
   │  Patient's Phone    │◄── receives WhatsApp link
   │  (web browser)      │    opens /reports/:token → PDF streamed
   └─────────────────────┘
```

---

## 3. Backend Architecture

### 3.1 Entry Point (`src/index.ts`)

The Express app is assembled in a single entry file:

1. **Trust proxy** — tells Express to trust `X-Forwarded-For` from Render's load balancer (required for rate limiting and IP logging to work correctly).
2. **CORS** — configured with an explicit `allowedHeaders` list including `If-Match` (needed for optimistic-lock version creation) and `X-Branch-Id`.
3. **Singleton Prisma** — imported from `lib/prisma.ts`; one client for the entire process lifetime.
4. **Singleton Puppeteer** — browser warmed up at startup; reused across PDF requests to avoid 2-3 second cold start per request.
5. **Routes** — all 24 route modules mounted under `/api/*`, except:
   - `GET /reports/:token` — public PDF delivery (no auth)
   - `POST /webhooks/whatsapp` — Meta webhook (no auth)
6. **Graceful shutdown** — `SIGINT`/`SIGTERM` handlers close the Puppeteer browser and disconnect Prisma before the process exits.

### 3.2 Middleware Stack

Request processing order:

```
Incoming Request
     ↓
cors()              ← CORS preflight + headers
     ↓
helmet()            ← Security headers (CSP, HSTS, etc.)
     ↓
express.json()      ← Parse JSON body
     ↓
morgan()            ← Request logging (dev only)
     ↓
authenticateToken   ← Verify JWT → attach req.user  (skipped on public routes)
     ↓
attachBranchContext ← Read X-Branch-Id → attach req.branchId  (skipped on /auth, public)
     ↓
Route Handler
     ↓
requireRole(...)    ← RBAC guard (inline in routes that need it)
```

#### `middleware/auth.ts`
- Reads `Authorization: Bearer <token>` header
- Verifies with `JWT_SECRET`
- On success: sets `req.user = { id, email, role }`
- On failure: returns `401 Unauthorized`

#### `middleware/branch.ts`
- Reads `X-Branch-Id` from request header
- Validates the branch exists in DB and is active
- Sets `req.branchId`; returns `400` / `403` on invalid/inactive branch

#### `middleware/rbac.ts`
- `requireRole('owner')` — factory that returns a middleware
- Checks `req.user.role` against allowed roles
- Returns `403 Forbidden` if not allowed

### 3.3 Route → Service Pattern

Routes are thin. They:
1. Extract and validate input from `req.body` / `req.params` / `req.query`
2. Call one or more service functions
3. Return the result as JSON

All business logic lives in `src/services/`. This makes services independently testable.

### 3.4 Services Overview

| Service | Responsibility |
|---------|---------------|
| `authService` | Login, JWT creation, audit logging |
| `patientService` | Patient CRUD, identifier management |
| `patientMatchingService` | Deduplication at registration (phone/email/Aadhaar matching) |
| `numberService` | Generates sequential bill numbers and patient numbers per branch |
| `clinicalDefinitionService` | Clone-on-write versioning for `TestDefinition` records |
| `derivedParameterService` | Evaluates JS-like formula expressions for calculated test results |
| `referenceRangeService` | Picks the correct reference range for a patient's age/gender |
| `productOrderService` | Maps `BillableProduct` → `ClinicalPanel` → `TestDefinition` at visit creation |
| `reportSnapshotService` | Creates an immutable `ReportSnapshot` JSON blob when a report is finalized |
| `reportRendererService` | Converts a `ReportSnapshot` into a fully self-contained HTML string (all images as base64) |
| `pdfGenerationService` | Runs Puppeteer to render the HTML snapshot as a PDF buffer |
| `reportAccessService` | Generates/validates 12-char base64url tokens for public PDF links |
| `notificationService` | Orchestrates WhatsApp messages; fire-and-forget, never throws |
| `whatsappCloudService` | Low-level Meta Graph API calls (`sendTextMessage`, `sendTemplateMessage`) |
| `auditService` | Appends records to `AuditLog`; always fire-and-forget |
| `payoutService` | Calculates doctor commissions on finalized visits |
| `tokenService` | Legacy token utility (kept for backward compatibility) |

### 3.5 Key Architectural Patterns

#### Clone-on-Write Test Versioning

`TestDefinition` records track the exact configuration of a lab test (units, reference ranges, formula). When an owner edits a test:

```
TestDefinition (v1, ACTIVE)
  ├── edit triggered
  ├── v1 → status = INACTIVE (locked forever)
  └── TestDefinition (v2, ACTIVE) ← new record with rootDefinitionId = v1's rootDefinitionId
```

This means: any `TestResult` that references a `TestDefinition` will always be linked to the exact version that was active when results were entered. Historical reports remain correct even after the test is reconfigured later.

The unique constraint is `@@unique([rootDefinitionId, version])` — it prevents two active versions with the same lineage.

#### Immutable Report Snapshots

When a report is finalized, `reportSnapshotService` captures:
- Patient demographics at that moment
- All test results and reference ranges
- Signing doctor details (name, degrees, signature image path)
- Branch letterhead configuration

This JSON blob is stored in `ReportSnapshot.data`. All subsequent PDF rendering reads from this snapshot — never from live DB rows. This means:
- Editing a patient's name after finalization does NOT change already-finalized reports
- Changing a signing doctor's details does NOT affect old reports
- The report is legally/forensically immutable

#### Token-Based Public Report Access

`ReportAccessToken` holds a 12-character random base64url token linked to a `ReportSnapshot`. The token is sent to the patient via WhatsApp:

```
https://reports.sobhanaportal.com/reports/<token>
```

The public `/reports/:token` route:
1. Looks up the token in the DB
2. Checks expiry (currently null = never expires)
3. Renders the snapshot to HTML
4. Runs Puppeteer to generate PDF
5. Streams the PDF with `Content-Disposition: attachment`

No authentication is required for this route — the randomness of the token IS the access control.

#### Fire-and-Forget Notifications

`notificationService` is called after report finalization but never awaited for the response. Pattern:

```typescript
// In the route handler:
await finalizeReport(visitId);
notificationService.sendReportReady(visitId).catch(console.error); // ← not awaited
res.json({ success: true }); // ← user gets response immediately
```

If WhatsApp delivery fails, it's logged to `MessageLog` but does not fail the HTTP request or the finalization.

---

## 4. Frontend Architecture

### 4.1 Routing (`App.tsx`)

React Router 6 with a `<ProtectedRoute>` wrapper that:
1. Checks `authStore.isAuthenticated`
2. Calls `authStore.checkTokenExpiration()` before each render — auto-logout on expired JWT
3. Accepts an `allowedRoles` prop for role-based page access

Route groups:

| Path prefix | Who can access |
|-------------|---------------|
| `/diagnostics/*` | `staff`, `owner` |
| `/clinic/*` | `staff`, `owner` |
| `/doctor` | `doctor`, `owner` |
| `/owner/*` | `owner` only |
| `/bill-print/:visitId` | `staff`, `owner` |
| `/report/:visitId` | `staff`, `owner`, `doctor` |
| `/reports/*` | Public (served by backend, not React Router) |

### 4.2 State Management (Zustand)

Three stores — each minimal and purpose-specific:

**`authStore`**
- Holds: `token (string)`, `user ({id, email, role, name})`, `isAuthenticated (boolean)`
- Actions: `login(token, user)`, `logout()`, `checkTokenExpiration()`
- Persistence: `localStorage` via Zustand persist middleware
- Token expiry: `checkTokenExpiration()` decodes the JWT and compares `exp` to `Date.now()`; if expired, calls `logout()` automatically

**`branchStore`**
- Holds: `activeBranchId (string | null)`, `branches (Branch[])`
- Actions: `setActiveBranch(id)`, `setBranches(branches)`
- Persistence: `localStorage` — survives page refresh
- Usage: every API call (via React Query) includes `X-Branch-Id: activeBranchId`

**`appStore`**
- Holds: general UI state (sidebar open/closed, etc.)
- Not persisted

### 4.3 Data Fetching (TanStack Query)

All server state is managed via React Query:
- Requests made with `fetch` + `Authorization` + `X-Branch-Id` headers
- Query keys include `branchId` to prevent cross-branch cache pollution
- Mutations use `queryClient.invalidateQueries()` for optimistic cache refresh
- Error states surface via toast notifications

### 4.4 Component Hierarchy

```
App.tsx (Router)
  └── ProtectedRoute
        └── AppLayout (Sidebar + TopNav)
              ├── pages/diagnostics/
              │     ├── DiagnosticsNewVisit ─────────── creates visit + bill
              │     ├── DiagnosticsPendingResults ───── lists visits needing results
              │     ├── DiagnosticsResultEntry ──────── enter per-test values
              │     ├── DiagnosticsFinalizedReports ─── view/search completed reports
              │     └── DiagnosticsReportPreview ─────── preview HTML, trigger PDF
              ├── pages/clinic/
              │     ├── ClinicNewVisit ──────────────── create consultation
              │     ├── ClinicVisitQueue ────────────── today's queue
              │     ├── GlobalPatientSearch ─────────── cross-branch lookup
              │     └── Patient360 ──────────────────── unified patient history
              ├── pages/owner/
              │     ├── OwnerDashboard
              │     ├── AdminConfigCenter ────────────── tab hub
              │     ├── ManageSigningDoctors ─────────── doctor + signature CRUD
              │     ├── ManageClinicalDefinitions ─────── versioned test catalog
              │     ├── PayoutsList
              │     └── PayoutDetail
              └── pages/doctor/
                    └── DoctorDashboard
```

---

## 5. Database Schema Summary

> Full schema: `health-hub-backend/prisma/schema.prisma`

### Core Entities

| Model | Purpose |
|-------|---------|
| `User` | System user (staff/doctor/owner); has one branch |
| `Branch` | Physical location; scopes all data |
| `Patient` | Patient record; one per unique individual |
| `PatientIdentifier` | Phone / email / Aadhaar for a patient |
| `DiagnosticVisit` | One lab visit; has many `TestOrder`s and one `Bill` |
| `ClinicVisit` | One clinic consultation; has one `Bill` |
| `Bill` | Financial record; immutable once confirmed |
| `BillSnapshot` | Snapshot of bill at confirmation time |
| `TestOrder` | One ordered test within a diagnostic visit |
| `TestResult` | The entered value for one `TestOrder` |
| `ReportVersion` | Each "draft" or "finalized" state of a diagnostic report |
| `ReportSnapshot` | Immutable JSON blob captured at finalization |
| `ReportAccessToken` | Short token linking to a `ReportSnapshot` for public access |

### Clinical Catalog

| Model | Purpose |
|-------|---------|
| `TestDefinition` | A lab test (e.g., "Hemoglobin") — versioned via rootDefinitionId |
| `TestDefinitionRange` | Reference range for a `TestDefinition` (age/gender specific) |
| `InterpretationRule` | Auto-interpretation text based on result value |
| `ClinicalPanel` | A group of related tests (e.g., "CBC") |
| `ClinicalPanelItem` | Junction between `ClinicalPanel` and `TestDefinition` |
| `BillableProduct` | A purchasable item that maps to panels or standalone tests |
| `BillableProductPanel` | Junction between `BillableProduct` and `ClinicalPanel` |

### Doctors & Signing

| Model | Purpose |
|-------|---------|
| `SigningDoctor` | A doctor whose signature appears on reports |
| `SigningRule` | Rule that assigns a `SigningDoctor` to specific test panels/products |
| `ReferralDoctor` | External doctor who referred the patient; earns commissions |
| `Department` | Clinical department (for clinic visits) |

### Operational

| Model | Purpose |
|-------|---------|
| `AuditLog` | Append-only activity log (login, finalize, edit, etc.) |
| `MessageLog` | WhatsApp message delivery log (status, error) |
| `DoctorPayout` | A processed commission payment record |

### Key Constraints

- **`TestDefinition`**: `@@unique([rootDefinitionId, version])` — prevents two versions with the same lineage number.
- **`Bill`**: has a `confirmedAt` timestamp; once confirmed, lines are immutable (enforced in route logic).
- **`ReportSnapshot`**: no `updatedAt` — snapshots are write-once.
- **`PatientIdentifier`**: `@@unique([type, value, branchId])` — prevents duplicate phones per branch.

---

## 6. Key Data Flows

### 6.1 Diagnostic Visit → Report → Patient

```
Staff: POST /api/diagnostic-visits
  └── patientMatchingService.findOrCreate(phone)   ← dedup check
  └── numberService.nextBillNumber(branchId)       ← sequential numbering
  └── productOrderService.createOrdersForProducts(products, visitId)
        └── maps BillableProduct → ClinicalPanel → TestDefinition
  └── Creates Visit + Bill + TestOrders in a Prisma transaction
  └── Returns { visitId, billId }

Staff: PATCH /api/diagnostic-visits/:id/results
  └── For each TestOrder:
        └── referenceRangeService.getRange(testDef, patient.dob, patient.gender)
        └── derivedParameterService.evaluate(formula, results)  ← if calculated
        └── Upsert TestResult

Staff: POST /api/diagnostic-visits/:id/finalize
  └── reportSnapshotService.createSnapshot(visitId)
        └── Fetches: visit, patient, all test results + ranges, signing doctor
        └── Inlines signature image path
        └── Writes ReportSnapshot { data: JSON blob }
  └── reportAccessService.createToken(snapshotId)
        └── nanoid(12) → base64url token
        └── Writes ReportAccessToken
  └── notificationService.sendReportReady(visitId)  ← fire-and-forget
        └── whatsappCloudService.sendTemplateMessage(phone, token)

Patient: GET /reports/:token
  └── reportAccessService.validateToken(token)
  └── reportRendererService.renderReportHtml(snapshot)
        └── inlineSignatureImage()  ← reads file → base64 data URI
  └── pdfGenerationService.generatePdf(html)
        └── Puppeteer: emulateMediaType('screen') for digital PDF
  └── res.send(pdfBuffer) with Content-Type: application/pdf
```

### 6.2 Test Catalog: Creating a New Version

```
Owner: POST /api/clinical-definitions/:id/new-version
  Headers: If-Match: <currentUpdatedAt>    ← optimistic lock
  
  └── clinicalDefinitionService.createNewVersion(id, data)
        └── Check: DB updatedAt === If-Match value  ← conflict check
        └── Lock: UPDATE existing to status=INACTIVE
        └── Clone: INSERT new TestDefinition with:
              rootDefinitionId = original.rootDefinitionId (or original.id for v1)
              version = old.version + 1
              status = ACTIVE
              ...all other fields from request body
        └── Copy: reference ranges, interpretation rules → new version
  └── Returns new TestDefinition
```

### 6.3 Authentication Flow

```
User: POST /api/auth/login { email, password }
  └── authService.login(email, password)
        └── Prisma: find User by email
        └── bcrypt.compare(password, user.passwordHash)
        └── jwt.sign({ id, email, role }, JWT_SECRET, { expiresIn: '7d' })
        └── auditService.log(LOGIN_SUCCESS | LOGIN_FAILED, userId, ...)
  └── Returns { token, user: { id, email, role, name } }

Frontend: authStore.login(token, user)
  └── Stores in localStorage (Zustand persist)
  └── All subsequent requests: Authorization: Bearer <token>

Frontend periodic check: authStore.checkTokenExpiration()
  └── jwt-decode(token).exp < Date.now() / 1000
  └── If expired: authStore.logout() → redirect to /login
```

---

## 7. Security Model

### Authentication
- All routes except `/reports/:token`, `/webhooks/whatsapp`, and `/api/auth/login` require a valid JWT.
- JWT signed with `JWT_SECRET` (symmetric HS256). Rotation requires re-login of all users.
- Tokens expire in 7 days (configurable in `authService.ts`).

### Authorization (RBAC)
- Three roles: `staff`, `doctor`, `owner`.
- Routes use `requireRole(...)` middleware inline.
- `owner` can always do what `staff` or `doctor` can do (by listing multiple roles).

### Branch Isolation
- Every DB query in every service includes `branchId: req.branchId` in the `where` clause.
- This is not enforced at the DB level (no Row Level Security) — it is an application-level convention. Consistency is critical.

### Input Validation
- Route handlers validate request bodies using inline checks.
- `utils/validation.ts` provides shared validators.
- Prisma parameterizes all queries — no raw SQL injection risk except in intentional raw queries (none currently).

### Public Report Access
- The 12-character base64url token has 72 bits of entropy — brute-forcing is computationally infeasible.
- Tokens currently do not expire (`expiresAt: null`). Expiry can be added by setting `expiresAt` on the `ReportAccessToken` record.

### WhatsApp Webhook Verification
- Meta sends a `hub.verify_token` on webhook setup. Must match `WHATSAPP_VERIFY_TOKEN` env var.
- Incoming messages validated via Meta's signature header (planned — currently trust-based).

---

## 8. Infrastructure & Deployment

### Services Map

| Service | Platform | URL | Deploy Trigger |
|---------|----------|-----|---------------|
| Frontend | Vercel | `sobhanaportal.com` | Push to `main` |
| Backend API | Render (Docker) | `reports.sobhanaportal.com` | Push to `main` |
| Database | Render Managed PostgreSQL | (internal) | Manual migration on deploy |

### Backend Docker Build

```dockerfile
# health-hub-backend/Dockerfile (simplified)
FROM node:18-slim
# Install system Chromium (for Puppeteer in headless mode)
RUN apt-get install -y chromium
# Set env to use system Chrome instead of bundled
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN npx tsc
# Run migrations at container start, then launch server
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
```

### Why Render + Docker (not serverless)?

Puppeteer requires a persistent Chromium process. Serverless functions cold-start too slowly (2-3s per PDF) and have execution time limits incompatible with Puppeteer's startup overhead. A persistent Docker container on Render keeps Chromium pre-warmed. See `docs/DECISIONS.md` for the full ADR.

### Database Migrations

Prisma migrations are applied automatically at container start (`prisma migrate deploy`). The migration history is in `health-hub-backend/prisma/migrations/`. Never use `prisma migrate dev` in production — it can reset the DB.

### Vercel SPA Configuration

`health-hub/vercel.json` contains a catch-all rewrite:
```json
{ "rewrites": [{ "source": "/(.*)", "destination": "/" }] }
```
This ensures React Router handles all navigation client-side and refreshing `/diagnostics/result-entry` doesn't return a 404.
