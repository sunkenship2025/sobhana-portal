/**
 * Resolves the payout-statement category for a test order.
 *
 * Categories are NOT a fixed enum. Resolution order:
 *   1. BillableProduct.payoutCategory — explicit owner override (highest).
 *   2. Inferred from the product / test NAME (USG, ECG, X-Ray, CT/MRI). This is
 *      what makes existing data categorise correctly without any setup, because
 *      the names are reliable even when departments aren't linked.
 *   3. Default to "Laboratory" — in a diagnostic centre everything that isn't
 *      imaging/cardiology is lab work. (Owner can override per product.)
 *
 * There is deliberately no "SPL / Other" catch-all.
 */

export type PayoutCategory = string;

export const CAT_LAB = 'Laboratory';
export const CAT_XRAY = 'X-Ray';
export const CAT_USG = 'Ultrasound';
export const CAT_ECG = 'ECG / Cardiology';
export const CAT_SCAN = 'CT / MRI';

// Preferred display order; anything else is appended alphabetically.
export const CATEGORY_ORDER: PayoutCategory[] = [CAT_LAB, CAT_XRAY, CAT_USG, CAT_ECG, CAT_SCAN];

export function categoryLabel(category: PayoutCategory): string {
  return category;
}

function inferFromName(name?: string | null): PayoutCategory | null {
  const n = (name || '').toUpperCase();
  if (!n) return null;
  if (/\bUSG\b|ULTRA\s?SOUND|SONOGRAM|SONOGRAPHY|DOPPLER/.test(n)) return CAT_USG;
  if (/\bECG\b|\bEKG\b|\bECHO\b|2\s?D\s?ECHO|\bTMT\b|HOLTER/.test(n)) return CAT_ECG;
  if (/X[\s-]?RAY|\bXRAY\b/.test(n)) return CAT_XRAY;
  if (/\bCT\b|\bMRI\b|\bCECT\b|\bNCCT\b|\bPET\b|\bDEXA\b/.test(n)) return CAT_SCAN;
  return null;
}

export function categorize(input: {
  productPayoutCategory?: string | null;
  productName?: string | null;
  testName?: string | null;
}): PayoutCategory {
  const explicit = (input.productPayoutCategory || '').trim();
  if (explicit) return explicit;

  const inferred = inferFromName(input.productName) || inferFromName(input.testName);
  if (inferred) return inferred;

  return CAT_LAB;
}
