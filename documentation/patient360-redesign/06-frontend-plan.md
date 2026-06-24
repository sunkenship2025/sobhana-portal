# Patient360 Frontend — Build Plan

A single build-ready plan for replacing the Patient360 detail page, the global patient search page, and the shared data layer behind both. Grounded in the live code:

- `qk` factory + `useApiQuery`/`useApiMutation`/`branchRequest`/`apiCall` exist in `src/lib/query.ts` (factory at line 112; `signal` forwarded at lines 98-101).
- `apiRequest` in `src/lib/utils.ts:10-41` throws a **bare `Error`** at line 37 (`error.message || HTTP ${response.status}`) — no machine-readable status. This is a hard prerequisite (Step 0).
- Routes confirmed in `src/App.tsx`: `/clinic/patient-search` → `GlobalPatientSearch` (line 135); `/clinic/patient-360/:patientId` → `Patient360` (line 140); `/clinic/new` → `ClinicNewVisit` (line 125); `/money/bills` (line 164); `/bill/print/:domain/:visitId` (line 230). **There is no `/clinic/new-visit` and no `/clinic/billing`.**
- `ClinicNewVisit` has **no** `useLocation`/`location.state`/`prefill` reader (grep returned nothing) — prefill is net-new work.
- `fetchFinalizedReportPdfBlobUrl(request: StaffReportRequest & {mode})` and `openFinalizedReportWindow(request: StaffReportRequest & {autoPrint})` confirmed in `src/lib/reportAccess.ts:64,102`.
- `VisitTimelineItem` (`src/types/index.ts:524-565`) has `reportStatus: ReportVersionStatus`, `reportVersionId`, `finalizedAt`, and flat `discount*` fields. It does **not** have `reportState`, `hasAbnormalResults`, `workflowMode`, `delivery`, or a `discount` object — all §6 shapes are net-new and backend-blocked.

---

## 0. BINDING DECISIONS (read first)

These resolve internal conflicts and are non-negotiable for the build.

1. **Branch header on `/360*` + `/patients/*` endpoints — use `apiCall` (NO `X-Branch-Id`).** Patient360 is a global, cross-branch view. The four endpoints `/patients/{id}/360/summary`, `/360/timeline`, `/patients/search`, `/patients/by-bill/:billNumber` go through `apiCall` (no branch header). This structurally eliminates any hardcoded-fallback-branchId bug (a global endpoint needs no branch). Report PDF + `/messages/:visitId/send-report` ARE genuinely branch-scoped and DO carry `X-Branch-Id` (matching `reportAccess.ts` today). **This is the single highest-risk assumption in the plan** — if the backend silently filters timeline/search by branch header, multi-branch patients will show partial data that looks like a "missing visits" bug, not an auth error, and is very hard to diagnose. **Q1 must be answered before Group B starts (blocking, not parallel).** The answer also decides whether `branchId` belongs in the query keys.
2. **`qk` location.** Extend the existing factory in `src/lib/query.ts` (line 112) with the four keys in §3.1. Keys carry NO `branchId` (global view), consistent with resolution 1 and the factory's "global (no branchId in key)" section. Cross-branch stale-leak is already prevented because `branchStore.setActiveBranch` calls `queryClient.clear()` on switch.
3. **Hooks layout.** One self-contained folder `src/hooks/patient360/` (Axora-ready isolation): `usePatient360.ts` (all queries + identity mutation + the pure-ish query builders co-located), `useReportActions.ts`, `useIsMobile.ts`.
4. **Hook naming.** `usePatient360Summary`, `usePatient360Timeline`, `useSmartSearch`, `useBillLookup`, `usePatientIdentityEdit`. There is exactly ONE WhatsApp send path: `useReportActions().sendWhatsApp(visitId)`. Both legacy call sites delete their duplicate POST and call it.
5. **`detectSearchType` placement.** `src/lib/smartSearch.ts` — pure, no React, unit-testable in isolation (it has the trickiest edge cases). `usePatient360.ts` imports it.
6. **`StatusChip` does NOT extend `StatusBadge`.** Fresh CVA component rendering icon+text (never color-only). Reuses the existing `status-paid/pending/draft/finalized` CSS classes. `StatusBadge` stays for plain payment/visit-status labels elsewhere.

---

## 1. OVERVIEW

Replace the 798-line monolith `src/pages/clinic/Patient360.tsx` (page + inline `VisitDetailDrawer` + full-screen preview modal) and the two-button-toggle `src/pages/clinic/GlobalPatientSearch.tsx` with:

- A **smart search entry page** — auto-detect phone/name/email/patientNumber/bill, live debounced type-ahead, recently-viewed, bill→visit resolve, no-match→register.
- A **detail page** — sticky header + glance strip + two-pane (timeline ← infinite-scroll | inspector →) on desktop; single-column + bottom-sheet on mobile. Inline PDF preview (no separate modal). Read-only except `PatientEditDialog`.
- A **shared data layer** — react-query hooks (summary, infinite timeline, smart search, bill lookup, identity-edit mutation), one `useReportActions` hook (per-visit busy, single WhatsApp path, blob lifecycle), one `StatusChip`.

**File structure (`+` new, `~` refactor, `⟳` rewrite):**

```
src/
  lib/
    utils.ts                             ~ Step 0: typed ApiError { status }; all callers read err.status
    query.ts                             ~ extend qk (4 keys)
    smartSearch.ts                       +  detectSearchType (pure)
    recentPatients.ts                    +  localStorage helpers
    reportAccess.ts                      = reused as-is
    patientDisplay.ts                    = reused as-is
  pages/clinic/
    Patient360.tsx                       ⟳ orchestrator only (~120 lines)
    GlobalPatientSearch.tsx              ⟳ smart bar host
    ClinicNewVisit.tsx                   ~ read useLocation().state.prefill; seed search/create step
  components/patient360/
    # detail
    PatientHeaderBar.tsx                 +
    GlanceStrip.tsx                      +
    NewVisitMenu.tsx                     +
    TimelineFilters.tsx                  +
    VisitTimeline.tsx                    +
    VisitRow.tsx                         +
    VisitInspector.tsx                   +
    FinancialDetailPanel.tsx             +
    ReportActions.tsx                    +
    DeliveryStatusLine.tsx               +
    JumpToOriginalVisit.tsx              +
    Patient360LoadingSkeleton.tsx        +
    Patient360ErrorState.tsx             +
    PatientEditDialog.tsx                ~ review step + return updated Patient
    # search
    SmartSearchBar.tsx                   +
    SmartSearchResults.tsx               +
    PatientMatchCard.tsx                 +
    BillResolveCard.tsx                  +
    NoMatchRegister.tsx                  +
    RecentlyViewed.tsx                   +
    # shared
    StatusChip.tsx                       +  CVA chip + mapReportStateToChip
  hooks/patient360/
    usePatient360.ts                     +  usePatient360Summary, usePatient360Timeline, useSmartSearch, useBillLookup, usePatientIdentityEdit, normalizeTimelineFilters, buildTimelineQuery
    useReportActions.ts                  +
    useIsMobile.ts                       +
  types/index.ts                         ~ add §6 types; extend VisitTimelineItem
```

