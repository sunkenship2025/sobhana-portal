# Changelog — Sobhana Health Hub

All notable changes to this project are documented here in reverse chronological order.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

_Nothing pending._

---

## [1.5.0] — 2026-03-02 — Version Creation Fix + CORS

### Fixed
- **Critical:** `If-Match` header was not listed in CORS `allowedHeaders` on the backend. The browser's preflight request blocked any PUT/version-creation request that included this header, resulting in "Failed to fetch" errors on the frontend with no server-side log. Added `If-Match` to `allowedHeaders` in `health-hub-backend/src/index.ts`.
- **Critical:** `@@unique([code, isLatest])` constraint on `TestDefinition` prevented creating a third or higher version of any test. When v1 → v2, both v1 and v2 have `isLatest=false` with the same `code`, violating the unique constraint. Replaced with `@@unique([rootDefinitionId, version])`. Migration `20260302000000` applied.
- `createNewVersion` in `clinicalDefinitionService.ts` used `??` (null-coalescing) to copy field values during cloning, silently discarding intentional `null` resets. Replaced with a `pick()` helper that correctly passes `null` through.

### Changed
- `TestDefinition` unique constraint: `@@unique([code, isLatest])` → `@@unique([rootDefinitionId, version])`

---

## [1.4.0] — 2026-02-28 — Report Layout Restructure + Signature Upload Fix

### Fixed
- Signature upload during doctor creation: previously the upload API required the doctor record to already exist (`editingDoctorId`). Signatures could only be uploaded on the edit form. Fixed by tracking `pendingSignatureFile` / `pendingSignaturePreview` in component state — the file is stored locally, and after the POST to create the doctor succeeds, the signature is uploaded automatically using the new `id`.

### Changed
- **Report layout:** Clinical note (interpretation text) moved out of `report-bottom-section` to render directly below the results table with a 25px top margin. This makes the note flow naturally with the results rather than floating at the bottom.
- **Report layout:** `report-bottom-section` now contains only the "Authorized Signatory" label and signature images (right-aligned), followed by a thin horizontal divider, followed by the footer with 30px top padding.
- Applies to both `report-screen.css` and `report-print.css`.

---

## [1.3.0] — 2026-02-15 — Report Text & Divider Cleanup

### Changed
- Removed "END OF REPORT" text that appeared at the bottom of every report.
- Removed dotted divider lines between report sections.
- Added standard medico-legal disclaimer line: _"This report should be interpreted in conjunction with clinical findings."_
- Authorized Signatory label added above signatures.

---

## [1.2.0] — 2026-02-10 — Signature Inlining in PDFs

### Fixed
- Doctor signature images were not appearing in PDFs downloaded by patients. Root cause: Puppeteer renders HTML in a sandboxed context without access to the server's filesystem, so `<img src="/uploads/signatures/xxx.png">` resolved to nothing. Fixed by reading the signature file from disk in `reportRendererService.inlineSignatureImage()` and converting it to a base64 data URI before passing HTML to Puppeteer.

### Changed
- `reportRendererService.renderReportHtml()` now inlines all signature images as base64 data URIs.
- Report snapshots store the **filesystem path** to the signature image (not a URL), so the backend can always read the file at render time.

---

## [1.1.0] — 2026-01-30 — Digital vs Print PDF Modes

### Added
- Two PDF rendering modes:
  - **Digital** (`emulateMediaType: 'screen'`): renders `report-screen.css`, includes colored header/footer in page content, uses 10mm margins on all sides.
  - **Print / Physical** (no media override): renders `report-print.css`, assumes pre-printed letterhead, uses 32mm top margin and 15.5mm bottom margin.
- Frontend toggle in `DiagnosticsReportPreview.tsx` lets staff select which PDF mode to download.

### Changed
- `pdfGenerationService.generatePdf()` accepts an `options.pdfType` parameter: `'digital'` or `'print'`.

---

## [1.0.0] — 2026-01-20 — Initial Production Release

### Added

**Core Platform**
- Multi-branch architecture: all data scoped to `Branch`. Staff can switch active branch.
- Three user roles: `staff`, `doctor`, `owner`, each with different route access.
- JWT authentication (HS256, 7-day expiry) with bcrypt password hashing.
- Zustand-based auth and branch state management with localStorage persistence.
- Append-only `AuditLog` model for all sensitive actions (login, finalize, edit).

**Patient Management**
- Patient registration with phone, email, and Aadhaar identifiers.
- Deduplication on registration: `patientMatchingService` warns when an existing patient with the same phone/email/Aadhaar is found.
- Patient 360 view: full cross-branch visit history.
- Global patient search across branches.

**Diagnostic Workflow**
- Create diagnostic visit: select products/tests, auto-generate bill.
- Sequential bill numbering per branch via `numberService`.
- Result entry: enter values for each ordered test, flag HIGH/LOW.
- Age- and gender-specific reference ranges via `referenceRangeService`.
- Formula-based derived parameters via `derivedParameterService` (mathematical expressions evaluated safely).
- Report finalization: creates immutable `ReportSnapshot` JSON blob.

**Report System**
- Immutable report snapshots: all report data (patient info, results, ranges, doctor details) captured at finalization and never changed.
- Versioned test catalog: `TestDefinition` uses clone-on-write versioning — editing creates a new version, old version locked.
- 12-character random base64url access tokens for public report delivery.
- HTML report rendering with fully inlined base64 images.
- PDF generation via Puppeteer singleton (stays warm between requests).
- Public report URL: `GET /reports/:token` — no auth required.

**WhatsApp Notifications**
- On report finalization, patient receives a WhatsApp message with the public report link.
- Fire-and-forget pattern — notification failure does not block finalization.
- Opt-in required (checked before sending).
- All delivery attempts logged to `MessageLog`.

**Billing**
- Bill auto-generated from test products selected at visit creation.
- Bill snapshot captured at confirmation — immutable thereafter.
- Multiple payment methods: CASH, CARD, UPI, CREDIT.
- Payout calculation for referring doctors (commission per visit).

**Clinical Test Catalog (Owner)**
- Full CRUD for `TestDefinition` with versioning.
- Reference ranges: multiple per test, filterable by age range and gender.
- Interpretation rules: auto-generated text based on result numeric ranges.
- `ClinicalPanel` grouping of tests.
- `BillableProduct` maps to panels for billing.

**Signing Doctors**
- Add signing doctors with degrees, designation, registration number, and signature image.
- `SigningRule` assigns a signing doctor to specific test panels or products.
- Signatures appear on finalized reports.

**Deployment**
- Backend: Render (Docker), `node:18-slim` + system Chromium.
- Frontend: Vercel, SPA fallback via `vercel.json`.
- Custom domain: `sobhanaportal.com` (frontend), `reports.sobhanaportal.com` (backend).
- Automatic DB migrations on container start (`prisma migrate deploy`).

---

## Migration Notes

### 1.5.0 — DB Migration Required

Migration `20260302000000` must be applied. It:
1. Drops `@@unique([code, isLatest])` constraint from `TestDefinition`
2. Adds `@@unique([rootDefinitionId, version])` constraint
3. This migration is applied automatically on Render via `prisma migrate deploy` in the Dockerfile CMD

If applying manually to a local DB:
```bash
cd health-hub-backend
npx prisma migrate deploy
```
