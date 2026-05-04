# Contributing

How the codebase is structured, what conventions to follow, and how to make a change land cleanly.

For setup instructions: [`README.md`](../README.md). For architectural context: [`ARCHITECTURE.md`](ARCHITECTURE.md).

---

## Contents

1. [Local environment](#1-local-environment)
2. [Codebase layout](#2-codebase-layout)
3. [Coding conventions](#3-coding-conventions)
4. [Making a change end-to-end](#4-making-a-change-end-to-end)
5. [Database changes](#5-database-changes)
6. [Common pitfalls](#6-common-pitfalls)
7. [Commit and PR workflow](#7-commit-and-pr-workflow)
8. [Things we do *not* have yet](#8-things-we-do-not-have-yet)

---

## 1. Local environment

Quick start (full instructions in [`README.md`](../README.md)):

```bash
# Backend
cd health-hub-backend
npm install
# create .env from the README's env-var table
npx prisma migrate deploy
npm run db:seed && npm run seed:catalog   # optional demo data
npm run dev                                # → http://localhost:10000

# Frontend (new terminal)
cd health-hub
npm install
npm run dev                                # → http://localhost:8080
```

Frontend points at backend via `VITE_API_BASE_URL` (defaults to `http://localhost:3000` so set it for our `10000` port).

---

## 2. Codebase layout

### Backend

```
health-hub-backend/src/
├── index.ts                ← start here — wires middleware + routes + warms Puppeteer
├── lib/
│   ├── prisma.ts           ← THE singleton PrismaClient
│   ├── redis.ts            ← optional Redis client
│   ├── logger.ts           ← Pino instance
│   ├── sentry.ts           ← Sentry init
│   ├── healthChecks.ts     ← /health probe logic
│   └── loginLockout.ts     ← per-email lockout via Redis
├── middleware/
│   ├── auth.ts             ← JWT → req.user
│   ├── branch.ts           ← X-Branch-Id → req.branchId
│   ├── rbac.ts             ← requireRole(...)
│   ├── rateLimit.ts        ← Redis-backed rate limit
│   └── requestId.ts        ← X-Request-Id propagation
├── routes/                 ← thin HTTP layer — no business logic
│   └── <resource>.ts
├── services/               ← all business logic
│   └── <feature>Service.ts
└── utils/
    ├── errors.ts           ← ValidationError, NotFoundError, etc.
    ├── validation.ts       ← shared input validators
    └── clinicalValidation.ts
```

**Rule.** Routes call services. Routes do not call Prisma directly except for trivial lookups. Services do not import from `routes/`.

### Frontend

```
health-hub/src/
├── App.tsx                 ← React Router routes + global providers
├── main.tsx                ← entry
├── lib/
│   ├── api.ts              ← API_BASE constant (only place to set the backend URL)
│   ├── validation.ts       ← form validators
│   ├── richText.ts         ← sanitize / normalize HTML for narrative reports
│   ├── formulaUtils.ts     ← derived-parameter evaluator
│   └── reportAccess.ts     ← open / download / print finalized reports
├── store/                  ← Zustand: authStore, branchStore, appStore
├── hooks/                  ← use-mobile, use-toast (sparse — most pages inline state)
├── components/
│   ├── ui/                 ← shadcn primitives — DO NOT EDIT
│   ├── layout/             ← AppLayout, Sidebar, ProtectedRoute
│   ├── diagnostics/        ← TestValueCombobox, RichTextNarrativeEditor, PdfPreview, …
│   ├── print/              ← BillReceipt, ClinicPrescriptionPrint
│   └── patient360/
├── pages/                  ← one file per page; many >800 LOC (god files — see ADR-014)
│   ├── diagnostics/
│   ├── clinic/
│   ├── owner/
│   ├── doctor/
│   └── legal/              ← Privacy, ToS, Data Deletion
└── types/index.ts          ← shared TS interfaces (currently duplicated with Prisma — drift risk)
```

**Rule.** Pages do not contain business logic — they orchestrate hooks/components and call APIs. New domain-level UI belongs in `components/<domain>/`, not inlined in a page file.

---

## 3. Coding conventions

### TypeScript

- **Strict mode is on** in both packages' `tsconfig.json`. Never reach for `any` — use `unknown` and narrow.
- Type API responses in `health-hub/src/types/index.ts` and import from there.
- Backend uses Prisma-generated types (`@prisma/client`) directly for DB models. Frontend redeclares them — this is current technical debt; if you change a DB shape, update both sides.

### Naming

| What | Convention | Example |
|---|---|---|
| React component file | PascalCase | `PatientCard.tsx` |
| Service/util file | camelCase | `reportSnapshotService.ts` |
| React component | PascalCase | `function PatientCard() {}` |
| Function | camelCase | `async function createSnapshot() {}` |
| Variable | camelCase | `const branchId = req.branchId` |
| Constant | UPPER_SNAKE_CASE | `const MAX_RANGE_OVERLAP = 0` |
| Prisma model field | camelCase | `createdAt`, `branchId` |
| CSS class | kebab-case | `.report-bottom-section` |

### File layout

- One React component per file (small inline sub-components are OK).
- One service module per file. Multiple exports inside one file are fine — group by feature.
- Route files are plural-resource named: `patients.ts`, `signingDoctors.ts`, `clinicalDefinitions.ts`.

### Errors

**Backend.** Throw `ValidationError`, `NotFoundError`, `ConflictError`, `UnauthorizedError`, `ForbiddenError`, or `InternalError` from [`utils/errors.ts`](../health-hub-backend/src/utils/errors.ts). The global error handler in `index.ts` translates them to JSON. **Never `res.status(500).json(...)` in a route handler** — throw and let the handler do it. Keeps shape consistent, attaches `requestId`, reports to Sentry.

```ts
if (!visit) throw new NotFoundError('Visit not found');
if (alreadyFinalized) throw new ConflictError('Cannot edit a finalized report');
```

**Frontend.** Surface errors via `toast.error(...)` from `sonner`. Don't let UI crash — wrap risky renders with an `ErrorBoundary` once we add one (current gap).

### Comments

Explain *why*, not *what*. Code already says what.

```ts
// BAD
// increment version
const next = current + 1;

// GOOD
// Version numbers are 1-based, strictly increasing per rootDefinitionId.
// We never reuse a version even after a soft-delete — would confuse audit logs.
const next = current + 1;
```

JSDoc on exported service functions:

```ts
/**
 * Clones a TestDefinition into a new ACTIVE version, locking the prior version.
 * Reference ranges and interpretation rules are copied to the new row.
 *
 * @throws ConflictError if If-Match doesn't match current updatedAt
 * @throws ValidationError if the definition's status doesn't allow new versions
 */
export async function createNewVersion(rootId: string, data: UpdatePayload, ifMatch: string) { … }
```

### The branch-isolation rule

Every Prisma query for branch-scoped data **must** include `branchId` in the `where` clause:

```ts
// CORRECT
await prisma.patient.findFirst({ where: { id, branchId: req.branchId } });

// LEAKS DATA across branches
await prisma.patient.findFirst({ where: { id } });
```

This is enforced by convention, not by the database. One missed filter = a cross-branch data leak.

### Money

All amounts live as **integer paise** (`Int` in Prisma), never as float. Use the helpers in `lib/referralPayouts.ts` to format for display. Never do float arithmetic on money.

### Time

Stored as `DateTime` (UTC) by Postgres. Display in `BUSINESS_TIME_ZONE` (default `Asia/Kolkata`). Use the formatters in [`reportRendererService`](../health-hub-backend/src/services/reportRendererService.ts) — don't reimplement.

---

## 4. Making a change end-to-end

Walkthrough: adding a `referralSource` field to diagnostic visits.

### 4.1 Schema

In [`prisma/schema.prisma`](../health-hub-backend/prisma/schema.prisma):

```prisma
model Visit {
  …
  referralSource String?    // nullable so existing rows are valid
}
```

### 4.2 Migration

```bash
cd health-hub-backend
npx prisma migrate dev --name add_referral_source_to_visit
```

If migrate-dev fails on the shadow DB (a known Neon issue we've hit before), create the migration SQL by hand under `prisma/migrations/<timestamp>_add_referral_source_to_visit/migration.sql` and apply with `npx prisma migrate deploy`. Then `npx prisma generate`. Commit the migration directory.

### 4.3 Service

Add the field to whichever service writes to `Visit`. Validate at the entry point.

### 4.4 Route

In [`routes/diagnosticVisits.ts`](../health-hub-backend/src/routes/diagnosticVisits.ts), accept the field on `POST /` (and any update endpoint), validate, pass to the service.

### 4.5 Frontend type

In [`health-hub/src/types/index.ts`](../health-hub/src/types/index.ts) extend the `Visit` interface. Until we have shared types this stays manual.

### 4.6 UI

Add the input to `DiagnosticsNewVisit.tsx` (or the relevant page). Include in the mutation payload.

### 4.7 Verify

- Backend typecheck: `npm run type-check` in `health-hub-backend`.
- Frontend typecheck: `npx tsc --noEmit` in `health-hub`.
- Manual: create a visit with the new field set, hit the GET endpoint, inspect the response.
- DB sanity: `npm run db:studio` → check the row has the value.

---

## 5. Database changes

### Do
- Always create a migration file. Always commit it.
- Make new columns nullable when added to a populated table (otherwise migration fails).
- Run `npx prisma generate` after schema edits.
- For renames or destructive changes use a multi-step migration: add new column → backfill → switch reads → switch writes → drop old column. Spread across multiple deploys.

### Don't
- Don't run `npx prisma migrate reset` on anything that isn't your local dev DB. It drops everything.
- Don't edit a migration file after it has been applied anywhere. Write a new corrective migration instead.
- Don't change `@@unique` constraints on a populated table without a planned data migration.

For real production migrations, follow [`runbooks/database-migrations.md`](runbooks/database-migrations.md).

---

## 6. Common pitfalls

### "Failed to fetch" from the frontend
Almost always CORS. Check, in order:
1. Backend running? `curl http://localhost:10000/health`
2. `VITE_API_BASE_URL` correctly pointed at the backend?
3. Header you're sending listed in `allowedHeaders` in [`src/index.ts`](../health-hub-backend/src/index.ts)?

### Branch context missing in a new route
If `req.branchId` is undefined inside your route handler, you forgot to mount the route after `branchContextMiddleware` in `index.ts`. All public routes (`/reports/:token`, `/webhooks/whatsapp`) are deliberately mounted *before* it.

### Prisma client doesn't know about your new model
Run `npx prisma generate`. The IDE TypeScript server may also cache the old client — restart the TS server after a generate.

### Migration fails on shadow DB but works in prod
Known issue with Neon + Prisma's `migrate dev`. Workaround: write the migration SQL by hand and use `migrate deploy`. See ADR-013 in [`DECISIONS.md`](DECISIONS.md).

### React Query showing stale data after a mutation
We're not using react-query consistently yet — most pages refetch via `useEffect`. If you do reach for react-query, remember to invalidate the relevant query key after a mutation.

### Signature missing in PDF
`reportRendererService.inlineSignatureImage()` reads the signature path from the snapshot and converts to base64 before the HTML hits Puppeteer. If the file is gone from disk / R2, the PDF renders without the signature and a warning is logged. Check storage.

### TypeScript `@/` alias
Frontend uses `@/` mapped to `src/`. Use `import { Button } from '@/components/ui/button'` over relative imports.

---

## 7. Commit and PR workflow

### Branches

We're loose with branch naming today. The conventions we'd like to see going forward:

```
feat/<short-description>      ← new functionality
fix/<short-description>       ← bug fix
chore/<short-description>     ← deps, refactor, docs
hotfix/<short-description>    ← urgent prod fix
```

### Commits

Conventional Commits style is preferred but not enforced (no commit-lint hook yet).

```
<type>(<scope>): <short description>

<body — what changed and *why*; not *how* (the diff shows how)>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `style`, `test`, `build`, `ci`.

Bad: `redid the bill fix`, `fixes`, `wip`. (Yes, our git log has these. Aim higher.)
Good: `fix(diagnostics): include If-Match header in CORS allowlist for new-version endpoint`

### Pre-push checks

```bash
# Backend
cd health-hub-backend
npm run type-check        # tsc --noEmit, must pass
npm run lint              # eslint, should pass
npm run build             # tsc, must pass

# Frontend
cd health-hub
npx tsc --noEmit          # must pass
npm run build             # vite build, must pass
npm run lint              # should pass
```

Open a PR using the [PR template](../.github/pull_request_template.md). Self-review the diff before requesting review.

### What "done" means

- Typecheck + build pass on both packages
- Manual smoke test of the affected flow
- Any new env var documented in `README.md`
- Any new ADR-worthy decision recorded in `DECISIONS.md`
- Any migration committed alongside the schema change

---

## 8. Things we do *not* have yet

So you don't waste time looking:

- **Automated tests** (Vitest/Jest, Playwright, etc.) — see [`TESTING.md`](TESTING.md) for the plan
- **CI pipeline** (`.github/workflows/`) — none currently
- **Branch protection on `main`** — direct commits visible in history
- **Pre-commit hooks** (husky / lefthook / lint-staged) — none
- **Renovate / Dependabot** — not configured
- **Codecov / coverage gates** — none
- **Storybook** — none
- **Generated API client / OpenAPI spec** — none
- **react-query usage** — installed, not used. Same for react-hook-form + zod.

Each of these is a worthwhile addition — see [`DECISIONS.md`](DECISIONS.md) for the long-term direction.
