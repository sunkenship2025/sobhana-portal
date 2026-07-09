/**
 * Patient360 data layer — react-query hooks for the four GLOBAL endpoints
 * (summary, infinite timeline, smart search, bill lookup) plus the identity-edit
 * mutation. (06-frontend-plan.md §3 / Group B steps 7-9, 11.)
 *
 * BINDING DECISION 1: these endpoints are global (cross-branch). They go through
 * `apiCall` — NO `X-Branch-Id` — and their query keys carry NO branchId. Report
 * PDF + WhatsApp-send are the only genuinely branch-scoped paths (useReportActions).
 */
import { useEffect, useState } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { apiCall, useApiQuery, useApiMutation, qk } from "@/lib/query";
import { apiRequest } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { useAuthStore } from "@/store/authStore";
import { detectSearchType, searchParamFor } from "@/lib/smartSearch";
import type {
  Patient,
  Patient360Summary,
  Patient360TimelinePage,
  PatientSearchPage,
  BillLookupResult,
  PatientEditPayload,
  SearchKind,
  TimelineFilters,
} from "@/types";

// ---------------------------------------------------------------------------
// normalizeTimelineFilters / buildTimelineQuery — pure, co-located, unit-testable.
// normalizeTimelineFilters MUST be referentially predictable: two logically-equal
// filter objects must produce a value that serializes to identical key JSON, or
// the timeline key churns every render → infinite refetch + the cursor never
// resets. We achieve this with canonical property order + dropped defaults +
// clamped pageSize, and feed the SAME normalized object into both the key and
// the queryFn (no double-memoization).
// ---------------------------------------------------------------------------

const DEFAULT_PAGE_SIZE = 20;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 50;

/** A canonicalized, defaults-dropped view of the filters used in the query key. */
export interface NormalizedTimelineFilters {
  domain: TimelineFilters["domain"];
  from: string | null;
  to: string | null;
  branchId: string | null;
  unpaidOnly: boolean;
  includeCancelled: boolean;
  pageSize: number;
}

function clampPageSize(pageSize: number | undefined): number {
  if (pageSize === undefined || Number.isNaN(pageSize)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.trunc(pageSize)));
}

/**
 * Canonicalize filters so logically-equal inputs serialize identically in the
 * key. Property order is FIXED here (object-literal insertion order is stable in
 * JSON.stringify), undefined/empty values collapse to null/false, pageSize is
 * clamped. Pure — no React, no memoization.
 */
export function normalizeTimelineFilters(
  filters: TimelineFilters | undefined,
): NormalizedTimelineFilters {
  const f = filters ?? {
    domain: null,
    from: null,
    to: null,
    branchId: null,
    unpaidOnly: false,
    includeCancelled: false,
  };
  return {
    domain: f.domain ?? null,
    from: f.from ?? null,
    to: f.to ?? null,
    branchId: f.branchId ?? null,
    unpaidOnly: f.unpaidOnly ?? false,
    includeCancelled: f.includeCancelled ?? false,
    pageSize: clampPageSize(f.pageSize),
  };
}

/**
 * Build the `?...` query string for the timeline endpoint from the NORMALIZED
 * filters + the cursor (pageParam). Cursor is NEVER part of the key — it lives
 * only here. Returns "" or "?a=b&c=d".
 */
