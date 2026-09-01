# Smart Reports — edge-case register

Every case below has a **decision**, not a shrug. If a reviewer asks "what happens when…", the
answer is here. Anything genuinely deferred is marked **V1** or **OPEN** with a reason.

Companion to `SMART_REPORTS_PLAN.md`.

---

## A. Patient & demographics

| # | Case | Decision |
|---|---|---|
| A1 | **Paediatric patient.** Adult calorie/macro formulas and adult diet advice are wrong, sometimes harmful, for a child. | **Skip below a configurable minimum age (default 18)**, `skipReason = PATIENT_BELOW_MIN_AGE`. Not a silent bad report — no report. |
| A2 | **Pregnant patient.** Reference ranges differ (`RangeCategory.OTHER` + `categoryLabel` "Pregnant") and lifestyle advice can be actively wrong. HealthFlow has **no pregnancy flag**. | If any resolved range's `categoryLabel` matches `/pregnan/i`, **suppress the advisory page** and print "your ranges were interpreted for pregnancy — please discuss these with your doctor". **V1:** capture a pregnancy flag at registration and skip properly. |
| A3 | **Gender = `O`.** Gendered ranges may not resolve, and copy that says "for adult men" is wrong. | Range resolution already falls back to gender-null rows. **Content rule: `what_it_means` never contains a gendered phrase** — the range is rendered separately from the sentence. Linted in the seed script. |
| A4 | **Very long patient name** overflows the cover. | Two-line clamp with ellipsis; the strip on inner pages truncates at one line. |
| A5 | **Patient with no phone.** No WhatsApp, and the portal logs in by phone OTP. | Report still generates; reachable only via the printed QR. Not an error. |
| A6 | **Infant ages** stored in `DAYS`/`MONTHS` (`Patient.ageUnit`). | Covered by A1 — those patients are below the age gate. |

## B. Result data shape

| # | Case | Decision |
|---|---|---|
| B1 | Result has `textValue` only — "Negative", "Trace", "2-3 /hpf" — inside a tabular or PROCEDURE_STRUCTURED panel. | **Three buckets, not two.** *Scored* = numeric value + numeric range. *Shown, not scored* = has a value but no numeric range → its own **"Results reported in words"** section, printing the result beside `referenceText` ("usually expected"), no status pill, no score contribution. *Referred to only* = free-prose panels and external PDFs → the separate note. `computeFlag` is numeric-only and `matchInterpretationRule` can't be trusted to classify these, so **we show them and never judge them** — printing `15-20 /hpf` beside `0-5 /hpf` lets the patient see it without us parsing a string we can't parse safely. Burying urine chemistry in a footnote would hide a genuinely abnormal result. |
| B2 | Result has **both** `value` and `textValue`. | Score on `value`; display `textValue` in the card if present. |
| B3 | `value` is null — test not resulted. | Excluded from **all** counts. **Never counted as normal** — that's the Flabs bug in a different costume. |
| B4 | Operator results — `"<0.1"`, `">1000"` — stored as text. | Not scored, listed. **Do not parse the operator**; a parsed `<0.1` scored as 0.1 is a fabricated value. |
| B5 | `referenceText` only (e.g. "Negative"), no numeric range. | Not scored. |
| B6 | Value is `0` or negative. | Valid. Must not be treated as missing — guard against truthiness bugs (`if (!value)`). |
| B7 | **Derived parameters** (`formulaExpression`, e.g. A/G ratio). | Treated identically once resulted — they carry ranges. Already in the catalog. |
| B8 | **Same analyte in two panels** on one visit (glucose in two packages). | Dedupe by `testDefinitionId`; keep the first by panel `displayOrder`. Counting it twice would inflate both the score and the totals. |
| B9 | Panel with **subGroups** (CBC MAIN / DIFFERENTIAL / SMEAR). | Flattened for scoring. SMEAR rows are text, so B1 excludes them naturally. |
| B10 | **One-sided reference range** (`< 100`, `> 40`) — the gauge has no opposite bound. | Gauge renders a **two-zone** track instead of three, marker positioned within the bounded side. Explicitly designed, not a fallback. |
| B11 | **Critical value** (`CRITICAL_HIGH` / `CRITICAL_LOW`). | **The most important case in this document.** A score of 71 printed beside a critical potassium is indefensible. On any critical result: page 01 leads with a red *"One of your results needs urgent attention — please contact the centre today"* banner, that card sorts first, **the score is replaced by that message**, and **the advisory page is suppressed entirely**. `SmartReport.hasCritical = true`. A patient with a critical result should be phoning the lab, not reading a diet page. |
| B12 | **Every analyte normal.** | Dedicated all-normal Test Score copy and a maintenance-only advisory. Must not read as a stub — this is the most common outcome for a healthy patient and it is a *product surface*, not an empty state. |
| B13 | **Every analyte abnormal**, or a 100+ analyte package. | Cards paginate at 6/page, capped at 3 pages (config); the remainder is summarised as a count line. The LLM prompt only ever contains findings, never the normals, so prompt size is bounded. |

