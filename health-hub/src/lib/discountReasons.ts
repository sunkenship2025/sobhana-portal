/**
 * Discount reasons: one fixed list, picked at billing and at Collect Due, so the
 * owner's "why were discounts given" adds up. The bill still stores a string —
 * "<reason>" or "<reason> · <note>" — so old bills, receipts and the backend
 * are unchanged; `discountReasonGroup` reads either form back into the list.
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

/** Reasons typed before the list existed that can't be read into it. */
export const LEGACY_REASON_GROUP = 'Typed before the list';

// Old free text that clearly means one of the reasons. Names of people are left
// alone — "C/O VARUN" could be marketing or a friend.
const LEGACY: [RegExp, DiscountReason][] = [
  [/MD\s*SIR|M\.D\.?\s*SIR/i, 'MD approved'],
  [/NO\s*REF|REF[AE]R+AL\s*CUT|TO\s*REF[AE]R+AL/i, 'No referring doctor'],
  [/^(C\/O\s+)?(DOCTOR|DR)\b/i, 'Doctor asked'],
  [/^(PATIENT|PT)\s*REQ|^REQ(UEST)?$/i, 'Patient asked'],
  [/STAFF/i, 'Staff or staff family'],
  [/\bCARD\b|^REGULAR$|OLD\s*CUSTO?MER|OLD\s*COSTEMER/i, 'Regular or card holder'],
  [/\bRE\s*-?BILL\b|REPLACE BILL|PREVIOUS BILL/i, 'Billing correction'],
];

/** The list entry a stored reason belongs to (for grouping). */
export function discountReasonGroup(stored: string | null | undefined): string {
  const s = (stored ?? '').trim();
  if (!s) return 'No reason given';
  const head = s.split(' · ')[0];
  if ((DISCOUNT_REASONS as readonly string[]).includes(head)) return head;
  for (const [re, reason] of LEGACY) if (re.test(s)) return reason;
  return LEGACY_REASON_GROUP;
}
