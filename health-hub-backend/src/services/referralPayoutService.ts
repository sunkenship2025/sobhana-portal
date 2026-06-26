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

// ─── Outside-lab vendor cost (LAB payout) ───────────────────────────────────

/**
 * Vendor cost owed to an outside lab for one outsourced test.
 * PERCENTAGE is of the POST-DISCOUNT price (caller passes it in, mirroring
 * deriveReferralPayout); FIXED_AMOUNT is the flat snapshot amount.
 */
export function computeLabCostInPaise(input: {
  postDiscountPriceInPaise: number;
  costType?: ReferralPayoutType | null;
  costPercent?: number | null;
  costAmountInPaise?: number | null;
}): number {
  if (input.costType === 'FIXED_AMOUNT') {
    return Math.max(0, Math.round(input.costAmountInPaise ?? 0));
  }
  return Math.max(0, Math.round((input.postDiscountPriceInPaise * (input.costPercent ?? 0)) / 100));
}

export interface LabRateSource {
  rateType: ReferralPayoutType;
  ratePercent: number | null;
  rateAmountInPaise: number | null;
}

export interface LabRateOverride {
  rateType?: ReferralPayoutType | null;
  ratePercent?: number | null;
  rateAmountInPaise?: number | null;
}

export interface LabCostSnapshot {
  labCostType: ReferralPayoutType;
  labCostPercentage: number | null;
  labCostAmountInPaise: number | null;
}

/**
 * Resolve the frozen vendor-cost snapshot for an outsourced order: a per-product
 * override on the lab wins when it specifies a rate, otherwise the lab default.
 */
export function resolveLabCostSnapshot(
  lab: LabRateSource,
  rule?: LabRateOverride | null
): LabCostSnapshot {
  const hasOverride =
    rule != null &&
    rule.rateType != null &&
    ((rule.rateType === 'FIXED_AMOUNT' && rule.rateAmountInPaise != null) ||
      (rule.rateType === 'PERCENTAGE' && rule.ratePercent != null));

  const type: ReferralPayoutType = hasOverride ? (rule!.rateType as ReferralPayoutType) : lab.rateType;
  if (type === 'FIXED_AMOUNT') {
    return {
      labCostType: 'FIXED_AMOUNT',
      labCostPercentage: null,
      labCostAmountInPaise: hasOverride ? rule!.rateAmountInPaise ?? 0 : lab.rateAmountInPaise ?? 0,
    };
  }
  return {
    labCostType: 'PERCENTAGE',
    labCostPercentage: hasOverride ? rule!.ratePercent ?? 0 : lab.ratePercent ?? 0,
    labCostAmountInPaise: null,
  };
}

export interface ReferralCommissionSnapshot {
  referralCommissionType: ReferralPayoutType;
  referralCommissionPercentage: number | null;
  referralCommissionAmountInPaise: number | null;
}

export interface ReducedReferralOverride {
  reducedReferralCommissionType?: ReferralPayoutType | null;
  reducedReferralCommissionPercent?: number | null;
  reducedReferralCommissionAmountInPaise?: number | null;
}

/**
 * When a test is outsourced and the lab's per-product rule defines a reduced
 * referring-doctor commission, that reduced value overrides the doctor's normal
 * commission snapshot frozen onto the TestOrder. Null override => keep normal.
 */
export function resolveReducedReferralSnapshot(
  normal: ReferralCommissionSnapshot,
  rule?: ReducedReferralOverride | null
): ReferralCommissionSnapshot {
  if (!rule || rule.reducedReferralCommissionType == null) {
    return normal;
  }
  if (rule.reducedReferralCommissionType === 'FIXED_AMOUNT') {
    return {
      referralCommissionType: 'FIXED_AMOUNT',
      referralCommissionPercentage: null,
      referralCommissionAmountInPaise: rule.reducedReferralCommissionAmountInPaise ?? 0,
    };
  }
  return {
    referralCommissionType: 'PERCENTAGE',
    referralCommissionPercentage: rule.reducedReferralCommissionPercent ?? 0,
    referralCommissionAmountInPaise: null,
  };
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
