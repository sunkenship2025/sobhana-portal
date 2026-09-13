# Round 2 — disposition of 25 points

Verdict on each, with **V1 / V2 / Future / No** and the *primitive* that changes, not the feature.
Where a point is already built, the file that builds it is named — three of these are more complete
than the locked spec credited, and two are places the locked spec was **wrong**.

---

## First: two corrections to my own spec

**C1 — `TestResultFlag` already has critical values.** The review said `{NORMAL|HIGH|LOW}`. It is
`NORMAL | HIGH | LOW | CRITICAL_HIGH | CRITICAL_LOW` (`schema.prisma:95`). So "a critical value never
routes through an automation" is implementable today from the flag — it was written into the spec as
a rule that nothing could enforce.

**C2 — `Coupon.patientId` is not checked at redemption.** `validateCouponByCode` rejects on
NOT_FOUND / ALREADY_REDEEMED / EXPIRED / VOID / CAMPAIGN_INACTIVE and **never compares the patient**
(`couponService.ts:173`). "Unique coupon per patient" is decorative today — any code works for
anyone holding it. Your point 12 is not a future hardening, it is a live hole.

---

## The clinical interface already exists, and it is better than what I specified

Point 1 is the biggest item and the answer is not "define an interface". It is already defined:

| Thing | Where |
|---|---|
| Numeric value, text value, flag | `TestResult.value / textValue / flag` |
| Reference range resolved **per patient** (age in days, gender, category) | `TestDefinitionRange` + `resolveByTestDefinition()` (`referenceRangeService.ts:229`) |
| Units | `TestDefinitionRange.referenceUnit`, `TestDefinition.referenceUnit` |
| Critical bounds, clinician-set | `TestDefinitionRange.criticalMin / criticalMax` |
| The rule that an un-bounded test may never be called critical | `smartReport/findings.ts:36` — already argued, already enforced |

So the automation engine's clinical predicate is a **thin projection over a resolver that already
exists**, and Smart Reports is the proof it works:

```
resultOf(testOrderId, testCode) → {
  value, textValue, flag,                  // TestResult
  referenceMin, referenceMax, referenceUnit,
  criticalMin, criticalMax,                // resolveByTestDefinition(), age/gender resolved
  finalizedAt, reportVersionId
}
```

**The one rule that makes numeric thresholds safe:** a condition stores the unit it was authored
against, and a run **fails loudly** if the resolved unit differs. `HbA1c > 7` is true in % and
absurd in mmol/mol, and nothing in the number says which. Without this, a catalog edit silently
inverts every threshold in every campaign. This is the only clinical safety rule the engine owns;
everything else stays with the clinicians.

> **1 — Result triggers.** Interface: **V1** (write it down, it costs nothing, it is the contract).
> Result-triggered automations: **V2**, as scoped. Threshold conditions are allowed because the
> engine compares a number to a number — it never decides what "abnormal" means.

---

## The rest, in order

**2 — Event model / correlation scope. Partly already · naming is V1 · an Event table is No.**

