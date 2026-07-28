// Shared date-range filtering for the staff worklists (Pending Results,
// Finalized Reports, Finalized OP/IP). One definition so the presets and the
// custom-range semantics stay identical across every list.

export type DatePreset =
  | "today"
  | "yesterday"
  | "week"
  | "all"
  | "custom";

export interface DateRangeState {
  preset: DatePreset;
  /** Inclusive lower bound, 'YYYY-MM-DD' local calendar day. Only for `custom`. */
  from: string;
  /** Inclusive upper bound, 'YYYY-MM-DD' local calendar day. Only for `custom`. */
  to: string;
}

/** A fresh range at a given preset (used for defaults and "clear filters"). */
export const makeDateRange = (preset: DatePreset = "all"): DateRangeState => ({
  preset,
  from: "",
  to: "",
});

/** Today as a 'YYYY-MM-DD' string in the browser's local timezone. */
export const todayISO = (): string => {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${m}-${day}`;
};

/**
 * Stable string key for memo/pagination deps — changes whenever the effective
 * filter changes.
 */
export const dateRangeKey = (range: DateRangeState): string =>
  range.preset === "custom"
    ? `custom:${range.from}:${range.to}`
    : range.preset;

/**
 * Lower-bound 'YYYY-MM-DD' for `range`, to pass to a server endpoint that
 * bounds an otherwise-unbounded query (e.g. status=COMPLETED worklists —
 * COMPLETED visits accumulate forever, unlike DRAFT/WAITING). Deliberately
 * lower-bound only: the server filters by updatedAt, which keeps advancing
 * after finalize, so an upper bound could wrongly hide an in-range visit
 * touched again later (printed, WhatsApp send). `undefined` for "all" — the
 * caller's own safety-net default applies.
 */
export const dateRangeFrom = (range: DateRangeState): string | undefined => {
  const { preset } = range;
  if (preset === "all") return undefined;
  if (preset === "custom") return range.from || undefined;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const start = new Date(todayStart);
  if (preset === "yesterday") start.setDate(todayStart.getDate() - 1);
  else if (preset === "week") start.setDate(todayStart.getDate() - 6);
  // "today" leaves start at todayStart as-is.

  const m = String(start.getMonth() + 1).padStart(2, "0");
  const d = String(start.getDate()).padStart(2, "0");
  return `${start.getFullYear()}-${m}-${d}`;
};

/**
 * Does `value` (an ISO timestamp) fall inside `range`?
 *
 * Presets are relative to "now"; `custom` is an inclusive local-calendar-day
 * window where a missing bound leaves that side open-ended.
 */
export const matchesDateRange = (
  range: DateRangeState,
  value: string | null | undefined,
): boolean => {
  const { preset } = range;
  if (preset === "all") return true;

  const source = value ? new Date(value) : null;
  if (!source || isNaN(source.getTime())) return false;

  if (preset === "custom") {
    if (range.from) {
      const fromStart = new Date(`${range.from}T00:00:00`);
      if (!isNaN(fromStart.getTime()) && source < fromStart) return false;
    }
    if (range.to) {
      const toEnd = new Date(`${range.to}T23:59:59.999`);
      if (!isNaN(toEnd.getTime()) && source > toEnd) return false;
    }
    return true;
  }

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setDate(todayStart.getDate() + 1);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);
  const weekStart = new Date(todayStart);
  weekStart.setDate(todayStart.getDate() - 6);

  if (preset === "today") return source >= todayStart && source < tomorrowStart;
  if (preset === "yesterday")
    return source >= yesterdayStart && source < todayStart;
  if (preset === "week") return source >= weekStart && source < tomorrowStart;
  return true;
};
