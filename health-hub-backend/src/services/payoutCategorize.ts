/**
 * Maps a test order to one of the legacy payout-statement categories
 * (LAB / XRAY / USG / ECG / SPL). The app has NO category enum; categories are
 * reconstructed from the test's Department plus product/test code prefixes.
 *
 * IMPORTANT: code prefix is resolved BEFORE department, because all radiology
 * tests (X-Ray, USG, ECG, ...) share Department = RADIOLOGY — only the code
 * distinguishes them. Non-radiology lab departments collapse to LAB; anything
 * else (bill-only charges, uncategorised) falls to SPL.
 */

export type PayoutCategory = 'LAB' | 'XRAY' | 'USG' | 'ECG' | 'SPL';

export const CATEGORY_ORDER: PayoutCategory[] = ['LAB', 'XRAY', 'USG', 'ECG', 'SPL'];

const CATEGORY_LABELS: Record<PayoutCategory, string> = {
  LAB: 'Laboratory',
  XRAY: 'X-Ray',
  USG: 'Ultrasound',
  ECG: 'ECG',
  SPL: 'Special / Other',
};

export function categoryLabel(category: PayoutCategory): string {
  return CATEGORY_LABELS[category];
}

const LAB_DEPARTMENTS = new Set([
  'HAEMATOLOGY',
  'HEMATOLOGY',
  'BIOCHEMISTRY',
  'SEROLOGY',
  'MICROBIOLOGY',
  'PATHOLOGY',
  'CLINICAL PATHOLOGY',
  'IMMUNOLOGY',
  'MOLECULAR BIOLOGY',
  'CYTOLOGY',
  'HISTOPATHOLOGY',
]);

export function categorize(input: {
  departmentName?: string | null;
  productCode?: string | null;
  testCode?: string | null;
  workflowMode?: string | null;
}): PayoutCategory {
  const code = (input.productCode || input.testCode || '').trim().toUpperCase();

  // Code prefix wins (radiology shares Department = RADIOLOGY).
  if (code.startsWith('XRAY') || code.startsWith('X_RAY') || code.startsWith('XR_')) return 'XRAY';
  if (code.startsWith('USG') || code.startsWith('US_') || code.startsWith('SONO')) return 'USG';
  if (code.startsWith('ECG') || code.startsWith('EKG')) return 'ECG';

  const dept = (input.departmentName || '').trim().toUpperCase();
  if (LAB_DEPARTMENTS.has(dept)) return 'LAB';

  return 'SPL';
}
