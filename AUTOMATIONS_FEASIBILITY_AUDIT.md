# Feasibility audit — does the backend keep the UI's promises?

Every claim below was traced against the code, not recalled. Files and lines cited are real.
The UI is taken as the desired end state; the question is only whether it can be honestly backed.

**Baseline:** "current architecture" = the schema and services as they exist today.
`AutomationRun`, `AutomationStepLog` and `AwaitingReply` do **not** exist yet — they are designed in
`AUTOMATIONS_LOCKED_V1.md` but unbuilt. Where a gap is "the spec already covers this", it is still
counted as missing, because nothing is written.

---

## Part A — the spine, link by link

```
ClinicVisit → AutomationRun → step → condition → wait → re-check → MessageLog → Meta
   → inbound webhook → Conversation → AwaitingReply → Coupon → Bill → payout → Results
```

| Link | Identifier that carries it | Exists? |
|---|---|---|
| Patient → Visit | `Visit.patientId`, `Visit.branchId`, `Visit.domain`, `Visit.status` | ✅ |
| Clinic detail | `ClinicVisit.visitId @unique`, `status`, `startedAt`, `completedAt` | ✅ |
| Visit → run | `AutomationRun.subjectId = visitId` | ❌ table absent |
| Run → step history | `AutomationStepLog` | ❌ absent |
| Run → message | `MessageLog.automationRunId` | ❌ column absent |
| Message → provider | `MessageLog.waMessageId` + status webhook | ✅ `webhooks.ts` updates SENT/DELIVERED/READ/FAILED with `errorCode` |
| Provider → inbound | `ConversationMessage.waMessageId @unique` | ✅ |
| Inbound → run | `AwaitingReply` | ❌ absent; today the patient is guessed from the phone (`webhooks.ts:345`) |
| Run → coupon | `Coupon.automationRunId` | ❌ column absent |
| Coupon → bill | `Coupon.redeemedBillId`, `Bill.couponId`, `Bill.couponDiscountInPaise` | ✅ |
| Bill → revenue | `Bill.totalAmountInPaise`, `paidAmountInPaise`, `PaymentTransaction` | ✅ |
| **Clinic visit → the diagnostics it caused** | — | ❌ **no link of any kind exists** |

That last row is the one that matters most, and §C.2 is about it.

---

## Part B — UI element → capability → support → gap → severity → smallest fix

### Builder and engine

| UI element | Required capability | Current support | Missing | Sev | Smallest fix |
|---|---|---|---|---|---|
| `WHEN a clinic visit is completed` | an enrolment trigger on `VisitStatus → COMPLETED` | Completion is computed inside route handlers (`diagnosticVisits.ts:628 reevaluateVisitCompletion`); **no event, no hook, no bus** | a sweep that finds newly-completed visits | M | tick query `WHERE status='COMPLETED' AND completedAt > watermark` + `NOT EXISTS(run)`; idempotent by `@@unique(automationId, subjectId, cycleKey)` |
| `a patient can have two running at once` | one run per visit, many per patient | nothing | `AutomationRun.subjectId` | M | the table |
| `Day 10 after the clinic visit` | anchored `nextActionAt` from `run.triggeredAt` | nothing | column | S | arithmetic on one column |
| `Checked live, the moment this step runs` | re-read predicates at action time | predicates don't exist; all logic is inline in routes | a predicate library | M | extract named `(subjectId, now) → value` fns; no schema change |
| `Stop conditions re-checked before every action` | the guard wraps coupon issue + task too | n/a | engine rule | S | one call site |
| `Importance: Normal` + contention order | cross-automation query at send time | nothing | `Automation.priority` + a `MessageLog` lookup by patient/category/window | S | one column + one indexed query |
| `Pause` vs `Stop` | stop enrolment vs cancel in-flight | nothing | `Automation.enabled` + bulk run update | S | two fields |
| `Stop for her` (patient-level) | cancel one run | nothing | `run.state='STOPPED'` | S | one update |
| **Simulation — "she does her tests on Day 6"** | evaluate predicates against **hypothetical** facts, not the DB | **nothing, and this is not a schema gap** — every existing query reads live Prisma | predicates must accept an injected fact overlay | **M** | define predicates as `(ctx, subjectId, now)` where `ctx` is a repository interface; pass a real one in prod and an overlay in simulation. Decide this **before** writing the first predicate — retrofitting it later means rewriting all of them |
| `3,412 qualifying visits · 3,198 patients` | count visits and distinct patients | ✅ both derivable | — | — | — |
| `v1` / `v2` on runs | version frozen at enrolment | nothing | `Automation.version`, `run.version`, `run.definition` | S | three columns |

