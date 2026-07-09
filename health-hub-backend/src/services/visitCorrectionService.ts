/**
 * visitCorrectionService — post-billing corrections for data-entry mistakes,
 * built so money can never be silently rewritten:
 *
 *  - changeVisitReferral: repoint the visit's referring doctor (or back to
 *    SELF) and re-freeze every active order's commission snapshot with the
 *    same rules billing uses. The old referral link is soft-deleted (kept in
 *    the DB for history, marked with deletedAt/deletedReason/deletedBy) rather
 *    than hard-deleted, so the visit looks Self everywhere while the history
 *    survives. Payouts carry no paid/unpaid concept — they are always "what's
 *    owed for the period" — so instead of blocking when a payout run covers the
 *    visit, we re-derive that run so its amount drops to match.
 *  - swapVisitProduct: replace one billed product with another of the SAME
 *    effective price (typo fixes like CREATININE → URIC ACID). Bill totals,
 *    paid and due are untouched by construction; anything money-changing must
 *    go through cancel/refund + add-tests instead.
 *
 * Every correction demands a reason and writes an immutable AuditLog row with
 * old → new values, so the owner ops audit feed surfaces them.
 */
import prisma from "../lib/prisma";
import { logAction } from "./auditService";
import { deleteCachedMergedPdf } from "./mergedReportPdfCache";
import {
  distributeFixedAmountInPaise,
  resolveReducedReferralSnapshot,
} from "./referralPayoutService";
import { resolveProducts } from "./productOrderService";

export class CorrectionError extends Error {
  constructor(
    public statusCode: number,
    public errorCode: string,
    message: string,
  ) {
    super(message);
    this.name = "CorrectionError";
  }
}

type CommissionRule = {
  commissionType: "PERCENTAGE" | "FIXED_AMOUNT";
  commissionPercent: number | null;
  commissionAmountInPaise: number | null;
};

type CommissionSnapshot = {
  referralCommissionType: "PERCENTAGE" | "FIXED_AMOUNT";
  referralCommissionPercentage: number | null;
  referralCommissionAmountInPaise: number | null;
};

const SELF_SNAPSHOT: CommissionSnapshot = {
  referralCommissionType: "PERCENTAGE",
  referralCommissionPercentage: 0,
  referralCommissionAmountInPaise: null,
};

/** Mirror of billing's applyReferralRuleToPrices for a group of order prices. */
function snapshotsForRule(
  pricesInPaise: number[],
  rule: CommissionRule | null,
): CommissionSnapshot[] {
  if (!rule) return pricesInPaise.map(() => ({ ...SELF_SNAPSHOT }));
  if (rule.commissionType === "FIXED_AMOUNT") {
    const distributed = distributeFixedAmountInPaise(
      rule.commissionAmountInPaise ?? 0,
      pricesInPaise,
    );
    return distributed.map((amount) => ({
      referralCommissionType: "FIXED_AMOUNT",
      referralCommissionPercentage: null,
      referralCommissionAmountInPaise: amount,
    }));
  }
  return pricesInPaise.map(() => ({
    referralCommissionType: "PERCENTAGE",
    referralCommissionPercentage: rule.commissionPercent ?? 0,
    referralCommissionAmountInPaise: null,
  }));
}

/**
 * After a referral change, any derived payout run covering this visit for the
 * affected doctor is now stale (a made-Self visit must leave that doctor's
 * total; a newly-referred visit must join it). Re-derive each covering run so
 * its stored amount matches the new reality. Best-effort — a refresh failure
 * must not roll back the committed referral change (the worklist/statement also
 * re-derive live on view), so failures are logged and swallowed.
 */
