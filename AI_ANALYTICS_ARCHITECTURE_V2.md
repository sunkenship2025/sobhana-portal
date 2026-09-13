# AI Analytics Layer — Architecture V2 (measured)

Supersedes `AI_ANALYTICS_LAYER_PLAN.md`. Status: **DESIGN — no implementation code.**
Date: 2026-09-10.

**Everything below is measured against the live database and against DeepSeek V4 Flash.**
11 real API calls were spent (~27k input, ~1.5k output tokens — a fraction of a rupee).
Where I previously asserted, I now have numbers, and **two of my earlier assertions were wrong.**

---

## 0. What the experiments actually showed

### Measurement 1 — the schema is small

| Encoding | Tokens |
|---|---|
| `prisma/schema.prisma` verbatim | 25,140 |
| Full DDL (`CREATE TABLE`) | 7,135 |
| Compact `table(col:type)`, all 73 tables | **3,989** |
| ...as actually sent to DeepSeek with enums | **5,887** (measured) |

73 tables · 944 columns · 99 FKs · 35 enums · 311 MB.

### Measurement 2 — deterministic retrieval, 30 questions, zero LLM calls

A weighted keyword index + a 174 KB value index + FK-graph path expansion:

```
RECALL 30/30 = 100%
context tokens: min 105 · median 347 · p90 533 · max 578
```

No embeddings. No vector store. No LLM call. Retrieval runs in-process in ~0 ms.

### Measurement 3 — the A/B that decides the architecture

4 questions × 2 arms. Every generated SQL was **executed** and compared to a
hand-written control number.

| Question | Retrieved (~470 tok) | Full schema (5,887 tok) |
|---|---|---|
| Q1 "how many tests in August?" — wrong-table trap | **14,111 ✅** | **14,111 ✅** |
| Q2 "reports finalized in August?" — wrong-timestamp trap | **1,261 ✅** | **1,261 ✅** |
| Q3 "revenue in August?" — metric adherence | **190,092,453 ✅** | ❌ used `paidAmountInPaise WHERE paymentStatus='PAID'` |
| Q4 "patients with >2 tests in 90d" — complex HAVING | ❌ 99 (metric over-anchoring) | **1,456 ✅** |
| **Totals** | **3/4 · avg 469 tok · 1,594 ms** | **3/4 · avg 5,887 tok · 1,490 ms** |

**Three conclusions, two of which contradict what I claimed before:**

1. ❌ **I was wrong that a large schema causes wrong-table and wrong-timestamp errors.**
   DeepSeek V4 Flash handled all 73 tables correctly on Q1 and Q2 — including the
   `LabTest`(243, legacy) vs `TestDefinition`(443) vs `TestOrder`(29,784) trap, and
   including picking `finalizedAt` over `createdAt`. The model is better at schema
   navigation than I gave it credit for.

2. ❌ **I was wrong that retrieval buys latency.** 1,594 ms vs 1,490 ms — the
   retrieved arm was *marginally slower*. At 6k input tokens prefill is not the
   bottleneck. **The latency argument for retrieval is dead at this scale. Do not
   use it to justify the design.**

3. ✅ **The metric layer is what actually buys accuracy.** Q3 is the whole story:
   given the schema alone, the model invented a *plausible, executable, wrong*
   definition of revenue — collections on fully-paid bills. Against the controls:

   ```
   net revenue (correct)   ₹19,00,924.53
   gross (a likely error)  ₹20,35,849.00     ← 7% high
   what the model wrote    a third number entirely
   ```

### Measurement 4 — metric injection can *hurt* (the surprise)

Q4 failed in the retrieved arm at 99 instead of 1,456. Retrieval was **not** at
fault — `TestOrder` was retrieved. The cause was the instruction
`DEFINED METRICS — use these expressions VERBATIM`: the model forced a per-patient
`HAVING` question into the shape of the `unique_patients` metric.

One targeted call confirmed the diagnosis. Softening the header to *"use ONLY if the
question asks for exactly this quantity; if it needs a different grain, IGNORE these"*
produced the correct `TestOrder ⋈ Visit … GROUP BY patientId HAVING COUNT(*) > 2`.

> **Metric injection must be conditional and soft, never mandatory.** A metric is a
> definition on offer, not a template to force the question into.

### Measurement 5 — the finding that shapes everything else