---

## 2. COMPONENT INVENTORY

Props typed against the §6 shapes (`Patient360Summary`, `Patient360Glance`, `Patient360TimelinePage`, extended `VisitTimelineItem`, `ReportState`, `VisitDelivery`, `BillLookupResult`).

| Component / Hook | Responsibility | Props (key fields) | Reuses |
|---|---|---|---|
| **`Patient360`** (page ⟳) | Orchestrator. `useParams`, owns `selectedVisitId`/`inspectorOpen`/`filters`, drives summary+timeline hooks, reads `?visit=`, routes skeleton/error/content. | none | `AppLayout` |
| **`PatientHeaderBar`** + | Sticky identity bar: back, name, identity chips, branch count, Edit trigger. | `patient: Patient; branchCount: number; onBack(); onPatientUpdated(p: Patient)` | `Button`, `Badge`, `ArrowLeft`/`Pencil`, `formatPatientName`; hosts `PatientEditDialog` |
| **`GlanceStrip`** + | 4 cells: Last visit, Outstanding due (headline, ▲ if >0), Reports (`{finalized}✓·{notFinalized} pending`), `NewVisitMenu`. | `glance: Patient360Glance; patientId: string; enabledDomains?: VisitDomain[]` | `Card`/divs, `IndianRupee`, `formatCurrency` |
| **`NewVisitMenu`** + | Dropdown deep-linking into the new-visit flow, gated by enabled domains. | `patientId: string; enabledDomains?: VisitDomain[]` | `Popover`+`Command`, `Button`, `ChevronRight`, `useNavigate` |
| **`TimelineFilters`** + | Domain segmented control, date popover, branch select, "Unpaid only", "Show cancelled". 1:1 with `/360/timeline` params. | `value: TimelineFilters; onChange(next); branches: {id;name}[]` | `Button` group, `Popover`+`Input`, `Select`, `Checkbox` |
| **`VisitTimeline`** + | Flatten `pages[].items`, month buckets, render rows, "Load older", empty/error inline. | `pages; isFetchingNextPage; hasNextPage; onLoadMore(); selectedVisitId; onSelectVisit(item); reportBusyVisitId; onViewReport(item); onJumpToOriginal(id)` | `EmptyState`, `Button`, `Separator`, `Skeleton`, `LoadingState` |
| **`VisitRow`** + | One visit card: domain tag, date, billNumber/visitRef, revisit chip+jump, payment/report/abnormal chips, amount, compact `ReportActions`, `.cancelled` styling. **Not a `role="button"` ancestor of the action buttons (see §8).** | `item: VisitTimelineItem; selected; reportBusy; onSelect(); onViewReport(); onJumpToOriginal(id)` | `Card`, `Badge`, `Button`, lucide; `getDomainBadgeVariant` |
| **`VisitInspector`** + | Replaces old drawer + modal. Desktop right pane / mobile bottom `Drawer`. Hosts financial panel, report actions, collect-payment link, print-bill, inline iframe preview. Owns ESC/✕/backdrop close; revokes blob on visit change. | `visit: VisitTimelineItem \| null; open; onClose(); patientPhone; isMobile; patientId` | desktop pane+`Separator`; mobile `Drawer`; `EmptyState`, `X` |
| **`FinancialDetailPanel`** + | Bill #, visitRef, Total/Discount(+reason)/Paid/Due/Method rows, payment chip. Read-only. Trusts `dueAmountInPaise` (backend forces ₹0 on cancelled/refunded). | `visit: VisitTimelineItem` | `.kv` rows, `StatusChip`, `Separator`, `formatCurrency` |
| **`ReportActions`** + | View/Print/WhatsApp; `full` variant adds `DeliveryStatusLine`. Gated `domain==='DIAGNOSTICS' && reportState.kind ∈ {FINALIZED, PARTIALLY_FINALIZED}`. Uses `useReportActions`. | `visit; patientPhone; variant: 'compact'\|'full'; busy: boolean; onView()` | `Button`, `FileText`/`Printer`/`MessageCircle`/`Eye`/`Loader2`/`Download`; `reportAccess.ts` |
| **`DeliveryStatusLine`** + | Progressive Sent→Delivered→Read (or Failed) line from `item.delivery`. Hidden if `null`. | `delivery: VisitDelivery \| null` | icon+text row, `formatDate` |
| **`JumpToOriginalVisit`** + | Revisit annotation + in-page jump (no `/visit/:id` route). | `originalVisitId; originalVisitBillNumber; originalVisitDate; onJump(id)` | `Button` (link), `ChevronRight` |
| **`StatusChip`** + | CVA chip, icon+text (WCAG). Kinds: payment/report/abnormal/cancelled. `mapReportStateToChip` is the single place `ReportState` is decoded. Does NOT extend `StatusBadge`. | `kind: ChipKind; value?: PaymentStatus\|ReportState\|boolean\|null; className?` | reuses `status-paid/pending/draft/finalized` CSS + lucide |
| **`Patient360LoadingSkeleton`** + | Skeleton header + 3 glance cells + 3 timeline rows (no bare spinner). | none | `Skeleton` |
| **`Patient360ErrorState`** + | 404 (not-found, Back-to-Search) vs network/5xx (Retry → `refetch`). Branches on `err.status` (requires Step 0). | `kind: 'not-found'\|'network'; onRetry?(); onBack()` | `EmptyState`, `Button`, `Alert` |
| **`PatientEditDialog`** ~ | Form → Review step for identity changes (old→new + `changeReason`), then PATCH. `onSuccess` returns updated `Patient`. Cache update strategy per §3.4 (merge only if Q2 confirms response body; else invalidate). | `patient: Patient; onSuccess(updated: Patient)` | `Dialog`, `Form`/`Input`/`Select`/`Textarea`/`Checkbox`, `usePatientIdentityEdit` |
| **`SmartSearchBar`** + | Input + magnifier + detection `Badge` (debounced live region) + override pills + Search button. | `rawQuery; onChange(v); detection; effectiveKind; onOverride(kind); onSubmit()` | `Input`, `Badge`, `Button`, `Search`/`Phone`/`User`/`Mail`/`Hash`/`Receipt` |
| **`SmartSearchResults`** + | Switch on effectiveKind + state → match list / bill card / no-match / recent / loading / error. | `state from useSmartSearch + useBillLookup` | composes the four below |
| **`PatientMatchCard`** + | One `PatientSearchResult`: initials, name, age·gender chip, patientNumber, meta line, Open. Shared-phone disambiguation safeguard. | `result: PatientSearchResult; onOpen(patientId)` | `Card`, `Badge`, `Button`, `formatPatientName`, `getDomainLabel`, `formatDate` |
| **`BillResolveCard`** + | `{patient, visit}` accented card: bill header + StatusBadge, identity row, Open-visit / Open-record / Reprint. | `result: BillLookupResult; onOpenVisit(pid,vid); onOpenRecord(pid)` | `Card`(`border-l-4`), `StatusBadge`, `Button`, `formatCurrency` |
| **`NoMatchRegister`** + | Empty result OR bill 404 → Register (carries typed value) / Try again. | `typed: string; kind: SearchKind; onRegister(); onClear()` | `EmptyState`(`SearchX`), `Button` |
| **`RecentlyViewed`** + | localStorage list shown when input empty. | `items: RecentPatient[]; onOpen(id); onClear()` | `Card`/rows, `Button` |
| `usePatient360Summary` + | Summary query, `retry:false`. | `(patientId?)` | `useApiQuery`+`apiCall` |
| `usePatient360Timeline` + | Infinite timeline query. | `(patientId?, filters)` | `useInfiniteQuery`+`apiCall` |
| `useSmartSearch` + | Debounced patient search (phone/name/email/patientNumber). | `(raw, overrideType?)` | `useApiQuery`+`apiCall` |
| `useBillLookup` + | Bill→visit, `retry:false`, 404=no-match. | `(billNumber?, enabled?)` | `useApiQuery`+`apiCall` |
| `usePatientIdentityEdit` + | PATCH + cache update on summary. | `(patientId)` | `useApiMutation`+`apiRequest`+`useQueryClient` |
| `useReportActions` + | preview/print/WhatsApp, per-visit busy, blob lifecycle. | `()` | `reportAccess.ts`, `apiRequest`, `toast` |
| `useIsMobile` + | `matchMedia('(max-width:768px)')`. | `()` | — |

