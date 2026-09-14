import { useEffect, useRef } from "react";

/**
 * Window event carrying the server's "a visit changed" push. `CatalogSync` in
 * App.tsx translates a `worklist` SSE frame into this; every list already using
 * `useRevalidateOnFocus` picks it up with no per-page wiring. A window event
 * rather than react-query invalidation because these lists own their own fetch
 * and are not in the query cache.
 */
export const WORKLIST_EVENT = "worklist-changed";

/**
 * How close together two triggers have to be to count as the same revalidation.
 * Sized for the focus/visibilitychange pair, which land ~90ms apart; an SSE frame
 * swallowed inside this window is already carried by the fetch that just started.
 */
const COALESCE_MS = 1000;

/**
 * Re-run `refetch` when the user returns to a stale tab — or when the server
 * says the data changed.
 *
 * Staff worklists (Pending Results, Finalized, Clinic Finalized) are left open
 * for hours on counter phones, where mobile browsers freeze background tabs:
 * switching back does NOT remount the page, so a plain one-shot fetch keeps
 * painting an old snapshot (e.g. "Result Queue (0)" long after new bills were
 * created) until the staff manually pull-to-refresh. This revalidates on
 * tab-visible / window-focus — and, while the tab is visible, on a light poll —
 * so the list tracks current data without a reload.
 *
 * The callback is expected to fetch SILENTLY (no full-page loading spinner), so
 * revalidation swaps the data in place without a visible flash. It is held in a
 * ref so callers can pass an inline closure without re-subscribing the
 * listeners on every render.
 *
 * Poll timers only fire while the tab is visible, so a backgrounded/frozen
 * phone tab contributes zero backend load.
 */
export function useRevalidateOnFocus(
  refetch: () => void,
  opts: { enabled?: boolean; pollMs?: number } = {},
) {
  const { enabled = true, pollMs } = opts;
  const refetchRef = useRef(refetch);
  refetchRef.current = refetch;

  useEffect(() => {
    if (!enabled) return;

    // ONE handler for all four triggers, behind a coalescing window.
    //
    // Alt-tabbing back to the browser fires `focus` AND `visibilitychange`. They used to
    // be two handlers — `focus` calling refetch directly, `visibilitychange` calling it
    // behind a visibility check — and a visibility check gates each one without
    // deduplicating BETWEEN them. So every return to the tab fetched the same list
    // twice. Seen in production: /api/visits/diagnostic?status=DRAFT answered at
    // 08:00:00.578 and again at .679, 95KB and 52KB, 101ms apart, byte-identical query.
    //
    // The visibility check still matters for the other two triggers: a backgrounded tab
    // keeps its SSE open, and refetching a list nobody is looking at is the load this
    // whole mechanism exists to avoid. It revalidates on the way back in regardless, and
    // the poll stays as the backstop for a blocked or dropped stream.
    let lastAt = 0;
    const revalidate = () => {
      if (document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastAt < COALESCE_MS) return;
      lastAt = now;
      refetchRef.current();
    };

    window.addEventListener("focus", revalidate);
    document.addEventListener("visibilitychange", revalidate);
    window.addEventListener(WORKLIST_EVENT, revalidate);

    let interval: ReturnType<typeof setInterval> | undefined;
    if (pollMs && pollMs > 0) {
      interval = setInterval(revalidate, pollMs);
    }

    return () => {
      window.removeEventListener("focus", revalidate);
      document.removeEventListener("visibilitychange", revalidate);
      window.removeEventListener(WORKLIST_EVENT, revalidate);
      if (interval) clearInterval(interval);
    };
  }, [enabled, pollMs]);
}