After softening, the SQL still failed — on unquoted camelCase (`t.cancelledat`). A
**deterministic repair** (quote any known camelCase identifier, built from
`information_schema`, zero LLM calls) fixed the syntax. The query then ran clean and
returned:

```
control            1,456
model, repaired    1,410      ← 3% wrong, ZERO error signal
```

The model had added `AND t."noReportAt" IS NULL` and filtered on **visit** date
rather than **order** date. Both are defensible readings of "patients who had more
than two tests in the last 90 days".

> **This is the central problem of the whole feature.** The SQL is syntactically
> valid, semantically reasonable, passes every validator, executes without error —
> and is wrong by 3%. No schema context, no SQL parser, no `EXPLAIN`, no read-only
> role and no retry loop can detect it. **Only a defined metric eliminates it, and
> only for the questions a metric covers.**

Everything in Part A follows from this.

---

## Part A — The core recommendation

**Build the user's Architecture 3, with a conditional interpretation call.**

```
question → deterministic retrieval (0 LLM) → ONE DeepSeek call → deterministic
validation + repair → Postgres → deterministic response, LLM prose only when earned
```

Normal cost: **1 DeepSeek call**, ~470 input / ~150 output tokens, ~1.6 s.

The design principle the measurements force:

> **The system's accuracy comes from the metric layer, not from the retrieval.**
> Retrieval's job is to keep the prompt small, keep sensitive tables out of it, and
> scale past 73 tables — all real, none of them the accuracy story.

And the honest corollary:

> **Answers from defined metrics are exact. Answers from generated SQL carry
> irreducible definitional variance (~3% measured).** The two must therefore be
> *labelled differently in the UI*. A metric answer states a number. A generated
> answer states a number **plus the assumptions it rests on**, prominently.

That labelling is not a nicety. It is the only honest response to Measurement 5.

---

## Part B — How DeepSeek learns our database

Not by being told the schema. By being handed, per question, a **context pack**
assembled from a hand-authored **AI Metadata Catalog** — 26 analytics-relevant tables
out of 73, each carrying what the raw schema cannot express.

Evaluation of the eight approaches, scored on what was measured:

| # | Approach | Accuracy | Tokens | Latency | Complexity | Maint. | Verdict |
|---|---|---|---|---|---|---|---|
| A | Whole schema every prompt | 3/4 measured | 5,887 | 1,490 ms | trivial | free | **Viable but loses on money + leaks sensitive tables** |
| B | Live introspection per request | same as A | 5,887 | +DB round trip | low | free | **No** — same tokens, worse latency, no semantics |
| C | Static schema docs (markdown) | ≈A | 5–8k | same | low | rots silently | **No** |
| D | Semantic catalog (descriptions, aliases, rules) | **best** | 350–600 | same | medium | ~2 h/quarter | **YES — core** |
| E | Embedding / vector retrieval | ≤ F | 350–600 | +30–80 ms | high | index refresh | **No — proven unnecessary** |
| F | Hybrid deterministic retrieval + metadata | **best** | 350–600 | +~0 ms | medium | with D | **YES — core** |
| G | Metric layer only (my earlier V1 DSL) | exact but **narrow** | ~200 | fastest | medium | high | **Insufficient alone** — cannot express Q4 |
| H | **D + F + G combined** | **best** | **~470** | ~1.6 s | medium | manageable | **★ RECOMMENDED** |

**On embeddings, concretely and with evidence:** deterministic retrieval scored
**30/30 recall** at **174 KB** and **0 ms**, using a keyword index plus a value index
built from live data. An embedding index would need a model, a store, a refresh
pipeline, and ~30–80 ms per query, to beat 100%. **It cannot.** Do not build it.
Revisit only if (a) the catalog exceeds ~200 tables, or (b) the
`retrieval_low_confidence` counter in the query log shows users reaching for
vocabulary the catalog and value index do not contain.

### The catalog entry

Raw schema gives `name`, `type`, `nullable`. It cannot give any of the rest:

```js
TestOrder: {
  d: 'One billed test line on a visit. Test name/code SNAPSHOTTED at order time.',
  t: 'createdAt',                                    // the STABLE time column
  cols: 'id,visitId,branchId,testCodeSnapshot,testNameSnapshot,priceInPaise,' +
        'workflowMode(REPORTABLE|BILL_ONLY|EXTERNAL_UPLOAD|EVENT),cancelledAt,' +
        'noReportAt,payoutCategorySnapshot,productId,panelId,createdAt',
  k: 'test tests ordered workload throughput investigation procedure panel ' +
     'xray ultrasound scan did performed conducted volume',   // retrieval aliases
}
```