async function refreshCoveringReferralPayouts(
  referralDoctorId: string,
  branchId: string,
  anchorDate: Date,
) {
  const runs = await prisma.doctorPayoutLedger.findMany({
    where: {
      doctorType: "REFERRAL",
      referralDoctorId,
      branchId,
      deletedAt: null,
      periodStartDate: { lte: anchorDate },
      periodEndDate: { gte: anchorDate },
    },
    select: { periodStartDate: true, periodEndDate: true },
  });
  if (runs.length === 0) return;
  // Lazy import avoids a load-time cycle with payoutService.
  const { derivePayout } = await import("./payoutService");
  for (const run of runs) {
    try {
      await derivePayout(
        "REFERRAL",
        referralDoctorId,
        branchId,
        run.periodStartDate,
        run.periodEndDate,
      );
    } catch (err) {
      console.error(
        `refreshCoveringReferralPayouts: failed to re-derive payout for doctor ${referralDoctorId}`,
        err,
      );
    }
  }
}

/** Latest finalized date if any, else creation — the date payout windows use. */
function payoutAnchorDate(visit: {
  createdAt: Date;
  report: { versions: { finalizedAt: Date | null }[] } | null;
}): Date {
  const finalized = (visit.report?.versions ?? [])
    .map((version) => version.finalizedAt)
    .filter((d): d is Date => Boolean(d))
    .sort((a, b) => b.getTime() - a.getTime())[0];
  return finalized ?? visit.createdAt;
}

async function loadVisitForCorrection(visitId: string, branchId: string) {
  const visit = await prisma.visit.findFirst({
    where: { id: visitId, branchId, domain: "DIAGNOSTICS" },
    include: {
      bill: true,
      referrals: {
        where: { deletedAt: null },
        include: { referralDoctor: { select: { id: true, name: true } } },
      },
      testOrders: true,
      report: {
        select: {
          versions: {
            select: {
              id: true,
              finalizedAt: true,
              status: true,
              visitSnapshot: true,
            },
          },
        },
      },
    },
  });
  if (!visit) {
    throw new CorrectionError(404, "NOT_FOUND", "Diagnostic visit not found");
  }
  return visit;
}

