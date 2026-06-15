# Changelog

All notable changes are documented here in reverse chronological order. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

For *why* a change was made (not just what), see [`DECISIONS.md`](DECISIONS.md). For operational impact (e.g. migrations to apply), see the **Migration notes** at the bottom of each entry where relevant.

---

## [Unreleased]

### Added
- **Public Bill PDF Links:** Patients now receive a direct button link to view their bill PDF in WhatsApp, powered by a new `BillAccessToken` model and a public `/bills/view/:token` backend route.
- **Mobile PDF Printing Fallback:** For mobile devices encountering printing issues, the frontend now automatically captures the receipt using `html2canvas` and generates a downloadable PDF with `jspdf`.
- **Test Order Display Ordering:** Test orders now carry a `displayOrder` field, ensuring chronological sorting on printed bills and in the visit queue matching the original input order.
- **Bill Payment Status:** The generated bill PDFs now display the payment status (e.g. PAID, PENDING) matching the actual bill transaction state.

### Changed
- Default patient WhatsApp opt-in state has been toggled from disabled to enabled across diagnostic and edit patient forms.
- The React app now silently reloads once if a user encounters a stale chunk (failed to fetch dynamically imported module) after a new deployment.

_Tracked here as commits land on `main`. Entries are promoted to a versioned section at release time — see [`RELEASE.md`](RELEASE.md)._

### Added
- **Report Rendering:** Added support for `spacedDefinitionsGap` in `ClinicalPanel`, allowing customizable gap rows (1-3 rows) between tests within a panel on generated reports.
- **Database Schema:** Added `spacedDefinitionsGap` (Int, default 0) to the `ClinicalPanel` model.
- **Diagnostics Result Entry:** Added display of billed product name (e.g., "(Billed as: [Product Name])") when different from the panel display name in the result entry view. Grouping of orders in result entry is now scoped to the specific `productId` to prevent merging of identical panels from different products.
- **Spaced Definitions Gap Setting.** Added a new configuration option called "Spaced Definitions Gap" to the Layout Configuration settings in the panel editor. This allows toggling spacing between `Off`, `1 Row Gap`, `2 Row Gap`, and `3 Row Gap`. The global report renderer inserts empty table rows to create spacing between tests, affecting live edit preview, WhatsApp PDF, standard PDF print, and the downloaded digital report.
- **Panel Grouping by Product.** In Diagnostics Result Entry, panel grouping is now scoped to the specific `productId` to prevent identical panels from different products from merging. The UI also displays the product name as "(Billed as: [Product Name])" if it differs from the panel display name.
- **URL-based Branch State:** Owner pages (`OwnerDashboardV2`, `OwnerDoctorsPage`, `OwnerMoneyPage`, `OwnerOperationsPage`) now use URL query parameters (`?branch=...`) for branch selector state instead of local component state, enabling shareable URLs.
- **Spaced Definitions Gap Configuration.** Added a new layout configuration for clinical panels (`spacedDefinitionsGap`) allowing 1 to 3 empty table rows to be inserted between tests for better readability on reports. This is universally applied across live edit previews, WhatsApp PDFs, standard printed PDFs, and downloaded digital reports.
- **Smart Auto-focus in Result Entry.** The Diagnostics Result Entry page now automatically focuses the first empty input field when the page loads, allowing staff to resume data entry instantly.
- **Product Code Updates.** Added support for updating product codes via `PUT /api/billable-products/:id` and the UI. Included format validation and uniqueness checks, throwing a `409 Conflict` if the code already exists.
- **Test Order Sorting.** Test orders on bill fetching are now sorted by `createdAt` ascending, falling back to `id` ascending to ensure a consistent list order.
- **Lab Incharge Signing with Branch-Wise Rules.** Added `SigningLabIncharge` and `LabInchargeRule` tables to support assigning specific lab incharges per branch. The report renderer now includes lab incharge signatures (digital versions show the signature image, while printed versions show a manual signing line). Admin UI was updated to a 4-section layout to manage these rules.
- **Master Title Re-added.** Added "Master" back to the patient title options for pediatric patients, completing title and salutation coverage across the application.



