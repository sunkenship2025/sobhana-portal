// The payout / referral category taxonomy, mirrored from the backend
// (payoutCategorize.ts). One vocabulary shared by panel definitions, the
// referral rate card, per-doctor category rates, and the payout statement.
// Centre-defined strings, not a hard enum — these are the seeded defaults the
// owner picks from, but a custom string is still valid on either side.

export const CAT_LAB = 'Laboratory';
export const CAT_XRAY = 'X-Ray';
export const CAT_USG = 'Ultrasound';
export const CAT_ECG = 'ECG / Cardiology';
export const CAT_SCAN = 'CT / MRI';

// Display order matches the payout statement.
export const PAYOUT_CATEGORIES: string[] = [
  CAT_LAB,
  CAT_XRAY,
  CAT_USG,
  CAT_ECG,
  CAT_SCAN,
];