Four kinds of knowledge, in the layer that can hold each:

| Knowledge | Lives in | Why not elsewhere |
|---|---|---|
| tables, columns, types, FKs | **auto-generated** from `information_schema` | free, never stale |
| descriptions, aliases, synonyms | **hand-authored catalog** | not derivable; this is the business meaning |
| enum value semantics | auto-extracted + hand-annotated | `pg_enum` gives labels, not meaning |
| metric definitions | **metric registry** (SQL expression) | Measurement 3: the model invents these wrong |
| business rules (paise, IST, soft delete) | static rules block, ~90 tokens | apply to every query |
| entity values (test codes, branch names) | **value index**, built from live data | 174 KB, always current |

---

## Part C — Context retrieval

Four deterministic stages, no LLM, measured end-to-end at 100% recall:

**1 · Weighted keyword scoring.** Table name = 3, curated alias = 2, non-FK column
word = 1.

> Measured failure worth recording: my first version indexed **all** columns
> including `*Id`. Because `branchId` appears in ten tables, the word "branch"
> stopped discriminating and the `Branch` table fell out of the top-N — recall
> *dropped* and tokens *doubled*. **FK columns are join plumbing, not semantics, and
> must be excluded from the keyword index.**

**2 · Value index.** 1,026 terms → `(table, column, canonical values)`, built from
live `TestOrder.testCodeSnapshot`, `TestDefinition`, `Branch`, `Department`,
`BillableProduct`, `ReferralDoctor`. **174 KB in memory.** This is what makes
data-literal questions work at all:

```
"hba1c" → TestOrder.testCodeSnapshot IN ('GHB','HBA1C','HBA1C_OUTSIDE')
```

Note it returns **three codes**. A hand-written keyword list would have returned one
and silently halved the answer. It also caught that the branch is spelled
"Jagathgiri Gutta", not the "Jagadgirigutta" I had hand-typed into the catalog.

**3 · FK-graph path expansion.** BFS the shortest path between every pair of seed
tables and add the intermediates. This is what prevents invented joins: the model is
handed `TestOrder → Visit → Patient`, so it never has to guess a path.

**4 · Pack assembly.** Metrics (soft) → resolved entities → tables → joins → rules.

---

## Part D — The prompt DeepSeek actually receives

Verbatim output of the retriever for *"Show monthly diagnostic workload in Chintal
for the last 6 months"* — **237 tokens**, plus a ~350-token static (cacheable) system
prompt:

```
QUESTION
Show monthly diagnostic workload in Chintal for the last 6 months

REFERENCE METRIC DEFINITIONS — use ONLY if the question asks for exactly this
quantity. If it needs a different grain (per-patient, per-order, HAVING),
IGNORE these and write SQL from the TABLES below.
test_orders [count] Billed test lines, excluding cancelled.
  expr: COUNT(*)
  filter: o."cancelledAt" IS NULL
  time: o."createdAt"

RESOLVED ENTITIES — use these exact values
"chintal" → Branch.code IN ('CNT')

TABLES
TestOrder — One billed test line on a visit. Code SNAPSHOTTED at order time.
  id,visitId,branchId,testCodeSnapshot,testNameSnapshot,priceInPaise,
  workflowMode(REPORTABLE|BILL_ONLY|EXTERNAL_UPLOAD|EVENT),cancelledAt,
  noReportAt,payoutCategorySnapshot,productId,panelId,createdAt
  time: createdAt
Branch — Centre location. 4 rows: CNT, BLN, JGG, IDPL.
  id,name,code,isActive

JOINS
TestOrder → Branch

RULES
- money is Int paise
- time: col AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Kolkata'
- scope: branch=CNT
- soft delete: ReferralDoctor_Visit, DoctorPayoutLedger need deletedAt IS NULL
```

This is the Goldilocks level, and the A/B says so: it produced the **correct** net
revenue where 5,887 tokens of raw schema produced a wrong one. The wording of the
metric header is load-bearing — Measurement 4 showed the mandatory phrasing costs a
whole class of questions.

