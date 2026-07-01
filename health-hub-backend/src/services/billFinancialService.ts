import { BillDiscountType, PaymentStatus } from "@prisma/client";

export type BillDiscountInputType =
  | BillDiscountType
  | "FLAT_AMOUNT"
  | "PERCENTAGE"
  | null
  | undefined;

export interface BillFinancialInput {
  totalAmountInPaise: number;
  discountType?: BillDiscountInputType;
  discountValue?: number | string | null;
  discountReason?: string | null;
  paidAmount?: number | string | null; // User-facing rupees
  paidAmountInPaise?: number | string | null;
}

export interface BillFinancialFields {
  discountReason: string | null;
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
  discountReason?: string | null;
  discountType?: BillDiscountType | null;
  discountPercentage?: number | null;
  discountAmountInPaise?: number | null;
  paidAmountInPaise?: number | null;
  /// Sum of money refunded on this bill (reduces net payable so no phantom due appears).
  refundedAmountInPaise?: number | null;

  /// transactionType 'REFUND' rows are subtracted from paid; default/absent = 'PAYMENT'.
  transactions?: { amountInPaise: number; transactionType?: string | null }[] | null;
}

function toFiniteNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toPaiseFromRupees(value: unknown): number | null {
  const rupees = toFiniteNumber(value);
  return rupees === null ? null : Math.round(rupees * 100);
}

function normalizeDiscountType(
  value: BillDiscountInputType,
): BillDiscountType | null {
  if (value === "FLAT_AMOUNT") return BillDiscountType.FLAT_AMOUNT;
  if (value === "PERCENTAGE") return BillDiscountType.PERCENTAGE;
  return null;
}

/**
 * INVARIANT: every callsite that creates a `PaymentTransaction` MUST also
 * update `Bill.paidAmountInPaise` in the same transaction (and vice versa).
 * The two are kept in sync deliberately so `computeBillFinancialsFromPersisted`
 * works whether or not transactions are loaded — most read paths skip the
 * `transactions` include for perf. As of 2026-05, the only mutation paths are:
 *   - routes/diagnosticVisits.ts (POST /, PATCH /:id, /:id/collect-due, /:id/tests, DELETE /:id/tests/:testOrderId)
 *   - routes/clinicVisits.ts (POST /, PATCH /:id)
 * If you add a new path that creates a transaction, update the cached field
 * too — otherwise the two diverge and bills show wrong dues silently.
 */
export function computeBillFinancialsFromPersisted(
  bill: PersistedBillFinancials,
): BillFinancialFields {
  const subtotal = Math.max(0, Math.round(bill.totalAmountInPaise || 0));
  const discountAmountInPaise = Math.min(
    subtotal,
    Math.max(0, Math.round(bill.discountAmountInPaise ?? 0)),
  );
  // Refunds reduce the net payable: the refunded portion of an order is no
  // longer owed, so returning the money keeps `due` at 0 instead of showing a
  // phantom balance. 0 for all pre-refund bills, so existing math is unchanged.
  const refundedAmountInPaise = Math.max(0, Math.round(bill.refundedAmountInPaise ?? 0));
  const netBeforeRefund = Math.max(0, subtotal - discountAmountInPaise);
  const netAmountInPaise = Math.max(0, netBeforeRefund - refundedAmountInPaise);
  // Source of truth for paid: prefer the transactions list when it actually
  // contains entries; otherwise use the cached paidAmountInPaise field on the
  // Bill row. Empty array does NOT override the cached field — that prevents a
  // foot-gun where a caller passes `{transactions: []}` thinking "I haven't
  // loaded any" and silently zeros out paid. REFUND rows subtract from paid.
  let rawPaidAmount = Math.max(0, Math.round(bill.paidAmountInPaise ?? 0));
  if (Array.isArray(bill.transactions) && bill.transactions.length > 0) {
    rawPaidAmount = bill.transactions.reduce(
      (sum, tx) =>
        sum +
        (tx.transactionType === "REFUND"
          ? -(tx.amountInPaise || 0)
          : tx.amountInPaise || 0),
      0,
    );
  }
  const paidAmountInPaise = Math.min(netAmountInPaise, Math.max(0, rawPaidAmount));
  const dueAmountInPaise = Math.max(0, netAmountInPaise - paidAmountInPaise);

  // Refund status: fully refunded (nothing left billable/paid) → REFUNDED;
  // any other bill carrying a refund → PARTIALLY_REFUNDED; otherwise the normal
  // paid/pending split.
  let paymentStatus: PaymentStatus;
  if (refundedAmountInPaise > 0 && netAmountInPaise === 0 && paidAmountInPaise === 0) {
    paymentStatus = PaymentStatus.REFUNDED;
  } else if (refundedAmountInPaise > 0) {
    paymentStatus = PaymentStatus.PARTIALLY_REFUNDED;
  } else {
    paymentStatus =
      dueAmountInPaise === 0 ? PaymentStatus.PAID : PaymentStatus.PENDING;
  }

  return {
    discountReason: bill.discountReason ?? null,
    discountType: bill.discountType ?? null,
    discountPercentage: bill.discountPercentage ?? null,
    discountAmountInPaise,
    paidAmountInPaise,
    netAmountInPaise,
    dueAmountInPaise,
    paymentStatus,
  };
}

