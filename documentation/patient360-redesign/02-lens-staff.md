# Patient360 — Staff Requirements (Jobs-To-Be-Done)

## 1. PERSONAS

Roles per discovery: only three exist — `staff`, `owner`, `doctor` (authStore.ts:29). "Staff" is a single backend role covering several real-world counter functions, which I split below by job context.

### Front-desk / Reception staff (role: `staff`)
- **Goal opening 360:** Confirm "is this the same person who was here before?" before billing a new visit; check dues; reprint a bill or resend a report a family member is asking for.
- **Frequency/volume:** Very high — dozens of times a day, on most walk-ins and phone callers. Indian high-volume front desk.
- **Device:** Desktop/laptop at the counter; occasionally a small screen. (max-w-4xl container, Patient360.tsx:430.)
- **Mental state:** Patient or relative standing at the counter, queue behind them, phone ringing. Needs answers in 2–3 seconds, not scrolling.

### Diagnostics staff / technician (role: `staff`)
- **Goal opening 360:** See whether a returning patient's last report is FINALIZED and ready to hand over / WhatsApp; see what tests are pending result entry; start a repeat test.
- **Frequency/volume:** High during result/collection windows.
- **Device:** Desktop at the lab/collection desk.
- **Mental state:** Patient waiting for a report "is it ready?"; or batch-processing the day's pending results.

### Owner / Admin (role: `owner`)
- **Goal opening 360:** Audit a single patient's full cross-branch financial and visit journey; investigate a billing complaint or pattern; verify a discount/due.
- **Frequency/volume:** Low/occasional, investigative.
- **Device:** Desktop. Has broader pages (OwnerMoneyPage, OwnerOperationsPage) for aggregates; uses 360 for the per-patient drill-down.
- **Mental state:** Calm, analytical, looking for the full record and ideally an audit trail.

### Doctor (role: `doctor`)
- **Cannot access Patient360** (App.tsx:140-142 allows only staff/owner). Listed for completeness: their workflow is /doctor dashboard, signing their own diagnostic reports read-only. **Gap:** a doctor referring a patient for clinic work has no way to see clinic history (discovery: intentional but undocumented).

---

## 2. JOBS-TO-BE-DONE (per role)

For each job: **info that must be visible** | **action that must be one click away**. "Exists" / "MISSING" / "backend dependency" flagged against discovery.

### Front-desk / Reception

**J1 — Verify identity before billing**
- Visible: name, title, age/ageDisplay, gender, primary phone, patientNumber, address. *(All in Patient Identity Card, lines 449–503 — exists.)*
- One click: start a new visit for this patient. **MISSING** — 360 is strictly read-only, no "New Diagnostics Visit" / "New Clinic Visit" launch (staff must exit to /clinic/new). Confirmed gap.

**J2 — Check outstanding balance before starting a new visit**
- Visible: total dues across visits, which visits are PENDING/DUE. **PARTIAL/MISSING** — Financial Summary shows Total Diagnostics / Total Clinic / Lifetime Total only (lines 505–555); no dues/outstanding aggregate. Timeline carries `dueAmountInPaise`, `paymentStatus` per visit (VisitTimelineItem) but there is **no rollup of outstanding balance** and no filter to "show only unpaid." This is the single highest-value missing number for the counter.
- One click: open the unpaid visit / record payment. **MISSING** — no payment action in 360 (intentional read-only); at minimum a deep-link to the bill/payment workflow is needed.

**J3 — Reprint a bill**
- Visible: bill number, branch, amount, date. *(Timeline + drawer — exists.)*
- One click: print bill — **exists** via handlePrintBill → /bill/print/:domain/:visitId (lines 168–187). But it lives **inside the drawer**, requiring View Details first; should be one click from the timeline row. Popup-blocker feedback is inconsistent (lines 176–182).

**J4 — Correct a misspelled name / wrong phone**
- Visible: editable identity fields. *(PatientEditDialog, lines 454–458 — exists, with change-reason for identity fields.)*
- One click: save. **Rough edges:** no confirmation/review step before changing phone or name (discovery flags accidental edits); full re-fetch of the entire 360 view on save (line 457) is heavy; cannot edit dateOfBirth or add/remove identifiers from here.

**J5 — Resend a finalized report on WhatsApp (relative calling)**
- Visible: which visits have a FINALIZED report; whether the patient has a PHONE; whether/when it was last sent. *(FINALIZED gating + phone check exist; **send history MISSING** — MessageLog not joined; button state only, no log of past sends/failures.)*
- One click: WhatsApp send — **exists** but duplicated in drawer (138–166) and modal (734–767); no shared handler; no opt-in (`whatsappOptIn`) surfaced despite data existing.

