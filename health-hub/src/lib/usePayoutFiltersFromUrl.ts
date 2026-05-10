/**
 * URL-driven filter state for the payouts page.
 *
 * Filters live in `useSearchParams` so they:
 *   - survive page reloads
 *   - survive browser back/forward
 *   - are shareable as URLs
 *   - hydrate from external links (doctor profile → "View payouts" → ?doctorId=X)
 *
 * Pattern mirrors AdminConfigCenter.tsx (useSearchParams-driven tabs).
 */
import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  PayoutDoctorType,
  PayoutSortField,
  PayoutSortDir,
} from "@/types";

export type PayoutTab = "by-period" | "by-doctor";
export type PayoutStatusFilter = "all" | "pending" | "paid";
export type DatePreset =
  | "this-month"
  | "last-month"
  | "last-30-days"
  | "this-quarter"
  | "custom";

export interface PayoutFilterState {
  tab: PayoutTab;
  doctorType: PayoutDoctorType | "all";
  doctorId: string;
  status: PayoutStatusFilter;
  startDate: string; // YYYY-MM-DD or ""
  endDate: string;   // YYYY-MM-DD or ""
  preset: DatePreset;
  q: string;
  page: number;
  pageSize: number;
  sortBy: PayoutSortField;
  sortDir: PayoutSortDir;
}

const DEFAULTS: PayoutFilterState = {
  tab: "by-period",
  doctorType: "all",
  doctorId: "all",
  status: "all",
  startDate: "",
  endDate: "",
  preset: "this-month",
  q: "",
  page: 1,
  pageSize: 50,
  sortBy: "derivedAt",
  sortDir: "desc",
};

function parseInt0(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function usePayoutFiltersFromUrl() {
  const [params, setParams] = useSearchParams();

  const state = useMemo<PayoutFilterState>(() => {
    return {
      tab: (params.get("tab") as PayoutTab) || DEFAULTS.tab,
      doctorType:
        (params.get("doctorType") as PayoutFilterState["doctorType"]) ||
        DEFAULTS.doctorType,
      doctorId: params.get("doctorId") || DEFAULTS.doctorId,
      status:
        (params.get("status") as PayoutStatusFilter) || DEFAULTS.status,
      startDate: params.get("startDate") || DEFAULTS.startDate,
      endDate: params.get("endDate") || DEFAULTS.endDate,
      preset: (params.get("preset") as DatePreset) || DEFAULTS.preset,
      q: params.get("q") || DEFAULTS.q,
      page: parseInt0(params.get("page"), DEFAULTS.page),
      pageSize: parseInt0(params.get("pageSize"), DEFAULTS.pageSize),
      sortBy: (params.get("sortBy") as PayoutSortField) || DEFAULTS.sortBy,
      sortDir:
        (params.get("sortDir") as PayoutSortDir) || DEFAULTS.sortDir,
    };
  }, [params]);

  // Patch one or more keys at once. Empty strings clear the param entirely.
  const update = useCallback(
    (patch: Partial<PayoutFilterState>) => {
      const next = new URLSearchParams(params);
      for (const [k, v] of Object.entries(patch)) {
        if (v === "" || v === undefined || v === null) {
          next.delete(k);
        } else {
          next.set(k, String(v));
        }
      }
      // Any filter change resets to page 1 unless the patch sets page itself.
      if (!("page" in patch)) {
        next.delete("page");
      }
      setParams(next, { replace: true });
    },
    [params, setParams]
  );

  const reset = useCallback(() => {
    setParams(new URLSearchParams(), { replace: true });
  }, [setParams]);

  return { state, update, reset };
}

// ----------------------------------------------------------------------------
// Date preset → concrete (startDate, endDate) range.
// All dates returned in YYYY-MM-DD format (the same shape <Input type="date"/>
// produces). Time component is normalized client-side when posted to the API.
// ----------------------------------------------------------------------------

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function resolveDatePreset(preset: DatePreset, today = new Date()): { startDate: string; endDate: string } {
  if (preset === "this-month") {
    return {
      startDate: ymd(new Date(today.getFullYear(), today.getMonth(), 1)),
      endDate: ymd(new Date(today.getFullYear(), today.getMonth() + 1, 0)),
    };
  }
  if (preset === "last-month") {
    return {
      startDate: ymd(new Date(today.getFullYear(), today.getMonth() - 1, 1)),
      endDate: ymd(new Date(today.getFullYear(), today.getMonth(), 0)),
    };
  }
  if (preset === "last-30-days") {
    const end = today;
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return { startDate: ymd(start), endDate: ymd(end) };
  }
  if (preset === "this-quarter") {
    const q = Math.floor(today.getMonth() / 3);
    return {
      startDate: ymd(new Date(today.getFullYear(), q * 3, 1)),
      endDate: ymd(new Date(today.getFullYear(), q * 3 + 3, 0)),
    };
  }
  return { startDate: "", endDate: "" };
}