### Patient 360

| UI element | Support | Missing | Sev | Fix |
|---|---|---|---|---|
| Timeline, glance, inspector | ✅ all real (`Patient360.tsx`, `GlanceStrip`, `VisitInspector`) | — | — | — |
| "Why she entered" | needs the qualifying values **as evaluated**, not recomputed | `AutomationStepLog.detail` | S | log the values at enrolment |
| "Why she was not messaged" | a skip must be a written row, not an absence | same | S | write a `SUPPRESSED` row every tick |
| "Why it stopped" | `run.stopReason` | S | one column |
| "What is next" | `run.nextActionAt` + `stepIndex` + frozen definition | S | columns |
| "Which visit caused it" | `run.subjectId` | S | column |
| Coupon card "holds 1 offer" | `Coupon` by `patientId` + `status=ISSUED` + `expiresAt` | ✅ **already queryable today** | — | — |
| "Issued by the recovery journey" | `Coupon.automationRunId` | S | one column |
| **"Every message she's had" — showing the message text** | reconstructing what the patient actually read | `MessageLog.templateParams` exists; **the template body does not**. `listMessageTemplates` returns today's `bodyText`, and Meta edits templates **in place** with no version id (`whatsappCloudService.ts:186` exposes `name`+`language` only) | `MessageLog.templateBody` snapshot | **M** | snapshot `bodyText` at send. Without it, any message sent before a template edit is **unreconstructable forever** |

### Messaging

| UI element | Support | Missing | Sev | Fix |
|---|---|---|---|---|
| Template picker, `paramCount`, `category` | ✅ `MessageTemplateSummary` already returns `category`, `bodyText`, `paramCount`, `hasHeaderMedia` | — | — | — |
| Blank-arity validation at save | ✅ compare `paramCount` to bound blanks | — | — | — |
| `Utility` / `Marketing` on a send | category known at send, **never persisted** | `MessageLog.templateCategory` | S | one column |
| **`Rejected` template state + "1 automation paused"** | observing a non-approved template | **`listMessageTemplates` filters `t.status === 'APPROVED'` and discards the rest**; the webhook handles `messages` and `statuses` only — **no `message_template_status_update` subscription** | stop filtering; subscribe to the template-status field; persist last-known status | **M** | until then, rejection is only detectable *after* N sends fail — which is the circuit breaker, and is a slower, noisier signal than the UI implies |
| Delivered / Read ticks | ✅ `webhooks.ts` writes `DELIVERED`/`READ`/`FAILED` + `errorCode` | — | — | — |
| Button reply → run correlation | `extractInbound` captures `msg.button?.text` and **throws away `button.payload`** (`webhooks.ts:131`) | keep the payload | S | one line — but it is the only exact correlation key WhatsApp gives |
| Inbound → which patient | **`webhooks.ts:345` derives the patient from the newest `MessageLog` for that phone.** With a shared phone this attributes the reply — and the coupon — to the wrong patient. Live bug. | `AwaitingReply.patientId` pinned at send | **M** | new table, one unique index |
| 24h free-form window | ✅ derived, `inbox.ts:57 isWindowOpen` | — | — | — |
| Handoff suppresses marketing only | `Conversation.assignedToId` ✅ exists; the category to compare against does not | `MessageLog.templateCategory` | S | same column as above |
| **Message cost (₹1,810)** | per-message or per-conversation billing data | **none. No cost field anywhere, and Meta bills per 24h conversation, not per message. The pricing webhook field is not subscribed.** | a cost source | **RED** | either subscribe to conversation pricing and store it, or delete the line. Do not estimate it — a made-up cost inside a profit calculation is worse than no cost |

