/**
 * Patient360 mobile breakpoint hook (§5).
 *
 * Self-contained in the patient360 folder (Axora-ready isolation) rather than
 * reusing the app-wide use-mobile, because Patient360 uses the inclusive
 * `(max-width: 768px)` boundary specified in the plan and drives the
 * desktop-pane ↔ bottom-Drawer swap off it.
 */
import { useEffect, useState } from "react";

const QUERY = "(max-width: 768px)";

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    // sync once in case the value changed between initial render and effect
    setIsMobile(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}
