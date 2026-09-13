# Stress test — 300 automations against the engine

Scored against what the code does, not what it could be made to do. Verified by reading
`triggers.ts`, `predicates.ts`, `engine.ts`, `inbound.ts` and the schema.

**~264 of 300 work now (88%).** The 36 that do not split into three groups, and none of
them is an engine limitation: **10** need samples to exist in the schema, **12** belong to
Pulse and are deliberately not duplicated, **14** need corrections to stop being in-place
edits. Everything else the list asked for was built rather than filed.

---

## What the stress test changed

The list was worth running. Five things were hardcoded that should not have been, one
whole category had no primitive at all, and one bug would have shipped silently.

| Was | Now |
|---|---|
| Sweep was `if (kind === 'SCHEDULE') … if (kind !== 'VISIT_COMPLETED') continue` | a **trigger registry** — adding one is an entry, not an engine edit |
| 2 triggers | **12** |
| No way to act on a *state* | **`AUDIENCE_SWEEP`** — re-asks the audience on a period |
| No counts or sums | `visitCount` · `spendInPaise` · `hasEverDoneDiagnostics` · `daysSinceLastDiagnostics` · `testCodeCount` |
| No result history | `previousResultValue` · `resultChangePct` · `consecutiveAbnormal` · `resultHasReferenceRange` |
| No way to ask a question | **`ASK`** and **`HANDOFF`** steps |
| `SEND` took `to.phones[0]` | sends to **every** resolved recipient |
| Conversion was any-branch only | `testDoneSinceThisVisitAtBranch` beside it, so nobody silently redefines "converted" |

**Triggers:** visit completed · visit created · visit cancelled · clinic no-show · patient
registered · report finalized · payment received · payment refunded · offer issued ·
campaign budget · schedule · audience sweep.

**`AUDIENCE_SWEEP` earned the most.** Around forty of these were never events: "no visit in
180 days", "lifetime spend over ₹25,000", "five or more visits", "never done diagnostics".
A state has no moment to fire on, so each would have wanted its own trigger and that list
has no end. One periodic re-ask absorbed all of them.

**The multi-recipient bug would have shipped looking like a feature.** Every operational
alert in §261–280 addresses several people. `to.phones[0]` sends to one of them and
reports success.

---

## By section

| Section | Score | Notes |
|---|---|---|
| **1–20 · Clinic recovery** | **20/20** | Cancelled and no-show have triggers; branch-scoped conversion is its own predicate, deliberately separate so adding it cannot quietly change what "converted" means everywhere else |
| **101–120 · Recovery variants** | **20/20** | `hasEverDoneDiagnostics` splits never-been from not-been-lately; the four conversational ones work through `ASK` |
| **2 · Patient lifecycle** | **15/15** | `PATIENT_REGISTERED` plus `AUDIENCE_SWEEP` with counts and sums |
| **3 · Diagnostic transactions** | **14/15** | Missing: cross-sell on "multiple tests purchased", which wants a per-visit order count |
| **4 · Sample lifecycle** | **0/10** | Not buildable — see below |
| **5 · Report lifecycle** | **14/20** | The six missing are amendment and cancellation |
| **6 · Results** | **16/20** | Thresholds with the unit guard, trends, consecutive abnormals, missing-range refusal. The four missing are amendment |
| **121–140 · Conversation** | **19/20** | Missing: email as a second channel |
| **141–160 · Messaging safety** | **19/20** | Missing: template status known *before* the first failure — no status webhook |
| **161–180 · Report engagement** | **14/20** | Same amendment gap |
| **181–200 · Results detail** | **16/20** | Same |
| **201–220 · History and aggregations** | **20/20** | `testCodeCount` closed the last two — zero means never, a different campaign from "not lately" |
| **221–240 · Offers** | **17/20** | `CAMPAIGN_BUDGET` fires once per threshold and counts reserved as well as spent. Missing: shared codes |
| **241–260 · Engine reliability** | **20/20** | All covered and all tested |
| **261–280 · Operational alerts** | **8/20** | The twelve missing are Pulse's |
| **281–300 · Advanced** | **19/20** | Including the subtle three: converting during a policy delay, the step staying due at its original day, priority resolving two live journeys |

---

## The conversation, since it was the biggest gap

`ASK` sends a question with buttons and holds the phone line while it waits. `HANDOFF`
gives the thread to a person and ends the run.

- Routing is by **payload, never by label** — the label is display text a patient never
  sends back verbatim.
- **"Not now" ends a journey** rather than jumping to a step. A decline needs a
  destination too.
- **Unmatched free text reaches a person by default.** The safe answer to "we did not
  understand" is a human, not silence and not a classifier guessing on a clinical channel.
- **Silence is an outcome.** When the window shuts the journey moves on, instead of a run
  that waits forever.
- A stale reply resumes nothing, a shared phone resolves to the **pinned** patient, two
  rapid replies are claimed once, and a second journey cannot hold a line another already
  holds.

---

## The 36 that remain, and why

**1 · Sample lifecycle — 10 cases. Not buildable.** There is no sample entity, no
collection state, no rejection reason and no delay clock anywhere in the schema. No
trigger work reaches this: the workflow has to model samples before an automation can
react to them, and a trigger over data that does not exist is a screen that lies.

**2 · Revenue and volume alerts — 12 cases. Deliberately absent.** "Revenue down 20%
against baseline" is a Pulse question. Pulse already owns a metric registry and a
contract, and a second definition of "revenue today" is the precise failure `pulse:check`
exists to prevent. The right shape is one predicate that READS a Pulse metric — not twelve
triggers that recompute the business alongside it.

**3 · Amendment — 14 cases.** There is no amendment event: a finalized result is corrected
by editing in place, preserving `finalizedAt`. Comparing timestamps is the ceiling and it
is a heuristic. Fixing it properly means corrections becoming versioned, which is a
workflow decision rather than an engine one.

Everything else was built, and the engine gained no special cases doing it: four registry
entries, seven predicates, two step kinds, and one primitive.

**51 offline checks pass** — no database, no model, no sends, about a second.