### Consent and safety

| UI element | Support | Missing | Sev | Fix |
|---|---|---|---|---|
| Two switches (reports / offers) | `Patient.whatsappOptIn` is a single boolean; auto-set on staff send (`notificationService.ts:266`) | `marketingOptIn` + timestamps + source | S | four columns |
| **"Opt-out is per number"** (§20) | a STOP on a phone silences marketing to **every** patient on it | `PatientIdentifier` explicitly allows many patients per phone. A per-patient column **cannot express this** — and `AUTOMATIONS_LOCKED_V1.md` currently specifies `Patient.marketingOptOutAt`, which contradicts the UI | a `PhoneOptOut { phone @id, optedOutAt, source }` table | **M** | new one-column table. **This is a genuine contradiction between the locked spec and the wireframe; the wireframe is right** |
| "cannot be re-enabled by staff" | enforcement | nothing | S | omit the write path; not a schema issue |
| Deceased banner | `Patient.deceasedAt` | **does not exist** | S | one nullable column + one resolver line |
| Quiet hours, frequency cap | `MessageLog.createdAt` + category | category column | S | as above |
| `patientLinkDisabledAt` | ✅ exists and already suppresses report sends | — | — | — |
| Critical value never automated | ✅ `TestResultFlag.CRITICAL_HIGH/LOW` exists | — | — | — |

### Offers

| UI element | Support | Missing | Sev | Fix |
|---|---|---|---|---|
| Unique code per patient | ✅ `Coupon.code/token @unique`, `patientId`, `expiresAt`, `allowedProductIds[]` | — | — | — |
| Issue / redeem / expire / void | ✅ `CouponStatus`, `redeemCouponInTx` | — | — | — |
| **"Only the patient it was issued to may use it"** | compare redeemer to `Coupon.patientId` | **`validateCouponByCode` never reads `patientId`** — rejections are NOT_FOUND / ALREADY_REDEEMED / EXPIRED / VOID / CAMPAIGN_INACTIVE only (`couponService.ts:173`) | the comparison + `CouponCampaign.bindToPatient` | S | five lines. Today the binding is decorative |
| Budget `₹73,400 of ₹2,00,000` | sum of redeemed discounts vs a cap | no cap column; sum is computable | `maxDiscountBudgetInPaise`, `reservedInPaise`, `committedInPaise` | S | columns + an atomic conditional update, or two bills spend the last rupee twice |
| Per-bill cap `₹1,000` | clamp | `computeCouponDiscountInPaise` clamps only to subtotal | `maxDiscountPerBillInPaise` | S | one column, one `Math.min` |
| **"Larger discount wins"** | compute both, apply one, record the loser | `Bill` has `discountAmountInPaise` **and** `couponDiscountInPaise` as separate columns ✅ — but `couponService` currently **blocks** the combination, and there is **no field to record a discount that was not applied** | `Bill.rejectedDiscountInPaise` + reason | S | two columns + `resolveDiscounts(bill, candidates[])` |
| Referral share of the coupon | `payoutService.ts:278` allocates `billFinancials.discountAmountInPaise` **only**; `couponDiscountInPaise` is invisible to the payout allocator | `CouponCampaign.referrerSharePct` + one term | S | one column, one term |
| Shared campaign code (`DIWALI20`) | one code redeemed many times | `Coupon.code @unique` makes this impossible as modelled | mint-at-redemption mode | M | V2 per spec; do not ship the radio button before the mode exists |
| Duplicate coupon on a replayed step | idempotency | **no unique key ties a coupon to a run/step** | `@@unique(automationRunId, stepIndex)` | S | one index — without it a retried tick mints two codes against one budget |

