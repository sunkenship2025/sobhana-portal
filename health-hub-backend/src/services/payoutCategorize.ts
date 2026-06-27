/**
 * Resolves the payout-statement category for a test order.
 *
 * Categories are NOT a fixed enum. The centre defines its own buckets by setting
 * `BillableProduct.payoutCategory` (e.g. "X-Ray", "Laboratory", "Ultrasound").
 * When a product has no explicit category we fall back to the test's Department
 * name (the same taxonomy the reports use). Only orders with neither land in the
 * single "Uncategorised" bucket.
 */

export type PayoutCategory = string;

export const UNCATEGORIZED = 'Uncategorised';

export function categoryLabel(category: PayoutCategory): string {
  return category;
}

export function categorize(input: {
  productPayoutCategory?: string | null;
  departmentName?: string | null;
}): PayoutCategory {
  const explicit = (input.productPayoutCategory || '').trim();
  if (explicit) return explicit;

  const dept = (input.departmentName || '').trim();
  if (dept) return dept;

  return UNCATEGORIZED;
}
