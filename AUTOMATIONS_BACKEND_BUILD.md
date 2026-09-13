# Automations backend — what was built

Status: **backend complete, typechecked, 31/31 offline tests passing, nothing activated.**
Design: `AUTOMATIONS_LOCKED_V1.md` (rev 5) · audit: `AUTOMATIONS_FEASIBILITY_AUDIT.md` ·
screens: `automations-wireframes.html`.

Nothing sends. Every automation is created disabled with no watermark, so the first
message this system emits requires an owner to click Activate.

---

## 1. Files

| File | What it is |
|---|---|
| `prisma/schema.prisma` | 5 new models, 22 new columns — all additive |
| `prisma/migrations/20260913210000_automations_engine/migration.sql` | hand-written; no drops, no renames, no backfill |
| `src/services/automations/types.ts` | the definition shape + reason codes |
| `src/services/automations/context.ts` | **the injectable fact repository** — live and in-memory |
| `src/services/automations/predicates.ts` | the predicate library + condition evaluator with traces |
| `src/services/automations/policy.ts` | the one gate: SEND · DEFER · DROP |
| `src/services/automations/actions.ts` | idempotent send + coupon mint/activate/void |
| `src/services/automations/engine.ts` | enrolment sweep · step execution · conversion reversal · tick |
| `src/services/automations/inbound.ts` | STOP · button payloads · reply→run correlation |
| `src/services/automations/discounts.ts` | larger-wins resolution over a list |
| `src/services/automations/preview.ts` | dry run + simulation |
| `src/services/automations/queries.ts` | read models for every screen |
| `src/routes/automations.ts` | the API |
| `automations-check.ts` | the offline harness — `npm run automations:check` |
| `prisma/seed-automations.ts` | the first journey, as a draft |

Touched: `src/index.ts` (ticker + route), `src/routes/webhooks.ts` (button payload, STOP),
`src/services/couponService.ts` (patient binding, per-bill cap, PENDING).

---

## 2. Data model

**New tables.** `Automation` · `AutomationRun` · `AutomationStepLog` · `AwaitingReply` ·
`PhoneOptOut`.

**New columns.** `Patient.marketingOptIn/At/Source`, `Patient.deceasedAt/deceasedByUserId` ·
`Visit.sourceVisitId` · `MessageLog.automationRunId/automationStep/templateCategory/templateBody` ·
`Coupon.automationRunId/automationStep` · `CouponStatus.PENDING` and `.REFUNDED` ·
`CouponCampaign.referrerSharePct/distribution/bindToPatient/maxRedemptions/maxDiscountBudgetInPaise/maxDiscountPerBillInPaise/reservedInPaise/committedInPaise` ·
`Bill.rejectedDiscountInPaise/rejectedDiscountReason` · `TestDefinition.retestIntervalDays`.

**Three indexes carry the safety properties.** `UNIQUE(automationId, subjectId, cycleKey)` is
re-entry, idempotency and deduplication at once. Two **partial** unique indexes —
`MessageLog(automationRunId, automationStep)` and `Coupon(automationRunId, automationStep)`, both
`WHERE automationRunId IS NOT NULL` — are what stop a replayed tick sending twice or minting a
second code against one budget. Partial, so the millions of ordinary rows are untouched.

---

## 3. The twelve items

**1–2 · `AutomationRun`, `AutomationStepLog`.** Built. The run is anchored to ONE triggering
entity: three clinic visits are three runs, and a condition reads the run's own subject, so
"diagnostics for this visit" cannot decay into "diagnostics ever". The step log is append-only and
records **the values as they were read**, which is why "why she entered" survives the data changing
afterwards — including the steps that chose to do nothing.

**3 · The injectable predicate context.** Every predicate is `(ctx, subject, args)`. `prismaContext`
reads the database; `memoryContext` answers from a plain object. This is what makes the simulation
screen possible at all — "she does her tests on Day 6" is a fact that is not in the database and
never will be — and it is the one thing that could not have been retrofitted cheaply, because every
predicate written against Prisma directly would have had to be rewritten.

**4 · wait → re-check → action.** Steps are an array with `stepIndex` on the run. Waits are
**anchored to `triggeredAt`**, not chained: a ten-hour quiet-hours delay on Day 2 does not push Day
10 to Day 10.4. A step already past runs inside an 8-hour grace and is skipped beyond it, because a
Day-10 nudge delivered on Day 13 is worse than not sending it.

**5 · Enrolment.** A sweep, not an event bus. This codebase has no event infrastructure — completion
and finalization are side effects inside route handlers — and adding a bus means a second write on
every one of them, on a 512MB box with an OOM history. Because enrolment is idempotent on the unique
key, a dropped hook, a duplicated hook and a crashed request all converge on exactly one run, so the
sweep is the correctness and any in-request hook would only be latency.

**6 · Idempotency and concurrency.** Claiming is a compare-and-set from `PENDING` to `RUNNING` —
the same idiom the day-sheet ticker and the inbox auto-reply already use, and no transaction pinning
on a pooled Neon connection. Side effects are keyed on `(runId, stepIndex)` behind the partial unique
indexes. Retries are classified: a permanent failure stops the run, a transient one backs off and
tries again up to four times rather than losing the message.

**7 · Correlation.** `MessageLog` and `Coupon` both carry the run and step. Inbound replies resolve
through `AwaitingReply`, whose single-column primary key means one automation may hold one phone
line and a second is refused by the database. `extractInbound` now keeps `button.payload` — the only
exact correlation key WhatsApp offers.

