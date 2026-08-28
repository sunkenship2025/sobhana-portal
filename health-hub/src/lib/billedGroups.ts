import type { VisitTimelineItem } from "@/types";

/**
 * A billed line as the PATIENT was sold it — one row per BillableProduct, not
 * one per TestOrder.
 *
 * The API returns test orders at leaf granularity: a COMPLETE BLOOD PICTURE
 * arrives as 13 separate rows (Hemoglobin, Total RBC Count, ...) that share one
 * productId and split the product's price between them. Any surface that lets
 * staff ACT on a billed item must roll those back up first, or it offers to
 * cancel "Hemoglobin ₹23" — something that was never sold on its own, and whose
 * removal leaves a 12-of-13 CBP on the bill and a report missing a parameter.
 */
export interface BilledGroup {
  productId: string;
  name: string;
  totalInPaise: number;
  isOutsourced: boolean;
  /** Every leaf order in this product — act on the whole set, never a subset. */
  orderIds: string[];
}

/**
 * Active billed items grouped by product, matching what the printed bill shows.
 * Cancelled orders are excluded; orders with no productId (legacy rows) are
 * skipped, since there is no product to roll them up into.
 */
export function buildBilledGroups(
  testOrders: VisitTimelineItem["testOrders"],
): BilledGroup[] {
  const map = new Map<string, BilledGroup>();
  for (const order of testOrders ?? []) {
    if (order.cancelledAt || !order.productId) continue;
    const existing = map.get(order.productId);
    if (existing) {
      existing.totalInPaise += order.priceInPaise;
      existing.isOutsourced = existing.isOutsourced || Boolean(order.isOutsourced);
      existing.orderIds.push(order.id);
    } else {
      map.set(order.productId, {
        productId: order.productId,
        name: order.productName || order.testName,
        totalInPaise: order.priceInPaise,
        isOutsourced: Boolean(order.isOutsourced),
        orderIds: [order.id],
      });
    }
  }
  return Array.from(map.values());
}

/**
 * Legacy orders carrying no productId. They cannot be grouped, so a surface
 * that acts on billed items must offer them individually or it would silently
 * hide them.
 */
export function ungroupedOrders(testOrders: VisitTimelineItem["testOrders"]) {
  return (testOrders ?? []).filter((order) => !order.cancelledAt && !order.productId);
}