export function normalizeBillFinancialInput(
  input: BillFinancialInput,
  options: { defaultPaidToNet?: boolean } = {},
): BillFinancialFields {
  const subtotal = Math.max(0, Math.round(input.totalAmountInPaise || 0));
  const discountType = normalizeDiscountType(input.discountType);
  const rawDiscountValue = toFiniteNumber(input.discountValue);
  let discountPercentage: number | null = null;
  let discountAmountInPaise = 0;

  if (discountType === BillDiscountType.PERCENTAGE) {
    const percentage = rawDiscountValue ?? 0;
    if (percentage < 0 || percentage > 100) {
      throw new Error("Discount percentage must be between 0 and 100");
    }
    discountPercentage = percentage;
    discountAmountInPaise = Math.round((subtotal * percentage) / 100);
  } else if (discountType === BillDiscountType.FLAT_AMOUNT) {
    const flatAmountInPaise = toPaiseFromRupees(input.discountValue) ?? 0;
    if (flatAmountInPaise < 0) {
      throw new Error("Discount amount must be a non-negative number");
    }
    discountAmountInPaise = flatAmountInPaise;
  }

  if (discountAmountInPaise > subtotal) {
    throw new Error("Discount cannot exceed bill subtotal");
  }

  const netAmountInPaise = Math.max(0, subtotal - discountAmountInPaise);
  const explicitPaidInPaise =
    toFiniteNumber(input.paidAmountInPaise) ??
    toPaiseFromRupees(input.paidAmount);
  const paidAmountInPaise =
    explicitPaidInPaise === null && options.defaultPaidToNet
      ? netAmountInPaise
      : Math.max(0, Math.round(explicitPaidInPaise ?? 0));

  if (paidAmountInPaise > netAmountInPaise) {
    throw new Error("Paid amount cannot exceed net payable");
  }

  const dueAmountInPaise = Math.max(0, netAmountInPaise - paidAmountInPaise);

  return {
    discountReason: input.discountReason ?? null,
    discountType,
    discountPercentage,
    discountAmountInPaise,
    paidAmountInPaise,
    netAmountInPaise,
    dueAmountInPaise,
    paymentStatus:
      dueAmountInPaise === 0 ? PaymentStatus.PAID : PaymentStatus.PENDING,
  };
}

