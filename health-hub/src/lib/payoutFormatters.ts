/**
 * Shared formatters used across PayoutsList, PayoutDetail, ByDoctor, and the
 * Run Cycle sheet. Lifted out of PayoutsList.tsx so display is consistent.
 */

export function formatRupees(paise: number): string {
  return `₹${(paise / 100).toLocaleString("en-IN", {
    minimumFractionDigits: 2,
  })}`;
}

export function formatDate(dateStr: string | Date | null | undefined): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/**
 * Period as "May 2026" when start/end span exactly one calendar month;
 * otherwise as a date range.
 */
export function formatPeriod(start: string | Date, end: string | Date): string {
  const s = new Date(start);
  const e = new Date(end);
  const sameMonth =
    s.getFullYear() === e.getFullYear() && s.getMonth() === e.getMonth();
  if (sameMonth) {
    // Verify it's also the full calendar month
    const firstOfMonth = s.getDate() === 1;
    const lastOfMonth =
      e.getDate() ===
      new Date(e.getFullYear(), e.getMonth() + 1, 0).getDate();
    if (firstOfMonth && lastOfMonth) {
      return s.toLocaleDateString("en-IN", { month: "short", year: "numeric" });
    }
  }
  const sLabel = s.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  });
  const eLabel = e.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  return `${sLabel} – ${eLabel}`;
}

/**
 * "DC" → "Diagnostic Center"; otherwise capitalized type label.
 */
export function formatDoctorTypeLabel(t: string): string {
  if (t === "REFERRAL") return "Referral";
  if (t === "CLINIC") return "Clinic";
  if (t === "DIAGNOSTIC_CENTER") return "Diagnostic Center";
  return t;
}

/** Short label for the badge column. */
export function formatDoctorTypeShort(t: string): string {
  if (t === "REFERRAL") return "REF";
  if (t === "CLINIC") return "CLINIC";
  if (t === "DIAGNOSTIC_CENTER") return "DC";
  return t;
}
