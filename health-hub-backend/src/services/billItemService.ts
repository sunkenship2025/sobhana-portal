type ReferralCommissionType = 'PERCENTAGE' | 'FIXED_AMOUNT';

export interface DiagnosticBillOrderInput {
  id: string;
  productId?: string | null;
  product?: {
    id: string;
    name: string;
    code: string;
  } | null;
  testName: string;
  testCode: string;
  priceInPaise: number;
  referralCommissionType?: ReferralCommissionType | null;
  referralCommissionPercentage?: number | null;
  referralCommissionAmountInPaise?: number | null;
}

export interface DiagnosticBillItem {
  id: string;
  name: string;
  code: string;
  price: number;
  referralCommissionType?: ReferralCommissionType;
  referralCommissionPercent?: number;
  referralCommissionAmountInPaise?: number;
}

function mergeReferralMetadata(target: DiagnosticBillItem, order: DiagnosticBillOrderInput) {
  const incomingType = order.referralCommissionType ?? undefined;

  if (!incomingType) {
    return;
  }

  if (!target.referralCommissionType) {
    target.referralCommissionType = incomingType;
    if (incomingType === 'PERCENTAGE') {
      target.referralCommissionPercent = order.referralCommissionPercentage ?? undefined;
      target.referralCommissionAmountInPaise = undefined;
    } else {
      target.referralCommissionAmountInPaise = order.referralCommissionAmountInPaise ?? 0;
      target.referralCommissionPercent = undefined;
    }
    return;
  }

  if (target.referralCommissionType !== incomingType) {
    target.referralCommissionType = undefined;
    target.referralCommissionPercent = undefined;
    target.referralCommissionAmountInPaise = undefined;
    return;
  }

  if (incomingType === 'FIXED_AMOUNT') {
    target.referralCommissionAmountInPaise =
      (target.referralCommissionAmountInPaise ?? 0) + (order.referralCommissionAmountInPaise ?? 0);
    return;
  }

  const existingPercent = target.referralCommissionPercent ?? undefined;
  const incomingPercent = order.referralCommissionPercentage ?? undefined;
  if (
    existingPercent !== undefined &&
    incomingPercent !== undefined &&
    Math.abs(existingPercent - incomingPercent) <= 0.0001
  ) {
    return;
  }

  target.referralCommissionType = undefined;
  target.referralCommissionPercent = undefined;
  target.referralCommissionAmountInPaise = undefined;
}

function toStandaloneBillItem(order: DiagnosticBillOrderInput): DiagnosticBillItem {
  return {
    id: order.id,
    name: order.testName,
    code: order.testCode,
    price: order.priceInPaise / 100,
    referralCommissionType: order.referralCommissionType ?? undefined,
    referralCommissionPercent: order.referralCommissionPercentage ?? undefined,
    referralCommissionAmountInPaise: order.referralCommissionAmountInPaise ?? undefined,
  };
}

export function buildDiagnosticBillItems(orders: DiagnosticBillOrderInput[]): DiagnosticBillItem[] {
  const items: DiagnosticBillItem[] = [];
  const groupedByProductId = new Map<string, DiagnosticBillItem>();

  for (const order of orders) {
    if (!order.productId || !order.product) {
      items.push(toStandaloneBillItem(order));
      continue;
    }

    const existing = groupedByProductId.get(order.productId);
    if (!existing) {
      const groupedItem: DiagnosticBillItem = {
        id: order.product.id,
        name: order.product.name,
        code: order.product.code,
        price: order.priceInPaise / 100,
      };
      mergeReferralMetadata(groupedItem, order);
      groupedByProductId.set(order.productId, groupedItem);
      items.push(groupedItem);
      continue;
    }

    existing.price += order.priceInPaise / 100;
    mergeReferralMetadata(existing, order);
  }

  return items;
}
