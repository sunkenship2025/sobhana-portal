# Smart Reports — self-audit and recommendations

Two parts: **what my own study was missing**, then **everything I'd suggest**. The gaps are listed
honestly, including the one where I specified a duplicate of a system that already exists.

---

# Part 1 — What was missing

## Fixed in this pass

| # | Gap | Severity | Now |
|---|---|---|---|
| 1 | **I designed a duplicate of the interpretation engine HealthFlow already has.** `InterpretationRule` + `matchInterpretationRule()` (`reportSnapshotService.ts:659`) already does numeric operators and text matching, and its output is already frozen into `interpretationsSnapshot`. I specified `HealthContentRule` from scratch with the same trigger shape. | **High** — wasted build, and I missed a free seed source | Plan section G now says: reuse the matcher, don't show `interpretationText` to patients (it names conditions), **seed the catalog from the existing rules**, and use `InterpretationRule.severity` for card ordering instead of inventing a priority scheme. |
| 2 | **The system prompt was never written.** It was listed as task AI-2 and left blank — but the prompt, schema and lexicon *are* the safety design. Everything else is scaffolding around them. | **High** | `SMART_REPORTS_AI_SPEC.md` — the actual prompt, output schema, seven validator checks, the enumerated lexicon, TypeScript payload types, and the worked example with two real rejections. |
| 3 | **The banned lexicon was described, never enumerated.** "Diagnosis nouns, drug names" is not implementable. | Medium | ~60 terms in five categories, including one I'd missed entirely: **false reassurance** ("nothing to worry about", "no need to see a doctor") is as dangerous as false alarm. |
| 4 | **No content-catalog `language` column.** Adding it after 83 rows are authored in English means a migration plus re-keying every row. | Medium | Added now, populated `en`. Costs nothing today. |
| 5 | **No TypeScript contract** for `Finding` / `ContentLine` / `SmartReportPayload`. A dev would have invented their own and the de-identification guarantee would drift. | Medium | In the AI spec, with the absent-fields list beside it. |
| 6 | **Patients already under treatment.** A managed diabetic's HbA1c of 7.5 is *their doctor's target*, not a finding. Telling them it's "above the recommended range" and to avoid sweets is at best patronising. HealthFlow holds no medication or condition history, so the report cannot know. | **High** — affects a large share of repeat patients | Disclaimer line added: *"If you are already being treated for a condition, your doctor's targets for you may differ from the general ranges used here."* |

## Found, deliberately left open

| # | Gap | Why it's a decision, not an oversight |
|---|---|---|
| 7 | **No human-in-the-loop option.** I assumed auto-send from day one. Most labs will want to read the first fifty. | Needs your call — see suggestion S2. |
| 8 | **`SmartReport` is overwrite-on-regenerate.** If advice changed between versions and a patient disputes what they were told, there's no record of what they actually saw. | Append-only is cheap now and impossible to retrofit — S4. |
| 9 | **No success metric.** Nothing measures whether patients open it or whether it drives re-tests. That is the entire ROI case and I never specified how to observe it. | S7–S9. |
| 10 | **No print path.** Digital only — but patients collect reports at the counter. Nobody decided what the front desk hands over. | S6. |
| 11 | **Score comparability over time.** If a later visit uses a different package, comparing scores is misleading (different denominator). Nobody would notice until someone builds a score graph. | S13 — guard it before it's built, not after. |
| 12 | **Collides with the abnormal-recall WhatsApp campaign.** Smart Reports suggest re-tests; the recall campaign nudges the same patients. Real people get two prompts for the same test. | S14. |
| 13 | **Body text is ~11px in the PDF.** Fine for the prototype's 52-year-old, poor for a 70-year-old. | S5. |
| 14 | **No alerting**, only counters. A provider outage degrades every report to template copy silently. | S12. |
| 15 | **No dry-run harness.** "Review a week of output" is not an operational instruction. | S3 — the single highest-value suggestion here. |
| 16 | **Front desk isn't briefed.** The report ends with "call us on…". Someone has to answer, and know what the score means. | S15. |
| 17 | **No business model.** Paid add-on, bundled, or a HealthFlow sales differentiator? Decides packaging. | S17. |
| 18 | **Content has no provenance.** Some labs want a source for dietary claims. | S16. |

---

# Part 2 — Recommendations

Ordered by what I'd actually do first.

## Before you write code

**S1 — Seed the catalog from `InterpretationRule` before touching `smart-report-content.csv`.**
Export the lab's existing rules, put them beside my draft, and have the writer convert clinician
text → patient text. Faster than authoring blind, and it inherits clinical intent the lab already
signed off. My 83 rows then fill the gaps rather than being the source of truth.