### Clinical

| UI element | Support | Missing | Sev | Fix |
|---|---|---|---|---|
| `HbA1c > 7.0 %` | numeric value + resolved range + unit | ✅ `TestResult.value`, and `resolveByTestDefinition()` (`referenceRangeService.ts:229`) already resolves range, unit and critical bounds by **age in days and gender** | — | — | the interface exists and Smart Reports already uses it |
| `flag is High or Critical high` | ✅ `TestResultFlag` | — | — | — |
| Reference / critical bounds shown | ✅ `TestDefinitionRange.referenceMin/Max/referenceUnit/criticalMin/criticalMax` | — | — | — |
| **Unit guard** | the unit a condition was authored against | `referenceUnit` is on the **range**, nullable, and resolved live. `TestResult` stores **no unit snapshot**, so editing the catalog silently reinterprets history | unit on the condition + refuse on mismatch/null | S | store it in the condition JSON; this is the whole clinical safety rule |
| Qualitative results | ✅ `TestResult.textValue` | — | — | — |
| **"Result amended" handling** | detecting that a value changed after the run read it | **There is no amendment event.** A finalized result is corrected by editing `TestResult` in place (`finalizedAt` preserved). `ReportVersion` is immutable-once-finalized *by convention, enforced in code*, and corrections bypass it | compare `TestResult.updatedAt` to the run's evaluation time | **M** | store `evaluatedAt` + `reportVersionId` on the step log and re-compare. It is a heuristic, not an event — say so |
| Previous result / trend | history query over `TestResult` joined to finalized versions | ✅ computable | — | — | V2 per spec |
| **"Test due every 90 days"** | a due date | **nothing. No retest interval, no monitoring plan, no expected-event entity anywhere** | `TestDefinition.retestIntervalDays` | S | one nullable column on a table clinicians already edit |
| "tests advised at this visit" | — | **`ClinicVisit` has doctor, fee, ward, type, status, token. No prescription, advice or diagnosis field** | a flag at clinic close | M | the recovery automation targets *everyone who consulted*, not *everyone advised*. The copy was fixed; the targeting limit remains |

### Analytics

| KPI | Source of truth | Verdict |
|---|---|---|
| Qualified (3,412) | count of enrolled runs | ✅ once runs exist |
| Could be messaged / skipped breakdown | step-log rows with reason codes | ✅ once the log exists |
| Sent | `MessageLog.status` | ✅ |
| Delivered | `MessageLog.deliveredAt` from webhook | ✅ |
| **Read (1,944 · 67%)** | `MessageLog.readAt` | ⚠️ **provider-dependent.** Read receipts arrive only when the recipient has them enabled. The number is a systematic **undercount** of unknown size and is not controllable. Usable as a trend, not as a rate |
| Control group | deterministic hash on `(automationId, patientId)` | ✅ |
| **Converted (530)** | "a DIAGNOSTICS visit for this patient within N days of the clinic visit" | ⚠️ **heuristic.** No link exists between a clinic visit and the diagnostics it caused (`ClinicVisit.originalVisitId` is clinic→clinic follow-up only — `patientService.ts:474`, `bills.ts:75`). This count includes unrelated walk-ins |
| **Lift (+6.1 pts)** | treated minus held-back | ✅ **trustworthy.** Both arms carry the same bias, so it cancels. This is why the holdout is load-bearing rather than decorative |
| **Revenue ₹4,94,000** | lift × average basket | ⚠️ **derived, not summed.** Label it "estimated" |
| Discount given | sum of `Bill.couponDiscountInPaise` | ✅ exact |
| Referral commission on discount | once `referrerSharePct` lands | ✅ exact |
| **Message cost ₹1,810** | — | ❌ **no source at all** |
| Incremental profit | contains the two ⚠️ and the one ❌ above | ⚠️ only as honest as its worst input |

