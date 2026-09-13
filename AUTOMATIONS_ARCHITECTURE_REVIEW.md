# Automations + Campaigns — adversarial architecture review

Reviewed against the actual Sobhana schema and services, not against the plan in the abstract.
Every claim below cites the file that makes it true.

---

## 0. The one-paragraph verdict

The layering (automations = who/when · offers = what · messaging = how · clinical = meaning) is
correct and worth keeping. The engine described on top of it is roughly 4x too large for this
product, and the two things that actually decide whether this works — **what "related to THIS
visit" means**, and **whether a coupon is a cost the centre eats or a discount the referring
doctor shares** — are not in the plan at all. The first is a schema gap. The second is a money
decision that is currently being answered by silence in `payoutService.ts`.

---

## A. What the plan gets right

1. **Re-check before every action.** Right principle. See §C for the one rule it is missing.
2. **The four-layer separation.** Keep it, with one correction in §K.
3. **Shared vs unique coupon modes.** Already half-built and correct — `Coupon` carries
   `patientId`, `issuedVisitId`, `redeemedVisitId`, `redeemedBillId` (`schema.prisma:825`).
4. **Migrating the day sheets onto the same engine.** Right, and cheaper than it looks — see §E.
5. **"Why didn't this patient get the message?"** The most valuable feature in the whole plan.
   It is not a debugging view, it is the send path itself (§D.3).
6. **Clinical meaning lives outside the automation engine.** Right — and it already exists, so
   the job is to expose it, not to build it (§F).

---

## B. The finding that blocks the flagship automation

**"Did a diagnostic transaction related to THIS clinic visit happen?" is not answerable in the
current schema.**

- A consultation is `Visit(domain=CLINIC)` + `ClinicVisit`.
- A diagnostic order is a `TestOrder` under a **different** `Visit(domain=DIAGNOSTICS)`.
- The only visit-to-visit pointer is `ClinicVisit.originalVisitId`, and it is clinic→clinic
  follow-up only — every read of it is via `clinicVisit.originalVisitId`
  (`patientService.ts:474`, `bills.ts:75`). Nothing links diagnostics back to the consultation
  that advised it.

Three ways to get the link, and the plan picks none:

| | Mechanism | Cost | Failure |
|---|---|---|---|
| (a) | Time window: any DIAGNOSTICS visit for this patient in `[consult, consult+N days]` | free | counts unrelated walk-in diagnostics |
| (b) | Capture it: `Visit.sourceVisitId`, set at diagnostics registration | 1 column + a front-desk field | staff discipline, not code, is the risk |
| (c) | The coupon **is** the link: `issuedVisitId` → `redeemedVisitId` | already built | invisible when the patient converts without using the code |

**Recommendation — use two different rules, deliberately:**

- **Suppression (should we still send?) → (a), generous.** A false "already done" costs one
  unsent message. That is the safe direction to be wrong in.
- **Attribution (did we cause it?) → (c), strict.** Only count what redemption proves.
- Add (b) later as an optional field; it improves both, but ship without it.

The plan uses one condition for both, which forces a single precision setting onto two questions
that want opposite ones. Say this explicitly in the spec or an engineer will pick one and half
the dashboard will be wrong.

---

## C. The re-check principle is right but under-specified

Add one rule, and it becomes a safety property instead of a convention:

> **A trigger payload carries identity only — never values.** Every condition re-reads live state
> at action time.

This is what makes corrected results safe. Sobhana has no amendment event: the documented way to
fix a finalized result is to patch `TestResult` **and** the panels snapshot in place, preserving
`finalizedAt`, with no re-notify. So a result-triggered automation can fire on a transcription
error and there is no event that cancels it.

If the condition captured `hba1c = 11.2` at enrollment, the re-check cannot save you. If the
condition re-reads, a correction inside the wait window silently cancels the send. Free safety,
but only if value capture is forbidden by the engine rather than by discipline.

Corollary: clinical triggers should carry a **settle delay** (evaluate 12–24h after finalize),
which is just a longer first wait — no new primitive.

---

## D. The primitives that are actually missing

Not "add a special case" — these are general, and each one collapses several plan sections.

### D.1 Subject (anchor entity) — replaces "event-scoped conditions"

