# Patient360 — Patient-Advocate / Care-Continuity Analysis

The patient never logs in. Everything below is mediated by a front-desk staff member under time pressure, often with the patient or family physically standing at the counter. The screen's job is to let staff *act correctly on behalf of a real person in under a minute*. I have grounded every claim in the discovery digest and the two files I read (`Patient360.tsx`, `GlobalPatientSearch.tsx`).

---

## 1. PATIENT NEEDS → Concrete screen requirements

| Patient need | What it means here | Concrete requirement the screen must meet | Data status |
|---|---|---|---|
| **"This is actually MY record"** (accurate, deduplicated identity) | A walk-in shares a phone with family; staff must open the *right person*, not a namesake or relative | Search results and the identity card must show enough disambiguators to confirm identity *before acting* — name + ageDisplay + gender + patientNumber + phone, and ideally last-visit date/branch. Today search shows name/age/gender/phone/patientNumber + a 3-visit snapshot (`GlobalPatientSearch.tsx:185-237`) — adequate to *pick*, but there is **no confirmation gate** on the 360 screen itself reminding staff who they opened. | Available: patientNumber, name, ageDisplay, gender, address, identifiers. No photo, no Aadhaar-last-4 surfaced. |
| **Complete cross-branch longitudinal history** | Patient treated at MPR last year, KPY today — one continuous story | Timeline must show *all* visits across all branches in one list, labeled by branch. Met: `getPatient360View` ignores branch filter; each row shows `branchName` (`Patient360.tsx:600-602`); financial summary and `branches[]` enable "history across N branches". | Available |
| **Timely access to their own reports** | "Send me my report" / "print it" | For any FINALIZED diagnostic report: one-tap WhatsApp, print, preview. Met (`Patient360.tsx:280-311`, `660-675`). **But** WhatsApp/print are gated on `reportStatus === 'FINALIZED'` only; a DRAFT/pending report offers the patient *nothing* — no "results pending, expected by…" affordance. | Available (FINALIZED reports); reportStatus, finalizedAt present |
| **Continuity of care — clinician sees prior results & trends** | A doctor or staff should see that last HbA1c was 9.2, trending up | Timeline must surface *result values and flags*, not just "Finalized." **NOT MET.** Discovery confirms `TestResult` rows (value/textValue/flag NORMAL/HIGH/LOW/CRITICAL) are **not joined into Patient360View** (`patientService.ts:423-429`); the screen shows only "Report Finalized" vs "Results Pending" (`Patient360.tsx:616-623`). No trend, no abnormal-flag visibility, no values without opening the PDF. | **Backend dependency** — results exist but are not in the 360 payload |
| **Financial transparency — what I paid / what I owe** | "How much is still due?" | Per-visit and lifetime: amount, paid, **due**, discount, payment method, payment status. Partially met: timeline shows total + paymentType + paymentStatus (`Patient360.tsx:633-644`); drawer shows amount/method/status (`224-259`). **But** the "Financial Summary" sums `totalAmountInPaise` only (`523-545`) — it shows lifetime *billed*, **not lifetime due/outstanding**. Patient360View selects only `paymentStatus` + `billedAt` from Bill (`patientService.ts:317-319`); `dueAmountInPaise`, `paidAmountInPaise`, transaction history are **not in the timeline payload**. | **Partial backend dependency** — due/paid/discount/txns exist on Bill but not surfaced in 360 |
| **Privacy & consent** | Cross-branch view exposes a person's full medical/financial life to any staff at any branch | Screen should surface WhatsApp opt-in status before sending, and ideally a consent/sensitivity indicator; report access should be auditable | `whatsappOptIn`/`whatsappOptInAt`/`whatsappOptInSource` and `ReportAccessLog`/`AuditLog` **exist in schema** but are **not surfaced** in 360. WhatsApp send is gated only on phone presence (`Patient360.tsx:300`, `734`), **not on opt-in**. **Backend data exists, frontend gap.** |
| **Get errors corrected** | Wrong name, wrong age, wrong phone, wrong charge, wrong result | Identity edits with mandated change-reason: met via `PatientEditDialog` (change-reason for identity fields, audited). **But** DOB and identifier add/remove are not editable from here; charges and results are correctly read-only (must be fixed at source) — yet the screen gives staff **no "raise correction / flag dispute" path**, so the patient's complaint has nowhere to go from this screen. | Available (identity); financial/result correction is out-of-scope by design |

---

## 2. PATIENT USE-CASES (Indian clinic + diagnostics context)