`run.subjectType / subjectId` **is** the correlation scope, and it is frozen at enrolment. What was
missing is the discipline: **every predicate takes an explicit scope argument, and a patient-scoped
predicate may not be used where a visit-scoped one exists.** Name the vocabulary — `PATIENT`,
`VISIT`, `TEST_ORDER`, `REPORT_VERSION`, `COUPON`, `RUN` — and the accident you are worried about
(checking all diagnostics instead of this visit's) becomes a type error rather than a code review.

An `Event` table is a second write on every visit completion on a 512MB box with an OOM history, and
it buys replay that nobody asked for. Instead, one change removes the reason you want it:

> **Triggers are a sweep. Hooks are latency.**

The ticker already asks "what is due?". It also asks "what is newly eligible and not yet enrolled?",
bounded by `LIMIT`. The in-request hook stays, as an optimisation. Because enrolment is idempotent on
`(automationId, subjectId, cycleKey)`, a dropped hook, a duplicated hook and a crashed request all
converge to exactly one run. That answers lost triggers, duplicate events and most of point 5 with a
query instead of a table.

**3 — Enrolment is entity + trigger event. Already — needed the sentence.**
`@@unique([automationId, subjectId, cycleKey])` with `subjectId = visitId` is precisely
"one enrolment per visit". Three visits, three runs. Now stated in the spec.

**4 — Re-entry rules. V1.** `cycleKey` already covers all of them; what was missing is that it was
computed in code instead of declared. Add `definition.reentry = { mode, days? }` with
`PER_EVENT | ONCE | EVERY_N_DAYS | WHILE_ELIGIBLE`, compiled to a cycleKey. **It was also missing
from the builder screen** — a real wireframe gap, now fixed.

**5 — Conversation first-class. Already — and one part of the proposal is wrong.**
`Conversation` exists (`schema.prisma:1387`), keyed `phone @unique`, with `assignedToId`, `status`,
`lastInboundAt`, and `ConversationMessage.waMessageId @unique` for retry-safety.

Do **not** put `automation_run_id` on `Conversation`. One phone carries many patients (your own
`PatientIdentifier` comment) and many runs. A run pointer on the thread is wrong the moment a family
shares a number — which is the normal case here, not the edge case. The chain is:

```
Conversation (phone)  ──<  ConversationMessage
        │
   AwaitingReply (phone UNIQUE, patientId PINNED at send)  ──  AutomationRun  ──  Patient
```

`AwaitingReply` is where "which automation is speaking" lives, and its single unique index is what
forbids two automations holding one line. `channel` and `provider_conversation_id`: **Future** — one
channel exists, and a column for a second is speculation.

**6 — Handoff needs a real state. V1 for the rule, Future for the SLA.**
The missing decision is not the fields, it is: **handoff suppresses MARKETING, never service.** A
report-ready message must still reach a patient while staff are mid-conversation. That is one line in
the resolver using `templateCategory`, which the spec already records per send. Add `assignedAt` and
`handoffReason`; assignment and OPEN/CLOSED already exist. Teams, SLAs and resolution codes need a
team first.

**7 — "Free text is legal" is too absolute. V1, accepted, and it is a wording + boundary fix.**
The engine asks the channel and does not know the policy:

```
channel.canSendFreeForm(phone) → boolean
```

Today that returns `isWindowOpen(lastInboundAt)` (`inbox.ts:57`). The engine's step design never
depends on the answer staying true — anything behind a wait is a template regardless — so a Meta
policy change edits one function and no automation.

**8 — Priority / conflict resolution. The primitive: accepted. Four tiers: No.**
You are right that the cap alone cannot resolve your 10:00–10:03 scenario, because a suppressed
message today simply vanishes. The missing primitive is a third outcome:

```
communicationPolicy(patient, category, now) → SEND | DEFER(until) | DROP(reason)
```

Quiet hours already needed DEFER and the spec quietly had it as "skip". With three outcomes, your
four messages resolve: report-ready and appointment send (service, uncapped), the campaign sends,
the payment reminder **defers** to the next eligible slot and says so on Activity.

Four tiers I still reject. Critical is not a message (it is a phone call), day sheets go to owners
who do not contend for a patient's attention, and that leaves exactly the two classes Meta already
forces you to declare. Merge-two-messages-into-one: **No** — Meta templates are pre-approved
fixed bodies; there is nothing to merge.

**9 — Shared vs unique codes. Real gap. Model in V1, build in V2.**
`Coupon` is unique-per-patient by construction (`code @unique`, `redeemedVisitId`), so `DIWALI20`
does not fit it. The clean answer needs no second table:

> **Unique mode mints the coupon at issue. Shared mode mints it at redemption.**

The campaign carries the shared code; redeeming it creates the `Coupon` row bound to that bill and
patient. Same table, same redemption path, same attribution, one enum —
`CouponCampaign.distribution = UNIQUE_PER_PATIENT | SHARED_CODE`. Decide it now so it is not a
migration; V1 ships UNIQUE only.

**10 — General discount policy. One function in V1, rules in V2.**
The dead end you are pointing at is real but the fix is small: make resolution
`resolveDiscounts(bill, candidates[]) → { applied, rejected[{reason}] }`, taking a **list**. Today it
implements "larger in rupees wins" over two candidates. Priority, min-bill, exclusions, per-department
rules arrive when a second offer type does — and they arrive inside a function that already exists
instead of replacing a hardcoded `if`. Note `CouponCampaign.scope` + `allowedProductIds` already
cover applicable/excluded items.

**11 — Offer budgets. V1. This is the one I should have caught.**
Unbounded liability, four columns, one check:

```
maxRedemptions · maxDiscountBudgetInPaise · maxDiscountPerBillInPaise · dailyRedemptionLimit
```

Two details that matter more than the columns: the check happens at **redemption, not issue** (an
issued coupon is a promise, a redeemed one is money), and it must be an **atomic conditional update**
on the campaign counter or two simultaneous bills both pass the last-rupee check. Exhausted →
`OFFER_EXHAUSTED` on the issuing step, and the campaign row says so on the Offers list.

**12 — Forwarding / patient binding. V1, one boolean — and see C2, it does not exist today.**
`CouponCampaign.bindToPatient`. But the product answer is the interesting half: **default it OFF.**
Your own schema documents that families share a phone, and a mother collecting her son's coupon is
your normal Tuesday. Bind it only for campaigns where the offer is genuinely personal.

**13 — Trends and result history. V2 for conditions, V1 to declare the shape.**
Add `resultHistory(patientId, testCode, limit) → Result[]` beside `resultOf()` now, so "changed by
more than X since last" and "abnormal on two consecutive tests" are a new *condition* later, not a
new *interface* later. Implementation waits for V2.

**14 — Expected test due. Accepted — and the primitive is a column, not a subsystem.**
You are right that someone will hardcode `thyroid = 90 days`. The cure is to put the interval where
the reference ranges already live:

```
TestDefinition.retestIntervalDays  Int?
```

Then "7 days before due" is generic: `lastResultAt(patient, testCode) + retestIntervalDays − 7d`.
The clinician sets it in the same screen where they set the range, which is the same argument that
kept the rule editor out of the engine. A per-patient, doctor-prescribed **monitoring plan** is a
genuinely different thing — **Future**, and it would override this column rather than replace it.

**15 — Corrections and reversals. Conversion reversal is V1. A formal event model is No.**
Re-reading live state handles corrections *before* the send. It does nothing for the case after:
coupon redeemed, conversion counted, order refunded. So:

> **A conversion is a claim, and the sweep can revoke it.**

The same tick re-checks runs converted in the last 30 days and reverses those whose basis is gone,
with `stopReason = CONVERSION_REVERSED`. This also covers `reopenVisitForEntry` — **visit completion
is not monotonic in this system**, and any engine that assumes it is will be wrong quietly.

**16 — Versioning. V1 — two integers, not a table.**
`Automation.version` incremented on each activation, copied to `AutomationRun.version` beside the
frozen definition. Results groups by it. An `AutomationVersion` table adds a join and a lifecycle to
answer a question one integer answers.

**17 — Permissions. Done.** Owner-only today (`AdminConfigCenter` `roles: ['owner']`). Nothing to
build. The split that will matter when that changes is **author vs activate**, not per-screen CRUD.

**18 — Approval state. No, while 17 holds.** An owner approving their own campaign is a ceremony
with no second pair of eyes. The real gate already exists and is better: the dry run, which shows
the count and the suppression breakdown before anything sends. Revisit the day someone other than
the owner can author.

**19 — Deterministic holdout. Already deterministic — and you found a real bug.**
`hash(automationId + subjectId) % 100 < N` is deterministic, but `subjectId` is a **visit**. The same
patient across three visits gets three independent coin flips and can be treated in one and held out
in the next, contaminating both arms. Fix:

```
holdout = hash(automationId + patientId) % 100 < N
```

The patient stays in the same arm for that automation forever. One word, and without it the headline
number on the Results screen is quietly meaningless.

**20 — Conversion window. V1, missing, accepted.**
`definition.conversionWindowDays`, and the non-obvious part: it is anchored to the **trigger event,
not the send**. The holdout has no send — anchoring to send time makes the two arms incomparable and
the lift unreadable. Default 14 days for clinic → diagnostics.

**21 — "Caused by" wording. V1, accepted.** Renamed to **Incremental conversion**, and the screen
now shows the interval: at n=2,986 vs 341 the estimate is **+6.1 ± 3.7 points**. Worth printing,
because it tells the owner this design can detect a six-point lift and cannot detect a two-point one.

**22 — Snapshot vs live evaluation. Already the design — V1 to label it.**
Enrolment criteria and send-time re-check are different questions and the dry run conflated them in
one number. It now reports both: *would enrol* and *would send right now*.

**23 — Rate limiting / queue. Mostly already built. Retries are V1.**
The `PENDING` runs table **is** the queue and `LIMIT 50` per 5-minute tick **is** the throttle — a
600/hour ceiling against Meta's 80/second, so a 2,000-patient campaign self-drains over three hours
instead of stampeding. The genuine gap is retry classification: `MessageLog.errorCode` already stores
the Meta code, so split transient (rate limit, timeout → retry with backoff, capped attempts) from
permanent (invalid number, template rejected → stop, no retry). Dead-letter is the FAILED rows, which
Activity already shows.

**24 — Delivery state machine. Already exists.**
`MessageStatus = PENDING | SENT | DELIVERED | READ | FAILED` with `sentAt / deliveredAt / readAt`
(`schema.prisma:166`). The one change worth making: **Results should count delivered, not sent.**

**25 — Link tracking. Mostly already built.**
`LinkAccessLog` already logs `linkType: BILL | REPORT | COUPON | STATEMENT` with device, referrer and
timestamp, and coupon pages already flow through it. The missing piece is one column —
`automationRunId` on the log — so a click attributes to a run and the funnel reads
**sent → delivered → read → clicked → redeemed → billed**. Do not build link tracking; attach the run id.

---

## Five things neither of us named

**N1 — The holdout has an ethical boundary.** Withholding a *marketing* message from 10% is
measurement. Withholding "your doctor advised a follow-up test" from 10% is withholding clinical
advice to measure a conversion rate. **Holdout must be permitted only on MARKETING-category
automations and refused on anything with clinical intent.** One check at activation. **V1.**

**N2 — The frequency cap contaminates the experiment.** A treated patient suppressed by the 7-day cap
received nothing but sits in the treated arm, dragging its conversion rate toward the control's and
understating the lift. Decide it explicitly: **intention-to-treat** — they stay treated, the number is
conservative. Wrong either way, but only one way is honest. **V1, one sentence in the spec.**

**N3 — The one-off broadcast has no home, and it contradicts A2.** Your abnormal-result recall sent
527 messages to a list. Every trigger in the spec is per-subject and forward-only, and the activation
watermark explicitly forbids back-fill — but a broadcast **is** a back-fill, by definition. It needs
its own trigger type where the audience *is* the back-fill, and it must be the one place where the
dry run is mandatory and the confirmation is typed, not clicked. Without this, the next campaign gets
run from a script again. **V1.**

**N4 — Pause and Stop are two different intents with one button.** Pausing because a template reads
badly means "stop everything, including the 300 runs mid-flight". Pausing because the campaign
succeeded means "stop enrolling, let the in-flight ones finish". Same word, opposite consequences.
**Two controls. V1.**

**N5 — Template parameters are unbound and unvalidated.** A step says "send `clinic_followup_v1`", but
the template has `{{1}}`, `{{2}}` and the spec never says where they come from. A mismatch is not
caught at save time — it fails at send time, in production, for every patient in the run, with a Meta
error. **Bind parameters per step, and validate arity against the fetched template definition when
the automation is saved.** `listMessageTemplates()` already returns the shape. **V1.**

---

## What changed in the locked spec

V1 gains: scope vocabulary · sweep-based enrolment · re-entry config · handoff category rule ·
channel-owned free-form · DEFER outcome · offer budgets · patient binding · conversion reversal ·
version integers · **holdout keyed on patient** · conversion window · retry classification ·
run id on link logs · unit-checked thresholds · holdout restricted to marketing · one-off broadcast
trigger · pause vs stop · template parameter binding.

V2: result triggers · trends · shared codes · discount rules · monitoring plans.

Still No: event table · Conversation-owned run pointer · four priority tiers · message merging ·
approval workflow (while owner-only) · AutomationVersion table · clinical rule editor · DAG.
