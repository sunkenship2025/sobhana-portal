# File: src/routes/diagnosticVisits.ts (Overview)

## Purpose
Express router mounted at `/api/visits/diagnostic` (mount point owned by `src/index.ts`). Owns the full diagnostic-visit lifecycle: create → add tests → enter results → collect sample → finalize → release partial → preview/download report. Largest single route file in the backend (4145 lines).

## Dependencies / Imports

```ts
import { Router } from "express";
import QRCode from "qrcode";
import {
  DiagnosticWorkflowMode,
  ReportStatus,
  VisitStatus,
} from "@prisma/client";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { branchContextMiddleware } from "../middleware/branch";
import { generateDiagnosticBillNumber } from "../services/numberService";
import { logAction } from "../services/auditService";
import {
  evaluateDerivedTargets,
  normalizeDependencyCodes,
  type DerivedFormulaTarget,
} from "../services/derivedParameterService";
import { resolveReferenceRanges } from "../services/referenceRangeService";
import {
  createAccessToken,
  recordAccessByReportVersionId,
} from "../services/reportAccessService";
import {
  buildEphemeralSnapshot,
  createReportSnapshot,
  getReportSnapshot,
  saveReportSnapshot,
} from "../services/reportSnapshotService";
import {
  resolveProducts,
  ProductResolutionError,
} from "../services/productOrderService";
import { renderReportHtml } from "../services/reportRendererService";
import { generateMergedReportPdf } from "../services/mergedReportPdfService";
import prisma from "../lib/prisma";
import { buildDiagnosticBillItems } from "../services/billItemService";
import {
  deriveDiagnosticVisitComposition,
  isPureBillOnlyVisit,
} from "../services/diagnosticWorkflowService";
import {
  areReferralPayoutsEqual,
  distributeFixedAmountInPaise,
  normalizeReferralOverrideInput,
  type NormalizedReferralPayout,
} from "../services/referralPayoutService";
import { derivePayout } from "../services/payoutService";
import {
  buildBillFinancialResponse,
  collectBillDue,
  computeBillFinancialsFromPersisted,
  normalizeBillFinancialInput,
  recomputeBillFinancialsForSubtotal,
} from "../services/billFinancialService";
```

## Middleware Chain (router-level)

```ts
const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
```

All routes under this router require:
- Valid Bearer JWT via `authMiddleware` (populates `req.user`).
- `X-Branch-Id` header validated against the user via `branchContextMiddleware` (populates `req.branchId`).

No route-specific RBAC is applied at the router level. RBAC for restricted operations is delegated to other routes (e.g., admin routes mount `requireRole`); diagnostic-visit endpoints are accessible to any authenticated staff with branch context.

## Endpoint Map (by line)

| Method | Path | Line | Purpose |
| --- | --- | --- | --- |
| GET | `/` | 380 | List diagnostic visits (branch-scoped or patient-360 if `?patientId=`) |
| GET | `/:id` | 519 | Fetch single visit with full nested data (orders, results, panel hierarchy, ranges, input configs) |
| POST | `/` | 1207 | **Create new diagnostic visit** (anchor flow) |
| PATCH | `/:id` | 1960 | Update visit status / patch operations |
| POST | `/:id/collect-due` | 2083 | Collect additive due payment (incremental cash/online) |
| POST | `/:id/tests` | 2184 | Add tests to existing visit (E3-03) |
| DELETE | `/:id/tests/:testOrderId` | 2437 | Remove a test order from visit |
| POST | `/:id/results` | 2604 | Save test results (numeric + text + flags) |
| POST | `/:id/collect-sample` | 3094 | Record sample collection and decrement stock |
| GET | `/:id/report-snapshot` | 3214 | JSON snapshot for grouped screen preview |
| GET | `/:id/preview-report` | 3263 | Generate ephemeral preview of the report |
| GET | `/:id/finalized-report` | 3338 | Staff-only HTML view of finalized report |
| GET | `/:id/finalized-report/pdf` | 3398 | Staff-only finalized report PDF |
| POST | `/:id/confirm-ready` | 3459 | Legacy compatibility for older pure bill-only visits |
| POST | `/:id/finalize` | 3609 | **Finalize report** (immutable transition) |
| POST | `/:id/release-partial` | 3831 | Release partial finalized report (subset of orders) |

