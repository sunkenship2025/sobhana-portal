# Automations + Campaigns — LOCKED V1 (rev 5)

Analysis: `AUTOMATIONS_ARCHITECTURE_REVIEW.md`. Round-2 disposition of the 25-point review:
`AUTOMATIONS_ROUND2.md`. **This file is the decisions** — where any of the three disagree, this one
wins. Rev 2 folds in the round-2 outcome.

Verified against code before locking, and two review claims corrected in the process:
`TestResultFlag` **does** carry `CRITICAL_HIGH`/`CRITICAL_LOW` (`schema.prisma:95`), and
`validateCouponByCode` **does not** check `patientId` (`couponService.ts:173`), so per-patient
coupons are unenforced today.

---

## 1. Answered decisions

**D1 — Coupon cost sharing is one number.** `CouponCampaign.referrerSharePct` 0…100.

```
commission base = gross − orderDiscount − (couponDiscount × referrerSharePct / 100)
```

0 = centre absorbs · 50 = split · 100 = doctor shares fully. One term added to the existing
allocator (`payoutService.ts:278`), not a branch. UI shows the arithmetic on a real bill.

**D2 — Coupon vs counter concession: the larger in rupees wins.** Compared in rupees on that bill,
never in percent — a TESTS_ONLY coupon and a whole-bill concession are not comparable as percentages.
Both recorded; the loser stored as `NOT_APPLIED_SMALLER`. Resolution goes through
`resolveDiscounts(bill, candidates[])`, which takes a **list** from day one so the next offer type is
a new candidate rather than a rewrite.

**D3 — Conversion is patient-level, any branch, branch recorded.** `convertedBranchId` on the run;
Results splits same-branch from cross-branch without a second definition of "converted".

**D4 — Its own place under Admin** (reversed 13 Sep). `Admin` becomes a nav group with two
children, reusing the `subItems` pattern `Workflows` and `Payouts` already use
(`Sidebar.tsx:96,140`) — no new nav primitive:

```
Admin
├── Config Center   /owner/config      things you set once
└── Automations     /owner/automations  something you operate
```

Sub-tabs inside it, in this order: **Automations · Templates · Offers · Activity**. Templates and
offers are resources an automation *uses*, so they sit behind it and are reachable inline from the
builder; they keep a tab because both also need a place to be seen all at once. Results is a section
inside one automation, never a tab. Day sheets move with it and become rows in the list.

**D5 — Permissions are done: owner-only** (`AdminConfigCenter` `roles: ['owner']`). No approval
workflow — an owner approving their own campaign is ceremony. The real gate is the mandatory dry run.
The split that matters when access widens is **author vs activate**, not per-screen CRUD.

**D6 — The builder reads as a sentence.** `WHEN → FOR → THEN → CHECK → DO → STOP`, one sequence
with the verb in the gutter, not five peer sections (Trigger / Audience / Steps / Stop / Safety).
Wait-then-check-before-every-send is the shape of the product, not a detail inside a Steps list, and
the screen has to make that legible without a diagram.

---

## 2. Standing rules

| | Rule |
|---|---|
| A1 | Sales stays blocked from patient threads (`inbox.ts:49`). Campaign authors see Activity and reason codes, never the thread body. |
| A2 | Activation watermark — enrol only subjects created **after** activation. The single exception is the one-off broadcast trigger (§4), where the back-fill *is* the audience. |
| A3 | Holdout 10%, settable 0–20, frozen at activation, **keyed on patientId** (§5). |
| A4 | Quiet hours 08:00–21:00 IST for marketing. Service messages unaffected. |
| A5 | **Reactive messages are never capped; proactive ones contend.** See §9.3 — this replaces "one marketing message per 7 days", which cut the wrong way. A run skipped by the cap is recorded as `SKIPPED_FREQUENCY_CAP` and is **never counted as messaged** (§9.8). |
| A6 | `CRITICAL_HIGH`/`CRITICAL_LOW` never routes through an automation. It raises an operational alert. |
| A7 | No test name or finding in the body of a patient template. Phones are shared; your schema says so. |
| A8 | STOP ships before anything that sells. |
| A9 | **Every action re-checks first — not only sends.** A message, a coupon issue, a staff task: each re-reads the stop condition immediately before executing. Guarding only the send leaves `Check → Issue coupon` unprotected, which is the one that costs money. |
| A10 | **Holdout is permitted only on MARKETING automations.** Withholding a clinical follow-up message to measure a conversion rate is not an experiment. |

