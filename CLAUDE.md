# Sobhana portal — agent working notes

## Token discipline (graphify + ponytail)

A **graphify** knowledge graph of this repo is prebuilt at `graphify-out/` (gitignored).
Before reading many files to answer a codebase / architecture / "what calls X" / "trace
the flow" question, **query the graph first** — it is far cheaper than fanning out reads:

```
graphify query "<question>" --budget 900     # BFS context for a question
graphify path "AuthModule" "Database"        # shortest path between two concepts
graphify explain "useAuthStore"              # a node + its neighbours
graphify god-nodes                           # architectural hubs
```

Rebuild after large refactors: `graphify update .` (code-only, deterministic, no API key).

**ponytail** mode governs code style: write the minimum that works — reuse what's already
in the repo, stdlib / installed deps before new ones, no unrequested abstractions, one line
over fifty. The best code is the code you never wrote.

## Pulse — what you can check for free, and what costs money

`npm run pulse:check` (in `health-hub-backend/`) runs every offline harness. No model
calls, no browser, a few minutes, and it costs nothing:

```
pulse-view.ts          81  prompts the model is given, evidence→view derivation,
                           evidence structure, renderer admissibility, bindings,
                           grounding, convergence, SQL reading, row identity
pulse-judge.ts         12  the BENCHMARK'S OWN judgement, in both directions — it must
                           flag the bad answer and stay silent on the good one
pulse-deterministic.ts 50  scoped metrics, scoped ratios, repeatability, compute
                           and its basis gate, routing, contract checks, verifySpec
pulse-frontend.ts       7  all 29 adversarial questions resolved — terms, families,
                           scopes and windows — without answering them
pulse-steps.ts             the steps the model ALREADY chose, re-run against today's
                           code. The number that must stay 0 is "worked then, FAIL now"
pulse-sql.ts               every complete generated query in the traces, replayed
                           through today's validator, spec check and the database
```

`pulse-replay.ts` re-judges every recorded answer by today's contract — useful after
changing a rule in `contract.ts`, to see what it would newly catch.

`pulse:chain` and `pulse:artifacts` need the model and are the two that matter most, because
they test that the GEARS STAY CONNECTED rather than that each one turns:

```
pulse-chain.ts       8  "name him" lands on the SAME row the first answer named · an
                        unresolvable reference asks instead of guessing · the CT payback
                        reaches a number AND never takes commission from the payout ledger,
                        which carries no link to a test order
pulse-artifact-fit  30  does a card earn its place — none / earned / asked — and does the
                        one that ships carry context, means, a total, shares and a sized tail
```

A prompt can say the right thing while the pipeline does the wrong one. identityOf was correct
for weeks while "name him" answered about a different patient; every CT operand was measurable
while the answer said it could not be established. Prefer an end-to-end test over another static
prompt assertion.

**RUN ONE SUITE AT A TIME.** Every suite builds the knowledge index on startup, which probes
each registry metric against the database, and each run holds its own Prisma pool. Three at once
exhausted the pool on the shared Neon instance: the knowledge build went from 80 seconds to 47
minutes, eleven metrics reported `broken: Timed out fetching a new connection`, and the analytics
database stopped answering until the runs were killed. It recovered in seconds once they were.

Nothing was lost, but that is a production database — the same one the portal uses. Launch them
sequentially, never with `&` in parallel.

**The suites that need the model** — `pulse:bench` (adversarial, the headline
benchmark), `pulse:regress`, `pulse:calc` — spend real credit on
`SMART_REPORT_LLM_API_KEY`. Each preflights and exits rather than scoring if the
account is unusable, because a billing failure once printed "8/29 clean" and that
is indistinguishable from a catastrophic regression.

Rule of thumb: the model's JUDGEMENT needs `pulse:bench`. Everything on both sides of
it — what the model is told, what its steps mean, what its SQL does, what reaches the
screen — is covered by `pulse:check`.

**What the paid suites cost.** Measured from the recorded traces: a question takes a
median of 7 model calls and a mean of 11, at roughly 8k tokens in and 1k out. On
DeepSeek list pricing that is about **$1.10 for adversarial, $0.50 for regression,
$0.20 for calc — under $2 for all three, and $7 buys several runs with repairs.**

Worth stating because the instinct is to treat the benchmark as expensive and put it
off. It is not. An unverified build is far more expensive than two dollars.

**If the account is dry**, `npm run pulse:when-funded` waits for it to come back (a
four-token probe every five minutes, which spends nothing while it fails), then runs
calc, regression and adversarial in cost order and writes the result to
`pulse-bench-result.txt`. `-- --now` skips the wait and exits 2 if there is still no
credit, rather than reporting a score it did not measure.