**8 · Visit → diagnostics attribution.** `Visit.sourceVisitId`, plus **two deliberately different
predicates**: `testDoneSinceThisVisit` is generous and drives suppression (being wrong costs one
unsent message); `testAttributedToThisVisit` is strict and drives attribution (only a captured link
counts). One condition cannot serve two precisions that want opposite answers, and the old design
used one for both.

**9 · Message content.** `MessageLog.templateBody` snapshots the body at send. Meta edits templates
in place and exposes no version id, so without this every message sent before an edit was
unreconstructable — retroactively.

**10 · Consent and opt-out.** `Patient.marketingOptIn` is per patient; `PhoneOptOut` is per **number**,
because `PatientIdentifier` documents that families share a handset and a per-patient column cannot
express "this phone said stop". Opt-out is broad, opt-in is narrow. An inbound STOP writes the row,
stops every live run on that number, and **cannot be lifted by staff** — only by the patient replying
START.

**11 · Coupons.** `validateCouponByCode` now compares the redeeming patient when the campaign is
patient-bound — before this, "unique per patient" was decorative and any code worked for anyone
holding it. Budget is reserved by an **atomic conditional update** before minting, counting reserved
plus committed, so two bills cannot both spend the last rupee and a campaign cannot issue three times
its budget. A coupon is minted `PENDING`, promoted on a successful send, and voided with its budget
released on a failure. Shared codes are modelled but not built: `distribution` exists, mint-at-
redemption does not.

**12 · Metrics.** `messageCostInPaise` is returned as `null` with a note, in the API and on the
screen — Meta bills per 24-hour conversation and we ingest no pricing data, and a made-up cost inside
a profit total is worse than no total. Conversion is labelled "within N days, any branch" rather than
implied as caused. Revenue is marked estimated. Read counts say "at least". The lift carries its 95%
interval, because it is the one number that survives the window bias — both arms carry it equally, so
it cancels.

---

## 4. API

```
GET    /api/automations                     list + counts + cadence
POST   /api/automations                     create (always disabled, no watermark)
GET    /api/automations/:id                 definition
PUT    /api/automations/:id                 save — validates predicates AND template arity
POST   /api/automations/:id/activate        sets the watermark, bumps version
POST   /api/automations/:id/pause           stops enrolling; live runs finish
POST   /api/automations/:id/stop            also cancels every live run
GET    /api/automations/:id/preview         dry run — matches, and who would send today
POST   /api/automations/:id/simulate        walk a journey on a fake clock
GET    /api/automations/:id/results         funnel · skip breakdown · lift ± margin · money
GET    /api/automations/activity            filters: automation, outcome, patient, days
GET    /api/automations/runs/:runId         why entered · timeline · why stopped · what is next
POST   /api/automations/runs/:runId/stop    stop ONE patient's journey
GET    /api/automations/patients/:patientId Patient 360 section: runs + coupons held
GET    /api/automations/consent/:patientId  two switches + shared-phone state
PUT    /api/automations/consent/:patientId  staff toggle, with a reason; refuses to undo a STOP
GET    /api/automations/templates           name · category · body · paramCount
```

Owner-only, matching the existing Config Center gate.

---

## 5. Verification

```
npm run automations:check     31/31 — no database, no model, no sends, about a second
npm run build                 clean
npx tsc --noEmit              clean
```

The named case, which is the product working: **enrolled Day 0, messaged Day 2, tests on Day 6 → one
message, no Day-10 reminder, no Day-15 message, and no discount issued to someone who already paid
full price.** Also covered: the 2/10/15 cadence when nobody converts, conversion before the first
message and after the offer, anchored waits not drifting, holdout stability and distribution, all
twelve policy branches, generous-vs-strict scope, cancelled visits, the unit guard in both
directions, and larger-wins including the tie.

---

## 6. Deploying this

The migration is additive, so it is safe to apply while the current code is running.
`Dockerfile` runs `prisma migrate deploy` on start, so **a push to main applies it to the production
Neon database**. After deploy:

```
npx ts-node --transpile-only prisma/seed-automations.ts   # creates the draft journey
```

Then the three templates (`clinic_followup_v1`, `clinic_followup_reminder_v1`,
`final_recovery_v1`) need Meta approval before the automation can be activated — `PUT` refuses to
save a SEND step naming a template that is not approved.

The ticker is wired **outside** the `ANALYTICS_DATABASE_URL` gate. Worth noting separately: the
existing day-sheet ticker sits *inside* that gate, so day sheets do not run without Pulse's analytics
URL configured. That looks like an accident of the two being added together. Left alone here.

---

## 7. Known limits, carried forward

- **Message cost** has no source. Subscribing to Meta's conversation pricing webhook is the fix.
- **Absolute conversion** is window-based until `sourceVisitId` is actually populated at the front
  desk. The column exists; the capture point does not. The lift is unaffected.
- **Shared campaign codes** are modelled, not built.
- **Result triggers** are not wired to enrolment — the predicates and the unit guard exist and are
  tested, but the trigger kind is not yet in the sweep. Deliberate: V2.
- **Template rejection** is still only detectable by consecutive send failures; the
  `message_template_status_update` webhook is not subscribed, and `listMessageTemplates` still filters
  to APPROVED.
- **"Tests advised"** does not exist on `ClinicVisit`, so the recovery journey targets everyone who
  consulted, not everyone who was told to go. One checkbox at clinic close would change that.