**A. Returning patient — "You have my history, right?"**
Staff searches by phone, sees the patient card + 3-visit snapshot, opens 360, sees the full cross-branch timeline. *Works well.* Gap: if the patient has 100+ visits there is **no pagination, no date/domain/branch filter, no in-timeline search** (`Patient360.tsx:573` renders all into one `space-y-3`). Staff must scroll a long DOM to find "the blood test from Diwali last year."

**B. Family members sharing one phone number** — *the highest-risk Indian scenario.*
Phone search returns *every family member on that number*. The screen must let staff pick the correct individual. Search cards do disambiguate by name/age/gender. **Risk:** once inside 360, nothing re-confirms identity, and there is **no dedup/merge awareness** — if a child was registered twice (e.g., "BABY OF SITA" then "AARAV"), they appear as two separate patients with split histories and the screen gives no hint they may be the same person (backend `patientMatching` exists, no frontend surface). A clinician could make a decision on half a history.

**C. Walk-in with no records** — searched, not found. Staff sees "No patients found" (`GlobalPatientSearch.tsx:168-176`) and proceeds to registration elsewhere. *Adequate.* The 360 "Patient not found" state (`Patient360.tsx:406`) is the wrong screen for this — it's only reachable via a bad/expired ID.

**D. "Is my report ready?"**
Most common phone/counter question. Staff opens 360, scans timeline: "Report Finalized" (green) vs "Results Pending" (amber) (`Patient360.tsx:616-623`). *Answerable.* Gap: "Pending" gives **no expected-ready time** and no one-tap "notify when ready," and there is **no log of whether/when a report was already sent** (MessageLog exists, not joined) — so staff may resend or wrongly say "we already sent it."

**E. Disputing a charge or a result**
"I paid this already" / "this glucose value is wrong." Staff can *view* billing (drawer) and the report PDF, but: (1) the financial summary doesn't show paid-vs-due, only billed total; (2) there's **no payment transaction history** in the view (CASH/ONLINE/cheque ref not in timeline); (3) results aren't visible without opening the PDF; (4) there is **no dispute/flag action**. The patient's grievance can be *looked at* but not *captured or routed* from here.

**F. "Please resend last year's report on WhatsApp"**
Staff finds the old FINALIZED visit, taps WhatsApp/preview/print (`Patient360.tsx:280-311`). *Works* — provided the report is FINALIZED and a PHONE identifier exists. Gaps: no opt-in check before sending; no confirmation of *which number* it's going to (could be a relative's shared phone); no send-history so staff can't confirm "it went through."

**G. Low-digital-literacy patient relying on staff**
Patient can't read English PDFs or operate a phone. Everything is staff-mediated, which the design supports. The single most valuable thing for this patient — a clinician/staff being able to *say out loud* "your sugar is high, it's gone up since last time" — is exactly what's missing, because **values and trends aren't on the screen** (use-case D/continuity gap).

---

## 3. RISKS TO THE PATIENT (grounded in discovery)

1. **Wrong-patient action (high).** No identity re-confirmation on the 360 screen and no photo. With shared family phones (use-case B), staff under high-volume pressure can open/act on the wrong person. Search disambiguation exists but the destination screen does nothing to reassert "you are now viewing P-00123, AARAV, 4y, M."

2. **Split / duplicate records fragmenting history (high).** No frontend dedup/merge or even a "possible duplicate" hint. A patient registered twice has two partial 360 views; a clinician seeing only one makes decisions on incomplete history. Backend matching capability exists but is invisible here.

3. **Care decisions on "Finalized" with no values (high — clinical).** The screen reduces a clinical result to a green word. Abnormal/CRITICAL flags, actual values, and trends are **not in the payload** (`patientService.ts:423-429`). A CRITICAL_HIGH potassium and a normal result look identical in the timeline. This is the most serious patient-safety gap.

4. **Financial harm / disputes (medium).** "Financial Summary" sums *billed* amounts (`Patient360.tsx:523-545`), not outstanding due, and `dueAmountInPaise`/paid/transactions aren't surfaced (`patientService.ts:317-319`). A patient can be told the wrong balance, or a genuine "already paid" claim can't be verified from here.

5. **Privacy / consent exposure (medium).** Cross-branch design means any staff at any branch sees a patient's entire medical+financial life with no consent indicator. WhatsApp sends are gated only on phone presence, **not `whatsappOptIn`** (`Patient360.tsx:300`, `734`) — risk of sending a medical report to a patient who never consented, or to a shared family number, a real confidentiality breach in the Indian shared-phone context.

6. **Stale identity (medium).** Identity is editable but DOB and identifiers can't be corrected here, and edits trigger a full refetch with no diff and **no confirmation step** before overwriting name/phone (`Patient360.tsx:454-458`) — an accidental phone change silently redirects all future report deliveries.