---

## 1. GREEN — supportable today, no new source of truth

Patient 360 page furniture · coupon issue/redeem/expire/void · coupon-by-patient lookup ·
bill discount and coupon-discount columns as separate lines · delivery and read webhooks ·
`errorCode` capture · conversation threads, 24h window derivation, webhook-retry dedup,
staff assignment, the auto-reply compare-and-set · template list with category, body and
param count · reference ranges, units and critical bounds resolved per patient ·
qualitative results · `patientLinkDisabledAt` suppression · tokenised links with
`LinkAccessLog(COUPON)` click logging · `ReportAccessLog` → report-opened ·
clinic no-show derivable (`WAITING` that never reached `IN_PROGRESS`) · `AuditLog` for
configuration changes · a 5-minute ticker with claim-before-send, IST arithmetic and grace ·
`$queryRaw` available for `FOR UPDATE SKIP LOCKED`.

## 2. YELLOW — small or medium, additive, no rewrite

**Small (columns and indexes):** `deceasedAt` · marketing consent columns ·
`MessageLog.automationRunId` + `templateCategory` + `templateBody` · `Coupon.automationRunId` +
`@@unique(automationRunId, stepIndex)` · `LinkAccessLog.automationRunId` ·
`CouponCampaign.referrerSharePct` / `bindToPatient` / budget + per-bill cap / reserved + committed ·
`Bill.rejectedDiscountInPaise` + reason · `TestDefinition.retestIntervalDays` ·
`Automation.priority` · `Conversation.assignedAt` + `handoffReason` · keeping `button.payload`.

**Medium (new tables or new mechanisms):** `AutomationRun` · `AutomationStepLog` ·
`AwaitingReply` · `PhoneOptOut` · the predicate library · the enrolment sweep ·
`message_template_status_update` webhook subscription + unfiltered template list ·
`resolveDiscounts(bill, candidates[])` · shared-code coupons (V2).

## 3. RED — the UI currently overpromises

1. **Message cost, and therefore "estimated incremental profit".** No cost data exists anywhere and
   Meta bills per conversation, not per message. Either subscribe to conversation pricing and persist
   it, or remove the line. An invented cost inside a profit figure is the worst possible outcome.
2. **Absolute conversion and revenue.** "530 came in · ₹4,94,000" rests on a time window, because
   nothing links a clinic visit to the diagnostics it caused. The **lift is sound**; the absolutes are
   not. The screen must say "within 14 days of the visit", not imply causation.
3. **Read rate as a percentage.** Provider-dependent and systematically undercounted.
4. **Template `Rejected` shown as a live state.** The service drops non-approved templates and no
   template-status webhook is subscribed; today rejection is only inferred from N failed sends.
5. **Reconstructing a message a patient received.** Meta edits templates in place with no version id,
   and `MessageLog` stores no body snapshot. Every message sent before an edit is unreconstructable —
   permanently, retroactively.
6. **"Opt-out is per number."** Contradicts the locked spec's per-patient column. The wireframe is
   right and the spec must change.
7. **Simulation against hypothetical events.** Not a data gap — an engine-shape decision that must be
   made before the first predicate is written, or every predicate needs rewriting.
8. **"Result amended" as an event.** There is none; corrections are in-place edits. Only a timestamp
   comparison is available.

## 4. HIDDEN BACKEND CONTRACT

```
Enrolment   sweep(automation, watermark) → subjects not yet enrolled   [idempotent by cycleKey]
Predicate   (ctx, subjectId, now) → value                              [ctx injectable — §3.7]
Policy      communicationPolicy(patient, phone, category, now)
              → SEND | DEFER(until) | DROP(reason)                     [total order, §9.3]
Action      execute(runId, stepIndex, action)                          [idempotent on runId:stepIndex]
Log         every tick writes one AutomationStepLog row, skip included
Clinical    resolveByTestDefinition(testDefinitionId, patient) → range+unit+critical   [exists]
Channel     canSendFreeForm(phone) · sendTemplate → waMessageId · status webhook       [exists]
Correlate   AwaitingReply(phone) → runId + pinned patientId
Money       resolveDiscounts(bill, candidates[]) → applied[] + rejected[{reason}]
Budget      atomic conditional update on (reserved + committed) < cap
```