---

## 3. DATA LAYER

### 3.0 Step 0 — typed `ApiError` (hard prerequisite, blocks all of Group B)

`src/lib/utils.ts:37` currently throws a bare `Error`. The 404-vs-network split (§6) and the bill-404-vs-bill-500 distinction (§3.2) both require a machine-readable status, which does not exist today. Before any data hook is built:

```ts
export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}
```

Replace line 37 with `throw new ApiError(response.status, error.message || `HTTP ${response.status}`)`. The 401 branch (line 28-33) keeps its existing behavior (logout + redirect) but should also throw `ApiError(401, …)` for consistency. **This is shared infra touching every existing `apiRequest`/`apiCall` consumer** — regression-test the existing 401 and generic-error paths (login expiry redirect, existing toasts) after the change. All new consumers read `err instanceof ApiError && err.status === 404`.

### 3.1 `qk` extension (`src/lib/query.ts`, append to factory at line 112)

```ts
// --- patient360 (global endpoints — NO branchId in key) ---
patient360Summary: (patientId: string) => ["patient360","summary",patientId] as const,
patient360Timeline: (patientId: string, filters: TimelineFilters) =>
  ["patient360","timeline",patientId,filters] as const,
patientSmartSearch: (type: SearchKind, q: string) => ["patientSearch","smart",type,q] as const,
billLookup: (billNumber: string) => ["billLookup",billNumber] as const,
```

Branch intentionally absent (global view, resolution 1). Cross-branch stale-leak prevented by the existing `queryClient.clear()` on branch switch. If Q1 returns "branch-scoped", add `branchId` to all four keys and switch the hooks to `branchRequest`.

### 3.2 Query hooks (`src/hooks/patient360/usePatient360.ts`)

- **`usePatient360Summary(patientId?)`** — `useApiQuery<Patient360Summary>({ queryKey: qk.patient360Summary(patientId??""), queryFn: () => apiCall(`/patients/${patientId}/360/summary`), enabled: !!patientId, retry: false })`. `retry:false` so a real 404 surfaces instantly as not-found instead of retrying 3×. Glance is page-independent (backend §8) → refetched only on identity-edit invalidation, never on paging.