### Diagnostics staff / technician

**J6 — "Is the last report ready to hand over?"**
- Visible: reportStatus (DRAFT/FINALIZED), finalizedAt, which tests. *(reportStatus/finalizedAt exist; **test names collapsed/absent** — TestResult values not joined in 360, and workflowMode not surfaced.)*
- One click: View Report / Print Report — exists (lines 660–675) for FINALIZED only.

**J7 — See what tests are pending result entry**
- Visible: orders awaiting results, workflowMode (REPORTABLE vs BILL_ONLY vs EXTERNAL_UPLOAD), DRAFT vs FINALIZED. **MISSING** — 360 shows no pending-results view; workflowMode not surfaced (gap); DRAFT visits show no actionable next step.
- One click: jump to result entry. **MISSING.**

**J8 — Start a repeat test for a returning patient**
- Visible: last test history. (Present in timeline.)
- One click: new diagnostic visit pre-filled. **MISSING** (same as J1).

### Owner / Admin

**J9 — Audit a patient's full cross-branch financial journey**
- Visible: every visit across branches, discounts (discountReason/type/%), paid/due, payment method. **PARTIAL** — 360 view selects only paymentStatus + billedAt from Bill (patientService.ts:318); full discount/paid/due and PaymentTransaction history require separate visit fetch. Drawer shows some, but no consolidated financial ledger.
- One click: open audit trail for this patient. **MISSING** — AuditLog / PatientChangeLog / ReportAccessLog exist but are not joined into 360; no "who edited this patient / who viewed reports" view.

**J10 — Investigate a duplicate / merged patient**
- Visible: possible duplicates. **MISSING** — no dedup/merge UI; matching service exists backend-side only.

---

## 3. PAIN POINTS (mapped to jobs)

| # | Pain (cited from discovery) | Hits jobs |
|---|---|---|
| P1 | **Read-only blocks the next action.** No "start new visit" launch from 360; staff must memorize/exit to /clinic/new. | J1, J8 |
| P2 | **No outstanding-balance / dues number.** Financial Summary is informational totals only; due amounts exist per visit but are never rolled up or filterable. | J2, J9 |
| P3 | **No payment action.** Cannot record payment, adjust discount, or refund; all financial change is elsewhere. | J2 |
| P4 | **No pending-results view; workflowMode hidden.** Can't tell which orders still need result entry. | J7 |
| P5 | **Timeline not filterable/searchable; no pagination.** All visits in one `space-y-3` (line 573), no domain/date/branch filter, hardcoded newest→oldest; DOM bloat and scroll-hunting for high-volume patients. | J3, J6, J9 |
| P6 | **Reprint/report actions buried in drawer.** Two clicks (View Details → button) for the most common counter task; inconsistent popup-blocker feedback (176–182). | J3, J5 |
| P7 | **WhatsApp logic duplicated, no send history, opt-in not shown.** MessageLog not joined; can't see if/when last sent or if it failed; `whatsappOptIn` data exists but isn't surfaced. | J5 |
| P8 | **Edit is risky & expensive.** No confirmation before changing name/phone; full 360 re-fetch on save; can't edit DOB or identifiers. | J4 |
| P9 | **Test values & report contents absent.** TestResult not joined; tech can't preview values without a separate fetch. | J6 |
| P10 | **No per-patient audit trail / no merge UI.** AuditLog, ReportAccessLog, PatientChangeLog, patientMatching all exist backend-side but unsurfaced. | J9, J10 |
| P11 | **Weak loading/error states.** Spinner-only load (line 400); network errors silently become "Patient not found" (411); no retry, no 404-vs-5xx distinction. | all |
| P12 | **Hardcoded fallback branchId** `cmjzumgap00003zwljoqlubsn` (line 49) risks wrong-branch auth headers / silent data-integrity issues. | all |
| P13 | **Revisit link is text-only.** Original visit ref/bill/date shown as low-contrast text (text-blue-700), no jump-to-original, no reprint-original. | J3 |
| P14 | **Modal/drawer UX gaps.** No ESC-to-close on preview modal; drawer close doesn't close modal; blob URL can leak on navigation. | J5, J6 |

---

## 4. MISSING CAPABILITIES (prioritized)