## C. Visit lifecycle

| # | Case | Decision |
|---|---|---|
| C1 | **Partial release, then final release.** | One `SmartReport` per `ReportVersion`. The patient always sees the **latest finalized version**, matching the existing token behaviour. Earlier rows are kept for audit. |
| C2 | **Report amended after finalize** (the correction path). | Regenerate **and invalidate the PDF cache** — the cache key includes `smartReportId + updatedAt`. A stale cached PDF after a correction is a patient-safety bug, not a performance bug. |
| C3 | **Test cancelled or refunded after generation.** | Cancellation triggers regeneration. Otherwise the report explains a test the patient no longer has. |
| C4 | **Films-only close after generation.** | Same as C3. |
| C5 | **Tests added to a billed visit** after the fact. | Regenerate on the next finalize. |
| C6 | **Visit cancelled**, or `patientLinkDisabledAt` set. | Every public door already closes via `patientLinkBlockForReportVersion`; the Smart Report inherits it because it reuses `loadReportForToken`. |
| C7 | **Duplicate visit** from a double-submit. | Two visits, two reports. The existing duplicate guard is the fix; not Smart Reports' problem, but noted so it isn't mistaken for a Smart Reports bug. |

## D. Trends

| # | Case | Decision |
|---|---|---|
| D1 | Prior value exists in a **different unit**. | No delta. Show both values with a note. Never convert. |
| D2 | Prior value's **reference range changed** (versioned `TestDefinition`). | Show the values, but **do not claim improvement or worsening** against a moved goalpost. |
| D3 | **Two visits on the same day.** | Pick the later `finalizedAt`; tie-break on higher `versionNum`. |
| D4 | **No prior visit.** | Omit the trend table entirely. Do not render an empty table with a "no data" row. |
| D5 | **Direction vs. good/bad.** Rising HDL is good; rising LDL is not. | The arrow shows **direction only** and is never coloured as good/bad. Stated in a footnote on the page. |
| D6 | Prior value came from a partial release. | Valid, use it. |

## E. Content & catalog

| # | Case | Decision |
|---|---|---|
| E1 | Finding has **no `HealthContentRule`**. | Row + value + status, **no explanation**. Safe by construction. |
| E2 | **Most** findings have no rule — the report feels empty. | Coverage guard: if under 50% of a report's abnormal findings matched a rule, log a warning and surface it in the admin content-health view. Silence here is how a thin report ships for months. |
| E3 | A rule suggests a test the lab **doesn't sell**. | Dropped at render, and **logged** — a silently missing follow-up is a lost re-test. |
| E4 | An author puts a **number in `what_it_means`**. | Seed-script lint rejects digits in that column. The number would go stale and would trip the AI validator's grounding check. |
| E5 | **Duplicate follow-up tests** from several rules. | Dedupe by test code, keep the **shortest** interval. (The reference sample printed HbA1c twice.) |
| E6 | **Conflicting advice** from two rules ("include calcium" + "avoid calcium supplements"). | Dedupe by rule id; cap diet lines at 6. Genuine conflicts are a content problem, caught in the clinician review gate (T-5). |

## F. AI failure modes