---

## Part E — Token & cost analysis

Measured per question:

| | Retrieved | Full schema |
|---|---|---|
| input tokens | **469 avg** (390–588) | **5,887** |
| output tokens | 122–174 | 113–183 |
| LLM calls | 1 | 1 |
| latency | 1,594 ms | 1,490 ms |
| **ratio** | — | **12.5× input** |

Architectures compared (relative cost, 1.0 = recommended):

| # | Shape | Calls | Input/question | Rel. cost | Accuracy |
|---|---|---|---|---|---|
| 1 | Full schema → SQL | 1 | 5,887 | **11×** | 3/4; **wrong on money** |
| 2 | LLM picks schema, then LLM writes SQL | 2 | ~1,400 + latency ×2 | **3.5×** | no measured gain over 3 |
| 3 | **Deterministic retrieval → 1 call** | **1** | **469** | **1.0×** | **best** |
| 4 | 3 + always interpret | 2 | 469 + ~350 | 1.9× | same SQL, nicer prose |
| 5 | 4 + always self-correct | 2–3 | +469 each retry | 2.4× | wasted when nothing failed |

**Recommended: Architecture 3, with the interpretation call conditional (Part I).**
Expected steady state ≈ **1.25 calls/question**.

Two honest caveats:
- DeepSeek reports `prompt_cache_hit_tokens`. A static full schema would cache well,
  narrowing Architecture 1's cost gap. **The cost case for retrieval is real but not
  overwhelming at 73 tables** — it becomes decisive as the schema grows.
- At current volumes, *every* option is affordable. **Choose on accuracy and
  security, not on cost.** Cost merely confirms the choice.

---

## Part F — Why this beats sending the whole schema

Only three of the reasons survived measurement. I am dropping the two that did not.

**Survives — 1. Metric adherence (decisive).** Q3. The model cannot invent a wrong
revenue definition when the right expression is in front of it. Worth 7%+ on the
number that matters most.

**Survives — 2. Sensitive tables never enter the prompt.** The full-schema arm sent
`ReportAccessToken`, `BillAccessToken`, `StatementAccessToken`, `PatientIdentifier`
and `User.passwordHash` to an external API on every question. The retrieved arm sends
26 curated tables and never those. This is a **privacy property of the prompt itself**,
independent of what the SQL is allowed to do — and it is arguably the strongest
argument of the three.

**Survives — 3. Decommissioned twins stay out.** The live schema contains **13 empty
tables** (`PanelDefinition`, `PanelTestItem`, `ExternalLab`, `ProductBranchPricing`,
`TestAgeRange`, …) and legacy duplicates (`LabTest` 243 rows vs `TestDefinition` 443).
The model got Q1/Q2 right anyway, so this is *insurance*, not a demonstrated win —
but it scales badly in the wrong direction as more tables are deprecated.

**Dropped — latency.** Measured 1,594 ms vs 1,490 ms. No gain. I claimed this before
without evidence.

**Dropped — "the model can't find the right table in a big schema."** It could.
Q1 and Q2 both correct against all 73 tables.

---

## Part G — Failure modes and mitigations

Ranked by measured or expected frequency.

| # | Failure | Evidence | Mitigation | Residual |
|---|---|---|---|---|
| 1 | **Silent definitional drift** — valid SQL, defensible reading, wrong number | **Measured: 1,410 vs 1,456** | Metric layer for anything defined; for the long tail, surface `assumptions` in the UI and label the answer as *generated, not certified* | **Irreducible.** Manage by disclosure |
| 2 | Wrong business definition (revenue) | **Measured: Q3 full-schema arm** | Metric registry injected on match; `reconcileWith` CI test against `ownerMoneyService` | Near zero |
| 3 | Metric over-anchoring | **Measured: Q4, 99 vs 1,456** | Soft metric header + explicit escape clause | Low; covered by eval |
| 4 | Unquoted camelCase identifier | **Measured, then repaired** | **Deterministic repair** from `information_schema` — 0 LLM calls | Near zero |
| 5 | Wrong timestamp column | Not observed | Catalog names one `time:` column per table; `updatedAt` never exposed | Low |
| 6 | Double counting via one-to-many join | Not observed | `unique_patients` metric uses `COUNT(DISTINCT)`; eval cases | Medium — watch |
| 7 | Wrong join path | Not observed | FK subgraph supplied explicitly | Low |
| 8 | Soft-delete forgotten | Not observed | Rules block + `baseFilters` on affected metrics | Low |
| 9 | Timezone error | Not observed | IST rule in every pack; controls confirmed | Low |
| 10 | Tenant leakage | — | **Scope injected by the app, not the model**; `analytics_ro` role | Near zero |
| 11 | Ambiguous question | Q1 "patients" = visits or people | Part J rules: default + state it | By design |
| 12 | Retrieval miss | 0/30 measured | `retrieval_low_confidence` logged; catalog aliases grow from it | Low |