- **Auto-save on result entry.** [`DiagnosticsResultEntry`](../health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx) now persists the in-progress draft 1.5 s after the last keystroke and immediately on field blur. An inline status indicator above the action button shows `Saving…` / `Saved · just now` / `Unsaved changes` / `Save failed — will retry`. In-flight saves are coordinated via a ref so the explicit click and the debounced timer never race. The first results-changed render after `fetchVisit` is suppressed via `autoSavePrimedRef` so the initial state load doesn't trigger a no-op POST.
- **Per-test scoped partial release.** New [`PartialReleaseSelectorDialog`](../health-hub/src/components/diagnostics/PartialReleaseSelectorDialog.tsx) lets staff pick exactly which test orders go into the partial-release version. The dialog groups orders by department, hints which rows have been edited vs unedited, and seeds defaults from the current draft.
  - `POST /api/visits/diagnostic/:id/release-partial` now accepts an optional body `{ testOrderIds: string[] }`. With an explicit selection: only those orders are finalized in the current draft; the rest are carried forward into the next DRAFT version untouched. Without a body: legacy behaviour (release every draft result that exists) — preserved for backwards compatibility.
  - `GET /api/visits/diagnostic/:id/preview-report` accepts the same scoping via `?testOrderIds=a,b,c` (or repeated query params), so the preview shown to staff matches byte-for-byte what `release-partial` will ship.
  - `createReportSnapshot(versionId, { selectedTestOrderIds })` and `buildEphemeralSnapshot(visitId, { selectedTestOrderIds })` filter both the test results AND the external uploads down to the selection, so an unselected MRI/X-ray PDF stays attached to its order for a future version instead of being baked into today's merged PDF.
- **Result-entry button label flips with completeness.** "Save Draft & Preview Report" → `Review & Finalize` when every reportable test has a value AND every required external upload is attached, or `Continue with Partial Report` otherwise. The click target itself is the same — only the label changes — so staff get a one-glance read of what's about to happen.

### Changed
- **Zustand Store Reactivity:** Updated components like `AppLayout`, `ContextBanner`, and `ClinicNewVisit` to selectively access `useBranchStore` state properties instead of destructuring, aligning with Zustand best practices for optimal re-rendering.
- **Print Receipt Styling.** Updated the print receipt layout with dynamic grid sizing, wrapped text indentation, reordered fields, and restored the bold patient name formatting for better scannability.
- **Owner Dashboard Branch Filters.** Branch filters in owner dashboards (`OwnerDashboardV2`, `OwnerDoctorsPage`, `OwnerMoneyPage`, `OwnerOperationsPage`) are now persisted using URL search parameters instead of local state, allowing bookmarking and preventing auth hydration from overriding the selection on refresh.
- **Product Code Mutability.** Product codes are no longer strictly immutable after creation. They can now be updated if the new code meets validation rules and does not conflict with existing codes.
- **Branch-Specific Print Addresses.** Bill receipts and clinic prescription prints now dynamically display the correct address based on the branch (e.g., Kukatpally, Balanagar, Chintal).
- **Result Entry Keyboard Navigation.** Implemented "enter to next box" functionality in the Diagnostics Result Entry page, allowing staff to navigate between input fields using the Enter key for faster data entry.



- **Finalize / release lives only inside the preview modal now.** [`DiagnosticsReportPreview`](../health-hub/src/pages/diagnostics/DiagnosticsReportPreview.tsx) no longer surfaces "Finalize" / "Release Partial" buttons on the page itself; staff must open the rendered-PDF preview before those actions appear (inside the modal). The previous `hasReviewedPreview` sessionStorage gate is removed — the modal is now the only path. Eliminates the "looked at the JSON-shaped on-screen card and shipped" failure mode.

