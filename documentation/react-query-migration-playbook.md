# React Query migration playbook

162 inline `fetch()` sites across 31 files (65 queries / 83 mutations / 33 imperative), heaviest in `pages/owner/Manage*`. Migrate **one page at a time** onto a single pattern. Source: workflow `react-query-migration-plan` (wf_a57656e9-385).

## Shared layer — `src/lib/query.ts`
Branch header is injected in the **wrapper**, never in `apiRequest` (keep its global blast radius zero — callers that deliberately omit `X-Branch-Id` must stay unaffected).

- `branchRequest<T>(path, branchId, options?)` — `apiRequest` + `X-Branch-Id`. `branchId` is required so the queryFn passes the same id that's in the key (no `getState()` drift).
- `apiCall<T>(path, options?)` — `apiRequest` + `API_BASE`, no branch header.
- `useApiQuery<T>({ branchScoped?, enabled?, queryKey, queryFn, ... })` — reactive GET; auto-guards on `!!token` and (when `branchScoped`) `!!activeBranchId`; default `staleTime: 30_000`.
- `useApiMutation<TData,TVars>({ mutationFn, invalidate?, onSuccess?, ... })` — `invalidate` is a list of key-prefixes invalidated on success (before the caller's `onSuccess`). `isPending` replaces `submitting`/`deleting`.
- `apiFetchQuery<T>(qc, key, path, branchId, { staleTime? })` — imperative fetch-on-action (openEdit, preview).
- `useBranchId()` / `qk` — `activeBranchId` selector + query-key factory.

## Query-key rule
A key carries `branchId` **iff** the call is branch-scoped in any form (header **or** `?branchId=` param). Exceptions to respect:
- `referral-doctors` / `clinic-doctors` lists are **global** → key carries **no** branchId.
- `billable-products` is branch-scoped via a `?branchId=` **param** → key **does** carry branchId.

## Stays raw `fetch` (never `apiRequest`)
PDF/blob exports (`/payouts/export`, `/payouts/:id/export`, ReportPreview, `reportAccess.ts`); multipart uploads (4 signature uploads, external-uploads POST — FormData, no Content-Type); the unload `keepalive` POST in ResultEntry; transient preview/derive loops (PayoutRunCycle, PanelDefinitions `handlePreview`).

## Never migrate
`apiRequest`, `authStore` login/logout/hydrate, `branchStore.fetchBranches`, `reportAccess.ts`. `use-doctor-lookup.ts` is already on RQ — exemplar; keep its keys + `invalidateDoctorLookups()`. The visit pages' patient-search `fetchQuery` is canonical — leave it.

## Migration order
1. Shared layer (`src/lib/query.ts`).
2. **`ManageDoctors.tsx`** (first; proves the pattern + external-cache invalidation).
3. `ManageClinicDoctors.tsx` (twin).
4. Branch-scoped CRUD: `ManageDiagnosticCenters`, `ManageDepartments` (prove `branchScoped`; also wire `setActiveBranch → queryClient.clear()` here).
5. Payouts family (4 files together — `['payouts']` namespace).
6. Heavy `Manage*` one at a time: BillableProducts → ClinicalDefinitions → PanelDefinitions → DoctorsAndReferrals → **SigningDoctors last** (multipart + sequenced chains).
7. Shared singletons: Dashboard, BillPrintPage, PatientEditDialog, TestInputConfigEditor.
8. Visits/clinical last (GETs first): ClinicVisitQueue, FinalizedReports, PendingResults, Patient360, ReportPreview, the two NewVisit pages, **ResultEntry dead last** (migrate only its 3 GETs + 2 uploads; leave the auto-save engine + keepalive).

## Gotchas
- Preserve header inconsistencies, don't normalize (esp. `ManageDoctorsAndReferrals`, the two `whatsappOptIn` PATCHes that omit `X-Branch-Id`).
- Typed errors for status-specific UX: 404 (BillPrintPage, PayoutDetail, Patient360→`data:null`), 409 (PayoutDetail "already paid") — detect status in the queryFn/mutationFn (apiRequest collapses status into a message).
- Swallow-error fallbacks must survive (return the fallback inside the queryFn): doctor-lookup `{}/[]`, TestInputConfigEditor `defaultInputConfig`, Patient360 404 `null`.
- Sequenced chains use `mutateAsync` (SigningDoctors create→upload→invalidate; ClinicalDefinitions save-def→PUT test-input-config with rootId from the create response).
- Optimistic updates: skip for v1 — `invalidateQueries` reproduces today's refetch-after-mutation exactly.