export async function changeVisitReferral(params: {
  visitId: string;
  branchId: string;
  referralDoctorId: string | null; // null ⇒ SELF (no referral)
  reason: string;
  note?: string | null;
  userId: string;
}) {
  const { visitId, branchId, referralDoctorId, reason, note, userId } = params;
  const visit = await loadVisitForCorrection(visitId, branchId);

  const currentReferral = visit.referrals[0] ?? null;
  const oldDoctorId = currentReferral?.referralDoctorId ?? null;
  if (oldDoctorId === referralDoctorId) {
    throw new CorrectionError(
      400,
      "NO_CHANGE",
      "The visit already has this referral",
    );
  }

  const anchorDate = payoutAnchorDate(visit);

  let newDoctor: {
    id: string;
    name: string;
    commissionType: "PERCENTAGE" | "FIXED_AMOUNT";
    commissionPercent: number | null;
    commissionAmountInPaise: number | null;
    productRules: {
      productId: string;
      commissionType: "PERCENTAGE" | "FIXED_AMOUNT";
      commissionPercent: number | null;
      commissionAmountInPaise: number | null;
    }[];
  } | null = null;

  if (referralDoctorId) {
    newDoctor = (await prisma.referralDoctor.findUnique({
      where: { id: referralDoctorId },
      include: { productRules: { where: { isActive: true } } },
    })) as any;
    if (!newDoctor) {
      throw new CorrectionError(400, "VALIDATION_ERROR", "Referral doctor not found");
    }
  }

  // Re-freeze commission snapshots exactly like billing: per product group,
  // product rule ?? doctor default; outsourced orders get the lab's reduced
  // referral rate when configured.
  const activeOrders = visit.testOrders.filter((order) => !order.cancelledAt);
  const ruleByProductId = new Map<string, CommissionRule>(
    (newDoctor?.productRules ?? []).map((rule) => [
      rule.productId,
      {
        commissionType: rule.commissionType,
        commissionPercent: rule.commissionPercent,
        commissionAmountInPaise: rule.commissionAmountInPaise,
      },
    ]),
  );
  const defaultRule: CommissionRule | null = newDoctor
    ? {
        commissionType: newDoctor.commissionType,
        commissionPercent: newDoctor.commissionPercent,
        commissionAmountInPaise: newDoctor.commissionAmountInPaise,
      }
    : null;

  // Reduced-referral rules for outsourced orders (lab+product specific).
  const outsourcedPairs = activeOrders
    .filter((order) => order.externalLabId && order.productId)
    .map((order) => ({ labId: order.externalLabId!, productId: order.productId! }));
  const labRules = outsourcedPairs.length
    ? await prisma.externalLabProductRule.findMany({
        where: {
          isActive: true,
          OR: outsourcedPairs.map((pair) => ({
            externalLabId: pair.labId,
            productId: pair.productId,
          })),
        },
      })
    : [];
  const labRuleByKey = new Map(
    labRules.map((rule) => [`${rule.externalLabId}:${rule.productId}`, rule]),
  );

  // Group orders by product so FIXED_AMOUNT rules distribute across the
  // product's constituent orders the same way billing does.
  const groups = new Map<string, typeof activeOrders>();
  for (const order of activeOrders) {
    const key = order.productId ?? `__order__${order.id}`;
    const list = groups.get(key) ?? [];
    list.push(order);
    groups.set(key, list);
  }

  const orderSnapshots = new Map<string, CommissionSnapshot>();
  for (const [key, orders] of groups) {
    const productId = key.startsWith("__order__") ? null : key;
    const rule = newDoctor
      ? ((productId && ruleByProductId.get(productId)) || defaultRule)
      : null;
    const snapshots = snapshotsForRule(
      orders.map((order) => order.priceInPaise),
      rule,
    );
    orders.forEach((order, index) => {
      let snapshot = snapshots[index];
      if (newDoctor && order.externalLabId && order.productId) {
        const labRule = labRuleByKey.get(
          `${order.externalLabId}:${order.productId}`,
        );
        if (labRule?.reducedReferralCommissionType != null) {
          snapshot = resolveReducedReferralSnapshot(snapshot, labRule);
        }
      }
      orderSnapshots.set(order.id, snapshot);
    });
  }

  // Group orders sharing an identical snapshot into one updateMany each —
  // per-order updates over the pooled remote connection blow the interactive
  // transaction timeout on large bills.
  const ordersBySnapshotKey = new Map<
    string,
    { snapshot: CommissionSnapshot; orderIds: string[] }
  >();
  for (const [orderId, snapshot] of orderSnapshots) {
    const key = `${snapshot.referralCommissionType}:${snapshot.referralCommissionPercentage}:${snapshot.referralCommissionAmountInPaise}`;
    const entry = ordersBySnapshotKey.get(key) ?? { snapshot, orderIds: [] };
    entry.orderIds.push(orderId);
    ordersBySnapshotKey.set(key, entry);
  }

  // A finalized report renders "Referred by" from the referralDoctorName frozen
  // into its visitSnapshot at finalization, NOT from the live referral link. A
  // correction that only repointed the link would leave every already-finalized
  // report (screen + printed PDF + WhatsApp gateway) showing the old doctor. So
  // repoint the frozen name too — null ⇒ the renderer prints "SELF". Draft /
  // non-finalized versions re-derive from live data and need no patch. This is
  // a deliberate amendment of the immutable snapshot, bounded to the one
  // identifying field the user just corrected and recorded in the audit log
  // below.
  const newReferralName = newDoctor?.name ?? null;
  const finalizedSnapshotPatches = (visit.report?.versions ?? [])
    .filter((version) => version.status === "FINALIZED" && version.visitSnapshot)
    .map((version) => ({
      id: version.id,
      visitSnapshot: {
        ...(version.visitSnapshot as Record<string, unknown>),
        referralDoctorName: newReferralName,
      },
    }));

  await prisma.$transaction(
    async (tx) => {
      // Soft-delete the active link(s): keep the row in the DB as history,
      // marked changed. Every referral-attribution read filters deletedAt IS
      // NULL, so the visit now looks Self / re-referred everywhere.
      await tx.referralDoctor_Visit.updateMany({
        where: { visitId, deletedAt: null },
        data: { deletedAt: new Date(), deletedReason: reason, deletedBy: userId },
      });
      if (referralDoctorId) {
        await tx.referralDoctor_Visit.create({
          data: { visitId, referralDoctorId, branchId },
        });
      }
      for (const { snapshot, orderIds } of ordersBySnapshotKey.values()) {
        await tx.testOrder.updateMany({
          where: { id: { in: orderIds } },
          data: snapshot,
        });
      }
      for (const patch of finalizedSnapshotPatches) {
        await tx.reportVersion.update({
          where: { id: patch.id },
          data: { visitSnapshot: patch.visitSnapshot as any },
        });
      }
    },
    { timeout: 30_000 },
  );

  // The public report download caches the merged PDF per finalized version,
  // assuming the snapshot never changes. We just changed it, so drop those
  // cache entries or the patient/doctor keeps downloading the old doctor's PDF
  // until the 7-day TTL lapses. Best-effort; runs after commit.
  for (const patch of finalizedSnapshotPatches) {
    await deleteCachedMergedPdf(patch.id);
  }

  // Re-derive any payout run that covered this visit so its total drops (Self)
  // or grows (re-referred) to match. Best-effort; runs after commit.
  const affectedDoctorIds = [oldDoctorId, referralDoctorId].filter(
    (id): id is string => Boolean(id),
  );
  for (const doctorId of affectedDoctorIds) {
    await refreshCoveringReferralPayouts(doctorId, branchId, anchorDate);
  }

  await logAction({
    branchId,
    actionType: "UPDATE",
    entityType: "Visit",
    entityId: visitId,
    userId,
    oldValues: {
      action: "REFERRAL_CHANGE",
      referralDoctorId: oldDoctorId,
      referralDoctorName: currentReferral?.referralDoctor?.name ?? "SELF",
    },
    newValues: {
      action: "REFERRAL_CHANGE",
      billNumber: visit.billNumber,
      referralDoctorId,
      referralDoctorName: newDoctor?.name ?? "SELF",
      ordersResnapshotted: orderSnapshots.size,
      reason,
      note: note ?? null,
    },
  });

  return {
    oldReferralDoctorName: currentReferral?.referralDoctor?.name ?? null,
    newReferralDoctorName: newDoctor?.name ?? null,
  };
}

