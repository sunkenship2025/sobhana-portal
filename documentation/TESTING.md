# Testing strategy

> **Honest current state:** zero automated tests. No Vitest / Jest / Playwright. Neither `package.json` has a `test` script. Every regression ships to production silently and is found by users.
>
> This document is the **comprehensive plan** for changing that. It covers what to test, how to test it, what *not* to test, the order of work, and the constraints that shape that order. Read it end-to-end before adding the first test — the *order* matters as much as the tests themselves.

---

## Contents

**Part I — The plan**
1. [Why this matters (concrete examples)](#1-why-this-matters)
2. [Test pyramid](#2-test-pyramid)
3. [Prerequisites — testability before tests](#3-prerequisites)
4. [Phase 0 — smoke](#4-phase-0--smoke)
5. [Phase 1 — unit](#5-phase-1--unit)
6. [Phase 2 — integration](#6-phase-2--integration)
7. [Phase 3 — end-to-end](#7-phase-3--end-to-end)
8. [Phase 4 — specialty](#8-phase-4--specialty)
9. [Frontend testing](#9-frontend-testing)
10. [Compliance and healthcare-specific tests](#10-compliance-and-healthcare-specific-tests)

**Part II — How**

11. [Tooling decisions](#11-tooling-decisions)
12. [Test data strategy](#12-test-data-strategy)
13. [File layout, naming, structure](#13-file-layout-naming-structure)

**Part III — Process**

14. [Coverage policy](#14-coverage-policy)
15. [CI integration](#15-ci-integration)
16. [Anti-patterns](#16-anti-patterns)
17. [Definition of done per phase](#17-definition-of-done-per-phase)

**Part IV — Roadmap**

18. [Sequencing — week 1 / month 1 / quarter 1](#18-sequencing)
19. [Rules for new code today](#19-rules-for-new-code-today)

---

# PART I — THE PLAN

## 1. Why this matters

Specific bug classes the git log shows we've shipped to production *because we have no tests*:

| Bug class | Recent commits | Test that would have caught it |
|---|---|---|
| Bill discount math | "redid the bill fix", "finally same fix", "fix bill", multiple iterations | Unit / property-based on `billFinancialService` |
| Report finalization regressions | "signs are now not stored in snapshot", "fixed prints" | Snapshot stability test on `reportSnapshotService` |
| Test-definition versioning | `@@unique([code, isLatest])` blocked v3 creation | Unit test on `clinicalDefinitionService.createNewVersion` |
| External upload merge edge cases | "minor bug fix for uploadable report" (twice) | Integration on `mergedReportPdfService` |
| CORS preflight | `If-Match` header missing from allowlist | Smoke / integration on protected endpoints |

The **compliance angle**: this is healthcare. A regression that misreports a result, leaks data across branches, or alters a finalized report is materially worse than a typical SaaS regression. Tests are not optional for the parts of the system that handle PHI or finance — they're the only thing standing between us and a regulatory event.

**The cost of *not* writing tests is not zero today** — it's the time spent debugging regressions after they ship, plus reputational + compliance exposure.

---

## 2. Test pyramid

```
                  ╱ ╲
                 ╱   ╲       e2e          handful of critical user journeys
                ╱─────╲                    Playwright against staging
               ╱       ╲                   ~5–10 tests
              ╱         ╲   integration    real DB, real Redis, fake R2/WhatsApp/Puppeteer
             ╱           ╲                 Vitest, sequential, ~50–100 tests
            ╱             ╲
           ╱               ╲   unit        services, utilities, hooks, components (FE)
          ╱                 ╲              Vitest, parallel, ~hundreds of tests
         ╱                   ╲
        ╱─────────────────────╲ smoke      "does the app start, does /health work,
       ╱                       ╲           does login succeed"
      ╱_________________________╲          ~5 tests, runs in <30 s
```

**Smoke** is the cheapest first win — added below any other tier. It catches catastrophic regressions (broken import, missing env var, schema mismatch) before any narrower test would even run.

**Each tier exists because the one below it is too expensive to cover the same surface.** Don't write an integration test for something a unit test would catch. Don't write an e2e test for something an integration test catches.

---

## 3. Prerequisites

**Testability is a property of code, not of test code.** Some of our code is currently untestable as a unit because of how it's structured. The order of work below interleaves *small refactors* with adding tests:

### 3.1 God files block unit testing

| File | LOC | Problem |
|---|---|---|
| `routes/diagnosticVisits.ts` | ~3,800 | Bill math, payout derivation, snapshot building all interleaved with HTTP handler code. Can't unit-test the math without spinning up Express. |
| `pages/DiagnosticsNewVisit.tsx` | ~2,234 | Form state + product-picker logic + bill preview tangled. Component test would simulate the entire page. |
| `pages/ManagePanelDefinitions.tsx` | ~1,769 | Same shape — logic inlined in JSX. |

**For these, the rule is:** the first PR that adds tests to a file also extracts the testable logic into a function/service. Tests + extraction land together.

### 3.2 No `test` script anywhere

Adding Vitest is a one-time setup. Until then, no other progress is possible.

### 3.3 Dual-FK migration in flight

`TestOrder` and `TestResult` carry both `testId` (legacy `LabTest`) and `testDefinitionId` (new). Many services branch on which is present. Tests written today must cover *both* paths or they'll silently miss regressions when we cut over.

### 3.4 Inline `fetch()` on the frontend

The frontend hand-rolls fetch calls in every page (~150 sites). Component tests will need to mock these via MSW (Mock Service Worker) until we centralize through an API client. Document the convention: in test setup, always wrap renders with an MSW handler.

### 3.5 No FE↔BE shared types

Until shared types exist, FE tests assert against locally-defined types that may drift from BE. Pact or schema-validated tests guard against this — but only after the schema layer exists.

---

## 4. Phase 0 — Smoke

**Goal:** catch catastrophic regressions in <30 seconds. Zero excuse to skip running.

**Targets** (5 tests total):

1. Backend boots: import `index.ts`, no module-level error.
2. `/health` returns 200 with `postgres: "ok"` against a test DB.
3. `POST /api/auth/login` with seeded credentials returns a valid JWT.
4. `GET /api/visits/diagnostic` (auth'd) returns 200 + an array shape.
5. `Patient` Prisma model can be created and read (sanity on Prisma client + DB connectivity).

**Tooling:** Vitest, runs against a Neon test branch (or local Postgres in CI). No mocks at this tier — if it doesn't work end-to-end against real infra, we want to know.

**Runtime budget:** 30 seconds total. If it gets slower, prune.

**When to write:** week 1.

---

## 5. Phase 1 — Unit

**Goal:** isolate business logic, test it without DB / network / framework. Hundreds of tests, all parallel, sub-second runtime.

### 5.1 Targets (priority-ranked by past-bug-density)

| # | Target | Why | Bug classes prevented |
|---|---|---|---|
| 1 | `billFinancialService` | Most "fix the bill" commits in history | Discount math, partial payment, due tracking, percentage rounding, paise-integer drift |
| 2 | `payoutService` | Money + complex rules | Pre-/post-discount allocation, % vs fixed, per-test commission overrides |
| 3 | `referenceRangeService` | Compliance-critical (wrong range = wrong flag) | Age boundary, gender resolution, fallback to default, multiple matching ranges |
| 4 | `derivedParameterService` | Sandbox safety + correctness | Formula evaluator security, division by zero, missing dependents |
| 5 | `numberService` | Race conditions on bill numbers | Concurrent calls produce different sequence numbers |
| 6 | `clinicalDefinitionService.createNewVersion` | The `pick()` helper | `null` is not collapsed to old value via `??` |
| 7 | `patientMatchingService` | Dedup correctness at registration | Phone match across branches, identifier-type collision, name fuzzy edge cases |
| 8 | `lib/validation.ts` (FE + BE) | Hand-rolled validators today | Age unit conversion, identifier format, phone normalization |
| 9 | `lib/formulaUtils` (FE) | Same evaluator as BE, separate impl | Sync drift between FE-preview and BE-authoritative result |
| 10 | `reportRendererService` (HTML generation portion only) | Snapshot determinism | Idempotent rendering — same snapshot → same HTML byte-for-byte |

### 5.2 Test types per target

For each target, the suite includes:

- **Happy path** — the canonical case
- **Boundary** — empty input, max input, off-by-one (e.g. age = 0, age = 100, exactly at the discount threshold)
- **Error path** — invalid input, missing FK, malformed JSON
- **Negative** — what should be rejected
- **Idempotency** — calling twice produces the same result (for finance + finalize-style operations)

For the finance services (`billFinancialService`, `payoutService`), add **property-based tests** with `fast-check`:

```ts
import fc from 'fast-check';
import { computeBill } from '@/services/billFinancialService';

test('paid + due == netPayable for any valid input', () => {
  fc.assert(
    fc.property(
      fc.record({
        gross: fc.integer({ min: 100, max: 10_000_000 }),
        discountPaise: fc.integer({ min: 0, max: 1_000_000 }),
        paidPaise: fc.integer({ min: 0, max: 10_000_000 }),
      }),
      ({ gross, discountPaise, paidPaise }) => {
        const result = computeBill({ gross, discountPaise, paidPaise });
        expect(result.paidPaise + result.duePaise).toBe(result.netPayablePaise);
      }
    )
  );
});
```

This single property catches every "off by one paise" / "discount applied twice" / "due not subtracted" regression in one assertion.

### 5.3 Testability refactors paired with each target

Test work is gated by extracting the logic from its god file. Track per-target:

| Target | Currently lives in | Refactor before testing |
|---|---|---|
| `billFinancialService` | already a service | none — go |
| `payoutService` | already a service | none — go |
| `referenceRangeService` | already a service | none — go |
| `derivedParameterService` | service + duplicated in FE `lib/formulaUtils` | extract pure evaluator; test once for both |
| `numberService` | service | none — go |
| `clinicalDefinitionService.createNewVersion` | service | none — go |
| `patientMatchingService` | service | none — go |
| Inline bill computation in `routes/diagnosticVisits.ts` | route file | **extract to `billFinancialService` first** |
| Inline payout computation in `routes/diagnosticVisits.ts` | route file | **extract to `payoutService` first** |

The two "extract first" items are the highest-priority refactors *because* they unblock the highest-priority tests.

### 5.4 Mocking policy

- **Don't mock Prisma.** Either the test exercises real Prisma (Phase 2) or the function under test doesn't touch Prisma. If a "unit test" needs a Prisma mock, it's actually an integration test or the function needs to be split.
- **Don't mock services with logic.** Mock at I/O boundaries: HTTP clients, external APIs, file I/O.
- **Use `vi.fn()` for spying on calls** — confirming a fire-and-forget side effect happened.

### 5.5 Definition of done

- Every Phase 1 target has ≥ 90% line coverage of its functions
- Suite runs in < 5 seconds total
- Every PR that modifies a Phase 1 target file modifies or adds a test
- The two pre-test extractions for `diagnosticVisits.ts` are landed

---

## 6. Phase 2 — Integration

**Goal:** test the seams between services + DB + middleware that unit tests can't cover.

### 6.1 Targets

**Visit lifecycle**
- `POST /api/visits/diagnostic` end-to-end: visit + bill + test orders created atomically. Simulate a partial DB failure mid-transaction; assert rollback (no orphan visits, bills, or test orders).
- `POST /api/visits/diagnostic/:id/results` then `/:id/finalize`: snapshot is byte-stable across multiple finalize calls.
- `PATCH /api/visits/diagnostic/:id` after finalize: rejected with 409.

**Branch isolation (compliance-critical — see §10)**
- Login as Branch A staff; query every list endpoint asking for Branch B's data; expect 404 / empty / 403, never B's actual rows.
- Try to access Branch B's `Visit`, `Bill`, `Patient` (where applicable), `TestResult` by direct ID. Expect 404.
- Repeat with `owner` role; same result expected (owners can switch branches but still can't *cross-query*).

**Auth**
- Login → bcrypt verify → JWT issued.
- Login with wrong password 5× → account lockout via Redis, 6th attempt blocked.
- JWT with `exp` in past → 401.
- JWT with valid signature but unknown user → 401.
- Audit log written for `LOGIN_SUCCESS` and `LOGIN_FAILED`.

**Concurrency**
- Two concurrent `POST /api/visits/diagnostic` from the same staff user; assert both succeed, both bill numbers are unique, no row corruption.
- Two concurrent `POST /:id/finalize` on the same visit; one succeeds (creates snapshot), the other returns 409 ("already finalized").

**Optimistic locking**
- `POST /api/clinical-definitions/:rootId/new-version` with stale `If-Match`; expect 409.

**Snapshot stability**
- Finalize a report → fetch the rendered HTML.
- Edit the patient's name in DB.
- Re-render the same report version → HTML is byte-identical (snapshot did not pull live data).

**External integrations (mocked at the boundary)**
- WhatsApp send: assert `notificationService` writes a `MessageLog` with `status=SENT` when the mock returns 200.
- WhatsApp send: assert `MessageLog` with `status=FAILED` and populated `failureReason` when mock throws.
- R2 upload: assert `ExternalReportUpload` row written when upload succeeds; assert error returned to caller when upload fails.

### 6.2 DB strategy

**Option A — Neon branch per test suite (preferred):**
- CI creates a Neon branch from a known base.
- Each suite gets its own branch (parallel-safe).
- Branch torn down at suite end.
- Pro: fast (Neon branching is seconds), data is real Postgres.
- Con: Neon-specific; doesn't run locally without a Neon dev account.

**Option B — Testcontainers (Postgres in Docker):**
- Each test run spins up a fresh Postgres container.
- Apply migrations with `prisma migrate deploy`.
- Pro: works anywhere Docker runs; offline-capable.
- Con: 5–10s per container startup; requires Docker in CI.

**Decision:** start with Option B (no special infra dependency) → migrate to Option A once CI is on a runner with Neon CLI access.

### 6.3 Test isolation

Each suite begins with a clean DB state. Two ways:

- **Truncate-and-seed** at suite start. Slow but bulletproof.
- **Transaction-rollback wrapper** — every test runs inside a transaction that rolls back. Fast but doesn't catch bugs in code that uses its own transaction.

**Rule:** transaction-rollback for tests of single-service logic; truncate-and-seed for cross-service tests and anything that itself uses Prisma transactions.

### 6.4 Definition of done

- Every endpoint listed under "Visit lifecycle" / "Branch isolation" / "Auth" has a passing test.
- Suite runs in < 60 seconds in CI.
- Branch-isolation tests run for **every** list endpoint (matrix-driven, not per-endpoint hand-rolled).

---

## 7. Phase 3 — End-to-end

**Goal:** verify the highest-value user journeys actually work in a deployed environment.

E2E tests are **expensive** — slow, flaky-prone, hard to debug. Be ruthless about scope.

### 7.1 Journeys

**Critical happy path** — the lab tech's daily reality:
1. Log in as staff
2. Search a patient by phone; create a new patient if not found
3. Create a diagnostic visit; pick a product
4. Save the bill
5. Open Pending Results; enter values for each test
6. Finalize the report
7. Open the staff finalized URL; PDF preview renders
8. Click "Send WhatsApp"; verify `MessageLog` shows `SENT`

**Owner journey:**
1. Log in as owner
2. View dashboard — counts match recently-finalized visits
3. Open a finalized report
4. Download PDF; assert it's a valid PDF binary

**Failure path:**
1. Create visit + bill with discount → log in as different staff → try to finalize → blocked with "outstanding due"
2. Pay the due → finalize succeeds

**Branch isolation (UI level):**
1. Log in as Branch A user
2. Switch to Branch B in the UI
3. Confirm Branch A's recent visit is no longer visible
4. Switch back to Branch A; data returns

### 7.2 Tooling

**Playwright.** One config file, two profiles:
- `playwright.config.staging.ts` — runs against deployed staging
- `playwright.config.local.ts` — runs against `npm run dev` on localhost

Tests live in `e2e/` at the repo root.

### 7.3 When to run

- **PR open:** local profile against ephemeral environment (when we have one)
- **Nightly:** staging profile against deployed staging
- **Pre-release:** all journeys + manual smoke

E2E results **don't block PR merge**. They can be flaky for non-code reasons (Render slow, network, browser quirks). Failures generate alerts; investigation is async.

### 7.4 Definition of done

- 4 journeys above all pass against staging
- Average runtime per journey < 60s
- Flake rate < 5% across 100 consecutive runs

---

## 8. Phase 4 — Specialty

**Visual regression**
- Tool: Percy or Chromatic.
- Targets: report PDF (rendered HTML pre-Puppeteer), bill receipt, prescription print.
- Catches the "pink stripe" / "stale CSS" / "logo cropped" class. We hit one of these in v1.9.0.

**Load**
- Tool: k6 or Artillery.
- Scenarios:
  - 50 concurrent staff finalizing reports in 60s — Puppeteer concurrency cap behavior under burst.
  - 100 concurrent patient PDF downloads — Redis cache hit rate, R2 latency.
- Run quarterly, not in CI. Manual.

**Security**
- Tool: OWASP ZAP baseline scan against staging.
- Tool: `npm audit` blocking in CI for high+ severity.
- Tool: Snyk or GitHub Dependabot security alerts.
- Run: every PR for `npm audit`; nightly for ZAP.

**Accessibility**
- Tool: `@axe-core/playwright` integrated into the e2e tests.
- Targets: every visited page in the e2e journeys.
- Failure threshold: zero serious / critical issues.

**Mutation testing**
- Tool: Stryker.
- Run: monthly on the unit test suite. Identifies tests that pass when they shouldn't.
- Don't gate CI on this — it's a meta-quality check.

**Contract testing (when OpenAPI / tRPC lands)**
- Tool: Pact or Spectral.
- Verifies FE expectations match BE schema.

---

## 9. Frontend testing

Frontend has its own tier structure that runs alongside backend tiers.

### 9.1 Hooks (unit)

Test custom hooks in isolation with `@testing-library/react`'s `renderHook`. Today we have `use-mobile`, `use-toast` — both trivial. As we extract data-fetching hooks (per [DECISIONS.md](DECISIONS.md) ADR-015), they become high-value test targets.

### 9.2 Components

Test logic-bearing components — not shadcn primitives.

**Targets:**
- `TestValueCombobox` — combobox + custom-value behavior
- `TestInputConfigEditor` — type-aware default field, preset reordering
- `PdfPreview` — loading/error states (`react-pdf` itself is mocked)
- `DiagnosticsResultEntry`'s test-input row — switches on `inputType`

**Tooling:**
- `vitest` with `jsdom` environment
- `@testing-library/react` for rendering and queries
- `@testing-library/user-event` for interactions
- **MSW** (`msw`) for mocking `fetch` calls — wrap component renders with MSW handlers

**Don't:**
- Don't test shadcn / Radix primitives — they have their own tests upstream
- Don't snapshot-test JSX trees (brittle) — assert on user-visible behavior

### 9.3 Pages (integration on the FE side)

For the god-page files (`DiagnosticsNewVisit.tsx`, etc.) — write a single integration test per page that walks through the page's primary flow:

1. Mock the API responses for the page's data fetches via MSW
2. Render the page inside the router
3. Drive the user flow with `userEvent`
4. Assert the final mutation was called with the right body

This tests the **integration** of components within the page, but stops short of going to the real backend (that's e2e's job).

### 9.4 Visual regression

Storybook for component isolation + Chromatic for visual diff. Stories double as documentation. Lower priority than unit/integration but high payoff for the report-rendering surface.

---

## 10. Compliance and healthcare-specific tests

These are the tests a regulator or auditor might ask about. They exist as a **separate category** so they're not lost inside generic integration suites.

### 10.1 Branch isolation (matrix test)

For every list-style endpoint, parameterized test:
```
for each role in [staff, doctor, owner, admin]:
  for each endpoint in [...all list endpoints]:
    log in as user from Branch A
    request endpoint with X-Branch-Id: B
    assert: 0 rows from Branch B in the response
```

This is the kind of test that catches a missing `branchId: req.branchId` filter the moment someone forgets it.

### 10.2 Snapshot immutability

After finalize:
- Editing the patient's name doesn't change the rendered PDF for that finalized version.
- Editing the signing doctor's degrees doesn't change the rendered PDF.
- Editing a `TestDefinition`'s reference range doesn't change historical flags.

These tests assert the snapshot read-only invariant — central to the audit defensibility of the report system.

### 10.3 Audit log coverage

For every action listed in `AuditActionType`:
- `LOGIN_SUCCESS`, `LOGIN_FAILED`
- `CREATE`, `UPDATE`, `DELETE` of patient identity fields
- `FINALIZE` of a report
- `PAYOUT_DERIVE`, `PAYOUT_PAID`
- `REPORT_ACCESS` (every public report download)

A test asserts that performing the action writes a corresponding `AuditLog` row.

### 10.4 PHI in logs

Trigger a Pino log line with patient context. Inspect the JSON output. Assert no patient name, phone, identifier, or test result value appears in the log line. Today this fails — the suite is what guarantees it stays passing once we add Pino redaction config.

### 10.5 Time and timezone

- A patient with `dateOfBirth = 2010-12-31` queried in `Asia/Kolkata` returns the correct age regardless of the server's local time.
- An age-band reference range with `maxAgeDays = 365` correctly excludes a 366-day-old patient.
- Daylight-saving transitions (in regions where they apply) don't cause off-by-one age issues.
- Bill timestamps stored as UTC are formatted in IST on display.

### 10.6 Money invariants

`fast-check` property tests:
- For any input, no operation produces a negative `paidAmountInPaise` (overpayment is rejected at validation, not silently flipped).
- `gross == discount + netPayable` for all valid inputs.
- `paid + due == netPayable` for all valid inputs.
- No float arithmetic anywhere — assert with a regex grep on services that all `*Paise` operations use integer arithmetic.

### 10.7 Patient deletion / right-to-erasure

If a patient deletion endpoint exists (or when it does):
- Soft-deleting a patient → patient is invisible in search but linked visits still resolvable
- Hard-deletion path: cascades through `PatientIdentifier`, `PatientChangeLog`, `MessageLog`
- Audit log captures the deletion
- Deletion is rejected if any finalized reports reference the patient (compliance — finalized reports are immutable)

### 10.8 Concurrency on finance

- Two concurrent `POST /:id/collect-due` for the same bill — assert `paidAmountInPaise` ends correctly summed, not racy.
- Idempotency-key handling (when added) — same key + retry produces same result without duplicate transactions.

These tests are how we sleep at night.

---

# PART II — HOW

## 11. Tooling decisions

| Concern | Pick | Why over alternatives |
|---|---|---|
| Unit + integration runner | **Vitest** | First-class TS + ESM, faster than Jest, same API, watch mode is excellent. |
| FE component testing | **Vitest + jsdom + @testing-library/react** | Same runner as backend → one CI job, one watch mode. |
| API mocking on FE | **MSW** | Network-layer interception. Tests use real `fetch` with mocked responses. Survives FE refactor away from inline `fetch`. |
| E2E browser | **Playwright** | Modern, robust, video/trace artifacts on failure, multi-browser. |
| Property-based | **fast-check** | Pure TypeScript, generators are first-class types. |
| Postgres in tests | **Testcontainers (Phase 2 start) → Neon branches (mature)** | Container is portable; Neon branching is faster + closer to prod. |
| Visual regression | **Chromatic** (with Storybook) or **Percy** | Cloud diff service; pick based on pricing. |
| Mutation testing | **Stryker** | TS-aware, CI-friendly. |
| Load | **k6** | Scriptable JS, great metrics, runs anywhere. |
| Accessibility | **@axe-core/playwright** | Integrates into existing e2e flow. |
| Security baseline | **OWASP ZAP** + **npm audit** | Free, well-known. |
| Test data factories | **@faker-js/faker** + hand-rolled builder pattern | Faker for primitives, builders for composed entities. |

---

## 12. Test data strategy

**No fixture files.** Don't store JSON blobs of test data in the repo. Build fixtures with code — they evolve with the schema.

**Builder pattern:**

```ts
// test/builders/patient.ts
export function aPatient(overrides: Partial<Patient> = {}): Patient {
  return {
    id: faker.string.uuid(),
    patientNumber: `P-${faker.number.int({ min: 1000, max: 99999 })}`,
    name: faker.person.fullName(),
    yearOfBirth: faker.number.int({ min: 1940, max: 2024 }),
    gender: faker.helpers.arrayElement(['M', 'F', 'O']),
    ageUnit: 'YEARS',
    whatsappOptIn: false,
    createdAt: new Date(),
    identifiers: [],
    ...overrides,
  };
}
```

**Composition:**

```ts
const visit = aVisit({
  patient: aPatient({ name: 'Test Patient' }),
  testOrders: [aTestOrder({ test: aTest({ code: 'HB' }) })],
});
```

**No shared mutable state.** Every test calls the builder with its own overrides. Two tests building "a patient" never share the same object.

**Seed for integration tests:** an idempotent `prisma/seed.test.ts` that creates a known set of branches, users, test definitions. Suites assume this exists. They don't add to it during the run.

---

## 13. File layout, naming, structure

### Layout

```
health-hub-backend/
├── src/
│   └── services/
│       └── billFinancialService.ts
└── test/
    ├── unit/
    │   └── services/
    │       └── billFinancialService.test.ts
    ├── integration/
    │   └── routes/
    │       └── diagnosticVisits.test.ts
    ├── builders/
    │   └── patient.ts
    └── helpers/
        ├── setup.ts          # global setup, DB ready
        └── auth.ts           # login helper for integration tests

health-hub/
├── src/
└── test/
    ├── unit/
    │   ├── components/
    │   └── hooks/
    └── helpers/
        └── render.tsx        # custom render with router + providers

e2e/
├── tests/
│   ├── critical-path.spec.ts
│   └── owner-journey.spec.ts
└── playwright.config.ts
```

Tests live in `test/` not co-located. Reasoning: discoverable by anyone; co-location bloats `src/` for casual readers.

### Naming

```
<thing>.test.ts             ← unit / integration
<thing>.spec.ts             ← e2e
```

(Vitest accepts both; we use `.test.ts` for non-e2e to distinguish.)

### Test structure (AAA)

```ts
describe('billFinancialService', () => {
  describe('computeBill', () => {
    it('returns netPayable = gross when no discount', () => {
      // Arrange
      const input = { gross: 1000, discountPaise: 0, paidPaise: 0 };

      // Act
      const result = computeBill(input);

      // Assert
      expect(result.netPayablePaise).toBe(1000);
      expect(result.duePaise).toBe(1000);
    });
  });
});
```

- One assertion concept per `it`. Multiple `expect()` calls fine if they verify one fact.
- `describe` per file, then per function under test, then per scenario.
- Test names start with "returns" / "throws" / "rejects" / "writes" — describe behavior, not implementation.

---

# PART III — PROCESS

## 14. Coverage policy

**Per phase:**

| Phase end | Unit | Integration | E2E |
|---|---|---|---|
| Phase 0 done | n/a | n/a | n/a |
| Phase 1 done | 50% backend services overall, 90% on the priority targets in §5.1 | n/a | n/a |
| Phase 2 done | 70% backend overall | every endpoint in §6.1 has at least one test | n/a |
| Phase 3 done | 80% backend, 50% frontend | matrix tests for branch isolation passing | 4 journeys |

**Don't gate CI on coverage thresholds** until Phase 2 is well underway. Premature gating → developers game the metric (test trivial getters, skip hard cases).

**Do** display coverage badges in PR comments via `vitest --coverage` + a CI commenter. Visible without being blocking.

---

## 15. CI integration

Once `.github/workflows/ci.yml` exists:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  backend:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: testpass
        ports: ['5432:5432']
        options: --health-cmd pg_isready --health-interval 10s
      redis:
        image: redis:7
        ports: ['6379:6379']

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: health-hub-backend/package-lock.json }

      - run: npm ci
        working-directory: health-hub-backend

      - run: npm run type-check
        working-directory: health-hub-backend

      - run: npm run lint
        working-directory: health-hub-backend

      - run: npx prisma migrate deploy
        working-directory: health-hub-backend
        env:
          DATABASE_URL: postgres://postgres:testpass@localhost:5432/postgres
          DIRECT_DATABASE_URL: postgres://postgres:testpass@localhost:5432/postgres

      - run: npm run test
        working-directory: health-hub-backend
        env:
          DATABASE_URL: postgres://postgres:testpass@localhost:5432/postgres
          REDIS_URL: redis://localhost:6379

      - run: npm run build
        working-directory: health-hub-backend

  frontend:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm', cache-dependency-path: health-hub/package-lock.json }
      - run: npm ci
        working-directory: health-hub
      - run: npx tsc --noEmit
        working-directory: health-hub
      - run: npm run lint
        working-directory: health-hub
      - run: npm run test
        working-directory: health-hub
      - run: npm run build
        working-directory: health-hub

  audit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm audit --audit-level=high --workspaces=false
        working-directory: health-hub-backend
        continue-on-error: false
      - run: npm audit --audit-level=high --workspaces=false
        working-directory: health-hub
        continue-on-error: false

  e2e:
    if: github.event_name == 'schedule' || github.event.label.name == 'e2e'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx playwright install --with-deps
        working-directory: e2e
      - run: npx playwright test
        working-directory: e2e
        env:
          STAGING_URL: ${{ secrets.STAGING_URL }}
          TEST_USER_EMAIL: ${{ secrets.TEST_USER_EMAIL }}
          TEST_USER_PASSWORD: ${{ secrets.TEST_USER_PASSWORD }}
```

**Required checks** (configured in branch protection):
- `backend / type-check`
- `backend / lint`
- `backend / test` (once tests exist)
- `backend / build`
- `frontend / typecheck`
- `frontend / lint`
- `frontend / test` (once tests exist)
- `frontend / build`
- `audit`

**Not required:**
- `e2e` — runs on schedule + label, results posted but not gating.

---

## 16. Anti-patterns

Things to refuse on review:

| Anti-pattern | Why it's bad |
|---|---|
| **Mocking Prisma** | The mock will diverge from real query behavior; tests pass while production breaks. Use a real DB for anything that touches Prisma. |
| **Snapshot-testing JSX trees** | Brittle, churn-heavy, doesn't assert behavior. Snapshot test the *output the user sees* (rendered text, accessible names) — not the markup. |
| **Snapshot-testing huge HTML/PDF** | Same problem at larger scale. Use visual regression (Chromatic) for that surface. |
| **Sharing mutable state across tests** | One test contaminates the next. Each test sets up its own fixtures. |
| **`it.skip` / `it.todo` left in main** | Either it works or it's deleted. Don't ship aspirational tests. |
| **Tests that test the test framework** | `expect(true).toBe(true)`. Trim. |
| **Multi-asserting tangentially related things in one `it`** | When it fails, you don't know which part broke. Split. |
| **Tests with timing dependencies (`setTimeout(100)`)** | Flaky on slow CI. Use deterministic waits — `waitFor`, `act`. |
| **Hitting external APIs in tests** | WhatsApp, R2, Sentry — never. Mock at the boundary. |
| **HTTP-level test for what a service-level test could cover** | Slow, brittle. Test the function, not the framework around it. |
| **Test files copy-pasted with one value changed** | Indicates a missing helper / parameterized test. Refactor. |
| **Tests that pass even when commented out** | Mutation testing catches these. Self-audit: comment out the function under test; if tests still pass, the test was useless. |

---

## 17. Definition of done per phase

| Phase | Done means |
|---|---|
| **Phase 0** | 5 smoke tests, < 30s, runs locally + (eventually) in CI. Prevents catastrophic regressions. |
| **Phase 1** | All 10 priority targets covered. Property-based tests for finance services. 90% coverage on listed services. Suite < 5s. |
| **Phase 2** | Visit lifecycle, branch isolation matrix, auth, concurrency, snapshot stability all covered. Suite < 60s. |
| **Phase 3** | 4 journeys passing reliably (< 5% flake) against staging. |
| **Phase 4** | Visual regression on report PDF. `npm audit` blocking in CI. Quarterly load-test runbook in place. |

---

# PART IV — ROADMAP

## 18. Sequencing

### Week 1 — bootstrap

- Add Vitest to `health-hub-backend` and `health-hub`
- Add `"test"` and `"test:watch"` scripts
- Write Phase 0 smoke tests
- Stand up CI YAML running typecheck + lint + smoke

### Week 2–3 — first finance unit tests

- Write Phase 1 tests for `billFinancialService` and `payoutService`
- Add `fast-check` and write the money invariant property tests
- Promote those services' coverage to 90%

### Week 4 — extraction

- Extract bill computation from `routes/diagnosticVisits.ts` into `billFinancialService` (the parts not already extracted)
- Extract payout computation from `routes/diagnosticVisits.ts` into `payoutService`
- Tests now cover the extracted code paths

### Month 2 — finish Phase 1

- All remaining Phase 1 service targets
- Frontend unit setup: Vitest with jsdom, RTL, MSW
- First component test: `TestValueCombobox`

### Month 3 — Phase 2 begins

- Testcontainers integration setup
- Visit lifecycle integration tests
- Branch isolation matrix tests
- Auth + lockout integration tests
- This is also when tests should be **required** for new PRs touching covered files

### Quarter 2 — Phase 3 begins

- Playwright setup + 4 critical journeys
- E2E in CI on a schedule
- Visual regression on report PDF (Chromatic / Percy)

### Quarter 3 — specialty

- Mutation testing weekly
- Load testing run + runbook for the next time
- Accessibility audit per page
- Security scan (ZAP) integrated

---

## 19. Rules for new code today

Until a test runner exists, every PR follows the rules in [`CONTRIBUTING.md`](CONTRIBUTING.md):

1. **Manual test plan in the PR description.** Steps you took. Output observed. Edge cases considered.
2. **Finance-touching PRs:** before/after numbers for at least 3 example visits (small, with discount, with partial payment).
3. **Annotate tests-needed places:** `// TODO(test): cover X`. Grep for these the moment Phase 1 starts.

Once the runner exists:

4. **Any change to a Phase-1 priority service** modifies or adds a test in the same PR.
5. **Any new endpoint** has at least one Phase-2 integration test in the same PR.
6. **Any UI flow change to a critical journey** has its e2e test updated in the same PR.
7. **Manual test plans** stay required — automated tests are *additive*, not replacement.

---

## Test debt log

Track tests we know we *should* have but don't, separately from issues. Reasonable home: a top-level `documentation/test-debt.md` (when we have one). Or grep `TODO(test):` across the repo.

When the test debt log is empty, the suite is doing its job.