**S2 — Ship with a review gate, not auto-send.** Add `reviewMode` to the config:
`ALWAYS_REVIEW` → `REVIEW_FIRST_N` → `AUTO`. Start at always-review, watch fifty reports, then
relax. Retrofitting a review queue after a bad report has gone to a patient is a much worse day
than building it now. It is roughly a status column and one worklist screen.

**S3 — Build the dry-run harness before the delivery routes.** A command that generates against
the last 50 real finalized visits and writes HTML to disk, with no patient delivery. This is what
makes the clinician review gate (T-5) real, it's how you find the content gaps, and it's how you
tune the score without a single patient seeing anything. **Highest value item on this page.**

**S4 — Make `SmartReport` append-only.** `@@unique([reportVersionId, version])`, exactly like
`ReportVersion`. Regeneration writes v2 and the patient link resolves to the latest. Cheap now,
impossible later, and it's the difference between having and not having an answer in a dispute.

## Product shape

**S5 — Raise the base font.** 12–13px body in the PDF, not 11. Your patients skew older than the
prototype's 52-year-old, and this is a document people read on a phone in poor light.

**S6 — Decide the counter path.** Either the Smart Report prints on plain paper alongside the
clinical report, or the front desk shows the QR. Pick one and tell the staff, or they'll improvise.

**S7 — Instrument before launch, not after.** `LinkAccessLog` already exists — record *which*
document was opened. Without it you cannot answer the only question that matters in month two.

**S8 — Define success now.** I'd propose: (a) Smart Report open rate vs clinical report open rate,
(b) re-test conversion within 4 months for a suggested follow-up, (c) front-desk call volume. Write
the targets down before launch so the result isn't argued about afterwards.

**S9 — Run it as an A/B for the first month.** Half the eligible packages get Smart Reports, half
don't. Compare re-test conversion. That single number is the business case for rolling it across
HealthFlow, and you only get it if you withhold deliberately at the start.

## Risk and correctness

**S10 — Make the score toggleable, and consider shipping without it.** The score is the most
eye-catching and the most contestable element. It is also the least necessary — the report works
without it. If a clinician is uneasy in review, you want a switch, not a code change.

**S11 — Reconsider the Health Essentials page for MVP.** It is the only page not derived from lab
results — BMI arithmetic that needs two new registration fields and reads generic. Everything else
is grounded in the patient's own numbers. If you want a smaller, sharper v1, that's the page to cut.
(You asked to match the reference, so it stays unless you say otherwise.)

**S12 — Alert on fallback rate.** If more than ~10% of a day's reports used template copy, someone
should know that evening. Silent degradation for a week is the realistic failure mode.

**S13 — Guard score comparability now.** Only compare scores across visits when the package is the
same; otherwise show per-analyte trends only. Write it into the trend engine before anyone builds a
score chart.

**S14 — Reconcile with the abnormal-recall campaign.** Suppress recall messages for a test the
patient's Smart Report already flagged within the last N weeks, or the same patient gets two
different nudges for the same re-test.

**S15 — Brief the front desk.** One page: what the score is, what it isn't, what to say when a
patient calls worried, and when to escalate to the lab incharge. The report generates the call; the
counter has to handle it.

**S16 — Decide on provenance.** If you want sources for dietary advice, add a `source` column to
the catalog now while it's being authored, not after.

## Beyond MVP — where the value actually compounds

**S17 — This is a HealthFlow sales asset, not just a Sobhana feature.** No independent diagnostic
centre in Hyderabad is producing anything like this. Decide early whether it is bundled (a
differentiator that closes deals) or a paid add-on (revenue but slower adoption). It changes how the
per-tenant toggle is built.

**S18 — The trend section is the real product for repeat customers.** For an annual health check,
"here is what moved since last year" is more valuable than anything else on the page. Once two years
of data exist, a longitudinal report is a stronger product than the single-visit one.

**S19 — A doctor-facing variant is a referral driver.** Referring doctors already receive the
clinical report. A concise summary addressed to them — clinical register, no patient hand-holding —
is cheap to add once the finding engine exists, and referral doctors are how a diagnostic centre
grows.

**S20 — The follow-up block is the monetisation, and it's clinically honest.** Every suggestion is
tied to a specific abnormal result and constrained to tests you actually sell. Measure conversion on
it (S8b); if it works, it justifies the whole feature commercially without anyone having to argue
about "AI value".

---

## The three still waiting on you

Unchanged from the handover, and everything above is downstream of them:

1. **The score formula** — 100 − 4/abnormal − 1/borderline, capped −10 per panel. Example patient scores 59.
2. **Never naming a condition** — safe and defensible; some owners will want more explicit language.
3. **The catalog gate** — no rule ⇒ no explanation. Maximally safe, thin until the catalog fills.
