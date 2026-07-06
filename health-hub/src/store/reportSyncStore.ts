/**
 * Report Auto-Sync — Zustand (persisted)
 *
 * Universal preference for the radiology / text-based report editors: when ON
 * (the default), draft results auto-save in the background as staff type; when
 * OFF, nothing syncs while typing and staff save on demand with the Save
 * button. Persists to localStorage so the choice is remembered across visits
 * and sessions, and is shared by every result-entry page (one toggle governs
 * them all).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ReportSyncState {
  autoSync: boolean;
  setAutoSync: (on: boolean) => void;
}

export const useReportSync = create<ReportSyncState>()(
  persist(
    (set) => ({
      autoSync: true,
      setAutoSync: (on) => set({ autoSync: on }),
    }),
    { name: "report-auto-sync" }
  )
);