---

## 3. Data model

Four new tables. Everything else is a column.

```prisma
model Automation {
  id          String    @id @default(cuid())
  key         String    @unique
  name        String
  group       String              // Reports | Patient journeys | Conversations
  definition  Json                // trigger + audience + steps + stop + reentry + windows
  version     Int       @default(1)   // ++ on each activation — replaces an AutomationVersion table
  enabled     Boolean   @default(false)
  activatedAt DateTime?               // the watermark (A2)
  holdoutPct  Int       @default(10)
  branchIds   String[]  @default([])
  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}

model AutomationRun {
  id                    String    @id @default(cuid())
  automationId          String
  version               Int                  // copied at enrolment; Results groups by it
  subjectType           String               // PATIENT | VISIT | TEST_ORDER | REPORT_VERSION | COUPON
  subjectId             String
  cycleKey              String               // compiled from definition.reentry
  patientId             String?              // PINNED at enrolment, never re-derived from a phone
  branchId              String?
  definition            Json                 // FROZEN copy
  stepIndex             Int       @default(0)
  state                 String    @default("PENDING")  // PENDING | DONE | STOPPED | FAILED
  stopReason            String?
  holdout               Boolean   @default(false)
  attempts              Int       @default(0)          // retry/backoff (§6)
  nextActionAt          DateTime?
  triggeredAt           DateTime                       // conversion window anchors HERE, not on the send
  convertedAt           DateTime?
  convertedBranchId     String?
  convertedValueInPaise Int?
  createdAt             DateTime  @default(now())
  updatedAt             DateTime  @updatedAt

  @@unique([automationId, subjectId, cycleKey])
  @@index([state, nextActionAt])
  @@index([automationId, state])
  @@index([patientId])
}

/// Append-only. This IS the Activity screen; nothing is derived at read time.
model AutomationStepLog {
  id           String   @id @default(cuid())
  runId        String
  stepIndex    Int
  kind         String   // ENROLLED | CHECK | SEND | DEFERRED | SUPPRESSED | ASK | REPLY | HANDOFF | STOPPED | REVERSED
  outcome      String   // the reason code — always present, never null
  detail       Json?
  messageLogId String?
  at           DateTime @default(now())

  @@index([runId, at])
}

/// STOP is per NUMBER, not per patient — corrected in rev 5 by the feasibility audit.
/// PatientIdentifier documents that families share a phone, so a per-patient column cannot
/// express "this handset said stop". Opt-out is broad, opt-in is narrow: asymmetric on purpose.
model PhoneOptOut {
  phone      String   @id            // normalized "919876543210"
  optedOutAt DateTime @default(now())
  source     String                  // INBOUND_STOP | STAFF | IMPORT
  byUserId   String?
  reason     String?
}

/// At most one automation may hold a phone line. The unique key IS the feature.
model AwaitingReply {
  phone           String   @id
  automationRunId String   @unique
  patientId       String            // PINNED at send — the fix for webhooks.ts:345
  expiresAt       DateTime
  match           Json              // { buttons: { payload → stepIndex }, keywords: [...] }
  createdAt       DateTime @default(now())

  @@index([expiresAt])
}
```

Columns on existing models:

