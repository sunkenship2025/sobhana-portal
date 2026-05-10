/**
 * Payout Preferences — Zustand (persisted)
 *
 * Per-user UI preferences for the payouts page that aren't worth burning a URL
 * param on (page size, last-used method for Mark Paid). Persists to
 * localStorage so finance staff don't re-pick the same settings every session.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PaymentType } from "@/types";

interface PayoutPrefsState {
  pageSize: number;
  lastPaymentMethod: PaymentType;
  setPageSize: (n: number) => void;
  setLastPaymentMethod: (m: PaymentType) => void;
}

export const usePayoutPrefs = create<PayoutPrefsState>()(
  persist(
    (set) => ({
      pageSize: 50,
      lastPaymentMethod: "CASH",
      setPageSize: (n) => set({ pageSize: n }),
      setLastPaymentMethod: (m) => set({ lastPaymentMethod: m }),
    }),
    { name: "payout-prefs" }
  )
);