A run is anchored to **one entity**, not to an event. The trigger event only identifies the
subject. Once `run.subjectType/subjectId` exists, "this visit" is free: conditions are evaluated
relative to the subject, and "this test / this visit / this order" stop being special cases.

`subjectType ∈ {PATIENT, VISIT, TEST_ORDER}`. That is the whole feature.

### D.2 Predicate library — the most important missing piece

Named, versioned, individually unit-testable functions `(subjectId, now) → boolean | number`:

```
hasDiagnosticsFollowing(visitId, days)
lastVisitAgeDays(patientId)
resultFlag(testOrderId, testCode)
outstandingDueInPaise(visitId)
```

Without this, every condition is a bespoke query inside a JSON blob in the automations table, the
same question gets three implementations, and **the code that decides whether to message 2,000
people has no test**. With it, the stop condition and the goal in §B are literally the same
function called twice — which is exactly what you want, and what the plan's separate "Goals"
subsystem would have let drift apart.

This is the layer to build first. It is also the layer that makes the engine testable offline,
the same way `pulse:check` tests Pulse without spending money.

### D.3 Suppression resolver with reason codes

One function, every source, returns `{ send: false, reason: 'LINK_DISABLED' }`:

- patient opted out (does not exist yet — §G)
- `Visit.patientLinkDisabledAt` (`schema.prisma:645`) — already suppresses report sends
  (`notificationService.ts:321,456,681`)
- no phone / invalid number
- frequency cap
- quiet hours (IST)
- holdout bucket
- template paused by Meta

This is not a debugging feature bolted on later. It **is** the send path, and its reason code is
what the Activity screen prints. Build it as one function or the two will disagree.

### D.4 Holdout bucket — three lines, impossible to backfill

`run.holdout = hash(automationId + subjectId) % 100 < N`. Enroll them, evaluate every condition,
**skip the send**, log it.

The plan's funnel (`coupons redeemed 318 → transactions 318 → revenue ₹X`) is wrong in both
directions at once: it counts patients who were coming anyway (where the 15% is pure margin
loss), and it misses everyone who converted without mentioning the code. Only
`conversion(treated) − conversion(holdout)` is a real number.

**This is the single highest-value day-one item in the review.** Every other gap can be fixed
later; a missing holdout means the first six months of data can never answer whether any of this
worked.

### D.5 Cycle key — the whole re-entry section, as one string column

`UNIQUE(automationId, subjectId, cycleKey)`:

- `cycleKey = visitId` → once per visit
- `cycleKey = '2026-09'` → once a month
- `cycleKey = 'once'` → once ever

Covers every re-entry policy in the plan, plus idempotency, plus deduplication, in one index. No
policy engine. This is the pattern `ScheduledMessageRun` already uses —
`@@unique([kind, branchId, domain, runDate])` (`schema.prisma:2401`).

### D.6 Send-time template classification + sender health

`whatsappCloudService.ts:189` knows `category: UTILITY | MARKETING | AUTHENTICATION`, but only for
template management — it is never persisted per send. Record it on `MessageLog` at send time, so
that in six months you can prove what was sent under which classification.

And add a circuit breaker: `MessageLog.errorCode` already stores the Meta error. After N
consecutive failures on one template, pause the automation. A campaign that keeps firing into a
blocked or rejected template burns the WABA's quality rating for every other message the centre
sends, including report-ready.

### D.7 Dry run

"How many patients match right now, show me 20 of them" before activation. The cheapest possible
protection against a 2,000-message mistake, and it is just the audience predicate with `LIMIT 20`.

---

## E. The execution engine — do not build a workflow engine

Evidence from this repo:

- One Render box, 512MB, with an OOM history.
- No scheduler by deliberate choice — `automatedMessageService.ts` says so, and
  `anomalyProjectorService.ts` avoids one too.
- The ticker is `setInterval(tick, 5 * 60 * 1000).unref()` (`index.ts:425`).
- Neon's pool is fragile: three concurrent harness runs exhausted it and stalled prod analytics.
- No websockets anywhere; SSE only.

The plan's DAG / branching / state machine is the wrong shape for this box. The right shape is
already in the repo — generalize `ScheduledMessageRun`:

