import crypto from "crypto";

/**
 * Guards against a registration being recorded twice.
 *
 * One registration creates Patient + Visit + Bill + PaymentTransaction, so a
 * request that arrives twice — a double-click, a retry after a flaky response,
 * a duplicated tab — bills the patient twice under two separate bills. Nothing
 * else in the stack stops it: bill numbers are allocated OUTSIDE the creating
 * transaction and are deliberately race-safe, so each request gets a DIFFERENT
 * number and the @@unique([branchId, billNumber]) constraints actively
 * guarantee both inserts succeed.
 *
 * Prod evidence (Jul 2026): 13 duplicate Patient pairs and 8 duplicate
 * Visit/Bill pairs over 90 days, the two requests landing 14ms-1.8s apart.
 */

/**
 * How close together two identical registrations for the same patient must be
 * before the second is treated as an accidental resubmit rather than a real
 * second visit. A patient genuinely registering twice for the same basket at
 * the same branch inside this window is not a real workflow.
 */
export const DUPLICATE_VISIT_WINDOW_MS = 60_000;

/**
 * Advisory-lock id serializing registrations of one patient at one branch.
 *
 * Scoped by domain on purpose: a patient consulting (CLINIC) and then being
 * sent for tests (DIAGNOSTICS) minutes later is the normal flow, so the two
 * domains must not block or dedupe against each other.
 */
export function duplicateVisitLockId(
  domain: "CLINIC" | "DIAGNOSTICS",
  branchId: string,
  patientId: string,
): number {
  return crypto
    .createHash("sha256")
    .update(`visit:${domain}:${branchId}:${patientId}`)
    .digest()
    .readInt32BE(0);
}

/**
 * Thrown inside a create transaction to roll it back when a twin is found.
 * The route catches it and answers 409 with the bill that already exists,
 * rather than a 500 that would send staff round again thinking it failed.
 */
export class DuplicateVisitError extends Error {
  constructor(public existingBillNumber: string) {
    super(`Duplicate of ${existingBillNumber}`);
    this.name = "DuplicateVisitError";
  }
}
