// The payout / referral category taxonomy, mirrored from the backend
// (payoutCategorize.ts). One vocabulary shared by panel definitions, the
// referral rate card, per-doctor category rates, and the payout statement.
// Centre-defined strings, not a hard enum — these are the seeded defaults the
// owner picks from, but a custom string is still valid on either side.
//
// The finer rows below (Tiffa, 2D Echo, EEG, TMT, Dental X-Ray) are opt-in:
// nothing lands in them by name-inference — a panel/product must be explicitly
// tagged with the category. Until then they simply sit in the rate card ready
// to be priced, and untagged tests keep resolving from the coarse buckets.

import { useEffect, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useBranchStore } from '@/store/branchStore';

export const CAT_LAB = 'Laboratory';
export const CAT_XRAY = 'X-Ray';
export const CAT_USG = 'Ultrasound';
export const CAT_ECG = 'ECG / Cardiology';
export const CAT_SCAN = 'CT / MRI';

// Display order matches the payout statement. Coarse buckets first, then the
// finer opt-in investigations.
export const PAYOUT_CATEGORIES: string[] = [
  CAT_LAB,
  CAT_XRAY,
  CAT_USG,
  CAT_ECG,
  CAT_SCAN,
  'Ultrasound Tiffa',
  '2D Echo',
  'EEG',
  'TMT',
  'Dental X-Ray',
];

/**
 * The category vocabulary to offer in a tagging dropdown: the seeded list above
 * unioned with whatever categories the owner has added to the rate card, so a
 * brand-new investigation becomes taggable on panels/products without a deploy.
 * Falls back to the seeds on any fetch failure.
 */
export function useReferralCategories(): string[] {
  const { token } = useAuthStore();
  const [cats, setCats] = useState<string[]>(PAYOUT_CATEGORIES);

  useEffect(() => {
    if (!token) return;
    const { activeBranchId } = useBranchStore.getState();
    fetch(`${API_BASE}/referral-doctors/category-rates`, {
      headers: { Authorization: `Bearer ${token}`, 'X-Branch-Id': activeBranchId || '' },
    })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { category: string }[]) => {
        const extra = rows
          .map((r) => r.category)
          .filter((c) => c && !PAYOUT_CATEGORIES.includes(c))
          .sort();
        setCats([...PAYOUT_CATEGORIES, ...Array.from(new Set(extra))]);
      })
      .catch(() => {
        /* keep seeds on failure */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return cats;
}
