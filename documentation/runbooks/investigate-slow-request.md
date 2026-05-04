# Investigate a slow request

**When to use this**

- A user reports "it's slow"
- API response times in Pino / Sentry trend up
- A specific endpoint is timing out

---

## Pre-flight

- Render dashboard (logs, metrics)
- Sentry (performance / latency view, if traces are enabled)
- Neon dashboard (slow query log)
- Backend admin login (for hitting endpoints under your own auth)

---

## Step 1: Get specific

"It's slow" doesn't tell you anything. Before diagnosing:

- **Which endpoint?** Click through to find it. The Pino log line for that request will give you the exact path + method + duration.
- **Which user / role / branch?** Branch-scoped queries can balloon if a branch has 10× more data than others.
- **When does it happen?** Always slow, or only at peak (end-of-day batch finalization)?
- **How slow is "slow"?** A 500ms response is fine for a list endpoint, terrible for a single-record GET. Get a number.

Reproduce it yourself if possible. Use Chrome DevTools' Network tab to time it from the browser. Pino's auto-logging gives the server-side number — comparing the two tells you if the gap is server or network.

---

## Step 2: Identify the bottleneck

For each request, time can go to:

| Where | Symptom | Tool |
|---|---|---|
| **Postgres query** | DB query time dominates total | Neon slow-query log; Pino `db_query_time` field if instrumented |
| **External call** (R2, WhatsApp, Meta) | Spike when one of these is slow | Pino logs around the call; status of the dep |
| **PDF generation** | Long sync block in handler | `pdfGenerationService` traces |
| **Express middleware** | Always slow regardless of payload | Less common — usually the body parser hitting a huge request |
| **Network from server to client** | Server time fast, browser slow | Compare Pino's `responseTime` to DevTools' `Time` column |

The 80/20: it's almost always Postgres. Start there.

---

## Step 3: Postgres deep dive

### Check the slow query log

Neon dashboard → your project → "Operations" → "Slow Queries" (or use `pg_stat_statements` directly via SQL editor).

Look for:
- Queries with high `mean_exec_time` (>100ms)
- Queries with high `calls` × `mean_exec_time` (high cumulative cost — these dominate)
- Recently new queries that weren't there last week

### Common culprits we've already documented

The previous architecture audit identified specific N+1 and sequential-await hotspots:

1. **`GET /api/visits/diagnostic/:id`** runs 4–5 sequential Prisma queries that have no data dependency on each other (`childTests`, `labPanelItems`, `definitionPanelItems`, `inputConfigs`). They should be parallelized with `Promise.all`. ~200ms wasted per visit load.
2. **List endpoints without pagination** can fetch huge result sets. Check the result count of `findMany` calls — if a branch has 10k+ visits and the endpoint doesn't paginate, every list page request is slow.
3. **Missing FK indexes** — some FKs in `schema.prisma` aren't indexed. Postgres can full-scan when filtering on them.

### Adding an index (the safe pattern)

If a query is full-scanning a column that should be indexed:

1. **Confirm via `EXPLAIN ANALYZE`** in Neon SQL editor. Look for `Seq Scan` on a big table.
2. Add the index in the Prisma schema:
   ```prisma
   model TestOrder {
     ...
     productId String?
     @@index([productId])
   }
   ```
3. Generate a migration:
   ```bash
   cd health-hub-backend
   npx prisma migrate dev --name add_index_<table>_<column>
   # or hand-write — see runbooks/database-migrations.md
   ```
4. Apply per [`database-migrations.md`](database-migrations.md).
5. **Verify** with `EXPLAIN ANALYZE` after the index lands — should now see `Index Scan` instead of `Seq Scan`.

Indexes are not free — they slow writes slightly. Don't index every column reflexively. Index columns you frequently filter or join on.

### Connection pool exhaustion

Symptom: queries that should be fast (<10ms) intermittently take seconds. Postgres is fine; the app is waiting for a free connection.

- Check Neon's "active connections" metric. If it's at the pool ceiling, you have a leak (some code path acquires but doesn't release) or just need a bigger pool.
- Restarting the backend container resets the pool — temporary fix while you diagnose.

---

## Step 4: External calls

R2 / WhatsApp / Meta API can be slow or down. Symptom: a specific endpoint that hits one of those is slow but `/health` is otherwise fine.

- **R2:** check Cloudflare status. Or `curl -w "%{time_total}\n" -o /dev/null -s <r2-public-url>` to time-test directly.
- **WhatsApp:** check Meta Business Suite for any banner about API issues. Or `curl` `graph.facebook.com` directly.
- **Mitigations:**
  - For WhatsApp: it's already fire-and-forget; user-facing requests aren't blocked.
  - For R2: external upload merging blocks PDF response. Worth adding a timeout + fall-through to base-only render (degraded) if R2 is slow.

---

## Step 5: PDF generation

For `/reports/:token` and `/api/visits/diagnostic/:id/finalized-report/pdf`:

- Cold start: 2–3s if Puppeteer just started.
- Per-request: typically 500ms–2s for a single-page report.
- Slow: >5s. Check:
  - HTML size — `reportRendererService` produces big HTML when a visit has many test results
  - Puppeteer concurrency cap (default 2) — if 5 PDF requests arrive simultaneously, the 3rd, 4th, 5th queue
  - Merged-PDF cache miss — every request re-renders if the cache is cold

Mitigations:
- Confirm the `mergedReportPdfCache` (Redis, 7-day TTL) is working — `/health` shows Redis status; cache logs in Pino
- Increase Puppeteer concurrency cap if the host has memory headroom
- Profile `renderReportHtml` separately — instrumentation in [`reportRendererService`](../../health-hub-backend/src/services/reportRendererService.ts)

---

## Step 6: Frontend perceived slowness

If the user says "it's slow" and the server times are fine, look frontend-side:

- Bundle size — main chunk is ~325 KB gzipped today. Slow on weak networks.
- Sequential `fetch` calls instead of `Promise.all` (check the Network tab waterfall — staircase shape = sequential)
- React render time — pages over 800 LOC frequently re-render the whole tree on every keystroke. Profile with React DevTools Profiler.
- No optimistic updates — every mutation triggers a full refetch.

Most of this is structural ([DECISIONS ADR-015](../DECISIONS.md) — tracked debt). Quick wins:
- Replace inline `fetch` chains with `Promise.all` for independent calls
- Check if the FE is unintentionally polling via a `useEffect` that re-runs on every render

---

## When to escalate

- The slowdown is global (all endpoints), and `/health` is green: probably a Postgres or network issue at the platform level. Check Neon status, Render status.
- A single endpoint is consistently slow and you've ruled out queries, externals, and PDF: open an issue with concrete data (request ID, durations, slow-query output, an `EXPLAIN ANALYZE` result if applicable). Don't guess; collect evidence first.

---

## What to log

- Endpoint(s) affected
- Time range when slow
- Diagnosed cause (DB query / external / PDF / FE)
- Fix applied (index / parallelize / cache)
- Before/after numbers — duration, query plan, etc.

This is the data you need to update [DECISIONS.md](../DECISIONS.md) or open a long-term refactor ticket.