## Key Helper Functions (file-local)

- `zeroPayoutSnapshot()` / `emptyOptionalPayoutSnapshot()` — payout default factories.
- `buildDerivedMetadata(formula, dependsOnCodesRaw)` — uses `normalizeDependencyCodes()` from `derivedParameterService`; returns `{ isDerived, formulaExpression, dependsOnCodes }`.
- `determineResultFlag(numValue, range)` — derives `CRITICAL_HIGH | CRITICAL_LOW | HIGH | LOW | NORMAL | null` purely from the numeric value vs `referenceMin/Max` and `criticalMin/Max`.
- `loadInputConfigsByRootId(rootIds)` — bulk-loads `TestInputConfig` rows; returns `Map<rootDefinitionId, TestInputConfigPayload>`.
- `loadLatestDefinitionFormulasByCode(codes)` — bulk-loads latest `TestDefinition` rows for a set of codes (`isLatest=true`).
- `applyReferralRuleToPrices(prices, rule)` / `applyOptionalReferralRuleToPrices` — distributes a referral commission rule (PERCENTAGE or FIXED_AMOUNT via `distributeFixedAmountInPaise`) across order prices.
- `loadFinalizedReportSnapshotForVisit(visitId)` — fetches latest finalized `ReportVersion` for a visit, plus its persisted snapshot from `reportSnapshotService.getReportSnapshot`.
- `getVisitComposition(orders, status, versions)` — wrapper around `deriveDiagnosticVisitComposition` to compute UI flags (`hasReportableOrders`, `hasBillOnlyOrders`, `hasExternalUploadOrders`, `hasReportInclusionOrders`, `hasEntryScreenOrders`, `hasFinalizedReport`, `nextAction`).
- `getReportableOrders(orders)` — filters to `workflowMode === REPORTABLE`.
- `getReportInclusionOrders(orders)` — filters to `REPORTABLE | EXTERNAL_UPLOAD` (drives report inclusion).

## File-Local Constants

```ts
const DERIVED_MANUAL_OVERRIDE_NOTE = "__DERIVED_MANUAL_OVERRIDE__";
const DERIVED_AUTO_NOTE_PREFIX = "Auto-calculated: ";

const DEFAULT_INPUT_CONFIG: TestInputConfigPayload = {
  inputType: 'NUMERIC',
  defaultValue: null,
  valueOptions: [],
};
```

## Validation Approach

- **No external schema validator (zod / joi / yup) is imported in this file.**
- Validation is hand-rolled with `if`-guards inside each handler. Errors are returned as plain JSON: `{ error: <CODE>, message: <human text> }`.
- Common error codes used: `NOT_FOUND`, `VALIDATION_ERROR`, `INTERNAL_ERROR`, `INVALID_STATUS`, `REPORT_FINALIZED`, `REPORT_NOT_FOUND`, `REPORT_NOT_AVAILABLE`, plus product-resolution errors propagated from `ProductResolutionError`.
- Money inputs are normalized via `normalizeBillFinancialInput()` and `normalizeReferralOverrideInput()` in `billFinancialService`/`referralPayoutService`.

## Transaction Boundaries (factual)

`prisma.$transaction(...)` is used at the following lines:

| Line | Operation |
| --- | --- |
| 1545 | Create-visit atomic write (visit + bill + test orders + referral join + audit) |
| 2011 | PATCH visit (status updates with side effects) |
| 2334 | Add tests to existing visit |
| 2542 | Delete test from visit (orphan check + decrement totals) |
| 2724 | Save test results |
| 3165 | Collect-sample workflow (status transition + audit) |
| 3686 | Finalize report (snapshot creation + version flip to FINALIZED + payout derivation) |
| 3998 | Release partial report (separate finalized version of subset) |

Audit logging via `logAction(...)` is fire-and-forget (`void logAction(...)`) **outside** the transaction in most cases (see line 1764, 2395, 2571, 3174, 3525, 3728, 4085) — meaning audit-log inserts are not part of the visit transaction. (Per schema rule, `AuditLog` is insert-only.)