---

## Part H — Semantic layer: what to define, what to generate

The rule the measurements support:

> **Define centrally when a wrong answer looks right.** Generate dynamically when a
> wrong answer looks wrong.

### DECIDED — "revenue" defaults to NET COLLECTED

Owner decision, 2026-09-10. Measured for August 2026 (IST):

| | Aug 2026 |
|---|---|
| net **billed** (old default, still the Money page headline) | ₹19,00,925 |
| net **collected** ← **NEW DEFAULT for "revenue"** | **₹18,93,725** |
| outstanding on Aug bills | ₹200 |
| refunds paid out in Aug | ₹22,489 |

**Gap: ₹7,200 = 0.4% of billed.** Low risk — this centre collects at point of service.

Three consequences:

1. **"Collected" itself has two readings, ₹7,000 apart.** Transactions *dated* in the
   period (cash-flow) vs cash against bills *billed* in the period (collections
   performance). **Default: the cash-flow reading**, stated in `provenance`; the other
   is offered as a follow-up chip.
2. **`net_billed` does not disappear** — it stops owning the word "revenue" and is
   renamed. It is still required: `outstanding` derives from it, and the identity
   `collected(cohort) + outstanding = net_billed` reconciles **to the rupee** (verified).
3. ⚠️ **The Money page headline KPI is still net billed.** Either its label or the AI's
   default must move so the two agree. Decide before V1 ships — this is exactly the
   "two numbers on two screens" failure the metric layer exists to prevent.

**MUST be defined (~15 metrics for V1):** every money metric (`collected` — now the
default meaning of "revenue" — `net_billed`, `outstanding`, `discount_total`,
`refund_total`, `commission`); every
ratio (`abnormal_rate` — the 38%-NULL denominator, `cancellation_rate`,
`delivery_rate`, collection rate); `tat_p50`; `reports_finalized` (latest-version
rule); `visits` vs `unique_patients` (the ambiguity in Q1); `test_orders`
(`cancelledAt IS NULL`).

**Safe to generate:** anything whose error is visible — counts and group-bys over one
fact table, top-N rankings, distributions, existence questions, and **all
multi-condition / `HAVING` / cohort questions**, which cannot be pre-defined and which
Measurement 4/5 show the model can write correctly given the right context.

**Deliberately NOT defined:** "patient volume", "workload", "how are we doing" as
*separate metrics*. These are aliases onto the defined set, resolved by the retrieval
keyword index — not new definitions.

**Do not exceed ~20 metrics in V1.** The V1 DSL failed Q4 precisely because a closed
metric vocabulary cannot express the long tail. Metrics constrain; they do not cover.

---

## Part I — LLM call strategy

| Stage | Mechanism | Why |
|---|---|---|
| Intent classification | **deterministic** | Keyword + value index; 30/30 |
| Schema retrieval | **deterministic** | 30/30 recall, 0 ms, 174 KB. An LLM call here is 2× cost for 0 gain |
| SQL generation | **1 DeepSeek call** | The only step needing a model |
| SQL validation | **deterministic** | Parser + allowlist + `analytics_ro` + `statement_timeout` |
| SQL repair (syntax) | **deterministic** | Measured: camelCase quoting fixed with 0 calls |
| SQL correction (semantic) | **≤1 extra call, only on DB error** | A retry cannot fix a *plausible* wrong answer, so never retry a successful query |
| Visualization | **deterministic** | Derived from the shape of the result set |
| Interpretation | **conditional call** | See Part J |

**Normal path: 1 call. Steady state ≈ 1.25 calls/question.**

---

## Part J — End to end

