import { ReferralPayoutType } from '@prisma/client';

export interface ReferralPayoutInput {
  commissionType?: ReferralPayoutType | string | null;
  commissionPercent?: number | string | null;
  commissionAmount?: number | string | null; // User-facing rupees
  commissionAmountInPaise?: number | string | null;
}

export interface NormalizedReferralPayout {
  commissionType: ReferralPayoutType;
  commissionPercent: number | null;
  commissionAmountInPaise: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeReferralPayoutInput(
  input: ReferralPayoutInput,
  fallbackType: ReferralPayoutType = 'PERCENTAGE'
): NormalizedReferralPayout {
  const commissionType =
    input.commissionType === 'FIXED_AMOUNT'
      ? 'FIXED_AMOUNT'
      : input.commissionType === 'PERCENTAGE'
        ? 'PERCENTAGE'
        : fallbackType;

  if (commissionType === 'FIXED_AMOUNT') {
    const explicitPaise = toFiniteNumber(input.commissionAmountInPaise);
    const rupees = toFiniteNumber(input.commissionAmount);
    const commissionAmountInPaise =
      explicitPaise ?? (rupees !== null ? Math.round(rupees * 100) : null);

    if (commissionAmountInPaise === null || commissionAmountInPaise < 0) {
      throw new Error('Commission amount must be a non-negative number');
    }

    return {
      commissionType,
      commissionPercent: null,
      commissionAmountInPaise,
    };
  }

  const commissionPercent = toFiniteNumber(input.commissionPercent);
  if (commissionPercent === null || commissionPercent < 0 || commissionPercent > 100) {
    throw new Error('Commission percent must be between 0 and 100');
  }

  return {
    commissionType,
    commissionPercent,
    commissionAmountInPaise: null,
  };
}

export function normalizeReferralOverrideInput(input: unknown): NormalizedReferralPayout | null {
  if (input === undefined || input === null || input === '') {
    return null;
  }

  if (typeof input === 'number' || typeof input === 'string') {
    return normalizeReferralPayoutInput({
      commissionType: 'PERCENTAGE',
      commissionPercent: input,
    });
  }

  if (typeof input === 'object') {
    return normalizeReferralPayoutInput(input as ReferralPayoutInput);
  }

  throw new Error('Invalid referral override');
}

export function computeReferralPayoutInPaise(order: {
  priceInPaise: number;
  referralCommissionType?: ReferralPayoutType | null;
  referralCommissionPercentage?: number | null;
  referralCommissionAmountInPaise?: number | null;
}): number {
  return computeCommissionInPaise({
    priceInPaise: order.priceInPaise,
    commissionType: order.referralCommissionType,
    commissionPercentage: order.referralCommissionPercentage,
    commissionAmountInPaise: order.referralCommissionAmountInPaise,
  });
}

export function computeCommissionInPaise(input: {
  priceInPaise: number;
  commissionType?: ReferralPayoutType | null;
  commissionPercentage?: number | null;
  commissionAmountInPaise?: number | null;
}) {
  if (input.commissionType === 'FIXED_AMOUNT') {
    return Math.max(0, Math.round(input.commissionAmountInPaise ?? 0));
  }

  return Math.round((input.priceInPaise * (input.commissionPercentage ?? 0)) / 100);
}

export function areReferralPayoutsEqual(
  left?: Pick<NormalizedReferralPayout, 'commissionType' | 'commissionPercent' | 'commissionAmountInPaise'> | null,
  right?: Pick<NormalizedReferralPayout, 'commissionType' | 'commissionPercent' | 'commissionAmountInPaise'> | null
) {
  const normalizedLeft: NormalizedReferralPayout = {
    commissionType: left?.commissionType ?? 'PERCENTAGE',
    commissionPercent: left?.commissionPercent ?? 0,
    commissionAmountInPaise: left?.commissionAmountInPaise ?? null,
  };

  const normalizedRight: NormalizedReferralPayout = {
    commissionType: right?.commissionType ?? 'PERCENTAGE',
    commissionPercent: right?.commissionPercent ?? 0,
    commissionAmountInPaise: right?.commissionAmountInPaise ?? null,
  };

  return (
    normalizedLeft.commissionType === normalizedRight.commissionType &&
    normalizedLeft.commissionPercent === normalizedRight.commissionPercent &&
    normalizedLeft.commissionAmountInPaise === normalizedRight.commissionAmountInPaise
  );
}

export function distributeFixedAmountInPaise(
  totalAmountInPaise: number,
  weights: number[]
): number[] {
  if (weights.length === 0) {
    return [];
  }

  const normalizedTotal = Math.max(0, Math.round(totalAmountInPaise));
  const safeWeights = weights.map((weight) => Math.max(0, Math.round(weight)));
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0);

  if (totalWeight === 0) {
    const evenShare = Math.floor(normalizedTotal / safeWeights.length);
    return safeWeights.map((_weight, index) =>
      index === safeWeights.length - 1
        ? normalizedTotal - evenShare * (safeWeights.length - 1)
        : evenShare
    );
  }

  let allocated = 0;
  return safeWeights.map((weight, index) => {
    if (index === safeWeights.length - 1) {
      return normalizedTotal - allocated;
    }

    const share = Math.floor((normalizedTotal * weight) / totalWeight);
    allocated += share;
    return share;
  });
}
