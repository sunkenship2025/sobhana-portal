import { QueryClient } from "@tanstack/react-query";

/**
 * Single app-wide QueryClient instance.
 *
 * Exported as a module singleton (instead of `new QueryClient()` inline in
 * App.tsx) so non-React code — notably `branchStore.setActiveBranch` — can
 * flush the cache on branch switch without reaching for `useQueryClient()`.
 * See the branch-switch contract documented in `store/branchStore.ts`.
 */
export const queryClient = new QueryClient();