```
USER QUESTION
  │
  ├─ 0  cache: hash(question + scope) → Redis hit? ─────────────► return
  │
  ├─ 1  DETERMINISTIC RETRIEVAL             (0 LLM, ~0 ms)
  │       keyword scoring · value index · FK-graph expansion
  │       → context pack, 350–600 tokens
  │
  ├─ 2  DEEPSEEK  ×1                        (~470 in / ~150 out, ~1.6 s)
  │       → { sql, assumptions, confidence }
  │
  ├─ 3  DETERMINISTIC VALIDATION            (0 LLM, ~1 ms)
  │       parse: single SELECT · no DDL/DML · tables on allowlist
  │       repair: quote camelCase from information_schema
  │       inject: branch scope from req.branchId  (NOT from the model)
  │       force:  LIMIT 500
  │       └─ invalid → ONE retry with the specific error, then stop
  │
  ├─ 4  EXECUTE as analytics_ro             (READ ONLY, statement_timeout 8s)
  │       └─ DB error → ONE retry (step 2) → then stop
  │
  ├─ 5  DETERMINISTIC RESULT PROCESSING     (0 LLM)
  │       facts: headline · deltas · shares · ranks
  │       viz:   from result shape
  │       caveats: coverage · assumptions from step 2
  │
  ├─ 6  RESPONSE
  │       1 row, 1 column  → TEMPLATE, no LLM        ("Revenue in August was ₹19,00,924.")
  │       multi-row / "why" → 1 DeepSeek call on ≤40 facts rows (~250 tok)
  │
  └─ 7  LOG: question · pack size · sql hash · assumptions · rows · ms · retries
```

**Ambiguity rules (Part 18), deterministic, no clarification round-trip:**

1. Question matches a defined metric → use it, state the definition in `provenance`.
2. Two metrics tie (Q1: `visits` vs `unique_patients`) → **answer with the more
   common reading, state it, and offer the other as a follow-up chip.** Never block.
3. No time range given → default to the current month, say so.
4. Long tail, no metric → generate SQL, and **show the model's `assumptions` line
   next to the number**. This is the mitigation for Measurement 5.
5. Ask a clarifying question **only** when an entity fails to resolve
   ("did you mean HbA1c or Hb?") — never for a definitional choice we can default.

**Conversation state (Part 19):** persist the last **structured plan** — metric,
tables, filters, time range, resolved entities, previous SQL — not the transcript.
~150 tokens. A follow-up sends `previous state + new question`, never the history.

**Schema sync (Part 20):** nightly job diffs `information_schema` against the
catalog. New table or column → appears in the auto-generated half immediately and
raises a `catalog_gap` warning listing what lacks a description. Value index rebuilds
nightly (174 KB, seconds). **Nothing about schema drift requires editing a prompt.**

---

## Part K — V1 (the smallest thing that is genuinely useful)

1. `analytics_ro` read-only Postgres role + grants *(the gap: only `neondb_owner`
   exists today)*.
2. AI Metadata Catalog — 26 tables, hand-authored descriptions + aliases. **~2 days,
   the highest-value work in the project.**
3. Metric registry — 15 metrics, each with `reconcileWith` anchored to the existing
   `owner*Service` numbers.
4. Deterministic retriever — the code measured above (keyword weights, value index,
   FK BFS). ~200 lines.
5. Validator + deterministic camelCase repair.
6. One DeepSeek call via the existing `smartReport/llm.ts` (add an optional `system`
   parameter — do not write a second client).
7. Template responses for single-value answers; LLM prose only for multi-row.
8. `AnalyticsQueryLog` + a 40-case eval harness, **money reconciled at zero tolerance.**
9. Owner-only UI, reusing `ownerUi.tsx` primitives + recharts.

**Not in V1:** embeddings, multi-agent anything, conversation, charts beyond
line/bar/KPI, anomaly narration, the raw-SQL escape hatch, materialized views.

## Part L — V2

Conversation via structured state · comparison/decomposition ("why did X change",
deterministic contribution analysis + LLM narration) · `AnomalyEvent`-backed "anything
unusual" · scheduled digests over the existing WhatsApp sender · catalog auto-drafting
for new tables · **embeddings only if `retrieval_low_confidence` proves a gap.**

---

## Part M — 30-question stress test

Deterministic retrieval, measured. `extra` = tables pulled in beyond the gold set
(FK path intermediates, mostly harmless).

