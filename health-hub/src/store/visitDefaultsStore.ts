/**
 * Visit Defaults — Zustand (persisted)
 *
 * Remembers the front-desk operator's last choices on the new-visit pages so
 * the common case is pre-filled instead of re-picked every registration:
 * the last consulting doctor (clinic) and the last payment mode (per surface).
 * Persists to localStorage, mirroring `payoutPrefsStore`.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";

type PaymentMode = "CASH" | "ONLINE" | "SPLIT";

interface VisitDefaultsState {
  lastClinicDoctorId: string;
  lastClinicPaymentMode: PaymentMode;
  lastDiagPaymentMode: PaymentMode;
  setLastClinicDoctorId: (id: string) => void;
  setLastClinicPaymentMode: (m: PaymentMode) => void;
  setLastDiagPaymentMode: (m: PaymentMode) => void;
}

export const useVisitDefaults = create<VisitDefaultsState>()(
  persist(
    (set) => ({
      lastClinicDoctorId: "",
      lastClinicPaymentMode: "CASH",
      lastDiagPaymentMode: "CASH",
      setLastClinicDoctorId: (id) => set({ lastClinicDoctorId: id }),
      setLastClinicPaymentMode: (m) => set({ lastClinicPaymentMode: m }),
      setLastDiagPaymentMode: (m) => set({ lastDiagPaymentMode: m }),
    }),
    { name: "visit-defaults" }
  )
);