```
AutomationRun
  automationId, subjectType, subjectId, cycleKey   UNIQUE
  definition   Json      -- the compiled automation, frozen at enrollment
  stepIndex    Int
  state        PENDING | DONE | STOPPED | FAILED
  stopReason   String?
  holdout      Boolean
  nextActionAt DateTime?                            -- partial index WHERE state='PENDING'
```

The existing 5-minute tick does:

```sql
SELECT ... WHERE state='PENDING' AND "nextActionAt" <= now()
ORDER BY "nextActionAt" LIMIT 50 FOR UPDATE SKIP LOCKED
```

`LIMIT 50` and one connection per tick, not per run — that is what keeps Neon alive.

Steps are an **array** in the definition with a `stepIndex` on the run. No DAG. No branch nodes:
a branch is a second automation with an inverted condition until you have three of them.

Freezing the compiled definition **on the run** answers the entire versioning section with zero
extra tables and zero joins — an in-flight run keeps its 48h wait when the automation is edited
to 24h, because it is reading its own copy.

Scale check: ~2,430 enrollments/month is ~80/day, ~0.3 per tick. This is not a throughput problem.
It is a correctness-and-explainability problem. Build for explainability.

**Claim before send, never after.** That is the one rule that makes redeploys, restarts, slow ticks
and a second instance all safe — `automatedMessageService.ts` already explains why, and it is the
right trade: a crash between claim and send leaves a FAILED row rather than a silent double.

---

## F. Clinical rules — already exist, so expose them

Do **not** build a rule DSL. The system already has `TestResultFlag {NORMAL|HIGH|LOW}`,
`TestDefinitionRange`, `TestAgeRange`, `RangeCategory`, `InterpretationRule`,
`ComparisonOperator` and `HealthContentRule`. A second rule engine beside these is the clearest
technical dead end in the plan.

The automation engine consumes **one predicate**: `resultFlag(testOrderId, testCode)`. Everything
about ranges, age/sex bands, units and qualitative results stays where it already lives and stays
the clinicians' business.

Two things the clinical layer must add for this to be safe:

1. **A settle delay** before a result is automation-visible (§C).
2. **Critical values must never route through marketing.** A panic value is a phone call from the
   lab, not a WhatsApp with a discount. Encode it: if the flag is critical, the automation refuses
   to act and raises an operational alert instead.

---

## G. Consent — the current model does not survive a marketing message

`notificationService.ts:266`:

```
/** Auto opt-in a patient if they haven't explicitly opted in yet.
 *  Used when staff triggers a manual send — implies consent. */
```

`whatsappOptIn` flips to `true` the first time staff manually sends anything. That is defensible
for a UTILITY report-ready message. It is **not** consent for marketing, and it is a single
boolean covering both purposes.

There is also **no opt-out anywhere**. A patient replying "STOP" lands in `Conversation` /
`ConversationMessage` (the inbox) and nothing happens.

Minimum viable fix, all three needed before the first campaign:

1. **Consent per purpose**, not one boolean: `service` (report/bill/OTP) vs `marketing`
   (offers/campaigns). Auto opt-in may continue to grant `service`. It must never grant
   `marketing`.
2. **Opt-out written from the inbound webhook** on STOP/STOP/UNSUBSCRIBE, and honoured by the
   suppression resolver (§D.3). Cheap: the webhook already writes `ConversationMessage`.
3. **Template category persisted on `MessageLog`** at send time (§D.6).

Context that makes this urgent: the abnormal-result recall campaign was approved as **UTILITY**
under the "standing concession" framing, post discount-ban. The moment a template is reclassified
MARKETING, delivery to non-marketing-opted-in patients is limited — `EVENTS_AND_COUPONS.md §8`
already flags this. With a single boolean you cannot even tell who is affected.

---

## H. The money collision nobody has decided

`payoutService.ts:278` allocates only `billFinancials.discountAmountInPaise` across the visit's
orders. `couponDiscountInPaise` is a **separate** column (`billFinancialService.ts:97–101`) and is
**not** in the referral commission base.

Today that is harmless — coupons are a blood-donation drive. At 2,000 coupons/month against
referred patients it is a structural margin leak:

> ₹2,000 bill · 15% coupon · 20% referral commission
> Centre collects ₹1,700. Centre pays the doctor ₹400 (20% of the pre-coupon ₹2,000), not ₹340.
> The coupon costs 15% **+ 3% of gross**, not 15%.

