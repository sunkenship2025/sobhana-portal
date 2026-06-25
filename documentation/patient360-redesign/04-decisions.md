# Patient360 Redesign — Decision Log

Decisions taken with the product owner (PA-style review, 24 Jun 2026). This log is the source of truth for scope; the requirements doc (`00-requirements.md`) describes the full possibility space, and this file records what was actually chosen.

## Decisions

| # | Topic | Decision | Effect on build |
|---|---|---|---|
| 1 | Doctor access | **Out** | Staff + owner only; no new role-scoping work |
| 2 | Collect payment | **Deep-link out** | Screen stays read-only for money; "→ Collect payment" jumps to existing billing |
| 3 | Due number source | **Calculate fresh each load** | Live SUM over real bills every open; no stored running total |
| 4 | Results inline | **Abnormal badge only** | Generic "⚠ has abnormal results" chip; values/test-names only in the report PDF |
| 5 | Duplicate patients | **Nothing for now** | No duplicate hint, no merge. `DuplicateHint` dropped from scope |
| 6 | Axora modules | **Isolated degradation, no config infra** | Clean show/hide keyed off domain; no per-tenant toggle framework built now |
| 7 | WhatsApp consent | **No gate** | Send to any phone on file (current behavior kept) |
| 8 | Delivery status | **Show full Sent→Delivered→Read** | Confirmed feasible — Meta webhook already maintains `MessageLog` (`webhooks.ts:82-163`) |
| 9 | Pagination | **Required fix (not a choice)** | Backend loads ALL visits today; cursor pagination is a Phase-1 correctness prerequisite |
| 10 | Deceased patients | **Out of scope** | No `isDeceased`/`dateOfDeath` field; no action suppression |
| 11 | Due edge cases | **Resolved** (see formula below) | Cancelled wiped; refunded ≠ paid; failed = still owed, no flag |

## Due-number formula (Q3 + Q11, resolved)
**Outstanding Due = Σ(billed on active visits) − Σ(payments actually captured)**, computed live each load.
- **Cancelled visits:** excluded entirely (neither owed nor paid).
- **Refunded payments:** do **not** count as paid — the balance reflects the money going back to the patient.
- **Failed payments:** do **not** count as paid; the bill stays owed. No special "failed attempt" UI indicator.

## Build sequencing (decided)
- **Backend-first.** Land the API changes first (due-number calc, cursor pagination + filters, new payload fields), then build the frontend on top — lower rework risk.
- **Frontend is gated on low-fi wireframe approval.** No frontend code until the owner has reviewed and signed off on low-fidelity wireframes of the redesigned layout + key states.

## Wireframes — APPROVED (24 Jun 2026)
Owner reviewed `wireframes/patient360-wireframes.html` and approved the layout direction (sticky header → glance strip → timeline-primary → side inspector; mobile bottom-sheet; distinct loading/error states). Directive: "make sure it works" — implementation must be genuinely functional end-to-end, not a hollow mockup.

## Search / entry page redesign (GlobalPatientSearch) — decided
Owner flagged the two-button "Search by Phone / Search by Name" toggle as redundant. Replaced with **one smart search bar** (wireframes: `wireframes/patient360-search-wireframes.html`):
- Single input accepts phone / name / patient ID / bill number; frontend type-detection with a one-tap override ("Detected: … — Not right? [Name][Patient ID][Bill no.]").
- **Phone → list ALL matches** (shared-phone family disambiguation, the wrong-patient safeguard at the entry point).
- **Bill number → resolve to patient + that visit** ("Open visit in Patient 360" / reprint bill).
- **No match → "+ Register new patient"** pre-filled with what was typed (walk-in path).
- **Recently viewed** list for 1-tap return (frontend-local, optional).
- **Behavior (decided): live type-ahead, debounced ~300ms** (not press-Enter).
- Detection rule: `@`→email · `^P-?\d+`→patient ID · branch-prefix+digits (e.g. `MPR-2231`) or leading `#`→bill · all-digits len≥7→phone · else→name.

Backend status: phone/name/email search already exist (`GET /patients/search`). **New backend-deps for this page:**
- **Patient-ID search** — add `patientNumber` to the search service.
- **Bill-number lookup** — resolve a bill number → its visit + patient.
These will be folded into the backend plan (currently scoped to the detail endpoint).

## Backend plan — READY (see `05-backend-plan.md`)
Code-grounded, adversarially stress-tested. Key shape: split `/360` into a **summary/glance** endpoint (aggregate-only) + a **cursor-paginated `/timeline`** endpoint with rich per-visit fields; legacy `/360` frozen + the `paymentType` bug fixed. Due reuses the authoritative `computeBillFinancialsFromPersisted`. 3 queries/page (no N+1). §10 adds the smart-search backend (patient-ID search + bill-number lookup). No migration required for correctness; one optional perf index recommended (`Visit @@index([patientId, createdAt])`).