### MUST
1. **"Start new visit" launch (Diagnostics / Clinic) from 360.** — Removes the single biggest workflow break (P1); returning-patient flow is the core staff job. *(Frontend deep-link; data exists.)*
2. **Outstanding-balance rollup + "unpaid only" filter.** — The number the counter needs before billing; per-visit `dueAmountInPaise`/`paymentStatus` already exist, needs aggregation. *(Light backend aggregate or client sum.)*
3. **Timeline filters (domain / date range / branch) + pagination.** — Makes 360 usable for high-volume patients; prevents DOM bloat. *(Backend likely already paginates; frontend must expose.)*
4. **One-click row actions: Reprint Bill, View/Print Report, WhatsApp directly on the timeline row.** — Collapses the most frequent 2-click tasks to one; consolidate duplicated WhatsApp into a shared handler. *(Frontend.)*
5. **Robust loading/error states + retry; remove hardcoded fallback branchId.** — Counter reliability + data-integrity fix (P11, P12). *(Frontend + ensure activeBranchId always set.)*

### SHOULD
6. **Pending-results / next-action surface per diagnostic visit (expose workflowMode, DRAFT state).** — Lets technicians see what still needs entry (P4); **backend dependency** to surface workflowMode + pending flag in 360 payload.
7. **WhatsApp/communication history + opt-in indicator per visit.** — Stops duplicate sends and "did it go?" calls; **backend dependency** to join MessageLog and return `whatsappOptIn`.
8. **Edit confirmation step + differential update (no full re-fetch).** — Prevents accidental name/phone changes; faster saves (P8). *(Frontend; optional patch-return from API.)*
9. **Full financial detail in timeline/drawer (discount, paid, due, payment method, transactions).** — Owner audit + counter dues clarity; **backend dependency** (currently only paymentStatus + billedAt selected).
10. **Revisit link: jump-to-original + reprint-original from the revisit row.** — Closes the revisit dead-end (P13). *(Frontend; originalVisitId already present.)*

### COULD
11. **Per-patient audit trail panel (who edited, who viewed reports).** — Owner investigative value; **backend dependency** to join AuditLog/PatientChangeLog/ReportAccessLog.
12. **Duplicate-detection / merge surfacing.** — Data hygiene for families sharing a phone; **backend dependency** (patientMatching exists, no UI).
13. **Test-value trend / preview without leaving 360.** — Technician convenience; **backend dependency** (TestResult not joined).
14. **Modal polish: ESC-to-close, drawer↔modal state sync, blob-URL cleanup on navigation.** — UX hygiene (P14). *(Frontend.)*

---

## 5. AXORA-MODULAR CONSIDERATION

The timeline is already domain-generic and conditionally renders the DIAGNOSTICS report section (Patient360.tsx:263–316), so it degrades gracefully today. The staff view should adapt per enabled module:

- **Diagnostics-only tenant:** Show only diagnostic visits, reports, and pending-results. Financial Summary should drop the "Total Clinic" column (collapse md:grid-cols-3 → 2). "Start new visit" launch should offer **Diagnostics only**. Doctor-name / visitType / revisit fields hide automatically (no clinic visits exist). Pending-results view (Must/Should #6) becomes the primary diagnostics-staff job.

- **OP-only (Clinic) tenant:** Show only clinic visits, doctor names, OP visit types, revisit links. Drop the diagnostic report section entirely (already conditional). Financial Summary drops "Total Diagnostics." "Start new visit" launch offers **Clinic/OP only**. No report-ready / WhatsApp-report job — but reprint-bill and revisit-slip remain primary.

- **All modules (OP + IP + Diagnostics):** Full timeline with a **domain filter** becomes essential (Must #3) because a single patient now mixes diagnostics + OP + IP rows; the outstanding-balance rollup must sum across domains. IP visits (visitType=IP, hospitalWard) need their own row treatment.

**Architecture note (per Axora direction):** there is currently **no frontend module-enablement flag** (discovery gap) — module visibility is enforced only implicitly via role-based routes. To make the above adaptations real rather than incidental, 360 needs a tenant/branch module-config signal (likely Branch-level Diagnostics/OP/IP flags). Build these adaptations as **toggleable, isolated conditionals keyed off enabled domains** so Axora's later per-tenant toggle is a mechanical wiring step — do not build a toggle framework now (per memory: build modules Axora-ready, no toggle framework yet).

**Key files for the synthesis/build step:** `/Users/pranavreddy/Desktop/sobhana portal/health-hub/src/pages/clinic/Patient360.tsx` (screen + drawer + modal), `/Users/pranavreddy/Desktop/sobhana portal/health-hub/src/components/patient360/PatientEditDialog.tsx` (edit flow), `/Users/pranavreddy/Desktop/sobhana portal/health-hub-backend/src/services/patientService.ts` (getPatient360View — where dues rollup, MessageLog, full financials, workflowMode must be added), `/Users/pranavreddy/Desktop/sobhana portal/health-hub/src/types/index.ts` (VisitTimelineItem / Patient360View shapes).