This is not an engineering bug — it is an unmade business decision, and both answers are
defensible (the doctor shares the promotion, or the centre absorbs it). Silence is the bug.
**Decide it before the first campaign ships, and write the decision into `payoutService`
explicitly either way**, because the current behaviour is an accident of which column the
allocator happened to read.

Second collision, smaller but it will hit the front desk in week one: `couponService` blocks
stacking with a manual discount. Staff give counter concessions routinely. A patient arriving with
a WhatsApp coupon *and* asking for the usual concession puts the staff member in a dead end whose
only exit is voiding one of them. Pick a rule now — coupon wins / larger wins / additive with a
cap — and make the billing screen say which.

---

## I. Healthcare-specific risks the plan does not name

### I.1 Shared phone numbers — documented in your own schema

`PatientIdentifier` (`schema.prisma:307`):

> *"Multiple patients can share the same identifier (e.g., family members with same phone)"*

Report-ready messages are safe today because they carry a **tokenized link**, not a finding. A
result-triggered marketing message carries the finding in the template body — and sends a
relative's diagnosis to whoever holds the phone.

Encode this as a **template property, not a campaign rule**:

> A template whose content derives from a clinical value may not name the finding in its body.

Send "your doctor has advised a follow-up test — details at the centre", or send a link. This
belongs to the messaging layer, so no campaign author can opt out of it by accident.

### I.2 No deceased flag

`Patient` has no `deceasedAt`. A retest reminder or a screening offer to a deceased patient is the
worst single failure this system can produce, and there is currently no way to prevent it. One
nullable column plus one line in the suppression resolver.

### I.3 Recycled numbers

Indian mobile numbers get reassigned. A dormant-patient reactivation campaign (90d+ inactive) is
exactly the cohort where this is most likely. Same mitigation as I.1: no clinical content in the
body of any message to a long-dormant number.

---

## J. Data to capture from day one (cheap now, impossible later)

Everything else in this document can be retrofitted. These cannot:

1. `run.subjectType/subjectId` + `cycleKey` — identity and re-entry.
2. `run.holdout` — the only honest ROI number.
3. `run.definition` (frozen JSON) — versioning, for free.
4. `MessageLog.automationRunId` + `templateCategory` — attribution and compliance.
5. `Coupon.automationRunId` — closes visit → run → coupon → bill → revenue.
6. `run.stopReason` — the Activity screen and the suppression audit, same column.
7. Consent split into `service` / `marketing` with timestamp and source.
8. An **activation watermark** on every automation (§K.19): runs only enroll subjects created
   after activation, never the last six months of history.

---

## K. Boundary corrections to the product philosophy

The four-layer split is right. Two corrections:

**"Transactions determine business outcome" is not a layer — it is a predicate.** Goal detection
and the stop condition are usually the *same question* (§B), and in the flagship automation they
are literally identical. Two subsystems guarantees they drift, and the day "stopped early" stops
equalling "converted" is the day nobody trusts the dashboard again.

**Offers are not a peer of messaging — a coupon is an action, and coupon eligibility belongs to
billing.** `couponService.validate()` already lives on the billing side. Leave it there. The
automation *issues*; billing decides what is redeemable. A marketing module must never own money
rules — see §H for what happens when discount logic drifts away from the payout allocator.

---

## L. V1 / V2 / not yet

### V1 — the thing that ships

- `AutomationRun` table (§E), driven by the existing 5-minute ticker.
- Predicate library (§D.2) with an offline test suite — no model calls, like `pulse:check`.
- Triggers: **event** (visit completed, report finalized) and **schedule**. Nothing else.
- Steps: `wait → check → act`, as an array. Actions: `send template`, `issue coupon`, `stop`.
- Suppression resolver with reason codes (§D.3).
- Holdout bucket (§D.4).
- Consent split + opt-out from the inbox webhook (§G).
- Dry-run preview (§D.7).
- Activity screen: one run, every step, every reason code.
- Migrate `DAY_SHEET` onto it.
- **First automation: clinic → diagnostics recovery**, with §B's asymmetric rules and §H decided.

### V2

