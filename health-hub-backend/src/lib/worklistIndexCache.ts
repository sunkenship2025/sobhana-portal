/**
 * Tiny in-process TTL cache for a worklist's ordered visit-ID "index".
 *
 * The Finalized worklists (status=COMPLETED) paginate server-side. Computing
 * the ordered/filtered/ranked candidate list is the expensive part; slicing a
 * page out of it is free. Staff page back and forth (1→2→3→3→2→1) within
 * seconds, so we cache just the ordered ID list + total per (branch, date
 * lower-bound, search term) and serve every page from it, hydrating only the
 * ~20 rows actually shown.
 *
 * Deliberately in-process, not Redis: the service runs a single instance, so
 * there's no cross-instance coherency need; this avoids a Redis round-trip per
 * page click, keeps the transient-network-error surface (ECONNABORTED) off the
 * hot path, and adds nothing to the PDF-cache Redis. On restart the cache is
 * simply cold — a correctness no-op.
 *
 * Only the STABLE parts (membership + ordering) are cached here. Volatile
 * per-row display state (Printed / Sent / Paid) is NOT — it comes from the
 * fresh per-page hydration, so it stays live even within a cached window.
 */

/** Ordering/membership is this stale at most before a recompute. Matches the
 *  app's existing worklist freshness (60s focus-poll, 30s owner-card TTL), so
 *  a newly finalized report still surfaces within the usual window. */
export const WORKLIST_INDEX_TTL_MS = 45_000;

interface IndexEntry {
  ids: string[];
  total: number;
  expiresAt: number;
}

const store = new Map<string, IndexEntry>();
// Backstop so a burst of distinct filter combos can't grow the map unbounded.
// Each entry is a few thousand short strings at most; 200 combos is generous.
const MAX_ENTRIES = 200;

export function getWorklistIndex(
  key: string,
): { ids: string[]; total: number } | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return { ids: entry.ids, total: entry.total };
}

export function setWorklistIndex(
  key: string,
  ids: string[],
  total: number,
  ttlMs: number = WORKLIST_INDEX_TTL_MS,
): void {
  if (store.size >= MAX_ENTRIES && !store.has(key)) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (now > v.expiresAt) store.delete(k);
    }
    if (store.size >= MAX_ENTRIES) {
      // Still full of live entries — drop the oldest-inserted one.
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
  }
  store.set(key, { ids, total, expiresAt: Date.now() + ttlMs });
}
