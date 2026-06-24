/**
 * React Query layer — thin wrappers over `apiRequest` + @tanstack/react-query.
 *
 * The branch header is injected HERE, never in `apiRequest`, so callers that
 * deliberately omit `X-Branch-Id` (global lists, doctor lookups) are untouched.
 * Pages keep their own queryKey + queryFn so the pattern stays greppable.
 *
 * See documentation/react-query-migration-playbook.md for the per-page plan,
 * key conventions, and the things that must stay raw `fetch` (blobs/multipart/
 * keepalive). The `qk` factory grows as pages migrate.
 */
import {
  useQuery,
  useMutation,
  useQueryClient,
  type UseQueryOptions,
  type UseMutationOptions,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import { apiRequest } from "@/lib/utils";
import { API_BASE } from "@/lib/api";
import { useBranchStore } from "@/store/branchStore";
import { useAuthStore } from "@/store/authStore";
import type { SearchKind, TimelineFilters } from "@/types";

/** `apiRequest` + `X-Branch-Id`. `branchId` is required so the queryFn sends
 *  the same id that's in the queryKey (no `getState()` drift on branch switch). */
export function branchRequest<T>(
  path: string,
  branchId: string,
  options: RequestInit = {},
): Promise<T> {
  return apiRequest<T>(`${API_BASE}${path}`, {
    ...options,
    headers: { "X-Branch-Id": branchId, ...options.headers },
  });
}

/** `apiRequest` + `API_BASE`, no branch header (for global endpoints). */
export function apiCall<T>(path: string, options: RequestInit = {}): Promise<T> {
  return apiRequest<T>(`${API_BASE}${path}`, options);
}

/** Reactive `activeBranchId` selector (re-renders / re-gates on branch switch). */
export const useBranchId = () => useBranchStore((s) => s.activeBranchId);

type ApiQueryOptions<T> = Omit<
  UseQueryOptions<T, Error, T, QueryKey>,
  "enabled"
> & {
  /** Also gate the query on an active branch being selected. */
  branchScoped?: boolean;
  enabled?: boolean;
};

/** Reactive GET. Auto-guards on `token` (and `branchId` when `branchScoped`). */
export function useApiQuery<T>(opts: ApiQueryOptions<T>) {
  const token = useAuthStore((s) => s.token);
  const branchId = useBranchStore((s) => s.activeBranchId);
  const { branchScoped, enabled, ...rest } = opts;
  return useQuery<T, Error>({
    staleTime: 30_000,
    ...rest,
    enabled: !!token && (!branchScoped || !!branchId) && (enabled ?? true),
  });
}

/** Mutation that invalidates a set of key-prefixes on success (before the
 *  caller's own `onSuccess`). */
export function useApiMutation<TData, TVars>(
  opts: UseMutationOptions<TData, Error, TVars> & {
    invalidate?: readonly (readonly unknown[])[];
  },
) {
  const qc = useQueryClient();
  const { invalidate, onSuccess, ...rest } = opts;
  return useMutation<TData, Error, TVars>({
    ...rest,
    onSuccess: (data, vars, ctx) => {
      invalidate?.forEach((key) =>
        qc.invalidateQueries({ queryKey: key as QueryKey }),
      );
      onSuccess?.(data, vars, ctx);
    },
  });
}

/** Imperative fetch-on-action (open-edit, preview). Caller must guard token/branch. */
export function apiFetchQuery<T>(
  qc: QueryClient,
  key: readonly unknown[],
  path: string,
  branchId: string | null,
  opts: { staleTime?: number } = {},
): Promise<T> {
  return qc.fetchQuery<T>({
    queryKey: key as QueryKey,
    queryFn: ({ signal }) =>
      branchId
        ? branchRequest<T>(path, branchId, { signal })
        : apiCall<T>(path, { signal }),
    staleTime: opts.staleTime ?? 0,
    retry: 1,
  });
}

/**
 * Query-key factory. A key carries `branchId` iff the call is branch-scoped in
 * any form (header OR `?branchId=` param). Grows as pages migrate — see the
 * conventions table in the playbook.
 */
export const qk = {
  // --- global (no branchId in key) ---
  referralDoctors: () => ["referral-doctors"] as const,
  clinicDoctors: () => ["clinic-doctors"] as const,
  // --- patient360 (global endpoints — NO branchId in key; resolution 1/§11) ---
  // Cross-branch stale-leak is prevented by queryClient.clear() on branch switch.
  patient360Summary: (patientId: string) =>
    ["patient360", "summary", patientId] as const,
  patient360Timeline: (patientId: string, filters: TimelineFilters) =>
    ["patient360", "timeline", patientId, filters] as const,
  patientSmartSearch: (type: SearchKind, q: string) =>
    ["patientSearch", "smart", type, q] as const,
  billLookup: (billNumber: string) => ["billLookup", billNumber] as const,
  // --- branch-scoped (branchId in key; flushed wholesale on branch switch) ---
  diagnosticCenters: (branchId: string | null) =>
    ["diagnostic-centers", branchId] as const,
  departments: (branchId: string | null) => ["departments", branchId] as const,
} as const;