- Inactivity and relative-to-expected-date triggers.
- Result triggers, behind the settle delay and the critical-value block (§F).
- Saved audiences (only once two automations share one).
- Frequency caps across automations.
- Channel fallback, when there is a second channel.

### Do not build yet

- A workflow DAG, branch nodes, or a durable-execution engine.
- A clinical rule DSL (§F).
- Segment / Journey / Enrollment / Goal / AutomationVersion as separate entities (§E, §K).
- Priority classes — you have two kinds of message, not four.
- Metric/threshold operational triggers. That is Pulse, which already has a metric registry and a
  contract. Duplicating it produces two definitions of "revenue today", which is the specific
  failure `pulse:check` exists to prevent.
- A/B testing. The holdout gives you the only comparison that matters until there are ten
  automations.

---

## M. The 20 hardest edge cases

1. Phone shared by three family members — clinical content leaks to a relative (§I.1).
2. Visit reopened after COMPLETED (`reopenVisitForEntry`) — a run that stopped as "converted" is
   now wrong. Completion is **not monotonic** here; the engine must tolerate state regression.
3. Duplicate registration via double-click (backend idempotency still open) — two Visit rows, two
   enrollments, two coupons for one real visit. `cycleKey` on visitId does not save you; needs a
   `(patient, day, automation)` backstop.
4. Result corrected after finalize, no amendment event — §C.
5. Coupon meets a counter concession — stacking blocked, staff has no exit (§H).
6. Coupon redeemed on a referred visit — doctor paid on pre-coupon gross (§H).
7. Order cancelled/refunded after the coupon was redeemed — coupon consumed, conversion counted,
   money returned. Needs a conversion reversal.
8. `patientLinkDisabledAt` set between enrollment and send.
9. Patient consults at Chintal, does diagnostics at another branch. Is that a conversion? `Visit`
   carries `branchId`; `Patient` does not. Decide, and write it down.
10. IST day boundary — "no visit today" evaluated in UTC is wrong for 5.5 hours a day. `Prisma
    DateTime` is tz-less UTC; `automatedMessageService` already does this correctly with a fixed
    +330 offset. Reuse it, do not re-derive it.
11. Redeploy mid-tick — safe only because the claim precedes the send.
12. Meta rejects or pauses the template — enrollment continues, every send fails, runs pile up
    (§D.6).
13. Patient replies; staff is mid free-form conversation in the inbox when a template fires.
14. Recycled phone number (§I.3).
15. Deceased patient (§I.2).
16. Soft-deleted rows — an audience query that forgets `deletedAt IS NULL` enrolls cancelled
    referrals. Three models carry it.
17. First activation backfill — must default to "from now", never the last six months (§J.8).
18. Two automations issue coupons to the same patient in the same week.
19. Test added to an already-billed visit (owner-gated, exists) changes the visit after conversion
    was evaluated.
20. A sweep that opens a connection per run exhausts the Neon pool exactly the way three
    concurrent harness runs did. Batch the sweep; one connection per tick.

---

## N. 20 automations, and the primitive each one proves

| # | Automation | Proves |
|---|---|---|
| 1 | Clinic → diagnostics recovery, 48h | subject, asymmetric suppression/attribution (§B) |
| 2 | Same, 3-day reminder | multi-step array, re-check |
| 3 | Nightly diagnostic day sheet | schedule trigger, non-patient recipient |
| 4 | Nightly OP day sheet | same engine, different action |
| 5 | Report ready, not opened in 48h | predicate over `ReportAccessLog` |
| 6 | Bill due > 7 days | `outstandingDueInPaise` predicate, goal = payment |
| 7 | Bill due > 21 days, second notice | cooldown via `cycleKey` |
| 8 | Films collected, report not | two predicates, AND |
| 9 | Clinic no-show (WAITING never IN_PROGRESS) | absence of a transition as a trigger |
| 10 | Clinic follow-up advised, not rebooked in 14d | relative-to-expected date |
| 11 | HbA1c abnormal → retest in 90d | settle delay, critical-value block (§F) |
| 12 | TSH abnormal → endocrine follow-up | same predicate, different template |
| 13 | Annual health checkup due | expected-event trigger, yearly `cycleKey` |
| 14 | Dormant patient, 180d | inactivity, recycled-number rule (§I.3) |
| 15 | Blood-camp coupon expiring in 3 days | coupon-state predicate |
| 16 | Coupon issued, unredeemed at day 5 | run → coupon linkage |
| 17 | Referring doctor's monthly statement | non-patient subject, monthly `cycleKey` |
| 18 | Owner alert: >20 unsigned reports | **rejected** — belongs to Pulse (§L) |
| 19 | Patient birthday greeting | proves frequency caps matter |
| 20 | Post-visit feedback, 24h | proves the priority question is binary, not four-tier |