## 5. DATA MODEL GAPS

Entities: `AutomationRun`, `AutomationStepLog`, `AwaitingReply`, `PhoneOptOut`, `Automation`.
Fields: every column in §2. Timestamps: `run.triggeredAt` (conversion anchor), `evaluatedAt` on the
step log, `deceasedAt`, marketing consent timestamps. Indexes: `(state, nextActionAt)` partial,
`@@unique(automationId, subjectId, cycleKey)`, `@@unique(automationRunId, stepIndex)` on Coupon,
`MessageLog(patientId, createdAt)` for the cap. State machines: run state, coupon state (add
`PENDING`, `REFUNDED`), template status.

## 6. EVENT MODEL GAPS

There is **no event infrastructure of any kind** — no bus, no outbox, no domain events. Completion,
finalization and payment are side effects inside route handlers. The spec's answer (a sweep, with
in-request hooks as latency only) is the right one for a 512MB box with an OOM history, but it must be
written down as the mechanism, because "on visit completed" in the UI implies an event that does not
exist. Missing correlation ids: run id on messages, coupons and link logs; button payload on inbound;
pinned patient id on a reply.

## 7. EXECUTION ENGINE GAPS

Everything. There is one special-purpose ticker (`automatedMessageService`) that sends two day sheets.
Missing: multi-step runs, waits, re-checks, stop conditions, re-entry, concurrency control, priority,
retry classification, pause/stop, per-patient stop, frozen definitions, versioning, holdout bucketing,
conversion reversal, and the simulation harness. The ticker's **shape** is correct and proven —
claim-before-send, one connection per tick, unique key as the safety property — so this is extension,
not redesign.

## 8. UI THAT SHOULD NOT BE BUILT YET

- The **message cost** row and the **incremental profit** total that consumes it.
- The **`Rejected` template badge** as a live status, until the status webhook exists.
- The **shared-code** radio on the offer form, until mint-at-redemption exists.
- **Result-based conditions**, until the unit guard and the amendment heuristic are implemented —
  the screen is honest about the boundary, but the guard is what makes it safe.
- Anything that presents **absolute conversions as caused**. The lift may ship; the absolutes need
  the window stated in the label.

## 9. OVERALL FEASIBILITY

**~85% of this UI is implementable correctly** on the current architecture plus the additive changes
in §2 — all of which are new tables and nullable columns beside the existing model, with no rewrite of
billing, reports, payouts or messaging. The existing foundations are stronger than expected: the
clinical range resolver, the coupon lifecycle, the conversation model, the delivery webhook and the
ticker pattern are all real and all reusable.

**The residual ~15% is not a build problem, it is a truth problem**, and no amount of engineering
fixes it:

- **~5%** — message cost has no source and cannot be inferred.
- **~7%** — no clinic-visit → diagnostics link exists, so absolute conversion and revenue are
  window-based estimates. The holdout rescues the *comparison* but never the *absolute*.
- **~3%** — read rate, template text history and amendment detection depend on a provider that does
  not give versions, guarantee receipts, or emit the events we would want.

Two of those are fixable by *adding a source of truth* rather than by architecture: subscribe to
conversation pricing, and capture "tests advised" at clinic close (which would also convert the
recovery automation from a window heuristic into a real link). Both are worth doing. Neither should
block V1.

**The single most consequential unbuilt decision** is the injectable predicate context (§B, simulation).
It costs nothing on day one and cannot be retrofitted cheaply, because every predicate written without
it has to be rewritten.
