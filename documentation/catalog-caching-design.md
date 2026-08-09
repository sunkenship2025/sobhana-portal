# Reference-catalog caching + cross-device invalidation

**Goal:** stop re-downloading rarely-changing reference lists (price list, dropdowns,
definitions) on every screen mount, without ever showing stale data.

**Status (branch `fix/display-poll-when-sse-live`):** `billable-products` and
`clinical-definitions` shipped end-to-end. Four dropdown catalogs remain.

**Two read-migration styles** (pick per screen):
- **Reactive** `useApiQuery` — a mounted screen live-refreshes on the SSE nudge. Use
  for hot, always-open pickers where instant cross-device update matters
  (billable-products on New Visit).
- **Imperative** `apiFetchQuery` — drop-in replacement for a `fetch` in an existing
  useEffect/useCallback; dedups within staleTime and refetches on next open after an
  invalidation, but a *mounted* screen doesn't live-refresh. Use for config screens
  where that's fine and the lower-risk migration is worth it (clinical-definitions in
  ReportBuilder + ManagePanelDefinitions). Wrap in `.catch(() => null)` when it sits
  inside a `Promise.all` with plain fetches, so its throw can't reject the batch.

## The catalogs

| Name (SSE id) | What it is | Query key | staleTime |
|---|---|---|---|
| `billable-products` | price list / test menu (billing picker) | `["billable-products", branchId]` | 5 min |
| `clinical-definitions` | test/panel definitions (report builder) | `["clinical-definitions", branchId]` | 5 min |
| `referral-doctors` | referring-doctor dropdown (global) | `["referral-doctors"]` | 10 min |
| `diagnostic-centers` | diagnostic-centre dropdown | `["diagnostic-centers", branchId]` | 10 min |
| `external-labs` | outside-lab dropdown | `["external-labs", branchId]` | 10 min |
| `departments` | department list | `["departments", branchId]` | 10 min |

## Three layers of freshness

1. **Invalidate on save** — the editing device's cache updates instantly (covered by
   layer 2 below, since its own SSE also receives the nudge).
2. **Server broadcast** — every *other* device updates within ~1s. A catalog mutation
   calls `emitCatalogChange(branchId, name)`; each browser holds one public SSE
   (`GET /api/events/:branchId/catalog-stream`) and, on a nudge, invalidates
   `[name]` (prefix match → all branch variants). Signal carries **no data**, so the
   stream needs no auth (EventSource can't send an Authorization header).
3. **staleTime backstop** — if a nudge never arrives (proxy strips SSE, tab asleep),
   the reuse-window + refetch-on-focus catches up. **Never disable
   `refetchOnWindowFocus`** — it's what bounds cross-device lag to ~staleTime.

## Correctness guards (why this can't show wrong data)

- **Branch switch** → `queryClient.clear()` already fires (`branchStore.ts`,
  `BranchConfirmModal.tsx`); every branch-scoped key carries `branchId`.
- **Money safety net** → bill prices are recomputed server-side at bill time
  (`resolveProducts(productIds, branchId)`; client sends IDs, never prices). A stale
  cached price is *display-only* — the bill is always the current price.
- **Catalog channel is separate** from the queue channel (`catalog:<branchId>` vs
  `<branchId>`), so clinic-visit churn never invalidates catalogs.

## Mechanism (all reuses `lib/displayEvents.ts` — the display's pub/sub)

**Server**
- `displayEvents.ts`: `emitCatalogChange(branchId, catalog)` / `onCatalogChange(...)`.
- `routes/events.ts`: public SSE `GET /api/events/:branchId/catalog-stream` (heartbeat + cleanup).
- each catalog mutation: `if (req.branchId) emitCatalogChange(req.branchId, '<name>')`.

**Client**
- `App.tsx` `<CatalogSync/>`: one EventSource per active branch → `invalidateQueries([catalog])`.
- reads migrate to `useApiQuery(qk.<catalog>(branchId), { staleTime, branchScoped })`.

## Ceilings (ponytail)

- In-process `EventEmitter` → single Node instance only (Render runs 1). Scale-out ⇒
  Redis pub/sub (already a dep) or Postgres LISTEN/NOTIFY — same two functions.
- One idle SSE per open staff tab. Cheap, and it *replaces* constant re-downloading.
- Cross-branch propagation of a global product edit rides staleTime, not the push
  (emit is keyed to the editor's active branch).

## Rollout (one catalog per PR; merge gate = the two-device test)

Reads→cache **and** writes→emit together, then verify in the browser: edit the catalog
on device A, watch it update on device B within ~1s; and confirm re-opening the screen
on one device doesn't re-download within the staleTime window.

Order: `billable-products` (done) → `clinical-definitions` (done) → dropdowns
(`referral-doctors`, `diagnostic-centers`, `external-labs`, `departments`).