Items 18 and 20 are in the list because the architecture is also proved by what it **refuses**.

---

# O. Two-way conversational workflows

## O.0 This is not a greenfield design — it ships today as one `if`

`webhooks.ts:395`:

```js
const isBook = /^\s*book\b/i.test(inboundBody);
if (isBook) await issueAndSendRetestCoupon(from, convo.patientId, convo.id);
```

Keyword trigger → coupon issue → free-form send. That is exactly the flow in the proposal,
hardcoded for one campaign (`RETEST_2026`). The design question is therefore **generalization, and
the existing special case is the spec** — including its bugs, which are the interesting part.

Also already present and correct, so do not rebuild:

| Thing | Where |
|---|---|
| `Conversation` as a first-class entity | `schema.prisma:1387` |
| 24h window, **derived** not stored | `inbox.ts:57` `isWindowOpen(lastInboundAt)` |
| Free-form send | `whatsappCloudService.ts:133` `sendText()` |
| Webhook-retry dedup | `ConversationMessage.waMessageId @unique` |
| Contention claim (compare-and-set) | `webhooks.ts` `autoRepliedAt` CAS — *generic reply only* |
| Human ownership | `Conversation.assignedToId`, `status OPEN\|CLOSED` |

## O.1 The live bug this generalization must fix

`webhooks.ts:345` derives the patient from the phone:

```js
const lastOutbound = await prisma.messageLog.findFirst({
  where: { phone: from }, orderBy: { createdAt: 'desc' },
  select: { patientId: true, branchId: true },
});
```

Cross this with `PatientIdentifier`'s own comment — *"Multiple patients can share the same
identifier (e.g., family members with same phone)"*:

1. Mother receives the abnormal-result recall.
2. An hour later the son's report-ready message goes to the same phone.
3. Mother replies **BOOK**.
4. `lastOutbound.patientId` = **the son**.
5. `resolveAbnormalProductIds(son)` scopes the coupon to **the son's abnormal panels**.
6. The message opens *"Thank you, [son's first name]"*.

Wrong name, a coupon whose allowed-product list discloses another patient's abnormal tests, and
attribution recorded against the wrong patient. The idempotency lookup compounds it — the existing
coupon is found by `(campaignId, phone, ISSUED)`, also phone-keyed, so the mother's reply *reuses
the son's coupon*.

**This is the whole difficulty of reply correlation, already in production.** Any engine built on
"resolve the patient from the phone at reply time" inherits it.

## O.2 Should `Conversation` be first-class? Yes — and it is the wrong place for automation state

It already is first-class, and it is **correctly modelled**: keyed `phone @unique`, because it
models the *channel thread*, which is what WhatsApp actually gives you. Do not re-key it to
patient — a shared phone would become two threads for one real WhatsApp conversation, and staff
would see duplicates of a thread they can only reply to once.

But that same correctness means `Conversation` **cannot** answer "which automation run is
speaking". One phone, many patients, many runs.

The genuinely missing entity is not Conversation. It is an **expectation slot**:

```
AwaitingReply
  phone            UNIQUE     -- at most one automation may hold the line
  automationRunId
  patientId                   -- PINNED at send time, never re-derived
  expiresAt
  match            Json       -- button payloads + keyword fallbacks
```

What the single unique index buys, with no other machinery:

- **Correlation.** Inbound → slot → run. No heuristics, no scanning outbound history.
- **O.1 fixed.** `patientId` is pinned when the question was asked, so the reply is attributed to
  whoever was actually asked — not to whoever happened to receive the most recent message.
- **"Multiple simultaneous automations"** — forbidden by construction. A second automation wanting
  the line skips and logs a reason code through the suppression resolver (§D.3).