```
MessageLog.automationRunId      String?
MessageLog.templateCategory     String?   // UTILITY | MARKETING | AUTHENTICATION, at SEND time
Coupon.automationRunId          String?
LinkAccessLog.automationRunId   String?   // click attribution — the log already exists
Conversation.assignedAt         DateTime?
Conversation.handoffReason      String?
Patient.marketingOptIn          Boolean @default(false)   // opt-IN is per patient
Patient.marketingOptInAt        DateTime?
Patient.marketingOptInSource    String?
Patient.deceasedAt              DateTime?
MessageLog.templateBody         String?   // snapshot — Meta edits templates in place, with no version
CouponCampaign.referrerSharePct         Int     @default(0)     // D1
CouponCampaign.distribution             String  @default("UNIQUE_PER_PATIENT")  // | SHARED_CODE (V2)
CouponCampaign.bindToPatient            Boolean @default(false) // default OFF — families share phones
CouponCampaign.maxRedemptions           Int?
CouponCampaign.maxDiscountBudgetInPaise Int?
CouponCampaign.maxDiscountPerBillInPaise Int?
CouponCampaign.dailyRedemptionLimit     Int?
TestDefinition.retestIntervalDays       Int?    // "due" belongs to the catalog, not the engine
```

`Patient.whatsappOptIn` keeps its meaning and becomes **service consent only** — comment change, no
migration. Auto opt-in on staff send may grant service; it must never grant marketing.

Deliberately not added: an `Event` table (§4), `AutomationVersion` (two integers do it),
`Conversation.automationRunId` (one phone, many patients, many runs — the pointer belongs on
`AwaitingReply`), a channel column (one channel exists).

---

## 4. Primitives

**Scope vocabulary.** Every predicate takes an explicit scope: `PATIENT · VISIT · TEST_ORDER ·
REPORT_VERSION · COUPON · RUN`. A patient-scoped predicate may not be used where a visit-scoped one
exists — that is what makes "diagnostics **for this visit**" a type rule rather than a code review.

**Triggers are a sweep; hooks are latency.** The tick asks both "what is due?" and "what is newly
eligible and not yet enrolled?", each bounded by `LIMIT`. The in-request hook stays as an
optimisation. Because enrolment is idempotent on `(automationId, subjectId, cycleKey)`, a dropped
hook, a duplicated hook and a crashed request all converge on exactly one run. No event table.

Trigger kinds in V1: `EVENT` (visit completed · report finalized · bill created · inbound message),
`SCHEDULE` (time of day, branch scope), `ONE_OFF` (a broadcast — the one place the audience *is* a
back-fill, gated by a mandatory dry run and a typed confirmation, never a click).

**Trigger payloads carry identity only, never values.** Every condition re-reads live state at action
time. The payload type has no field for a value, so this is an engine rule, not a discipline.

**Re-entry** is declared, not computed: `definition.reentry = { mode, days? }` compiled to the
`cycleKey`. Two orthogonal questions, both needed:

```
mode:       PER_EVENT | ONCE | EVERY_N_DAYS | WHILE_ELIGIBLE   -- may they enrol again?
concurrency: ALLOW_PARALLEL | ONE_ACTIVE_PER_PATIENT           -- may two runs be live at once?
```

`PER_EVENT + ALLOW_PARALLEL` is right for clinic recovery: three visits are three conversion
opportunities and three live runs. `ONE_ACTIVE_PER_PATIENT` is right for an annual-checkup reminder,
where a second live journey is just a second voice saying the same thing. The second was missing and
is not expressible by any frequency rule.

**Predicates take an injectable context**, not a bare Prisma call: `(ctx, subjectId, now) → value`.
`ctx` is a repository interface — the real one in production, an overlay in simulation. This costs
nothing on day one and cannot be retrofitted cheaply: a predicate written against Prisma directly has
to be rewritten to be simulatable, and the simulation screen is what proves the engine to an operator.

