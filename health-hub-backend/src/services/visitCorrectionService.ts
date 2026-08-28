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
import { categorize } from "./payoutCategorize";
import { recomputeBillFinancialsForSubtotal } from "./billFinancialService";
import { DiagnosticWorkflowMode } from "@prisma/client";

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

// Sort branch-scoped rows global-first so a later branch row overrides the
// global one for the same key when fed into a Map in order.
function branchFirst<T extends { branchId: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.branchId === null ? 0 : 1) - (b.branchId === null ? 0 : 1));
}

/** The rate card for a branch (its overrides on top of the global rows). */
async function loadCenterCategoryRates(branchId: string): Promise<Map<string, CommissionRule>> {
  const rates = await prisma.referralCategoryRate.findMany({
    where: { isActive: true, OR: [{ branchId }, { branchId: null }] },
  });
  const map = new Map<string, CommissionRule>();
  for (const rate of branchFirst(rates)) {
    map.set(rate.category, {
      commissionType: rate.commissionType,
      commissionPercent: rate.commissionPercent,
      commissionAmountInPaise: rate.commissionAmountInPaise,
    });
  }
  return map;
}

/**
 * Resolve a per-order commission snapshot from its frozen payout category:
 * per-doctor category rule > centre category rate card > SELF (zero). Each order
 * earns the FULL flat amount for a FIXED_AMOUNT category (per-test, never
 * distributed). Mirrors billing's resolveCategoryReferralSnapshot.
 */