export async function swapVisitProduct(params: {
  visitId: string;
  branchId: string;
  oldProductId: string;
  newProductId: string;
  reason: string;
  note?: string | null;
  userId: string;
}) {
  const { visitId, branchId, oldProductId, newProductId, reason, note, userId } =
    params;
  if (oldProductId === newProductId) {
    throw new CorrectionError(400, "NO_CHANGE", "Both products are the same");
  }
  const visit = await loadVisitForCorrection(visitId, branchId);

  const hasFinalized = (visit.report?.versions ?? []).some(
    (version) => version.status === "FINALIZED",
  );
  if (hasFinalized) {
    throw new CorrectionError(
      409,
      "REPORT_FINALIZED",
      "This visit already has a finalized report — cancel/refund the wrong test and bill the correct one instead.",
    );
  }

  const targetOrders = visit.testOrders.filter(
    (order) => order.productId === oldProductId && !order.cancelledAt,
  );
  if (targetOrders.length === 0) {
    throw new CorrectionError(
      400,
      "VALIDATION_ERROR",
      "No active billed tests found for that product on this visit",
    );
  }
  if (targetOrders.some((order) => order.externalLabId)) {
    throw new CorrectionError(
      409,
      "OUTSOURCED_ORDER",
      "That test is outsourced to an outside lab — use cancel/refund + re-bill so the lab payable stays correct.",
    );
  }

  const oldTotalInPaise = targetOrders.reduce(
    (sum, order) => sum + order.priceInPaise,
    0,
  );

  const resolved = (await resolveProducts([newProductId], branchId))[0];
  if (!resolved) {
    throw new CorrectionError(400, "VALIDATION_ERROR", "Replacement product not found");
  }
  if (resolved.effectivePrice !== oldTotalInPaise) {
    throw new CorrectionError(
      409,
      "PRICE_MISMATCH",
      `Swap must be money-neutral: billed ₹${(oldTotalInPaise / 100).toFixed(2)} vs replacement ₹${(resolved.effectivePrice / 100).toFixed(2)}. Use cancel/refund + add tests for price changes.`,
    );
  }

  // Commission snapshots for the new orders under the CURRENT referral.
  const currentReferral = visit.referrals[0] ?? null;
  const anchorDate = payoutAnchorDate(visit);
  let rule: CommissionRule | null = null;
  if (currentReferral?.referralDoctorId) {
    const doctor = await prisma.referralDoctor.findUnique({
      where: { id: currentReferral.referralDoctorId },
      include: {
        productRules: { where: { isActive: true, productId: newProductId } },
      },
    });
    if (doctor) {
      const productRule = doctor.productRules[0];
      rule = productRule
        ? {
            commissionType: productRule.commissionType,
            commissionPercent: productRule.commissionPercent,
            commissionAmountInPaise: productRule.commissionAmountInPaise,
          }
        : {
            commissionType: doctor.commissionType,
            commissionPercent: doctor.commissionPercent,
            commissionAmountInPaise: doctor.commissionAmountInPaise,
          };
    }
  }
  const snapshots = snapshotsForRule(
    resolved.testOrders.map((order) => order.priceInPaise),
    rule,
  );

  const resultsToDelete = await prisma.testResult.count({
    where: { testOrderId: { in: targetOrders.map((order) => order.id) } },
  });
  const displayOrderBase = Math.min(
    ...targetOrders.map((order) => order.displayOrder ?? 0),
  );

  await prisma.$transaction(async (tx) => {
    await tx.testOrder.createMany({
      data: resolved.testOrders.map((order, index) => ({
        visitId,
        branchId,
        testId: order.labTestId,
        testDefinitionId: order.testDefinitionId,
        productId: order.productId,
        workflowMode: order.workflowMode,
        priceInPaise: order.priceInPaise,
        testNameSnapshot: order.testName,
        testCodeSnapshot: order.testCode,
        referenceMinSnapshot: order.referenceMin,
        referenceMaxSnapshot: order.referenceMax,
        referenceUnitSnapshot: order.referenceUnit,
        displayOrder: displayOrderBase + index,
        ...snapshots[index],
      })),
    });
    // Hard-delete the mistaken orders (cascades their results); the swap is
    // fully recorded in the audit log, and the bill's money is untouched.
    await tx.testOrder.deleteMany({
      where: { id: { in: targetOrders.map((order) => order.id) } },
    });
  }, { timeout: 30_000 });

  await logAction({
    branchId,
    actionType: "UPDATE",
    entityType: "Visit",
    entityId: visitId,
    userId,
    oldValues: {
      action: "PRODUCT_SWAP",
      productId: oldProductId,
      testNames: targetOrders.map((order) => order.testNameSnapshot),
      amountInPaise: oldTotalInPaise,
    },
    newValues: {
      action: "PRODUCT_SWAP",
      billNumber: visit.billNumber,
      productId: newProductId,
      productName: resolved.productName,
      amountInPaise: resolved.effectivePrice,
      resultsDeleted: resultsToDelete,
      reason,
      note: note ?? null,
    },
  });

  // A swap is money-neutral for the bill, but a product-specific commission rule
  // can change what the referrer earns, so refresh any covering payout run.
  if (currentReferral?.referralDoctorId) {
    await refreshCoveringReferralPayouts(
      currentReferral.referralDoctorId,
      branchId,
      anchorDate,
    );
  }

  return {
    oldTestNames: targetOrders.map((order) => order.testNameSnapshot),
    newProductName: resolved.productName,
    resultsDeleted: resultsToDelete,
  };
}