7. **Misdelivery via shared/blocked channels (low-medium).** Print uses `window.open` with a popup-blocker check; if blocked, the patient simply doesn't get their report and feedback is a transient toast (`Patient360.tsx:184-186`). No send-history (MessageLog not joined) means failed/duplicate sends are invisible.

8. **Wrong-branch data integrity (low, but silent).** Hardcoded fallback branchId `'cmjzumgap00003zwljoqlubsn'` (`Patient360.tsx:49`, also `GlobalPatientSearch.tsx:29`) — if the store is empty, auth headers carry a placeholder branch; viewing is cross-branch so history is unaffected, but any branch-scoped action/audit attribution is mis-stamped.

9. **Lost grievances (low-medium, experiential).** No path to flag a disputed charge/result/identity error from the screen, so the patient's complaint depends entirely on staff memory.

---

## 4. PATIENT-CENTERED REQUIREMENTS (prioritized)

### MUST
- **M1. Surface result values + abnormal flags in the timeline (or visit drawer) for finalized diagnostic visits.** At minimum show CRITICAL/HIGH/LOW flags and key values without forcing a PDF open. *Backend dependency:* join `TestResult` into Patient360View or add a per-visit results fetch in the drawer. (Risk 3; need: continuity of care)
- **M2. Persistent patient-identity confirmation on the 360 screen** — keep name + ageDisplay + gender + patientNumber + masked phone visibly anchored, so staff acting on behalf of a shared-phone family never act on the wrong person. (Risk 1; need: accurate identity)
- **M3. Gate WhatsApp send on `whatsappOptIn` and show the destination number** before sending; surface opt-in status. Data exists (`whatsappOptIn/At/Source`); only the frontend check is missing. (Risk 5; need: privacy/consent)
- **M4. Show true financial position: lifetime/visit Paid and Due, not just Billed.** *Backend dependency:* include `paidAmountInPaise`/`dueAmountInPaise` (and ideally transactions) in the 360 payload. (Risk 4; need: financial transparency)
- **M5. Real error states + retry on the 360 fetch.** Today network errors collapse to "Patient not found" (`Patient360.tsx:406`, fetch error only `console.error`'d at `365`) — a patient is told they don't exist when the server hiccupped. Distinguish 404 from 5xx and offer retry. (Need: trust/accuracy)

### SHOULD
- **S1. Duplicate-record detection / "possible same patient" hint and a staff-initiated merge request path.** Backend matching exists; expose it. (Risk 2)
- **S2. Communication history per visit** (sent/delivered/failed, when, to which number) by joining MessageLog — so staff answer "did my report go?" truthfully and avoid duplicate/failed sends. (Use-case D/F)
- **S3. Timeline filter + pagination** (by domain, date range, branch) so a long-history patient is findable in seconds and the screen stays performant. (Use-case A; gap: no pagination at `Patient360.tsx:573`)
- **S4. Confirmation step on identity edits** (especially phone/name) before overwrite, given downstream delivery impact. (Risk 6)
- **S5. "Results pending — expected by / notify when ready" affordance** on DRAFT diagnostic visits. (Use-case D)
- **S6. Remove the hardcoded fallback branchId**; require a real active branch or block the action with a clear message. (Risk 8)

### COULD
- **C1. Simple trend view** for repeat tests (e.g., HbA1c over time) — high value for chronic-care patients once M1 lands.
- **C2. "Flag a correction / dispute" action** that captures the patient's grievance against a visit/charge/result and routes it, instead of relying on staff memory. (Use-case E; Risk 9)
- **C3. Jump-to-original-visit link** from revisit rows (currently read-only text only, low-contrast `text-blue-700`, `Patient360.tsx:646-653`).
- **C4. Per-patient access/audit visibility** (who viewed/edited/sent) using existing `ReportAccessLog`/`AuditLog`/`PatientChangeLog`, supporting the patient's right to know who touched their record.
- **C5. Bulk/family actions** (e.g., print all bills for a date) for shared-phone family front-desk efficiency.

---

**Backend dependencies to flag for synthesis:** M1 (TestResult values/flags), M4 (paid/due/transactions in 360 payload), S2 (MessageLog join), C4 (audit/access-log join), and surfacing `whatsappOptIn` for M3 — all of these data points **exist in the schema** per the discovery digest but are **not currently returned in `Patient360View`** (`patientService.ts:306-456`, selecting only `paymentStatus`+`billedAt` from Bill and omitting TestResult/MessageLog/ReportAccessLog joins).