### Fixed
- **Report Dividers.** Fixed the report divider line that was rendering below the QR code at the end of printed reports, restoring it and improving the gap rows height.
- **Test Order Preservation:** Fixed a bug in `diagnosticVisits` and `productOrderService` where the input order of selected tests or products was not strictly preserved during database creation. The system now explicitly maps items to preserve the exact sequence chosen by the user.
- **Session Hydration:** Fixed an issue in `authStore.ts` where hydration inadvertently overrode the active branch state.
- **Build Failure:** Fixed unused imports causing frontend build failures.
- **Auth Hydration Branch Override.** Fixed an issue where the auth hydration process on refresh was overwriting the user's currently selected branch with their default active branch.
- **Test Order to Product Panel Mapping.** Fixed a bug where test orders weren't correctly mapped to product panels when a single test definition belonged to multiple different panels across different products.
- **Report Printing Glitches.** Fixed report printing glitches involving `position: fixed` elements and QR code cutting off at page boundaries. (Additionally removed a redundant divider line rendering below the QR code).
- **Validation Error on Patient Update.** Resolved a validation error that occurred during partial patient updates when the patient's age remained unchanged.
- **TestValueCombobox Focus Advance.** Fixed the `TestValueCombobox` to correctly advance focus to the next input field upon selecting a value.
- **Redis Initialization.** Fixed a race condition where the application attempted to ping Redis before the connection was fully ready by waiting for the `ready` event in `ensureRedisReady`.
- **Title Dropdown Bug.** Fixed an issue where an empty string `Select.Item` caused a blank screen on the new patient form.



- **External-upload-only visits couldn't be finalized.** `canFinalizeAll` required `totalReportableCount > 0`, but pure EXTERNAL_UPLOAD visits have no reportable orders — the uploaded PDF *is* the report. Added `isExternalUploadOnly` branch in [`DiagnosticsReportPreview.tsx`](../health-hub/src/pages/diagnostics/DiagnosticsReportPreview.tsx) so single-upload visits can finalize once the PDF is attached.

### Migration notes
- No schema migration. Pure code change; route signature is backwards-compatible (legacy callers without a body still work).

---

## [1.9.0] — 2026-05-03 — Default values for panels + cross-browser PDF preview

### Added
- **Per-test entry-time UI configuration.** Admins can now configure, per `TestDefinition`:
  - `inputType`: `NUMERIC` (default), `FREE_TEXT`, `TEXT_WITH_PRESETS` (combobox), or `SELECT_ONLY` (strict dropdown)
  - `defaultValue`: optional pre-fill for the result-entry field
  - `valueOptions`: list of preset phrasings (used for combobox / strict dropdown)
