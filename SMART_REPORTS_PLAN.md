# HealthFlow Smart Reports — design & build plan

Status: DESIGN (Aug 31 2026). Target: **Sobhana portal single-tenant first**, then lift to
multi-tenant HealthFlow if it proves out. Build it as an isolated module so the lift is
mechanical — no tenancy infra now.

Objective, unchanged from the brief: *take the conventional diagnostic report HealthFlow
already produces and automatically turn it into a polished, understandable, personalised
Smart Health Report for the patient.* Not a new medical product.

---

## 0. What the Flabs report actually is (reverse-engineered)

Six pages, patient-facing, generated after results are out. Structure:

| Page | Content | Mechanism behind it |
|---|---|---|
| Cover | Lab logo + tagline, "Smart HEALTH REPORT", **"✨ AI Generated" badge**, patient name/sex/age, lab address + phone, **QR to download** | Pure template + branding. QR = the report link. |
| 1 — Personalised Health Analysis | Weight / Height / BMI tiles, **Test Score** sentence + %, body silhouette with **panel tiles** (Liver Function, Thyroid, CBC…) each tagged `n Normal` / `n Abnormal` / `Pending` | Panel rollup of per-analyte in/out-of-range counts. BMI needs height+weight captured at registration. |
| 2 — Health Essentials Insights | Daily water, sleep hours, energy expenditure at 3 activity levels, macronutrient ranges (protein/carbs/fat/fibre), calorie targets for loss/gain/maintenance | **Deterministic formulas off weight/height/age/sex** (Mifflin-St Jeor + RDA ranges). No lab results involved. |
| 3–5 — Detailed test insights / summary | (not in the screenshots supplied, but implied by page numbering: 01, 02, … 06) | Per-panel tables + per-finding explanation. |
| 6 — Health Advisory | Suggested Diet (3 themed blocks, each ✓ do / ✗ don't), Suggested Lifestyle (activity, stress), **Suggested Future Tests** with re-test intervals | Rules keyed off the abnormal findings → curated content, lightly rephrased. |

**Defects in the sample worth *not* copying:**

1. Page 1 says *"All 89 health parameters are within the normal range. Your health score is
   **100%**"* while the tiles beside it show **7 Abnormal** on Lung Function, Thyroid and CBC.
   The score and the tiles are computed from different sets. This is the single most damaging
   bug possible in this product — a patient with 7 abnormal results is told they're perfect.
   **Our score and our tiles must be projections of one resolved finding set. Non-negotiable.**
2. "Kidney Function Test" appears **twice**, both `Pending` — panel dedup is missing.
3. Energy Expenditure shows **2,596 Cal for all three** activity levels — a broken calculation
   shipped to a patient.
4. `Pateint:` typo on the cover; `Protien` on page 2.
5. Pending tests are mixed into the same tile grid as completed ones, so the reader can't tell
   what was actually measured.
6. Generic body silhouette, identical for every patient.
7. Diet advice ("Have Vitamin-D Rich Foods", "Iron-rich foods") is shown on a report whose own
   score claims everything is normal — the advice is not derived from the findings.

Net read: the concept is strong and genuinely valuable; the execution is a template with an
LLM loosely bolted on and no consistency gate. **The entire engineering value we add is the
gate.**

---

## A. Product breakdown

Nine capabilities. Each is independently testable.

| # | Capability | Deterministic? |
|---|---|---|
| A1 | **Eligibility resolver** — two gates: the visit must contain at least one Smart-Report-enabled **package**, and within it only analytes with a numeric value + reference range are scored | 100% rules |
| A2 | **Finding builder** — turn the frozen report snapshot into a normalised finding set (value, unit, range, status, panel, direction) | 100% rules |
| A3 | **Health score + bands** — one number, one sentence, derived only from A2 | 100% formula |
| A4 | **Panel rollup** — per-panel `n normal / n outside range / n not analysed` tiles | 100% rules |
| A5 | **Trend engine** — prior finalized values for the same analyte, delta + direction | 100% query |
| A6 | **Recommendation engine** — findings → curated diet / lifestyle / follow-up-test content from a lab-owned catalog | 100% table lookup |
| A7 | **Language layer (LLM)** — plain-English overview + per-finding explanation, selecting and rephrasing A6 content. Writes *words*, never *facts* | LLM |
| A8 | **Validator** — schema, number-grounding, banned-term, catalog-membership checks; falls back to template copy on failure | 100% rules |
| A9 | **Renderer + delivery** — HTML → PDF, token-gated public URL, patient-portal card, staff preview | Reuses existing pipeline |

A1–A6 and A8 are ordinary code. **A7 is the only LLM in the system.** One call per report.

---

## A2. Which products get a Smart Report

**Smart Reports are a property of the package, not of the visit.** A lab turns them on per
`BillableProduct`, and only for bundles. A one-off Lipid Profile does not produce a Smart Report;
a Master Health Check does. This is the single most important control in the product — it puts the
lab in charge of where the feature applies instead of inferring it per analyte at generation time.

New field: **`BillableProduct.smartReportEnabled Boolean @default(false)`**.

### When the toggle may be switched on

Shown in the product editor **only when the product is a bundle** (`isBundle = true`), and only
enabled when the resolved package passes all of:

| Condition | Why |
|---|---|
| `isBundle = true` | Smart Reports are a package feature |
| `workflowMode = REPORTABLE` | BILL_ONLY / EVENT products produce no results |
| No line resolves to an `EXTERNAL_UPLOAD` product | An uploaded PDF has no structured values — we never re-interpret another centre's report |
| No resolved panel is `TEXT_ONLY` or `IMAGING_NARRATIVE` | Free-text results carry no numeric reference ranges, so there is nothing to score, trend or explain |

Two things deliberately **do not** block:

- **`PROCEDURE_STRUCTURED` is allowed.** Despite sitting next to the narrative layouts in the enum,
  it is *structured*: its rows are ordinary `ClinicalPanelItem` → `TestDefinition` records, exactly
  like `STANDARD_TABLE`, and differ only in how the renderer lays them out. So the per-analyte gate
  already handles it — items with a numeric value and a reference range are scored, the rest are
  listed and not scored. Blocking a whole package because one procedure panel is in it would be wrong.
- **`BILL_ONLY` child lines are allowed** — a sample-collection charge inside a package carries no
  results and simply contributes nothing.

Resolution walks child products recursively — reuse `resolveProducts()` in
`productOrderService.ts`, which already does this (`:100-142`, `:366`). The "this line type is not
allowed in a package" rejection pattern already exists at `billableProducts.ts:481` (EVENT children);
copy it.

When the toggle is disabled, the UI must **say which line is blocking it** — "Contains USG Abdomen
(external upload) and Urine Routine (text-only panel)". A greyed-out switch with no reason is the
thing owners will file a bug about.

### Re-validation, because catalogs get edited

The flag goes stale the moment someone edits a panel inside an enabled package to `TEXT_ONLY`.
So it is checked **twice**:

1. **On save** — of the product, and of any `ClinicalPanel` whose `layoutType` changes. Changing a
   panel to `TEXT_ONLY` or `IMAGING_NARRATIVE` clears `smartReportEnabled` on every package containing it and
   writes an `AuditLog` row, so the owner can see it happened.
2. **At generation** — the real gate. `generateSmartReport` re-resolves the package and skips with
   `skipReason = PACKAGE_NO_LONGER_ELIGIBLE` rather than trusting a possibly-stale flag.

### Scoping at generation time

`TestOrder.productId` records which product was billed, so scope is resolved from the orders, not
from the live catalog:

- Collect the visit's non-cancelled, non-films-only orders whose `productId` points at a bundle with
  `smartReportEnabled = true`. **Those analytes are the report's scope.**
- **No such order ⇒ skip the visit entirely** (`skipReason = NO_SMART_REPORT_PRODUCT`). Most visits
  will hit this, which is the intent.
- **Other tests on the same visit are out of scope, not disqualifying.** A patient who buys a Master
  Health Check *and* a USG still gets a Smart Report for the package; the USG is listed under
  "reported separately, not analysed here". The package defines the scope; extras sit outside it.
- **Two enabled packages on one visit ⇒ one Smart Report** covering the union. One document per
  visit, always.
- Legacy orders with a null `productId` are out of scope.

The per-analyte rules from A2 still apply *inside* the scope — a qualitative result with only
`referenceText` inside a tabular panel is reported but not scored.

## B. User workflow — release to patient

```
staff clicks Finalize  (POST /api/visits/diagnostic/:id/finalize — existing)
  └─ ReportVersion FINALIZED + Visit COMPLETED          (existing, transactional)
  └─ createReportSnapshot + saveReportSnapshot          (existing)
  └─ createAccessToken                                  (existing)
  └─ sendReportReady(visitId, token)  fire-and-forget   (existing)
  └─ generateSmartReport(reportVersionId) fire-and-forget   ◀── NEW, one line
        ├─ load snapshot (already saved, no new queries against live catalog)
        ├─ A1 eligibility → SKIPPED + reason, or continue
        ├─ A2 findings  ├─ A3 score  ├─ A4 rollup  ├─ A5 trends  ├─ A6 content
        ├─ A7 one LLM call (structured output)
        ├─ A8 validate → on failure retry once → on failure use template copy
        └─ persist SmartReport row (READY | FAILED | SKIPPED)
```

Two hard rules:

- **Finalize never blocks on this.** Same fire-and-forget shape as `sendReportReady`
  (`diagnosticVisits.ts:6746`). A crash in generation cannot affect the clinical report.
- **The clinical report is never modified.** Smart Report is a *separate document at a separate
  URL*. We do not prepend it to the merged PDF, do not touch `panelsSnapshot`, do not touch the
  signature blocks. The legal document stays byte-identical.

Patient side, no new WhatsApp template in MVP (Meta approval is a multi-day cycle — see
`project_patient_portal_login_otp`):

```
patient gets the existing lab_report_ready WhatsApp  →  /r/:token (reportGateway)
   └─ existing landing already handles COMPLETED / partial / processing
   └─ NEW: when a READY SmartReport exists, the landing offers two buttons
            [ Your Smart Health Report ]   [ Full lab report (PDF) ]
   └─ if the Smart Report is still PENDING, reuse the existing waitingPage() —
      it already auto-refreshes; the button appears when generation lands.
Patient app (patient-portal): Home gains a Smart Report card per visit;
   DocView renders it with the existing pdf.js viewer (kind = 'smart').
```

Partial releases: a partial finalize produces a Smart Report over *only what has been
released*, and the report says so on the cover ("Covers 3 of 5 tests from this visit; the rest
are still in process"). Re-finalizing the visit regenerates it.

---

## C. Lab / admin workflow

New tab in the existing `AdminConfigCenter` (`/owner/config?tab=smart-reports`), roles
`owner` + `lab_incharge`, matching every other clinical-config tab.

| Control | MVP | Notes |
|---|---|---|
| Smart Reports **on/off** | ✅ | Org master switch. Off = nothing generates. **Both this and the per-package toggle must be on** — see A2. |
| Recommendations on/off | ✅ | Off = report shows results + explanations only, no diet/lifestyle/follow-ups. Some labs will want this for liability. |
| Follow-up tests on/off | ✅ | Separate from the above — this one is a sales surface, some owners want it, some think it looks pushy. |
| Trends on/off | ✅ | |
| Language | ✅ (en only) | Telugu in V1. |
| Accent colour + tagline | ✅ | Everything else (logo, branch name, address, phone, footer) is **already** frozen in `VisitSnapshot` / `resolveFooterLines` — reuse, no new branding system. |
| Custom disclaimer text | ✅ | Default supplied; owner can override. |
| Minimum analysed parameters | ✅ | Default 5. Below this we skip — a Smart Report over 2 analytes is noise. |
| **Minimum patient age** | ✅ | Default 18. Adult calorie and diet formulas are wrong for children, so we skip rather than print them (edge case A1). |
| **Max finding-card pages** | ✅ | Default 3 (18 cards). Prevents a 100-analyte package producing a 20-page document. |
| Model + monthly spend cap | ✅ | `claude-opus-5` default; owner can drop to `claude-haiku-4-5`. Cap halts generation and logs. |
| Section toggles (per page) | V1 | |
| Content-rule editor | V1 | Seeded catalog is code-owned in MVP. |
| Per-branch overrides | V1 | Config row is keyed `branchId String? @unique` — null row = global, exactly the pattern `ReferralCategoryRate` already uses. Per-branch is then a row insert, not a migration. |

Staff-side, per visit (Finalized page + Patient 360 inspector): a status line in the existing
control shape — `Smart Report · Ready` / `Preparing…` / `Not available (no analysable tests)` —
with **Preview** and **Regenerate** (owner + lab_incharge). No chips, no new visual primitives
(`feedback_ui_blend_in`).

---

## D. Data flow

### What Smart Reports reads

**Everything for A2–A4 comes from one row: `ReportVersion.panelsSnapshot` + `patientSnapshot` +
`visitSnapshot`.** That JSON is already frozen at finalize and already contains resolved,
age/sex-specific reference ranges. This is the single most important design decision in the
document — no live catalog lookups, so a later price/range edit can never retroactively change
a patient's Smart Report, and generation is one primary-key read.

| Source | Fields used | Why |
|---|---|---|
| `ReportVersion.panelsSnapshot` | per panel: `displayName`, `layoutType`, `departmentName`; per test: `testCode`, `testName`, `value`, `textValue`, `flag`, `referenceMin/Max`, `referenceText`, `referenceUnit`, `criticalMin/Max`, `subGroup` | the entire clinical payload |
| `ReportVersion.patientSnapshot` | `name`, `title`, `gender`, `ageDisplay`, `patientNumber` | header + age/sex-appropriate copy |
| `ReportVersion.visitSnapshot` | `billNumber`, `branchName`, `branchAddress`, `branchPhone`, `finalizedAt`, `collectedAt` | header, footer, branding |
| `ReportVersion` | `id`, `versionNum`, `finalizedAt`, `status` | identity, immutability |
| `TestOrder` | `workflowMode`, `cancelledAt`, `noReportAt` | eligibility (A1) |
| `TestResult` + `ReportVersion` (prior visits) | `value`, `referenceUnit`, `finalizedAt` for the same `testDefinitionId` | trends (A5) |
| `SmartReportConfig` | all | behaviour |
| `HealthContentRule` | all | recommendations (A6) |
| `BillableProduct` | `code`, `name`, `isActive` | **follow-up suggestions are constrained to tests this lab actually sells** |
| `Visit.patientLinkDisabledAt` | | kill switch already governs every public door |

### What Smart Reports must NOT read

Deliberate exclusions, not omissions:

- **All money** — `Bill`, `priceInPaise`, discounts, `PaymentTransaction`, `OrderRefund`,
  coupons. A health document that knows what you paid is a different, worse product.
- **All payout / referral data** — `ReferralDoctor`, commissions, `DoctorPayoutLedger`. Also
  keeps the LLM from ever being able to leak commercial relationships into patient copy.
- **Referring doctor identity** — not needed, and its absence removes any temptation to write
  "as your doctor suspected…".
- **Staff identity** — `enteredByUserId`, `User`, `AuditLog`, `AnomalyEvent`.
- **Signatures** — `signaturesSnapshot`, `labInchargeSnapshot`. The Smart Report is explicitly
  *not* a signed clinical document and must not carry a doctor's signature. The clinical report
  next to it does.
- **`ExternalReportUpload` contents** — we have a PDF in R2, not values. Listed as
  "included in your report, not analysed here", never interpreted.
- **Patient contact details** — phone/email/Aadhaar are used by the *delivery* layer only and
  never appear in the document body.
- **Other patients' data.** The prompt is built from one report version. There is no corpus,
  no cross-patient statistics, no cohort comparison.

### Data we don't have (and won't fake)

**Height and weight are not captured anywhere in HealthFlow today.** The Health Essentials page
(BMI, energy expenditure, calorie targets, macros) is pure arithmetic off those two numbers, so it
cannot render without them. Since that page is in scope, **MVP must add two optional fields to
registration** (`Patient.heightCm`, `Patient.weightKg` — the only change to an existing table).
When either is missing the page is **omitted entirely**; it is never estimated. Every figure on it
is a published formula, shown here so it can be checked rather than trusted:

| Figure | Formula |
|---|---|
| BMI | `kg / m²`, banded 18.5 / 24.9 / 29.9 |
| BMR | Mifflin-St Jeor: `10w + 6.25h − 5a + 5` (M) / `− 161` (F) |
| Energy expenditure | BMR × 1.2 / 1.55 / 1.725 — **three different numbers** (Flabs printed 2,596 Cal for all three) |
| Water | 35 ml/kg |
| Protein / Carbs / Fat | 0.8–2.0 g/kg · 45–65 % kcal · 20–35 % kcal |
| Fibre | 14 g per 1,000 kcal |
| Calorie goals | maintenance ± 500 kcal |

Smoking, alcohol and activity level are still not captured — so no lifestyle claim is made that the
lab results alone don't support.

---

## E. AI architecture

```
ReportVersion (FINALIZED, immutable snapshot)
      │
      ▼
[A1] eligibility resolver          rules      → analysable / excluded, with reasons
      ▼
[A2] finding builder               rules      → Finding[] {code,name,value,unit,lo,hi,status,direction,panel}
      ▼
[A3] score      [A4] rollup        formula    → score 0-100, band, per-panel counts
      ▼
[A5] trend engine                  SQL        → prior value + delta, unit-matched only
      ▼
[A6] recommendation engine         table join → HealthContentRule[] + follow-up BillableProduct codes
      ▼
──────────── everything above is deterministic and unit-testable ────────────
      ▼
[A7] LLM — ONE call, structured output        → words only: overview, per-finding plain English,
      ▼                                          chosen/rephrased content lines
[A8] validator                     rules      → pass | retry once | fall back to template copy
      ▼
[A9] renderer → HTML → PDF (puppeteer, existing) → Redis cache → token-gated URL
```

### The division of labour, stated as a rule

> **The LLM receives a closed set of facts and may only re-word them. Every number, test name,
> range, status, recommendation and suggested test in the output must already exist in the
> input. The LLM's output is treated as untrusted text until the validator says otherwise.**

**Rules-based:** abnormality detection (reuse the existing `flag` on `TestResult`, plus a
borderline band), eligibility, panel rollups, score, trends, follow-up intervals, which
recommendations apply, which tests may be suggested.

**Calculated:** score, deltas, percentages, counts, coverage.

**Retrieved:** `HealthContentRule` rows by `(testCode, direction)` — a JOIN. **No RAG, no vector
DB, no embeddings.** The knowledge base is a ~60-row table the lab owns, keyed by an exact
identifier we already have. Semantic search over 60 rows keyed by a primary key is not
retrieval, it's a lookup with extra infrastructure. **No agents, no multi-agent, no tool loop** —
there is nothing to decide and nothing to fetch mid-generation; the whole input is assembled
before the call.

**LLM-generated — exactly two outputs, nothing else:**

1. **The Test Score paragraph** on page 01 — 2–3 sentences summarising the counts and the two or
   three things that matter most.
2. **The Health Advisory page** — the diet and lifestyle do/don't lines (chosen from the catalog and
   rephrased in second person) and the one-line reason beside each suggested follow-up test.

Everything else the patient reads is template. In particular, **the per-finding explanations on the
Detailed Test Insights pages are `HealthContentRule.whatItMeans` verbatim** — clinician-authored
once, identical for every patient with that result, never regenerated. That is cheaper, faster,
reviewable, and removes the largest hallucination surface in the product. The two AI blocks are
labelled `✦ AI WRITTEN` in the report so a reader (and a regulator) can see exactly what was
generated.

### Anti-hallucination, in layers

1. **Closed input, and de-identified.** The prompt contains only the resolved findings and the
   pre-selected content rules — there is no "explain anything you know about HbA1c" affordance.
   **It carries no identifiers at all**: not the name, patient number, phone, visit or bill number,
   branch, or referring doctor. The model receives an **age band, sex, and the finding set**, which
   is everything it needs to write the copy. This matters doubly when the provider is overseas —
   enforced by a unit test on the payload builder, not by convention. It also closes the
   prompt-injection path, since no patient free text ever reaches the model.
2. **Catalog gating.** In MVP, a finding with no `HealthContentRule` gets a table row and a
   status — **no LLM explanation at all**. The model cannot free-write about an analyte the lab
   hasn't authored content for. (V1 loosens this to "may describe what the test measures, never
   what the result implies".)
3. **Structured output.** `output_config.format` with a strict JSON schema
   (`@anthropic-ai/sdk` + Zod, `client.messages.parse()`) — shape is guaranteed at the API layer,
   so there is no parsing/retry code to write.
4. **Number grounding.** Post-generation, extract every numeric token from the generated text.
   Each must appear in the input finding set (value, range bound, delta, interval in weeks) or
   be in a small allow-list (dates, "8 glasses", "30 minutes"). Any unmatched number ⇒ reject.
   This alone kills the most dangerous class of hallucination — an invented result.
5. **Banned lexicon.** Reject on: diagnosis nouns (`diabet*`, `cancer`, `anemi*`,
   `hypothyroid*`, `fatty liver`, …), `you have`, `diagnos*`, `prescri*`, `cure`, `stop taking`,
   `dose`/`mg` patterns, drug-name list, and absolute prognosis (`will develop`, `risk of dying`).
   **Deliberate consequence:** an HbA1c of 6.3 is described as *"above the recommended range"*,
   never as *"prediabetes"*. Naming the condition is the doctor's job and is a diagnosis; the
   report's job is to make the patient understand the number and go see someone.
6. **Membership checks.** Every content-line id in the output must be one we supplied; every
   suggested test code must be an active `BillableProduct` at that branch.
7. **Length + count caps** per field, so a runaway generation can't produce a wall of text.
8. **Fallback, never failure.** Validation failure → retry once → on second failure render the
   **template-only** report (deterministic sentences from `HealthContentRule.whatItMeans`). The
   patient always gets a correct, if drier, document. The failure is logged with the offending
   text for review. `SmartReport.validationFailures` keeps the trace.
9. **Patients already under treatment.** HealthFlow holds no medication or condition history, so a
   managed diabetic's HbA1c of 7.5 will read as "above the recommended range" when it is in fact
   their doctor's target. The disclaimer must therefore always carry: *"If you are already being
   treated for a condition, your doctor's targets for you may differ from the general ranges used
   here."* Non-negotiable, and it is the cheapest safety line in the product.
9. **Critical results override everything.** A score of 71 printed beside a critical potassium is
   indefensible. On any `CRITICAL_HIGH` / `CRITICAL_LOW`: page 01 leads with *"One of your results
   needs urgent attention — please contact the centre today"*, **the score is replaced by that
   message**, the card sorts first, and **the advisory page is suppressed**. That patient should be
   phoning the lab, not reading a diet page. See `SMART_REPORTS_EDGE_CASES.md` B11.
11. **Two disclaimers**, always, un-overridable in position: on the cover ("This is an
   explanatory summary generated from your lab results. It is not a diagnosis and does not
   replace your doctor's advice.") and above the advisory section.
12. **Regeneration is idempotent and audited** — a `Regenerate` writes an `AuditLog` row
    (`logAction`, existing).

### Model and cost

TypeScript backend, official SDK — `npm i @anthropic-ai/sdk`. One call:
`client.messages.parse()`, model `claude-opus-5`, `output_config.format` from a Zod schema,
`thinking` left at its default, `max_tokens: 4096`.

Rough per-report token shape: ~1.8k system (frozen, cacheable), ~1.2k findings JSON, ~1.1k out.

| Model | ≈ per report | 120 reports/day |
|---|---|---|
| `claude-opus-5` ($5/$25 per MTok) | ≈ ₹3.7 | ≈ ₹11,000/mo |
| `claude-sonnet-5` ($3/$15) | ≈ ₹1.8 | ≈ ₹6,500/mo |
| `claude-haiku-4-5` ($1/$5) | ≈ ₹0.6 | ≈ ₹2,200/mo |

> **Provider note.** The build targets a **different (Chinese) LLM API**, so the model IDs and the
> table above are illustrative, not prescriptive. What matters and does not change: **one call per
> report, structured JSON output, the de-identified payload (G1), and the validator**. Keep the
> provider behind `SmartReportConfig.model` + a base-URL env var so switching is config, not code —
> and re-measure cost against the real provider before trusting any figure here.
Note prompt caching mostly **won't** help here — reports finalize minutes apart and the default
cache TTL is 5 minutes; the frozen system prompt is worth a `cache_control` breakpoint with
`ttl: "1h"` only if you batch-generate. Track `inputTokens`/`outputTokens`/`costPaise` per row
so the real number is measurable after week one rather than argued about.

---

## F. Report structure (HealthFlow version)

Cover + six numbered pages, matching the reference one-for-one. `✦ AI` marks the two generated blocks.

**Cover.** Logo + tagline, green rule, "Smart" script over **HEALTH REPORT**, `✨ AI Generated`
badge, patient name / sex / age, hexagon photo cluster, lab address, QR to the report link.

**01 — Personalised Health Analysis.** Weight / Height / BMI tiles; the **Test Score** paragraph
`✦ AI`; body figure flanked by panel tiles, each `n Normal / n Abnormal / n Borderline`.
Two fixes to the reference: the score sentence leads with **coverage** ("29 measured, 25 analysed"),
and the tiles are projections of the same finding set as the score, so they can never contradict it
the way the sample does (100 % beside "7 Abnormal"). Panels are deduped by id — the sample printed
Kidney Function Test twice.

**02 — Health Essentials Insights.** Water, sleep, energy expenditure at three activity levels;
macronutrient ranges; calorie targets for loss / gain / maintenance. All deterministic formulas
(table in section D). Rendered only when height and weight exist.

**03–04 — Detailed Test Insights.** One card per finding, worst first: icon, value, unit, status
pill, a range gauge showing where the value sits, the clinician-authored explanation, and an inline
trend when a prior value exists. Findings that move together are merged into one card (haemoglobin +
MCV + PCV), which is both shorter and more honest than three near-identical cards.

**05 — Report Summary.** Score with its arithmetic and the four counts; a this-visit vs last-visit
table for the key numbers; "moving in the right direction" beside "worth discussing with your
doctor". Closes with the not-analysed note (narrative panels, external uploads).

**06 — Health Advisory** `✦ AI`. Suggested Diet and Suggested Lifestyle as themed ✓/✗ blocks, then
Suggested Future Tests with intervals and a reason each — deduped and filtered to tests this lab
actually sells (the sample printed HbA1c twice). Disclaimer.

**No full parameter table anywhere.** The signed laboratory report is where every value lives; the
Smart Report covers what needs attention and says plainly what it did not analyse.

## G. Database

Three new tables. No changes to any existing table in MVP.

```prisma
enum SmartReportStatus { PENDING READY FAILED SKIPPED }

/// One per finalized ReportVersion. Regeneration overwrites in place + writes an AuditLog row.
model SmartReport {
  id                String            @id @default(cuid())
  reportVersionId   String            @unique
  visitId           String
  patientId         String
  branchId          String
  status            SmartReportStatus @default(PENDING)
  skipReason        String?           // NO_SMART_REPORT_PRODUCT | PACKAGE_NO_LONGER_ELIGIBLE |
                                      // NO_ANALYSABLE_TESTS | BELOW_MIN_PARAMETERS | DISABLED | LINK_DISABLED
  language          String            @default("en")

  score             Int?              // 0-100
  scoreBand         String?           // ON_TRACK | MOSTLY_ON_TRACK | NEEDS_WORK | SEE_DOCTOR
  analysedCount     Int               @default(0)
  abnormalCount     Int               @default(0)
  borderlineCount   Int               @default(0)
  notAnalysedCount  Int               @default(0)
  hasCritical       Boolean           @default(false)

  findings          Json?             // A2-A6 output — the deterministic audit record
  content           Json?             // validated LLM output
  usedFallbackCopy  Boolean           @default(false)
  validationFailures Json?

  model             String?
  promptVersion     String?
  inputTokens       Int?
  outputTokens      Int?
  costPaise         Int?
  generationMs      Int?
  configSnapshot    Json?             // so the PDF is reproducible after a config change
  generatedAt       DateTime?
  regeneratedAt     DateTime?
  createdAt         DateTime          @default(now())

  reportVersion ReportVersion @relation(fields: [reportVersionId], references: [id], onDelete: Cascade)

  @@index([visitId])
  @@index([patientId])
  @@index([branchId, createdAt])
  @@index([status])
}

/// Null branchId = the global default. Same shape as ReferralCategoryRate, so per-branch
/// overrides later are a row insert rather than a migration.
model SmartReportConfig {
  id                    String   @id @default(cuid())
  branchId              String?  @unique
  enabled               Boolean  @default(false)
  recommendationsEnabled Boolean @default(true)
  futureTestsEnabled    Boolean  @default(true)
  trendsEnabled         Boolean  @default(true)
  language              String   @default("en")
  accentColor           String   @default("#0F766E")
  tagline               String?
  disclaimerOverride    String?
  minAnalysedParameters Int      @default(5)
  minPatientAgeYears    Int      @default(18)
  maxFindingPages       Int      @default(3)
  model                 String   @default("claude-opus-5")
  monthlyBudgetPaise    Int?
  updatedAt             DateTime @updatedAt
}

/// The curated content catalog — the recommendation engine's whole knowledge base.
model HealthContentRule {
  id                String   @id @default(cuid())
  testCode          String              // matches TestDefinition.code / testCodeSnapshot
  direction         String              // HIGH | LOW | ANY
  severity          String   @default("STANDARD")  // STANDARD | CRITICAL
  title             String              // "Cholesterol is above the recommended range"
  whatItMeans       String              // deterministic fallback copy, also the LLM's factual basis
  dos               Json     @default("[]")
  donts             Json     @default("[]")
  lifestyle         Json     @default("[]")
  suggestedTestCodes Json    @default("[]")  // constrained to active BillableProducts at render
  followUpWeeks     Int?
  displayOrder      Int      @default(0)
  isActive          Boolean  @default(true)
  updatedAt         DateTime @updatedAt

  @@unique([testCode, direction])
  @@index([isActive])
}
```

Edits to existing tables, all additive:

- `BillableProduct.smartReportEnabled Boolean @default(false)` — **the master control** (see A2)
- `ReportVersion.smartReport SmartReport?` — back-relation
- `Patient.heightCm Float?`, `Patient.weightKg Float?` — for the Health Essentials page
- `ClinicalPanel.icon String?` — see below

### Reuse the interpretation engine that already exists

**HealthFlow already has a per-analyte rule engine and I originally specified a duplicate of it.**
Correcting that here.

`InterpretationRule` (keyed by `testDefinitionId`) holds `operator` + `value1`/`value2`/`textMatch`
→ `interpretationText` + `severity`, and `matchInterpretationRule()` in
`reportSnapshotService.ts:659` already evaluates it — numeric `LT/LTE/GT/GTE/EQ/BETWEEN/NOT_BETWEEN`
plus text `MATCH`, first match by `displayOrder` wins. The resolved texts are already frozen into
`ReportVersion.interpretationsSnapshot`.

What this changes:

| | Decision |
|---|---|
| **Trigger logic** | **Do not write a new matcher.** `HealthContentRule` uses the same `(testDefinitionId, operator, value)` shape and the same evaluator. Direction (`HIGH`/`LOW`) stays as a convenience for the common case. |
| **Can we just show `interpretationText` to patients?** | **No.** It is clinician-facing and routinely names conditions — exactly what the banned lexicon exists to prevent. It cannot go on a patient document unedited. |
| **Seeding** | **This is the win.** The existing rules already tell you which analytes this lab bothers to interpret and what it thinks they mean. Converting clinician text → patient text is far faster than authoring from blank, and it inherits clinical intent the lab has already signed off. Seed the catalog from `InterpretationRule` first, then fill gaps from `smart-report-content.csv`. |
| **Card ordering** | `InterpretationRule.severity` (`normal` / `caution` / `critical`) is a ready-made prioritisation signal — use it instead of inventing one. |
| **`ClinicalPanel.interpretation` / `.comments`** | Clinician-authored panel-level HTML already printed on the clinical report. **Not surfaced** in the Smart Report (wrong audience, wrong register), but a second seed source for the writer. |

### Panel → icon mapping

Add **`ClinicalPanel.icon String?`** — set in Report Builder next to `payoutCategory`, holding a
**Health Icons** name (healthicons.org, CC0, built for exactly this). Not emoji: emoji has no liver,
no thyroid and no ultrasound, so the fallbacks end up as a steak, a butterfly and an x-ray on a
medical document. The icon set is ~15 SVGs inlined as `<symbol>`s, tinted per panel — no font
dependency in the PDF container either.

Resolution order: `ClinicalPanel.icon` → the name-match table below → department default → `stethoscope`.

| Panel / department | Health Icon | | Panel / department | Health Icon |
|---|---|---|---|---|
| CBC, Haemogram, Iron | `body/blood-drop` | | Vitamin D, Calcium, Bone | `body/skeleton` |
| Glucose, HbA1c, Diabetes | `devices/diabetes-measure` | | Vitamin B12, Folate | `body/blood-cells` |
| Lipid, Cardiac | `body/heart-organ` | | Urine, Stool | `devices/urine-sample` |
| Liver / LFT | `body/liver` | | USG, X-Ray, CT, MRI | `devices/ultrasound-scanner` |
| Kidney / KFT / RFT | `body/kidneys` | | Culture, Serology | `devices/test-tubes` |
| Thyroid | `body/thyroid` | | Pulmonary / PFT | `body/lungs` |
| *fallback* | `devices/stethoscope` | | | |

The page-01 body figure is Wikimedia's **`Human body silhouette.svg` (public domain)** — a single
path, inlined as vector (~22 KB, no raster asset, scales cleanly in the PDF). Recolour by setting
`fill` on the path; note the source wraps it in a `translate(41.5, 630.92)` layer, so keep that
transform or the figure renders clipped. Health Icons is CC0 and this figure is PD — both safe to
ship, unlike the reference's artwork.

---

## G2. Everything that must be pre-configured before launch

Code is the short pole; **this list is the long one**. Start it on day 1, in parallel with the build.
Two starter sheets are in the repo root, pre-filled with exemplars that set the tone:
`smart-report-content.csv` and `smart-report-panel-icons.csv`.

### 1. Per-analyte content — `HealthContentRule` (the biggest item)

One row per **(test code, direction)**. `smart-report-content.csv` ships 58 analytes → **83 rows**,
11 already written as exemplars, **72 to author**.

Two tiers, so nobody writes diet advice for basophils:

| Tier | Rows | Fields to write | Applies to |
|---|---|---|---|
| **Tier 1** | 53 | `title`, `what_it_means` | Every analyte. This is the sentence under each parameter card. |
| **Tier 2** | 30 | + `diet_do`, `diet_dont`, `lifestyle`, `follow_up_test_codes`, `follow_up_weeks` | Only findings a patient can act on — lipids, sugar, thyroid, vitamin D, iron/Hb, uric acid, liver, calcium |

Rules for `what_it_means`, because the LLM never rewrites it:

- **One or two sentences, ~25 words.** It sits under a value in a card.
- **No numbers.** The value, unit and range are rendered from the data beside it. A number in this
  text will go stale and will trip the validator's number-grounding check.
- **No diagnosis, no drug, no dose.** Explain what the test measures and why it matters — not what
  the patient has.
- **Second person, present tense.** "Haemoglobin is the protein in red blood cells that carries
  oxygen around your body."
- **Direction-specific where it matters.** Low HDL and high LDL need different sentences; use
  `direction = ANY` when one sentence genuinely serves both.

> ⚠️ **`test_code` must match your real `TestDefinition.code` values.** The codes in the sheet are
> plausible guesses. Run the top-analytes SQL in section G first, then reconcile — and drop any row
> for an analyte you don't actually report.

### 2. Panel → icon and patient-facing label

`smart-report-panel-icons.csv`, 16 rows. Per panel: the Health Icon name, a tint colour, and an
emoji alternative if you ever want to switch. Reconcile against your real panels:

```sql
SELECT id, "displayName", "layoutType", "departmentId" FROM "ClinicalPanel"
WHERE "isActive" = true ORDER BY "displayName";
```

Optional but worth it: a **patient-facing panel label**, since some internal names read oddly on a
patient document ("CBP WITH ESR" → "Complete Blood Count"). One nullable column on `ClinicalPanel`.

### 3. Which packages are switched on

Per section A2 — for every bundle you sell, decide on/off. Expect a handful. Blocked packages need
the offending panel fixed or the package split before the toggle can be turned on.

### 4. Follow-up test mapping

Every `follow_up_test_codes` value must resolve to an **active `BillableProduct` code** at that
branch, or the suggestion is dropped silently at render. Worth an explicit reconciliation pass —
this is the one place a content error becomes a missing sales prompt.

### 5. Thresholds and bands (code constants, but decide them once)

| Setting | Proposed |
|---|---|
| Score deductions | **Proportional to deviation.** `R = |value − nearest limit| ÷ limit`; points = `clamp(round(R × 12), 1, 6)`. Borderline (inside, near edge) = 1. Capped at 10 per panel. A 5%-out result costs 1, a 50%-out result costs 6 — a marginally raised semen abnormal-forms no longer costs the same as an LDL of 158. |
| Wording bands | Same `R` drives the label, so they can never disagree: `<10%` → "Slightly high/low" (amber), `10–30%` → "High/Low", `>30%` → "Very high/low". |
| Borderline band | inside the range, within 5% of a boundary |
| Sensitive panels | **No exclusion flag** — decided against. Semen analysis, HIV, tumour markers etc. appear like any other test, relying on the proportional wording to keep mild deviations calm. Accepted risk, revisit if a patient complains. |
| Score bands | 0–49 see your doctor · 50–74 several things to work on · 75–89 mostly on track · 90–100 on track |
| Max finding cards per page | 6 |
| Minimum analysed parameters | 5 |
| Trend window | most recent prior finalized visit, same unit only |

### 6. Static copy (~15 short blocks)

Cover disclaimer · advisory disclaimer · the four score-band sentences · six page titles and
subtitles · the "Did You Know" box · three "reported but not analysed" explanations (text-only
panel, external upload, qualitative result) · four macronutrient card descriptions · water / sleep /
energy descriptions · the calorie-goals paragraph · trend phrasing (`↑ from {value} on {date}`) ·
the two "at a glance" sentence templates.

### 7. AI layer configuration

The system prompt · the JSON output schema · the **banned lexicon** (diagnosis nouns, drug names,
dose patterns, "you have", "diagnos*", "prescri*", "cure", "stop taking", absolute prognosis) ·
the number-grounding allow-list (dates, "8 glasses", "30 minutes") · per-field length caps ·
model + provider + monthly spend cap.

### 8. Branding

Logo (base64), tagline, accent colour, website line, disclaimer override. Branch name, address and
phone already come from `VisitSnapshot` — nothing to configure.

### Effort

Tier 1 is ~53 short sentences; tier 2 adds ~30 richer rows. A clinician plus a writer can realistically
do this in **two or three sittings**, and it must be clinician-reviewed before the toggle goes on
(task T-5). Everything else on this page is an afternoon.

---

## H. APIs

Everything public reuses the existing token door — `validateToken`,
`patientLinkBlockForReportVersion`, the report rate limiters, `trackLinkAccess`. **No new auth
surface.**

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `GET` | `/reports/:token/smart` | public token | Smart Report as HTML (mobile-first) |
| `GET` | `/reports/:token/smart.pdf` | public token | PDF (Redis-cached, new key prefix) |
| `GET` | `/api/visits/diagnostic/:id/smart-report` | staff | status + JSON (drives the staff status line) |
| `GET` | `/api/visits/diagnostic/:id/smart-report/preview` | staff | HTML preview — mirrors the existing `/finalized-report` route |
| `POST` | `/api/visits/diagnostic/:id/smart-report/generate` | owner, lab_incharge | (re)generate; audited |
| `GET` | `/api/portal/reports/:reportVersionId/smart.pdf` | patient cookie | patient-app viewer |
| `GET`/`PUT` | `/api/smart-reports/config` | owner, lab_incharge | config tab |
| `GET`/`POST`/`PUT` | `/api/smart-reports/content-rules` | owner, lab_incharge | V1 |

Internal service surface (`services/smartReport/`):
`resolveEligibility(snapshot, orders, config)` · `buildFindings(snapshot)` ·
`computeScore(findings)` · `buildTrends(patientId, findings)` · `selectContent(findings)` ·
`generateCopy(payload, config)` · `validateCopy(copy, payload, config)` ·
`generateSmartReport(reportVersionId, opts)` · `renderSmartReportHtml(smartReport, profile)`.

Also: `GET /reports/:token` (the existing gateway) gains a Smart Report button when a READY row
exists — a few lines in `reportGateway.ts`, not a new route.

---

## I. Frontend

**Lab admin** — `AdminConfigCenter` gains `{ value: 'smart-reports', label: 'Smart Reports',
icon: Sparkles, roles: ['owner','lab_incharge'] }` and a lazy-loaded `ManageSmartReports` page:
enable toggle, the section switches, language, accent, tagline, disclaimer, model + budget, and
a live preview against a chosen recent visit.

**Report preview (staff)** — reuse the pattern from `ReportViewPage` / the panel-preview route:
server renders the same HTML the PDF uses, staff sees exactly what the patient sees. One
renderer, no divergence (this is the lesson from `report-frame.css` ↔ `report-screen.css`).

**Per-visit control** — Finalized page + Patient 360 inspector get one status line in the
surrounding control shape with Preview / Regenerate. No new visual primitives.

**Patient-facing** — the token landing page button; in the patient app, a Home card per visit
and `DocView` with `kind = 'smart'` (the existing pdf.js viewer + native share needs no change
beyond the URL). HTML view is mobile-first and is the primary experience; the PDF is for
sharing and printing.

**PDF** — `renderSmartReportHtml` → existing `generatePdfFromHtml` in `digital` mode. Assets
inline (base64 logo, inline CSS, QR data-URI) because the pipeline uses
`waitUntil: 'domcontentloaded'` and will render an external `<img>` blank. Cache in Redis with a
new prefix keyed by `smartReportId` + `updatedAt`; regeneration bumps the key.

**Download/share** — same three actions the portal already ships: in-app view, download,
native share of the PDF file.

---

## J. Scope

### MVP — the smallest thing a lab can actually use

- Config: master toggle, recommendations toggle, follow-ups toggle, trends toggle, language
  (en), accent, tagline, disclaimer, min-parameters, model. Global row only.
- A1 eligibility, A2 findings, A3 score, A4 rollup, A6 recommendations from a seeded ~40-row
  catalog, A8 validator with template fallback.
- A5 trends **minimal**: inline "↑ from 5.9 on 12 Feb" on key findings only — one query, no
  charts.
- A7: one LLM call producing **exactly two blocks** — the Test Score paragraph and the Health
  Advisory page. Per-finding explanations are catalog text, not generated.
- `Patient.heightCm` / `weightKg` at registration → unlocks the Health Essentials page.
- Cover + 6 pages. English. Web view + PDF + token route + portal card + gateway button.
- Staff status line, Preview, Regenerate.
- Generation hooked into finalize, fire-and-forget.

Explicitly **not** in MVP: Telugu, sparkline charts, per-branch config, owner-editable content
rules, dedicated WhatsApp template, doctor-facing variant, cross-visit longitudinal report,
and any full parameter table — the signed report already is one.

### V1

Telugu (content catalog gets a `language` column; the LLM translates nothing it wasn't given).
Trend sparklines. Per-branch config. Content-rule editor UI. Dedicated WhatsApp template with its
own deep link. Section toggles. Cost dashboard on the owner page. Combination rules (low Hb + low
MCV → ferritin) — the prototype shows one merged card already, hard-coded.

### Future

Doctor-facing variant with clinical language. Longitudinal "your last 4 visits" report.
Package-aware framing (a Master Health Check reads differently from a single thyroid test).
Copy A/B by outcome (does the patient re-test?). **Multi-tenant HealthFlow packaging** — see
below.

### Keeping the multi-tenant lift mechanical

Everything lives under `services/smartReport/` + `routes/smartReports.ts` + one Prisma block +
one renderer + one admin page. It touches existing code in exactly four places: one line in
finalize, one button in `reportGateway`, one tab in `AdminConfigCenter`, one card in the portal
Home. Config is already keyed by a nullable scope column. When HealthFlow needs it per-tenant,
that's a `tenantId` on two tables and a resolver change — not a rewrite. **We do not build
tenancy infra now** (`feedback_axora_ready_modules`).

---

## K. Worked example

See `smart-report-prototype.html` in the repo root (`open smart-report-prototype.html`) for the
rendered five-page output. The pipeline for that patient:

**Patient** — Mr. Ramesh Kumar, 52 / M, P-04127. Visit D-MPR-04812, Sobhana Diagnostics
(Chintal), finalized 31 Aug 2026. Package: Master Health Check + USG Abdomen (external) +
Urine Routine.

**1. Raw results (29 resulted parameters).** CBC: Hb 12.4 g/dL (13.0–17.0), MCV 76 fL (80–100),
PCV 38 % (40–50), RBC 4.6, WBC 7,200, Platelets 2.1 L — all with resolved ranges.
Glucose: FBS 118 mg/dL (70–100), HbA1c 6.3 % (<5.7). Lipid: Total 232 (<200), LDL 158 (<100),
HDL 38 (>40), TG 210 (<150). LFT: ALT 62 U/L (<50), AST 41, Bilirubin 0.9, ALP 96, Albumin 4.3.
KFT: Creatinine 1.0, Urea 28, Uric acid 6.9 (3.5–7.2). Thyroid: TSH 5.9 µIU/mL (0.4–4.0),
T3 1.1, T4 8.2. Vitamin D 18 ng/mL (30–100). Vitamin B12 310 pg/mL (211–911).
Plus: Urine Routine (`TEXT_ONLY` panel) and USG Abdomen (`EXTERNAL_UPLOAD`).

**2. A1 eligibility.** 25 analysable analytes. Excluded: Urine Routine (narrative panel, no
ranges) and USG Abdomen (uploaded PDF, no structured values) → 4 parameters "reported, not
analysed". 25 ≥ minAnalysedParameters(5) ⇒ proceed.

**3. A2 findings.** 12 outside range (Hb↓ MCV↓ PCV↓ FBS↑ HbA1c↑ TChol↑ LDL↑ HDL↓ TG↑ ALT↑ TSH↑
VitD↓), 1 borderline (uric acid 6.9, inside 3.5–7.2 but within 5 % of the upper limit),
12 within range. No critical breaches.

**4. A3 score.** Start 100; −4 per out-of-range, −1 per borderline, capped at −10 per panel:
CBC 3×4=12→10, Glucose 8, Lipid 4×4=16→10, LFT 4, Thyroid 4, Vit D 4, borderline 1. Total −41.
**Score 59/100, band NEEDS_WORK.** Printed with its own arithmetic beside it, and the panel
tiles are projections of this same set — they cannot disagree.

**5. A5 trends** (prior finalized visit, 12 Feb 2026): HbA1c 5.9→6.3, LDL 141→158, TSH 4.6→5.9,
Hb 12.9→12.4, Vitamin D 16→18. Unit-matched, so deltas render.

**6. A6 recommendations.** Rule hits: `(LDL,HIGH)`, `(TG,HIGH)`, `(HDL,LOW)`, `(HBA1C,HIGH)`,
`(FBS,HIGH)`, `(TSH,HIGH)`, `(VITD,LOW)`, `(HB,LOW)`, `(MCV,LOW)`, `(ALT,HIGH)`.
Follow-ups after dedup and `BillableProduct` filtering: HbA1c (12 wk), Fasting Lipid Profile
(12 wk), TSH + Free T4 (6 wk), Iron Profile / Ferritin (now — from the MCV↓+Hb↓ rule),
Vitamin D 25-OH (12 wk). *Note HbA1c appears once — Flabs printed it twice.*

**7. A7 LLM call.** Input: the 13 findings, the 10 matched rules, patient sex/age band, the
trend deltas, config. Output (abridged):

```json
{ "overview": "Most of your results are in range, but a few need a closer look — your
   cholesterol and triglycerides, your blood sugar, your thyroid hormone level and your
   vitamin D are all outside their reference ranges, and your haemoglobin is slightly low.
   Your HbA1c has moved from 5.9 to 6.3 since February. None of these are emergencies, but
   together they are worth a conversation with your doctor soon.",
  "findings": [
    { "code": "LDL", "headline": "LDL cholesterol is above the recommended range",
      "explanation": "LDL is the cholesterol that can build up in the walls of your blood
        vessels. Yours is 158 mg/dL where under 100 mg/dL is recommended, and it has risen
        from 141 mg/dL in February." },
    { "code": "HBA1C", "headline": "Your three-month average sugar is above range",
      "explanation": "HbA1c reflects your average blood sugar over roughly three months.
        Yours is 6.3 % against a recommended level below 5.7 %, up from 5.9 % in February." }
  ],
  "diet": [ { "ruleId": "…", "text": "…" } ],
  "lifestyle": [ … ]
}
```

**8. A8 validation trace** (a real one — the first attempt failed):

- attempt 1 produced *"This pattern is consistent with prediabetes and early fatty liver."* →
  **rejected** on the banned lexicon (`prediabet*`, `fatty liver`). Regenerated.
- attempt 1 also contained *"…roughly 30 % of men your age."* → **rejected** on number
  grounding: `30` is not in the input finding set. There is no cohort data in the prompt and
  there never will be.
- attempt 2 passed all seven checks. `usedFallbackCopy = false`.

**9. What the patient sees.** Page 2 opens with *"29 parameters were measured. 25 are analysed
below. 4 are descriptive results your doctor will read."*, then `59 / 100 — 12 of 25 analysed
parameters are outside their reference range, 1 is borderline`, then panel tiles that add up to
exactly that. Page 3 gives eight cards worst-first with values, ranges and trend arrows. Page 4
is every number. Page 5 is the do/don't blocks and five deduped follow-ups with intervals.
Nowhere does the document name a disease, suggest a medicine, or predict an outcome.

---

## L. Engineering tasks (MVP)

### Database
- **DB-1** Prisma: `SmartReport`, `SmartReportConfig`, `HealthContentRule`, `SmartReportStatus`,
  back-relation on `ReportVersion`. Hand-written migration (repo convention). *S*
- **DB-2** Seed `SmartReportConfig` global row (`enabled = false`). *XS*
- **DB-4** `Patient.heightCm` / `weightKg` + the two registration inputs + Patient 360 display. *S*
- **DB-3** Run the top-analytes query, author ~40 `HealthContentRule` rows with a clinician
  reviewing the copy, seed script. **Content task — start it on day 1, it is the long pole.** *L*

### Backend
- **BE-1** `smartReport/eligibility.ts` — package gate (A2) + per-analyte rules, from orders +
  snapshot + config. *M*
- **BE-1b** `smartReport/packageEligibility.ts` — shared validator (`isBundle`, `REPORTABLE`, no
  external-upload line, no TEXT_ONLY / IMAGING_NARRATIVE panel) reusing `resolveProducts()`. Returns the
  blocking reasons, not just a boolean — the UI needs them. *S*
- **BE-1c** Enforce on `PUT /api/billable-products/:id`; clear the flag + audit when a panel's
  `layoutType` leaves `STANDARD_TABLE`. *S*
- **BE-2** `smartReport/findings.ts` — A2 + borderline band. Reuse the existing `flag`; do not
  write a second abnormality engine. *M*
- **BE-3** `smartReport/score.ts` — A3 + A4, per-panel cap. *S*
- **BE-4** `smartReport/trends.ts` — prior finalized values by `testDefinitionId`, latest
  version per visit, unit-match guard. One batched query, no N+1. *M*
- **BE-5** `smartReport/content.ts` — A6 join + `BillableProduct` filter + follow-up dedup. *S*
- **BE-6** `smartReport/generate.ts` — orchestrator, persistence, status transitions, budget cap,
  audit on regenerate. *M*
- **BE-7** Hook into finalize + partial-release (2 lines, mirroring `sendReportReady`). *XS*
- **BE-7b** In-process generation queue, concurrency 3 — a 60-visit batch finalize must not
  stampede the LLM provider and fall back to template copy for the whole evening (edge case I1). *S*
- **BE-7c** Regeneration triggers: report amended, order cancelled/refunded, films-only close,
  tests added post-finalize — each must invalidate the row **and** the cached PDF (C2–C5). *S*
- **BE-8** `routes/smartReports.ts` — staff endpoints (status, preview, generate) + config CRUD. *M*
- **BE-9** Public token routes `/reports/:token/smart[.pdf]` reusing `loadReportForToken`. *S*
- **BE-10** Patient-portal endpoint + Home payload field. *S*
- **BE-11** `reportGateway` button when a READY row exists. *XS*

### AI
- **AI-1** Add `@anthropic-ai/sdk`; client wrapper with timeout, 1 retry, structured logging. *S*
- **AI-2** Prompt v1 (system + payload builder) + output schema, two fields only: `testScore`
  paragraph and `advisory` block. *M*
- **AI-3** `validate.ts` — schema, number-grounding, lexicon, membership, caps. **Own unit
  suite; this is the safety-critical file.** *M*
- **AI-4** Template fallback renderer from `HealthContentRule.whatItMeans`. *S*
- **AI-5** Token/cost accounting onto the row + monthly cap check. *S*

### PDF / renderer
- **PDF-1** `smartReportRendererService.ts` — five pages, inline CSS, print + mobile. *L*
- **PDF-2** QR (reuse `reportQrService`) + base64 logo + accent colour. *S*
- **PDF-3** `generatePdfFromHtml` wiring + Redis cache with a new prefix. **Lazy render on first
  request only** — finalize writes a row and must never launch a browser (this codebase has already
  had one Puppeteer OOM on 512 MB). *S*
- **PDF-5** Computed page numbers ("Page N of M"). The page count varies — Health Essentials is
  omitted without height/weight, cards paginate, the advisory is suppressed on a critical result.
  Hardcoded numbers will be wrong the first week (H4). *S*
- **PDF-4** Add `fonts-noto-color-emoji` to the backend Dockerfile, else panel icons render as tofu
  boxes in the PDF. Verify in a rendered PDF, not just the browser. *XS*

### Frontend
- **FE-1** `ManageSmartReports` config page + tab registration. *M*
- **FE-1b** "Enable Smart Report" toggle in `ManageBillableProducts`, bundles only, disabled with
  the blocking reasons listed inline. *S*
- **FE-2** Per-visit status line + Preview + Regenerate on Finalized and Patient 360. *M*
- **FE-3** Patient portal Home card + `DocView` `kind='smart'`. *S*

### Admin / ops
- **OPS-1** `ANTHROPIC_API_KEY` on Render; documented in `.env.example`. *XS*
- **OPS-2** Structured log line per generation (status, ms, tokens, cost, fallback flag). *XS*
- **OPS-3** Owner-page counters: generated / failed / fallback / **skipped by reason** / spend this
  month. Without the per-reason skip counts you cannot tell "correctly skipped" from "silently
  broken". *S*
- **OPS-4** Content-health view: % of abnormal findings that matched a rule, and follow-up test
  codes that resolved to nothing (E2, E3). *S*

### Testing
- **T-1** Golden-file tests for A1–A6: fixture snapshots → expected findings/score/rollup.
  Includes the Flabs bug as a regression test: **assert score and tiles derive from one set.** *M*
- **T-2** Validator suite: invented number, invented test, diagnosis word, drug name, out-of-catalog
  rule id, over-length — each must reject. **Plus a payload test asserting the prompt contains no
  name, patient number, phone, visit number or branch** (G1). *M*
- **T-6** Edge-case suite from `SMART_REPORTS_EDGE_CASES.md`: critical value (score suppressed,
  advisory suppressed), all-normal report, null vs zero result, operator result, one-sided range,
  duplicate analyte across panels, unit change between visits, under-age patient, pregnancy label,
  missing height/weight, erasure cascade. *M*
- **T-3** Eligibility matrix: **non-bundle product, bundle with an external-upload line, bundle with
  a TEXT_ONLY or IMAGING_NARRATIVE panel (blocks); bundle with a PROCEDURE_STRUCTURED panel and one
  with a BILL_ONLY child (both must still pass), enabled package + unrelated USG on the same visit (must still generate, scoped),
  two enabled packages (one report), stale flag after a panel edit**, plus bill-only, films-only,
  cancelled, qualitative result, partial release, below-minimum, link-disabled. *M*
- **T-4** End-to-end on a copy of a real finalized visit → PDF renders, numbers reconcile with
  the clinical report. **Not against prod Neon** (`feedback_neon_prod_quota_testing`). *S*
- **T-5** Clinician review of 20 generated reports before the toggle goes on. **Gate.** *M*

### Deployment
- **D-1** Migration via Render Docker `migrate deploy` on merge to main (agent hands off — see
  `reference_prod_deploy_topology`). *XS*
- **D-2** Ship with `enabled = false`; turn on for one branch, review a week of output, then on. *XS*

Rough order: DB-3 in parallel from day 1 (content is the long pole) → DB-1/2 → BE-1..6 → AI-1..4
→ PDF-1..3 → BE-7..11 → FE-1..3 → T-1..5 → D-1/2.

---

## M. Principle

The clinical report is the source of truth and is never touched. The Smart Report is a
*translation layer* over it: deterministic code decides every fact, the LLM only chooses the
words, and a validator refuses anything the code didn't already know. If the LLM is unavailable,
wrong, or rejected, the patient still receives a correct report — drier, but correct.

The measure of success is not that it looks impressive. It is that a patient reads it, correctly
understands which of their numbers need attention, and books the follow-up.
