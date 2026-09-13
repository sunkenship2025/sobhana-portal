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

**The suites that need the model** — `pulse:bench` (adversarial, the headline
benchmark), `pulse:regress`, `pulse:calc` — spend real credit on
`SMART_REPORT_LLM_API_KEY`. Each preflights and exits rather than scoring if the
account is unusable, because a billing failure once printed "8/29 clean" and that
is indistinguishable from a catastrophic regression.

Rule of thumb: the model's JUDGEMENT needs `pulse:bench`. Everything on both sides of
it — what the model is told, what its steps mean, what its SQL does, what reaches the
screen — is covered by `pulse:check`.
