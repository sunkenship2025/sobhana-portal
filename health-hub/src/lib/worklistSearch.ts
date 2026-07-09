/**
 * Shared worklist search — brings the queue/finalized/pending lists up to the
 * Patient 360 search "level": case-insensitive, phone-format-agnostic, and
 * exact-name-first ranking, over an already-fetched worklist array.
 *
 * Each page passes accessors to pull the searchable fields off its own row
 * shape. Returns the matching rows ranked so exact/prefix name matches float to
 * the top, while preserving the caller's existing order within a rank tier
 * (stable sort) — so the base date-desc ordering survives for equal matches.
 */

export interface WorklistFields {
  name?: string | null;
  phone?: string | null;
  billNumber?: string | null;
  visitRef?: string | null;
}

/** Digits only — lets a phone match ignore spaces, dashes and +country codes. */
const digitsOnly = (s: string) => s.replace(/\D/g, "");

/**
 * Score a row against a search term. 0 = no match (row is dropped); higher is a
 * better match. Name matches outrank identifier matches, and an exact name is
 * the strongest signal — mirroring the Patient 360 backend ranking.
 */
export function scoreWorklistMatch(
  fields: WorklistFields,
  rawSearch: string,
): number {
  const q = rawSearch.trim().toLowerCase();
  if (!q) return 1; // empty search keeps everything (rank-neutral)

  const name = (fields.name ?? "").toLowerCase().trim();
  if (name) {
    if (name === q) return 100;
    if (name.startsWith(q)) return 80;
    if (name.includes(q)) return 60;
  }

  // Phone: compare digit-strings so "9393 936269" matches "9393936269".
  const qDigits = digitsOnly(rawSearch);
  const phone = digitsOnly(fields.phone ?? "");
  if (qDigits && phone && phone.includes(qDigits)) return 40;

  const bill = (fields.billNumber ?? "").toLowerCase();
  if (bill && bill.includes(q)) return 30;

  const ref = (fields.visitRef ?? "").toLowerCase();
  if (ref && ref.includes(q)) return 20;

  return 0;
}

/**
 * Filter + rank a worklist by a search term. Stable within a rank tier, so the
 * caller's pre-sort (usually date desc) is preserved for equally-relevant rows.
 * An empty/blank search returns the list unchanged.
 */
export function searchWorklist<T>(
  items: T[],
  rawSearch: string,
  getFields: (item: T) => WorklistFields,
): T[] {
  if (!rawSearch.trim()) return items;

  return items
    .map((item, index) => ({
      item,
      index,
      score: scoreWorklistMatch(getFields(item), rawSearch),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((x) => x.item);
}