## Notification Triggers (factual)

WhatsApp/SMS notification dispatch is **fire-and-forget via dynamic `import()`** to avoid synchronous blocking of the response:

```ts
// Around line 1852 — bill notification on create
import("../services/notificationService").then(... )

// Around line 3795 — report-ready on finalize
import("../services/notificationService").then(({ sendReportReady }) => { ... })

// Around line 4111 — report-ready on partial release
import("../services/notificationService").then(({ sendReportReady }) => { ... })
```

Failures are caught and logged with `[Notification] ... non-blocking` prefixes — they never propagate as HTTP errors.

## Payment Interactions (factual)

- Visit creation generates the bill in the same transaction via `buildDiagnosticBillItems()` and `recomputeBillFinancialsForSubtotal()` (from `billFinancialService`).
- Standalone payment endpoint: `POST /:id/collect-due` (line 2083) routes through `collectBillDue()` from `billFinancialService` to add a `PaymentTransaction` row and recompute `Bill.paidAmountInPaise` + `paymentStatus`.
- Payment status transitions (`PENDING → PAID`) happen inside `collectBillDue` based on whether `paidAmountInPaise >= totalAmountInPaise - discountAmountInPaise`. (See `billFinancialService.md` for exact logic.)

## Audit Logging (factual)

Audit `logAction()` calls in this router emit:
- `CREATE` on visit creation (line 1764)
- `UPDATE` on PATCH visit (line 2395), test add (also 2395), test delete (line 2571)
- `CREATE` on collect-sample (line 3174)
- `FINALIZE` on report finalize (line 3525, 3728) and on partial release (line 4085)

Each call passes `branchId`, `actionType`, `entityType`, `entityId`, `userId`, `oldValues?`, `newValues?`, `ipAddress?`, `userAgent?` as configured by `auditService.logAction` (see `auditService.ts`).

## Status Transition Logic (factual)

- `Visit.status` enum: `DRAFT | WAITING | IN_PROGRESS | COMPLETED | CANCELLED`.
- `ReportVersion.status` enum: `DRAFT | FINALIZED`.
- On finalize (`POST /:id/finalize`, line 3609): visit transitions to `VisitStatus.COMPLETED` (see lines 3521, 3535, 3592) and the `ReportVersion` status flips to `FINALIZED` (lines 3693, 3738) inside the transaction.
- `confirm-ready` (line 3459) is a legacy path for "pure bill-only" visits (no reportable orders) that flips the visit straight to `COMPLETED` without creating a report version. Detection uses `isPureBillOnlyVisit()` from `diagnosticWorkflowService`.
- `release-partial` (line 3831) creates a new `ReportVersion` with `status = FINALIZED` containing only a subset of orders (line 4022, 4095). The visit itself is **not** marked `COMPLETED` by this endpoint (left in current status until full finalize).

## Architectural Observations (factual)

- The router file mixes route handlers with multiple file-local helper functions (`buildDerivedMetadata`, `determineResultFlag`, `applyReferralRuleToPrices`, `loadInputConfigsByRootId`, etc.) — these are not exported and not shared with other routes.
- Many handlers re-implement the same shape of bulk-fetch / reshape logic (e.g., panel hierarchy resolution in both `GET /:id` and `POST /:id/results` flows).
- Heavy reliance on dual-FK pattern: handlers always check `testDefinition` (new) before falling back to `test` (legacy `LabTest`). Snapshot fields (`testNameSnapshot`, `testCodeSnapshot`, etc.) are also consulted as a third source of truth.
- Notification dispatch uses dynamic `import("../services/notificationService")` rather than top-level import — the comment surrounding it labels these as "fire-and-forget."
- `logAction(...)` is invoked outside transactions, which means an audit row may not exist if the surrounding HTTP request errors after the transaction commits but before logging.
- The router does not paginate `GET /` — it returns the full list of visits in scope (potentially full branch history).

## Notes

- Source code is preserved verbatim in `diagnosticVisits_part1.md` through `diagnosticVisits_part5.md` (~850 lines per chunk).
- Each chunk states the line range of the original file.
- No code is omitted across the five parts.
