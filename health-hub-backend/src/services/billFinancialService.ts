import { BillDiscountType, PaymentStatus } from '@prisma/client';

export type BillDiscountInputType = BillDiscountType | 'FLAT_AMOUNT' | 'PERCENTAGE' | null | undefined;

export interface BillFinancialInput {
  totalAmountInPaise: number;
  discountType?: BillDiscountInputType;
  discountValue?: number | string | null;
  paidAmount?: number | string | null; // User-facing rupees
  paidAmountInPaise?: number | string | null;
}

export interface BillFinancialFields {
  discountType: BillDiscountType | null;
  discountPercentage: number | null;
  discountAmountInPaise: number;
  paidAmountInPaise: number;
  netAmountInPaise: number;
  dueAmountInPaise: number;
  paymentStatus: PaymentStatus;
}

export interface PersistedBillFinancials {
  totalAmountInPaise: number;
  discountType?: BillDiscountType | null;
  discountPercentage?: number | null;
  discountAmountInPaise?: number | null;
  paidAmountInPaise?: number | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPaiseFromRupees(value: unknown): number | null {
  const rupees = toFiniteNumber(value);
  return rupees === null ? null : Math.round(rupees * 100);
}

function normalizeDiscountType(value: BillDiscountInputType): BillDiscountType | null {
  if (value === 'FLAT_AMOUNT') return BillDiscountType.FLAT_AMOUNT;
  if (value === 'PERCENTAGE') return BillDiscountType.PERCENTAGE;
  return null;
}

export function computeBillFinancialsFromPersisted(
  bill: PersistedBillFinancials
): BillFinancialFields {
  const subtotal = Math.max(0, Math.round(bill.totalAmountInPaise || 0));
  const discountAmountInPaise = Math.min(
    subtotal,
    Math.max(0, Math.round(bill.discountAmountInPaise ?? 0))
  );
  const netAmountInPaise = Math.max(0, subtotal - discountAmountInPaise);
  const paidAmountInPaise = Math.min(
    netAmountInPaise,
    Math.max(0, Math.round(bill.paidAmountInPaise ?? 0))
  );
  const dueAmountInPaise = Math.max(0, netAmountInPaise - paidAmountInPaise);

  return {
    discountType: bill.discountType ?? null,
    discountPercentage: bill.discountPercentage ?? null,
    discountAmountInPaise,
    paidAmountInPaise,
    netAmountInPaise,
    dueAmountInPaise,
    paymentStatus: dueAmountInPaise === 0 ? PaymentStatus.PAID : PaymentStatus.PENDING,
  };
}

export function normalizeBillFinancialInput(
  input: BillFinancialInput,
  options: { defaultPaidToNet?: boolean } = {}
): BillFinancialFields {
  const subtotal = Math.max(0, Math.round(input.totalAmountInPaise || 0));
  const discountType = normalizeDiscountType(input.discountType);
  const rawDiscountValue = toFiniteNumber(input.discountValue);
  let discountPercentage: number | null = null;
  let discountAmountInPaise = 0;

  if (discountType === BillDiscountType.PERCENTAGE) {
    const percentage = rawDiscountValue ?? 0;
    if (percentage < 0 || percentage > 100) {
      throw new Error('Discount percentage must be between 0 and 100');
    }
    discountPercentage = percentage;
    discountAmountInPaise = Math.round((subtotal * percentage) / 100);
  } else if (discountType === BillDiscountType.FLAT_AMOUNT) {
    const flatAmountInPaise = toPaiseFromRupees(input.discountValue) ?? 0;
    if (flatAmountInPaise < 0) {
      throw new Error('Discount amount must be a non-negative number');
    }
    discountAmountInPaise = flatAmountInPaise;
  }

  if (discountAmountInPaise > subtotal) {
    throw new Error('Discount cannot exceed bill subtotal');
  }

  const netAmountInPaise = Math.max(0, subtotal - discountAmountInPaise);
  const explicitPaidInPaise =
    toFiniteNumber(input.paidAmountInPaise) ?? toPaiseFromRupees(input.paidAmount);
  const paidAmountInPaise =
    explicitPaidInPaise === null && options.defaultPaidToNet
      ? netAmountInPaise
      : Math.max(0, Math.round(explicitPaidInPaise ?? 0));

  if (paidAmountInPaise > netAmountInPaise) {
    throw new Error('Paid amount cannot exceed net payable');
  }

  const dueAmountInPaise = Math.max(0, netAmountInPaise - paidAmountInPaise);

  return {
    discountType,
    discountPercentage,
    discountAmountInPaise,
    paidAmountInPaise,
    netAmountInPaise,
    dueAmountInPaise,
    paymentStatus: dueAmountInPaise === 0 ? PaymentStatus.PAID : PaymentStatus.PENDING,
  };
}

export function collectBillDue(
  bill: PersistedBillFinancials,
  amount: number | string | null | undefined
): BillFinancialFields {
  const current = computeBillFinancialsFromPersisted(bill);
  const collectAmountInPaise = toPaiseFromRupees(amount);

  if (collectAmountInPaise === null || collectAmountInPaise <= 0) {
    throw new Error('Collection amount must be greater than zero');
  }

  if (collectAmountInPaise > current.dueAmountInPaise) {
    throw new Error('Collection amount cannot exceed due amount');
  }

  return computeBillFinancialsFromPersisted({
    ...bill,
    paidAmountInPaise: current.paidAmountInPaise + collectAmountInPaise,
  });
}

export function recomputeBillFinancialsForSubtotal(
  bill: PersistedBillFinancials,
  nextTotalAmountInPaise: number
): BillFinancialFields {
  const subtotal = Math.max(0, Math.round(nextTotalAmountInPaise || 0));
  const nextDiscountAmountInPaise =
    bill.discountType === BillDiscountType.PERCENTAGE
      ? Math.round((subtotal * (bill.discountPercentage ?? 0)) / 100)
      : Math.min(subtotal, Math.max(0, Math.round(bill.discountAmountInPaise ?? 0)));
  const nextNetAmountInPaise = Math.max(0, subtotal - nextDiscountAmountInPaise);
  const paidAmountInPaise = Math.max(0, Math.round(bill.paidAmountInPaise ?? 0));

  if (paidAmountInPaise > nextNetAmountInPaise) {
    throw new Error('Paid amount would exceed the new net payable');
  }

  const dueAmountInPaise = Math.max(0, nextNetAmountInPaise - paidAmountInPaise);

  return {
    discountType: bill.discountType ?? null,
    discountPercentage: bill.discountPercentage ?? null,
    discountAmountInPaise: nextDiscountAmountInPaise,
    paidAmountInPaise,
    netAmountInPaise: nextNetAmountInPaise,
    dueAmountInPaise,
    paymentStatus: dueAmountInPaise === 0 ? PaymentStatus.PAID : PaymentStatus.PENDING,
  };
}

export function buildBillFinancialResponse(
  bill: PersistedBillFinancials | null | undefined
) {
  if (!bill) {
    return {
      discountType: null,
      discountPercentage: null,
      discountAmountInPaise: 0,
      paidAmountInPaise: 0,
      netAmountInPaise: 0,
      dueAmountInPaise: 0,
    };
  }

  const computed = computeBillFinancialsFromPersisted(bill);
  return {
    discountType: computed.discountType,
    discountPercentage: computed.discountPercentage,
    discountAmountInPaise: computed.discountAmountInPaise,
    paidAmountInPaise: computed.paidAmountInPaise,
    netAmountInPaise: computed.netAmountInPaise,
    dueAmountInPaise: computed.dueAmountInPaise,
  };
}

export function allocateBillDiscountAcrossOrders<T extends { id: string; priceInPaise: number }>(
  orders: T[],
  discountAmountInPaise: number
): Map<string, number> {
  const allocations = new Map<string, number>();
  const safeDiscount = Math.max(0, Math.round(discountAmountInPaise || 0));
  const total = orders.reduce((sum, order) => sum + Math.max(0, Math.round(order.priceInPaise)), 0);

  if (orders.length === 0 || safeDiscount === 0 || total === 0) {
    for (const order of orders) allocations.set(order.id, 0);
    return allocations;
  }

  const cappedDiscount = Math.min(safeDiscount, total);
  const weighted = orders.map((order, index) => {
    const price = Math.max(0, Math.round(order.priceInPaise));
    const exactNumerator = cappedDiscount * price;
    const floor = Math.floor(exactNumerator / total);
    return {
      id: order.id,
      index,
      floor,
      remainder: exactNumerator - floor * total,
    };
  });

  let allocated = weighted.reduce((sum, item) => sum + item.floor, 0);
  weighted.sort((left, right) => {
    if (right.remainder !== left.remainder) return right.remainder - left.remainder;
    return left.index - right.index;
  });

  for (const item of weighted) {
    allocations.set(item.id, item.floor);
  }

  let remainder = cappedDiscount - allocated;
  for (const item of weighted) {
    if (remainder <= 0) break;
    allocations.set(item.id, (allocations.get(item.id) ?? 0) + 1);
    remainder -= 1;
    allocated += 1;
  }

  return allocations;
}