```
hasDiagnosticsFollowing(patientId, sinceVisitId, days)  → bool     // patient-level, D3
lastVisitAgeDays(patientId)                             → int
outstandingDueInPaise(visitId)                          → int
reportOpened(visitId)                                   → bool
visitStatus(visitId)                                    → enum
couponState(runId)                                      → ISSUED|REDEEMED|EXPIRED|null
patientAgeYears(patientId) · patientGender(patientId)
resultOf(testOrderId, testCode)                         → Result    // V2 conditions, V1 interface
resultHistory(patientId, testCode, limit)               → Result[]  // V2, declared now
retestDueAt(patientId, testCode)                        → Date|null // TestDefinition.retestIntervalDays
```

**The goal is declared once and read twice.** `definition.goal = { predicate, windowDays }` — the
stop condition is "goal achieved", and a conversion is "goal achieved within `windowDays` of
`triggeredAt`". One definition, two uses, so "stopped early" and "converted" cannot drift into two
numbers. Never two subsystems, and never a per-automation invention of what converted means.

**The clinical interface is a projection over what already exists** — `TestResult` plus
`resolveByTestDefinition()` (`referenceRangeService.ts:229`), which already resolves range, unit and
clinician-set critical bounds by age and gender:

```
Result = { value, textValue, flag,
           referenceMin, referenceMax, referenceUnit,
           criticalMin, criticalMax, finalizedAt, reportVersionId }
```

**Unit safety.** A numeric condition stores the unit it was authored against, and the run **fails
loudly** if the resolved unit differs. `HbA1c > 7` is true in % and absurd in mmol/mol, and nothing in
the number says which. This is the only clinical rule the engine owns.

**Actions.** `sendTemplate(name, params)` · `issueCoupon(campaignId)` · `ask(template, buttons[])` ·
`replyFreeForm(text)` · `handoffToStaff(reason)` · `stop(reason)`.

**Template parameters are bound per step and validated at save time** against the template definition
from `listMessageTemplates()`. An arity mismatch caught at send time fails in production for every
patient in the run.

**Free-form is a channel decision, not an engine one.** The engine calls
`channel.canSendFreeForm(phone)`; today that is `isWindowOpen(lastInboundAt)` (`inbox.ts:57`). The
step design never depends on the answer staying true — anything behind a wait is a template
regardless — so a Meta policy change edits one function and no automation. Window shut and no
template fits → `handoffToStaff`, never a silent drop.

**Communication policy — three outcomes, not two:**

```
communicationPolicy(patient, category, now) → SEND | DEFER(until) | DROP(reason)
```

checked in order:

```
DECEASED · NO_PHONE · PHONE_OPTED_OUT (per number) · NOT_OPTED_IN_MARKETING (per patient) · LINK_DISABLED ·
CRITICAL_VALUE · HUMAN_HOLDS_THREAD · LINE_HELD_BY_ANOTHER_RUN · TEMPLATE_PAUSED ·
OFFER_EXHAUSTED · FREQUENCY_CAP → DEFER · QUIET_HOURS → DEFER · HOLDOUT
```

`HUMAN_HOLDS_THREAD` suppresses **marketing only** — a report-ready message still reaches a patient
while staff are mid-conversation. Holdout sits last on purpose: a held-out run is enrolled, every
condition evaluated, the send skipped, the row logged. That is what makes it a control group rather
than an exclusion.

**Steps** are an array with `stepIndex` on the run. No DAG. A branch is a second automation until
there are three of them.

**A wait is anchored, not accumulated.** Each wait step declares where it counts from:

```
{ anchor: 'TRIGGER', day: 10 }            // Day 10 after the clinic visit
{ anchor: 'PREVIOUS_STEP', hours: 72 }    // 3 days after the last step ran
```

`TRIGGER` is the default and the one the canonical journey uses, for a reason that is not only
authoring convenience: **relative waits accumulate drift.** If the Day 2 message defers ten hours to
clear quiet hours, or retries after a transient Meta failure, every downstream `+3 days` shifts with
it and a three-touch journey arrives on Day 2.4 / 5.4 / 8.4. Anchored to `run.triggeredAt`, Day 10 is
Day 10 whatever happened before it — and `nextActionAt` is computed from a fixed instant rather than
from whenever the last step finished.

