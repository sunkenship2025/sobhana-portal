# Patient360 Redesign — Authoritative Requirements Document

*Healthcare clinic + diagnostics portal (Sobhana → Axora modular SaaS)*
*Code-grounded discovery + three product lenses (UI/UX, Staff JTBD, Patient-advocate). Where lenses conflict, the decision and rationale are stated inline.*

---

## 1. PURPOSE & VISION

Patient360 is the **single canonical, cross-branch view of one human being** — their identity, their full medical and financial journey across every Sobhana/Axora branch and module, and the launch point for acting correctly on their behalf. Today it is a record-first archive (a flat scroll of four stacked cards). It must become **task-first**: a front-desk user under counter pressure arrives with a question ("paid? report ready? same person as last time?") and must get the answer and the next action in under a minute, while an owner can still drill into the full audited history.

The patient never logs in — every requirement below is something staff do *for* a real person standing at the counter, so correctness, identity-certainty, and consent are first-class, not polish.

**Design principles**
1. **Task-first, not record-first.** Surface the answers staff arrive with (last visit, outstanding due, report status, identity confirmation) before the archive.
2. **Read-only by default; editing is a deliberate, audited mode.** Explicit entry, review-before-save with `changeReason`, surgical in-place update — never a silent full-refetch on a name change.
3. **Status and identity are typed, glanceable, and certain.** Payment/report status = chip (icon + word + color, never color alone, WCAG 1.4.1); patient identity stays anchored on screen so staff never act on the wrong shared-phone family member.
4. **Scale and honesty by default.** Assume 100+ visits: filter, group, paginate, backend-aggregate totals; distinguish genuinely-not-found from a server/network failure with retry — never collapse a server hiccup into "Patient not found."
5. **Module-agnostic (Axora-ready).** The timeline degrades cleanly for Diagnostics-only, OP-only, or full tenants via isolated conditionals keyed off enabled domains — built so the later per-tenant toggle is mechanical, not a framework built now.

---

## 2. PERSONAS & PRIMARY JOBS

Only three roles exist (`authStore.ts:29`): `staff`, `owner`, `doctor`. "Staff" is one backend role covering several counter functions, split below by job context.

| Persona | Access | #1 Job | Needs at a glance |
|---|---|---|---|
| **Front-desk / Reception** (`staff`) | Full | Verify "same person as before?" and dues before billing a new visit; reprint bill / resend report | Anchored identity (name, P-number, age/gender, phone), **outstanding due**, last visit, report-ready status — in 2-3 seconds |
| **Diagnostics tech** (`staff`) | Full | "Is the last report ready to hand over?" + what's pending result entry | reportStatus (Finalized/Draft), finalizedAt, **abnormal flags/values**, pending-results next-action |
| **Owner / Admin** (`owner`) | Full | Audit one patient's full cross-branch financial + visit journey; investigate a billing complaint | Complete timeline across branches, discounts/paid/due, payment method, per-patient audit trail |
| **Doctor** (`doctor`) | **No access** (`App.tsx:140-142` = staff/owner only) | n/a here — signs own reports on `/doctor` | *Listed for completeness. Gap: a doctor referring for clinic work has no path to clinic history. See Open Questions Q1.* |