- **"Reply to an old campaign"** — an expired slot means no run resumes; the message is a normal
  inbox message for staff. Never resume a 30-day-old run.
- **Human handoff** — `assignedToId` set is one more suppression source: a human holds the line,
  automations stay out.

Correlate on the **button payload**, not the keyword. `webhooks.ts:131` currently captures a button
reply as its *display text* and discards `button.payload` — which is the one field you control and
the only exact correlation key WhatsApp offers. Quoted-reply `context.id` only arrives when the
patient uses the swipe gesture; most people just type. So: buttons carry the run id, keywords are
best-effort fallback.

## O.3 Template vs free-form — one engine rule removes the whole question

The channel layer deciding is right. It needs **three** outcomes, not two, and one rule makes the
window state trivial:

> **Free-form is permitted only as a direct response to an inbound message, in the same tick.
> Anything behind a wait step is a template.**

The patient's reply *opens* the 24h window, so an immediate answer is always legal. Any step behind
a wait must assume the window is shut. No window tracking, no expiry job, no `windowExpiresAt`
column — `isWindowOpen(lastInboundAt)` stays a derived assertion at the boundary, exactly as
`inbox.ts:57` already does it.

The third outcome the plan omits: **window closed AND no template exists for this intent → cannot
send.** The automation must branch to human handoff; the channel layer must not silently drop it.
This is the common case for conversational steps, which by their nature have no template.

## O.4 The part to push back on

The proposed flow ends:

> patient says "HbA1c" → respond with relevant information → patient says "book" → create booking

That is a model answering clinical and pricing questions, free-form, to patients, with money
attached. Free-form means **no Meta pre-approval** — the reviewed surface goes from ~8 template
bodies to whatever the model emits. And "which test should I do" is a clinical question.

This codebase already learned the lesson: Pulse has a contract and a verification harness because
ungrounded generation was wrong in ways that were hard to see. The same failure on an owner's
screen is a bad number. On a patient's phone it is a clinical claim.

**Build a menu, not a conversation.** Quick-reply buttons, fixed responses, human handoff for
anything off-menu. The safe design and the technically correct design are the same design, because
buttons are also the only reliable correlation key (§O.2). Free text that matches nothing is not a
failure — it is the handoff trigger, and `assignedToId` is already there to receive it.

Reject for V1: sentiment/intent classification ("reply is positive/negative"). A button payload is
a match. Sentiment is a model call on a clinical channel.

## O.5 The first keyword is STOP, not TESTS

§G flagged that no opt-out exists anywhere. Reply triggers hand it to you for nothing: the same
inbound path, one keyword, one write. It is the only keyword that is legally load-bearing, and it
should ship before the one that sells anything.

## O.6 Two contradictions to resolve before building

1. **`inbox.ts:49` hard-blocks marketing from patient conversations** — *"Marketing (sales) has no
   business in patient conversations"*, enforced at the API, not just the nav. The proposal is a
   marketing conversation with the patient. Either that decision stands (and campaign operators
   never see the thread their campaign started), or it is consciously revised. It should not be
   discovered by an engineer at implementation time.
2. **The BOOK path has no claim.** The generic auto-reply uses a compare-and-set on `autoRepliedAt`
   precisely so *"concurrent inbound webhooks can't trigger a double, and two bots can't
   ping-pong"*. `issueAndSendRetestCoupon` has no equivalent — it is protected only because the
   coupon is reused, which dedups the *coupon* and not the *message*. Two rapid BOOKs send two
   texts. The generalized engine must claim the slot the same way the day-sheet ticker claims a
   run: **before** the send.

## O.7 What this adds to V1

- `AwaitingReply` slot (one table, one unique index).
- Inbound event → slot → resume run, inside the same transaction as the `ConversationMessage`
  insert, so `waMessageId @unique` makes resumption retry-safe too.
- Actions: `send template`, `send free-form (response-only)`, `hand off to staff`.
- Button payloads carry the run id; `extractInbound` stops discarding `button.payload`.
- Keywords: `STOP` first.
- `assignedToId` set → automations suppressed on that thread.
- Migrate the hardcoded BOOK path onto it, and **pin `patientId` at send time** — that migration
  is the fix for §O.1.

Still not V1: intent classification, free-text Q&A, booking creation from chat, SMS/email inbound.