**Catch-up rule.** If an anchored time is already past when the run reaches that step (the automation
was paused, an earlier step ran late), the step runs immediately — within the same 8-hour grace
`automatedMessageService` already uses for a missed day sheet. Past the grace, the step is skipped
with `MISSED_WINDOW` and the run continues to the next one. A Day-10 nudge delivered on Day 13 is
worse than not sending it.

**"Due" and "sent" are two different facts.** A step is *due* on the day the journey says; the
communication policy may *delay execution* until the patient is eligible again. The step's due day
never moves, and no screen may imply it did — the operator configured a Day 15 journey and it stays
one.

**A policy delay never rewrites the journey.** Day 10 and Day 15 are both proactive and five days
apart, so the policy may hold the third send until Day 17. The automation is still a **Day 2 / 10 / 15
journey** — it does not silently become a Day 17 journey, because an operator has to be able to reason
about the thing they configured.

Concretely: **an expiry stops the journey from starting new steps; it never kills a step already due.**
"Stop: Day 15" means no step begins after Day 15, not "cancel the send that is queued behind the
frequency policy". The activation screen shows the configured day and the possible delay side by side
— `Day 15 · may be held to Day 17` — so the collision is visible before activation, not discovered
afterwards.

**Pause and Stop are different controls.** Pause stops enrolling and lets in-flight runs finish.
Stop kills in-flight runs with `stopReason = STOPPED_BY_OWNER`. Same word today, opposite
consequences.

---

## 5. Measurement

- **Holdout key is `hash(automationId + patientId)`**, never `subjectId`. Keyed on a visit, the same
  patient gets an independent coin flip per visit and can be treated once and held out the next time,
  contaminating both arms.
- **Conversion window** is `definition.conversionWindowDays`, anchored to `run.triggeredAt` — **not
  to the send**. The holdout has no send; anchoring there makes the arms incomparable. Default 14.
- **A conversion is a claim the sweep can revoke.** Runs converted in the last 30 days are re-checked;
  a refunded or cancelled basis sets `stopReason = CONVERSION_REVERSED`. Visit completion is **not
  monotonic** here (`reopenVisitForEntry`), so an engine that assumes it is will be wrong quietly.
- Results counts **delivered**, not sent. `MessageStatus` already carries the distinction.
- Report the interval, not just the point estimate: at n≈3,000 vs 341 the design detects a six-point
  lift and cannot detect a two-point one, and the screen should say so.

---

## 6. Execution

The existing 5-minute ticker (`index.ts:425`), one connection per tick:

```sql
SELECT … WHERE state='PENDING' AND "nextActionAt" <= now()
ORDER BY "nextActionAt" LIMIT 50 FOR UPDATE SKIP LOCKED
```

Claim before send, always. **The PENDING table is the queue and `LIMIT 50` is the throttle** — a
600/hour ceiling against Meta's 80/second, so a 2,000-patient broadcast self-drains over three hours
instead of stampeding. No queue service, no rate limiter.

**Retries are classified, not uniform.** `MessageLog.errorCode` already stores the Meta code:
transient (rate limit, timeout) → backoff and retry, capped by `run.attempts`; permanent (invalid
number, template rejected) → stop, no retry. After N consecutive failures on one template the
automation pauses itself — a campaign firing into a rejected template burns the WABA quality rating
for every message the centre sends, report-ready included. FAILED runs on Activity are the
dead-letter queue.

**Offer budgets are checked at redemption, not issue** — an issued coupon is a promise, a redeemed one
is money — and via an **atomic conditional update** on the campaign counter, or two simultaneous bills
both pass the last-rupee check.

---

## 7. Build order

1. **Predicate library + offline harness** — `npm run automations:check`, no model calls, no sends,
   the way `pulse:check` works. The code that decides whether to message 2,000 people gets a test
   before it gets a UI. **The named case that must be in it from day one:** a patient enrolled on
   Day 0, messaged on Day 2, who has diagnostics on Day 6 — the Day-10 check stops the run, and
   **no Day-10 message, no Day-15 message and no coupon are produced**. That single assertion is the
   whole product working; every other test is detail.