- **`usePatient360Timeline(patientId?, filters)`** — `useInfiniteQuery<Patient360TimelinePage>` (the app's first infinite query). Because `useInfiniteQuery` is NOT wrapped by `useApiQuery`, the wrapper's defaults are lost and must be set explicitly:
  - `queryKey: qk.patient360Timeline(patientId, normalized)` where `normalized = normalizeTimelineFilters(filters)`.
  - `queryFn: ({pageParam, signal}) => apiCall(`/patients/${patientId}/360/timeline${buildTimelineQuery(normalized, pageParam)}`, {signal})` (`apiCall` forwards `signal`, confirmed query.ts:98-101).
  - `initialPageParam: undefined`; `getNextPageParam: (last) => last.pageInfo.hasMore ? last.pageInfo.nextCursor : undefined`.
  - **`enabled: !!patientId && !!token`** (token gate replicated, since the wrapper isn't applied), **`staleTime: 30_000`**, **`retry: false`** — all set explicitly.
  - **Cursor-reset contract:** filters live in the key, cursor in `pageParam` (NEVER in the key). Any filter change → new cache entry → fresh `pageParam=undefined` (newest page). The old cursor lives on the old key and can never bleed across a filter change.
  - **`normalizeTimelineFilters` must produce a structurally stable, referentially predictable value and feed the SAME normalized object into both the key and the queryFn.** Do not double-memoize: do not both `useMemo` it and re-call it in the key builder with a different identity, or the key changes every render → infinite refetch loop AND the cursor never resets (the query remounts fresh each render). Normalization: drop undefined/default keys, canonical property order, clamp `pageSize` 1–50 (default 20). A unit test asserts two logically-equal filter objects serialize to the same JSON for the key (`===`-stable).

- **`useSmartSearch(raw, overrideType?)`** — 300ms debounce (`setTimeout` + `useEffect` cleanup, no lib). `type = overrideType ?? detectSearchType(debounced)`. `useApiQuery<PatientSearchResult[]>({ queryKey: qk.patientSmartSearch(type, debounced), queryFn → apiCall(`/patients/search?${param}=${enc(debounced)}`), enabled: debounced.length>=2 && type!=='bill', staleTime: 30_000, placeholderData })`. Min-length gate: phone≥7 digits, name≥2 chars, patientNumber/email on regex match. **`placeholderData` must be gated on matching detection type** — `placeholderData:(prev)=>prev` alone shows stale phone results under a name query during a detection flip. Use `placeholderData: (prev, prevQuery) => prevQuery?.queryKey[2] === type ? prev : undefined` (keep prior data only when the previous key's `type` matches the current type), so results clear when `effectiveKind` changes but persist between same-type keystrokes.

- **`useBillLookup(billNumber?, enabled=true)`** — `useApiQuery<BillLookupResult>({ queryKey: qk.billLookup(trim), queryFn → apiCall(`/patients/by-bill/${enc(trim)}`), enabled: enabled && len>=3, retry: false })`. The consumer treats `isError && (error as ApiError).status === 404` as "no such bill" (distinct from `/search`'s `[]`, and NOT the patient-register path — a bill miss ≠ a patient miss). Requires Step 0; until then bill-404 and bill-500 are indistinguishable.

### 3.3 `useReportActions()` (`src/hooks/patient360/useReportActions.ts`)

Single source of truth; fixes three constraint bugs at once:

- **Per-visit busy** — `busy: {visitId, action} | null` + `isBusy(visitId, action?)`. Clicking visit A's report never disables visit B's button (fixes the shared-`previewLoading` bug). If `ReportActions` renders for the same visit in both row (`compact`) and inspector (`full`), both disable together — desired.
- **Single WhatsApp path** — `sendWhatsApp(visitId)` → `apiRequest(`${API_BASE}/messages/${visitId}/send-report`, {method:'POST', headers:{'X-Branch-Id': branchId??''}})` → `toast`. Both legacy call sites (drawer + modal header) delete their duplicate POST and call this.
- **Blob lifecycle** — owned by `urlRef`: `setPreviewUrl` revokes the prior before setting the new; `closePreview` revokes; `useEffect(() => () => revoke, [])` revokes on unmount. The `reportAccess.ts` 60s/120s timers stay as a backstop for the print/new-tab paths it owns. **The inspector additionally calls `closePreview()` in an effect keyed on `selectedVisitId`** so switching from a visit with an open preview to another visit (which may never open a preview) still revokes the old blob (§5). The hook also revokes on `isMobile` change, since the desktop↔mobile swap unmounts the inspector but the hook instance lives in the page and survives, orphaning the blob otherwise.
- Report endpoints ARE branch-scoped → `branchId = useBranchStore(s => s.activeBranchId)`, passed to `fetchFinalizedReportPdfBlobUrl`/`openFinalizedReportWindow` (matching their confirmed `StaffReportRequest` signatures, reportAccess.ts:64,102). Caller gates on `domain==='DIAGNOSTICS' && reportState.kind ∈ {FINALIZED, PARTIALLY_FINALIZED}`.

### 3.4 Identity-edit mutation `usePatientIdentityEdit(patientId)`

`useApiMutation<Patient, PatientEditPayload>({ mutationFn → apiRequest PATCH /patients/${id}, onSuccess })`. **Cache-update strategy is gated on Q2** (does PATCH return the full updated `Patient`?):

- The existing `PatientEditDialog` does `onSuccess` → parent full-refetch, which strongly implies the PATCH response is NOT currently trusted as the source of truth. Do not assume in-place merge.
- **Default (safe): `qc.invalidateQueries(qk.patient360Summary(patientId))`** — one scoped refetch (NOT a full page reload). Timeline is untouched (visits carry no identity fields).
- **Optimization (only after Q2 confirms PATCH returns the full server-computed `Patient` — `ageDisplay`, uppercased `name`): `qc.setQueryData(qk.patient360Summary(patientId), old => old ? {...old, patient: updated} : old)`.** If PATCH returns `{success:true}` and you merge anyway, you write garbage into `summary.patient` (blank name). A stale client-side echo would also show an un-uppercased name. So in-place merge is the optimization, invalidate is the floor.

`PatientEditPayload` includes `changeReason?`; the dialog requires it for `IDENTITY_FIELDS` changes before `mutate`.

---

## 4. ROUTING

**No new routes are added.** All deep-links resolve client-side and use the verified canonical paths.

- **Canonical paths (verified in `App.tsx`):** `/clinic/patient-search` → `GlobalPatientSearch` (line 135); `/clinic/patient-360/:patientId` → `Patient360` (line 140); `/clinic/new` → `ClinicNewVisit` (line 125, **NOT `/clinic/new-visit`**); `/money/bills` (line 164, **there is NO `/clinic/billing`**); `/bill/print/:domain/:visitId` (line 230). Both Patient360 routes are `staff`/`owner` protected.
- **Search → detail:** `navigate('/clinic/patient-360/' + patientId)`.
- **Bill resolve → specific visit:** `navigate('/clinic/patient-360/' + patientId + '?visit=' + visitId)`. The detail page reads `useSearchParams().get('visit')` on mount and runs the auto-locate routine below.
- **No-match → register:** `navigate('/clinic/new', { state: { prefill: { kind, value } } })`. **`ClinicNewVisit` does NOT read `location.state` today (verified: grep found zero `useLocation`/`prefill`).** Adding the reader is net-new work, scheduled as an explicit build step (Group C step 14b), not an open question: add `const { state } = useLocation();` and seed `state?.prefill` into the existing search/create step (`handleCreateNewPatient`). Without this step the prefill is silently dropped and the user lands on a blank flow.
- **New-visit from detail (`NewVisitMenu`):** `navigate('/clinic/new', { state: { prefillPatientId, prefillPatient } })` — same reader.
- **Collect-payment / print-bill:** there is no `/clinic/billing`. Use **print-bill via `/bill/print/:domain/:visitId`** (verified). For "collect payment," point at `/money/bills` only after confirming it accepts a visit filter (Q5); otherwise drop the collect-payment deep-link from the inspector for v1 and keep print-bill only.
- **Jump-to-original-visit:** in-page only (no `/visit/:id` route).

**Auto-locate routine (shared by `?visit=` deep-link and jump-to-original) — bounded, cannot hang:**
1. If the target visit is in a loaded timeline page → select + scroll + open inspector.
2. If not loaded: **clear all timeline filters first** (a filter may exclude the target server-side, in which case page-forward never finds it and `hasNextPage` going false would otherwise look like an infinite-search bug), then `fetchNextPage()` in a loop **capped at N iterations (e.g. 10)**.
3. If still not found after the cap OR `hasNextPage` is false → show a non-blocking "Couldn't locate that visit" toast/inline note and leave the timeline at its current position. Never loop unbounded; the inspector spinner must always resolve.

---

## 5. INTERACTION DETAILS

- **Inspector (sheet vs bottom-sheet).** `useIsMobile()` (`matchMedia('(max-width:768px)')`). Desktop: inspector is the always-mounted right column (`flex:1`); "open" swaps empty-state→content and adds `.sel` to the row; close via visible `✕` + an `Escape` handler **scoped to the pane element, attached only while open** (a `document`-level listener would fire app-wide and close the edit Dialog underneath — see §8). Mobile: `Drawer` (vaul, `shouldScaleBackground`) controlled by `inspectorOpen`; vaul handles ESC + backdrop + drag-to-dismiss via `onOpenChange`. One `onClose` serves both.
- **Filters → cursor reset.** Filter object is part of the timeline key; any change creates a new cache entry starting at `pageParam=undefined`. No manual cursor juggling. `normalizeTimelineFilters` keeps equal filters from thrashing the key.
- **Per-visit report loading.** `reportBusyVisitId` derives from `useReportActions().isBusy(item.visitId)`; only that row/inspector button shows `Loader2` and disables.
- **Blob lifecycle.** Inline `<iframe src={preview.url}>` inside the inspector — no separate modal. `useReportActions` revokes on: preview change, `closePreview`, unmount. The inspector adds an effect on `selectedVisitId` → `closePreview()` (covers visit-switch when no new preview opens) and the hook revokes on `isMobile` change (covers the desktop↔mobile swap orphaning the blob).
- **Edit review-step.** `PatientEditDialog` two-state body: Form → Review. On submit, if any `IDENTITY_FIELDS` changed → Review (each changed field old→new + required `changeReason`), then "Confirm & Save". Non-identity-only changes skip straight to save. Cache updated per §3.4.
- **Smart-search type detection.** `detectSearchType` order in `lib/smartSearch.ts` (first match wins): `@`→email; `^P-?\d+$`→patientNumber; bill regex (chosen in Step 2 test, Q3); digits(strip space/dash)≥7→phone; else name. patientNumber checked **before** bill (so `P-01432` isn't mis-tagged). Detection runs instantly on raw input for the badge; the network fires on `debouncedQuery`. Override pills set `overrideKind`; editing text resets `overrideKind=null`.
- **Type-ahead races.** Primary defense = React Query key-per-query (`['patientSearch','smart',type,debounced]`): a late response for a stale key updates only its own cache entry. Secondary = `{signal}` through `apiCall`→`apiRequest`→`fetch` (auto-abort). No manual sequence counter. `placeholderData` is type-gated (§3.2) so a detection flip clears stale-type results.
- **Recently-viewed.** `lib/recentPatients.ts`, localStorage key `p360.recentPatients.v1`, MAX 8, dedupe by patientId, tolerant JSON parse. Written from the detail page on successful load (reflects real opens). Read on the entry page when `debouncedQuery===''`. Single global key (Q7).

---

## 6. STATUS-CHIP & STATE SPEC

**`StatusChip` is a fresh CVA component** rendering `<Icon aria-hidden/><span>{label}</span>` (icon+text, WCAG SC 1.4.1, never color-only), reusing the existing `status-paid/pending/draft/finalized` CSS classes. `StatusBadge` stays for plain payment/visit-status labels elsewhere.

**Backend dependency on the chip data.** The live `VisitTimelineItem` (`types/index.ts:524-565`) has `reportStatus: ReportVersionStatus` (DRAFT|FINALIZED), `reportVersionId`, `finalizedAt`, and flat discount fields. It does **NOT** have `reportState`, `hasAbnormalResults`, `workflowMode`, `delivery`, or a `discount` object. The entire `mapReportStateToChip` design depends on a backend `reportState` discriminated union that does not exist yet. `StatusChip` is buildable and unit-testable against the new TS types, but until the backend ships §6 shapes it cannot be wired to real data (it will render "Bill only"/nothing for every visit). This makes Group A only *partially* backend-independent.

**Payment** (`item.paymentStatus` / derived from `dueAmountInPaise`):
| State | Label | Icon | Class |
|---|---|---|---|
| PAID | Paid | CheckCircle2 | status-paid |
| PENDING + due>0 | Due {formatCurrency} | Clock/AlertCircle | status-pending |
| Partial (paid>0 && due>0) | Partial · Due {…} | AlertCircle | status-pending |
| FAILED | Due {…} (no special failed indicator) | Clock | status-pending |
| REFUNDED | Refunded | RotateCcw | status-draft |
| !hasBill | No bill | — | secondary muted |

**Report state** (`item.reportState`, discriminated union; diagnostics only, clinic → render nothing) — decoded ONLY in `mapReportStateToChip`:
| `kind` | Label | Icon | Class |
|---|---|---|---|
| FINALIZED | Finalized v{version} | CheckCircle2 | status-finalized |
| PARTIALLY_FINALIZED | Partial · {finalized} of {total} | Loader2/FileText | status-pending |
| BILL_ONLY | Bill only | FileText | status-draft |
| EXTERNAL_UPLOAD_PENDING | Awaiting upload | Upload | status-pending |
| RESULTS_PENDING | Results pending | Clock | status-pending |
| null | (nothing) | — | — |

`version` = max finalized versionNum, not the trailing DRAFT (confirm Q6). Partial uses `finalized`/`total`.

**Abnormal** (`item.hasAbnormalResults === true`) — flag only: label "Abnormal results", `AlertTriangle`, destructive-tinted, `role="status"`. No values, no test names anywhere. Absent when false/undefined.

**Cancelled** (`item.status === 'CANCELLED'`): label "Cancelled", `Ban`, neutral; row gets `.cancelled` (opacity + strike); muted note "— excluded from dues"; trusts backend `due=0`.

**Delivery** (`DeliveryStatusLine`, `item.delivery: VisitDelivery | null`) — NOT a chip; inspector-only inline progression (PENDING→Queued, SENT→Sent✓{sentAt}, DELIVERED→Delivered✓, READ→Read✓, FAILED→destructive). Hidden if null. Furthest-reached step shown. `formatDate` timestamps.

**Loading:** `Patient360LoadingSkeleton` — `Skeleton` header + 3 glance cells + 3 timeline rows (no bare spinner). Next-page → `LoadingState label="Loading older visits…"` pinned at list footer.

**Not-found vs network error (requires Step 0 `ApiError.status`):**
- **404 / null patient** (`(err as ApiError).status === 404`, summary uses `retry:false`) → `EmptyState icon={UserX} title="Patient not found"` + "← Back to Search" (no retry).
- **Network / 5xx / timeout** → `Alert variant="destructive"` "Couldn't load this patient" + primary "⟳ Retry" → `query.refetch()`.
- **Timeline-only failure** (summary OK, a page fails) → inline `Alert`+Retry inside `VisitTimeline`; already-loaded pages preserved.

**Smart search states:** idle (empty)→hint+recently-viewed; below-min→badge only, no fetch; loading→`LoadingState`/`Skeleton` rows with type-gated `placeholderData`; empty `[]`→`NoMatchRegister`; bill 404→distinct "No bill found for {n}" (NOT register); error 5xx→`Alert`+Retry.

---

## 7. ORDERED BUILD STEPS

Each step is independently testable. Backend blockers flagged. **Group B is hard-blocked until Q1 (branch header) is answered.**

**Step 0 — typed `ApiError` (TRUE prerequisite; no backend dep; FE infra).** `src/lib/utils.ts`: add `ApiError extends Error { status }`, throw it at line 37 (and 401 branch). All existing consumers read `err.status`. *Test: existing 401 redirect still fires; existing error toasts still show their message; `tsc` clean; a 404 and a 500 produce `ApiError` with the right `.status`.*

**Group A — Types & pure primitives (no backend dep for build; some unit-only)**
1. **Types** — add §6 types to `types/index.ts` (`ReportState`, `VisitWorkflowMode`, `VisitDelivery`, `Patient360Glance`, `Patient360Summary`, `Patient360TimelinePage`, `BillLookupResult`, `SearchKind`/`Detection`, `TimelineFilters`, `RecentPatient`, `PatientEditPayload`); extend `VisitTimelineItem` with optional `reportState?`, `hasAbnormalResults?`, `workflowMode?`, `delivery?` (keep existing `reportStatus`/`reportVersionId`/`finalizedAt`/flat discount fields for back-compat). Leave legacy `Patient360View` untouched. *Test: `tsc` compiles.*
2. **`lib/smartSearch.ts`** — `detectSearchType` (truly independent). *Test: unit table (phone with dashes, `P-01432`, `#MPR-2231`, email, 6-digit→name, etc.). Finalize the bill regex here (Q3).*
3. **`lib/recentPatients.ts`** (truly independent). *Test: unit (dedupe, cap 8, corrupt-JSON tolerance).*
4. **`StatusChip.tsx` + `mapReportStateToChip`** — all kinds + WCAG markup. *Test: render each variant in isolation. NOTE: unit-only — cannot be wired to real data until backend ships `reportState` (§6); against today's `reportStatus` it would render "Bill only"/nothing.*
5. **`useIsMobile.ts`**. *Test: matchMedia mock.*
6. **`qk` extension** in `query.ts`. *Test: `tsc`.*

**Group B — Data hooks** *(HARD-BLOCKED on Q1 + backend endpoints: `/patients/{id}/360/summary`, `/360/timeline` cursor-paginated, `/patients/search?patientNumber=`/`email=`, `/patients/by-bill/:billNumber`. All four are net-new/rewritten endpoints — the app currently calls one `/patients/{id}/360` returning legacy `Patient360View`.)*
7. **`usePatient360Summary`** + `normalizeTimelineFilters`/`buildTimelineQuery`. *Test: mocked `apiCall`; assert no `X-Branch-Id`; 404 → not-found via `ApiError.status`.*
8. **`usePatient360Timeline`** (infinite). *Test: filter change resets pageParam; `fetchNextPage` accumulates; exhaustion sets `hasNextPage=false`; two equal filter objects → identical key (no refetch loop); `staleTime`/`retry:false`/token-gate present.*
9. **`useSmartSearch` + `useBillLookup`**. *Test: 300ms debounce; min-length gate; stale key doesn't overwrite current; type-flip clears `placeholderData`; bill 404 (`ApiError.status===404`) ≠ patient `[]`.*
10. **`useReportActions`** *(report PDF + `/messages/:visitId/send-report` already exist, reused).* *Test: per-visit busy isolation; blob revoke on switch/close/unmount/isMobile-change; single sendWhatsApp.*
11. **`usePatientIdentityEdit`** *(BLOCKED on Q2 — PATCH response body).* *Test: invalidate path refetches summary only (timeline untouched); merge path (if Q2 confirms) writes server-computed fields.*

**Group C — Search page** *(depends on B7/B9. Phone+name work against the existing search endpoint; patientNumber/email/bill paths are backend-blocked and 404 until the new params/endpoint ship — degrade gracefully.)*
12. **`SmartSearchBar`**. *Test: type→badge; pill override; edit resets override.*
13. **`PatientMatchCard`, `BillResolveCard`, `NoMatchRegister`, `RecentlyViewed`**. *Test: render from fixtures.*
14. **`SmartSearchResults` switch + rewrite `GlobalPatientSearch.tsx`** (drop toggle/`submitted`/hardcoded branch). *Test: phone→list, name→list (against existing endpoint), bill→resolve / empty→register (against new endpoint once shipped), recent on empty input.*
14b. **`ClinicNewVisit` prefill reader (net-new).** Add `useLocation()` + seed `state.prefill` / `state.prefillPatientId` into the search/create step. *Test: navigate from no-match with `{prefill:{kind:'phone',value:'98…'}}` → new-visit lands with the phone pre-seeded; navigating directly (no state) behaves as before.*

**Group D — Detail page shell** *(depends on B7)*
15. **`Patient360LoadingSkeleton`, `Patient360ErrorState`, `useIsMobile` wired; rewrite `Patient360.tsx`** orchestrator (params + `?visit=` read, summary hook, skeleton/error routing, header + glance + empty body). *Test: skeleton while loading; 404 vs network split + Retry (via `ApiError.status`); header/glance render.*
16. **`PatientHeaderBar`, `GlanceStrip`, `NewVisitMenu`** (`enabledDomains` optional, defaults to all — see Q4). *Test: glance cells, due headline ▲, new-visit deep-link to `/clinic/new` with state.*

**Group E — Timeline + inspector** *(depends on B8, B10, A4)*
17. **`TimelineFilters`** + filter state. *Test: each control updates filters; cursor reset observable (new fetch).*
18. **`VisitTimeline` + `VisitRow` + `JumpToOriginalVisit`** (month buckets, load-older, chips, compact actions, cancelled styling; `VisitRow` is a `<div>` with a clickable header region that is a sibling of the action buttons — §8). *Test: pagination; jump-to-original bounded (loaded + capped page-forward + "couldn't locate" fallback); empty/filtered-empty; inline error.*
19. **`VisitInspector` + `FinancialDetailPanel` + `ReportActions` + `DeliveryStatusLine`** (desktop pane / mobile Drawer, inline iframe preview, print-bill, optional collect-payment). *Test: select row→inspector; ESC (pane-scoped)/✕/backdrop close; per-visit busy; blob revoke on visit-switch and isMobile-change; preview iframe.*
20. **`?visit=` + jump auto-open wiring** end-to-end (bounded routine from §4). *Test: deep-link from bill resolve scrolls+opens; filter-excluded target → filters cleared then located or "couldn't locate"; never hangs.*

**Group F — Edit flow** *(depends on B11, Q2)*
21. **Refactor `PatientEditDialog`**: review step + cache update per §3.4. *Test: identity change requires reason+review; address-only skips review; cache invalidates (or merges if Q2 confirms) with no full page reload.*

**Group G — Polish**
22. Responsive pass (desktop two-pane ↔ mobile single-col + filters Drawer + bottom-sheet), a11y pass (§8), recently-viewed write-on-load, empty/error copy, remove dead code from the old monolith.

---

## 8. ACCESSIBILITY & RESPONSIVE

- **WCAG chips:** every `StatusChip` = icon (`aria-hidden`) + visible text → meaning never color-only (SC 1.4.1). Abnormal chip `role="status"`. Delivery line follows the same icon+text rule.
- **`VisitRow` markup:** the row is a `<div>` with an explicit clickable header region (a real `<button>` or a `role="button"` element) that is a **sibling**, not an ancestor, of the action buttons. Interactive controls must not nest inside a `role="button"`/`<button>` (breaks AT semantics and double-fires `onSelect`). The action buttons `stopPropagation` regardless.
- **Focus / ESC:** mobile `Drawer` (vaul) and `Dialog` (Radix) trap focus + handle ESC/overlay natively. The desktop inspector pane (not a modal) gets an `Escape` keydown listener **scoped to the pane element and attached only while open** — never a `document`-level listener (which would close the edit Dialog underneath). On open, move focus to the inspector heading; on close, return focus to the originating `VisitRow`, **falling back to the timeline container heading if that row unmounted** (e.g. a filter changed while the inspector was open — the saved ref would point at a detached node).
- **Keyboard nav:** the row's clickable region handles Enter/Space → select. Override pills and Open buttons are real `Button`s. Search input gets `aria-label`. The detection badge's `aria-live="polite"` updates announce the **settled (debounced) detection**, not every keystroke — otherwise screen-reader users get a torrent as `9`→`98`→`987` flips name→phone. Filters use native `Select`/`Checkbox`. "Load older" is a real button (also serves no-JS-scroll users).
- **Desktop↔mobile:** breakpoint 768px via `useIsMobile`. Desktop: sticky header, full-width 4-cell glance, inline filters, two-pane body (`Timeline flex:1.35` | `Inspector flex:1`, always mounted), inline PDF in the right pane. Mobile: header collapses (name + ⋮ overflow for Edit), identity chips wrap; glance 2×2 with Due first; filters behind a "⚙ Filters" Drawer (domain segmented control stays inline); inspector = bottom Drawer; PDF preview full-screen within the same Drawer flow. Search page is single-column responsive throughout.
- **Reduced motion:** respect `prefers-reduced-motion` for Drawer scale/slide.

---

## 9. VERIFICATION PLAN

All commands run from the frontend repo `/Users/pranavreddy/Desktop/sobhana portal/health-hub` (the backend is the sibling `health-hub-backend`).

### 9.1 Static / build gates (run after every group)
```bash
cd "/Users/pranavreddy/Desktop/sobhana portal/health-hub"
npm run lint          # ESLint
npx tsc --noEmit      # type gate — must be clean after Step 0, Group A, and each hook
npm run build         # vite production build must succeed before any push
npm test              # unit suites: smartSearch, recentPatients, normalizeTimelineFilters, StatusChip
```
Backend (separate terminal), needed for any integration flow:
```bash
cd "/Users/pranavreddy/Desktop/sobhana portal/health-hub-backend"
npm run dev           # or the project's start script; confirm /patients/360* endpoints are served
```
Then `npm run dev` in the frontend and open the printed localhost URL. Log in as a `staff` or `owner` user (both Patient360 routes are role-gated).

### 9.2 Per-flow manual verification

- **Step 0 / ApiError regression** — let a token expire (or clear it) and hit any authed page: confirm the 401 path still logs out and redirects to `/login`. Force a generic backend error and confirm the existing error toast still shows the server message. In devtools, throw a 404 from summary and confirm `error instanceof ApiError && error.status===404`.
- **Search type-detection** — go to `/clinic/patient-search`. Type `9876543` → phone badge; `P-01432` → patientNumber badge (NOT bill); `#MPR-2231` → bill badge; `a@b.com` → email badge; `Ramesh` → name badge. Edit text after clicking an override pill → detection re-auto-detects. Confirm the network request fires only on the 300ms-debounced value (Network tab), and the `aria-live` badge announces only the settled detection (VoiceOver/NVDA).
- **Shared-phone disambiguation** — search a phone number shared by two patients; confirm both `PatientMatchCard`s render with distinct name + patientNumber + age·gender, and Open routes to the correct `patientId`.
- **Bill → visit** — type a known bill number; confirm `BillResolveCard` renders, "Open visit" navigates to `/clinic/patient-360/:patientId?visit=:visitId`, and the detail page auto-selects+scrolls+opens the inspector for that visit. Type a non-existent bill → "No bill found for {n}" (NOT the register card). Confirm in Network that bill-404 and a simulated bill-500 take different branches (requires Step 0).
- **No-match → register** — search a phone with no match → `NoMatchRegister`; click Register → lands on `/clinic/new` with the phone pre-seeded (verifies the Step 14b reader). Navigating to `/clinic/new` directly still works.
- **Timeline filter + infinite scroll** — open a patient with many visits. Change domain/date/branch/Unpaid filters; confirm the list resets to the newest page (Network shows a fresh request with no cursor) and the glance numbers do NOT refetch. Click "Load older" repeatedly; confirm pages accumulate and the button disappears when `hasNextPage` is false. Toggle a filter back and forth and confirm no infinite refetch loop (Network is quiet at rest).
- **Inspector + inline PDF + ESC** — select a row → inspector opens (desktop right pane; mobile bottom Drawer via narrowing the window < 768px or device emulation). View a finalized diagnostics report → PDF renders in the inline iframe (no separate modal). Press Escape → inspector closes and focus returns to the originating row. Open the edit Dialog, then press Escape → only the Dialog closes, the inspector listener does NOT also fire (pane-scoped listener check). Change a filter that removes the open visit, then close the inspector → focus falls back to the timeline heading (no console error about a detached node).
- **Report send + delivery status** — click WhatsApp on a finalized report → success toast, single POST to `/messages/:visitId/send-report` in Network (confirm exactly ONE request, no duplicate). Confirm `DeliveryStatusLine` shows the furthest-reached step (Sent→Delivered→Read) and is hidden when `delivery` is null.
- **Edit review-step** — open Edit, change name → Review step appears requiring a `changeReason`; Confirm & Save. Change address only → saves without a Review step. After save, confirm the header name updates with NO full page reload (Network shows one scoped summary refetch, or zero requests if Q2 confirms the merge path). The timeline does NOT refetch.
- **Error / retry** — point the frontend at a stopped backend (or block the summary request): a real 404 patient → "Patient not found" + Back-to-Search (no Retry); a 5xx/network error → destructive Alert + Retry that calls `refetch`. A timeline-page failure with a healthy summary → inline Alert+Retry inside the timeline with earlier pages preserved.

### 9.3 Per-visit loading + no blob leak (explicit)
- **Per-visit loading isolation** — in a timeline with ≥2 finalized-report visits, click View on visit A; confirm only A's button shows `Loader2` and disables, while visit B's button stays enabled and clickable. (Fixes the shared-`previewLoading` bug.)
- **No blob leak** — open DevTools → Memory, or instrument `URL.createObjectURL`/`revokeObjectURL` with a counter in the console:
  ```js
  // paste in console before testing
  let live = 0; const c = URL.createObjectURL, r = URL.revokeObjectURL;
  URL.createObjectURL = (...a) => { live++; console.log('blob+', live); return c(...a); };
  URL.revokeObjectURL = (...a) => { live--; console.log('blob-', live); return r(...a); };
  ```
  Then: preview visit A → `live=1`; select visit B without previewing → `live=0` (inspector's `selectedVisitId` effect revoked A); preview B → `live=1`; close inspector → `live=0`; resize across the 768px breakpoint with a preview open → `live=0` (isMobile-change revoke); navigate away from the page → `live=0` (unmount revoke). At no point should `live` climb monotonically.

---

## 10. OPEN QUESTIONS FOR THE OWNER

1. **(BLOCKING — gates Group B) Branch header on `/360*` + `/patients/*`.** Resolved to NO `X-Branch-Id` (global). Confirm the backend treats these four endpoints as global/audit-only and does NOT filter by branch header. If it actually scopes by branch, switch those hooks to `branchRequest` and add `branchId` back into the keys. This is the highest-risk assumption: a wrong answer surfaces as silent "missing visits," not an error.
2. **(BLOCKING — gates Group F cache strategy) PATCH `/patients/:id` response body.** Does it return the full updated `Patient` (server-computed `ageDisplay`, uppercased `name`)? The existing dialog refetches on success, implying the body is NOT trusted today. Default is `invalidateQueries` (one scoped refetch); in-place `setQueryData` merge is enabled only if you confirm the full body is returned.
3. **Bill-number regex.** Real bill-number format (prefix length, separators, leading `#`)? Needed to finalize `detectSearchType` and its Step 2 unit test (two candidate patterns exist; pick one).
4. **`enabledDomains` source.** Where does the per-tenant enabled-domain list come from (summary payload? auth/tenant config?)? MEMORY forbids building a toggle framework, so `enabledDomains` is an **optional** prop defaulting to all domains until a real producer exists — confirm there's no field we should be reading instead.
5. **Collect-payment route.** There is no `/clinic/billing`. Confirm whether `/money/bills` accepts a visit filter (e.g. `?visitId=`) for the inspector's "collect payment" link; if not, v1 ships print-bill only (`/bill/print/:domain/:visitId`) and drops collect-payment.
6. **`reportState.version` semantics.** Confirm `version` is the max **finalized** versionNum (not the trailing DRAFT) so "Finalized v{n}" is correct.
7. **Recently-viewed scope.** Single global localStorage key across branches (patients are global) — acceptable, or must it be per-user/per-branch to avoid front-desk cross-talk on shared machines?
