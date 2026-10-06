/**
 * Discount reasons: one fixed list, picked at billing and at Collect Due, so the
 * owner's "why were discounts given" adds up. The bill still stores a string —
 * "<reason>" or "<reason> · <note>" — so receipts and the backend are
 * unchanged. The server refuses a bare "Other".
 */
export const DISCOUNT_REASONS = [
  'Doctor asked',
  'No referring doctor',
  'Patient asked',
  'MD approved',
  'Marketing / PRO',
  'Staff or staff family',
  'Regular or card holder',
  'Billing correction',
  'Other',
] as const;
export type DiscountReason = (typeof DISCOUNT_REASONS)[number];

/** "Other" means nothing without words; the rest can stand alone. */
export const reasonNeedsNote = (reason: string) => reason === 'Other';

export const NOTE_PLACEHOLDER: Record<DiscountReason, string> = {
  'Doctor asked': 'Which doctor (optional)',
  'No referring doctor': 'Note (optional)',
  'Patient asked': 'Note (optional)',
  'MD approved': 'Note (optional)',
  'Marketing / PRO': 'Whose patient (optional)',
  'Staff or staff family': 'Whose family (optional)',
  'Regular or card holder': 'Card or note (optional)',
  'Billing correction': 'Old bill number (optional)',
  Other: 'Say why (required)',
};

export function composeDiscountReason(reason: string, note: string): string {
  const n = note.replace(/\s+/g, ' ').trim();
  return reason ? (n ? `${reason} · ${n}` : reason) : '';
}

/**
 * The list entry a stored reason belongs to (for grouping). Every bill typed
 * before the list was sorted into it on Oct 7 2026 ("<reason> · <typed>"), so
 * anything off the list is a stray and counts as "Other".
 */
export function discountReasonGroup(stored: string | null | undefined): string {
  const s = (stored ?? '').trim();
  if (!s) return 'No reason given';
  const head = s.split(' · ')[0];
  return (DISCOUNT_REASONS as readonly string[]).includes(head) ? head : 'Other';
}