2. **Consent split · STOP from the webhook · `deceasedAt`.** Useful with zero automations built.
3. **`AutomationRun` + `AutomationStepLog` + sweep/ticker; migrate `DAY_SHEET`.** Proves the engine on
   a live automation with no patient risk.
4. **Communication policy (SEND/DEFER/DROP) · `templateCategory` · retry classification · circuit breaker.**
5. **Builder UI · template parameter binding + arity validation · dry run · Activity.**
6. **Holdout (patient-keyed) · conversion window · reversal sweep · Results.**
7. **Clinic → diagnostics recovery.** D1, D2, offer budgets and patient binding land with it.
8. **`AwaitingReply` + migrate the hardcoded BOOK path** — that migration is the fix for the live
   shared-phone misattribution at `webhooks.ts:345`.

---

## 8. Not built

**V2:** result-triggered automations (settle delay + critical block) · result trends and history
conditions · shared campaign codes · discount rules beyond larger-wins · inactivity and
relative-to-due triggers · saved audiences.

**Future:** per-patient monitoring plans · second channel · conversation SLAs and teams ·
provider conversation ids.

**No:** an event table · a run pointer on `Conversation` · four priority tiers · message merging ·
an approval workflow while access is owner-only · an `AutomationVersion` table · a clinical rule
editor · a DAG or flow canvas · segment builder · intent classification · free-text clinical Q&A ·
A/B arms · metric-threshold triggers (that is Pulse, and a second definition of "revenue today" is
the exact failure `pulse:check` exists to prevent).

The conversational surface is a **menu, not a conversation**. Buttons carry the run id — the only
exact correlation key WhatsApp offers — so `extractInbound` must stop discarding `button.payload`
(`webhooks.ts:131`). Free text that matches nothing is not a failure; it is the handoff.

---

## 9. Round-3 semantics

Answers to the P0/P1 list. Where one contradicts an earlier section, the earlier section has been
edited rather than left standing.

### 9.1 Triggers are `Entity.Transition`, and the registry is honest about what exists

A trigger is not a business event someone thought of — it is **an entity moving into a state**,
registered as `<Entity>.<Transition>`. Adding one is a registry entry; the picker renders the
registry. That is the generic primitive.

What this schema can actually fire on today:

| Entity | Transitions | Source |
|---|---|---|
| `Visit` | Created · Waiting · InProgress · Completed · Cancelled · **Reopened** | `VisitStatus`, `reopenVisitForEntry` |
| `TestOrder` | Created · Cancelled · Refunded · ClosedFilmsOnly · Reopened | `cancelledAt`, `OrderRefund`, `noReportAt`, `reopenedAt` |
| `ReportVersion` | Finalized · **Superseded** · Opened | `ReportStatus`, version chain, `ReportAccessLog` |
| `Bill` / `PaymentTransaction` | Created · Paid · PartiallyRefunded · Refunded · StillDue | `PaymentStatus` |
| `Coupon` | Issued · Viewed · Redeemed · Expired · Voided | `CouponStatus`, `LinkAccessLog(COUPON)` |
| `Conversation` | InboundReceived · AssignedToStaff · Closed | `Conversation`, `ConversationMessage` |

**What does not exist and must not appear in the picker:** there is no `Appointment` model in this
schema — no booking, confirmation, reschedule or cancellation. Rendering "appointment no-show" would
be UI promising data that has no source. The one exception worth noting: a clinic **no-show is
derivable today** as a `ClinicVisit` that reached `WAITING` and never reached `IN_PROGRESS`, so it is
a legitimate registry entry. Sample collected / rejected / delayed have no state anywhere and are
simply not available until the workflow models them.

**Amendment.** Sobhana has no amendment event — a finalized result is corrected by editing in place.
`ReportVersion.Superseded` is therefore the closest real signal, and §9.6 says what a run does with it.