| # | Case | Decision |
|---|---|---|
| F1 | Timeout, 5xx, or rate limit. | Retry once, then **template copy**. The report always ships. |
| F2 | Valid JSON, **empty strings**. | Treated as failure → template copy. |
| F3 | Invents a number. | Number-grounding validator rejects. |
| F4 | Names a condition ("prediabetes"). | Banned-lexicon validator rejects. |
| F5 | Replies in the wrong language. | Language check rejects. |
| F6 | **Provider outage for hours.** | Every report that day ships with template copy. A backfill job can regenerate later; `usedFallbackCopy` marks them. |
| F7 | **Monthly spend cap reached.** | Generation continues **with template copy** — it does not skip. A drier report beats no report. |
| F8 | **Prompt injection via patient data** — a patient named *"Ignore previous instructions"*, or a free-text note. | **No patient free-text ever enters the prompt.** The system prompt is frozen; all patient data goes in one user-content JSON block explicitly labelled as data. See G1 — the name isn't sent at all. |

## G. Privacy & compliance

| # | Case | Decision |
|---|---|---|
| G1 | **Health data sent to a third-party LLM**, hosted overseas. | **The prompt carries no identifiers.** Not the name, patient number, phone, visit/bill number, branch, or doctor — the model needs none of them to write the copy. It receives an **age band, sex, and the finding set**. This is a hard requirement, enforced by a unit test on the payload builder, not a convention. |
| G2 | **DPDP Act (India)** — automated processing of health data. | Registration consent text should name automated summarisation; the report carries the disclaimer. **Flagged for your legal review — I'm not giving you a legal opinion, I'm telling you it needs one before launch.** |
| G3 | **Patient erasure request.** | `SmartReport` cascades from `ReportVersion` → `Visit`, so it deletes with the visit. Verify the cascade explicitly in a test; a stranded row holding findings JSON is a breach. |
| G4 | Patient forwards the PDF on WhatsApp. | Expected. The document identifies itself and carries the disclaimer. No action. |

## H. Rendering & delivery

| # | Case | Decision |
|---|---|---|
| H1 | **Puppeteer OOM on 512 MB Render** — this has already happened once in this codebase. | Smart Report PDFs are **never rendered eagerly at finalize**. Lazy render on first request, through the existing `withPdfSlot` concurrency limiter, cached in Redis. Generation at finalize writes a row; it does not launch a browser. |
| H2 | **External asset** in the HTML. | The pipeline uses `waitUntil: 'domcontentloaded'`, so an external `<img>` renders **blank**. All assets inlined: SVG icons, SVG body figure, base64 logo, data-URI QR. |
| H3 | **Redis down.** | Cache miss → render live. Must not 500. |
| H4 | **Page count varies** — Health Essentials omitted without height/weight, cards paginate, advisory suppressed on a critical. | **Page numbers are computed, never hardcoded.** Footer reads "Page N of M". The prototype hardcodes `01`–`06`; the renderer must not. |
| H5 | **Black-and-white printing** and **colour-blind readers**. | Status is carried by **text** ("High" / "Low" / "Borderline"), not hue; the reference range is printed under every gauge. No information is colour-only. |
| H6 | Long test names overflow a card. | Two-line clamp. |
| H7 | Patient opens the link **before generation finishes**. | Existing `waitingPage()` — already auto-refreshes. |
| H8 | Generation **failed**. | The Smart Report button simply doesn't appear; the patient gets the normal report and is never shown an error about a feature they didn't ask for. |

## I. Operations

| # | Case | Decision |
|---|---|---|
| I1 | **Batch finalize** — 60 reports at 6pm → 60 concurrent LLM calls. | In-process queue, concurrency 3, with retry. Without this the first busy evening rate-limits the provider and every report falls back to template copy. |
| I2 | **Backfill** for historical visits. | Opt-in script, never automatic. Old visits' patients did not expect a new document. |
| I3 | **Monitoring from day one.** | Counters for generated / failed / fallback / skipped-by-reason, p95 generation latency, spend to date. Without `skipReason` counts you cannot tell "correctly skipped" from "silently broken". |
| I4 | **Feature flag turned off** after reports exist. | Off = no new generation **and** existing Smart Reports hidden from patients. One switch, one meaning. |

---

## Deliberately open

| Item | Why it's open |
|---|---|
| Pregnancy flag at registration | Needs a registration-form change and a clinical decision on which ranges apply. A2 degrades safely until then. |
| Telugu | Content catalog needs a `language` column and a translator. The LLM must never translate content it wasn't given. |
| DPDP consent wording | Legal, not engineering. |
| Doctor-facing variant | Different audience, different copy, different disclaimer. Not MVP. |
