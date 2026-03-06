# Contributing Guide — Sobhana Health Hub

Welcome. This document explains how the codebase is structured, what conventions to follow, and how to add new features correctly.

---

## Table of Contents

1. [Getting Your Environment Running](#1-getting-your-environment-running)
2. [Codebase Tour](#2-codebase-tour)
3. [Coding Conventions](#3-coding-conventions)
4. [Adding a New Feature — Walkthrough](#4-adding-a-new-feature--walkthrough)
5. [Database Changes](#5-database-changes)
6. [Common Pitfalls](#6-common-pitfalls)
7. [Commit & Branch Workflow](#7-commit--branch-workflow)

---

## 1. Getting Your Environment Running

Follow the README for full setup. Quick summary:

```bash
# Backend
cd health-hub-backend
npm install
cp .env.example .env   # Fill in DATABASE_URL and JWT_SECRET
npx prisma migrate dev
npm run dev             # http://localhost:3000

# Frontend (new terminal)
cd health-hub
npm install
npm run dev             # http://localhost:5173
```

Essential: set `VITE_API_BASE_URL=http://localhost:3000` in `health-hub/.env.local`.

---

## 2. Codebase Tour

### Backend: Where things live

```
health-hub-backend/src/
├── index.ts               ← START HERE — wires everything together
├── lib/prisma.ts          ← the ONE PrismaClient instance
├── middleware/
│   ├── auth.ts            ← JWT → req.user
│   ├── branch.ts          ← X-Branch-Id header → req.branchId
│   └── rbac.ts            ← requireRole() factory
├── routes/                ← HTTP interface only; no business logic
│   └── <resource>.ts      ← One file per REST resource
├── services/              ← ALL business logic lives here
│   └── <feature>Service.ts
└── utils/
    ├── errors.ts          ← Custom Error subclasses
    └── validation.ts      ← Reusable input validators
```

**Rule**: Route files call service functions. Route files do not contain business logic.

### Frontend: Where things live

```
health-hub/src/
├── App.tsx                ← All routes defined here
├── lib/api.ts             ← API_BASE_URL — only place to define the backend URL
├── store/                 ← Zustand: authStore, branchStore, appStore
├── hooks/                 ← Custom hooks (use-mobile, use-toast)
├── components/
│   ├── layout/            ← AppLayout, Sidebar, TopNav, ProtectedRoute
│   └── ui/                ← Shadcn components (do not edit these directly)
├── pages/                 ← One file per page/view
│   ├── diagnostics/
│   ├── clinic/
│   ├── owner/
│   └── doctor/
└── types/                 ← TypeScript interfaces shared across pages
```

**Rule**: Business logic stays in services (backend). Pages and components should only call APIs and render responses.

---

## 3. Coding Conventions

### TypeScript

- **Strict mode is on** (`"strict": true` in both `tsconfig.json`s).
- Never use `any`. Use `unknown` if you don't know the type and narrow it.
- For API response types: define them in `health-hub/src/types/` and import from there.

### Naming

| What | Convention | Example |
|------|-----------|---------|
| React component files | PascalCase | `PatientCard.tsx` |
| Service/util files | camelCase | `reportSnapshotService.ts` |
| React components | PascalCase | `function PatientCard(...)` |
| Functions | camelCase | `async function createSnapshot(...)` |
| Variables | camelCase | `const branchId = req.branchId` |
| Constants | UPPER_SNAKE_CASE | `const MAX_RANGE_OVERLAP = 0` |
| DB model fields | camelCase (Prisma default) | `createdAt`, `branchId` |
| CSS class names | kebab-case | `.report-bottom-section` |

### File Organization

- One React component per file (except tiny sub-components used only within one file).
- One service export per service file (though multiple functions are fine in one service file).
- Route files are named after the resource in plural: `patients.ts`, `signingDoctors.ts`.

### Error Handling

**Backend:**
- Throw `ValidationError`, `NotFoundError`, or standard `Error` from services.
- Route handlers wrap service calls in `try/catch` and return appropriate HTTP status codes.
- Never let an unhandled promise rejection crash the server — always `.catch(console.error)` on fire-and-forget calls.

**Frontend:**
- React Query surfaces errors automatically; display them with a toast using `useToast()`.
- For mutations, use the `onError` callback in `useMutation`: `onError: (err) => toast({ title: 'Error', description: err.message })`.

### Comments

Write comments that explain **why**, not **what**. The code already says what — explain the reasoning:

```typescript
// BAD:
// increment version number
const newVersion = currentVersion + 1;

// GOOD:
// Version numbers are 1-based and strictly increasing per rootDefinitionId.
// We cannot reuse a version number even after deletion (would confuse audit logs).
const newVersion = currentVersion + 1;
```

For public service functions, write a JSDoc block:

```typescript
/**
 * Creates a new immutable version of a TestDefinition.
 *
 * The existing version is locked (status → INACTIVE) and cannot be edited again.
 * All reference ranges and interpretation rules are copied to the new version.
 *
 * @param id - The ID of the currently ACTIVE TestDefinition to version
 * @param data - The new field values for the version; null values are intentional resets
 * @param currentUpdatedAt - The expectedUpdatedAt for optimistic concurrency check
 * @returns The newly created TestDefinition (next version)
 * @throws ValidationError if the definition is not currently ACTIVE
 * @throws ConflictError if another update has occurred since currentUpdatedAt
 */
async function createNewVersion(id: string, data: UpdatePayload, currentUpdatedAt: Date) { ... }
```

### Branch Isolation — Critical Convention

Every Prisma query in every service MUST include `branchId: req.branchId` (or equivalent) in the `where` clause. Missing this causes data leakage between branches. Example:

```typescript
// CORRECT:
const patient = await prisma.patient.findFirst({
  where: { id: patientId, branchId: req.branchId }
});

// DANGEROUS (leaks data from other branches):
const patient = await prisma.patient.findFirst({
  where: { id: patientId }
});
```

---

## 4. Adding a New Feature — Walkthrough

Example: Adding a "referral source" tracking field to diagnostic visits.

### Step 1: Update the Prisma schema

In `health-hub-backend/prisma/schema.prisma`, add the field:

```prisma
model DiagnosticVisit {
  ...
  referralSource String? // ← new field (nullable is usually safer for existing rows)
}
```

### Step 2: Create and apply the migration

```bash
cd health-hub-backend
npx prisma migrate dev --name add-referral-source-to-diagnostic-visit
```

This generates a migration file in `prisma/migrations/`. Commit this file.

### Step 3: Add the backend service logic

Create or update the relevant service. For a simple field, the update may just be adding it to the `prisma.diagnosticVisit.create({ data: { ...input } })` call.

### Step 4: Add the route

In `src/routes/diagnosticVisits.ts`, accept the new field in the POST body:

```typescript
const { referralSource } = req.body; // add to destructuring
```

Pass it to the service call.

### Step 5: Add the TypeScript type to the frontend

In `health-hub/src/types/`, update or add the interface:

```typescript
interface DiagnosticVisit {
  ...
  referralSource?: string;
}
```

### Step 6: Update the form/page

In the relevant page (`DiagnosticsNewVisit.tsx`), add the input field and include it in the mutation payload.

### Step 7: Test end-to-end

1. Create a diagnostic visit with a referral source via the UI
2. Check the DB has the value: `npx prisma studio`
3. Verify the value appears in the visit detail response

---

## 5. Database Changes

### Do

- Always create a migration with `npx prisma migrate dev --name <description>`
- Commit the generated migration file in `prisma/migrations/`
- Make new fields nullable if they will be added to existing rows (otherwise migration fails on non-empty DB)
- Run `npx prisma generate` if you change `schema.prisma` in a way that affects the Prisma client types

### Don't

- Never run `npx prisma migrate reset` in production — it drops all data
- Never edit existing migration files — create a new corrective migration instead
- Never modify `@@unique` or `@id` constraints on live tables without a carefully planned migration (may require data backfill)

### Seeding

If your feature needs default data, add it to the appropriate seed file in `prisma/`. Run:

```bash
npx tsx prisma/seed-full-catalog.ts
```

---

## 6. Common Pitfalls

### "Failed to fetch" from the frontend

Usually a CORS issue. Check:
1. Is the header you're sending listed in `allowedHeaders` in `health-hub-backend/src/index.ts`?
2. Is the frontend `VITE_API_BASE_URL` correct?
3. Is the backend running?

### Prisma unique constraint errors on version creation

The `TestDefinition` model has `@@unique([rootDefinitionId, version])`. You cannot insert two records with the same `rootDefinitionId` and `version`. This constraint replaced an older `@@unique([code, isLatest])` (migration `20260302000000`). If you see constraint violations creating versions, ensure `createNewVersion` increments the version number correctly.

### Report snapshot missing signature

If a newly added signing doctor's signature is not appearing in PDFs:
1. Check the signature file exists in the upload directory on the server
2. Check `reportRendererService.inlineSignatureImage()` — it reads the file path from the snapshot and converts to base64. If the path is wrong or the file is missing, it logs a warning and renders without the signature.
3. In dev: signature files are served from `health-hub-backend/public/uploads/signatures/`

### React Query stale data after mutation

After a mutation, you must invalidate the relevant query:

```typescript
await queryClient.invalidateQueries({ queryKey: ['visits', branchId] });
```

If you forget this, the UI shows stale data until the user refreshes.

### Branch context missing

If you write a new route that should be branch-scoped but forget to register it after `authenticateToken` and `attachBranchContext` middleware in `index.ts`, `req.branchId` will be undefined and all DB queries will silently return cross-branch data or error.

Check: is the route mounted inside the section of `index.ts` that applies both middleware?

### TypeScript path aliases

The backend uses relative imports. The frontend uses the `@/` alias (mapped to `src/`). Example:

```typescript
// Frontend — correct:
import { Button } from '@/components/ui/button';

// Frontend — also works but less clean:
import { Button } from '../../components/ui/button';
```

---

## 7. Commit & Branch Workflow

### Branch naming

```
feature/short-description     ← new functionality
fix/short-description         ← bug fix
chore/short-description       ← maintenance (deps, refactor, docs)
hotfix/short-description      ← urgently needed fix on main
```

### Commit message format

```
<type>: <short description>

<optional body: what and why, not how>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `style`

Examples:
```
feat: add referral source field to diagnostic visits
fix: include If-Match in CORS allowed headers
chore: update Prisma to 5.x
docs: add ARCHITECTURE.md
refactor: extract referenceRangeService from resultEntryService
```

### Before pushing

```bash
# Backend
cd health-hub-backend
npm run build    # must succeed with zero TypeScript errors

# Frontend
cd health-hub
npm run build    # must succeed
```

Do not push code that fails to compile.