export function buildTimelineQuery(
  normalized: NormalizedTimelineFilters,
  pageParam: string | undefined,
): string {
  const params = new URLSearchParams();
  if (normalized.domain) params.set("domain", normalized.domain);
  if (normalized.from) params.set("from", normalized.from);
  if (normalized.to) params.set("to", normalized.to);
  if (normalized.branchId) params.set("branchId", normalized.branchId);
  if (normalized.unpaidOnly) params.set("unpaidOnly", "true");
  if (normalized.includeCancelled) params.set("includeCancelled", "true");
  params.set("pageSize", String(normalized.pageSize));
  if (pageParam) params.set("cursor", pageParam);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// ---------------------------------------------------------------------------
// usePatient360Summary — glance + identity. retry:false so a real 404 surfaces
// instantly as not-found instead of three retries. Page-independent: refetched
// only on identity-edit invalidation, never on timeline paging.
// ---------------------------------------------------------------------------

export function usePatient360Summary(patientId?: string) {
  return useApiQuery<Patient360Summary>({
    queryKey: qk.patient360Summary(patientId ?? ""),
    queryFn: ({ signal }) =>
      apiCall<Patient360Summary>(`/patients/${patientId}/360/summary`, { signal }),
    enabled: !!patientId,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// usePatient360Timeline — the app's first infinite query. useInfiniteQuery is
// NOT wrapped by useApiQuery, so the wrapper's defaults (token gate, staleTime)
// are lost and must be set explicitly here.
// ---------------------------------------------------------------------------

export function usePatient360Timeline(
  patientId: string | undefined,
  filters: TimelineFilters,
) {
  const token = useAuthStore((s) => s.token);
  const normalized = normalizeTimelineFilters(filters);

  return useInfiniteQuery<
    Patient360TimelinePage,
    Error,
    { pages: Patient360TimelinePage[]; pageParams: (string | undefined)[] },
    QueryKey,
    string | undefined
  >({
    // filters in the KEY, cursor in pageParam (NEVER in the key). Any filter
    // change → new cache entry → fresh pageParam=undefined (newest page).
    queryKey: qk.patient360Timeline(patientId ?? "", normalized as TimelineFilters),
    queryFn: ({ pageParam, signal }) =>
      apiCall<Patient360TimelinePage>(
        `/patients/${patientId}/360/timeline${buildTimelineQuery(normalized, pageParam)}`,
        { signal },
      ),
    initialPageParam: undefined,
    getNextPageParam: (last) =>
      last.pageInfo.hasMore ? last.pageInfo.nextCursor ?? undefined : undefined,
    enabled: !!patientId && !!token,
    staleTime: 30_000,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// useSmartSearch — 300ms debounce (no lib), type detection, type-gated
// placeholderData so a detection flip clears stale-type results.
// ---------------------------------------------------------------------------

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PAGE_SIZE = 20;

export function useSmartSearch(
  raw: string,
  overrideType?: SearchKind,
  page = 1,
) {
  const [debounced, setDebounced] = useState(raw);

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(raw), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [raw]);

  const detection = detectSearchType(debounced);
  const type: SearchKind = overrideType ?? detection.kind;
  // The network-ready value: for an override we re-run min-length gating against
  // the same raw text via the detected value when the kinds match, else the
  // trimmed input (override paths like patientNumber/email still need a value).
  const param = searchParamFor(type);
  const value = overrideType
    ? debounced.trim()
    : detection.value ?? "";

  const enabled =
    !!param && type !== "bill" && value.length >= 2;

  // Paginated envelope: `?page=&pageSize=` switches the backend to the ranked
  // { results, total, hasMore } shape. The full match set is ranked server-side
  // (exact name first), so the best match is never truncated out of a page.
  const query = useApiQuery<PatientSearchPage>({
    queryKey: qk.patientSmartSearch(type, value, page),
    queryFn: ({ signal }) =>
      apiCall<PatientSearchPage>(
        `/patients/search?${param}=${encodeURIComponent(value)}&page=${page}&pageSize=${SEARCH_PAGE_SIZE}`,
        { signal },
      ),
    enabled,
    staleTime: 30_000,
    // Type-gated: keep prior data ONLY when the previous key's `type` (index 2)
    // matches the current type, so results persist between same-type keystrokes
    // and page flips but CLEAR the moment effectiveKind flips (no stale phone
    // rows under a name query). queryKey is
    // ['patientSearch','smart',type,q,page] → type at index 2.
    placeholderData: (prev, prevQuery) =>
      prevQuery && (prevQuery.queryKey as QueryKey)[2] === type ? prev : undefined,
  });

  const pageData = query.data;

  // Expose the settled detection + the effective (override-aware) kind so the
  // SmartSearchBar can render the badge / announce the SETTLED detection, and
  // so the host can fork the bill path to useBillLookup. `billValue` is the
  // normalized bill number when the effective kind is "bill", else null.
  return {
    ...query,
    /** Current page of results (ranked; empty until the first page loads). */
    results: pageData?.results ?? [],
    /** Full match count across all pages (drives the count line + pager). */
    total: pageData?.total ?? 0,
    /** True when another page exists after this one. */
    hasMore: pageData?.hasMore ?? false,
    /** Server page size (rows per page). */
    pageSize: pageData?.pageSize ?? SEARCH_PAGE_SIZE,
    /** Settled (debounced) auto-detected kind — drives the aria-live badge. */
    detectedKind: detection.kind,
    /** Override ?? detection — the kind in effect right now. */
    effectiveKind: type,
    /** Network-ready value for the active query (null below min-length). */
    value: enabled ? value : null,
    /** True when a /patients/search query is enabled for the current input. */
    active: enabled,
    /** Normalized bill number when effectiveKind === "bill", else null. For an
     *  override to bill we fall back to the trimmed input since the raw text may
     *  not match the auto-detect bill regex. */
    billValue:
      type === "bill"
        ? overrideType
          ? debounced.trim() || null
          : detection.value
        : null,
  };
}

// ---------------------------------------------------------------------------
// useBillLookup — bill → visit. retry:false; the consumer treats
// ApiError.status===404 as "no such bill" (distinct from /search's []).
// ---------------------------------------------------------------------------

export function useBillLookup(billNumber: string | undefined, enabled = true) {
  const trimmed = (billNumber ?? "").trim();
  return useApiQuery<BillLookupResult>({
    queryKey: qk.billLookup(trimmed),
    queryFn: ({ signal }) =>
      apiCall<BillLookupResult>(
        `/patients/by-bill/${encodeURIComponent(trimmed)}`,
        { signal },
      ),
    enabled: enabled && trimmed.length >= 3,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// usePatientIdentityEdit — PATCH /patients/:id. The backend PATCH returns the
// updated Prisma patient row but NOT the computed age/ageDisplay (those are
// derived in the summary/search shapers, not the PATCH path), so we do NOT
// setQueryData-merge — we invalidate the summary (the floor per §3.4). Timeline
// untouched (visits carry no identity fields).
// ---------------------------------------------------------------------------

export function usePatientIdentityEdit(patientId: string) {
  const qc = useQueryClient();
  return useApiMutation<Patient, PatientEditPayload>({
    mutationFn: (payload) =>
      apiRequest<Patient>(`${API_BASE}/patients/${patientId}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.patient360Summary(patientId) });
    },
  });
}