Bill-number uniqueness (was open): RESOLVED — format `D-{BRANCH_CODE}-{SEQ}` embeds branch code; full string globally unambiguous. Lookup is safe.

Minor confirmations defaulted (override anytime): "unpaid" = `paymentStatus notIn [PAID,REFUNDED]`; glance "not finalized" includes in-flight partials; delivery status only for REPORT-context (clinic visits show none); ship the optional index.

## Frontend plan — READY (see `06-frontend-plan.md`)
Code-grounded + adversarially stress-tested. Both pages decomposed (smart-search entry + detail page), react-query data layer (summary query + infinite timeline + debounced smart search + bill lookup + identity-edit mutation), one `useReportActions` hook (kills duplicate WhatsApp logic, per-visit loading, blob lifecycle), `StatusChip`. Ordered, independently-testable build steps grouped by dependency; full verification plan.

Frontend open questions — RESOLVED from code:
- Q2 PATCH return: returns full patient + identifiers but NOT computed age/ageDisplay → edit uses a **scoped summary refetch** (not in-place merge). 
- Q3 bill regex: bills `D/C-{BRANCH}-{SEQ}`, patient `P-{SEQ}` → unambiguous detection.
- Q1 branch header: new `/360*` + `/patients/*` endpoints are **global** (no branch filter / no X-Branch-Id), matching existing `/360`.
- Q4 enabledDomains: optional prop, defaults to all (no toggle framework).
- Q6 reportState.version = max FINALIZED version (not trailing draft).
- Q5 collect-payment: confirm `/money/bills?visitId=` at build; else v1 = print-bill only.
- Q7 recently-viewed: **per-user** localStorage key (shared-machine safety).
- Prereq found: `apiRequest` throws a bare Error (no `.status`) → Step 0 adds a typed `ApiError{status}` before the 404-vs-network split can work.

## Open loops
- **Owner go/no-go on implementing** (backend-first, then frontend). Both plans ready for review.

## Conscious trade-offs (flagged for the record)
Several items the lens analyses rated as patient-safety / privacy MUST or SHOULD were deliberately scoped **out**:
- Patient lens **M3** (gate WhatsApp on opt-in) → Q7 "no gate".
- Patient lens **S1 / C2** (duplicate-merge, dispute-capture) → Q5 "nothing".
- Patient lens **M1** (full result values inline) → Q4 "flag-only".
- Deceased-patient action suppression → Q10 "out of scope".

These are legitimate product calls; recorded so the trade-off is conscious, not accidental.

## Confirmed code bugs to fix during the build
- `visit.bill?.paymentType` always resolves `null` — `paymentType` lives on `PaymentTransaction`, not `Bill` (`Patient360.tsx:399`).
- Shared `previewLoading` boolean disables "View Report" on every row at once (`Patient360.tsx:665`).
- Hardcoded fallback `branchId = 'cmjzumgap00003zwljoqlubsn'` (`Patient360.tsx:49`, `GlobalPatientSearch.tsx:29`).
- Network/5xx error collapses into the "Patient not found" state with no retry (`Patient360.tsx:365`, `:411`).


## Runtime verification (25 Jun 2026) — report & bill views ✅
Ran the app fully locally against a fresh current-schema DB (`sobhana_p360`, seeded), created a finalized diagnostic visit (RAVI VERMA P-000001, Hemoglobin 13.5, bill D-CNT-000001 paid), and visually verified:
- **Bill view** (`/bill/print/...`): renders cleanly — letterhead, patient details, Hemoglobin ₹80, Total/Paid/Balance due. ✅
- **Report view** (inline inspector iframe, blob PDF): SOBHANA letterhead → REPORT → patient header → Hemoglobin | 13.5 | g/dL | 12–16 → clinical note. ✅
- **Bonus (full detail page on real data):** glance strip (Due ₹0 "all settled", 1 report finalized, last visit); timeline row with Paid + Finalized v1 chips; inspector Billing Total ₹80 / Paid ₹80 / Due ₹0 / **Method CASH** (confirms the `paymentType`-null bug is fixed); inline PDF preview + blob URL working.
- Not runtime-exercised: smart-search page, pagination with many visits, multi-test/panel reports, partial reports, edit flow, mobile. (tsc + vite build clean for all.)

Note: the earlier `prisma db push` loaded `.env` and added the `Visit_patientId_createdAt_idx` index to the Neon DB (additive, intended migration; no data dropped). Local `sobhana_db` got `title`/`ageUnit` columns added during diagnosis.
