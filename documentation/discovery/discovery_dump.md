# Sobhana Portal Discovery Dump

> Engineering Liaison Agent output for BA discovery on the customer-facing diagnostics storefront.
>
> Scope: Tier 1 code extraction, Tier 2 operational discovery, Tier 3 system contracts. All artifacts derived faithfully from the existing `health-hub-backend/` codebase. No speculation, no architectural redesign, no inferred systems.

## How to use this dump

This index document is the **entry point**. Each entry below is a one-paragraph summary plus a pointer to the full per-artifact markdown file. The supporting files preserve raw source verbatim and the architectural observations that travel with each.

To consume:
1. Read this file top-to-bottom for an overview.
2. Open each `*.md` listed under "Files" for full source + analysis.
3. For the diagnosticVisits route, read `diagnosticVisits_overview.md` first; the five `_partN.md` files contain the verbatim 4145-line route source split into ~850-line chunks.

---

## Files

All paths are relative to `documentation/discovery/`.

### Tier 1 — Code Extraction

| # | File | Subject |
| - | --- | --- |
| 1 | [`schema_analysis.md`](./schema_analysis.md) | Full Prisma schema (1428 LOC) + relationship map, indexing, money strategy, soft-delete |
| 2a | [`diagnosticVisits_overview.md`](./diagnosticVisits_overview.md) | Endpoint map, middleware chain, transactions, notifications, audit logging, status transitions |
| 2b | [`diagnosticVisits_part1.md`](./diagnosticVisits_part1.md) | Source lines 1–850 |
| 2c | [`diagnosticVisits_part2.md`](./diagnosticVisits_part2.md) | Source lines 851–1700 |
| 2d | [`diagnosticVisits_part3.md`](./diagnosticVisits_part3.md) | Source lines 1701–2550 |
| 2e | [`diagnosticVisits_part4.md`](./diagnosticVisits_part4.md) | Source lines 2551–3400 |
| 2f | [`diagnosticVisits_part5.md`](./diagnosticVisits_part5.md) | Source lines 3401–4146 |
| 3 | [`productOrderService.md`](./productOrderService.md) | BillableProduct → ClinicalPanel → TestDefinition → LabTest resolution + price split |
| 4 | [`billFinancialService.md`](./billFinancialService.md) | Discount/net/paid/due pipeline, payment recording, money normalization |
| 5 | [`notificationService.md`](./notificationService.md) | WhatsApp Cloud API send flow, opt-in, fire-and-forget pattern, template handling |
| 6a | [`payoutService.md`](./payoutService.md) | Payout derivation per doctor type, mark-paid concurrency, rounding rules (annotated) |
| 6b | [`payoutService_source.md`](./payoutService_source.md) | Full verbatim source of `payoutService.ts` (1208 LOC) |
| 7 | [`referenceRangeService.md`](./referenceRangeService.md) | Age/gender range resolution + dual-arch (LabTest vs TestDefinition); HIGH/LOW/CRITICAL is at caller |
| 8 | [`auth_middleware.md`](./auth_middleware.md) | JWT verification, X-Branch-Id enforcement, RBAC, request-id middleware, route-mounting structure |
| 9 | [`public_reports_endpoint.md`](./public_reports_endpoint.md) | `/reports/:token` — token generation, hashing, expiry, rate limiting, download model |
| 10 | [`whatsapp_webhook.md`](./whatsapp_webhook.md) | Inbound Meta webhook verification (HMAC + verify token), MessageLog status updates |

### Tier 2 — Operational Discovery

| # | File | Subject |
| - | --- | --- |
| 11 | [`operational_answers.md`](./operational_answers.md) | Customer site, phlebotomist roster, service-area mapping, home-collection workflow, mobile-readiness, job runner, BSP, branch list, frontend deps, JWT storage |

### Tier 3 — System Contracts

| # | File | Subject |
| - | --- | --- |
| 12 | [`system_contracts.md`](./system_contracts.md) | Audit log, message log, error response, request ID propagation, money handling, integer paise enforcement, Float audit |

---

## Snapshot of Key Findings

