/**
 * Recently-viewed patients — localStorage helpers (§5).
 *
 * PER-USER key (`p360.recent.<userId>.v1`) so front-desk staff sharing a machine
 * don't see each other's recent opens. MAX 8, deduped by patientId (most-recent
 * first), tolerant JSON parse (corrupt/legacy blobs degrade to an empty list,
 * never throw).
 */
import type { RecentPatient } from "@/types";

const MAX_RECENT = 8;
const KEY_PREFIX = "p360.recent.";
const KEY_SUFFIX = ".v1";

function keyFor(userId: string): string {
  return `${KEY_PREFIX}${userId}${KEY_SUFFIX}`;
}

function isValidEntry(x: unknown): x is RecentPatient {
  if (!x || typeof x !== "object") return false;
  const e = x as Record<string, unknown>;
  return (
    typeof e.patientId === "string" &&
    typeof e.name === "string" &&
    typeof e.patientNumber === "string" &&
    typeof e.viewedAt === "number"
  );
}

/** Read the recent list for a user (newest first). Tolerant: never throws. */
export function getRecentPatients(userId: string | null | undefined): RecentPatient[] {
  if (!userId) return [];
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

/**
 * Record an opened patient. Dedupes by patientId (moves it to the front with a
 * fresh `viewedAt`), caps at {@link MAX_RECENT}. Returns the updated list.
 */
export function addRecentPatient(
  userId: string | null | undefined,
  entry: Omit<RecentPatient, "viewedAt">,
): RecentPatient[] {
  if (!userId || !entry?.patientId) return getRecentPatients(userId);
  const existing = getRecentPatients(userId).filter(
    (e) => e.patientId !== entry.patientId,
  );
  const next: RecentPatient[] = [
    { ...entry, viewedAt: Date.now() },
    ...existing,
  ].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify(next));
  } catch {
    // storage full / disabled — non-fatal, the in-memory list is still returned
  }
  return next;
}

/** Clear a user's recent list. */
export function clearRecentPatients(userId: string | null | undefined): void {
  if (!userId) return;
  try {
    localStorage.removeItem(keyFor(userId));
  } catch {
    // ignore
  }
}