export function collectBillDue(
  bill: PersistedBillFinancials,
  amount: number | string | null | undefined,
): BillFinancialFields {
  const current = computeBillFinancialsFromPersisted(bill);
  const collectAmountInPaise = toPaiseFromRupees(amount);

  if (collectAmountInPaise === null || collectAmountInPaise <= 0) {
    throw new Error("Collection amount must be greater than zero");
  }

  if (collectAmountInPaise > current.dueAmountInPaise) {
    throw new Error("Collection amount cannot exceed due amount");
  }

  const nextPaidAmountInPaise =
    current.paidAmountInPaise + collectAmountInPaise;
  const nextDueAmountInPaise = Math.max(
    0,
    current.netAmountInPaise - nextPaidAmountInPaise,
  );

  return {
    ...current,
    paidAmountInPaise: nextPaidAmountInPaise,
    dueAmountInPaise: nextDueAmountInPaise,
    paymentStatus:
      nextDueAmountInPaise === 0
        ? PaymentStatus.PAID
        : PaymentStatus.PENDING,
  };
}

export function recomputeBillFinancialsForSubtotal(
  bill: PersistedBillFinancials,
  nextTotalAmountInPaise: number,
): BillFinancialFields {
  const subtotal = Math.max(0, Math.round(nextTotalAmountInPaise || 0));
  const nextDiscountAmountInPaise =
    bill.discountType === BillDiscountType.PERCENTAGE
      ? Math.round((subtotal * (bill.discountPercentage ?? 0)) / 100)
      : Math.min(
          subtotal,
          Math.max(0, Math.round(bill.discountAmountInPaise ?? 0)),
        );
  const nextNetAmountInPaise = Math.max(
    0,
    subtotal - nextDiscountAmountInPaise,
  );
  // Resolve the actual amount paid: prefer the transactions list when it has
  // entries (authoritative), otherwise fall back to the cached field on the
  // Bill row.
  let rawPaidAmount = Math.max(0, Math.round(bill.paidAmountInPaise ?? 0));
  if (Array.isArray(bill.transactions) && bill.transactions.length > 0) {
    rawPaidAmount = bill.transactions.reduce(
      (sum, tx) => sum + (tx.amountInPaise || 0),
      0,
    );
  }

  // If reducing the subtotal would put us below what's already been paid, the
  // patient has overpaid — refuse rather than silently dropping the overpayment.
  // The caller (typically a "remove test from visit" flow) must explicitly
  // refund the difference first.
  if (rawPaidAmount > nextNetAmountInPaise) {
    throw new Error(
      `Cannot reduce subtotal below the already-paid amount (paid ₹${(rawPaidAmount / 100).toFixed(2)}, new net ₹${(nextNetAmountInPaise / 100).toFixed(2)}). Refund the overpayment before reducing the bill.`,
    );
  }

  const paidAmountInPaise = rawPaidAmount;
  const dueAmountInPaise = Math.max(
    0,
    nextNetAmountInPaise - paidAmountInPaise,
  );

  return {
    discountReason: bill.discountReason ?? null,
    discountType: bill.discountType ?? null,
    discountPercentage: bill.discountPercentage ?? null,
    discountAmountInPaise: nextDiscountAmountInPaise,
    paidAmountInPaise,
    netAmountInPaise: nextNetAmountInPaise,
    dueAmountInPaise,
    paymentStatus:
      dueAmountInPaise === 0 ? PaymentStatus.PAID : PaymentStatus.PENDING,
  };
}

export function buildBillFinancialResponse(
  bill: PersistedBillFinancials | null | undefined,
) {
  if (!bill) {
    return {
      discountReason: null,
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
    discountReason: computed.discountReason,
    discountType: computed.discountType,
    discountPercentage: computed.discountPercentage,
    discountAmountInPaise: computed.discountAmountInPaise,
    paidAmountInPaise: computed.paidAmountInPaise,
    netAmountInPaise: computed.netAmountInPaise,
    dueAmountInPaise: computed.dueAmountInPaise,
  };
}

export function allocateBillDiscountAcrossOrders<
  T extends { id: string; priceInPaise: number },
>(orders: T[], discountAmountInPaise: number): Map<string, number> {
  const allocations = new Map<string, number>();
  const safeDiscount = Math.max(0, Math.round(discountAmountInPaise || 0));
  const total = orders.reduce(
    (sum, order) => sum + Math.max(0, Math.round(order.priceInPaise)),
    0,
  );

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
    if (right.remainder !== left.remainder)
      return right.remainder - left.remainder;
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