### 9.2 A run is `automation + version + subject + cycleKey`, and the subject is the event

Already the model (§3). Stated as the rule it is: **the triggering entity is the run's subject and is
frozen at enrolment.** Three clinic visits are three runs with three subjects; a condition evaluated
"since this visit" reads the run's own subject and cannot accidentally read the patient's whole
history. A predicate that takes only `patientId` may not be used where a subject-scoped one exists.

Limit, stated honestly: the run is keyed to the **entity**, not to a distinct event id. A second
transition of the same kind on the same entity (a visit completed, reopened, completed again) is
deduplicated by `cycleKey`, not treated as a new event. That is the right default here — the second
completion of one visit is the same conversion opportunity — and it is the thing to revisit if an
entity ever needs two live runs of the same automation.

### 9.3 Reactive vs proactive — the cut that matters, not Meta's

Meta's UTILITY/MARKETING split is a billing classification and it groups the wrong things. The
distinction that governs contention is **who started it**:

- **Reactive** — the patient did something and this is the answer: report ready, bill, OTP, a reply
  in an open conversation. **Never capped, never deferred, never suppressed by handoff.** Five in a
  day is five things that happened.
- **Proactive** — we initiated: an unopened-report nudge, a due reminder, an offer. These contend
  for one person's attention and are capped across **all** automations.

**Contention is resolved in one fixed order, every time.** "The more important one goes first" is
ambiguous the moment three journeys compete, so the order is total and deterministic:

```
1. Hard safety      deceased · critical value · no clinical content rule
2. Consent          service vs marketing, per patient
3. Opt-out          STOP — per phone number, not per patient (§9.x)
4. Channel          no usable number · template paused or rejected
5. Conversation     a person holds this thread → marketing only is suppressed
6. Frequency cap    → DEFER, never DROP
7. Quiet hours      → DEFER
8. Automation priority   1–5, declared on the automation
9. Longest-waiting run   the only tie-break; runs are never ordered by id or by chance
```

Steps 1–5 DROP with a reason. 6–7 DEFER with a time. 8–9 order what remains. Two runs can never both
win, and the same two runs always resolve the same way — which is what makes
`WAITING_ANOTHER_AUTOMATION`, printed with the name of the journey that took the slot, a true
statement rather than a guess.

This lives in `communicationPolicy()` (§4), not inside any automation. One place owns consent,
frequency, quiet hours, priority, channel availability and conversation ownership; every automation
asks it the same question.

### 9.3b Three different eligibilities, and Stop owns only the first

Stop was carrying too much. Separate them:

| | Question | Owner | Failure mode |
|---|---|---|---|
| **Journey eligibility** | May this run continue at all? | the goal predicate + expiry | run ends |
| **Step due** | Is this step scheduled to happen now? | the anchored day (§4) | step waits |
| **Action eligibility** | May this action execute at this moment? | `communicationPolicy()` | DEFER or DROP |

A step can be *due* and its action *not eligible* — that is the Day 15 case, and it is not a stop.
Only journey eligibility ends a run. Conflating action eligibility into Stop is how an operator ends
up with a journey that quietly expired because one send was throttled.

### 9.4 Counting: visits, patients and runs are three different numbers

"3,412 patients match" was wrong wherever the trigger is per-visit. Every screen now reads:

```
3,412 qualifying visits · 3,198 unique patients · 2,863 eligible to be messaged today
```

The denominator on Results is **enrolled runs**, and the label says so.

### 9.4b Every action is idempotent, keyed on (run, step)

The ticker can execute a step twice — a crash between the action and the state write, a slow tick, a
second instance. Every side effect therefore carries an **idempotency key of `runId:stepIndex`**:

- `sendTemplate` → the key is stored on `MessageLog` before the provider call; a replay finds the row
  and does not re-send.
- `issueCoupon` → `UNIQUE(automationRunId, stepIndex)` on `Coupon`. A replay returns the existing
  coupon rather than minting a second one against the same budget.
