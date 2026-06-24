/**
 * Smart-search type detection — pure, no React (§5 / 04-decisions).
 *
 * Maps a raw search string to a {@link SearchKind} and a network-ready `value`.
 * First-match-wins precedence (order is load-bearing):
 *   1. contains `@`                  → email
 *   2. `^P-?\d+$` (case-insensitive) → patientNumber   (BEFORE bill, so P-01432
 *                                       is never mis-tagged as a bill)
 *   3. bill regex  D|C-{BRANCH}-{SEQ}, optional leading `#` → bill
 *   4. digit-count (strip space/dash) ≥ 7 → phone
 *   5. otherwise                     → name
 *
 * `value` is null until the kind's min-length gate is met, so callers can gate
 * the network call (phone ≥ 7 digits, name ≥ 2 chars, patientNumber/email/bill
 * on regex match).
 */
import type { SearchKind, Detection } from "@/types";

// Bill number: optional leading '#', a D (diagnostics) or C (clinic) domain
// letter, a 2–6 char alphanumeric branch code, then a numeric sequence.
// e.g. D-MPR-2231, C-HYD-007, #MPR-2231 (legacy no-domain-letter form allowed).
const BILL_REGEX = /^#?([DC]-)?[A-Z]{2,6}-\d{1,8}$/i;

// patientNumber: P-00001 / P00001 (optional dash, all digits after).
const PATIENT_NUMBER_REGEX = /^P-?\d+$/i;

const PHONE_MIN_DIGITS = 7;
const NAME_MIN_CHARS = 2;

/** Strip spaces and dashes, return remaining chars (used for phone digit count). */
function digitsOnly(s: string): string {
  return s.replace(/[\s-]/g, "");
}

export function detectSearchType(raw: string): Detection {
  const trimmed = raw.trim();

  if (trimmed === "") {
    return { kind: "name", value: null };
  }

  // 1. email
  if (trimmed.includes("@")) {
    // require something on both sides of '@' before firing the network
    const valid = /^[^@\s]+@[^@\s]+$/.test(trimmed);
    return { kind: "email", value: valid ? trimmed : null };
  }

  // 2. patientNumber (before bill)
  if (PATIENT_NUMBER_REGEX.test(trimmed)) {
    return { kind: "patientNumber", value: trimmed.toUpperCase() };
  }

  // 3. bill
  if (BILL_REGEX.test(trimmed)) {
    // normalize: drop a leading '#', uppercase
    const value = trimmed.replace(/^#/, "").toUpperCase();
    return { kind: "bill", value };
  }

  // 4. phone — digit-dominant after stripping separators
  const stripped = digitsOnly(trimmed);
  if (/^\+?\d+$/.test(stripped)) {
    const digitCount = stripped.replace(/^\+/, "").length;
    return {
      kind: "phone",
      value: digitCount >= PHONE_MIN_DIGITS ? stripped.replace(/^\+/, "") : null,
    };
  }

  // 5. name
  return {
    kind: "name",
    value: trimmed.length >= NAME_MIN_CHARS ? trimmed : null,
  };
}

/** The `?param=` name the /patients/search endpoint expects for a given kind. */
export function searchParamFor(kind: SearchKind): "phone" | "email" | "name" | "patientNumber" | null {
  switch (kind) {
    case "phone":
      return "phone";
    case "email":
      return "email";
    case "name":
      return "name";
    case "patientNumber":
      return "patientNumber";
    case "bill":
      return null; // bill routes through /patients/by-bill, not /search
  }
}
