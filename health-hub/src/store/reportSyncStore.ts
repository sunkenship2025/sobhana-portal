/**
 * Report Auto-Sync — Zustand (persisted)
 *
 * Preference for the radiology / text-based report editors: when ON, drafts
 * auto-save in the background; when OFF, each report saves on demand via its
 * own Save button.
 *
 * Two levels:
 *   - orgDefault: the org-wide default, stored server-side. Only the lab
 *     incharge can change it ("for all"). Fetched at runtime — NOT persisted
 *     here (the server is the source of truth).
 *   - personal:   a per-user override kept in localStorage, keyed by userId, so
 *     it's remembered for that user on this device and different users on the
 *     same machine don't clash.
 *
 * Effective value for a user = personal[userId] if set, else orgDefault, else
 * on. See `effectiveAutoSync`.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ReportSyncState {
  /** Org-wide default from the server (default on until fetched). */
  orgDefault: boolean;
  /** userId -> personal override. Absent = follow the org default. */
  personal: Record<string, boolean>;
  setOrgDefault: (on: boolean) => void;
  setPersonal: (userId: string, on: boolean | null) => void;
}

export const useReportSync = create<ReportSyncState>()(
  persist(
    (set) => ({
      orgDefault: true,
      personal: {},
      setOrgDefault: (on) => set({ orgDefault: on }),
      setPersonal: (userId, on) =>
        set((state) => {
          const next = { ...state.personal };
          if (on === null) {
            delete next[userId];
          } else {
            next[userId] = on;
          }
          return { personal: next };
        }),
    }),
    {
      name: "report-auto-sync",
      // Only the per-user overrides are remembered locally; orgDefault always
      // comes fresh from the server.
      partialize: (state) => ({ personal: state.personal }),
    }
  )
);

/** Resolve the effective on/off for a given user. */
export function effectiveAutoSync(
  state: Pick<ReportSyncState, "orgDefault" | "personal">,
  userId: string | undefined
): boolean {
  if (userId && Object.prototype.hasOwnProperty.call(state.personal, userId)) {
    return state.personal[userId];
  }
  return state.orgDefault;
}