- `handoffToStaff` → the `AwaitingReply`/assignment write is a compare-and-set, as the day-sheet
  ticker and the inbox auto-reply already do.

This is invisible in the UI and it is the difference between a patient getting one code and two.

### 9.5 An action is atomic, and an issued coupon reserves budget

A step that sends a message *and* issues a coupon must not leave a coupon behind when the send fails,
and must not let two workers spend the last of a budget.

```
claim the step  →  reserve budget (atomic conditional update on the campaign)
                →  mint the coupon as PENDING
                →  send the message (the code is in the body, so it must exist first)
                →  success: activate the coupon    failure: void it, release the reservation
```

A `PENDING` coupon that never activates is swept and its reservation released. The campaign tracks
**two** numbers — `reservedInPaise` (issued, unexpired) and `committedInPaise` (redeemed) — and stops
issuing when `reserved + committed` reaches the cap. Counting only redemptions lets you issue three
times the budget and discover it when redemption catches up.

### 9.6 Runs have explicit states, and nothing is called "messaged" that was not

```
ENROLLED · WAITING · DUE · SKIPPED(reason) · HELD_OUT · SENT · DELIVERED · READ ·
FAILED(reason) · DEFERRED(until) · HANDED_OFF · STOPPED(reason) · EXPIRED · REVERSED
```

`SKIPPED_FREQUENCY_CAP`, `SKIPPED_NO_CONSENT` and `HELD_OUT` are distinct, and Results picks its
denominator explicitly rather than absorbing them into "messaged". A held-out run is still a control
subject; a skipped one is neither treated nor control and is reported separately.

**Result amended mid-run.** The run records the `reportVersionId` it evaluated. If a newer version
appears before the send, the run re-evaluates against it; if the newer version no longer satisfies the
condition, the run stops with `BASIS_CHANGED`. It never pretends the original reading did not happen —
the step log keeps both.

### 9.7 Aggregations, as predicate shape

`COUNT`, `SUM` and `LAST` over a window ship with V1 — they are one SQL statement each and they unlock
"more than 3 visits in 90 days" and "spend over ₹10,000 this year". `AVG`, `MIN`, `MAX` and
previous-versus-current comparisons are V2, on the same shape:

```
aggregate(entity, fn, field, window, scope) → number
```

Declaring the shape now means a new aggregate is a registry entry, not a new condition type.

### 9.8 Lifecycles that needed more states

**Coupon:** `PENDING → ISSUED → REDEEMED | EXPIRED | VOID`, plus `REFUNDED` when the redeeming order
is reversed (which also fires the conversion reversal in §5). *Delivered* and *viewed* are not new
states — they are already recorded in `MessageLog` and `LinkAccessLog(COUPON)`.

**Template:** `DRAFT · PENDING_APPROVAL · APPROVED · REJECTED · DISABLED · ARCHIVED`, with a
dependency view rather than a table: changing one prints **"3 automations affected · 843 active
runs"** before you change it.

### 9.9 Simulation is the harness with a screen on it

Pick a patient, optionally add events on a fake clock, and walk the journey. This costs almost
nothing because it is already required: the predicates are pure, the steps are an array, and build
step 1 is an offline harness that walks them. The screen is that harness with a UI, and it is where
the named test case (§7.1) lives for a human instead of CI.

### 9.10 Two audits, not one

Activity answers *what happened to patients*. Configuration changes go to the existing `AuditLog` and
surface on the Audit & Anomalies page that already exists: who changed Day 10 to Day 12, who activated
v4, who moved an offer from 15% to 10%. Nearly free, and the alternative is a six-month-old question
nobody can answer.

### 9.11 Deferred, deliberately

Permissions beyond owner-only (D5) · approval workflow · collapsible long journeys (worth it past
~12 steps, not before) · monitoring-plan layer · a flow canvas. The last one especially: at six to ten
steps the linear sequence is dramatically easier to read than a branch diagram, and nothing in the
first ten automations needs one.