**Role-based financial visibility (privacy).** Cross-branch visibility is intentional, but full financial detail is not uniformly appropriate for every role. See 3.4 [Should]: scope discount reasons, lifetime/cross-branch financial totals, and the audit tab by role (owner = all; front-desk staff = current-branch dues and what's needed to bill the next visit).

---

## 3. FUNCTIONAL REQUIREMENTS

Tags: **[Must]** ship-blocking, **[Should]** high value, **[Could]** later. "BE-dep" = data needed but **not currently returned** by `getPatient360View` (`patientService.ts:306-456`).

### 3.1 Identity
- **[Must]** Persistent, anchored identity confirmation visible at all times (sticky header): name, patientNumber, title, ageDisplay, gender, masked primary phone, WhatsApp opt-in flag, branches-touched count. *Prevents wrong-patient action on shared family phones.*
- **[Must]** **Shared-phone disambiguation at arrival.** Schema explicitly allows multiple patients per identifier (`schema.prisma:277-278`, "family members with same phone"). A phone search in GlobalPatientSearch returns N patients; the result list **must** disambiguate by name + age + gender before a patient is opened. Picking the wrong child is the core wrong-patient risk and starts upstream of Patient360.
- **[Must]** **No-record / walk-in path.** Patient360 is keyed by `:patientId`; a person at the counter with no record cannot be verified against a screen that will not load. GlobalPatientSearch must offer an explicit "no match → register new patient" path, and Patient360 must never be the dead-end for an unregistered walk-in.
- **[Must]** Editing identity is a deliberate mode: explicit Edit entry → focused form → **review/diff step** for identity fields (name/phone/DOB) with mandatory `changeReason` → PATCH. *Currently no confirmation; an accidental phone change silently redirects all future report delivery.*
- **[Must]** On edit success, **patch local state in place** for identity-only fields rather than calling `loadPatient360()` to refetch the entire view (current `PatientEditDialog` line 457). **Caveat:** name is stored uppercase and `age`/`ageDisplay` are *computed server-side* (`getPatientAge`, `patientService.ts:440-442`) from `yearOfBirth`/`dateOfBirth`/`ageUnit`. A naive client patch of a name/DOB/age edit will display a stale or wrongly-cased value. Either (a) replicate server casing + age computation on the client for the patched fields, or (b) use the PATCH response body as the source of truth for the patched record. Refetch the timeline only if a visit-affecting field changed.
- **[Should]** Allow editing `dateOfBirth` and add/remove identifiers (PHONE/EMAIL/AADHAR) from the edit form (today only name/title/age/gender/address/phone/email/optIn — `patients.ts:136`).
- **[Should]** **Identity change-history read.** `PatientChangeLog` and `GET /:id/change-history` already exist. Surface "who last changed this phone/name and why" inline on the identity panel (or one click away). This is a wrong-patient safety control, not analytics — cheap because the endpoint already ships.
- **[Should]** "Possible duplicate / same patient" hint (non-actionable surface) with a staff-initiated **merge-request** entry point. BE-dep: `patientMatching.findPatientsByIdentifier` exists backend-only, no UI. *A child registered twice = split history — the highest-risk Indian scenario.* **Scope warning:** an *actionable* merge (re-pointing visits, audit, approval) is a net-new backend subsystem — there is no merge data model today (no `mergedInto`/merge fields). Ship the hint; treat full merge as a separate epic (see 8 / Q5).

### 3.2 History / Timeline
- **[Must]** Timeline is the **primary object** (promoted above financials), cross-branch, each row labeled by `branchName`, newest→oldest default.
- **[Must]** **Filter bar**: segmented domain (All / Diagnostics / Clinic), date range, branch dropdown, with a live result count.
- **[Must]** **Server-driven cursor pagination + month grouping** for 100+ visits. This is a **correctness prerequisite, not an optimization**: `getPatient360View` currently does `include: { visits: {...} }` with no `take`/`skip`/cursor and returns `patient.visits.map(...)` in full (`patientService.ts:312-336, 379`). The backend over-fetches every visit and every join on each load, so client virtualization alone does not fix it. Required: cursor + filter params on `/patients/:id/360` (`?cursor=&domain=&from=&to=`). Default loads most recent ~20; "Load older" / infinite scroll. **[Should]** add client virtualization of rendered rows on top, to bound the DOM for the loaded window.
- **[Must]** **CANCELLED-visit rules.** `VisitStatus` includes `CANCELLED` (`schema.prisma:46`) and the timeline does **not** filter by status today (no status check in the `.map`). A cancelled visit still carries `totalAmountInPaise` and would inflate any due/lifetime rollup. Define: cancelled visits are visually marked (struck/greyed, "Cancelled" chip), **excluded from all financial rollups (due + lifetime)**, and excluded from the default "active" timeline view (available behind a filter). There is no bill-void concept in the schema, so cancellation status is the only available signal — handle it explicitly.
- **[Must]** Per-row status as **typed chips** (icon+text+color): payment and report. Domain shown by label + chip, not color alone.
- **[Should]** Revisit lineage: raise contrast (current `text-blue-700` is low-contrast), add an icon, and a real **"open original visit"** link/action (`originalVisitId` already present).
- **[Could]** In-timeline free-text search (e.g. by bill number).

### 3.3 Clinical results
- **[Must]** Surface **abnormal flags + key values** for finalized diagnostic visits without forcing a PDF open — at minimum CRITICAL_HIGH/CRITICAL_LOW/HIGH/LOW flags. *Most serious safety gap: a CRITICAL potassium and a normal result look identical today (both = green "Finalized").*
  - **BE-dep + N+1 risk:** `TestResult` (value/textValue/flag) is **not** in the 360 payload — results come only from `/visits/diagnostic/:id`. Per-row flags must come from either a new join into the paginated 360 query (preferred) or risk N detail-fetches. Do not implement per-row flags as N calls.
  - **Privacy gate (couples to Q4):** showing values/flags on a shared counter screen is privacy-sensitive. The Q4 decision (flags-only vs flags+values vs full panel) must be resolved before this ships. Default recommendation: flags + abnormal-test names inline; full values only inside the inspector.
- **[Must]** **Partial / re-finalized report state.** Reports are **not** binary. `TestOrder.workflowMode` (REPORTABLE / BILL_ONLY / EXTERNAL_UPLOAD) plus `ReportVersion` versioning means a visit can be partially reportable or re-finalized (version > 1). A flat "Finalized" chip is misleading when only some orders are reportable or a later version exists. Define states: *Partially finalized* (X of Y reportable orders done), *Finalized v{n}* (amended/re-finalized), *Bill-only* (no report expected), *External upload pending*. BE-dep.
- **[Should]** Surface `workflowMode` and a per-visit **next-action** (e.g. "Enter results") so techs see what's pending. BE-dep.
- **[Should]** On DRAFT diagnostic visits, show "Results pending" with an expected-ready affordance (and ideally "notify when ready"). *Decision: keep lightweight — no SLA engine; just a clear pending state that resolves the "is it ready?" call without overpromising.*
- **[Could]** Trend view for repeat tests (e.g. HbA1c over time) — unlocks once results are in the payload.

### 3.4 Financials / Dues
- **[Must]** **Outstanding-due rollup** is the single headline financial number (glance strip), summed across domains, **excluding CANCELLED visits and excluding REFUNDED/FAILED payment states** (both are in the `PaymentStatus` enum — REFUNDED must count as neither "due" nor "paid"; FAILED is not a due). Today the Financial Summary sums `totalAmountInPaise` (billed) only and admits it's "informational" — it never shows what's owed. *This is the #1 missing counter number and a dispute/patient-harm risk.*
- **[Must]** Per-visit and lifetime **Paid vs Due**, not just Billed. **BE-dep (hard blocker):** the 360 query selects **only** `{ paymentStatus, billedAt }` from Bill (`patientService.ts:318`); `paidAmountInPaise`/`dueAmountInPaise` are not in the payload and `dueAmountInPaise` is not even a stored column (derived in `billFinancialService`). Add `paidAmountInPaise`, derived `dueAmountInPaise`, and `discountAmount/Type/Reason`. **There is no client-only path to a due number** — see Phase plan (§8).
- **[Should]** **Role-scoped financial detail.** Gate discount reasons, lifetime totals, and cross-branch financial figures by role: owner sees full ledger; front-desk staff sees current-visit/current-branch dues and what is required to bill the next visit. Front-desk should not need another branch's pricing or discount-reason history to do its job.
- **[Should]** "Unpaid only" filter on the timeline (drives the before-billing dues check).
- **[Should]** Payment-transaction history in the inspector (CASH/ONLINE/CHEQUE, reference, date). **BE-dep:** `PaymentTransaction` is not joined, and **`paymentType` lives on `PaymentTransaction`, not on `Bill`** — the current read of `visit.bill?.paymentType` (`Patient360.tsx:399`) resolves to `null` on every row. Any "payment method" shown anywhere requires this join. *Lets staff verify an "I already paid" claim.*
- **[Could]** Full financial-detail secondary tab (consolidated ledger) for owner audit.
- **Decision (lens conflict):** Staff/Patient lenses want a **payment action** in 360; UI/UX and the security model say 360 is intentionally read-only. **Resolution:** keep 360 read-only for money; provide a **deep-link to the bill/payment workflow** instead of inline payment. Preserves the read-only invariant while removing the dead-end.

### 3.5 Actions
- **[Must]** **"Start new visit" launch** (Diagnostics / Clinic) from 360 with patient pre-filled. *Removes the single biggest workflow break — returning-patient billing is the core job; today staff must exit to `/clinic/new`.* Frontend deep-link; offer only enabled-module domains (Axora). **Suppressed for deceased patients** (see 3.7).
- **[Must]** **One-click row actions** for the 80% case: Reprint Bill, View/Print Report (finalized only), WhatsApp — directly on the timeline row, not buried behind View Details.
- **[Must]** Per-action loading state is **per-visit, keyed by visitId** — fix the shared `previewLoading` boolean (line 665) that disables every row's "View Report" at once.
- **[Should]** Jump-to-original-visit + reprint-original from revisit rows.
- **[Could]** "Flag a correction / dispute" action that captures a grievance against a visit/charge/result and routes it (today nothing — depends on staff memory). BE-dep (new entity/endpoint).
- **[Could]** Bulk/family actions (print all bills for a date for a shared-phone family).

### 3.6 Reports & messaging
- **[Must]** Unify report preview/print/WhatsApp behind **one shared `useReportActions(visit)` hook** with a single `sending` state keyed by visitId — kills the verbatim WhatsApp duplication in VisitDetailDrawer (138-166) and Report Modal (734-767).
- **[Must]** **Gate WhatsApp send on `whatsappOptIn`** (not merely phone presence as today, lines 300/734) and **show the destination number** before sending. *Consent + shared-phone confidentiality.* `whatsappOptIn/At/Source` already on Patient.
- **[Must]** PDF preview renders **inline in the inspector** (desktop) / full-screen (mobile). ESC + X + backdrop all close; revoke blob URL on inspector change **and** on route unmount (fix the leak). **Desktop legibility caveat:** a full report page inside a right-hand sheet at ≥1280px is cramped — verify the embedded `iframe` blob viewer is legible at sheet width, otherwise open full-screen preview on desktop too (same component, expanded surface).
- **[Should]** **Communication history** per visit (sent/delivered/failed, when, to which number) read back from `MessageLog`, so the button reflects real delivery instead of a transient toast — stops duplicate sends and "did it go?" calls. BE-dep: `MessageLog` not joined.

### 3.7 Deceased-patient handling
- **[Should] (needs product decision — see Q10).** There is **no `dateOfDeath`/`isDeceased` field in the schema today** (confirmed absent). The redesign must not silently enable sending medical reports or starting "[+ New]" visits for a deceased patient (especially to a shared family number). Resolve one of:
  - (a) add an `isDeceased`/`dateOfDeath` field → show a deceased banner on the header that **suppresses WhatsApp send and the [+ New] launcher** and warns before any report action; or
  - (b) explicitly declare deceased-state out of scope as a documented assumption.
  Do not ship the messaging/new-visit affordances without picking one.

---

## 4. INFORMATION ARCHITECTURE & LAYOUT

### Section order (priority)
1. **Sticky patient header bar** — identity + key flags + Edit (+ deceased banner when applicable). Always visible (collapses on scroll).
2. **At-a-glance strip** — Last visit (date+domain) · **Outstanding due (₹)** · Reports (finalized vs pending count). Replaces the heavy 3-column "informational" financial card; full financials demoted to a secondary tab.
3. **Visit Timeline (primary)** — filter/segment bar + result count, month-grouped, paginated + virtualized, per-row chips + inline actions.
4. **Inspector panel (right on desktop / bottom sheet on mobile)** — single surface for visit detail **and** report preview (replaces the drawer + modal duplication).
5. **Secondary tabs (below fold / on demand)** — Financial detail, Communication log, Audit/change history.

**Above the fold:** sticky identity + glance strip + first page of the timeline with filters. Everything a counter user needs to answer "who, paid?, ready?" is visible without scrolling.

> **Wireframe data-readiness note:** the inspector's financial breakdown (Total / Discount / Paid / payment method) and the row-level abnormal-flag chip are **100% BE-dep** today — only `paymentStatus`, `billedAt`, and `totalAmountInPaise` are local. The wireframe shows the target state; the build team must not assume that data is currently in the payload.

### Desktop wireframe (≥1280px)
```
┌──────────────────────────────────────────────────────────────────────────┐
│ ← Back  RAMESH KUMAR (MR · 54Y · M)  P-01432  📞 98xxxx  ✓WA  [ Edit ]     │ ← sticky
├──────────────────────────────────────────────────────────────────────────┤
│ Last: 12 Jun · Diagnostics │ Due: ₹1,250 ▲ │ Reports: 3✓ 1 pending │[+New ▾]│ ← glance + new-visit
├───────────────────────────────────────────┬────────────────────────────────┤
│ VISIT TIMELINE             (24 active)     │  INSPECTOR                      │
│ [All][Diagnostics][Clinic] [Date▼][Branch▼]│  ┌──────────────────────────┐  │
│ [☐ Unpaid only] [☐ Show cancelled]         │  │ Diagnostics · MPR · 12 Jun│  │
│  ── June 2026 ──────────────────────────── │  │ Bill #MPR-2231            │  │
│  ┌──────────────────────────────────────┐ │  │ Total ₹2,400  Disc −₹200  │  │ ← BE-dep
│  │ 12 Jun [DIAG] MPR · #2231             │ │  │ Paid ₹2,200  🟢 PAID      │  │ ← BE-dep
│  │ ✅ Finalized v1 · ⚠1 HIGH ₹2,400 🟢PAID│ │  │ Method: ONLINE            │  │ ← BE-dep
│  │           [View Report] [Inspect ▸]   │ │  │ ─────────────────────────│  │
│  └──────────────────────────────────────┘ │  │ Report ✅ Finalized v1     │  │
│  ┌──────────────────────────────────────┐ │  │  [View][Print][WhatsApp→98]│  │
│  │ 09 Jun [CLINIC·OP] 🔁 Revisit         │ │  │ Bill   [Print Bill]       │  │
│  │ Dr. Mehta  ₹500  🟡 DUE ₹500          │ │  │ Sent: ✓ Delivered 12 Jun  │  │ ← BE-dep (MessageLog)
│  │ ↳ orig #2180 · 02 Jun [open ▸]        │ │  │  [→ Collect payment]      │  │ ← deep-link, read-only 360
│  │           [Print Bill] [Inspect ▸]    │ │  └──────────────────────────┘  │
│  │ 05 Jun [DIAG] ⨯ Cancelled (excl. dues)│ │  (PDF preview renders inline;   │
│  └──────────────────────────────────────┘ │   ESC / X / backdrop to close;  │
│  ── May 2026 ───── … virtualized, load-older │  full-screen on desktop if    │
│                                            │   sheet width is illegible)     │
└───────────────────────────────────────────┴────────────────────────────────┘
```

### Mobile / tablet
- Sticky header collapses to name + masked phone + Edit (kebab). Glance strip wraps to 2 rows, **Due always first**.
- Timeline full-width single column; filters become a sticky segmented control + a "Filters" bottom sheet.
- Inspector is a **bottom sheet**; PDF preview opens full-screen *within the same inspector flow* — same component, different breakpoint, no separate modal.

### Handling 100+ visits (explicit)
- **Server-driven cursor pagination** (default ~20, load-older) is the correctness baseline — the backend currently returns the entire visit history on every load.
- **Filtering** (domain / date / branch / unpaid-only / show-cancelled) narrows server-side before scroll.
- **Month grouping** gives scan anchors; **client virtualization** bounds the rendered DOM for the loaded window.
- **Glance totals (due, lifetime, report counts) come from a backend aggregate**, never from "having loaded every visit" or client recompute-every-render (current `md:grid-cols-3` sums, lines 525-537). **Coupling note:** "Reports: 3✓ 1 pending" appears to be cheap today only because the backend loads *all* visits; once pagination lands, glance counts **must** come from the aggregate endpoint, not the loaded page. Pagination and glance-counts are one coupled work item.

---

## 5. KEY FLOWS

**A. Returning patient → new visit (highest-frequency)**
1. Staff searches phone/name in GlobalPatientSearch → **if multiple hits on a shared phone, disambiguate by name/age/gender** and pick the right person; **if no match, take the "register new patient" path** (not a Patient360 dead-end).
2. Patient360 opens; sticky header re-confirms identity; glance strip shows due + last visit.
3. Staff clicks **[+ New ▾]** → chooses Diagnostics or Clinic (only enabled modules shown; suppressed if patient is deceased).
4. New-visit workflow opens **pre-filled** with this patient. *(Today: dead-ends — must re-find patient at `/clinic/new`.)*

**B. "Is my report ready?" + resend**
1. Open 360 (or read straight off glance strip "Reports: 3✓ 1 pending").
2. Scan timeline / filter Diagnostics → row chip shows ✅ Finalized (with version / partial state) vs ⏳ Pending.
3. Finalized: click **WhatsApp** on the row → confirm opt-in + destination number → send → button reflects real delivery from MessageLog ("✓ Delivered"). Pending: clear "results pending" state, no false "already sent."

**C. Correct identity (deliberate, audited)**
1. Click **Edit** → focused form.
2. Change phone 98… → 97… → **review step** shows the diff + requires `changeReason`.
3. Confirm → PATCH → **local state updated from the PATCH response** (no full refetch; correct casing/age preserved). Audit logged via `PatientChangeLog`; "last changed by/why" visible on the identity panel.

**D. Check dues before billing**
1. Open 360 → glance strip headline **Due: ₹1,250** (cancelled/refunded excluded).
2. (Optional) toggle **Unpaid only** → see exactly which visits are outstanding (per-visit Due chip).
3. Inspect a visit → see Paid/Due/transactions → **deep-link to bill/payment workflow** to collect (360 stays read-only).

**E. Owner audit a complaint**
1. Open 360 → filter by date/branch.
2. Inspector shows full financials (total/discount/paid/due, payment txns).
3. Open **Audit/Change-history tab** → who edited identity, who viewed/sent reports.

---

## 6. NON-FUNCTIONAL REQUIREMENTS

**Performance**
- Server-side cursor pagination is mandatory (backend over-fetches all visits today). Bounded DOM via virtualization; no full-array `.map`. Per-visit loading state (no shared boolean re-rendering all rows). Glance totals from a backend aggregate, not per-render client sums. Abnormal-flag surfacing must use a join, not N+1 detail fetches. Memoize remaining derived values.

**Responsive**
- Single-component-per-breakpoint inspector (right sheet desktop ≥1280, bottom sheet mobile/tablet). Replace `max-w-4xl` single column with a two-pane desktop layout that collapses to one column < 1024px. Verify inline-PDF legibility at sheet width; fall back to full-screen preview on desktop if cramped. Mono bill strings must not wrap awkwardly; chips wrap gracefully.

**Accessibility**
- Status as icon+text+color chips (WCAG 1.4.1 — no color-only meaning). `role="status"` on live status. Inspector/preview: focus trap + **ESC-to-close** (today missing) + restore focus to trigger. Keyboard-operable filters and row actions for a keyboard-driven front desk.

**Privacy / consent & audit**
- WhatsApp send gated on `whatsappOptIn` with destination shown (no sending medical reports to a non-consented or shared family number; suppressed for deceased patients per 3.7).
- Role-scoped financials (3.4) and abnormal clinical values (3.3) — values shown on a shared counter screen are privacy-sensitive; default to flags inline and full values in the inspector.
- Cross-branch exposure is intentional but **report access should be auditable** (`ReportAccessLog`) and surfaced in the audit tab. Mask phone in the header (full value only in edit).

**Error / loading honesty**
- Skeleton loading (not bare spinner).
- **Separate the not-found path from the failure path.** Today `Patient360.tsx:59` already returns `null` on a genuine 404, but that `null` is funneled into the same "Patient not found" state as a thrown network/5xx error (lines 365/411). The fix is to keep the `null` = genuinely-not-found path distinct from the `throw` = network/5xx path, and give the latter a **Retry**. Do not treat a transient server failure as "this patient does not exist."
- **Remove the hardcoded fallback `branchId` `'cmjzumgap00003zwljoqlubsn'`** (Patient360 line 49, GlobalPatientSearch line 29): require a real `activeBranchId` or fail loud with a clear message — never silently send a placeholder branch header.

**Axora-modular (graceful degradation)** — isolated conditionals keyed off enabled domains, no toggle framework built now:
- **Diagnostics-only:** clinic visits absent → glance strip & financials drop "Clinic"; [+ New] offers Diagnostics only; pending-results becomes the primary tech job. Clinic-only fields (doctor/visitType/revisit) self-hide.
- **OP-only (Clinic):** drop the diagnostic report section (already conditional, 263-316); financials drop "Diagnostics"; [+ New] offers Clinic/OP only; reprint-bill + revisit-slip primary.
- **All (OP + IP + Diagnostics):** domain filter becomes essential (mixed rows); due rollup sums across domains; IP visits (visitType=IP, hospitalWard) get distinct row treatment.
- **Architecture note:** no frontend module flag exists today (enforced implicitly via routes). Add a Branch-level module-config signal (Diagnostics/OP/IP flags) so these conditionals are real, not incidental — wiring left mechanical for Axora's later toggle.

---

## 7. COMPONENT BREAKDOWN

Decomposing the current single 798-line `Patient360.tsx` (+ embedded drawer/modal):

| Component | Responsibility (one line) |
|---|---|
| `Patient360Page` | Route container: data fetch orchestration, error/loading/empty states, layout shell. |
| `usePatient360(patientId)` | Data hook: fetch + cursor pagination + filter params + typed states (null=not-found vs throw=network/5xx) + retry. |
| `PatientHeaderBar` | Sticky identity bar (name, P-number, age/gender, masked phone, opt-in/branch flags, deceased banner) + Edit trigger. |
| `GlanceStrip` | Last visit · outstanding due · report counts, from backend aggregate (cancelled/refunded excluded). |
| `NewVisitMenu` | [+ New ▾] launcher; offers only enabled-module domains, deep-links pre-filled; suppressed if deceased. |
| `TimelineFilters` | Segmented domain control, date range, branch dropdown, unpaid-only + show-cancelled toggles, result count. |
| `VisitTimeline` | Paginated (cursor) + virtualized, month-grouped list; renders `VisitRow`s; load-older. |
| `VisitRow` | One visit: chips (payment/report/partial/abnormal/cancelled), branch/bill, revisit lineage, inline row actions; per-row loading. |
| `VisitInspector` | Single surface (right sheet / bottom sheet) for visit detail + inline PDF preview; ESC/X/backdrop close; full-screen fallback. |
| `FinancialDetailPanel` | Total/discount/paid/due + PaymentTransaction history (in inspector + secondary tab); role-scoped. |
| `ReportActions` + `useReportActions(visit)` | Shared preview/print/WhatsApp logic, single `sending` state keyed by visitId, opt-in gate, blob lifecycle. |
| `CommunicationLog` | MessageLog-backed send/delivery history per visit. (BE-dep) |
| `PatientEditDialog` (refactored) | Focused edit with review/diff step, `changeReason`, in-place update from PATCH response (correct casing/age). |
| `PatientAuditPanel` | Who edited / viewed / sent (`PatientChangeLog`/`AuditLog`/`ReportAccessLog`). Identity change-history read promoted to [Should]. |
| `StatusChip` | Reusable icon+text+color chip (payment, report, partial, abnormal-flag, cancelled) — WCAG-safe. |
| `DuplicateHint` | "Possible same patient" surface + merge-request entry (hint only; full merge is a separate backend epic). (BE-dep, [Should]) |

---

## 8. PHASED ROLLOUT

> **Honest scoping:** there is **no purely frontend-only first phase**. The headline due number and correct pagination are both backend-blocked. Phase 1 below is "frontend + a minimal Bill-financials/pagination join"; the strictly-frontend subset is called out within it.

**Phase 1 — Frontend, plus a minimal backend join (launch-gating)**

*Strictly frontend (no backend):*
- Sticky `PatientHeaderBar` + anchored identity confirmation.
- Shared-phone disambiguation + "no match → register" path in GlobalPatientSearch.
- Typed `StatusChip`s; raised revisit contrast + jump-to-original link; CANCELLED visual treatment + default exclusion from active view.
- Unify drawer + modal → single `VisitInspector`; shared `useReportActions` hook; **fix per-visit loading state**; ESC-to-close; blob-URL cleanup.
- One-click row actions (Reprint Bill, View/Print Report, WhatsApp).
- **[+ New]** launch deep-links to existing new-visit workflows.
- **Separate not-found from network/5xx** + Retry + skeleton.
- **Remove hardcoded fallback branchId**; gate WhatsApp on `whatsappOptIn` + show destination; edit review-step + in-place update from PATCH response.

*Minimal backend join required this phase (launch-gating):*
- **Cursor + filter params** on `/patients/:id/360` — pagination is a correctness prerequisite, not optional.
- **Minimal Bill-financials join** (`paidAmountInPaise`, derived `dueAmountInPaise`) so the glance strip can show a real **Outstanding due**. *Without this join there is no due number in Phase 1 — accept that explicitly, or land this join.*
- Aggregate for glance counts (due + report counts), coupled to pagination.

**Phase 2 — Fuller backend (extend `getPatient360View`)**
- Full per-visit financials in payload: discount fields, `PaymentTransaction` history (and the real `paymentType`, which lives on PaymentTransaction not Bill).
- Join `TestResult` flags/values for finalized diagnostics (abnormal-flag surfacing) — via join, with the Q4 privacy gate resolved first.
- Partial / re-finalized report state (`workflowMode` + `ReportVersion`) + per-visit next-action.
- Join `MessageLog` for real delivery status / communication history.
- Identity change-history read surfaced ([Should], endpoint already exists — pull forward if cheap).
- Role-scoped financial visibility.
- Branch-level module-config flags (Axora module-aware rendering becomes real).
- Deceased field + suppression (if Q10 resolves to "in scope").

**Phase 3 — Advanced**
- Full per-patient audit/access tab (`AuditLog`/`ReportAccessLog`).
- **Patient merge subsystem** — net-new backend (merge table, visit re-pointing, audit, owner approval). Separate epic, not a Patient360 deliverable; the duplicate *hint* ships earlier.
- Test-value **trend view** for repeat tests.
- "Flag a correction / dispute" capture + routing.
- Bulk / family actions; "notify when ready" on pending reports.
- Doctor read-access to clinic history (pending product decision — see Q1).

---

## 9. OPEN QUESTIONS / ASSUMPTIONS

1. **Doctor access:** Should a referring doctor get read-only clinic/diagnostic history (today fully blocked, intentional but undocumented)? If yes, scoped to their own referred patients or full?
2. **Payment in 360:** Confirmed assumption — 360 stays **read-only for money**; we deep-link out to the bill/payment workflow rather than add inline payment. Acceptable, or is in-context payment-record needed at the counter?
3. **Outstanding-due source of truth:** `dueAmountInPaise` is derived (in `billFinancialService`), not stored. Is a backend aggregate endpoint acceptable as the authoritative due, or must totals reconcile against the bill service live on each load?
4. **Clinical results in timeline:** How much to surface inline — flags only, flags + key values, or full panel? (Safety value vs payload size vs privacy on a shared counter screen.) Blocks 3.3 shipping.
5. **Merge policy:** System deliberately prevents auto-merge **and has no merge data model**. Confirm: is the realistic deliverable a non-actionable "possible duplicate" hint, with full staff-merge→owner-approval treated as a separate backend epic?
6. **Module-config signal:** Where do per-tenant Diagnostics/OP/IP flags live (Branch table?) and what is the shape of the frontend-readable config? (Blocks real Axora-modular rendering.)
7. **Consent semantics:** Is `whatsappOptIn=false` a hard block on report send, or a warning staff can override with reason (and audit)?
8. **WhatsApp delivery read-back:** Is `MessageLog` status reliably updated by the WhatsApp provider webhook (SENT→DELIVERED→READ), so the inspector can trust it?
9. **Pagination — answered finding, not open:** the backend does **not** paginate (`include: { visits }` with no `take`/`skip`, returns all). Therefore cursor params are a Phase-1 correctness prerequisite; client virtualization alone is insufficient. (Retained here as the resolved record.)
10. **Deceased patients:** No `dateOfDeath`/`isDeceased` exists. In scope (add field + suppress messaging/[+ New]) or explicitly out of scope for now?
11. **REFUNDED / FAILED payments:** Confirm rollup treatment — REFUNDED counts as neither due nor paid; FAILED is not a due; both excluded from the headline due number alongside CANCELLED visits.

---

**Primary files for the build step:**
- `/Users/pranavreddy/Desktop/sobhana portal/health-hub/src/pages/clinic/Patient360.tsx` — screen + drawer + modal to decompose; `:59` (404→null), `:399` (reads nonexistent `bill.paymentType`), `:49` (hardcoded branchId), `:573-574`, `:665` (shared loading boolean)
- `/Users/pranavreddy/Desktop/sobhana portal/health-hub/src/pages/clinic/GlobalPatientSearch.tsx` — entry point; shared-phone disambiguation + no-match-register path; `:29` hardcoded branchId
- `/Users/pranavreddy/Desktop/sobhana portal/health-hub/src/components/patient360/PatientEditDialog.tsx` — edit flow: review-step + in-place update from PATCH response; `:457` (full refetch to remove)
- `/Users/pranavreddy/Desktop/sobhana portal/health-hub-backend/src/services/patientService.ts` — `getPatient360View` (`:306-456`): add cursor/filter params, Bill financials (paid/due/discount), `PaymentTransaction` (+ `paymentType`), `TestResult` flags, `MessageLog`, `workflowMode`/`ReportVersion`; CANCELLED/REFUNDED exclusion; server-computed age (`:440-442`)
- `/Users/pranavreddy/Desktop/sobhana portal/health-hub-backend/src/routes/patients.ts` — `/patients/:id/360` endpoint params; `change-history` endpoint already exists
- `/Users/pranavreddy/Desktop/sobhana portal/health-hub-backend/prisma/schema.prisma` — `VisitStatus` CANCELLED (`:46`), no deceased field (`:243-273`), `paymentType` on `PaymentTransaction` (`:579`), shared-identifier comment (`:277-278`)
- `/Users/pranavreddy/Desktop/sobhana portal/health-hub/src/types/index.ts` — `VisitTimelineItem` / `Patient360View` shapes
- `/Users/pranavreddy/Desktop/sobhana portal/health-hub/src/lib/reportAccess.ts` — report blob/print logic for the shared `useReportActions` hook
