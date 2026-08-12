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

    // window "focus" fires on alt-tab back to the browser; visibilitychange
    // fires when the tab itself is switched to. Cover both.
    const onFocus = () => refetchRef.current();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refetchRef.current();
    };

    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    // Server push — arrives within ~1s of another device's write. Routed through
    // the visibility check, not straight to refetch: a backgrounded tab keeps its
    // SSE open, and refetching a list nobody is looking at is the load this whole
    // change is meant to remove. It revalidates on the way back in regardless.
    // The poll below stays as the backstop for a blocked or dropped stream.
    window.addEventListener(WORKLIST_EVENT, onVisibility);

    let interval: ReturnType<typeof setInterval> | undefined;
    if (pollMs && pollMs > 0) {
      interval = setInterval(onVisibility, pollMs);
    }

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener(WORKLIST_EVENT, onVisibility);
      if (interval) clearInterval(interval);
    };
  }, [enabled, pollMs]);
}