### Domain anchors
- **`Visit`** is the single anchor for all medical data (per schema header rule #1). Every diagnostics or clinic interaction is a `Visit` row with `domain: DIAGNOSTICS | CLINIC`.
- **`Bill` is 1:1 with `Visit`** (`Bill.visitId @unique`).
- **`DiagnosticReport` is 1:0..1 with `Visit`**, with versioned `ReportVersion[]` rows; `ReportStatus` flips `DRAFT → FINALIZED` and is intended-immutable.

### Customer-storefront integration assumptions

Per the BA's approved integration assumptions (verbatim from prompt):
1. Customer bookings become `Visit` records in the existing workflow.
2. Finalize gets one additional publish step.
3. Existing operational flow remains unchanged.

These map onto the existing code as follows (factual):
- A customer booking that becomes a `Visit` must populate `branchId`, `patientId`, `domain: DIAGNOSTICS`, `status: DRAFT|WAITING`, `billNumber` (via `generateDiagnosticBillNumber(branch.code)`), and a `Bill` row plus `TestOrder[]` (via `productOrderService.resolveProducts` → `billItemService.buildDiagnosticBillItems`).
- The "additional publish step" at finalize would extend the existing `POST /api/visits/diagnostic/:id/finalize` flow (line 3609), which already snapshots the report version and triggers `sendReportReady` via fire-and-forget WhatsApp notification.
- "Existing operational flow remains unchanged" — confirmed feasible: storefront becomes a new ingestion path that produces a `Visit`; no existing handler signatures need to change.

### What does NOT exist in the repo

The following systems are **NOT FOUND**:
- Customer-facing storefront (no `/book`, no `/storefront`, no second frontend repo here).
- Phlebotomist roster / scheduling.
- Branch service-area mapping (no pincode/geo on `Branch`).
- Home-collection workflow (no pickup/route/transit model).
- Background job runner (no BullMQ, node-cron, agenda; only fire-and-forget dynamic `import()`).
- SMS sending code path (channel exists in enum but unused).
- Inbound WhatsApp message parsing (only delivery statuses are processed).

### Money policy
- **Integer paise everywhere.** All money fields use Prisma `Int` with `*InPaise` suffix; no `Decimal` columns; no `Float` money fields. Rupee inputs converted via `Math.round(rupees * 100)`.
- **Single currency: INR.** No `currencyCode` column in any model.

### Auth & branch model
- Auth via httpOnly cookie `jwt` (preferred) or `Authorization: Bearer` (legacy fallback).
- Branch context via `X-Branch-Id` header (else `User.activeBranchId`). Live re-validation against DB on every request.
- RBAC inline via `requireRole(...)`; not applied on `diagnosticVisits` router (any authenticated branched user can use those endpoints).

### Public report links
- 12-character base62-like token; stored as **SHA-256 hash** in DB (`ReportAccessToken.token @unique`).
- Default `expiresAt = null` (never expires).
- Rate-limited per IP (30/min) and per (IP, token) (10/min).
- Legacy plaintext-token rows are silently migrated to hashed form on first access.

### Notification provider
- **Direct Meta WhatsApp Cloud API** (`graph.facebook.com/v21.0`). No third-party BSP SDK.
- Templates: `bill_receipt`, `lab_report_ready`, `lab_report_partial_ready`. Language hard-coded to `en`.
- Opt-in tracked on `Patient.whatsappOptIn` (+ `whatsappOptInAt`, `whatsappOptInSource`); manual staff resends auto-opt-in.

### Payout system
- Per-test, per-day ledger entries (`DoctorPayoutLedger`).
- Three doctor types: `REFERRAL`, `CLINIC`, `DIAGNOSTIC_CENTER`.
- Commission snapshotted on `TestOrder` for `REFERRAL` + `DIAGNOSTIC_CENTER` (immutable post-order); read live for `CLINIC`.
- Mark-paid uses atomic `updateMany` for race safety; cascade-pays only ledger rows derived **before** the approved `paidAt` timestamp.

### Audit log
- Insert-only convention (no DB-level enforcement).
- Token-like values in payloads are SHA-256-hashed before persistence.
- `oldValues` / `newValues` stored as `String` (JSON.stringify), not `Json`.

### Migration period (factual)
- Schema actively carries dual FKs on `TestOrder` and `TestResult`: `testId` (legacy `LabTest`) + `testDefinitionId` (new `TestDefinition`).
- New-arch chain: `TestDefinition` → `ClinicalPanel` → `BillableProduct`. Legacy chain still operational via `LabTest` + `PanelDefinition` + `PanelTestItem`.
- `productOrderService` auto-creates `LabTest` rows from `TestDefinition` data on first reference (price `0`, since pricing now lives on `BillableProduct`).

---

## Hard Constraints Honored

- ❌ No architectural redesign suggested.
- ❌ No migration proposed.
- ❌ No refactor / "we should..." statements.
- ❌ No simplification or rewrite.
- ❌ No inferred systems.
- ✅ Exact naming preserved (model names, field names, enum values).
- ✅ Exact API shapes preserved.
- ✅ Exact schema fields preserved.
- ✅ Uncertainty called out explicitly (`UNKNOWN`, `NOT FOUND`).

---

## Source Audit Trail

| Source file | LOC | Reproduced verbatim in |
| --- | ---: | --- |
| `prisma/schema.prisma` | 1428 | `schema_analysis.md` |
| `src/routes/diagnosticVisits.ts` | 4145 | `diagnosticVisits_part1.md`–`_part5.md` |
| `src/services/productOrderService.ts` | 389 | `productOrderService.md` |
| `src/services/billFinancialService.ts` | 329 | `billFinancialService.md` |
| `src/services/notificationService.ts` | 483 | `notificationService.md` |
| `src/services/whatsappCloudService.ts` | 157 | `notificationService.md` |
| `src/services/payoutService.ts` | 1208 | `payoutService_source.md` (full) + `payoutService.md` (annotated) |
| `src/services/referralPayoutService.ts` | 165 | `payoutService.md` |
| `src/services/referenceRangeService.ts` | 224 | `referenceRangeService.md` |
| `src/middleware/auth.ts` | 98 | `auth_middleware.md` |
| `src/middleware/branch.ts` | 109 | `auth_middleware.md` |
| `src/middleware/rbac.ts` | 81 | `auth_middleware.md` |
| `src/middleware/requestId.ts` | 24 | `auth_middleware.md` + `system_contracts.md` |
| `src/routes/reportDownload.ts` | 270 | `public_reports_endpoint.md` |
| `src/services/reportAccessService.ts` | 261 | `public_reports_endpoint.md` |
| `src/services/tokenService.ts` (DEAD legacy) | 61 | `public_reports_endpoint.md` (referenced) |
| `src/routes/webhooks.ts` | 165 | `whatsapp_webhook.md` |
| `src/services/auditService.ts` | 78 | `system_contracts.md` |
| `src/index.ts` (entry point) | 383 | `auth_middleware.md` (route mount section) |

---

## Document Conventions

- All file paths cited use markdown links so a viewer (VS Code, GitHub, web preview) can click through.
- Source code is rendered in fenced code blocks; raw bytes preserved (no reformatting).
- Verbatim quotes from source are presented as fenced blocks or marked as "(verbatim from source)".
- Architectural observations are factual statements only; trade-offs and recommendations are out of scope per the prompt's hard constraints.