function categoryCommissionSnapshot(
  category: string | null,
  doctorCategoryRules: Map<string, CommissionRule>,
  centerCategoryRates: Map<string, CommissionRule>,
): CommissionSnapshot {
  const rule =
    (category ? doctorCategoryRules.get(category) : undefined) ??
    (category ? centerCategoryRates.get(category) : undefined) ??
    null;
  if (!rule) return { ...SELF_SNAPSHOT };
  if (rule.commissionType === "FIXED_AMOUNT") {
    return {
      referralCommissionType: "FIXED_AMOUNT",
      referralCommissionPercentage: null,
      referralCommissionAmountInPaise: rule.commissionAmountInPaise ?? 0,
    };
  }
  return {
    referralCommissionType: "PERCENTAGE",
    referralCommissionPercentage: rule.commissionPercent ?? 0,
    referralCommissionAmountInPaise: null,
  };
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
      branchId: string | null;
      commissionType: "PERCENTAGE" | "FIXED_AMOUNT";
      commissionPercent: number | null;
      commissionAmountInPaise: number | null;
    }[];
    categoryRules: {
      category: string;
      branchId: string | null;
      commissionType: "PERCENTAGE" | "FIXED_AMOUNT";
      commissionPercent: number | null;
      commissionAmountInPaise: number | null;
    }[];
  } | null = null;

  if (referralDoctorId) {
    newDoctor = (await prisma.referralDoctor.findUnique({
      where: { id: referralDoctorId },
      include: {
        productRules: { where: { isActive: true, OR: [{ branchId }, { branchId: null }] } },
        categoryRules: { where: { isActive: true, OR: [{ branchId }, { branchId: null }] } },
      },
    })) as any;
    if (!newDoctor) {
      throw new CorrectionError(400, "VALIDATION_ERROR", "Referral doctor not found");
    }
  }

  // Re-freeze commission snapshots exactly like billing: a per-product rule
  // covers the whole product (distributed); otherwise each order resolves from
  // its frozen panel category (doctor category rule > centre rate card > none).
  // Outsourced orders still get the lab's reduced referral rate when configured.
  const activeOrders = visit.testOrders.filter((order) => !order.cancelledAt);
  const ruleByProductId = new Map<string, CommissionRule>(
    branchFirst(newDoctor?.productRules ?? []).map((rule) => [
      rule.productId,
      {
        commissionType: rule.commissionType,
        commissionPercent: rule.commissionPercent,
        commissionAmountInPaise: rule.commissionAmountInPaise,
      },
    ]),
  );
  const doctorCategoryRuleByCategory = new Map<string, CommissionRule>(
    branchFirst(newDoctor?.categoryRules ?? []).map((rule) => [
      rule.category,
      {
        commissionType: rule.commissionType,
        commissionPercent: rule.commissionPercent,
        commissionAmountInPaise: rule.commissionAmountInPaise,
      },
    ]),
  );
  const centerCategoryRateByCategory = newDoctor
    ? await loadCenterCategoryRates(branchId)
    : new Map<string, CommissionRule>();

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
    const productRule =
      newDoctor && productId ? ruleByProductId.get(productId) ?? null : null;
    // Product rule → whole product, distributed. Otherwise each order resolves
    // from its own frozen category. No referral doctor → SELF (zero).
    const snapshots = productRule
      ? snapshotsForRule(orders.map((order) => order.priceInPaise), productRule)
      : newDoctor
        ? orders.map((order) =>
            categoryCommissionSnapshot(
              // Pre-migration orders have no frozen category — infer from the
              // test name (as payout grouping does) so re-attribution doesn't
              // silently zero their commission.
              order.payoutCategorySnapshot ??
                categorize({ testName: order.testNameSnapshot }),
              doctorCategoryRuleByCategory,
              centerCategoryRateByCategory,
            ),
          )
        : orders.map(() => ({ ...SELF_SNAPSHOT }));
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
  /** Dry-run: run every guard and report the impact without writing anything. */
  preview?: boolean;
}) {
  const { visitId, branchId, oldProductId, newProductId, reason, note, userId, preview } =
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

  // Swapping INTO a product the visit already carries silently double-bills it,
  // and the duplicate then has to be cancelled by hand. addProductsToVisit
  // refuses the same move (DUPLICATE_PRODUCTS); swap must too, or the guard is
  // only as strong as whichever path staff happen to use. oldProductId is
  // already known to differ from newProductId, so no need to exclude targets.
  if (
    visit.testOrders.some(
      (order) => order.productId === newProductId && !order.cancelledAt,
    )
  ) {
    throw new CorrectionError(
      409,
      "DUPLICATE_PRODUCTS",
      "That replacement test is already on this bill.",
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

  // Commission snapshots for the new orders under the CURRENT referral: a
  // per-product rule covers the whole product (distributed), otherwise each new
  // order resolves from its own panel category (doctor rule > centre rate card).
  const currentReferral = visit.referrals[0] ?? null;
  const anchorDate = payoutAnchorDate(visit);
  let snapshots: CommissionSnapshot[];
  if (currentReferral?.referralDoctorId) {
    const doctor = await prisma.referralDoctor.findUnique({
      where: { id: currentReferral.referralDoctorId },
      include: {
        productRules: { where: { isActive: true, productId: newProductId, OR: [{ branchId }, { branchId: null }] } },
        categoryRules: { where: { isActive: true, OR: [{ branchId }, { branchId: null }] } },
      },
    });
    // Branch override wins over the doctor's global product rule.
    const productRule =
      doctor?.productRules.find((r) => r.branchId === branchId) ??
      doctor?.productRules.find((r) => r.branchId === null);
    if (productRule) {
      snapshots = snapshotsForRule(
        resolved.testOrders.map((order) => order.priceInPaise),
        {
          commissionType: productRule.commissionType,
          commissionPercent: productRule.commissionPercent,
          commissionAmountInPaise: productRule.commissionAmountInPaise,
        },
      );
    } else if (doctor) {
      const doctorCategoryRules = new Map<string, CommissionRule>(
        branchFirst(doctor.categoryRules).map((r) => [
          r.category,
          {
            commissionType: r.commissionType,
            commissionPercent: r.commissionPercent,
            commissionAmountInPaise: r.commissionAmountInPaise,
          },
        ]),
      );
      const centerCategoryRates = await loadCenterCategoryRates(branchId);
      snapshots = resolved.testOrders.map((order) =>
        categoryCommissionSnapshot(
          order.payoutCategory,
          doctorCategoryRules,
          centerCategoryRates,
        ),
      );
    } else {
      snapshots = resolved.testOrders.map(() => ({ ...SELF_SNAPSHOT }));
    }
  } else {
    snapshots = resolved.testOrders.map(() => ({ ...SELF_SNAPSHOT }));
  }

  // Snapshot the results that the hard-delete is about to cascade away. The
  // outgoing rows leave NO trace in the DB (unlike every other correction path,
  // which soft-cancels), so the audit log is the only record they existed —
  // a bare count would make a deleted result unreconstructible.
  const deletedResults = await prisma.testResult.findMany({
    where: { testOrderId: { in: targetOrders.map((order) => order.id) } },
    select: {
      testOrderId: true,
      testId: true,
      testDefinitionId: true,
      value: true,
      textValue: true,
      flag: true,
      notes: true,
    },
  });
  const resultsToDelete = deletedResults.length;

  // Dry-run for the confirm dialog: every guard above has passed, so the caller
  // can show what the swap will destroy BEFORE the user commits to it.
  if (preview) {
    return {
      preview: true,
      oldTestNames: targetOrders.map((order) => order.testNameSnapshot),
      newProductName: resolved.productName,
      resultsDeleted: resultsToDelete,
    };
  }

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
        panelId: order.panelId,
        payoutCategorySnapshot: order.payoutCategory,
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
      // Full snapshot of the hard-deleted rows + their results. The TestOrder
      // rows are gone, so this is the ONLY way to reconstruct what was billed.
      orders: targetOrders.map((order) => ({
        id: order.id,
        testName: order.testNameSnapshot,
        testCode: order.testCodeSnapshot,
        priceInPaise: order.priceInPaise,
        productId: order.productId,
        panelId: order.panelId,
        testDefinitionId: order.testDefinitionId,
        workflowMode: order.workflowMode,
        results: deletedResults
          .filter((result) => result.testOrderId === order.id)
          .map(({ testOrderId: _omit, ...rest }) => rest),
      })),
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

// Roles allowed to add tests to an already-billed visit. Front-desk `staff`
// (and `sales`) are intentionally excluded — an add moves money on a bill they
// collected, so it is kept to the lab incharge / owner. Bills older than a week
// are owner-only (ADD_TESTS_OWNER_TIER). Enforced server-side, never trusting
// the UI, so it holds no matter which client calls it.
const ADD_TESTS_ROLES = new Set(["owner", "admin", "lab_incharge"]);
const ADD_TESTS_OWNER_TIER = new Set(["owner", "admin"]);
const ADD_TESTS_SELF_SERVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * addProductsToVisit — add one or more billable products to an EXISTING,
 * not-yet-finalized diagnostic visit (a post-billing add-on). Modelled on
 * swapVisitProduct: same referral-snapshot rules billing uses, an immutable
 * audit row, a covering-payout refresh. Unlike swap it is NOT money-neutral —
 * the added catalog price raises the bill total and the delta becomes Due
 * (collected via Collect Due). The exploit controls live here, server-side:
 *   - role gate: only owner / admin / lab_incharge may add;
 *   - age gate: bills > 7 days old are owner-only;
 *   - catalog price only (the caller never supplies a price);
 *   - a HIGH-severity audit row so the owner ops feed surfaces every add.
 * Deliberately refuses finalized reports (see the product decision: adds are
 * pre-finalization only).
 */
export async function addProductsToVisit(params: {
  visitId: string;
  branchId: string;
  productIds: string[];
  userId: string;
  userRole: string;
  note?: string | null;
}) {
  const { visitId, branchId, productIds, userId, userRole, note } = params;

  if (!Array.isArray(productIds) || productIds.length === 0) {
    throw new CorrectionError(400, "VALIDATION_ERROR", "At least one test is required");
  }

  // Role gate first — cheap, and it must hold regardless of caller.
  if (!ADD_TESTS_ROLES.has(userRole)) {
    throw new CorrectionError(
      403,
      "FORBIDDEN_ROLE",
      "Only a lab incharge or owner can add tests to a billed visit.",
    );
  }

  const visit = await loadVisitForCorrection(visitId, branchId);

  // Pre-finalization only: a finalized report is immutable.
  const hasFinalized = (visit.report?.versions ?? []).some(
    (version) => version.status === "FINALIZED",
  );
  if (hasFinalized) {
    throw new CorrectionError(
      409,
      "REPORT_FINALIZED",
      "This report is already finalized — cancel/refund and re-bill, or start a new visit.",
    );
  }

  const activeOrders = visit.testOrders.filter((order) => !order.cancelledAt);

  // A pure bill-only visit must not be silently turned reportable by bolting a
  // test on — same guard billing uses.
  if (
    activeOrders.length > 0 &&
    activeOrders.every(
      (order) => order.workflowMode === DiagnosticWorkflowMode.BILL_ONLY,
    )
  ) {
    throw new CorrectionError(
      400,
      "BILL_ONLY_VISIT",
      "Bill-only visits can't be converted into reportable ones by adding tests.",
    );
  }

  // Age gate — adding to an old bill is the classic laundering vector, so past a
  // week only an owner (or admin) can do it.
  const billAnchor = visit.bill?.billedAt ?? visit.createdAt;
  const billAgeMs = Date.now() - new Date(billAnchor).getTime();
  const billAgeDays = Math.max(0, Math.floor(billAgeMs / (24 * 60 * 60 * 1000)));
  if (
    billAgeMs > ADD_TESTS_SELF_SERVE_WINDOW_MS &&
    !ADD_TESTS_OWNER_TIER.has(userRole)
  ) {
    throw new CorrectionError(
      403,
      "OWNER_ONLY_OLD_BILL",
      `This bill is ${billAgeDays} days old — only an owner can add tests to bills older than 7 days.`,
    );
  }

  // Reject products already active on the visit — an accidental double-add would
  // double-charge the patient.
  const existingProductIds = new Set(
    activeOrders
      .map((order) => order.productId)
      .filter((pid): pid is string => Boolean(pid)),
  );
  const duplicates = productIds.filter((pid) => existingProductIds.has(pid));
  if (duplicates.length > 0) {
    throw new CorrectionError(
      409,
      "DUPLICATE_PRODUCTS",
      "Some of these tests are already on this bill.",
    );
  }

  // Resolve at catalog price (packages expand, price spreads across leaves) — the
  // caller never supplies a price. resolveProducts throws ProductResolutionError
  // (mapped to a 400 by the route).
  const resolved = await resolveProducts(productIds, branchId);
  const addedAmountInPaise = resolved.reduce(
    (sum, rp) => sum + rp.effectivePrice,
    0,
  );
  const newTotalInPaise = visit.totalAmountInPaise + addedAmountInPaise;

  // Commission snapshots under the CURRENT referral (mirror swapVisitProduct).
  const currentReferral = visit.referrals[0] ?? null;
  const anchorDate = payoutAnchorDate(visit);
  const displayOrderBase =
    Math.max(0, ...visit.testOrders.map((order) => order.displayOrder ?? 0)) + 1;

  // Load the current referrer's rules once (not per product): per-product rule
  // covers a whole product; otherwise each leaf resolves from its panel category
  // (doctor category rule > centre rate card > none).
  const doctorProductRules = new Map<string, CommissionRule>();
  const doctorCategoryRules = new Map<string, CommissionRule>();
  let centerCategoryRates = new Map<string, CommissionRule>();
  if (currentReferral?.referralDoctorId) {
    const doctor = await prisma.referralDoctor.findUnique({
      where: { id: currentReferral.referralDoctorId },
      include: {
        productRules: { where: { isActive: true, OR: [{ branchId }, { branchId: null }] } },
        categoryRules: { where: { isActive: true, OR: [{ branchId }, { branchId: null }] } },
      },
    });
    if (doctor) {
      // Global-first so the branch override wins for the same key.
      for (const r of branchFirst(doctor.productRules)) {
        doctorProductRules.set(r.productId, {
          commissionType: r.commissionType,
          commissionPercent: r.commissionPercent,
          commissionAmountInPaise: r.commissionAmountInPaise,
        });
      }
      for (const r of branchFirst(doctor.categoryRules)) {
        doctorCategoryRules.set(r.category, {
          commissionType: r.commissionType,
          commissionPercent: r.commissionPercent,
          commissionAmountInPaise: r.commissionAmountInPaise,
        });
      }
      centerCategoryRates = await loadCenterCategoryRates(branchId);
    }
  }

  const orderRows: any[] = [];
  let cursor = 0;
  for (const rp of resolved) {
    const productRule = doctorProductRules.get(rp.productId) ?? null;
    const snapshots = productRule
      ? snapshotsForRule(rp.testOrders.map((order) => order.priceInPaise), productRule)
      : currentReferral?.referralDoctorId
        ? rp.testOrders.map((order) =>
            categoryCommissionSnapshot(
              order.payoutCategory,
              doctorCategoryRules,
              centerCategoryRates,
            ),
          )
        : rp.testOrders.map(() => ({ ...SELF_SNAPSHOT }));
    rp.testOrders.forEach((order, index) => {
      orderRows.push({
        visitId,
        branchId,
        testId: order.labTestId,
        testDefinitionId: order.testDefinitionId,
        productId: order.productId,
        panelId: order.panelId,
        payoutCategorySnapshot: order.payoutCategory,
        workflowMode: order.workflowMode,
        priceInPaise: order.priceInPaise,
        testNameSnapshot: order.testName,
        testCodeSnapshot: order.testCode,
        referenceMinSnapshot: order.referenceMin,
        referenceMaxSnapshot: order.referenceMax,
        referenceUnitSnapshot: order.referenceUnit,
        displayOrder: displayOrderBase + cursor + index,
        ...snapshots[index],
      });
    });
    cursor += rp.testOrders.length;
  }

  if (orderRows.length === 0) {
    throw new CorrectionError(
      400,
      "INVALID_PANEL_CONFIGURATION",
      "The selected product has no reportable test items — fix its linked panel first.",
    );
  }

  // Recompute the bill against the raised subtotal — paid stays, so the delta
  // becomes Due. Load transactions so a previously-refunded bill recomputes paid
  // correctly.
  const billWithTx = visit.bill
    ? await prisma.bill.findUnique({
        where: { id: visit.bill.id },
        include: { transactions: true },
      })
    : null;
  const nextBillFinancials = billWithTx
    ? recomputeBillFinancialsForSubtotal(billWithTx, newTotalInPaise)
    : null;

  await prisma.$transaction(
    async (tx) => {
      await tx.testOrder.createMany({ data: orderRows });
      await tx.visit.update({
        where: { id: visitId },
        data: { totalAmountInPaise: newTotalInPaise },
      });
      if (visit.bill) {
        await tx.bill.updateMany({
          where: { visitId },
          data: {
            totalAmountInPaise: newTotalInPaise,
            ...(nextBillFinancials
              ? {
                  discountAmountInPaise: nextBillFinancials.discountAmountInPaise,
                  paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
                  paymentStatus: nextBillFinancials.paymentStatus,
                }
              : {}),
          },
        });
      }
    },
    { timeout: 30_000 },
  );

  // Immutable audit row — flagged HIGH so the owner ops feed and the anomalies
  // page surface every post-bill add (who, role, bill age, money added).
  await logAction({
    branchId,
    actionType: "UPDATE",
    entityType: "Visit",
    entityId: visitId,
    userId,
    oldValues: {
      action: "ADD_TESTS_TO_BILL",
      totalAmountInPaise: visit.totalAmountInPaise,
      testCount: activeOrders.length,
    },
    newValues: {
      action: "ADD_TESTS_TO_BILL",
      severity: "HIGH",
      billNumber: visit.billNumber,
      patientId: visit.patientId,
      addedProductNames: resolved.map((rp) => rp.productName),
      addedAmountInPaise,
      totalAmountInPaise: newTotalInPaise,
      billAgeDays,
      addedByRole: userRole,
      note: note ?? null,
    },
  });

  // The added tests earn the referrer commission, so refresh any covering run.
  if (currentReferral?.referralDoctorId) {
    await refreshCoveringReferralPayouts(
      currentReferral.referralDoctorId,
      branchId,
      anchorDate,
    );
  }

  return {
    addedProductNames: resolved.map((rp) => rp.productName),
    addedAmountInPaise,
    newTotalInPaise,
    billAgeDays,
  };
}