- New table `TestInputConfig` keyed by `rootDefinitionId` — sibling to `TestDefinition`, **not** versioned. See [DECISIONS ADR-013](DECISIONS.md#adr-013--testinputconfig-as-a-sibling-table-not-on-testdefinition).
- New backend route: `GET/PUT /api/test-input-configs/:rootDefinitionId` plus bulk `GET ?rootIds=…`.
- New frontend components:
  - `TestValueCombobox` — shadcn Popover + cmdk Command with editable typing for combobox tests, "Use custom" footer for free-typed values.
  - `TestInputConfigEditor` — admin editor for input type, default value, drag-reorderable preset list, bulk paste.
  - `PdfPreview` — cross-browser PDF preview using `react-pdf` (pdf.js). Replaces the native `<iframe>` preview to eliminate browser-specific PDF chrome (Chrome's dark toolbar, Safari's bar, Firefox's sidebar). Lazy-loaded to keep main bundle unchanged.
- Result entry rendering: combobox / select-only tests now span the full width of the value-cell row (absorbing the always-empty Reference / Flag columns for text-based tests like RBC Morphology), so long preset phrasings like `NORMOCYTIC HYPOCHROMIC FEW MICROCYTES` display without truncation.
- Diagnostic-visit GET response now embeds `inputConfig` on each `TestOrder` and each `childTest`, eager-loaded by `rootDefinitionId`.

### Fixed
- **Pink stripe artifact in PDF preview.** Report header/footer thin striped bands rendered as pink/magenta in the new `PdfPreview` due to subpixel anti-aliasing at 1× DPR. Forced `devicePixelRatio={Math.max(2, window.devicePixelRatio)}` on each `<Page>` — stripes now render in their true colors.

### Migration notes
- New migration `20260503000000_add_test_input_config`. Pure additive (new enum + new table). Apply with `npx prisma migrate deploy`. The `migrate dev` shadow-DB path failed in our environment due to a pre-existing migration history quirk on Neon; the migration SQL is hand-written and committed alongside.

---

## [1.8.0] — 2026-05-02 — Sentry, Pino-as-default, login rate limit, signature snapshotting fix

### Added
- **Pino structured logging** as the default backend logger. Pretty-printed in dev, JSON in prod. `pino-http` middleware auto-logs every request with method/path/status/duration/requestId. `/health` is excluded to avoid log-stream noise.
- **Sentry** on backend (DSN-gated by `SENTRY_DSN`). Each event tagged with the request ID. 10% trace sample rate.
- **Login rate limit / lockout** via Redis (`lib/loginLockout.ts`). Per-email failure counter; configurable thresholds.
- Business metrics endpoint for owner dashboard.

### Changed
- **Signatures no longer stored in the report snapshot.** Previously, `ReportVersion.signaturesSnapshot` JSON included full base64 signature image data, bloating row size. Now only the signing-doctor *reference* + filesystem path is snapshotted; rendering inlines the image at PDF time. Existing snapshots still work because `inlineSignatureImage()` accepts both shapes.
- Result-entry: result rows are wider; presets and default value pre-fill empty fields.

### Fixed
- Several PDF rendering issues for external-upload pages.

---

## [1.7.0] — 2026-04-30 — External report uploads + merged PDF pipeline

### Added
- **`EXTERNAL_UPLOAD` workflow mode** for `TestOrder`. Lab can upload PDF files (e.g., outsourced reports from another diagnostic center) instead of entering numeric values.
- New table `ExternalReportUpload` (R2-stored PDFs, soft-deleted via `deletedAt`).
- `mergedReportPdfService` — appends external upload pages to the base report PDF using `pdf-lib`. Native PDF page concatenation without re-rendering through Puppeteer.
- 7-day Redis cache (`mergedReportPdfCache.ts`) keyed by snapshot ID + branding version.
- Parallel R2 fetches for multi-upload visits.
- Puppeteer `domcontentloaded` wait (vs default `load`) — ~30% faster page renders without breaking signature inlining.

### Changed
- Report preview (`/preview-report`) now returns the merged PDF (not standalone HTML), so what staff preview matches what the patient downloads byte-for-byte.

---

## [1.6.0] — 2026-04-18 — Bill discounts, partial payments, due tracking

### Added
- `BillDiscountType` enum: `FLAT_AMOUNT` | `PERCENTAGE`.
- `Bill.discountType`, `discountAmountInPaise`, `discountPercentage`, `discountReason`, `paidAmountInPaise`.
- `PaymentTransaction` ledger: per-bill payment records (cash + online; multiple per bill).
- New endpoint `POST /api/visits/diagnostic/:id/collect-due` — additive due collection.
- Report finalization is now blocked while a due exists.
- Add/remove-test flows recompute bill totals; removal is rejected if it would create overpayment.
- Referral percentage payouts use the post-discount allocated amount; fixed payouts are unchanged.
- Patient-facing UI: due warning + "Collect Due" affordance on Pending Results page.
- Print outputs: bills now show subtotal, discount, net payable, paid, due.

---

## [1.5.0] — 2026-03-02 — Version creation fix + CORS

### Fixed
- `If-Match` header was missing from CORS `allowedHeaders`. Browser preflight blocked PUT / new-version requests; the failure mode was a silent "Failed to fetch" with no server log. Added `If-Match` to `allowedHeaders` in [`src/index.ts`](../health-hub-backend/src/index.ts).
- `@@unique([code, isLatest])` on `TestDefinition` prevented creating v3+ of any test (both v1 and v2 have `isLatest=false` with the same code, violating the constraint). Replaced with `@@unique([rootDefinitionId, version])`. Migration `20260302000000`.
- `clinicalDefinitionService.createNewVersion()` used `??` when copying fields, silently discarding intentional `null` resets (e.g., removing a formula). Replaced with a `pick()` helper.

### Changed
- `TestDefinition` unique constraint: `@@unique([code, isLatest])` → `@@unique([rootDefinitionId, version])`.

---

## [1.4.0] — 2026-02-28 — Report layout restructure + signature upload fix

### Fixed
- Signature upload on doctor creation: previously upload required the doctor record to exist (`editingDoctorId`). Signatures could only be added on edit. Fixed by tracking `pendingSignatureFile` / `pendingSignaturePreview` in component state — local until POST succeeds, then uploaded with the new doctor's `id`.

### Changed
- **Report layout:** Clinical interpretation moved out of `report-bottom-section` to render directly below the results table with a 25 px top margin.
- **Report layout:** `report-bottom-section` now contains only the "Authorized Signatory" label and signature images (right-aligned), then a thin horizontal divider, then the footer with 30 px top padding. Applies to both `report-screen.css` and `report-print.css`.

---

## [1.3.0] — 2026-02-15 — Report text & divider cleanup

### Changed
- Removed "END OF REPORT" footer text.
- Removed dotted divider lines between report sections.
- Added the standard medico-legal disclaimer line: *"This report should be interpreted in conjunction with clinical findings."*
- Authorized Signatory label added above signatures.

---

## [1.2.0] — 2026-02-10 — Signature inlining

### Fixed
- Doctor signatures missing from patient-downloaded PDFs. Root cause: Puppeteer renders HTML in a sandbox without filesystem access, so `<img src="/uploads/signatures/xxx.png">` resolved to nothing. Fixed by `reportRendererService.inlineSignatureImage()` reading the file and inlining as a base64 data URI before Puppeteer sees it.

### Changed
- Snapshots store the **filesystem path** of the signature, not a URL — so the backend can always read it at render time.

---

## [1.1.0] — 2026-01-30 — Digital vs print PDF modes

### Added
- Two PDF rendering modes:
  - **Digital** (`emulateMediaType: 'screen'`): renders `report-screen.css`; full Sobhana branding, 10 mm margins all around.
  - **Print / Physical** (no media override): renders `report-print.css`; assumes pre-printed letterhead, 32 mm top / 15.5 mm bottom margins.
- Frontend toggle in `DiagnosticsReportPreview.tsx`.

### Changed
- `pdfGenerationService.generatePdf()` accepts `options.pdfType: 'digital' | 'print'`.

---

## [1.0.0] — 2026-01-20 — Initial production release

### Added

**Core platform**
- Multi-branch architecture; all data scoped to `Branch`. Active-branch switcher.
- Three user roles: `staff`, `doctor`, `owner`. Plus reserved `admin`.
- JWT auth (HS256, 7-day expiry) + bcrypt.
- Zustand auth + branch state, `localStorage`-persisted.
- Append-only `AuditLog` for sensitive actions.

**Patient management**
- Multi-identifier registration (phone, email, Aadhaar, other).
- Deduplication on registration via `patientMatchingService`.
- Patient 360 cross-branch view; global patient search.

**Diagnostic workflow**
- Visit creation → product/test selection → auto bill.
- Per-branch sequential bill numbers via `numberService`.
- Result entry with HIGH/LOW/CRITICAL flagging.
- Age- and gender-specific reference ranges.
- Formula-based derived parameters (safe expression evaluator).
- Report finalization → immutable snapshot.

**Reports**
- Versioned, finalize-once snapshots.
- 12-character base64url access tokens (SHA-256 hashed in DB).
- HTML rendering with all images base64-inlined.
- Puppeteer PDF generation, singleton browser.
- Public `/reports/:token` route, no auth.

**WhatsApp**
- Patient gets WhatsApp link on finalize.
- Fire-and-forget — finalization never blocked by delivery failure.
- Opt-in tracking; full delivery log in `MessageLog`.

**Billing**
- Auto-generated from product selection.
- CASH / CARD / UPI / CREDIT.
- Doctor commission per finalized visit.

**Catalog (owner)**
- `TestDefinition` with clone-on-edit versioning.
- Reference ranges by age/gender.
- Interpretation rules for auto-text.
- `ClinicalPanel` grouping; `BillableProduct` for billing.

**Signing doctors**
- Add doctors with degrees, designation, registration number, signature image.
- `SigningRule` assigns a signing doctor to specific panels/products.

**Deployment**
- Backend: Render Docker (`node:20-slim` + system Chromium).
- Frontend: Vercel + SPA fallback.
- DB: Neon Postgres.

---

## How to add an entry

When merging a PR:

1. Pick a section under `[Unreleased]` (`Added` / `Changed` / `Fixed` / `Deprecated` / `Removed` / `Security`).
2. Write a sentence in the user-impact voice: *what* changed, *why it matters*. Not internal refactor noise.
3. Add a **Migration notes** sub-bullet if the change requires action (env var, migration, manual data fix).
4. At release time, promote `[Unreleased]` to a versioned section per [`RELEASE.md`](RELEASE.md).

Refactors that touch nothing user-visible go *only* in the commit log, not here.
