/**
 * Coupon meets counter concession.
 *
 * The rule is "the larger applies", compared IN RUPEES on this bill — never in
 * percent, because a TESTS_ONLY coupon and a whole-bill concession are not comparable
 * as percentages. Both numbers are kept: the loser is recorded as not-applied with its
 * reason, so the payout statement and the audit feed can each explain the bill later.
 *
 * Takes a LIST from day one. Today it resolves exactly two candidates; when a second
 * offer type arrives it is a new entry rather than a rewrite of an `if`.
 */
export interface DiscountCandidate {
  kind: 'COUPON' | 'MANUAL';
  amountInPaise: number;
  reason: string;
}

export interface DiscountResolution {
  applied: DiscountCandidate | null;
  rejected: (DiscountCandidate & { rejectedBecause: string })[];
}

export function resolveDiscounts(candidates: DiscountCandidate[]): DiscountResolution {
  const live = candidates.filter((c) => c.amountInPaise > 0);
  if (live.length === 0) return { applied: null, rejected: [] };

  // Ties go to the coupon: it is a promise already made to the patient in writing,
  // and a counter concession is not.
  const sorted = [...live].sort(
    (a, b) => b.amountInPaise - a.amountInPaise || (a.kind === 'COUPON' ? -1 : 1),
  );
  const [winner, ...losers] = sorted;
  return {
    applied: winner,
    rejected: losers.map((l) => ({
      ...l,
      rejectedBecause: `A larger discount of ₹${Math.round(winner.amountInPaise / 100)} applied instead`,
    })),
  };
}
