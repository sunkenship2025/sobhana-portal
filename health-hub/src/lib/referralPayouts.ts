import type {
  DiagnosticCenter,
  DiagnosticCenterProductRule,
  ReferralDoctor,
  ReferralPayoutType,
  ReferralProductRule,
} from '@/types';

export interface ReferralPayoutDraft {
  commissionType: ReferralPayoutType;
  commissionPercent: string;
  commissionAmount: string;
}

export function formatRupeesFromPaise(amountInPaise: number | null | undefined) {
  const amount = (amountInPaise ?? 0) / 100;
  return `₹${amount.toLocaleString('en-IN', {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined) return '0%';
  return `${Number.isInteger(value) ? value : Number(value.toFixed(2))}%`;
}

export function formatReferralPayout(input: {
  commissionType?: ReferralPayoutType | null;
  commissionPercent?: number | null;
  commissionAmountInPaise?: number | null;
}) {
  if (input.commissionType === 'FIXED_AMOUNT') {
    return formatRupeesFromPaise(input.commissionAmountInPaise);
  }

  return formatPercent(input.commissionPercent);
}

type PayoutProductRule = ReferralProductRule | DiagnosticCenterProductRule;
type ProductPayoutEntity = ReferralDoctor | DiagnosticCenter;

function getDefaultPayout(entity?: ProductPayoutEntity | null) {
  if (!entity) return null;

  return {
    commissionType: entity.commissionType ?? 'PERCENTAGE',
    commissionPercent: entity.commissionPercent,
    commissionAmountInPaise: entity.commissionAmountInPaise ?? null,
  };
}

function getProductRule(
  entity: ProductPayoutEntity | null | undefined,
  productId: string
): PayoutProductRule | undefined {
  return entity?.productRules?.find((rule) => rule.productId === productId);
}

function getEffectiveProductPayout(
  entity: ProductPayoutEntity | null | undefined,
  productId: string
) {
  const productRule = getProductRule(entity, productId);
  if (productRule) {
    return {
      commissionType: productRule.commissionType,
      commissionPercent: productRule.commissionPercent ?? null,
      commissionAmountInPaise: productRule.commissionAmountInPaise ?? null,
    };
  }

  return getDefaultPayout(entity);
}

export function getDoctorDefaultPayout(doctor?: ReferralDoctor | null) {
  return getDefaultPayout(doctor);
}

export function getDoctorProductRule(
  doctor: ReferralDoctor | null | undefined,
  productId: string
): ReferralProductRule | undefined {
  return getProductRule(doctor, productId) as ReferralProductRule | undefined;
}

export function getEffectiveDoctorPayout(
  doctor: ReferralDoctor | null | undefined,
  productId: string
) {
  return getEffectiveProductPayout(doctor, productId);
}

export function getDiagnosticCenterDefaultPayout(center?: DiagnosticCenter | null) {
  return getDefaultPayout(center);
}

export function getDiagnosticCenterProductRule(
  center: DiagnosticCenter | null | undefined,
  productId: string
): DiagnosticCenterProductRule | undefined {
  return getProductRule(center, productId) as DiagnosticCenterProductRule | undefined;
}

export function getEffectiveDiagnosticCenterPayout(
  center: DiagnosticCenter | null | undefined,
  productId: string
) {
  return getEffectiveProductPayout(center, productId);
}

export function toReferralPayoutDraft(input?: {
  commissionType?: ReferralPayoutType | null;
  commissionPercent?: number | null;
  commissionAmountInPaise?: number | null;
} | null): ReferralPayoutDraft {
  return {
    commissionType: input?.commissionType ?? 'PERCENTAGE',
    commissionPercent:
      input?.commissionPercent !== null && input?.commissionPercent !== undefined
        ? String(input.commissionPercent)
        : '',
    commissionAmount:
      input?.commissionAmountInPaise !== null && input?.commissionAmountInPaise !== undefined
        ? String(input.commissionAmountInPaise / 100)
        : '',
  };
}

export function toReferralPayoutPayload(input: ReferralPayoutDraft) {
  if (input.commissionType === 'FIXED_AMOUNT') {
    return {
      commissionType: input.commissionType,
      commissionAmount: input.commissionAmount === '' ? 0 : Number(input.commissionAmount),
    };
  }

  return {
    commissionType: input.commissionType,
    commissionPercent: input.commissionPercent === '' ? 0 : Number(input.commissionPercent),
  };
}

function normalizeReferralPayout(input?: {
  commissionType?: ReferralPayoutType | null;
  commissionPercent?: number | string | null;
  commissionAmount?: number | string | null;
  commissionAmountInPaise?: number | null;
} | null) {
  const commissionType = input?.commissionType ?? 'PERCENTAGE';

  if (commissionType === 'FIXED_AMOUNT') {
    const commissionAmountInPaise =
      input?.commissionAmountInPaise ??
      Math.round(Number(input?.commissionAmount ?? 0) * 100);

    return {
      commissionType,
      commissionPercent: null,
      commissionAmountInPaise,
    };
  }

  return {
    commissionType,
    commissionPercent: Number(input?.commissionPercent ?? 0),
    commissionAmountInPaise: null,
  };
}

export function areReferralPayoutsEqual(
  left?: {
    commissionType?: ReferralPayoutType | null;
    commissionPercent?: number | string | null;
    commissionAmount?: number | string | null;
    commissionAmountInPaise?: number | null;
  } | null,
  right?: {
    commissionType?: ReferralPayoutType | null;
    commissionPercent?: number | string | null;
    commissionAmount?: number | string | null;
    commissionAmountInPaise?: number | null;
  } | null
) {
  const normalizedLeft = normalizeReferralPayout(left);
  const normalizedRight = normalizeReferralPayout(right);

  return (
    normalizedLeft.commissionType === normalizedRight.commissionType &&
    normalizedLeft.commissionPercent === normalizedRight.commissionPercent &&
    normalizedLeft.commissionAmountInPaise === normalizedRight.commissionAmountInPaise
  );
}
