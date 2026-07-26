import { useEffect, useRef } from "react";

/**
 * Re-run `refetch` when the user returns to a stale tab.
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

    let interval: ReturnType<typeof setInterval> | undefined;
    if (pollMs && pollMs > 0) {
      interval = setInterval(onVisibility, pollMs);
    }

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
      if (interval) clearInterval(interval);
    };
  }, [enabled, pollMs]);
}