| # | Question | Recall | Extra | Tokens | Metric(s) matched |
|---|---|---|---|---|---|
| 1 | How many patients did we see last month? | ✅ | 1 | 240 | visits, unique_patients ⚠️*ambiguous* |
| 2 | What was our revenue last month? | ✅ | 0 | 245 | net_revenue |
| 3 | How much cash did we collect in August? | ✅ | 0 | 239 | collected |
| 4 | How many tests did we do this week? | ✅ | 1 | 239 | test_orders |
| 5 | How many reports were finalized yesterday? | ✅ | 2 | 367 | reports_finalized, tat_p50 |
| 6 | Break down revenue by branch | ✅ | 0 | 279 | net_revenue |
| 7 | Show workload by department | ✅ | 0 | 262 | test_orders |
| 8 | Revenue by payout category | ✅ | 4 | 578 | net_revenue |
| 9 | Consultations per clinic doctor this month | ✅ | 4 | 471 | — |
| 10 | Cash vs online collection split by branch | ✅ | 0 | 271 | collected |
| 11 | Monthly revenue, last 6 months | ✅ | 0 | 248 | net_revenue |
| 12 | Daily visit volume, last 30 days | ✅ | 2 | 326 | visits |
| 13 | Trend in HbA1c testing, last 6 months | ✅ | 2 | 347 | test_orders *(value index → GHB)* |
| 14 | Compare this month with last month on revenue | ✅ | 1 | 375 | net_revenue |
| 15 | Compare Chintal and Balanagar on test volume | ✅ | 2 | 417 | test_orders |
| 16 | Top 10 tests by volume | ✅ | 2 | 352 | test_orders |
| 17 | Which referring doctors sent the most patients? | ✅ | 2 | 381 | unique_patients |
| 18 | Top 5 products by revenue | ✅ | 2 | 375 | net_revenue |
| 19 | Which branch has the highest workload? | ✅ | 0 | 225 | test_orders |
| 20 | What percentage of results are abnormal? | ✅ | 1 | 304 | abnormal_rate |
| 21 | What is our WhatsApp delivery rate? | ✅ | 3 | 424 | delivery_rate |
| 22 | What share of tests get cancelled? | ✅ | 2 | 331 | cancellation_rate |
| 23 | What is our collection rate this month? | ✅ | 3 | 533 | collected |
| 24 | What is our average turnaround time? | ✅ | 2 | 466 | tat_p50 |
| 25 | How many reports are still pending? | ✅ | 3 | 416 | reports_finalized |
| 26 | How much money is outstanding? | ✅ | 1 | 298 | outstanding |
| 27 | How many unique patients visited this year? | ✅ | 2 | 291 | unique_patients |
| 28 | Patients with more than two tests in 90 days | ✅ | 2 | 381 | ⚠️ *over-anchor risk — soft header required* |
| 29 | Doctors who referred patients that never paid | ✅ | 3 | 534 | collected |
| 30 | Anything unusual in the data this week | ✅ | 0 | 105 | — → `AnomalyEvent` |

**30/30 recall · median 347 tokens · p90 533 · zero LLM calls.**

Four of these were executed end-to-end against DeepSeek and the live database
(#2 ✅ exact, #4 ✅ exact, #25-shape ✅ exact, #28 — correct SQL shape, 3% definitional
variance). Questions 1 and 28 carry the two named risks, both handled by design:
ambiguity is defaulted-and-disclosed, over-anchoring is prevented by the soft header.

---

## What changed from V1, and why

| V1 claim | Verdict | Evidence |
|---|---|---|
| "Don't build text-to-SQL, build text-to-plan" | **Overturned.** A closed DSL cannot express Q4/Q28/Q29 | Q4 measured |
| "Big schema → wrong table / wrong timestamp" | **Wrong.** Model handled 73 tables | Q1, Q2 |
| "Retrieval buys latency" | **Wrong.** 1,594 vs 1,490 ms | A/B |
| "Metric layer prevents contradictory numbers" | **Confirmed, decisively** | Q3 |
| "Aggregate-only, no rows to the model" | **Kept** | design |
| "Deterministic validation, not LLM self-policing" | **Kept, strengthened** | camelCase repair |
| "No embeddings" | **Confirmed with a measurement** | 30/30 deterministic |

**STOP — awaiting approval before any implementation code.**
