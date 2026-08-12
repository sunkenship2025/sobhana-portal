import { Router } from "express";
import QRCode from "qrcode";
import {
  DUPLICATE_VISIT_WINDOW_MS,
  DuplicateVisitError,
  duplicateVisitLockId,
} from "../lib/duplicateGuard";
import {
  BillDiscountType,
  DiagnosticWorkflowMode,
  MessageChannel,
  MessageStatus,
  ReportStatus,
  VisitStatus,
} from "@prisma/client";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { branchContextMiddleware } from "../middleware/branch";
import { requireRole } from "../middleware/rbac";
import { emitWorklistOnMutation } from "../lib/displayEvents";
import { generateDiagnosticBillNumber } from "../services/numberService";
import { logAction } from "../services/auditService";
import {
  evaluateDerivedTargets,
  normalizeDependencyCodes,
  type DerivedFormulaTarget,
} from "../services/derivedParameterService";
import { resolveReferenceRanges } from "../services/referenceRangeService";
import {
  createAccessToken,
  recordAccessByReportVersionId,
} from "../services/reportAccessService";
import {
  buildEphemeralSnapshot,
  createReportSnapshot,
  getReportSnapshot,
  saveReportSnapshot,
} from "../services/reportSnapshotService";
import {
  resolveProducts,
  ProductResolutionError,
} from "../services/productOrderService";
import { renderReportHtml } from "../services/reportRendererService";
import { generateMergedReportPdf } from "../services/mergedReportPdfService";
import prisma from "../lib/prisma";
import { searchWorklist } from "../lib/worklistSearch";
import {
  getWorklistIndex,
  setWorklistIndex,
} from "../lib/worklistIndexCache";
import {
  changeVisitReferral,
  swapVisitProduct,
  addProductsToVisit,
  CorrectionError,
} from "../services/visitCorrectionService";
import { buildDiagnosticBillItems } from "../services/billItemService";
import {
  deriveDiagnosticVisitComposition,
  isPureBillOnlyVisit,
} from "../services/diagnosticWorkflowService";
import {
  areReferralPayoutsEqual,
  distributeFixedAmountInPaise,
  normalizeReferralOverrideInput,
  resolveLabCostSnapshot,
  resolveReducedReferralSnapshot,
  type NormalizedReferralPayout,
} from "../services/referralPayoutService";
import { derivePayout } from "../services/payoutService";
import { categorize } from "../services/payoutCategorize";
import {
  allocateBillDiscountAcrossOrders,
  buildBillFinancialResponse,
  collectBillDue,
  computeBillFinancialsFromPersisted,
  normalizeBillFinancialInput,
  paymentBreakdownFromTransactions,
  recomputeBillFinancialsForSubtotal,
} from "../services/billFinancialService";

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);
// ...and every successful write wakes the other tabs' worklists (see displayEvents).
router.use(emitWorklistOnMutation);

type PayoutSnapshot = {
  commissionType: "PERCENTAGE" | "FIXED_AMOUNT";
  commissionPercentage: number | null;
  commissionAmountInPaise: number | null;
};

type OptionalPayoutSnapshot = {
  commissionType: "PERCENTAGE" | "FIXED_AMOUNT" | null;
  commissionPercentage: number | null;
  commissionAmountInPaise: number | null;
};

type ResolvedNumericRange = {
  referenceMin: number | null;
  referenceMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
};

type LatestDefinitionFormula = {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  formulaExpression: string | null;
  dependsOnCodes: unknown;
  rootDefinitionId: string;
};

const DERIVED_MANUAL_OVERRIDE_NOTE = "__DERIVED_MANUAL_OVERRIDE__";
const DERIVED_AUTO_NOTE_PREFIX = "Auto-calculated: ";

function zeroPayoutSnapshot(): PayoutSnapshot {
  return {
    commissionType: "PERCENTAGE",
    commissionPercentage: 0,
    commissionAmountInPaise: null,
  };
}

function emptyOptionalPayoutSnapshot(): OptionalPayoutSnapshot {
  return {
    commissionType: null,
    commissionPercentage: null,
    commissionAmountInPaise: null,
  };
}

function buildDerivedMetadata(
  formula: string | null | undefined,
  dependsOnCodesRaw: unknown,
): {
  isDerived: boolean;
  formulaExpression: string | null;
  dependsOnCodes: string[] | null;
} {
  const formulaExpression = formula?.trim() || null;
  const dependsOnCodes = normalizeDependencyCodes(dependsOnCodesRaw);

  if (!formulaExpression || dependsOnCodes.length === 0) {
    return {
      isDerived: false,
      formulaExpression: null,
      dependsOnCodes: null,
    };
  }

  return {
    isDerived: true,
    formulaExpression,
    dependsOnCodes,
  };
}

/**
 * When multiple TestOrders share the same productId but only some of them
 * resolved to a panel, propagate that panel to the orders without one.
 * This handles mis-configured ClinicalPanelItem / PanelTestItem mappings
 * while staying safe for bundle products that legitimately contain tests
 * from different panels.
 */
function propagatePanelByProductId<
  T extends {
    productId: string | null;
    panel: { id: string } | null;
  }
>(orders: T[]): T[] {
  // Collect distinct panel ids per productId
  const panelIdsByProduct = new Map<string, Set<string>>();
  for (const order of orders) {
    if (!order.productId || !order.panel?.id) continue;
    const set = panelIdsByProduct.get(order.productId) ?? new Set<string>();
    set.add(order.panel.id);
    panelIdsByProduct.set(order.productId, set);
  }

  // Only propagate when every resolved panel for a productId is the SAME panel.
  const panelByProductId = new Map<string, T["panel"]>();
  for (const [productId, panelIds] of panelIdsByProduct) {
    if (panelIds.size !== 1) continue;
    const targetId = Array.from(panelIds)[0];
    const representative = orders.find(
      (o) => o.productId === productId && o.panel?.id === targetId
    );
    if (representative?.panel) {
      panelByProductId.set(productId, representative.panel);
    }
  }

  // Apply propagation (shallow copy so mutations on one order don't leak)
  for (const order of orders) {
    if (order.productId && !order.panel) {
      const propagated = panelByProductId.get(order.productId);
      if (propagated) {
        order.panel = { ...propagated };
      }
    }
  }

  return orders;
}

function determineResultFlag(
  numValue: number,
  range: ResolvedNumericRange,
): "CRITICAL_HIGH" | "CRITICAL_LOW" | "HIGH" | "LOW" | "NORMAL" | null {
  if (range.criticalMax !== null && numValue > range.criticalMax) {
    return "CRITICAL_HIGH";
  }
  if (range.criticalMin !== null && numValue < range.criticalMin) {
    return "CRITICAL_LOW";
  }
  if (range.referenceMax !== null && numValue > range.referenceMax) {
    return "HIGH";
  }
  if (range.referenceMin !== null && numValue < range.referenceMin) {
    return "LOW";
  }
  if (range.referenceMin !== null || range.referenceMax !== null) {
    return "NORMAL";
  }
  return null;
}

function isManualDerivedOverrideNote(
  notes: string | null | undefined,
): boolean {
  return notes?.trim() === DERIVED_MANUAL_OVERRIDE_NOTE;
}

function hasMeaningfulResultRow(result: {
  value?: number | null;
  textValue?: string | null;
  notes?: string | null;
}): boolean {
  if (result.value !== null && result.value !== undefined) {
    return true;
  }

  if (typeof result.textValue === "string" && result.textValue.trim()) {
    return true;
  }

  const notes = result.notes?.trim();
  if (!notes) {
    return false;
  }

  return (
    notes !== DERIVED_MANUAL_OVERRIDE_NOTE &&
    !notes.startsWith(DERIVED_AUTO_NOTE_PREFIX)
  );
}

/**
 * Collect every testOrderId referenced anywhere in a finalized report snapshot
 * (panels / external-upload sections). This is the authoritative "what actually
 * shipped in this report" signal. TestResult.reportVersionId is NOT reliable for
 * this: a partial release scopes its rendered snapshot to the selected orders,
 * but can still leave a deliberately held-back test's result row tagged to the
 * finalized version (via carry-forward / version assignment). So a test can have
 * reportVersionId === a FINALIZED version yet never have appeared in that report.
 */
function collectSnapshotTestOrderIds(node: unknown, acc: Set<string>): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectSnapshotTestOrderIds(item, acc);
    return;
  }
  if (typeof node === "object") {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      if (key === "testOrderId" && typeof val === "string") {
        acc.add(val);
      } else {
        collectSnapshotTestOrderIds(val, acc);
      }
    }
  }
}

function getExpectedResultTestIds(order: {
  testId: string;
  test?: {
    isPanel?: boolean | null;
    childTests?: Array<{ id: string }> | null;
  } | null;
}): string[] {
  if (order.test?.isPanel && order.test.childTests?.length) {
    return order.test.childTests.map((child) => child.id);
  }

  return [order.testId];
}

function dedupeResultRows<T extends { testOrderId: string; testId: string; createdAt?: Date | string | null; id?: string }>(
  rows: T[],
): T[] {
  const byOrderAndTest = new Map<string, T>();

  for (const row of rows) {
    const key = `${row.testOrderId}:${row.testId}`;
    const existing = byOrderAndTest.get(key);
    if (!existing) {
      byOrderAndTest.set(key, row);
      continue;
    }

    const rowTime = row.createdAt ? new Date(row.createdAt).getTime() : 0;
    const existingTime = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
    if (
      rowTime > existingTime ||
      (rowTime === existingTime && String(row.id ?? "") > String(existing.id ?? ""))
    ) {
      byOrderAndTest.set(key, row);
    }
  }

  return Array.from(byOrderAndTest.values());
}

type TestInputConfigPayload = {
  inputType: 'NUMERIC' | 'FREE_TEXT' | 'TEXT_WITH_PRESETS' | 'SELECT_ONLY';
  defaultValue: string | null;
  valueOptions: string[];
};

const DEFAULT_INPUT_CONFIG: TestInputConfigPayload = {
  inputType: 'NUMERIC',
  defaultValue: null,
  valueOptions: [],
};

function normalizeInputConfig(row: {
  inputType: string;
  defaultValue: string | null;
  valueOptions: any;
} | null | undefined): TestInputConfigPayload {
  if (!row) return DEFAULT_INPUT_CONFIG;
  const opts = Array.isArray(row.valueOptions)
    ? row.valueOptions.filter((v: any): v is string => typeof v === 'string')
    : [];
  return {
    inputType: row.inputType as TestInputConfigPayload['inputType'],
    defaultValue: row.defaultValue ?? null,
    valueOptions: opts,
  };
}

/**
 * Bulk-fetch entry-time UI configs for the given rootDefinitionIds.
 * Returns Map<rootDefinitionId, TestInputConfigPayload>.
 * rootDefinitionIds without a row in TestInputConfig are simply absent from the map.
 */
async function loadInputConfigsByRootId(
  rootIds: Iterable<string>,
): Promise<Map<string, TestInputConfigPayload>> {
  const unique = [...new Set([...rootIds].filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await prisma.testInputConfig.findMany({
    where: { rootDefinitionId: { in: unique } },
  });
  return new Map(rows.map((row) => [row.rootDefinitionId, normalizeInputConfig(row)]));
}

async function loadLatestDefinitionFormulasByCode(
  codes: Iterable<string>,
): Promise<Map<string, LatestDefinitionFormula>> {
  const uniqueCodes = [
    ...new Set(
      Array.from(codes)
        .map((code) => code.trim())
        .filter(Boolean),
    ),
  ];
  if (uniqueCodes.length === 0) {
    return new Map();
  }

  const definitions = await prisma.testDefinition.findMany({
    where: {
      code: { in: uniqueCodes },
      isLatest: true,
    },
    select: {
      id: true,
      code: true,
      name: true,
      displayOrder: true,
      formulaExpression: true,
      dependsOnCodes: true,
      rootDefinitionId: true,
    },
  });

  return new Map(
    definitions.map((definition) => [definition.code, definition]),
  );
}

function applyReferralRuleToPrices(
  pricesInPaise: number[],
  rule: NormalizedReferralPayout | null,
): PayoutSnapshot[] {
  if (!rule) {
    return pricesInPaise.map(() => zeroPayoutSnapshot());
  }

  if (rule.commissionType === "FIXED_AMOUNT") {
    const distributed = distributeFixedAmountInPaise(
      rule.commissionAmountInPaise ?? 0,
      pricesInPaise,
    );

    return distributed.map((commissionAmountInPaise) => ({
      commissionType: "FIXED_AMOUNT",
      commissionPercentage: null,
      commissionAmountInPaise,
    }));
  }

  return pricesInPaise.map(() => ({
    commissionType: "PERCENTAGE",
    commissionPercentage: rule.commissionPercent ?? 0,
    commissionAmountInPaise: null,
  }));
}

function applyOptionalReferralRuleToPrices(
  pricesInPaise: number[],
  rule: NormalizedReferralPayout | null,
): OptionalPayoutSnapshot[] {
  if (!rule) {
    return pricesInPaise.map(() => emptyOptionalPayoutSnapshot());
  }

  return applyReferralRuleToPrices(pricesInPaise, rule).map((snapshot) => ({
    commissionType: snapshot.commissionType,
    commissionPercentage: snapshot.commissionPercentage,
    commissionAmountInPaise: snapshot.commissionAmountInPaise,
  }));
}

async function loadFinalizedReportSnapshotForVisit(visitId: string) {
  const visit = await prisma.visit.findFirst({
    where: {
      id: visitId,
      domain: "DIAGNOSTICS",
    },
    select: {
      billNumber: true,
      report: {
        select: {
          versions: {
            where: { status: "FINALIZED" },
            orderBy: { versionNum: "desc" },
            take: 1,
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!visit) {
    return {
      ok: false as const,
      status: 404,
      error: "NOT_FOUND",
      message: "Diagnostic visit not found",
    };
  }

  const reportVersionId = visit.report?.versions?.[0]?.id;
  if (!reportVersionId) {
    return {
      ok: false as const,
      status: 404,
      error: "REPORT_NOT_FOUND",
      message: "Finalized report not found",
    };
  }

  const snapshot = await getReportSnapshot(reportVersionId);
  if (!snapshot) {
    return {
      ok: false as const,
      status: 404,
      error: "REPORT_NOT_AVAILABLE",
      message: "Finalized report snapshot not found",
    };
  }

  return {
    ok: true as const,
    billNumber: visit.billNumber,
    reportVersionId,
    snapshot,
  };
}

function getVisitComposition<
  T extends { workflowMode?: DiagnosticWorkflowMode | null },
>(
  orders: T[],
  visitStatus: VisitStatus | string,
  versions: Array<{ status?: ReportStatus | null }> = [],
) {
  return deriveDiagnosticVisitComposition(orders, visitStatus, versions);
}

function getReportableOrders<
  T extends {
    workflowMode?: DiagnosticWorkflowMode | null;
    cancelledAt?: Date | string | null;
    noReportAt?: Date | string | null;
  },
>(orders: T[]): T[] {
  return orders.filter(
    (order) =>
      !order.cancelledAt &&
      !order.noReportAt &&
      (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
        DiagnosticWorkflowMode.REPORTABLE,
  );
}

/** Orders that contribute to the patient-facing report (REPORTABLE or EXTERNAL_UPLOAD). */
function getReportInclusionOrders<
  T extends {
    workflowMode?: DiagnosticWorkflowMode | null;
    cancelledAt?: Date | string | null;
    noReportAt?: Date | string | null;
  },
>(orders: T[]): T[] {
  return orders.filter(
    (order) =>
      !order.cancelledAt &&
      !order.noReportAt &&
      ((order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
        DiagnosticWorkflowMode.REPORTABLE ||
        order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD),
  );
}

/**
 * Auto-complete a diagnostic visit whose report workflow is fully resolved.
 *
 * When the LAST reportable/external order on an open (DRAFT/WAITING) visit is
 * closed as "no report needed" (films-only) or cancelled, there is nothing left
 * to enter or finalize — the visit is done. Historically only the owner-only
 * "finalize all-waived" button flipped such a visit to COMPLETED, so a visit
 * whose last order was closed by front-desk staff stranded in DRAFT: invisible
 * in Pending (nothing to enter) AND in Finalized (not COMPLETED). This helper
 * closes that gap by re-deriving completion after each no-report / cancel action.
 *
 * Fires ONLY when getReportInclusionOrders() is empty AND at least one order was
 * resolved via noReportAt/cancelledAt — so a genuinely-awaiting-upload or
 * mid-entry visit is never wrongly completed, and a pure bill-only visit (which
 * is already COMPLETED at billing) is untouched.
 *
 * Money-neutral: a films-only close still earns the referrer their commission
 * (payouts re-derived, exactly like the finalize-waived path), and an
 * outstanding bill due is NOT waived — it stays on the bill, still collectible,
 * and the visit becomes visible so it can actually be chased. Deliberately sends
 * NO WhatsApp: a films-only visit issues no patient-facing report.
 *
 * Idempotent + race-safe: re-reads fresh state and flips via an updateMany
 * guarded on status IN (DRAFT,WAITING), so a double-close / concurrent action
 * completes the visit at most once.
 */
async function reevaluateVisitCompletion(
  visitId: string,
  actor: {
    userId?: string | null;
    branchId: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<{ completed: boolean }> {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    select: {
      id: true,
      status: true,
      branchId: true,
      testOrders: {
        select: {
          id: true,
          workflowMode: true,
          cancelledAt: true,
          noReportAt: true,
        },
      },
      referrals: {
        where: { deletedAt: null },
        select: { referralDoctorId: true },
      },
      diagnosticCenterReferrals: {
        select: { diagnosticCenterId: true },
      },
    },
  });

  if (!visit) return { completed: false };
  // Only an open visit can auto-complete. COMPLETED/CANCELLED are terminal;
  // the cancel path already sets CANCELLED when every order is voided.
  if (visit.status !== "DRAFT" && visit.status !== "WAITING") {
    return { completed: false };
  }
  // Something still reportable → leave the visit open for result entry.
  if (getReportInclusionOrders(visit.testOrders).length > 0) {
    return { completed: false };
  }
  // Only complete when an order was actually resolved down to nothing (films-only
  // or cancelled). Never auto-complete a visit that merely lacks reportable
  // orders — pure bill-only visits are COMPLETED at billing, not here.
  const someResolved = visit.testOrders.some(
    (o) => o.noReportAt || o.cancelledAt,
  );
  if (!someResolved) return { completed: false };

  const completedAt = new Date();
  // Race-safe flip: only if still open. A concurrent close/cancel that already
  // completed this visit matches 0 rows here, so we complete at most once.
  const flipped = await prisma.visit.updateMany({
    where: { id: visit.id, status: { in: ["DRAFT", "WAITING"] } },
    data: { status: "COMPLETED" },
  });
  if (flipped.count !== 1) return { completed: false };

  await logAction({
    branchId: actor.branchId,
    actionType: "FINALIZE",
    entityType: "Visit",
    entityId: visit.id,
    userId: actor.userId ?? undefined,
    newValues: {
      status: "COMPLETED",
      noReport: true,
      autoCompleted: true,
      completedAt: completedAt.toISOString(),
      resolvedOrderIds: visit.testOrders
        .filter((o) => o.noReportAt || o.cancelledAt)
        .map((o) => o.id),
    },
    ipAddress: actor.ip,
    userAgent: actor.userAgent,
  });

  // Referrer / centre still earns on a films-only test — re-derive payouts
  // exactly like the finalize-waived path (this close is money-neutral).
  const periodStartDate = new Date(completedAt);
  periodStartDate.setHours(0, 0, 0, 0);
  const periodEndDate = new Date(completedAt);
  periodEndDate.setHours(23, 59, 59, 999);
  const payoutTasks: Array<Promise<unknown>> = [];
  const referralDoctorId = visit.referrals[0]?.referralDoctorId;
  const diagnosticCenterId =
    visit.diagnosticCenterReferrals[0]?.diagnosticCenterId;
  if (referralDoctorId) {
    payoutTasks.push(
      derivePayout(
        "REFERRAL",
        referralDoctorId,
        visit.branchId,
        periodStartDate,
        periodEndDate,
      ),
    );
  }
  if (diagnosticCenterId) {
    payoutTasks.push(
      derivePayout(
        "DIAGNOSTIC_CENTER",
        diagnosticCenterId,
        visit.branchId,
        periodStartDate,
        periodEndDate,
      ),
    );
  }
  if (payoutTasks.length > 0) {
    const settled = await Promise.allSettled(payoutTasks);
    for (const r of settled) {
      if (r.status === "rejected") {
        console.error(
          "Auto-refresh payout after visit auto-completion failed:",
          r.reason,
        );
      }
    }
  }

  return { completed: true };
}

// GET /api/visits/diagnostic - List diagnostic visits
// When patientId is provided: Returns ALL visits for that patient across ALL branches (Patient 360 view)
// COMPLETED visits accumulate forever (unlike DRAFT/WAITING, which clear out
// as they resolve), so an unbounded status=COMPLETED fetch grows with the
// branch's whole history — the cause of the Jul 2026 OOM restarts (see
// project_oom_remediation_2026_07 memory). The Finalized worklist paginates
// server-side; the expensive part is computing the ordered candidate set, so
// we do it once (a LIGHT scan of only the fields the filter/sort/search need),
// cache the ordered IDs (see worklistIndexCache), and hydrate only the page's
// ~20 rows with the heavy includes. `from` bounds the light scan to the
// worklist's selected date range (90-day default). SCAN_CAP is a hard backstop
// on the light scan itself.
const COMPLETED_INDEX_SCAN_CAP = 2000;

/**
 * Phase 1 for the Finalized diagnostics worklist: the ordered, filtered,
 * ranked list of visit IDs (+ total), cached ~45s per (branch, from, q).
 * Filtering reuses deriveDiagnosticVisitComposition (via getVisitComposition)
 * so the "finalized report OR nothing to report" semantics are identical to
 * the heavy path — no risk of a divergent WHERE hiding visits.
 */
async function computeCompletedDiagnosticIndex(
  branchId: string,
  from: string | undefined,
  to: string | undefined,
  q: string,
): Promise<{ ids: string[]; total: number }> {
  const qNorm = q.trim().toLowerCase();
  const cacheKey = `diag|${branchId}|${from ?? "90d"}|${to ?? ""}|${qNorm}`;
  const cached = getWorklistIndex(cacheKey);
  if (cached) return cached;

  const fromDate = from
    ? new Date(`${from}T00:00:00`)
    : new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

  const where: any = { domain: "DIAGNOSTICS", branchId, status: "COMPLETED" };
  // The DB scan bounds on updatedAt (lower only): it keeps advancing after
  // finalize (mark-printed, WhatsApp resend), so it's a cheap SUPERSET of the
  // in-window rows — a row's stable date is always <= its updatedAt. We tighten
  // to the real window on that stable date below.
  if (!isNaN(fromDate.getTime())) where.updatedAt = { gte: fromDate };

  // Visible-set window on the row's STABLE date (finalized/bill time — the same
  // date the row shows and sorts by). Without this, a report finalized on an
  // earlier day but re-touched today (reprint/resend bumps updatedAt) leaks into
  // "Today". Only applied when `from` is explicit — the "all"/90d default keeps
  // the recently-active superset.
  const stableFromMs = from ? fromDate.getTime() : null;
  const stableToMs = to ? new Date(`${to}T23:59:59.999`).getTime() : null;

  const light = await prisma.visit.findMany({
    where,
    take: COMPLETED_INDEX_SCAN_CAP,
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      billNumber: true,
      updatedAt: true,
      createdAt: true,
      bill: { select: { billedAt: true, createdAt: true } },
      patient: {
        select: { name: true, identifiers: { select: { type: true, value: true } } },
      },
      testOrders: {
        select: { workflowMode: true, cancelledAt: true, noReportAt: true },
      },
      report: {
        select: {
          versions: {
            orderBy: { versionNum: "desc" },
            take: 1,
            select: { status: true, finalizedAt: true },
          },
        },
      },
    },
  });

  if (light.length >= COMPLETED_INDEX_SCAN_CAP) {
    console.warn(
      `[worklist] diagnostic COMPLETED index hit scan cap (${COMPLETED_INDEX_SCAN_CAP}) for branch ${branchId}; oldest in-window rows may be omitted — narrow the date range or raise the cap.`,
    );
  }

  const rows = light.map((v) => {
    const currentVersion = v.report?.versions[0] ?? null;
    const comp = getVisitComposition(
      v.testOrders,
      "COMPLETED",
      currentVersion ? [currentVersion] : [],
    );
    // Match the heavy path's row date: finalized-report time first, else the
    // bill time, else the visit's own timestamps.
    const reportFinalizedAt =
      currentVersion?.status === "FINALIZED" ? currentVersion.finalizedAt : null;
    const sortSource =
      reportFinalizedAt ??
      v.bill?.billedAt ??
      v.bill?.createdAt ??
      v.updatedAt ??
      v.createdAt;
    return {
      id: v.id,
      // Same completeness rule the client used to apply post-fetch: a finalized
      // report, or nothing to report (pure bill-only / films-only).
      keep: comp.hasFinalizedReport || !comp.hasReportInclusionOrders,
      sortMs: sortSource ? new Date(sortSource).getTime() : 0,
      name: v.patient?.name ?? null,
      phone:
        v.patient?.identifiers?.find((i) => i.type === "PHONE")?.value ?? null,
      billNumber: v.billNumber ?? null,
    };
  });

  let ordered = rows.filter(
    (r) =>
      r.keep &&
      (stableFromMs == null || r.sortMs >= stableFromMs) &&
      (stableToMs == null || r.sortMs <= stableToMs),
  );
  // Finalized-time desc (restores the long-standing client sort). searchWorklist
  // is stable, so applying it after the date sort keeps date-desc within a rank
  // tier while floating exact/prefix name matches to the top.
  ordered.sort((a, b) => b.sortMs - a.sortMs);
  if (qNorm) {
    ordered = searchWorklist(ordered, q, (r) => ({
      name: r.name,
      phone: r.phone,
      billNumber: r.billNumber,
    }));
  }

  const ids = ordered.map((r) => r.id);
  setWorklistIndex(cacheKey, ids, ids.length);
  return { ids, total: ids.length };
}

// When patientId is omitted: Returns visits for current branch only (daily operations)
router.get("/", async (req: AuthRequest, res) => {
  try {
    const { status, patientId, from, to, q, page, pageSize } = req.query;

    const where: any = {
      domain: "DIAGNOSTICS",
    };

    // Patient 360 view: Show all visits across branches for specific patient
    // Branch-scoped view: Show only visits in current branch
    if (patientId) {
      where.patientId = patientId;
      // NOTE: No branchId filter when querying by patientId (cross-branch patient history)
    } else {
      where.branchId = req.branchId; // Branch-scoped for list queries
    }

    if (status) {
      where.status = status;
    }

    // Finalized worklist: compute (or reuse a cached) ordered ID index for the
    // whole filtered set, then narrow the heavy fetch below to just this page's
    // ≤20 IDs. Everything else (DRAFT/WAITING, Patient 360) keeps the plain
    // full-array behavior it already expects.
    let paginated:
      | { total: number; page: number; pageSize: number; totalPages: number; order: string[] }
      | null = null;
    if (!patientId && status === "COMPLETED") {
      const qStr = typeof q === "string" ? q : "";
      const { ids, total } = await computeCompletedDiagnosticIndex(
        req.branchId!,
        typeof from === "string" ? from : undefined,
        typeof to === "string" ? to : undefined,
        qStr,
      );
      const pageNum = Math.max(1, parseInt(String(page ?? "1"), 10) || 1);
      const size = Math.min(
        100,
        Math.max(1, parseInt(String(pageSize ?? "20"), 10) || 20),
      );
      const totalPages = Math.max(1, Math.ceil(total / size));
      const clampedPage = Math.min(pageNum, totalPages);
      const start = (clampedPage - 1) * size;
      const pageIds = ids.slice(start, start + size);
      paginated = { total, page: clampedPage, pageSize: size, totalPages, order: pageIds };
      // Hydrate ONLY this page's rows below.
      delete where.branchId;
      delete where.status;
      where.id = { in: pageIds };
    }

    const visits = await prisma.visit.findMany({
      where,
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        referrals: {
          where: { deletedAt: null },
          include: {
            referralDoctor: true,
          },
        },
        testOrders: {
          include: {
            // Worklist reads only the test's name/code + reference range; select
            // those so the full LabTest row isn't loaded/serialised per order.
            test: {
              select: {
                name: true,
                code: true,
                referenceMin: true,
                referenceMax: true,
                referenceUnit: true,
              },
            },
            product: { select: { name: true } },
            // Surface per-test readiness on the worklist: an external-upload
            // order is "ready" once a (non-deleted) upload exists.
            externalUploads: {
              where: { deletedAt: null },
              select: { id: true },
              take: 1,
            },
          },
        },
        bill: { include: { transactions: true } },
        report: {
          include: {
            versions: {
              orderBy: { versionNum: "desc" },
              take: 1,
              // The list needs only status/version/finalizedAt + the latest
              // version's result rows (to count done vs pending). Select these
              // EXPLICITLY so the heavy frozen snapshots (panelsSnapshot /
              // visitSnapshot / signaturesSnapshot / …) are never loaded into
              // memory or serialised — they bloated the worklist payload to
              // ~8MB and drove the 512MB OOM restarts.
              select: {
                id: true,
                status: true,
                versionNum: true,
                finalizedAt: true,
                testResults: {
                  select: {
                    testOrderId: true,
                    value: true,
                    textValue: true,
                    notes: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // WhatsApp delivery signal for the Finalized page: has a REPORT / BILL
    // notification actually gone out for each visit? Drives the green "Sent"
    // affordance. Only count messages that left the building (SENT/DELIVERED/
    // READ) — a PENDING/FAILED row isn't a send. Latest wins per context.
    const listVisitIds = visits.map((v) => v.id);
    const sentMessages = listVisitIds.length
      ? await prisma.messageLog.findMany({
          where: {
            contextId: { in: listVisitIds },
            channel: MessageChannel.WHATSAPP,
            status: {
              in: [
                MessageStatus.SENT,
                MessageStatus.DELIVERED,
                MessageStatus.READ,
              ],
            },
          },
          orderBy: { createdAt: "desc" },
          select: {
            contextId: true,
            contextType: true,
            sentAt: true,
            createdAt: true,
          },
        })
      : [];
    const reportSentAtByVisit = new Map<string, Date>();
    const billSentAtByVisit = new Map<string, Date>();
    for (const m of sentMessages) {
      const at = m.sentAt ?? m.createdAt;
      if (m.contextType === "REPORT" && !reportSentAtByVisit.has(m.contextId)) {
        reportSentAtByVisit.set(m.contextId, at);
      } else if (
        m.contextType === "BILL" &&
        !billSentAtByVisit.has(m.contextId)
      ) {
        billSentAtByVisit.set(m.contextId, at);
      }
    }

    // Resolve panel membership for every test order so list views can show
    // panel names ("HEMOGRAM") instead of long lists of constituent test
    // codes ("HB, PCV, RBC, ..."). Two arches coexist: lab tests resolve via
    // PanelTestItem (by testId), new-arch resolves via ClinicalPanelItem
    // (by testDefinitionId). Bulk-fetch both keyed maps before transform.
    const allTestIds = new Set<string>();
    const allTestDefinitionIds = new Set<string>();
    for (const v of visits) {
      for (const to of v.testOrders) {
        if (to.testId) allTestIds.add(to.testId);
        if (to.testDefinitionId) allTestDefinitionIds.add(to.testDefinitionId);
      }
    }

    const labPanelItems = allTestIds.size
      ? await prisma.panelTestItem.findMany({
          where: { testId: { in: Array.from(allTestIds) } },
          orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
          select: {
            testId: true,
            panel: {
              select: { id: true, name: true, displayName: true },
            },
          },
        })
      : [];
    const labPanelByTestId = new Map<
      string,
      { id: string; name: string; displayName: string }
    >();
    for (const item of labPanelItems) {
      if (!labPanelByTestId.has(item.testId)) {
        labPanelByTestId.set(item.testId, item.panel);
      }
    }

    // Match panel membership by rootDefinitionId so orders referencing an
    // older TestDefinition version (panel re-saves re-point items at the
    // latest version) still resolve their panel name.
    const orderedDefinitions = allTestDefinitionIds.size
      ? await prisma.testDefinition.findMany({
          where: { id: { in: Array.from(allTestDefinitionIds) } },
          select: { id: true, rootDefinitionId: true },
        })
      : [];
    const rootIdByDefinitionId = new Map(
      orderedDefinitions.map((def) => [def.id, def.rootDefinitionId]),
    );
    const clinicalPanelItems = orderedDefinitions.length
      ? await prisma.clinicalPanelItem.findMany({
          where: {
            testDefinition: {
              rootDefinitionId: {
                in: [...new Set(orderedDefinitions.map((def) => def.rootDefinitionId))],
              },
            },
          },
          orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
          select: {
            testDefinitionId: true,
            testDefinition: { select: { rootDefinitionId: true } },
            panel: {
              select: { id: true, name: true, displayName: true },
            },
          },
        })
      : [];
    const clinicalPanelByRootId = new Map<
      string,
      { id: string; name: string; displayName: string }
    >();
    for (const item of clinicalPanelItems) {
      const rootId = item.testDefinition.rootDefinitionId;
      if (!clinicalPanelByRootId.has(rootId)) {
        clinicalPanelByRootId.set(rootId, item.panel);
      }
    }
    const clinicalPanelByDefinitionId = new Map<
      string,
      { id: string; name: string; displayName: string }
    >();
    for (const [defId, rootId] of rootIdByDefinitionId) {
      const panel = clinicalPanelByRootId.get(rootId);
      if (panel) clinicalPanelByDefinitionId.set(defId, panel);
    }

    // Transform to frontend format
    const transformed = visits.map((v) => {
      const currentVersion = v.report?.versions[0] || null;
      const composition = getVisitComposition(
        v.testOrders,
        v.status,
        currentVersion ? [currentVersion] : [],
      );
      const billFinancials = buildBillFinancialResponse(v.bill);

      // Per-test done/pending for the "Pending Results" worklist. A report-
      // inclusion order is "ready" when it has a meaningful result row in the
      // latest (draft) version, or — for external uploads — a saved upload.
      // Mirrors the release-partial handler's readiness logic.
      const reportInclusionOrders = getReportInclusionOrders(v.testOrders);
      const draftResultOrderIds = new Set(
        (currentVersion?.testResults ?? [])
          .filter(hasMeaningfulResultRow)
          .map((r) => r.testOrderId),
      );
      const readyExternalUploadOrderIds = new Set(
        v.testOrders
          .filter(
            (o) =>
              o.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD &&
              o.externalUploads.length > 0,
          )
          .map((o) => o.id),
      );
      const reportInclusionOrderIds = new Set(
        reportInclusionOrders.map((o) => o.id),
      );
      const readyOrderIds = new Set(
        reportInclusionOrders
          .filter(
            (o) =>
              draftResultOrderIds.has(o.id) ||
              readyExternalUploadOrderIds.has(o.id),
          )
          .map((o) => o.id),
      );
      const reportInclusionCount = reportInclusionOrders.length;
      const readyReportInclusionCount = readyOrderIds.size;
      const pendingReportInclusionCount =
        reportInclusionCount - readyReportInclusionCount;
      // A partial report has already been dispatched when the current draft is
      // a carry-forward version (versionNum > 1) and the visit isn't finished.
      const hasPartialReport =
        currentVersion?.status === "DRAFT" &&
        (currentVersion.versionNum ?? 1) > 1 &&
        v.status !== "COMPLETED";

      return {
        id: v.id,
        branchId: v.branchId,
        billNumber: v.billNumber,
        patientId: v.patientId,
        patient: v.patient,
        domain: v.domain,
        status: v.status,
        totalAmount: v.totalAmountInPaise / 100,
        paymentType:
          Array.isArray((v as any).bill?.transactions) &&
          (v as any).bill.transactions.length > 0
            ? Array.from(
                new Set(
                  (v as any).bill.transactions.map((t: any) => t.paymentType),
                ),
              ).join(", ")
            : null,
        // Per-mode collected amounts so the worklists can show a split
        // ("Cash ₹300 + Online ₹200"), not just the joined mode names.
        paymentBreakdown: paymentBreakdownFromTransactions(
          (v as any).bill?.transactions,
        ),
        paymentStatus: v.bill?.paymentStatus || "PENDING",
        ...billFinancials,
        billedAt: v.bill?.billedAt || v.bill?.createdAt || null,
        reportFinalizedAt:
          currentVersion?.status === "FINALIZED"
            ? currentVersion.finalizedAt
            : null,
        // Finalized-page "Printed" / "Sent" signals (green affordances).
        billPrintedAt: v.billPrintedAt,
        reportPrintedAt: v.reportPrintedAt,
        billWhatsappSentAt: billSentAtByVisit.get(v.id) ?? null,
        reportWhatsappSentAt: reportSentAtByVisit.get(v.id) ?? null,
        hasReportableOrders: composition.hasReportableOrders,
        hasBillOnlyOrders: composition.hasBillOnlyOrders,
        hasExternalUploadOrders: composition.hasExternalUploadOrders,
        hasReportInclusionOrders: composition.hasReportInclusionOrders,
        hasEntryScreenOrders: composition.hasEntryScreenOrders,
        hasFinalizedReport: composition.hasFinalizedReport,
        nextAction: composition.nextAction,
        reportInclusionCount,
        readyReportInclusionCount,
        pendingReportInclusionCount,
        hasPartialReport,
        referralDoctorId: v.referrals[0]?.referralDoctorId || null,
        referralDoctor: v.referrals[0]?.referralDoctor || null,
        testOrders: (() => {
          const orders = v.testOrders.map((to) => {
            const panel =
              (to.testDefinitionId
                ? clinicalPanelByDefinitionId.get(to.testDefinitionId)
                : undefined) ?? labPanelByTestId.get(to.testId) ?? null;
            return {
              id: to.id,
              visitId: to.visitId,
              testId: to.testId,
              productId: to.productId,
              productName: to.product?.name ?? null,
              testDefinitionId: to.testDefinitionId,
              workflowMode: to.workflowMode,
              // null for bill-only orders (not part of the report); true/false
              // for report-inclusion orders based on whether results are in.
              resultReady: reportInclusionOrderIds.has(to.id)
                ? readyOrderIds.has(to.id)
                : null,
              // E3-03: Use snapshotted metadata (fallback to live data for backward compatibility)
              testName: to.testNameSnapshot || to.test.name,
              testCode: to.testCodeSnapshot || to.test.code,
              price: to.priceInPaise / 100,
              priceInPaise: to.priceInPaise,
              referralCommissionType: to.referralCommissionType,
              referralCommissionPercent: to.referralCommissionPercentage,
              referralCommissionAmountInPaise: to.referralCommissionAmountInPaise,
              referenceRange: {
                min: to.referenceMinSnapshot ?? to.test.referenceMin ?? 0,
                max: to.referenceMaxSnapshot ?? to.test.referenceMax ?? 0,
                unit: to.referenceUnitSnapshot || to.test.referenceUnit || "",
              },
              panel,
            };
          });
          return propagatePanelByProductId(orders);
        })(),
        report: v.report
          ? {
              id: v.report.id,
              // Ship a slim version — the worklist reads only status/version/
              // finalizedAt off it. testResults were used only to compute the
              // done/pending counts above; no need to send the array to the client.
              currentVersion: currentVersion
                ? {
                    id: currentVersion.id,
                    versionNum: currentVersion.versionNum,
                    status: currentVersion.status,
                    finalizedAt: currentVersion.finalizedAt,
                  }
                : null,
            }
          : null,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      };
    });

    // Finalized worklist: return the page in the cached index's order (a
    // findMany with `id: { in: [...] }` doesn't preserve the id order), wrapped
    // in the paginated envelope the client expects. `transformed` here is only
    // this page's ≤20 rows, so their live Printed/Sent/Paid state is fresh.
    if (paginated) {
      const byId = new Map(transformed.map((t) => [t.id, t]));
      const items = paginated.order
        .map((id) => byId.get(id))
        .filter((t): t is (typeof transformed)[number] => Boolean(t));
      return res.json({
        items,
        total: paginated.total,
        page: paginated.page,
        pageSize: paginated.pageSize,
        totalPages: paginated.totalPages,
      });
    }

    return res.json(transformed);
  } catch (err: any) {
    console.error("List diagnostic visits error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to list diagnostic visits",
    });
  }
});

// GET /api/visits/diagnostic/summary — lightweight dashboard counts (no visit rows).
// The staff Dashboard needs only three numbers (pending result-entry, diagnostics
// created "today", finalized "today"); it previously fetched the ENTIRE visit list
// (megabytes) purely to count. This returns the counts directly, reusing the exact
// same composition helper so the numbers can't drift from the old client-side
// computation. "Today" is defined by the CLIENT (its local-day boundaries via
// dayStart/dayEnd) so it matches the UI's isSameLocalDay filter with no timezone
// drift. MUST stay registered before "/:id" so it isn't captured as an id.
router.get("/summary", async (req: AuthRequest, res) => {
  try {
    const { dayStart, dayEnd } = req.query as {
      dayStart?: string;
      dayEnd?: string;
    };
    const branchId = req.branchId;

    const compositionSelect = {
      status: true,
      testOrders: {
        select: { workflowMode: true, cancelledAt: true, noReportAt: true },
      },
      report: {
        select: {
          versions: {
            orderBy: { versionNum: "desc" as const },
            take: 1,
            select: { status: true },
          },
        },
      },
    };

    // Pending result-entry: active (DRAFT/WAITING) visits carrying at least one
    // report-inclusion order. Only the small active set is scanned, and only the
    // minimal fields the composition needs are loaded.
    const activeVisits = await prisma.visit.findMany({
      where: {
        domain: "DIAGNOSTICS",
        branchId,
        status: { in: [VisitStatus.DRAFT, VisitStatus.WAITING] },
      },
      select: compositionSelect,
    });
    let pending = 0;
    for (const v of activeVisits) {
      const comp = getVisitComposition(
        v.testOrders,
        v.status,
        v.report?.versions ?? [],
      );
      // Mirrors the Dashboard predicate exactly (incl. the legacy fallback).
      if (
        comp.hasReportInclusionOrders ??
        (comp.hasReportableOrders || comp.hasExternalUploadOrders)
      ) {
        pending++;
      }
    }

    // "Today" counts, windowed by the client's local day so they match the UI's
    // isSameLocalDay filter. Absent a window, they're 0 (the dashboard always sends it).
    let today = 0;
    let finalizedToday = 0;
    const from = dayStart ? new Date(dayStart) : null;
    const to = dayEnd ? new Date(dayEnd) : null;
    if (from && to && !isNaN(from.getTime()) && !isNaN(to.getTime())) {
      const todaysVisits = await prisma.visit.findMany({
        where: {
          domain: "DIAGNOSTICS",
          branchId,
          createdAt: { gte: from, lt: to },
        },
        select: compositionSelect,
      });
      today = todaysVisits.length;
      finalizedToday = todaysVisits.filter((v) => {
        const comp = getVisitComposition(
          v.testOrders,
          v.status,
          v.report?.versions ?? [],
        );
        return comp.hasFinalizedReport;
      }).length;
    }

    return res.json({ pending, today, finalizedToday });
  } catch (err: any) {
    console.error("Diagnostic summary error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to load diagnostic summary",
    });
  }
});

// GET /api/visits/diagnostic/:id - Get single diagnostic visit
router.get("/:id", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visitBase = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        referrals: {
          where: { deletedAt: null },
          include: {
            referralDoctor: true,
          },
        },
        bill: { include: { transactions: true } },
        report: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!visitBase) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    const reportVersions = visitBase.report
      ? await prisma.reportVersion.findMany({
          where: { reportId: visitBase.report.id },
          orderBy: { versionNum: "desc" },
          select: {
            id: true,
            versionNum: true,
            status: true,
            finalizedAt: true,
          },
        })
      : [];

    const reportResults = reportVersions.length
      ? await prisma.testResult.findMany({
          where: {
            reportVersionId: {
              in: reportVersions.map((version) => version.id),
            },
          },
          orderBy: [{ reportVersionId: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            testOrderId: true,
            testId: true,
            reportVersionId: true,
            value: true,
            textValue: true,
            flag: true,
            notes: true,
            signerNameOverride: true,
            useSigningRule: true,
            // Must travel with useSigningRule: the result-entry screen seeds the
            // radiology signing-doctor dropdown from it. Omitting it made every
            // reload come back with an empty dropdown even though the pick was
            // stored, and left finalize blocked on a choice already made.
            selectedSigningDoctorId: true,
            createdAt: true,
            testDefinitionId: true,
            test: {
              select: {
                id: true,
                name: true,
                code: true,
                referenceMin: true,
                referenceMax: true,
                referenceUnit: true,
                referenceText: true,
              },
            },
          },
        })
      : [];

    const reportResultsByVersionId = new Map<string, typeof reportResults>();
    for (const result of reportResults) {
      const versionResults =
        reportResultsByVersionId.get(result.reportVersionId) ?? [];
      versionResults.push(result);
      reportResultsByVersionId.set(result.reportVersionId, versionResults);
    }

    const rawTestOrders = await prisma.testOrder.findMany({
      where: { visitId: id },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        visitId: true,
        testId: true,
        productId: true,
        testDefinitionId: true,
        workflowMode: true,
        priceInPaise: true,
        referralCommissionType: true,
        referralCommissionPercentage: true,
        referralCommissionAmountInPaise: true,
        referenceMinSnapshot: true,
        referenceMaxSnapshot: true,
        referenceUnitSnapshot: true,
        testNameSnapshot: true,
        testCodeSnapshot: true,
        cancelledAt: true,
        cancelReason: true,
        reversedChargeInPaise: true,
        noReportAt: true,
        noReportReason: true,
        noReportByUser: { select: { name: true } },
        uploadInsteadAt: true,
        uploadInsteadByUser: { select: { name: true } },
        test: {
          select: {
            id: true,
            name: true,
            code: true,
            isPanel: true,
            referenceMin: true,
            referenceMax: true,
            referenceUnit: true,
            referenceText: true,
            department: {
              select: { id: true, name: true, reportHeaderText: true },
            },
            derivedParameter: {
              select: {
                id: true,
                parameterName: true,
                formula: true,
                dependsOnTestCodes: true,
              },
            },
          },
        },
        testDefinition: {
          select: {
            id: true,
            code: true,
            rootDefinitionId: true,
            formulaExpression: true,
            dependsOnCodes: true,
            referenceMin: true,
            referenceMax: true,
            referenceUnit: true,
            referenceText: true,
            department: { select: { id: true, name: true } },
          },
        },
        product: {
          select: {
            id: true,
            name: true,
            code: true,
          },
        },
        testResults: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            testOrderId: true,
            testId: true,
            reportVersionId: true,
            value: true,
            textValue: true,
            flag: true,
            notes: true,
            signerNameOverride: true,
            useSigningRule: true,
            // Must travel with useSigningRule: the result-entry screen seeds the
            // radiology signing-doctor dropdown from it. Omitting it made every
            // reload come back with an empty dropdown even though the pick was
            // stored, and left finalize blocked on a choice already made.
            selectedSigningDoctorId: true,
            createdAt: true,
            testDefinitionId: true,
            test: {
              select: {
                id: true,
                name: true,
                code: true,
                referenceMin: true,
                referenceMax: true,
                referenceUnit: true,
                referenceText: true,
              },
            },
          },
        },
      },
    });

    const panelTestIds = [
      ...new Set(
        rawTestOrders
          .filter((order) => order.test.isPanel)
          .map((order) => order.testId),
      ),
    ];

    const childTests = panelTestIds.length
      ? await prisma.labTest.findMany({
          where: {
            parentTestId: {
              in: panelTestIds,
            },
          },
          orderBy: [
            { parentTestId: "asc" },
            { displayOrder: "asc" },
            { createdAt: "asc" },
          ],
          select: {
            id: true,
            parentTestId: true,
            name: true,
            code: true,
            displayOrder: true,
            referenceMin: true,
            referenceMax: true,
            referenceUnit: true,
            referenceText: true,
            derivedParameter: {
              select: {
                id: true,
                parameterName: true,
                formula: true,
                dependsOnTestCodes: true,
              },
            },
          },
        })
      : [];

    const childTestsByParentId = new Map<string, typeof childTests>();
    for (const childTest of childTests) {
      if (!childTest.parentTestId) {
        continue;
      }
      const siblings = childTestsByParentId.get(childTest.parentTestId) ?? [];
      siblings.push(childTest);
      childTestsByParentId.set(childTest.parentTestId, siblings);
    }

    const labPanelItems = rawTestOrders.length
      ? await prisma.panelTestItem.findMany({
          where: {
            testId: {
              in: [...new Set(rawTestOrders.map((order) => order.testId))],
            },
          },
          orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
          select: {
            testId: true,
            panel: {
              select: {
                id: true,
                name: true,
                displayName: true,
                layoutType: true,
                department: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        })
      : [];

    const productIds = [
      ...new Set(
        rawTestOrders
          .map((order) => order.productId)
          .filter((productId): productId is string => Boolean(productId)),
      ),
    ];
    const productPanels = productIds.length
      ? await prisma.billableProductPanel.findMany({
          where: {
            productId: { in: productIds },
            panelId: { not: null },
          },
          select: { productId: true, panelId: true },
        })
      : [];
    const productPanelSet = new Map<string, Set<string>>();
    for (const pp of productPanels) {
      if (!pp.panelId) continue;
      const set = productPanelSet.get(pp.productId) || new Set();
      set.add(pp.panelId);
      productPanelSet.set(pp.productId, set);
    }

    const labPanelItemsByTestId = new Map<string, typeof labPanelItems>();
    for (const panelItem of labPanelItems) {
      const list = labPanelItemsByTestId.get(panelItem.testId) || [];
      list.push(panelItem);
      labPanelItemsByTestId.set(panelItem.testId, list);
    }

    // Panel membership is matched via rootDefinitionId (not exact
    // testDefinitionId): panel re-saves re-point ClinicalPanelItems at the
    // latest definition versions, and orders referencing an older version
    // would otherwise lose their panel grouping.
    const testDefinitionRootIds = [
      ...new Set(
        rawTestOrders
          .map((order) => order.testDefinition?.rootDefinitionId)
          .filter((rootId): rootId is string => Boolean(rootId)),
      ),
    ];

    const definitionPanelItems = testDefinitionRootIds.length
      ? await prisma.clinicalPanelItem.findMany({
          where: {
            testDefinition: {
              rootDefinitionId: { in: testDefinitionRootIds },
            },
          },
          orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
          select: {
            testDefinitionId: true,
            testDefinition: { select: { rootDefinitionId: true } },
            panel: {
              select: {
                id: true,
                name: true,
                displayName: true,
                layoutType: true,
                panelMethodText: true,
                panelMethodItalic: true,
                narrativeTemplateHtml: true,
                department: {
                  select: {
                    id: true,
                    name: true,
                  },
                },
              },
            },
          },
        })
      : [];

    const definitionPanelItemsByRootId = new Map<
      string,
      typeof definitionPanelItems
    >();
    for (const panelItem of definitionPanelItems) {
      const rootId = panelItem.testDefinition.rootDefinitionId;
      const list = definitionPanelItemsByRootId.get(rootId) || [];
      list.push(panelItem);
      definitionPanelItemsByRootId.set(rootId, list);
    }

    const testOrders = rawTestOrders.map((order) => {
      const orderProductPanels = order.productId
        ? productPanelSet.get(order.productId)
        : undefined;

      const labItems = labPanelItemsByTestId.get(order.testId);
      let labPanelItem = undefined;
      if (labItems && labItems.length > 0) {
        if (orderProductPanels) {
          labPanelItem = labItems.find((item) =>
            orderProductPanels.has(item.panel.id),
          );
        }
        if (!labPanelItem) {
          labPanelItem = labItems[0];
        }
      }

      let definitionPanelItem = undefined;
      if (order.testDefinition?.rootDefinitionId) {
        const defItems = definitionPanelItemsByRootId.get(
          order.testDefinition.rootDefinitionId,
        );
        if (defItems && defItems.length > 0) {
          if (orderProductPanels) {
            definitionPanelItem = defItems.find((item) =>
              orderProductPanels.has(item.panel.id),
            );
          }
          if (!definitionPanelItem) {
            definitionPanelItem =
              defItems.find(
                (item) => item.testDefinitionId === order.testDefinitionId,
              ) || defItems[0];
          }
        }
      }

      return {
        ...order,
        test: {
          ...order.test,
          childTests: childTestsByParentId.get(order.testId) ?? [],
          panelItems: labPanelItem ? [labPanelItem] : [],
        },
        testDefinition: order.testDefinition
          ? {
              ...order.testDefinition,
              panelItems: definitionPanelItem ? [definitionPanelItem] : [],
            }
          : null,
      };
    });

    const visit = {
      ...visitBase,
      report: visitBase.report
        ? {
            id: visitBase.report.id,
            versions: reportVersions.map((version) => ({
              ...version,
              testResults: reportResultsByVersionId.get(version.id) ?? [],
            })),
          }
        : null,
      testOrders,
    };

    // Resolve age/gender-aware reference ranges for all tests (including child tests)
    const patient = visit.patient;
    const reportableOrders = getReportableOrders(visit.testOrders);
    const allTestIds: string[] = [];
    for (const to of reportableOrders) {
      allTestIds.push(to.testId);
      if (to.test.isPanel && to.test.childTests) {
        for (const ct of to.test.childTests) {
          allTestIds.push(ct.id);
        }
      }
    }
    const uniqueTestIds = [...new Set(allTestIds)];

    // Build testDefinitionId map from testOrders
    const testDefIdMap = new Map<string, string>();
    for (const to of reportableOrders) {
      if (to.testDefinitionId) {
        testDefIdMap.set(to.testId, to.testDefinitionId);
      }
    }

    const resolvedRanges = await resolveReferenceRanges(
      uniqueTestIds,
      patient.yearOfBirth,
      patient.gender as any,
      testDefIdMap.size > 0 ? testDefIdMap : undefined,
      patient.dateOfBirth,
    );

    const latestDefinitionFormulasByCode =
      await loadLatestDefinitionFormulasByCode(
        reportableOrders.flatMap((to) => [
          to.testCodeSnapshot || to.testDefinition?.code || to.test.code,
          ...to.test.childTests.map((child) => child.code),
        ]),
      );

    // Bulk-fetch entry-time input configs (presets, default value, input type)
    // for every test in this visit. Keyed by rootDefinitionId.
    const rootIdsToFetch = new Set<string>();
    for (const to of reportableOrders) {
      if (to.testDefinition?.rootDefinitionId) {
        rootIdsToFetch.add(to.testDefinition.rootDefinitionId);
      }
      // For legacy panel children, look up by code to find the latest TestDefinition's rootId
      for (const child of to.test.childTests) {
        const latestForChild = latestDefinitionFormulasByCode.get(child.code);
        if (latestForChild?.rootDefinitionId) {
          rootIdsToFetch.add(latestForChild.rootDefinitionId);
        }
      }
    }
    const inputConfigsByRootId = await loadInputConfigsByRootId(rootIdsToFetch);

    // Helper to build referenceRange from resolved + fallback data
    const buildRange = (
      testId: string,
      defaultMin: number | null,
      defaultMax: number | null,
      defaultUnit: string | null,
      defaultText?: string | null,
    ) => {
      const resolved = resolvedRanges.get(testId);
      return {
        min: resolved?.referenceMin ?? defaultMin ?? 0,
        max: resolved?.referenceMax ?? defaultMax ?? 0,
        unit: resolved?.referenceUnit || defaultUnit || "",
        text: resolved?.referenceText || defaultText || "",
      };
    };
    // Transform to frontend format
    const latestFinalizedVersion =
      visit.report?.versions.find(
        (version: any) => version.status === "FINALIZED",
      ) || null;
    const composition = getVisitComposition(
      visit.testOrders,
      visit.status,
      visit.report?.versions || [],
    );
    const billFinancials = buildBillFinancialResponse(visit.bill);

    const transformed = {
      id: visit.id,
      branchId: visit.branchId,
      billNumber: visit.billNumber,
      patientId: visit.patientId,
      patient: visit.patient,
      domain: visit.domain,
      status: visit.status,
      totalAmount: visit.totalAmountInPaise / 100,
      paymentType:
        Array.isArray((visit as any).bill?.transactions) &&
        (visit as any).bill.transactions.length > 0
          ? Array.from(
              new Set(
                (visit as any).bill.transactions.map((t: any) => t.paymentType),
              ),
            ).join(", ")
          : null,
      paymentStatus: visit.bill?.paymentStatus || "PENDING",
      ...billFinancials,
      billedAt: visit.bill?.billedAt || visit.bill?.createdAt || null,
      reportFinalizedAt: latestFinalizedVersion?.finalizedAt || null,
      hasReportableOrders: composition.hasReportableOrders,
      hasBillOnlyOrders: composition.hasBillOnlyOrders,
      hasExternalUploadOrders: composition.hasExternalUploadOrders,
      hasReportInclusionOrders: composition.hasReportInclusionOrders,
      hasEntryScreenOrders: composition.hasEntryScreenOrders,
      hasFinalizedReport: composition.hasFinalizedReport,
      nextAction: composition.nextAction,
      referralDoctorId: visit.referrals[0]?.referralDoctorId || null,
      referralDoctor: visit.referrals[0]?.referralDoctor || null,
      testOrders: (() => {
        const orders = visit.testOrders.map((to) => {
          const orderCode =
            to.testCodeSnapshot || to.testDefinition?.code || to.test.code;
          const latestOrderDefinition =
            latestDefinitionFormulasByCode.get(orderCode);
          const orderDerived = to.testDefinition?.formulaExpression
            ? buildDerivedMetadata(
                to.testDefinition.formulaExpression,
                to.testDefinition.dependsOnCodes,
              )
            : to.test.derivedParameter?.formula
              ? buildDerivedMetadata(
                  to.test.derivedParameter.formula,
                  to.test.derivedParameter.dependsOnTestCodes,
                )
              : buildDerivedMetadata(
                  latestOrderDefinition?.formulaExpression,
                  latestOrderDefinition?.dependsOnCodes,
                );

          const orderRootId =
            to.testDefinition?.rootDefinitionId ?? latestOrderDefinition?.rootDefinitionId;
          const orderInputConfig =
            (orderRootId && inputConfigsByRootId.get(orderRootId)) || DEFAULT_INPUT_CONFIG;

          return {
            id: to.id,
            visitId: to.visitId,
            testId: to.testId,
            productId: to.productId,
            testDefinitionId: to.testDefinitionId,
            workflowMode: to.workflowMode,
            testName: to.testNameSnapshot || to.test.name,
            testCode: to.testCodeSnapshot || to.test.code,
            price: to.priceInPaise / 100,
            priceInPaise: to.priceInPaise,
            cancelledAt: to.cancelledAt,
            cancelReason: to.cancelReason,
            reversedChargeInPaise: to.reversedChargeInPaise,
            noReportAt: to.noReportAt,
            noReportReason: to.noReportReason,
            noReportBy: to.noReportByUser?.name ?? null,
            uploadInsteadAt: to.uploadInsteadAt,
            uploadInsteadBy: to.uploadInsteadByUser?.name ?? null,
            referralCommissionType: to.referralCommissionType,
            referralCommissionPercent: to.referralCommissionPercentage,
            referralCommissionAmountInPaise: to.referralCommissionAmountInPaise,
            isPanel: to.test.isPanel,
            isDerived: orderDerived.isDerived,
            formulaExpression: orderDerived.formulaExpression,
            dependsOnCodes: orderDerived.dependsOnCodes,
            inputConfig: orderInputConfig,
            department: (() => {
              const dept =
                to.testDefinition?.panelItems?.[0]?.panel?.department ||
                to.test.panelItems?.[0]?.panel?.department ||
                to.testDefinition?.department ||
                to.test.department;
              return dept ? { id: dept.id, name: dept.name } : null;
            })(),
            panel: (() => {
              const panel =
                to.testDefinition?.panelItems?.[0]?.panel ||
                to.test.panelItems?.[0]?.panel ||
                null;
              const panelMethodText =
                panel && "panelMethodText" in panel
                  ? (panel.panelMethodText ?? null)
                  : null;
              const panelMethodItalic =
                panel && "panelMethodItalic" in panel
                  ? (panel.panelMethodItalic ?? false)
                  : false;
              const narrativeTemplateHtml =
                panel && "narrativeTemplateHtml" in panel
                  ? (panel.narrativeTemplateHtml ?? null)
                  : null;
              return panel
                ? {
                    id: panel.id,
                    name: panel.name,
                    displayName: panel.displayName,
                    layoutType: panel.layoutType,
                    panelMethodText,
                    panelMethodItalic,
                    narrativeTemplateHtml,
                  }
                : null;
            })(),
            referenceRange: buildRange(
              to.testId,
              to.referenceMinSnapshot ??
                to.testDefinition?.referenceMin ??
                to.test.referenceMin,
              to.referenceMaxSnapshot ??
                to.testDefinition?.referenceMax ??
                to.test.referenceMax,
              to.referenceUnitSnapshot ||
                to.testDefinition?.referenceUnit ||
                to.test.referenceUnit,
              to.testDefinition?.referenceText || to.test.referenceText,
            ),
            childTests: to.test.isPanel
              ? to.test.childTests.map((ct: any) => {
                  const latestChildDefinition =
                    latestDefinitionFormulasByCode.get(ct.code);
                  const childDerived = buildDerivedMetadata(
                    ct.derivedParameter?.formula ||
                      latestChildDefinition?.formulaExpression,
                    ct.derivedParameter?.dependsOnTestCodes ||
                      latestChildDefinition?.dependsOnCodes,
                  );
                  const childRootId = latestChildDefinition?.rootDefinitionId;
                  const childInputConfig =
                    (childRootId && inputConfigsByRootId.get(childRootId)) ||
                    DEFAULT_INPUT_CONFIG;

                  return {
                    id: ct.id,
                    name: ct.name,
                    code: ct.code,
                    displayOrder: ct.displayOrder,
                    isDerived: childDerived.isDerived,
                    formulaExpression: childDerived.formulaExpression,
                    dependsOnCodes: childDerived.dependsOnCodes,
                    inputConfig: childInputConfig,
                    referenceRange: buildRange(
                      ct.id,
                      ct.referenceMin,
                      ct.referenceMax,
                      ct.referenceUnit,
                      ct.referenceText,
                    ),
                  };
                })
              : [],
            results: to.testResults.map((tr: any) => ({
              ...tr,
              manualOverride: isManualDerivedOverrideNote(tr.notes),
              testName: tr.test?.name || "",
              testCode: tr.test?.code || "",
              referenceRange: buildRange(
                tr.testId,
                tr.test?.referenceMin,
                tr.test?.referenceMax,
                tr.test?.referenceUnit,
                tr.test?.referenceText,
              ),
            })),
          };
        });
        return propagatePanelByProductId(orders);
      })(),
      billItems: buildDiagnosticBillItems(
        visit.testOrders.map((to) => ({
          id: to.id,
          productId: to.productId,
          product: to.product
            ? {
                id: to.product.id,
                name: to.product.name,
                code: to.product.code,
              }
            : null,
          testName: to.testNameSnapshot || to.test.name,
          testCode: to.testCodeSnapshot || to.test.code,
          priceInPaise: to.priceInPaise,
          referralCommissionType: visit.referrals[0]?.referralDoctor
            ? to.referralCommissionType
            : undefined,
          referralCommissionPercentage: visit.referrals[0]?.referralDoctor
            ? to.referralCommissionPercentage
            : undefined,
          referralCommissionAmountInPaise: visit.referrals[0]?.referralDoctor
            ? to.referralCommissionAmountInPaise
            : undefined,
        })),
      ),
      report: visit.report
        ? {
            id: visit.report.id,
            versions: visit.report.versions.map((v: any) => ({
              id: v.id,
              versionNumber: v.versionNum,
              status: v.status,
              finalizedAt: v.finalizedAt,
              testResults: v.testResults.map((tr: any) => ({
                ...tr,
                manualOverride: isManualDerivedOverrideNote(tr.notes),
                testName: tr.test?.name || "",
                testCode: tr.test?.code || "",
                referenceRange: buildRange(
                  tr.testId,
                  tr.test?.referenceMin,
                  tr.test?.referenceMax,
                  tr.test?.referenceUnit,
                  tr.test?.referenceText,
                ),
              })),
            })),
          }
        : null,
      createdAt: visit.createdAt,
      updatedAt: visit.updatedAt,
    };

    return res.json(transformed);
  } catch (err: any) {
    console.error("Get diagnostic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to get diagnostic visit",
    });
  }
});

// POST /api/visits/diagnostic - Create new diagnostic visit
// Accepts EITHER productIds (new architecture) OR testIds (legacy)
router.post("/", async (req: AuthRequest, res) => {
  try {
    const {
      patientId,
      referralDoctorId,
      diagnosticCenterId,
      referralOverrides,
      diagnosticCenterOverrides,
      externalLabByProductId,
      externalLabByTestId,
      testIds,
      productIds,
      paymentType,
      discountType,
      discountValue,
      discountReason,
      couponCode,
      paidAmount,
      payments,
      sendWhatsApp,
    } = req.body;

    const hasProducts =
      productIds && Array.isArray(productIds) && productIds.length > 0;
    const hasTests = testIds && Array.isArray(testIds) && testIds.length > 0;

    // Validation
    if (!patientId || (!hasProducts && !hasTests)) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Patient ID and at least one product or test are required",
      });
    }

    if (discountType && discountType !== "NONE" && discountValue > 0 && !discountReason?.trim()) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "A reason must be provided when applying a discount",
      });
    }

    // Get branch code for bill number
    const branch = await prisma.branch.findUnique({
      where: { id: req.branchId },
    });

    if (!branch) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Invalid branch",
      });
    }

    const referralRuleByProductId = new Map<string, NormalizedReferralPayout>();
    // Per-doctor per-category overrides + the centre-wide category rate card.
    // Together these replace the old per-doctor flat default: a referred test's
    // base commission now comes from its panel category (doctor rule > centre
    // rate card). A per-product rule / ad-hoc override still takes priority.
    const doctorCategoryRuleByCategory = new Map<string, NormalizedReferralPayout>();
    const centerCategoryRateByCategory = new Map<string, NormalizedReferralPayout>();
    let defaultDiagnosticCenterRule: NormalizedReferralPayout | null = null;
    const diagnosticCenterRuleByProductId = new Map<
      string,
      NormalizedReferralPayout
    >();

    // For every branch-scoped rule set, we pull this branch's rows + the global
    // (branchId = null) rows, then build the map global-first so the branch row
    // overrides the global for the same key. (nulls sort before non-nulls.)
    const branchFirst = <T extends { branchId: string | null }>(rows: T[]): T[] =>
      [...rows].sort((a, b) => (a.branchId === null ? 0 : 1) - (b.branchId === null ? 0 : 1));

    if (referralDoctorId) {
      const referralDoc = await prisma.referralDoctor.findUnique({
        where: { id: referralDoctorId },
        include: {
          productRules: { where: { isActive: true, OR: [{ branchId: req.branchId! }, { branchId: null }] } },
          categoryRules: { where: { isActive: true, OR: [{ branchId: req.branchId! }, { branchId: null }] } },
        },
      });

      if (!referralDoc) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Referral doctor not found",
        });
      }

      for (const rule of branchFirst(referralDoc.productRules)) {
        referralRuleByProductId.set(rule.productId, {
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
        });
      }

      for (const rule of branchFirst(referralDoc.categoryRules)) {
        doctorCategoryRuleByCategory.set(rule.category, {
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
        });
      }

      // Rate card — the base commission for every referred test, keyed by the
      // test's panel category. This branch's override wins over the global row.
      const categoryRates = await prisma.referralCategoryRate.findMany({
        where: { isActive: true, OR: [{ branchId: req.branchId! }, { branchId: null }] },
      });
      for (const rate of branchFirst(categoryRates)) {
        centerCategoryRateByCategory.set(rate.category, {
          commissionType: rate.commissionType,
          commissionPercent: rate.commissionPercent,
          commissionAmountInPaise: rate.commissionAmountInPaise,
        });
      }
    }

    if (diagnosticCenterId) {
      const diagnosticCenter = await prisma.diagnosticReferralCenter.findUnique(
        {
          where: { id: diagnosticCenterId },
          include: {
            productRules: {
              where: { isActive: true },
            },
          },
        },
      );

      if (!diagnosticCenter) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Diagnostic center not found",
        });
      }

      defaultDiagnosticCenterRule = {
        commissionType: diagnosticCenter.commissionType,
        commissionPercent: diagnosticCenter.commissionPercent,
        commissionAmountInPaise: diagnosticCenter.commissionAmountInPaise,
      };

      for (const rule of diagnosticCenter.productRules) {
        diagnosticCenterRuleByProductId.set(rule.productId, {
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
        });
      }
    }

    // Resolve a referred test's commission from its frozen payout category:
    // per-doctor category override > centre category rate card > none. A
    // per-product rule or ad-hoc bill override (handled at the call site) wins
    // over this. Returns a zero snapshot when nothing is configured for the
    // category (e.g. an uncategorised panel) — never the old flat default.
    const resolveCategoryReferralSnapshot = (
      category: string | null,
    ): PayoutSnapshot => {
      const rule =
        (category ? doctorCategoryRuleByCategory.get(category) : undefined) ??
        (category ? centerCategoryRateByCategory.get(category) : undefined) ??
        null;
      if (!rule) return zeroPayoutSnapshot();
      if (rule.commissionType === "FIXED_AMOUNT") {
        return {
          commissionType: "FIXED_AMOUNT",
          commissionPercentage: null,
          // Per-test flat: each order in this category earns the full amount
          // (NOT distributed — that's product-level fixed-amount behaviour).
          commissionAmountInPaise: rule.commissionAmountInPaise ?? 0,
        };
      }
      return {
        commissionType: "PERCENTAGE",
        commissionPercentage: rule.commissionPercent ?? 0,
        commissionAmountInPaise: null,
      };
    };

    // ── Outside-lab outsourcing (optional): which products/tests go to a lab ──
    const labByProduct: Record<string, string> =
      externalLabByProductId && typeof externalLabByProductId === "object"
        ? externalLabByProductId
        : {};
    const labByTest: Record<string, string> =
      externalLabByTestId && typeof externalLabByTestId === "object"
        ? externalLabByTestId
        : {};
    const labMap = new Map<
      string,
      {
        lab: { rateType: any; ratePercent: number | null; rateAmountInPaise: number | null };
        ruleByProductId: Map<string, any>;
      }
    >();
    const labIds = Array.from(
      new Set(
        [...Object.values(labByProduct), ...Object.values(labByTest)].filter(
          (id): id is string => typeof id === "string" && id.length > 0
        )
      )
    );
    if (labIds.length > 0) {
      const labs = await prisma.externalLab.findMany({
        where: { id: { in: labIds }, isActive: true },
        include: { productRules: { where: { isActive: true } } },
      });
      for (const lab of labs) {
        labMap.set(lab.id, {
          lab,
          ruleByProductId: new Map(lab.productRules.map((r) => [r.productId, r])),
        });
      }
    }

    const overrides = new Map<string, NormalizedReferralPayout>();
    const diagnosticCenterOverrideMap = new Map<
      string,
      NormalizedReferralPayout
    >();
    if (referralOverrides && typeof referralOverrides === "object") {
      try {
        for (const [key, value] of Object.entries(referralOverrides)) {
          const normalized = normalizeReferralOverrideInput(value);
          if (normalized) {
            overrides.set(key, normalized);
          }
        }
      } catch (validationErr: any) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: validationErr.message,
        });
      }
    }

    if (
      diagnosticCenterOverrides &&
      typeof diagnosticCenterOverrides === "object"
    ) {
      try {
        for (const [key, value] of Object.entries(diagnosticCenterOverrides)) {
          const normalized = normalizeReferralOverrideInput(value);
          if (normalized) {
            diagnosticCenterOverrideMap.set(key, normalized);
          }
        }
      } catch (validationErr: any) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: validationErr.message,
        });
      }
    }

    // ── Resolve tests + pricing ──
    // Two paths: product-based (new) or direct test-based (legacy)
    let totalAmountInPaise = 0;
    let testOrderData: Array<{
      testId: string;
      testDefinitionId?: string;
      productId?: string;
      panelId: string | null;
      payoutCategorySnapshot: string | null;
      workflowMode: DiagnosticWorkflowMode;
      priceInPaise: number;
      testNameSnapshot: string;
      testCodeSnapshot: string;
      referenceMinSnapshot: number | null;
      referenceMaxSnapshot: number | null;
      referenceUnitSnapshot: string | null;
      referralCommissionType: "PERCENTAGE" | "FIXED_AMOUNT";
      referralCommissionPercentage: number | null;
      referralCommissionAmountInPaise: number | null;
      diagnosticCenterCommissionType: "PERCENTAGE" | "FIXED_AMOUNT" | null;
      diagnosticCenterCommissionPercentage: number | null;
      diagnosticCenterCommissionAmountInPaise: number | null;
      externalLabId: string | null;
      labCostType: "PERCENTAGE" | "FIXED_AMOUNT" | null;
      labCostPercentage: number | null;
      labCostAmountInPaise: number | null;
    }> = [];

    // Resolve the outside-lab snapshot (+ optional reduced doctor commission)
    // for one order. Returns the (possibly reduced) referral snapshot to use.
    const resolveOrderLab = (
      key: string | undefined,
      referral: {
        commissionType: "PERCENTAGE" | "FIXED_AMOUNT";
        commissionPercentage: number | null;
        commissionAmountInPaise: number | null;
      },
      productId?: string
    ) => {
      const labId = key ? (labByProduct[key] ?? labByTest[key]) : undefined;
      const entry = labId ? labMap.get(labId) : undefined;
      if (!labId || !entry) {
        return {
          externalLabId: null as string | null,
          labCostType: null as "PERCENTAGE" | "FIXED_AMOUNT" | null,
          labCostPercentage: null as number | null,
          labCostAmountInPaise: null as number | null,
          referral,
        };
      }
      const rule = productId ? entry.ruleByProductId.get(productId) : undefined;
      const cost = resolveLabCostSnapshot(entry.lab, rule);
      let nextReferral = referral;
      if (referralDoctorId && rule?.reducedReferralCommissionType != null) {
        const reduced = resolveReducedReferralSnapshot(
          {
            referralCommissionType: referral.commissionType,
            referralCommissionPercentage: referral.commissionPercentage,
            referralCommissionAmountInPaise: referral.commissionAmountInPaise,
          },
          rule
        );
        nextReferral = {
          commissionType: reduced.referralCommissionType,
          commissionPercentage: reduced.referralCommissionPercentage,
          commissionAmountInPaise: reduced.referralCommissionAmountInPaise,
        };
      }
      return {
        externalLabId: labId,
        labCostType: cost.labCostType,
        labCostPercentage: cost.labCostPercentage,
        labCostAmountInPaise: cost.labCostAmountInPaise,
        referral: nextReferral,
      };
    };

    if (hasProducts) {
      // ── New architecture: resolve BillableProducts ──
      try {
        const resolved = await resolveProducts(productIds, req.branchId!);

        for (const rp of resolved) {
          // A product-level rule (ad-hoc bill override or per-doctor per-product
          // rule) covers the whole product and is distributed across its leaves.
          // With no product-level rule, each leaf resolves from its own panel
          // category (per-modality rates work inside a mixed bundle this way).
          const productLevelRule =
            overrides.get(rp.productId) ??
            referralRuleByProductId.get(rp.productId) ??
            null;
          const effectiveDiagnosticCenterRule =
            diagnosticCenterOverrideMap.get(rp.productId) ??
            diagnosticCenterRuleByProductId.get(rp.productId) ??
            defaultDiagnosticCenterRule;
          const referralSnapshots = productLevelRule
            ? applyReferralRuleToPrices(
                rp.testOrders.map((to) => to.priceInPaise),
                productLevelRule,
              )
            : referralDoctorId
              ? rp.testOrders.map((to) =>
                  resolveCategoryReferralSnapshot(to.payoutCategory),
                )
              : rp.testOrders.map(() => zeroPayoutSnapshot());
          const diagnosticCenterSnapshots = applyOptionalReferralRuleToPrices(
            rp.testOrders.map((to) => to.priceInPaise),
            effectiveDiagnosticCenterRule,
          );

          for (const [index, to] of rp.testOrders.entries()) {
            const labResolved = resolveOrderLab(
              rp.productId,
              {
                commissionType: referralSnapshots[index].commissionType,
                commissionPercentage: referralSnapshots[index].commissionPercentage,
                commissionAmountInPaise: referralSnapshots[index].commissionAmountInPaise,
              },
              to.productId
            );
            testOrderData.push({
              testId: to.labTestId,
              testDefinitionId: to.testDefinitionId,
              productId: to.productId,
              panelId: to.panelId ?? null,
              payoutCategorySnapshot: to.payoutCategory ?? null,
              workflowMode: to.workflowMode,
              priceInPaise: to.priceInPaise,
              testNameSnapshot: to.testName,
              testCodeSnapshot: to.testCode,
              referenceMinSnapshot: to.referenceMin,
              referenceMaxSnapshot: to.referenceMax,
              referenceUnitSnapshot: to.referenceUnit,
              referralCommissionType: labResolved.referral.commissionType,
              referralCommissionPercentage: labResolved.referral.commissionPercentage,
              referralCommissionAmountInPaise: labResolved.referral.commissionAmountInPaise,
              diagnosticCenterCommissionType:
                diagnosticCenterSnapshots[index].commissionType,
              diagnosticCenterCommissionPercentage:
                diagnosticCenterSnapshots[index].commissionPercentage,
              diagnosticCenterCommissionAmountInPaise:
                diagnosticCenterSnapshots[index].commissionAmountInPaise,
              externalLabId: labResolved.externalLabId,
              labCostType: labResolved.labCostType,
              labCostPercentage: labResolved.labCostPercentage,
              labCostAmountInPaise: labResolved.labCostAmountInPaise,
            });
          }
          totalAmountInPaise += rp.effectivePrice;
        }
      } catch (err) {
        if (err instanceof ProductResolutionError) {
          return res.status(400).json({
            error: err.code,
            message: err.message,
            details: err.details,
          });
        }
        throw err;
      }
    } else {
      // ── Legacy path: direct LabTest IDs ──
      const tests = await prisma.labTest.findMany({
        where: { id: { in: testIds } },
      });

      if (tests.length !== testIds.length) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "One or more tests not found",
        });
      }

      totalAmountInPaise = tests.reduce((sum, t) => sum + t.priceInPaise, 0);

      const testMap = new Map(tests.map(t => [t.id, t]));

      testOrderData = testIds.map((testId: string) => {
        const test = testMap.get(testId)!;
        // Legacy LabTests have no panel, so infer the category from the name.
        const legacyCategory = categorize({
          testName: test.name,
          productName: test.name,
        });
        const overrideRule = overrides.get(test.id) ?? null;
        const referralSnapshot = overrideRule
          ? applyReferralRuleToPrices([test.priceInPaise], overrideRule)[0]
          : referralDoctorId
            ? resolveCategoryReferralSnapshot(legacyCategory)
            : zeroPayoutSnapshot();
        const diagnosticCenterSnapshot = applyOptionalReferralRuleToPrices(
          [test.priceInPaise],
          diagnosticCenterOverrideMap.get(test.id) ??
            defaultDiagnosticCenterRule,
        )[0];

        const labResolved = resolveOrderLab(
          test.id,
          {
            commissionType: referralSnapshot.commissionType,
            commissionPercentage: referralSnapshot.commissionPercentage,
            commissionAmountInPaise: referralSnapshot.commissionAmountInPaise,
          },
          undefined
        );
        return {
          testId: test.id,
          panelId: null,
          payoutCategorySnapshot: legacyCategory,
          workflowMode: DiagnosticWorkflowMode.REPORTABLE,
          priceInPaise: test.priceInPaise,
          testNameSnapshot: test.name,
          testCodeSnapshot: test.code,
          referenceMinSnapshot: test.referenceMin,
          referenceMaxSnapshot: test.referenceMax,
          referenceUnitSnapshot: test.referenceUnit,
          referralCommissionType: labResolved.referral.commissionType,
          referralCommissionPercentage: labResolved.referral.commissionPercentage,
          referralCommissionAmountInPaise:
            labResolved.referral.commissionAmountInPaise,
          diagnosticCenterCommissionType:
            diagnosticCenterSnapshot.commissionType,
          diagnosticCenterCommissionPercentage:
            diagnosticCenterSnapshot.commissionPercentage,
          diagnosticCenterCommissionAmountInPaise:
            diagnosticCenterSnapshot.commissionAmountInPaise,
          externalLabId: labResolved.externalLabId,
          labCostType: labResolved.labCostType,
          labCostPercentage: labResolved.labCostPercentage,
          labCostAmountInPaise: labResolved.labCostAmountInPaise,
        };
      });
    }

    if (testOrderData.length === 0) {
      return res.status(400).json({
        error: "INVALID_PANEL_CONFIGURATION",
        message:
          "The selected product does not contain any reportable test items. Please fix the linked panel configuration.",
      });
    }

    // ── Coupon redemption (optional): a campaign code discounts the in-scope
    // items as a SEPARATE bill line and is consumed once. See EVENTS_AND_COUPONS.md.
    let couponContext: { couponId: string; code: string; discountInPaise: number } | null = null;
    let redeemCouponInTx: ((tx: any, input: any) => Promise<void>) | null = null;
    if (typeof couponCode === "string" && couponCode.trim()) {
      const svc = await import("../services/couponService");
      redeemCouponInTx = svc.redeemCouponInTx;
      const v = await svc.validateCouponByCode(couponCode);
      if (!v.ok || !v.coupon || !v.campaign) {
        return res.status(400).json({
          error: "COUPON_INVALID",
          reason: v.reason,
          message:
            v.reason === "ALREADY_REDEEMED"
              ? "This coupon has already been used."
              : v.reason === "EXPIRED"
                ? "This coupon has expired."
                : v.reason === "NOT_FOUND"
                  ? "No coupon found for that code."
                  : "This coupon can't be applied.",
        });
      }
      // allowedProductIds non-empty ⇒ discount ONLY those products (the patient's
      // abnormal panels); empty ⇒ all in-scope tests (original campaign-scope behaviour).
      const allowedProducts = v.coupon.allowedProductIds ?? [];
      const inScopeInPaise =
        v.campaign.scope === "WHOLE_BILL"
          ? totalAmountInPaise
          : testOrderData.reduce((s: number, o: any) => {
              const reportable =
                (o.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
                DiagnosticWorkflowMode.REPORTABLE;
              const inScope =
                allowedProducts.length === 0 ||
                (o.productId && allowedProducts.includes(o.productId));
              return s + (reportable && inScope ? o.priceInPaise || 0 : 0);
            }, 0);
      couponContext = {
        couponId: v.coupon.id,
        code: v.coupon.code,
        discountInPaise: svc.computeCouponDiscountInPaise(v.campaign, inScopeInPaise),
      };
    }

    let billFinancials;
    try {
      billFinancials = normalizeBillFinancialInput(
        {
          totalAmountInPaise,
          discountType,
          discountValue,
          discountReason,
          couponDiscountInPaise: couponContext?.discountInPaise ?? 0,
          paidAmount,
        },
        { defaultPaidToNet: true },
      );
    } catch (validationErr: any) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: validationErr.message,
      });
    }

    const createComposition = getVisitComposition(
      testOrderData,
      VisitStatus.WAITING,
    );
    // Visits that require an entry screen (REPORTABLE values OR external uploads)
    // start as DRAFT and only complete after finalize. Pure bill-only visits skip
    // straight to COMPLETED because there's nothing to enter.
    const initialVisitStatus = createComposition.hasReportInclusionOrders
      ? VisitStatus.DRAFT
      : VisitStatus.COMPLETED;

    // Generate bill number
    const billNumber = await generateDiagnosticBillNumber(branch.code);

    // Create visit with all related records in a transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // Idempotency guard. One registration = Patient + Visit + Bill +
        // PaymentTransaction, so a request that arrives twice (double-click, a
        // retry after a flaky response, a second tab) bills the patient twice.
        // Nothing else stops it: bill numbers are generated to be DISTINCT, so
        // the @@unique([branchId, billNumber]) constraints actively let both
        // inserts succeed.
        //
        // Serialize on (branch, patient) first — a bare SELECT would let two
        // concurrent requests both look, both find nothing, and both insert.
        // The check reads through `tx` so it is covered by that same lock.
        const dupLockId = duplicateVisitLockId(
          "DIAGNOSTICS",
          req.branchId!,
          patientId,
        );
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${dupLockId})`;
        const recentTwin = await tx.visit.findFirst({
          where: {
            branchId: req.branchId!,
            patientId,
            domain: "DIAGNOSTICS",
            totalAmountInPaise,
            status: { not: VisitStatus.CANCELLED },
            createdAt: { gte: new Date(Date.now() - DUPLICATE_VISIT_WINDOW_MS) },
          },
          orderBy: { createdAt: "desc" },
          select: { id: true, billNumber: true },
        });
        if (recentTwin) {
          throw new DuplicateVisitError(recentTwin.billNumber);
        }

        // Create visit
        const visit = await tx.visit.create({
          data: {
            branchId: req.branchId!,
            patientId,
            domain: "DIAGNOSTICS",
            status: initialVisitStatus,
            billNumber,
            totalAmountInPaise,
          },
        });

        // Create bill
        const createdBill = await tx.bill.create({
          data: {
            visitId: visit.id,
            billNumber,
            branchId: req.branchId!,
            totalAmountInPaise,
            discountReason: billFinancials.discountReason,
            discountType: billFinancials.discountType,
            discountPercentage: billFinancials.discountPercentage,
            discountAmountInPaise: billFinancials.discountAmountInPaise,
            discountedByUserId:
              billFinancials.discountAmountInPaise > 0 ? req.user!.id : null,
            couponId: couponContext?.couponId ?? null,
            couponCode: couponContext?.code ?? null,
            couponDiscountInPaise: couponContext?.discountInPaise ?? 0,
            paidAmountInPaise: billFinancials.paidAmountInPaise,
            paymentStatus: billFinancials.paymentStatus,
            transactions:
              billFinancials.paidAmountInPaise > 0
                ? {
                    create:
                      Array.isArray(payments) && payments.length > 0
                        ? payments.map((p: any) => ({
                            amountInPaise:
                              p.amountInPaise ??
                              Math.round((p.amount || 0) * 100),
                            paymentType: p.paymentType ?? p.type ?? "CASH",
                            collectedByUserId: req.user!.id,
                          }))
                        : [
                            {
                              amountInPaise: billFinancials.paidAmountInPaise,
                              paymentType: paymentType || "CASH",
                              collectedByUserId: req.user!.id,
                            },
                          ],
                  }
                : undefined,
          },
        });

        // Consume the coupon atomically inside the same tx (one-time; race-proof).
        if (couponContext && redeemCouponInTx) {
          await redeemCouponInTx(tx, {
            couponId: couponContext.couponId,
            visitId: visit.id,
            billId: createdBill.id,
            userId: req.user!.id,
          });
        }

        // Create referral if specified
        if (referralDoctorId) {
          await tx.referralDoctor_Visit.create({
            data: {
              visitId: visit.id,
              referralDoctorId,
              branchId: req.branchId!,
            },
          });
        }

        // Create diagnostic center referral if specified
        if (diagnosticCenterId) {
          await tx.diagnosticCenter_Visit.create({
            data: {
              visitId: visit.id,
              diagnosticCenterId,
              referralType: "REFERRED_FROM",
              branchId: req.branchId!,
            },
          });
        }

        if (referralDoctorId && hasProducts && overrides.size > 0) {
          for (const productId of productIds.filter((id: string) =>
            overrides.has(id),
          )) {
            const override = overrides.get(productId);
            if (!override) continue;

            // An explicit ad-hoc override always persists as a per-product rule.
            // (There is no longer a flat doctor default to compare it against —
            // the base is the category rate card, which a per-product rule
            // deliberately overrides.)
            // An ad-hoc override happened in this branch → persist it as this
            // branch's per-product rule (never clobbering the global rule).
            await tx.referralDoctorProductRule.upsert({
              where: {
                referralDoctorId_branchId_productId: {
                  referralDoctorId,
                  branchId: req.branchId!,
                  productId,
                },
              },
              update: {
                commissionType: override.commissionType,
                commissionPercent: override.commissionPercent,
                commissionAmountInPaise: override.commissionAmountInPaise,
                isActive: true,
              },
              create: {
                referralDoctorId,
                branchId: req.branchId!,
                productId,
                commissionType: override.commissionType,
                commissionPercent: override.commissionPercent,
                commissionAmountInPaise: override.commissionAmountInPaise,
                isActive: true,
              },
            });
          }
        }

        if (
          diagnosticCenterId &&
          hasProducts &&
          diagnosticCenterOverrideMap.size > 0
        ) {
          for (const productId of productIds.filter((id: string) =>
            diagnosticCenterOverrideMap.has(id),
          )) {
            const override = diagnosticCenterOverrideMap.get(productId);
            if (!override) continue;

            if (
              areReferralPayoutsEqual(override, defaultDiagnosticCenterRule)
            ) {
              await tx.diagnosticCenterProductRule.deleteMany({
                where: {
                  diagnosticCenterId,
                  productId,
                },
              });
              continue;
            }

            await tx.diagnosticCenterProductRule.upsert({
              where: {
                diagnosticCenterId_productId: {
                  diagnosticCenterId,
                  productId,
                },
              },
              update: {
                commissionType: override.commissionType,
                commissionPercent: override.commissionPercent,
                commissionAmountInPaise: override.commissionAmountInPaise,
                isActive: true,
              },
              create: {
                diagnosticCenterId,
                productId,
                commissionType: override.commissionType,
                commissionPercent: override.commissionPercent,
                commissionAmountInPaise: override.commissionAmountInPaise,
                isActive: true,
              },
            });
          }
        }

        // Create test orders with metadata snapshot (E3-03)
        await tx.testOrder.createMany({
          data: testOrderData.map((tod, idx) => ({
            visitId: visit.id,
            testId: tod.testId,
            branchId: req.branchId!,
            workflowMode: tod.workflowMode,
            priceInPaise: tod.priceInPaise,
            referralCommissionType: tod.referralCommissionType,
            referralCommissionPercentage: tod.referralCommissionPercentage,
            referralCommissionAmountInPaise:
              tod.referralCommissionAmountInPaise,
            diagnosticCenterCommissionType: tod.diagnosticCenterCommissionType,
            diagnosticCenterCommissionPercentage:
              tod.diagnosticCenterCommissionPercentage,
            diagnosticCenterCommissionAmountInPaise:
              tod.diagnosticCenterCommissionAmountInPaise,
            externalLabId: tod.externalLabId ?? null,
            labCostType: tod.labCostType,
            labCostPercentage: tod.labCostPercentage,
            labCostAmountInPaise: tod.labCostAmountInPaise,
            testNameSnapshot: tod.testNameSnapshot,
            testCodeSnapshot: tod.testCodeSnapshot,
            referenceMinSnapshot: tod.referenceMinSnapshot,
            referenceMaxSnapshot: tod.referenceMaxSnapshot,
            referenceUnitSnapshot: tod.referenceUnitSnapshot,
            testDefinitionId: tod.testDefinitionId ?? null,
            productId: tod.productId ?? null,
            panelId: tod.panelId ?? null,
            payoutCategorySnapshot: tod.payoutCategorySnapshot ?? null,
            displayOrder: idx,
          })),
        });

        if (createComposition.hasReportInclusionOrders) {
          // Both REPORTABLE and EXTERNAL_UPLOAD orders flow into a single
          // DiagnosticReport — the merged PDF combines rendered values with
          // appended uploads.
          const report = await tx.diagnosticReport.create({
            data: {
              visitId: visit.id,
              branchId: req.branchId!,
            },
          });

          await tx.reportVersion.create({
            data: {
              reportId: report.id,
              versionNum: 1,
              status: "DRAFT",
            },
          });
        }

        return visit;
      },
      {
        timeout: 15000,
        maxWait: 15000,
      },
    );

    void logAction({
      userId: req.user?.id!,
      actionType: "CREATE",
      entityType: "VISIT",
      entityId: result.id,
      branchId: req.branchId!,
      newValues: {
        domain: "DIAGNOSTICS",
        billNumber,
        patientId,
        totalAmountInPaise,
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    // Auto-refresh payouts only for pure bill-only visits (already COMPLETED).
    // Visits with REPORTABLE/EXTERNAL_UPLOAD orders complete payouts at finalize time.
    if (!createComposition.hasReportInclusionOrders) {
      const completedAt = new Date();
      const periodStartDate = new Date(completedAt);
      periodStartDate.setHours(0, 0, 0, 0);
      const periodEndDate = new Date(completedAt);
      periodEndDate.setHours(23, 59, 59, 999);

      const payoutRefreshTasks: Array<Promise<unknown>> = [];

      if (referralDoctorId) {
        payoutRefreshTasks.push(
          derivePayout(
            "REFERRAL",
            referralDoctorId,
            req.branchId!,
            periodStartDate,
            periodEndDate,
          ),
        );
      }

      if (diagnosticCenterId) {
        payoutRefreshTasks.push(
          derivePayout(
            "DIAGNOSTIC_CENTER",
            diagnosticCenterId,
            req.branchId!,
            periodStartDate,
            periodEndDate,
          ),
        );
      }

      if (payoutRefreshTasks.length > 0) {
        const refreshResults = await Promise.allSettled(payoutRefreshTasks);
        for (const refreshResult of refreshResults) {
          if (refreshResult.status === "rejected") {
            console.error(
              "Auto-refresh payout after bill-only billing failed:",
              refreshResult.reason,
            );
          }
        }
      }
    }

    // Fetch complete visit for response
    const completeVisit = await prisma.visit.findUnique({
      where: { id: result.id },
      include: {
        patient: { include: { identifiers: true } },
        referrals: { where: { deletedAt: null }, include: { referralDoctor: true } },
        testOrders: {
          include: {
            test: true,
            product: {
              select: {
                id: true,
                name: true,
                code: true,
              },
            },
          },
        },
        bill: { include: { transactions: true } },
      },
    });

    // Fire-and-forget WhatsApp (non-blocking). EVENT visits (e.g. the blood-donation
    // camp) mint a coupon and send the campaign reward instead of a bill receipt.
    if (sendWhatsApp) {
      const isEventVisit = (completeVisit?.testOrders ?? []).some(
        (o: any) => o.workflowMode === DiagnosticWorkflowMode.EVENT,
      );
      import("../services/notificationService").then(
        ({ sendBillConfirmation, sendEventCoupon }) => {
          const task = isEventVisit
            ? sendEventCoupon(result.id)
            : sendBillConfirmation(result.id);
          task.catch((err: any) =>
            console.error(
              "[Notification] WhatsApp send failed (non-blocking):",
              err?.message,
            ),
          );
        },
      );
    }

    const completeBillFinancials = buildBillFinancialResponse(
      completeVisit!.bill,
    );

    return res.status(201).json({
      id: completeVisit!.id,
      billNumber: completeVisit!.billNumber,
      patientId: completeVisit!.patientId,
      totalAmount: completeVisit!.totalAmountInPaise / 100,
      status: completeVisit!.status,
      hasBill: true,
      paymentType:
        Array.isArray((completeVisit as any)!.bill?.transactions) &&
        (completeVisit as any)!.bill.transactions.length > 0
          ? Array.from(
              new Set(
                ((completeVisit as any)!.bill.transactions as any[]).map(
                  (t) => t.paymentType,
                ),
              ),
            ).join(", ")
          : null,
      paymentStatus: completeVisit!.bill?.paymentStatus || "PENDING",
      // Ledger entries so the at-creation printed receipt can show the method
      // (e.g. "PAID | ONLINE"). Without this the bill printed straight after
      // creation had no transactions to derive the method from and showed a
      // bare "PAID". Mirrors the shape returned by GET /bills/:domain/:id.
      transactions:
        ((completeVisit as any)!.bill?.transactions as
          | Array<{ paymentType: string; amountInPaise: number }>
          | undefined
        )?.map((t) => ({
          paymentType: t.paymentType,
          amountInPaise: t.amountInPaise,
        })) || [],
      ...completeBillFinancials,
      billedAt:
        completeVisit!.bill?.billedAt || completeVisit!.bill?.createdAt || null,
      reportFinalizedAt: null,
      hasReportableOrders: createComposition.hasReportableOrders,
      hasBillOnlyOrders: createComposition.hasBillOnlyOrders,
      hasExternalUploadOrders: createComposition.hasExternalUploadOrders,
      hasReportInclusionOrders: createComposition.hasReportInclusionOrders,
      hasEntryScreenOrders: createComposition.hasEntryScreenOrders,
      hasFinalizedReport: false,
      nextAction: getVisitComposition(
        completeVisit!.testOrders,
        completeVisit!.status,
      ).nextAction,
      createdAt: completeVisit!.createdAt,
      referralDoctor: completeVisit!.referrals[0]?.referralDoctor || null,
      billItems: buildDiagnosticBillItems(
        completeVisit!.testOrders.map((to) => ({
          id: to.id,
          productId: to.productId,
          product: to.product
            ? {
                id: to.product.id,
                name: to.product.name,
                code: to.product.code,
              }
            : null,
          testName: to.testNameSnapshot || to.test.name,
          testCode: to.testCodeSnapshot || to.test.code,
          priceInPaise: to.priceInPaise,
          referralCommissionType: completeVisit!.referrals[0]?.referralDoctor
            ? to.referralCommissionType
            : undefined,
          referralCommissionPercentage: completeVisit!.referrals[0]
            ?.referralDoctor
            ? to.referralCommissionPercentage
            : undefined,
          referralCommissionAmountInPaise: completeVisit!.referrals[0]
            ?.referralDoctor
            ? to.referralCommissionAmountInPaise
            : undefined,
        })),
      ),
      testOrders: completeVisit!.testOrders.map((to) => ({
        id: to.id,
        visitId: to.visitId,
        testId: to.testId,
        productId: to.productId,
        testDefinitionId: to.testDefinitionId,
        workflowMode: to.workflowMode,
        testName: to.testNameSnapshot || to.test.name,
        testCode: to.testCodeSnapshot || to.test.code,
        priceInPaise: to.priceInPaise,
        referralCommissionType: to.referralCommissionType,
        referralCommissionPercent: to.referralCommissionPercentage,
        referralCommissionAmountInPaise: to.referralCommissionAmountInPaise,
        diagnosticCenterCommissionType: to.diagnosticCenterCommissionType,
        diagnosticCenterCommissionPercent:
          to.diagnosticCenterCommissionPercentage,
        diagnosticCenterCommissionAmountInPaise:
          to.diagnosticCenterCommissionAmountInPaise,
      })),
    });
  } catch (err: any) {
    // The registration was already recorded moments ago — this request is a
    // resubmit, not a second visit. Nothing was written (the transaction rolled
    // back), so report the bill that already exists rather than billing twice.
    if (err instanceof DuplicateVisitError) {
      return res.status(409).json({
        error: "DUPLICATE_VISIT",
        existingBillNumber: err.existingBillNumber,
        message: `This patient was already registered as ${err.existingBillNumber} moments ago. No second bill was created.`,
      });
    }
    console.error("Create diagnostic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to create diagnostic visit",
    });
  }
});

// PATCH /api/visits/diagnostic/:id - Update diagnostic visit status
router.patch("/:id", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { status, paymentType, paidAmount } = req.body;

    // Check visit exists
    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: { bill: { include: { transactions: true } } },
    });

    if (!existing) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    let nextBillFinancials = null;
    if (paidAmount !== undefined) {
      if (!existing.bill) {
        return res.status(400).json({
          error: "BILL_NOT_FOUND",
          message: "No bill found for this diagnostic visit",
        });
      }

      try {
        nextBillFinancials = normalizeBillFinancialInput({
          totalAmountInPaise: existing.bill.totalAmountInPaise,
          discountReason: existing.bill.discountReason,
          discountType: existing.bill.discountType,
          discountValue:
            existing.bill.discountType === "PERCENTAGE"
              ? (existing.bill.discountPercentage ?? 0)
              : existing.bill.discountAmountInPaise / 100,
          paidAmount,
        });
      } catch (validationErr: any) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: validationErr.message,
        });
      }
    }

    // Update visit
    const updated = await prisma.$transaction(async (tx) => {
      if (status) {
        await tx.visit.update({
          where: { id },
          data: { status },
        });
      }

      // Update bill financials if provided (paymentType no longer exists on bill)
      if (nextBillFinancials) {
        const currentBillFinancials = buildBillFinancialResponse(existing.bill);

        await tx.bill.updateMany({
          where: { visitId: id },
          data: {
            paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
            paymentStatus: nextBillFinancials.paymentStatus,
          },
        });

        // Record additive transaction for the newly paid amount
        const previousPaid = currentBillFinancials.paidAmountInPaise;
        const newPaid = nextBillFinancials.paidAmountInPaise;
        const addedAmount = newPaid - previousPaid;

        if (addedAmount > 0 && existing.bill) {
          await tx.paymentTransaction.create({
            data: {
              billId: existing.bill.id,
              amountInPaise: addedAmount,
              paymentType: paymentType || "CASH",
              collectedByUserId: req.user!.id,
            },
          });
        }
      }

      return tx.visit.findUnique({
        where: { id },
        include: { bill: { include: { transactions: true } } },
      });
    });
    const billFinancials = buildBillFinancialResponse(updated!.bill);

    return res.json({
      id: updated!.id,
      status: updated!.status,
      paymentStatus: updated!.bill?.paymentStatus,
      paymentType:
        Array.isArray((updated as any)!.bill?.transactions) &&
        (updated as any)!.bill.transactions.length > 0
          ? Array.from(
              new Set(
                ((updated as any)!.bill.transactions as any[]).map(
                  (t) => t.paymentType,
                ),
              ),
            ).join(", ")
          : null,
      ...billFinancials,
      billedAt: updated!.bill?.billedAt || updated!.bill?.createdAt || null,
    });
  } catch (err: any) {
    console.error("Update diagnostic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to update diagnostic visit",
    });
  }
});

// POST /api/visits/diagnostic/:id/collect-due - Collect an additive due payment
router.post("/:id/collect-due", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { amount, paymentType, discountType, discountValue, discountReason } =
      req.body;

    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: { bill: { include: { transactions: true } } },
    });

    if (!existing) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    if (!existing.bill) {
      return res.status(400).json({
        error: "BILL_NOT_FOUND",
        message: "No bill found for this diagnostic visit",
      });
    }

    // Optionally apply a discount at collection time. The reason is MANDATORY
    // (mirrors the create-visit rule at POST /) and the discount is stored on the
    // bill with the collector as `discountedByUserId` + `discountReason`, so it
    // flows into the owner audit/anomaly feed (which reads those columns). The
    // discount is ADDITIVE to any discount already on the bill.
    const subtotalPaise = Math.max(
      0,
      Math.round(existing.bill.totalAmountInPaise || 0),
    );
    const existingDiscountPaise = Math.max(
      0,
      Math.round(existing.bill.discountAmountInPaise ?? 0),
    );
    const wantsDiscount =
      discountType && discountType !== "NONE" && Number(discountValue) > 0;

    let discountData:
      | {
          discountType: BillDiscountType;
          discountPercentage: number | null;
          discountAmountInPaise: number;
          discountReason: string;
          discountedByUserId: string;
        }
      | undefined;
    let workingBill: typeof existing.bill = existing.bill;

    if (wantsDiscount) {
      if (typeof discountReason !== "string" || !discountReason.trim()) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "A reason must be provided when applying a discount",
        });
      }
      let incrementPaise = 0;
      if (discountType === "PERCENTAGE") {
        const pct = Number(discountValue);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
          return res.status(400).json({
            error: "VALIDATION_ERROR",
            message: "Discount percentage must be between 0 and 100",
          });
        }
        incrementPaise = Math.round((subtotalPaise * pct) / 100);
      } else if (discountType === "FLAT_AMOUNT") {
        const flat = Number(discountValue);
        if (!Number.isFinite(flat) || flat <= 0) {
          return res.status(400).json({
            error: "VALIDATION_ERROR",
            message: "Discount amount must be greater than zero",
          });
        }
        incrementPaise = Math.round(flat * 100);
      } else {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Invalid discount type",
        });
      }

      const newDiscountPaise = Math.min(
        subtotalPaise,
        existingDiscountPaise + incrementPaise,
      );
      const currentPaidPaise =
        computeBillFinancialsFromPersisted(existing.bill).paidAmountInPaise;
      const couponPaise = Math.max(
        0,
        Math.round(existing.bill.couponDiscountInPaise ?? 0),
      );
      const reversedPaise = Math.max(
        0,
        Math.round(existing.bill.reversedChargeInPaise ?? 0),
      );
      const newNetPaise = Math.max(
        0,
        subtotalPaise - newDiscountPaise - couponPaise - reversedPaise,
      );
      if (newNetPaise < currentPaidPaise) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: `Discount would drop the bill below the amount already paid (₹${(currentPaidPaise / 100).toFixed(2)}). Refund the overpayment first.`,
        });
      }

      // Store faithfully as a percentage only when there was no prior manual
      // discount; otherwise freeze the combined discount as an absolute amount so
      // it stays stable if the subtotal later changes (add/remove test).
      if (existingDiscountPaise === 0 && discountType === "PERCENTAGE") {
        discountData = {
          discountType: BillDiscountType.PERCENTAGE,
          discountPercentage: Number(discountValue),
          discountAmountInPaise: newDiscountPaise,
          discountReason: discountReason.trim(),
          discountedByUserId: req.user!.id,
        };
      } else {
        discountData = {
          discountType: BillDiscountType.FLAT_AMOUNT,
          discountPercentage: null,
          discountAmountInPaise: newDiscountPaise,
          discountReason: discountReason.trim(),
          discountedByUserId: req.user!.id,
        };
      }
      workingBill = { ...existing.bill, ...discountData };
    }

    // Collection amount may be 0 ONLY when a discount is being applied (e.g. the
    // discount clears the remaining balance). Otherwise a positive amount is
    // required.
    const collectRupees = Number(amount);
    const wantsCollection = Number.isFinite(collectRupees) && collectRupees > 0;
    if (!wantsCollection && !wantsDiscount) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Collection amount must be greater than zero",
      });
    }

    const workingFinancials = computeBillFinancialsFromPersisted(workingBill);
    let nextPaidAmountInPaise = workingFinancials.paidAmountInPaise;
    let nextPaymentStatus = workingFinancials.paymentStatus;
    let addedAmountInPaise = 0;

    if (wantsCollection) {
      let nextBillFinancials;
      try {
        nextBillFinancials = collectBillDue(workingBill, amount);
      } catch (validationErr: any) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: validationErr.message,
        });
      }
      addedAmountInPaise = Math.max(
        0,
        nextBillFinancials.paidAmountInPaise -
          workingFinancials.paidAmountInPaise,
      );
      if (addedAmountInPaise <= 0) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Collection amount must increase paid amount",
        });
      }
      nextPaidAmountInPaise = nextBillFinancials.paidAmountInPaise;
      nextPaymentStatus = nextBillFinancials.paymentStatus;
    }

    const normalizedPaymentType =
      paymentType === "ONLINE" ? "ONLINE" : "CASH";

    const updated = await prisma.bill.update({
      where: { id: existing.bill.id },
      data: {
        ...(discountData ?? {}),
        paidAmountInPaise: nextPaidAmountInPaise,
        paymentStatus: nextPaymentStatus,
        ...(addedAmountInPaise > 0
          ? {
              transactions: {
                create: {
                  amountInPaise: addedAmountInPaise,
                  paymentType: normalizedPaymentType,
                  collectedByUserId: req.user!.id,
                },
              },
            }
          : {}),
      },
      include: { transactions: true },
    });

    const billFinancials = buildBillFinancialResponse(updated);

    return res.json({
      id: existing.id,
      status: existing.status,
      paymentType:
        Array.isArray((updated as any).transactions) &&
        (updated as any).transactions.length > 0
          ? Array.from(
              new Set(
                ((updated as any).transactions as any[]).map(
                  (t) => t.paymentType,
                ),
              ),
            ).join(", ")
          : null,
      paymentBreakdown: paymentBreakdownFromTransactions(
        (updated as any).transactions,
      ),
      paymentStatus: updated.paymentStatus,
      ...billFinancials,
      billedAt: updated.billedAt || updated.createdAt,
    });
  } catch (err: any) {
    console.error("Collect diagnostic due error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to collect due payment",
    });
  }
});

// POST /api/visits/diagnostic/:id/refund - Cancel test orders and refund overpayment
// Whole-order cancellation: voids each selected order's remaining charge (net of
// its proportional discount share) off the bill, and returns any money the
// patient has now overpaid as a REFUND ledger row. With `preview: true` the
// amounts are computed and returned without writing anything.
router.post("/:id/refund", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { testOrderIds, reason, note, paymentType, preview } = req.body;

    if (
      !Array.isArray(testOrderIds) ||
      testOrderIds.length === 0 ||
      testOrderIds.some((orderId) => typeof orderId !== "string")
    ) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "At least one test order ID is required",
      });
    }
    if (!preview && (typeof reason !== "string" || !reason.trim())) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "A cancellation reason is required",
      });
    }

    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        bill: { include: { transactions: true } },
        testOrders: true,
        patient: { select: { name: true } },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }
    if (!visit.bill) {
      return res.status(400).json({
        error: "BILL_NOT_FOUND",
        message: "No bill found for this diagnostic visit",
      });
    }

    const bill = visit.bill;
    const targetIdSet = new Set<string>(testOrderIds);
    const targets = visit.testOrders.filter((order) =>
      targetIdSet.has(order.id),
    );
    if (targets.length !== targetIdSet.size) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Some test orders do not belong to this visit",
      });
    }
    if (targets.some((order) => order.cancelledAt)) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Some of the selected tests are already cancelled",
      });
    }

    const current = computeBillFinancialsFromPersisted(bill);

    // Each order's cancellable charge is its price minus its proportional
    // share of the bill discount (so a discounted bill never over-refunds),
    // minus any charge already reversed on it.
    const discountAllocations = allocateBillDiscountAcrossOrders(
      visit.testOrders,
      current.discountAmountInPaise,
    );
    const perOrder = targets.map((order) => ({
      testOrderId: order.id,
      testName: order.testNameSnapshot,
      reversalInPaise: Math.max(
        0,
        order.priceInPaise -
          (discountAllocations.get(order.id) ?? 0) -
          order.reversedChargeInPaise,
      ),
    }));
    const totalReversalInPaise = perOrder.reduce(
      (sum, entry) => sum + entry.reversalInPaise,
      0,
    );
    if (totalReversalInPaise <= 0) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Nothing left to cancel on the selected tests",
      });
    }

    const nextReversedChargeInPaise =
      Math.max(0, bill.reversedChargeInPaise ?? 0) + totalReversalInPaise;
    const afterReversal = computeBillFinancialsFromPersisted({
      ...bill,
      reversedChargeInPaise: nextReversedChargeInPaise,
    });
    // Money to hand back = whatever the patient has paid beyond the new net.
    const refundInPaise = Math.max(
      0,
      current.paidAmountInPaise - afterReversal.netAmountInPaise,
    );

    const nextRefundedAmountInPaise =
      Math.max(0, bill.refundedAmountInPaise ?? 0) + refundInPaise;
    const nextPaidAmountInPaise = Math.max(
      0,
      Math.round(bill.paidAmountInPaise ?? 0) - refundInPaise,
    );
    const finalFinancials = computeBillFinancialsFromPersisted({
      ...bill,
      transactions: undefined,
      reversedChargeInPaise: nextReversedChargeInPaise,
      refundedAmountInPaise: nextRefundedAmountInPaise,
      paidAmountInPaise: nextPaidAmountInPaise,
    });

    const remainingActiveOrders = visit.testOrders.filter(
      (order) => !order.cancelledAt && !targetIdSet.has(order.id),
    );

    if (preview) {
      return res.json({
        preview: true,
        perOrder,
        totalReversalInPaise,
        refundInPaise,
        nextNetAmountInPaise: finalFinancials.netAmountInPaise,
        nextDueAmountInPaise: finalFinancials.dueAmountInPaise,
        nextPaymentStatus: finalFinancials.paymentStatus,
        cancelsWholeVisit: remainingActiveOrders.length === 0,
      });
    }

    const trimmedReason = String(reason).trim();
    const trimmedNote =
      typeof note === "string" && note.trim() ? note.trim() : null;
    const normalizedPaymentType = paymentType === "ONLINE" ? "ONLINE" : "CASH";
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      for (const entry of perOrder) {
        const order = targets.find((o) => o.id === entry.testOrderId)!;
        // Atomic claim: only cancel if still uncancelled. A concurrent refund
        // that already claimed this order (e.g. a double-tapped button) matches
        // 0 rows here, which aborts the whole transaction and prevents a
        // duplicate refund + double commission reversal. The row lock makes the
        // second request wait for the first to commit, then see cancelledAt set.
        const claimed = await tx.testOrder.updateMany({
          where: { id: order.id, cancelledAt: null },
          data: {
            reversedChargeInPaise:
              order.reversedChargeInPaise + entry.reversalInPaise,
            cancelledAt: now,
            cancelReason: trimmedReason,
          },
        });
        if (claimed.count !== 1) {
          const e: any = new Error(
            "Some of the selected tests were just cancelled by another action. Refresh and try again.",
          );
          e.code = "ORDER_ALREADY_CANCELLED";
          throw e;
        }
      }

      await tx.orderRefund.createMany({
        data: perOrder.map((entry) => ({
          billId: bill.id,
          visitId: visit.id,
          testOrderId: entry.testOrderId,
          branchId: visit.branchId,
          kind: "CANCEL" as const,
          amountInPaise: 0,
          chargeReversedInPaise: entry.reversalInPaise,
          reason: trimmedReason,
          note: trimmedNote,
          createdByUserId: req.user!.id,
        })),
      });

      if (refundInPaise > 0) {
        // Bill-level money-out event (overpayment across the cancelled orders).
        await tx.orderRefund.create({
          data: {
            billId: bill.id,
            visitId: visit.id,
            testOrderId: null,
            branchId: visit.branchId,
            kind: "REFUND",
            amountInPaise: refundInPaise,
            chargeReversedInPaise: 0,
            reason: trimmedReason,
            note: trimmedNote,
            paymentType: normalizedPaymentType,
            createdByUserId: req.user!.id,
          },
        });
        await tx.paymentTransaction.create({
          data: {
            billId: bill.id,
            amountInPaise: refundInPaise,
            paymentType: normalizedPaymentType,
            transactionType: "REFUND",
            collectedByUserId: req.user!.id,
          },
        });
      }

      await tx.bill.update({
        where: { id: bill.id },
        data: {
          reversedChargeInPaise: nextReversedChargeInPaise,
          paidAmountInPaise: nextPaidAmountInPaise,
          paymentStatus: finalFinancials.paymentStatus,
          ...(refundInPaise > 0
            ? {
                refundedAmountInPaise: nextRefundedAmountInPaise,
                refundReason: trimmedReason,
                refundedAt: now,
                refundedByUserId: req.user!.id,
              }
            : {}),
        },
      });

      if (remainingActiveOrders.length === 0) {
        await tx.visit.update({
          where: { id: visit.id },
          data: { status: "CANCELLED" },
        });
        // Whole visit voided → revoke every public link to it. Partial refunds
        // leave links live so the updated bill/report stays viewable.
        //  - bill token gates the bill PDF AND the /r/:token report gateway
        await tx.billAccessToken.updateMany({
          where: { visitId: visit.id, revokedAt: null },
          data: { revokedAt: now },
        });
        //  - report tokens gate the direct /reports/:token PDF (the QR on the report)
        const reportVersions = await tx.reportVersion.findMany({
          where: { report: { visitId: visit.id } },
          select: { id: true },
        });
        if (reportVersions.length > 0) {
          await tx.reportAccessToken.updateMany({
            where: {
              reportVersionId: { in: reportVersions.map((v) => v.id) },
              revokedAt: null,
            },
            data: { revokedAt: now },
          });
        }
      }
    });

    await logAction({
      branchId: visit.branchId,
      actionType: "UPDATE",
      entityType: "Bill",
      entityId: bill.id,
      userId: req.user?.id,
      newValues: {
        action: refundInPaise > 0 ? "ORDER_REFUND" : "ORDER_CANCEL",
        billNumber: visit.billNumber,
        patientId: visit.patientId,
        patientName: visit.patient?.name,
        testOrderIds: perOrder.map((entry) => entry.testOrderId),
        chargeReversedInPaise: totalReversalInPaise,
        refundedInPaise: refundInPaise,
        reason: trimmedReason,
        note: trimmedNote,
      },
    });

    // Cancelling can leave a visit with only films-only (noReportAt) orders and
    // nothing left to report — complete it so it doesn't strand in DRAFT.
    // (remainingActiveOrders counts a films-only order as "active", so the
    // CANCELLED flip above misses this case.) No-op when the visit was just set
    // CANCELLED or a live reportable order remains — the helper self-guards.
    let autoCompleted = false;
    if (remainingActiveOrders.length > 0) {
      const completion = await reevaluateVisitCompletion(visit.id, {
        userId: req.user?.id,
        branchId: visit.branchId,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      autoCompleted = completion.completed;
    }

    const updatedBill = await prisma.bill.findUnique({
      where: { id: bill.id },
      include: { transactions: true },
    });
    const billFinancials = buildBillFinancialResponse(updatedBill);

    return res.json({
      id: visit.id,
      status:
        remainingActiveOrders.length === 0
          ? "CANCELLED"
          : autoCompleted
            ? "COMPLETED"
            : visit.status,
      paymentStatus: updatedBill?.paymentStatus,
      refundInPaise,
      totalReversalInPaise,
      ...billFinancials,
    });
  } catch (err: any) {
    if (err?.code === "ORDER_ALREADY_CANCELLED") {
      return res.status(409).json({
        error: "ORDER_ALREADY_CANCELLED",
        message: err.message,
      });
    }
    console.error("Refund diagnostic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to process cancellation/refund",
    });
  }
});

// POST /api/visits/diagnostic/:id/correct-referral - Fix a wrongly-entered
// referring doctor (or set back to SELF). Re-freezes commission snapshots,
// audited with mandatory reason. The old link is soft-deleted (kept for
// history); any covering payout run is re-derived so its total matches.
router.post("/:id/correct-referral", async (req: AuthRequest, res) => {
  try {
    const { referralDoctorId, reason, note } = req.body;
    if (typeof reason !== "string" || !reason.trim()) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "A reason is required",
      });
    }
    const result = await changeVisitReferral({
      visitId: req.params.id,
      branchId: req.branchId!,
      referralDoctorId:
        typeof referralDoctorId === "string" && referralDoctorId
          ? referralDoctorId
          : null,
      reason: reason.trim(),
      note: typeof note === "string" && note.trim() ? note.trim() : null,
      userId: req.user!.id,
    });
    return res.json(result);
  } catch (err: any) {
    if (err instanceof CorrectionError) {
      return res.status(err.statusCode).json({
        error: err.errorCode,
        message: err.message,
      });
    }
    console.error("Correct referral error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to update referral",
    });
  }
});

// POST /api/visits/diagnostic/bulk-correct-referral - Convert many visits to
// SELF (or re-point them) in one call. Backs the "Make self" bulk action on a
// doctor's payout statement. Each visit runs through changeVisitReferral so the
// per-visit soft-delete, snapshot re-freeze, audit, and payout re-derive all
// apply; per-visit failures are collected, not fatal for the batch.
router.post("/bulk-correct-referral", async (req: AuthRequest, res) => {
  try {
    const { visitIds, referralDoctorId, reason, note } = req.body;
    if (!Array.isArray(visitIds) || visitIds.length === 0) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "At least one visit is required",
      });
    }
    if (typeof reason !== "string" || !reason.trim()) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "A reason is required",
      });
    }
    const resolvedDoctorId =
      typeof referralDoctorId === "string" && referralDoctorId
        ? referralDoctorId
        : null;
    const trimmedReason = reason.trim();
    const trimmedNote =
      typeof note === "string" && note.trim() ? note.trim() : null;

    const succeeded: string[] = [];
    const failed: { visitId: string; message: string }[] = [];
    // Sequential: each change re-derives payouts, so avoid racing on the same
    // ledger rows when several selected visits share a doctor+period.
    for (const visitId of visitIds) {
      if (typeof visitId !== "string" || !visitId) continue;
      try {
        await changeVisitReferral({
          visitId,
          branchId: req.branchId!,
          referralDoctorId: resolvedDoctorId,
          reason: trimmedReason,
          note: trimmedNote,
          userId: req.user!.id,
        });
        succeeded.push(visitId);
      } catch (err: any) {
        // NO_CHANGE (already Self / already this doctor) is a benign no-op.
        if (err instanceof CorrectionError && err.errorCode === "NO_CHANGE") {
          succeeded.push(visitId);
          continue;
        }
        const message =
          err instanceof CorrectionError ? err.message : "Failed to update";
        failed.push({ visitId, message });
      }
    }

    return res.json({
      data: {
        succeededCount: succeeded.length,
        failedCount: failed.length,
        succeeded,
        failed,
      },
    });
  } catch (err: any) {
    console.error("Bulk correct referral error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to update referrals",
    });
  }
});

// POST /api/visits/diagnostic/:id/swap-product - Replace a mistakenly billed
// product with a SAME-PRICE one (typo fixes). Money-neutral by construction;
// price changes must go through cancel/refund + add tests.
router.post("/:id/swap-product", async (req: AuthRequest, res) => {
  try {
    const { oldProductId, newProductId, reason, note } = req.body;
    if (typeof reason !== "string" || !reason.trim()) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "A reason is required",
      });
    }
    if (typeof oldProductId !== "string" || typeof newProductId !== "string") {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Both the billed product and its replacement are required",
      });
    }
    const result = await swapVisitProduct({
      visitId: req.params.id,
      branchId: req.branchId!,
      oldProductId,
      newProductId,
      reason: reason.trim(),
      note: typeof note === "string" && note.trim() ? note.trim() : null,
      userId: req.user!.id,
    });
    return res.json(result);
  } catch (err: any) {
    if (err instanceof CorrectionError) {
      return res.status(err.statusCode).json({
        error: err.errorCode,
        message: err.message,
      });
    }
    console.error("Swap product error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to swap the billed test",
    });
  }
});

// POST /api/visits/diagnostic/:id/tests - Add billable products to an existing,
// NOT-yet-finalized diagnostic visit (a post-billing add-on). All exploit gating
// (role, bill age, catalog-only price, HIGH audit) lives in addProductsToVisit so
// it holds regardless of caller. Surfaced only from Patient 360.
router.post("/:id/tests", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { productIds, note } = req.body;
    const ids = Array.isArray(productIds)
      ? productIds.filter((p: unknown): p is string => typeof p === "string")
      : [];
    if (ids.length === 0) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "At least one test is required",
      });
    }

    const result = await addProductsToVisit({
      visitId: id,
      branchId: req.branchId!,
      productIds: ids,
      userId: req.user!.id,
      userRole: req.user!.role,
      note: typeof note === "string" ? note : undefined,
    });

    return res.status(201).json({
      message: "Tests added successfully",
      addedCount: result.addedProductNames.length,
      addedProductNames: result.addedProductNames,
      addedAmount: result.addedAmountInPaise / 100,
      newTotal: result.newTotalInPaise / 100,
    });
  } catch (err: any) {
    if (err instanceof CorrectionError) {
      return res
        .status(err.statusCode)
        .json({ error: err.errorCode, message: err.message });
    }
    if (err instanceof ProductResolutionError) {
      return res
        .status(400)
        .json({ error: err.code, message: err.message, details: err.details });
    }
    console.error("Add tests to visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to add tests to visit",
    });
  }
});

// DELETE /api/visits/diagnostic/:id/tests/:testOrderId - Remove test from visit (E3-03)
// Tests can only be removed before report finalization
router.delete("/:id/tests/:testOrderId", async (req: AuthRequest, res) => {
  try {
    const { id, testOrderId } = req.params;

    // Get visit with report status
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        testOrders: {
          select: {
            id: true,
            visitId: true,
            testId: true,
            workflowMode: true,
            priceInPaise: true,
          },
        },
        bill: { include: { transactions: true } },
        report: {
          include: {
            versions: {
              where: { status: "FINALIZED" },
              take: 1,
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    // E3-03: Check if report is finalized
    const hasFinalized =
      visit.report?.versions && visit.report.versions.length > 0;
    if (hasFinalized) {
      return res.status(400).json({
        error: "REPORT_FINALIZED",
        message: "Cannot remove tests after report has been finalized",
      });
    }

    // Find the test order to remove
    const testOrder = visit.testOrders.find((to) => to.id === testOrderId);
    if (!testOrder) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Test order not found",
      });
    }

    // Must have at least one test remaining
    if (visit.testOrders.length <= 1) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Cannot remove the last test from a visit",
      });
    }

    // Block removal if it would leave the visit with no report-inclusion orders
    // (REPORTABLE or EXTERNAL_UPLOAD). A pure bill-only visit cannot reach the
    // result-entry/finalize flow that's already underway here.
    const targetIsReportInclusion =
      (testOrder.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
        DiagnosticWorkflowMode.REPORTABLE ||
      testOrder.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD;
    const reportInclusionOrderCount = visit.testOrders.filter(
      (order) =>
        (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
          DiagnosticWorkflowMode.REPORTABLE ||
        order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD,
    ).length;

    if (targetIsReportInclusion && reportInclusionOrderCount <= 1) {
      return res.status(400).json({
        error: "LAST_REPORTABLE_ORDER",
        message:
          "Cannot remove the last reportable / external-upload order from a diagnostic visit.",
      });
    }

    // Calculate new total
    const newTotalAmountInPaise =
      visit.totalAmountInPaise - testOrder.priceInPaise;
    let nextBillFinancials = null;
    try {
      nextBillFinancials = visit.bill
        ? recomputeBillFinancialsForSubtotal(visit.bill, newTotalAmountInPaise)
        : null;
    } catch (financialErr: any) {
      return res.status(400).json({
        error: "BILL_OVERPAID_AFTER_REMOVAL",
        message: financialErr.message,
      });
    }

    // Remove test order in a transaction
    await prisma.$transaction(async (tx) => {
      // Delete the test order
      await tx.testOrder.delete({
        where: { id: testOrderId },
      });

      // Update visit total
      await tx.visit.update({
        where: { id },
        data: { totalAmountInPaise: newTotalAmountInPaise },
      });

      // Update bill total
      await tx.bill.updateMany({
        where: { visitId: id },
        data: {
          totalAmountInPaise: newTotalAmountInPaise,
          ...(nextBillFinancials
            ? {
                discountAmountInPaise: nextBillFinancials.discountAmountInPaise,
                discountedByUserId:
                  nextBillFinancials.discountAmountInPaise > 0
                    ? req.user!.id
                    : null,
                paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
                paymentStatus: nextBillFinancials.paymentStatus,
              }
            : {}),
        },
      });
    });

    // Audit log for test removal
    await logAction({
      userId: req.user?.id!,
      actionType: "UPDATE",
      entityType: "VISIT",
      entityId: id,
      branchId: req.branchId!,
      oldValues: {
        testCount: visit.testOrders.length,
        totalAmountInPaise: visit.totalAmountInPaise,
      },
      newValues: {
        testCount: visit.testOrders.length - 1,
        totalAmountInPaise: newTotalAmountInPaise,
        removedTestOrderId: testOrderId,
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.json({
      message: "Test removed successfully",
      newTotal: newTotalAmountInPaise / 100,
    });
  } catch (err: any) {
    console.error("Remove test from visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to remove test from visit",
    });
  }
});

// POST /api/visits/diagnostic/:id/results - Save test results
router.post("/:id/results", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { results } = req.body;

    if (!results || !Array.isArray(results)) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Results array is required",
      });
    }

    // Get visit with report and test orders with their test (including children for panels)
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        report: {
          include: {
            versions: {
              where: { status: "DRAFT" },
              orderBy: { versionNum: "desc" },
              take: 1,
            },
          },
        },
        testOrders: {
          include: {
            test: {
              include: {
                derivedParameter: {
                  select: {
                    parameterName: true,
                    formula: true,
                    dependsOnTestCodes: true,
                  },
                },
                childTests: {
                  include: {
                    derivedParameter: {
                      select: {
                        parameterName: true,
                        formula: true,
                        dependsOnTestCodes: true,
                      },
                    },
                  },
                }, // Include child tests for panels
              },
            },
            testDefinition: {
              select: {
                id: true,
                code: true,
                name: true,
                displayOrder: true,
                formulaExpression: true,
                dependsOnCodes: true,
              },
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    // Allow result entry whenever the visit has anything that lands on the
    // entry screen (REPORTABLE values OR EXTERNAL_UPLOAD attachments).
    if (getReportInclusionOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not use result entry.",
      });
    }
    const reportableOrders = getReportableOrders(visit.testOrders);

    const draftVersion = visit.report?.versions[0];
    if (!draftVersion) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "No draft report version found",
      });
    }

    const payloadResultKey = (result: any): string =>
      result?.testOrderId
        ? `${result.testOrderId}:${result.testId}`
        : String(result?.testId ?? "");

    const manualDerivedOverrideResultKeys = new Set<string>(
      results
        .filter(
          (result: any) => result?.manualOverride === true && result?.testId,
        )
        .map(payloadResultKey),
    );
    const uniqueResults = Array.from(
      results.reduce((map: Map<string, any>, result: any) => {
        if (result?.testId) {
          map.set(payloadResultKey(result), result);
        }
        return map;
      }, new Map<string, any>()).values(),
    );

    type ResultContext = {
      testOrderId: string;
      testId: string;
      testDefinitionId: string | null;
      code: string;
    };
    const contextByOrderAndTest = new Map<string, ResultContext>();
    const unambiguousContextByTestId = new Map<string, ResultContext | null>();
    const testToDefIdMap = new Map<string, string>();
    const addResultContext = (
      testOrderId: string,
      testId: string,
      testDefinitionId: string | null,
      code: string,
    ) => {
      const context = { testOrderId, testId, testDefinitionId, code };
      contextByOrderAndTest.set(`${testOrderId}:${testId}`, context);
      const existing = unambiguousContextByTestId.get(testId);
      if (existing === undefined) {
        unambiguousContextByTestId.set(testId, context);
      } else if (existing && existing.testOrderId !== testOrderId) {
        unambiguousContextByTestId.set(testId, null);
      }
      if (testDefinitionId) {
        testToDefIdMap.set(testId, testDefinitionId);
      }
    };

    for (const testOrder of reportableOrders) {
      addResultContext(
        testOrder.id,
        testOrder.testId,
        testOrder.testDefinitionId ?? null,
        testOrder.testDefinition?.code ||
          testOrder.testCodeSnapshot ||
          testOrder.test.code,
      );

      if (testOrder.test.isPanel && testOrder.test.childTests) {
        for (const childTest of testOrder.test.childTests) {
          addResultContext(testOrder.id, childTest.id, null, childTest.code);
        }
      }
    }
    const resolveResultContext = (result: any): ResultContext | null => {
      if (result?.testOrderId) {
        return contextByOrderAndTest.get(`${result.testOrderId}:${result.testId}`) ?? null;
      }
      return unambiguousContextByTestId.get(result.testId) ?? null;
    };

    // Resolve age-aware reference ranges up front so each result's flag is written
    // in the SAME upsert below, instead of a second per-row update pass afterward.
    // Non-fatal: any failure falls back to the client-provided flag (prior behavior).
    let resolvedFlagRanges: Awaited<
      ReturnType<typeof resolveReferenceRanges>
    > | null = null;
    try {
      const flagPatient = await prisma.patient.findUnique({
        where: { id: visit.patientId },
        select: { yearOfBirth: true, dateOfBirth: true, gender: true },
      });
      if (flagPatient) {
        // Numeric results only (value, or a textValue that parses to a number).
        const testIdsForFlags = uniqueResults
          .filter((r: any) => {
            if (!r.testId) return false;
            let rawValue: string | number | null = null;
            if (r.value !== null && r.value !== undefined) rawValue = r.value;
            else if (r.textValue) rawValue = r.textValue;
            if (rawValue === null) return false;
            return !isNaN(parseFloat(String(rawValue)));
          })
          .map((r: any) => r.testId);
        if (testIdsForFlags.length > 0) {
          resolvedFlagRanges = await resolveReferenceRanges(
            testIdsForFlags,
            flagPatient.yearOfBirth,
            flagPatient.gender as any,
            undefined,
            flagPatient.dateOfBirth,
          );
        }
      }
    } catch (flagErr) {
      // Non-fatal: keep the client-provided flag, exactly as the old second pass did.
      console.warn("Auto-flag calculation warning:", flagErr);
      resolvedFlagRanges = null;
    }

    // Which parameters actually changed in THIS save — for the audit trail
    // ("who edited what in the report"), collected as we upsert/delete below.
    const editedTestCodes = new Set<string>();

    // Upsert test results
    await prisma.$transaction(async (tx) => {
      // Snapshot the draft's existing rows so we can skip no-op rewrites. Auto-save
      // re-sends the whole panel every tick; rewriting an unchanged row still burns a
      // tuple version. Nothing observes the write (TestResult has no updatedAt), so
      // skipping an identical row is invisible downstream.
      const existingRows = await tx.testResult.findMany({
        where: { reportVersionId: draftVersion.id },
        select: {
          testOrderId: true,
          testId: true,
          value: true,
          textValue: true,
          flag: true,
          notes: true,
          testDefinitionId: true,
          enteredByUserId: true,
          signerNameOverride: true,
          useSigningRule: true,
          selectedSigningDoctorId: true,
        },
      });
      const existingByKey = new Map(
        existingRows.map((r) => [`${r.testOrderId}:${r.testId}`, r]),
      );

      for (const result of uniqueResults) {
        const context = resolveResultContext(result);
        if (!context) {
          console.warn(
            `No unambiguous test order found for result testId=${result.testId} testOrderId=${result.testOrderId ?? "missing"}`,
          );
          continue;
        }
        const resultKey = `${context.testOrderId}:${context.testId}`;

        // Upsert this specific test result. The compound unique constraint
        // protects against two near-simultaneous auto/manual saves inserting
        // the same reportVersion/order/test row twice.
        const signerOverride =
          typeof result.signerNameOverride === "string" &&
          result.signerNameOverride.trim()
            ? result.signerNameOverride.trim()
            : null;
        // Narrative "use signing rule" checkbox: true = sign with the
        // department's SigningRule, false = typed name + consultant. null when
        // the client doesn't send it (non-narrative rows).
        const useSigningRuleChoice =
          typeof result.useSigningRule === "boolean" ? result.useSigningRule : null;
        // Pinned signing doctor for a multi-rule department (radiology). Only
        // meaningful when useSigningRule is true; ignored otherwise.
        const selectedSigningDoctorChoice =
          useSigningRuleChoice === true &&
          typeof result.selectedSigningDoctorId === "string" &&
          result.selectedSigningDoctorId.trim()
            ? result.selectedSigningDoctorId.trim()
            : null;
        const numericValue =
          result.value != null
            ? parseFloat(result.value)
            : result.textValue
              ? parseFloat(result.textValue)
              : NaN;
        const isText = isNaN(numericValue);
        const normalizedNotes = manualDerivedOverrideResultKeys.has(resultKey)
          ? DERIVED_MANUAL_OVERRIDE_NOTE
          : result.notes || null;
        // Prefer explicit textValue from frontend; fall back to notes for legacy clients.
        const textVal =
          result.textValue ||
          (isText ? normalizedNotes || String(result.value ?? "") : null);

        if (
          (result.value !== null && result.value !== undefined) ||
          textVal ||
          (normalizedNotes && normalizedNotes.trim()) ||
          signerOverride
        ) {
          // Fold the age-aware flag into this single upsert. The server-computed
          // flag wins when the value is abnormal; otherwise keep the client's flag —
          // identical to the old separate flag pass, but without a second write.
          let computedFlag: any = result.flag || null;
          if (resolvedFlagRanges && !isText) {
            const range = resolvedFlagRanges.get(context.testId);
            if (range) {
              const serverFlag = determineResultFlag(numericValue, range);
              if (serverFlag) computedFlag = serverFlag;
            }
          }

          const resultData = {
            value: isText ? null : numericValue,
            textValue: textVal || null,
            flag: computedFlag,
            notes: normalizedNotes,
            testDefinitionId: context.testDefinitionId,
            enteredByUserId: req.user!.id,
            signerNameOverride: signerOverride,
            useSigningRule: useSigningRuleChoice,
            selectedSigningDoctorId: selectedSigningDoctorChoice,
          };

          // Skip the write entirely when nothing about this row changed (the common
          // auto-save case). Conservative: any field differing, or no existing row,
          // falls through to the upsert — so a real edit is never dropped.
          const prev = existingByKey.get(resultKey);
          const unchanged =
            prev !== undefined &&
            prev.value === resultData.value &&
            prev.textValue === resultData.textValue &&
            prev.flag === resultData.flag &&
            prev.notes === resultData.notes &&
            prev.testDefinitionId === resultData.testDefinitionId &&
            prev.enteredByUserId === resultData.enteredByUserId &&
            prev.signerNameOverride === resultData.signerNameOverride &&
            prev.useSigningRule === resultData.useSigningRule &&
            prev.selectedSigningDoctorId === resultData.selectedSigningDoctorId;
          if (unchanged) continue;
          if (context.code) editedTestCodes.add(context.code);

          await tx.testResult.upsert({
            where: {
              reportVersionId_testOrderId_testId: {
                reportVersionId: draftVersion.id,
                testOrderId: context.testOrderId,
                testId: context.testId,
              },
            },
            update: resultData,
            create: {
              testOrderId: context.testOrderId,
              testId: context.testId,
              reportVersionId: draftVersion.id,
              ...resultData,
            },
          });
        } else if (existingByKey.has(resultKey)) {
          // Only issue the delete when a row actually exists to remove.
          if (context.code) editedTestCodes.add(context.code);
          await tx.testResult.deleteMany({
            where: {
              testOrderId: context.testOrderId,
              testId: context.testId,
              reportVersionId: draftVersion.id,
            },
          });
        }
      }

      // Update visit status to WAITING if still DRAFT or IN_PROGRESS
      if (visit.status === "DRAFT" || visit.status === "IN_PROGRESS") {
        await tx.visit.update({
          where: { id },
          data: { status: "WAITING" },
        });
      }
    });

    // Age-aware flags are now written inline with each result's upsert above
    // (see resolvedFlagRanges), so the separate second-pass flag update is gone.

    // --- Derived Parameters: auto-calculate formula-based values ---
    try {
      const latestDefinitionFormulasByCode =
        await loadLatestDefinitionFormulasByCode(
          reportableOrders.flatMap((testOrder) => [
            testOrder.testDefinition?.code ||
              testOrder.testCodeSnapshot ||
              testOrder.test.code,
            ...testOrder.test.childTests.map((child) => child.code),
          ]),
        );

      const resultsByTestCode = new Map<string, number>();
      for (const r of uniqueResults) {
        let rawValue: string | number | null = null;

        if (r.value !== null && r.value !== undefined) {
          rawValue = r.value;
        } else if (r.textValue) {
          rawValue = r.textValue;
        }

        if (rawValue === null) continue;

        const numericValue = parseFloat(String(rawValue));
        if (isNaN(numericValue)) continue;

        const context = resolveResultContext(r);
        if (context) {
          resultsByTestCode.set(context.code, numericValue);
        }
      }

      const derivedTargets: DerivedFormulaTarget[] = [];
      for (const testOrder of reportableOrders) {
        const orderCode =
          testOrder.testDefinition?.code ||
          testOrder.testCodeSnapshot ||
          testOrder.test.code;
        const latestOrderDefinition =
          latestDefinitionFormulasByCode.get(orderCode);
        const orderDerived = testOrder.testDefinition?.formulaExpression
          ? buildDerivedMetadata(
              testOrder.testDefinition.formulaExpression,
              testOrder.testDefinition.dependsOnCodes,
            )
          : testOrder.test.derivedParameter?.formula
            ? buildDerivedMetadata(
                testOrder.test.derivedParameter.formula,
                testOrder.test.derivedParameter.dependsOnTestCodes,
              )
            : buildDerivedMetadata(
                latestOrderDefinition?.formulaExpression,
                latestOrderDefinition?.dependsOnCodes,
              );

        if (
          orderDerived.isDerived &&
          orderDerived.formulaExpression &&
          orderDerived.dependsOnCodes
        ) {
          derivedTargets.push({
            testOrderId: testOrder.id,
            testId: testOrder.testId,
            testDefinitionId: testOrder.testDefinitionId ?? null,
            code: orderCode,
            parameterName:
              testOrder.testDefinition?.name ||
              testOrder.test.derivedParameter?.parameterName ||
              latestOrderDefinition?.name ||
              testOrder.testNameSnapshot ||
              testOrder.test.name,
            formula: orderDerived.formulaExpression,
            dependsOnCodes: orderDerived.dependsOnCodes,
            displayOrder:
              testOrder.testDefinition?.displayOrder ??
              latestOrderDefinition?.displayOrder ??
              testOrder.test.displayOrder ??
              0,
          });
        }

        for (const childTest of testOrder.test.childTests) {
          const latestChildDefinition = latestDefinitionFormulasByCode.get(
            childTest.code,
          );
          const childDerived = buildDerivedMetadata(
            childTest.derivedParameter?.formula ||
              latestChildDefinition?.formulaExpression,
            childTest.derivedParameter?.dependsOnTestCodes ||
              latestChildDefinition?.dependsOnCodes,
          );

          if (
            childDerived.isDerived &&
            childDerived.formulaExpression &&
            childDerived.dependsOnCodes
          ) {
            derivedTargets.push({
              testOrderId: testOrder.id,
              testId: childTest.id,
              testDefinitionId: null,
              code: childTest.code,
              parameterName:
                childTest.derivedParameter?.parameterName ||
                latestChildDefinition?.name ||
                childTest.name,
              formula: childDerived.formulaExpression,
              dependsOnCodes: childDerived.dependsOnCodes,
              displayOrder:
                latestChildDefinition?.displayOrder ??
                childTest.displayOrder ??
                0,
            });
          }
        }
      }

      const derivedResults = evaluateDerivedTargets(
        derivedTargets,
        resultsByTestCode,
      );

      if (derivedResults.length > 0) {
        const draftVer = visit.report?.versions[0];
        if (draftVer) {
          const patient = await prisma.patient.findUnique({
            where: { id: visit.patientId },
            select: { yearOfBirth: true, dateOfBirth: true, gender: true },
          });

          const derivedTestIds = derivedResults
            .filter((dr) => dr.value !== null)
            .map((dr) => dr.testId);

          const derivedRanges =
            patient && derivedTestIds.length > 0
              ? await resolveReferenceRanges(
                  derivedTestIds,
                  patient.yearOfBirth,
                  patient.gender as any,
                  testToDefIdMap.size > 0 ? testToDefIdMap : undefined,
                  patient.dateOfBirth,
                )
              : new Map();

          for (const dr of derivedResults) {
            const orderIdForDerived = dr.testOrderId ?? null;
            if (!orderIdForDerived) continue;

            const derivedResultKey = `${orderIdForDerived}:${dr.testId}`;
            if (manualDerivedOverrideResultKeys.has(derivedResultKey)) {
              continue;
            }

            if (dr.value === null) {
              await prisma.testResult.deleteMany({
                where: {
                  testOrderId: orderIdForDerived,
                  testId: dr.testId,
                  reportVersionId: draftVer.id,
                },
              });
              continue;
            }

            const derivedRange = derivedRanges.get(dr.testId);
            const derivedFlag = derivedRange
              ? determineResultFlag(dr.value, derivedRange)
              : null;
            const derivedData = {
              value: dr.value,
              textValue: null,
              flag: derivedFlag,
              notes: `${DERIVED_AUTO_NOTE_PREFIX}${dr.parameterName}`,
              testDefinitionId:
                dr.testDefinitionId ?? testToDefIdMap.get(dr.testId) ?? null,
              enteredByUserId: req.user!.id,
              signerNameOverride: null,
            };

            await prisma.testResult.upsert({
              where: {
                reportVersionId_testOrderId_testId: {
                  reportVersionId: draftVer.id,
                  testOrderId: orderIdForDerived,
                  testId: dr.testId,
                },
              },
              update: derivedData,
              create: {
                testOrderId: orderIdForDerived,
                testId: dr.testId,
                reportVersionId: draftVer.id,
                ...derivedData,
              },
            });
          }

          for (const manualResultKey of manualDerivedOverrideResultKeys) {
            const manualInput = uniqueResults.find(
              (result: any) => payloadResultKey(result) === manualResultKey,
            );
            const manualContext = manualInput ? resolveResultContext(manualInput) : null;

            if (!manualInput || !manualContext) {
              continue;
            }

            const numericValue =
              manualInput.value !== null && manualInput.value !== undefined
                ? parseFloat(manualInput.value)
                : manualInput.textValue
                  ? parseFloat(manualInput.textValue)
                  : NaN;

            if (isNaN(numericValue)) {
              await prisma.testResult.deleteMany({
                where: {
                  testOrderId: manualContext.testOrderId,
                  testId: manualContext.testId,
                  reportVersionId: draftVer.id,
                },
              });
              continue;
            }

            const manualRange = derivedRanges.get(manualContext.testId);
            const manualFlag = manualRange
              ? determineResultFlag(numericValue, manualRange)
              : null;
            const manualData = {
              value: numericValue,
              textValue: null,
              flag: manualFlag,
              notes: DERIVED_MANUAL_OVERRIDE_NOTE,
              testDefinitionId: manualContext.testDefinitionId,
              enteredByUserId: req.user!.id,
              signerNameOverride: null,
            };

            await prisma.testResult.upsert({
              where: {
                reportVersionId_testOrderId_testId: {
                  reportVersionId: draftVer.id,
                  testOrderId: manualContext.testOrderId,
                  testId: manualContext.testId,
                },
              },
              update: manualData,
              create: {
                testOrderId: manualContext.testOrderId,
                testId: manualContext.testId,
                reportVersionId: draftVer.id,
                ...manualData,
              },
            });
          }
        }
      }
    } catch (derivedErr) {
      // Non-fatal: log but don't fail the whole request
      console.warn("Derived parameter calculation warning:", derivedErr);
    }

    // Draft authorship (audit slice 3): record ONE audit row per (visit, author)
    // the first time a staff member saves results into this draft — deduped so
    // the auto-save firing on every keystroke, or 10 edited parameters, never
    // creates 10 rows. Surfaces in the Audit & Anomalies feed's "Report drafts"
    // category (who wrote / edited a report and left it). Best-effort: it runs
    // after the response and never blocks or fails the save.
    if (Array.isArray(results) && results.length > 0 && req.user?.id && req.branchId) {
      const branchId = req.branchId;
      const userId = req.user.id;
      const draftVersionId = draftVersion.id;
      void (async () => {
        try {
          const existing = await prisma.auditLog.findFirst({
            where: { branchId, entityType: "ReportDraft", entityId: id, userId },
            select: { id: true },
          });
          if (!existing) {
            await logAction({
              branchId,
              actionType: "UPDATE",
              entityType: "ReportDraft",
              entityId: id,
              userId,
              newValues: { reportVersionId: draftVersionId, kind: "draft-authorship" },
            });
          }
        } catch (auditErr) {
          console.warn("Draft authorship audit warning:", auditErr);
        }
      })();
    }

    // What changed in the report this save — one row listing the edited
    // parameters (not one per parameter). Answers "who edited what". Best-effort.
    // ponytail: one row per save; if aggressive auto-save makes it chatty,
    // collapse consecutive same-author saves into a session later.
    if (editedTestCodes.size > 0 && req.user?.id && req.branchId) {
      const changed = Array.from(editedTestCodes);
      void logAction({
        branchId: req.branchId,
        actionType: "UPDATE",
        entityType: "ReportDraft",
        entityId: id,
        userId: req.user.id,
        newValues: { kind: "result-edit", changed: changed.slice(0, 40), count: changed.length },
      }).catch((e) => console.warn("Result-edit audit warning:", e));
    }

    return res.json({ success: true });
  } catch (err: any) {
    console.error("Save test results error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to save test results",
    });
  }
});

// POST /api/visits/diagnostic/:id/collect-sample - Record sample collection and decrement stock
router.post("/:id/collect-sample", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;
    const userId = req.user!.id;

    // Fetch visit with test orders
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        testOrders: {
          include: {
            test: {
              select: {
                id: true,
                name: true,
                sampleType: true,
                isPanel: true,
                childTests: { select: { id: true } },
              },
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    const reportableOrders = getReportableOrders(visit.testOrders);
    if (reportableOrders.length === 0) {
      return res.json({
        success: true,
        status: visit.status,
        testsCollected: visit.testOrders.length,
        sampleTypes: [
          ...new Set(
            visit.testOrders.map((to) => to.test.sampleType).filter(Boolean),
          ),
        ],
        collectedAt: visit.createdAt,
      });
    }

    if (visit.status !== "DRAFT") {
      return res.status(400).json({
        error: "INVALID_STATUS",
        message: `Sample can only be collected when visit is in DRAFT status. Current status: ${visit.status}`,
      });
    }

    // Collect all test IDs (including panel children)
    const testIds: string[] = [];
    for (const to of reportableOrders) {
      testIds.push(to.testId);
      if (to.test.isPanel && to.test.childTests) {
        for (const child of to.test.childTests) {
          testIds.push(child.id);
        }
      }
    }

    // Update status in a transaction
    await prisma.$transaction(async (tx) => {
      // Move visit to IN_PROGRESS
      await tx.visit.update({
        where: { id },
        data: { status: "IN_PROGRESS" },
      });
    });

    // Audit log
    await logAction({
      actionType: "FINALIZE",
      entityType: "Visit",
      entityId: id,
      userId,
      branchId,
      newValues: {
        billNumber: visit.billNumber,
        testCount: testIds.length,
        sampleTypes: [
          ...new Set(
            reportableOrders
              .map((to: any) => to.test.sampleType)
              .filter(Boolean),
          ),
        ],
      },
    });

    return res.json({
      success: true,
      status: "IN_PROGRESS",
      testsCollected: testIds.length,
      sampleTypes: [
        ...new Set(
          reportableOrders.map((to) => to.test.sampleType).filter(Boolean),
        ),
      ],
    });
  } catch (err: any) {
    console.error("Collect sample error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to record sample collection",
    });
  }
});

// GET /api/visits/diagnostic/:id/report-snapshot - JSON snapshot for grouped screen preview
// Returns finalized frozen snapshot only for completed visits; partial releases
// keep the visit open, so preview should use the live draft snapshot.
router.get("/:id/report-snapshot", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: "DIAGNOSTICS" },
      select: {
        id: true,
        status: true,
        testOrders: {
          select: {
            workflowMode: true,
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({ error: "Visit not found" });
    }

    if (getReportInclusionOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not have a report snapshot.",
      });
    }

    if (visit.status === "COMPLETED") {
      const loaded = await loadFinalizedReportSnapshotForVisit(id);
      if (loaded.ok) {
        return res.json(loaded.snapshot);
      }
    }

    const snapshot = await buildEphemeralSnapshot(id);
    return res.json(snapshot);
  } catch (err: any) {
    console.error("Report snapshot error:", err);
    return res.status(500).json({
      error: "SNAPSHOT_FAILED",
      message: err.message || "Failed to load report snapshot",
    });
  }
});

// GET /api/visits/diagnostic/:id/preview-report - Generate ephemeral preview of the report
// Staff can see the actual branded report layout BEFORE finalizing (nothing is saved).
// Default response is the merged PDF (rendered base + appended external uploads), so
// the staff preview matches byte-for-byte what the patient receives. Pass ?format=html
// for the legacy HTML-only view (which does NOT show appended uploads).
router.get("/:id/preview-report", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const format = req.query.format === "html" ? "html" : "pdf";

    // Verify the visit belongs to this branch
    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: "DIAGNOSTICS" },
      select: {
        id: true,
        status: true,
        testOrders: {
          select: {
            workflowMode: true,
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({ error: "Visit not found" });
    }

    if (getReportInclusionOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not have a report preview.",
      });
    }

    // Optional per-test scoping passed by the partial-release selector so the
    // preview matches exactly what /release-partial will eventually ship.
    // Accepted as either repeated query params or a comma-separated list.
    const rawTestOrderIds = req.query.testOrderIds;
    const selectedTestOrderIds: string[] | null = Array.isArray(rawTestOrderIds)
      ? rawTestOrderIds.map(String)
      : typeof rawTestOrderIds === "string" && rawTestOrderIds.length > 0
        ? rawTestOrderIds.split(",").map((s) => s.trim()).filter(Boolean)
        : null;

    // Build ephemeral snapshot from live data (no persistence)
    const snapshot = await buildEphemeralSnapshot(id, { selectedTestOrderIds });
    const baseUrl = `${req.protocol}://${req.get("host")}`;

    if (format === "html") {
      const html = renderReportHtml(snapshot, { profile: "screen", baseUrl });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      return res.send(html);
    }

    // Default: merged PDF — same writer as the public download path so staff
    // preview matches what the patient downloads (rendered values + appended uploads).
    const pdfBuffer = await generateMergedReportPdf(snapshot, {
      mode: "digital",
      baseUrl,
      qrDataUrl: "", // QR encodes the public token which doesn't exist for drafts
      cache: false,  // never cache draft previews — they change as staff edits
    });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "inline");
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("Cache-Control", "no-store");
    return res.send(pdfBuffer);
  } catch (err: any) {
    console.error("Preview report error:", err);
    return res.status(500).json({
      error: "PREVIEW_FAILED",
      message: err.message || "Failed to generate report preview",
    });
  }
});

// GET /api/visits/diagnostic/:id/finalized-report - Staff-only HTML view of the finalized report
router.get("/:id/finalized-report", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const loaded = await loadFinalizedReportSnapshotForVisit(id);

    if (!loaded.ok) {
      return res.status(loaded.status).json({
        error: loaded.error,
        message: loaded.message,
      });
    }

    const autoPrint = req.query.print === "true";
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const qrDataUrl = autoPrint
      ? await QRCode.toDataURL(
          `${baseUrl}/reports/${await createAccessToken(loaded.reportVersionId)}`,
          {
            width: 100,
            margin: 1,
            color: { dark: "#000000", light: "#ffffff" },
          },
        )
      : "";

    const html = renderReportHtml(loaded.snapshot, {
      // Physical print uses pre-printed ledger paper, so the HTML must omit
      // the built-in report header/footer when the browser print dialog opens.
      profile: autoPrint ? "pdf-physical" : "screen",
      baseUrl,
      qrDataUrl,
      // Stamp the moment of this print. Rendered on-demand (no-store), so it's
      // always accurate; only set on the actual print, never the screen view.
      printedAt: autoPrint ? new Date() : undefined,
    });
    const finalHtml = autoPrint
      ? html.replace(
          "</body>",
          "<script>window.onload=function(){setTimeout(function(){window.print()},600)}</script></body>",
        )
      : html;

    await recordAccessByReportVersionId(
      loaded.reportVersionId,
      autoPrint ? "PRINT" : "VIEW",
      req.ip,
      req.get("user-agent"),
      req.user?.id,
    );

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(finalHtml);
  } catch (err: any) {
    console.error("Finalized report view error:", err);
    return res.status(500).json({
      error: "GENERATION_FAILED",
      message: "Failed to generate finalized report view",
    });
  }
});

// GET /api/visits/diagnostic/:id/finalized-report/pdf - Staff-only finalized report PDF
router.get("/:id/finalized-report/pdf", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const mode = req.query.mode === "physical" ? "physical" : "digital";
    const loaded = await loadFinalizedReportSnapshotForVisit(id);

    if (!loaded.ok) {
      return res.status(loaded.status).json({
        error: loaded.error,
        message: loaded.message,
      });
    }

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const reportToken = await createAccessToken(loaded.reportVersionId);
    const reportUrl = `${baseUrl}/reports/${reportToken}`;
    const qrDataUrl = await QRCode.toDataURL(reportUrl, {
      width: 100,
      margin: 1,
      color: { dark: "#000000", light: "#ffffff" },
    });

    // Use the merged-PDF writer so any external uploads attached to this visit
    // are included in the staff download/print, with the Sobhana band overlaid
    // on every appended page. Cache is keyed on reportVersionId so finalize
    // path and staff-download path share the same cached bytes.
    const pdfBuffer = await generateMergedReportPdf(loaded.snapshot, {
      mode,
      baseUrl,
      qrDataUrl,
      cache: true,
    });

    await recordAccessByReportVersionId(
      loaded.reportVersionId,
      mode === "physical" ? "PRINT" : "DOWNLOAD",
      req.ip,
      req.get("user-agent"),
      req.user?.id,
    );

    const filename =
      mode === "physical"
        ? `Report-${loaded.billNumber}-print.pdf`
        : `Report-${loaded.billNumber}.pdf`;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdfBuffer.length);
    res.setHeader("Cache-Control", "no-store");
    return res.send(pdfBuffer);
  } catch (err: any) {
    console.error("Finalized report PDF error:", err);
    return res.status(500).json({
      error: "GENERATION_FAILED",
      message: "Failed to generate finalized report PDF",
    });
  }
});

// POST /api/visits/diagnostic/:id/confirm-ready - Legacy compatibility for older pure bill-only visits
router.post("/:id/confirm-ready", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        referrals: {
          where: { deletedAt: null },
          select: {
            referralDoctorId: true,
          },
        },
        diagnosticCenterReferrals: {
          select: {
            diagnosticCenterId: true,
          },
        },
        testOrders: {
          select: {
            workflowMode: true,
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    const composition = getVisitComposition(visit.testOrders, visit.status);
    // Only pure bill-only visits skip the entry/finalize flow. Visits with
    // REPORTABLE or EXTERNAL_UPLOAD orders must go through result entry first.
    if (composition.hasReportInclusionOrders || !composition.hasBillOnlyOrders) {
      return res.status(400).json({
        error: "REPORTABLE_VISIT",
        message: "This endpoint only applies to legacy pure bill-only visits.",
      });
    }

    if (visit.status === VisitStatus.COMPLETED) {
      return res.json({
        success: true,
        status: visit.status,
        hasReportableOrders: composition.hasReportableOrders,
        hasBillOnlyOrders: composition.hasBillOnlyOrders,
        hasFinalizedReport: false,
        nextAction: "NONE",
      });
    }

    const completedAt = new Date();

    await prisma.visit.update({
      where: { id },
      data: {
        status: VisitStatus.COMPLETED,
      },
    });

    await logAction({
      branchId: req.branchId!,
      actionType: "FINALIZE",
      entityType: "Visit",
      entityId: visit.id,
      userId: req.user?.id!,
      oldValues: {
        status: visit.status,
      },
      newValues: {
        status: VisitStatus.COMPLETED,
        visitId: visit.id,
        completionMode: "BILL_ONLY",
        completedAt: completedAt.toISOString(),
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    const periodStartDate = new Date(completedAt);
    periodStartDate.setHours(0, 0, 0, 0);
    const periodEndDate = new Date(completedAt);
    periodEndDate.setHours(23, 59, 59, 999);

    const payoutRefreshTasks: Array<Promise<unknown>> = [];
    const referralDoctorId = visit.referrals[0]?.referralDoctorId;
    const diagnosticCenterId =
      visit.diagnosticCenterReferrals[0]?.diagnosticCenterId;

    if (referralDoctorId) {
      payoutRefreshTasks.push(
        derivePayout(
          "REFERRAL",
          referralDoctorId,
          visit.branchId,
          periodStartDate,
          periodEndDate,
        ),
      );
    }

    if (diagnosticCenterId) {
      payoutRefreshTasks.push(
        derivePayout(
          "DIAGNOSTIC_CENTER",
          diagnosticCenterId,
          visit.branchId,
          periodStartDate,
          periodEndDate,
        ),
      );
    }

    if (payoutRefreshTasks.length > 0) {
      const refreshResults = await Promise.allSettled(payoutRefreshTasks);
      for (const result of refreshResults) {
        if (result.status === "rejected") {
          console.error(
            "Auto-refresh payout after bill-only completion failed:",
            result.reason,
          );
        }
      }
    }

    return res.json({
      success: true,
      status: VisitStatus.COMPLETED,
      hasReportableOrders: false,
      hasBillOnlyOrders: true,
      hasFinalizedReport: false,
      nextAction: "NONE",
      completedAt,
    });
  } catch (err: any) {
    console.error("Confirm bill-only ready error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to complete legacy bill-only visit",
    });
  }
});

// POST /api/visits/diagnostic/:id/mark-printed
// Stamp when the bill or finalized report was printed from the Finalized page,
// so the print icon turns green ("Printed · time") for every staffer/device.
// Purely a staff-facing signal — never touches report content or money.
router.post("/:id/mark-printed", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const kind = req.body?.kind;

    if (kind !== "bill" && kind !== "report") {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "kind must be 'bill' or 'report'",
      });
    }

    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: "DIAGNOSTICS" },
      select: { id: true },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    const updated = await prisma.visit.update({
      where: { id },
      data: kind === "bill" ? { billPrintedAt: new Date() } : { reportPrintedAt: new Date() },
      select: { billPrintedAt: true, reportPrintedAt: true },
    });

    return res.json({
      success: true,
      billPrintedAt: updated.billPrintedAt,
      reportPrintedAt: updated.reportPrintedAt,
    });
  } catch (err: any) {
    console.error("Mark visit printed error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to record print",
    });
  }
});

// POST /api/visits/diagnostic/:id/finalize - Finalize report
// Only the owner and lab incharge may finalize; staff/sales are read/entry only.
// POST /:id/orders/:orderId/no-report
// Close a single REPORTABLE test as "no written report needed" (films only):
// the patient decided the films are enough and doesn't want the narrative
// report. This is per-test (the rest of the bill is untouched) and MONEY-NEUTRAL
// — no refund, no cancel. The order then drops out of the entry screen, the
// report, and the finalize-completeness check (see getReportInclusionOrders /
// filterReportableOrders / the finalize incompleteOrders guard).
//
// IMPORTANT: this endpoint deliberately does NOT call sendReportReady(). Closing
// a test as film-only must never fire a "partial" or "final" WhatsApp/SMS —
// those only come from /finalize and /release-partial. Reversible via
// /reopen-report until the visit's report is finalized.
router.post("/:id/orders/:orderId/no-report", async (req: AuthRequest, res) => {
  try {
    const { id, orderId } = req.params;
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason.trim() : "";

    if (!reason) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message:
          'A short reason is required (e.g. "Films sufficient / patient declined report").',
      });
    }

    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: "DIAGNOSTICS" },
      select: {
        id: true,
        report: {
          select: {
            versions: {
              where: { status: "FINALIZED" },
              select: {
                id: true,
                panelsSnapshot: true,
                externalUploadsSnapshot: true,
              },
            },
          },
        },
        testOrders: {
          where: { id: orderId },
          select: {
            id: true,
            workflowMode: true,
            cancelledAt: true,
            noReportAt: true,
            uploadInsteadAt: true,
            testNameSnapshot: true,
          },
        },
      },
    });

    if (!visit) {
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Diagnostic visit not found" });
    }

    const order = visit.testOrders[0];
    if (!order) {
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Test not found on this visit" });
    }

    if (order.cancelledAt) {
      return res.status(400).json({
        error: "ORDER_CANCELLED",
        message: "This test was already cancelled.",
      });
    }

    // A report switched to "Upload instead" must be reverted to typing before it
    // can be closed as films-only — the two are mutually exclusive (upload-instead
    // sends a real report from the PDF; films-only sends nothing). This keeps the
    // order from ending up in a contradictory EXTERNAL_UPLOAD + noReportAt state.
    // (The UI already hides "No report needed" in upload mode; this guards the API.)
    if (order.uploadInsteadAt) {
      return res.status(400).json({
        error: "NOT_ELIGIBLE",
        message:
          'This report is set to "Upload instead". Switch it back to typing before closing it as no-report.',
      });
    }

    // Both REPORTABLE and EXTERNAL_UPLOAD orders (e.g. X-ray / imaging sent for
    // an external PDF) can be closed as film-only when the patient declines the
    // written report. BILL_ONLY orders never produce a report, so there is
    // nothing to waive.
    const mode = order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE;
    if (
      mode !== DiagnosticWorkflowMode.REPORTABLE &&
      mode !== DiagnosticWorkflowMode.EXTERNAL_UPLOAD
    ) {
      return res.status(400).json({
        error: "NOT_ELIGIBLE",
        message:
          'Only reportable or external-report tests can be closed as "no report needed".',
      });
    }

    // A partial report may already be FINALIZED for OTHER tests on this visit.
    // Waiving a still-open test is valid then — the finalize path is built for
    // exactly this ("last remaining test closed as films-only after a partial
    // report already went out", see /finalize). Only block when THIS order was
    // actually SHIPPED in a finalized report: it's already reported and can't be
    // retroactively waived.
    //
    // Inclusion is judged by the finalized report SNAPSHOT (what was actually
    // rendered/sent), NOT by TestResult.reportVersionId. A partial release scopes
    // its snapshot to the selected orders but can leave a deliberately held-back
    // test's result row tagged to the finalized version — so gating on the FK
    // wrongly blocks waiving a test that was excluded from the partial and never
    // shipped (e.g. a USG held for the radiologist while the CBC went out).
    const reportedOrderIds = new Set<string>();
    for (const version of visit.report?.versions ?? []) {
      collectSnapshotTestOrderIds(version.panelsSnapshot, reportedOrderIds);
      collectSnapshotTestOrderIds(
        version.externalUploadsSnapshot,
        reportedOrderIds,
      );
    }
    const orderAlreadyFinalized = reportedOrderIds.has(order.id);
    if (orderAlreadyFinalized) {
      return res.status(400).json({
        error: "ALREADY_FINALIZED",
        message:
          "This test is already finalized in a report and can't be closed as no-report.",
      });
    }

    if (order.noReportAt) {
      // Idempotent — already closed as no-report. A PRIOR call may have written
      // noReportAt but then failed to complete the visit (e.g. the completion
      // re-derivation below errored after this order was committed). Re-attempt
      // completion here so a transient failure can't leave the visit stranded in
      // DRAFT — reevaluateVisitCompletion is itself idempotent + race-safe.
      const completion = await reevaluateVisitCompletion(id, {
        userId: req.user?.id,
        branchId: req.branchId!,
        ip: req.ip,
        userAgent: req.get("user-agent"),
      });
      return res.json({
        success: true,
        alreadyNoReport: true,
        orderId: order.id,
        visitCompleted: completion.completed,
      });
    }

    const now = new Date();
    await prisma.testOrder.update({
      where: { id: order.id },
      data: {
        noReportAt: now,
        noReportReason: reason,
        noReportByUserId: req.user?.id ?? null,
        // Re-waiving supersedes any prior reopen trace (keeps the two states
        // mutually exclusive for display).
        reopenedAt: null,
        reopenedByUserId: null,
      },
    });

    await logAction({
      branchId: req.branchId!,
      actionType: "UPDATE",
      entityType: "TestOrder",
      entityId: order.id,
      userId: req.user?.id!,
      newValues: {
        noReport: true,
        reason,
        testName: order.testNameSnapshot,
        closedAt: now.toISOString(),
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    // Closing the LAST reportable/external order as films-only leaves nothing to
    // enter or finalize — complete the visit so it lands in Finalized instead of
    // stranding in DRAFT (invisible in both Pending and Finalized). No-op when
    // other reportable tests remain; the helper self-guards.
    const completion = await reevaluateVisitCompletion(id, {
      userId: req.user?.id,
      branchId: req.branchId!,
      ip: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.json({
      success: true,
      orderId: order.id,
      noReportAt: now.toISOString(),
      noReportReason: reason,
      visitCompleted: completion.completed,
    });
  } catch (error) {
    console.error("Error closing test as no-report:", error);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to close test as no report needed",
    });
  }
});

// POST /:id/orders/:orderId/reopen-report
// Undo a "no report needed" closure while the visit is still open (no finalized
// report yet). The test returns to the entry screen / report / finalize check.
router.post("/:id/orders/:orderId/reopen-report", async (req: AuthRequest, res) => {
  try {
    const { id, orderId } = req.params;

    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: "DIAGNOSTICS" },
      select: {
        id: true,
        status: true,
        report: {
          select: {
            id: true,
            versions: {
              orderBy: { versionNum: "desc" },
              select: { id: true, status: true, versionNum: true },
            },
          },
        },
        testOrders: {
          select: {
            id: true,
            noReportAt: true,
            cancelledAt: true,
            workflowMode: true,
            testNameSnapshot: true,
          },
        },
      },
    });

    if (!visit) {
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Diagnostic visit not found" });
    }

    const order = visit.testOrders.find((o) => o.id === orderId);
    if (!order) {
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Test not found on this visit" });
    }

    if (!order.noReportAt) {
      // Idempotent — already open.
      return res.json({ success: true, alreadyOpen: true, orderId: order.id });
    }

    // A films-only ("no report needed") order is never part of a FINALIZED
    // version, so reopening one is always safe — even after the visit's report
    // was finalized. Reopening then re-issues the test as a follow-up version:
    // e.g. CRP shipped in v1, an X-ray was waived and later reopened → it ships
    // in v2 with its own WhatsApp, without re-notifying CRP. Hence no
    // "already finalized" block here (unlike the earlier design).
    const versions = visit.report?.versions ?? [];
    const latestVersion = versions[0]; // ordered by versionNum desc
    const latestFinalized = versions.find((v) => v.status === "FINALIZED");
    const hasOpenDraft = versions.some((v) => v.status === "DRAFT");
    const reportId = visit.report?.id;

    // Reopening restores a live report-inclusion order. If the visit had been
    // completed (every reportable/external test was waived, or the rest were
    // already finalized), it must return to the entry queue or it never
    // resurfaces in Pending Results (which lists DRAFT + WAITING).
    const ordersAfterReopen = visit.testOrders.map((o) =>
      o.id === order.id ? { ...o, noReportAt: null } : o,
    );
    const reentersEntryQueue =
      visit.status === "COMPLETED" &&
      getReportInclusionOrders(ordersAfterReopen).length > 0;

    // When every version is already FINALIZED (no open draft), open the NEXT
    // draft and carry forward the last finalized results — mirroring
    // /release-partial — so (a) the entry screen has a draft to write the
    // reopened test into and (b) finalize sees the already-sent tests as
    // complete (its completeness check reads only the current draft). Without
    // this, entering the reopened test would fail ("No draft report version
    // found") and finalize would wrongly flag the already-sent tests as
    // incomplete.
    const needsCarryForwardDraft =
      !hasOpenDraft && !!latestFinalized && !!reportId && !!latestVersion;

    await prisma.$transaction(async (tx) => {
      await tx.testOrder.update({
        where: { id: order.id },
        data: {
          noReportAt: null,
          noReportReason: null,
          noReportByUserId: null,
          // Leave an audit trace of the reversal (surfaced in Patient 360 + the
          // owner audit feed).
          reopenedAt: new Date(),
          reopenedByUserId: req.user?.id ?? null,
        },
      });

      if (reentersEntryQueue) {
        await tx.visit.update({ where: { id }, data: { status: "DRAFT" } });
      }

      if (needsCarryForwardDraft && reportId && latestFinalized && latestVersion) {
        const carryForward = await tx.testResult.findMany({
          where: { reportVersionId: latestFinalized.id },
          select: {
            testOrderId: true,
            testId: true,
            value: true,
            textValue: true,
            flag: true,
            notes: true,
            testDefinitionId: true,
            enteredByUserId: true,
            signerNameOverride: true,
            useSigningRule: true,
            selectedSigningDoctorId: true,
          },
        });
        const nextDraft = await tx.reportVersion.create({
          data: {
            reportId,
            versionNum: latestVersion.versionNum + 1,
            status: "DRAFT",
          },
        });
        if (carryForward.length > 0) {
          await tx.testResult.createMany({
            data: carryForward.map((r) => ({
              ...r,
              reportVersionId: nextDraft.id,
            })),
          });
        }
      }
    });

    await logAction({
      branchId: req.branchId!,
      actionType: "UPDATE",
      entityType: "TestOrder",
      entityId: order.id,
      userId: req.user?.id!,
      newValues: {
        noReport: false,
        reopened: true,
        testName: order.testNameSnapshot,
        ...(reentersEntryQueue ? { visitStatus: "DRAFT" } : {}),
        ...(needsCarryForwardDraft
          ? { openedNextDraftVersion: (latestVersion?.versionNum ?? 0) + 1 }
          : {}),
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.json({
      success: true,
      orderId: order.id,
      ...(reentersEntryQueue ? { status: "DRAFT" } : {}),
    });
  } catch (error) {
    console.error("Error reopening no-report test:", error);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to reopen test",
    });
  }
});

// POST /:id/orders/:orderId/switch-to-upload
// "Upload instead": switch a REPORTABLE narrative/text report to being fulfilled
// by an uploaded PDF (an outside radiologist's report) rather than a typed one.
// This flips the order's workflowMode to EXTERNAL_UPLOAD, reusing the entire
// external-upload pipeline verbatim (upload zone -> snapshot -> merged PDF -> QR
// -> report-ready WhatsApp). UNLIKE "no report needed" (films-only, which stays
// silent), the patient still receives a REAL report — sourced from the uploaded
// PDF instead of typed text. Instant and reversible via /revert-to-typed until
// the order is finalized into a report.
//
// Any half-typed draft is KEPT (not deleted): while the order is EXTERNAL_UPLOAD
// it's inert — filterReportableOrders / the finalize completeness gate ignore it
// — and it is restored in the editor on toggle-back. Mirrors the /no-report guard
// order and audit shape; deliberately NOT role-gated (matches no-report).
router.post("/:id/orders/:orderId/switch-to-upload", async (req: AuthRequest, res) => {
  try {
    const { id, orderId } = req.params;

    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: "DIAGNOSTICS" },
      select: {
        id: true,
        report: {
          select: {
            versions: {
              where: { status: "FINALIZED" },
              select: {
                id: true,
                panelsSnapshot: true,
                externalUploadsSnapshot: true,
              },
            },
          },
        },
        testOrders: {
          where: { id: orderId },
          select: {
            id: true,
            workflowMode: true,
            cancelledAt: true,
            noReportAt: true,
            uploadInsteadAt: true,
            testNameSnapshot: true,
          },
        },
      },
    });

    if (!visit) {
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Diagnostic visit not found" });
    }

    const order = visit.testOrders[0];
    if (!order) {
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Test not found on this visit" });
    }

    if (order.cancelledAt) {
      return res.status(400).json({
        error: "ORDER_CANCELLED",
        message: "This test was already cancelled.",
      });
    }

    // Idempotent — already switched to upload. Gate on uploadInsteadAt so a
    // NATIVE external-upload product (EXTERNAL_UPLOAD but never switched) falls
    // through to the REPORTABLE-only eligibility check below and gets a proper
    // NOT_ELIGIBLE, rather than a misleading "alreadySwitched".
    if (
      order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD &&
      order.uploadInsteadAt
    ) {
      return res.json({
        success: true,
        alreadySwitched: true,
        orderId: order.id,
        workflowMode: "EXTERNAL_UPLOAD",
      });
    }

    // Only a typed (reportable) report can be switched to upload. BILL_ONLY /
    // EVENT orders never produce a typed report, so there's nothing to switch.
    const mode = order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE;
    if (mode !== DiagnosticWorkflowMode.REPORTABLE) {
      return res.status(400).json({
        error: "NOT_ELIGIBLE",
        message: "Only a typed (reportable) report can be switched to upload.",
      });
    }

    // Mutually exclusive with films-only: a "no report needed" order fires NO
    // patient message, whereas upload-instead DOES. Reopen it first.
    if (order.noReportAt) {
      return res.status(400).json({
        error: "NOT_ELIGIBLE",
        message:
          'This test is closed as "no report needed". Reopen it before switching to upload.',
      });
    }

    // Already-shipped guard — judged by the finalized report SNAPSHOT (what was
    // actually rendered/sent), NOT by TestResult.reportVersionId (a held-back
    // test in a partial release can carry the FK without ever shipping). A test
    // already reported to the patient can't have its fulfilment mode changed.
    const reportedOrderIds = new Set<string>();
    for (const version of visit.report?.versions ?? []) {
      collectSnapshotTestOrderIds(version.panelsSnapshot, reportedOrderIds);
      collectSnapshotTestOrderIds(
        version.externalUploadsSnapshot,
        reportedOrderIds,
      );
    }
    if (reportedOrderIds.has(order.id)) {
      return res.status(400).json({
        error: "ALREADY_FINALIZED",
        message:
          "This test is already finalized in a report and can't be switched to upload.",
      });
    }

    const now = new Date();
    await prisma.testOrder.update({
      where: { id: order.id },
      data: {
        workflowMode: DiagnosticWorkflowMode.EXTERNAL_UPLOAD,
        uploadInsteadAt: now,
        uploadInsteadByUserId: req.user?.id ?? null,
      },
    });

    await logAction({
      branchId: req.branchId!,
      actionType: "UPDATE",
      entityType: "TestOrder",
      entityId: order.id,
      userId: req.user?.id!,
      newValues: {
        uploadInstead: true,
        fromWorkflowMode: mode,
        toWorkflowMode: "EXTERNAL_UPLOAD",
        testName: order.testNameSnapshot,
        switchedAt: now.toISOString(),
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.json({
      success: true,
      orderId: order.id,
      workflowMode: "EXTERNAL_UPLOAD",
      uploadInsteadAt: now.toISOString(),
    });
  } catch (error) {
    console.error("Error switching test to upload:", error);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to switch test to upload",
    });
  }
});

// POST /:id/orders/:orderId/revert-to-typed
// Undo "Upload instead": flip the order back to REPORTABLE so the doctor types
// the report again. Only a SWITCHED order (uploadInsteadAt set) can revert — a
// product born EXTERNAL_UPLOAD stays an upload. Valid only before the order is
// finalized into a report. The kept draft narrative reappears in the editor; any
// attached PDFs are left in place but become inert (buildExternalUploadSnapshots
// only bakes EXTERNAL_UPLOAD orders) and reappear if the operator switches again.
router.post("/:id/orders/:orderId/revert-to-typed", async (req: AuthRequest, res) => {
  try {
    const { id, orderId } = req.params;

    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: "DIAGNOSTICS" },
      select: {
        id: true,
        report: {
          select: {
            versions: {
              where: { status: "FINALIZED" },
              select: {
                id: true,
                panelsSnapshot: true,
                externalUploadsSnapshot: true,
              },
            },
          },
        },
        testOrders: {
          where: { id: orderId },
          select: {
            id: true,
            workflowMode: true,
            cancelledAt: true,
            uploadInsteadAt: true,
            testNameSnapshot: true,
          },
        },
      },
    });

    if (!visit) {
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Diagnostic visit not found" });
    }

    const order = visit.testOrders[0];
    if (!order) {
      return res
        .status(404)
        .json({ error: "NOT_FOUND", message: "Test not found on this visit" });
    }

    // Parity with switch-to-upload: don't mutate a cancelled order's mode.
    if (order.cancelledAt) {
      return res.status(400).json({
        error: "ORDER_CANCELLED",
        message: "This test was already cancelled.",
      });
    }

    // Only a report that was SWITCHED to upload can revert to typing. A native
    // external-upload product (no uploadInsteadAt) has no typed form to go back to.
    if (!order.uploadInsteadAt) {
      return res.status(400).json({
        error: "NOT_ELIGIBLE",
        message: "Only a report switched to upload can be reverted to typing.",
      });
    }

    // Same snapshot-inclusion guard as switch-to-upload: a shipped order is fixed.
    const reportedOrderIds = new Set<string>();
    for (const version of visit.report?.versions ?? []) {
      collectSnapshotTestOrderIds(version.panelsSnapshot, reportedOrderIds);
      collectSnapshotTestOrderIds(
        version.externalUploadsSnapshot,
        reportedOrderIds,
      );
    }
    if (reportedOrderIds.has(order.id)) {
      return res.status(400).json({
        error: "ALREADY_FINALIZED",
        message:
          "This test is already finalized in a report and can't be reverted.",
      });
    }

    await prisma.testOrder.update({
      where: { id: order.id },
      data: {
        workflowMode: DiagnosticWorkflowMode.REPORTABLE,
        uploadInsteadAt: null,
        uploadInsteadByUserId: null,
      },
    });

    await logAction({
      branchId: req.branchId!,
      actionType: "UPDATE",
      entityType: "TestOrder",
      entityId: order.id,
      userId: req.user?.id!,
      newValues: {
        uploadInstead: false,
        reverted: true,
        toWorkflowMode: "REPORTABLE",
        testName: order.testNameSnapshot,
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.json({
      success: true,
      orderId: order.id,
      workflowMode: "REPORTABLE",
    });
  } catch (error) {
    console.error("Error reverting test to typed:", error);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to revert test to typed",
    });
  }
});

router.post("/:id/finalize", requireRole("owner", "lab_incharge"), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        referrals: {
          where: { deletedAt: null },
          select: {
            referralDoctorId: true,
          },
        },
        diagnosticCenterReferrals: {
          select: {
            diagnosticCenterId: true,
          },
        },
        testOrders: {
          select: {
            id: true,
            testId: true,
            testNameSnapshot: true,
            testCodeSnapshot: true,
            workflowMode: true,
            noReportAt: true,
            test: {
              select: {
                isPanel: true,
                childTests: { select: { id: true } },
              },
            },
            externalUploads: {
              where: { deletedAt: null },
              select: { id: true },
              take: 1,
            },
          },
        },
        bill: { include: { transactions: true } },
        report: {
          include: {
            versions: {
              where: { status: "DRAFT" },
              orderBy: { versionNum: "desc" },
              take: 1,
              include: {
                testResults: {
                  select: {
                    testOrderId: true,
                    testId: true,
                    value: true,
                    textValue: true,
                    notes: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    const reportInclusionOrders = getReportInclusionOrders(visit.testOrders);
    if (reportInclusionOrders.length === 0) {
      // Nothing to include in a report. Two very different situations land here:
      //   1. Pure bill-only visit — no reportable/external test ever existed.
      //   2. Every reportable/external test was closed as "no report needed"
      //      (films only). This IS a valid completion: there is no report to
      //      build and — per product rule — NO message to the patient.
      const waivedReportableOrders = visit.testOrders.filter(
        (o) =>
          !!o.noReportAt &&
          ((o.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
            DiagnosticWorkflowMode.REPORTABLE ||
            o.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD),
      );

      if (waivedReportableOrders.length === 0) {
        return res.status(400).json({
          error: "BILL_ONLY_VISIT",
          message: "Pure bill-only visits do not use report finalization.",
        });
      }

      // Idempotent — already completed (e.g. double-click).
      if (visit.status === "COMPLETED") {
        return res.json({ success: true, status: "COMPLETED", noReport: true });
      }

      // Bill-due guard — same authoritative gate as the normal finalize path.
      // Owners may finalize with an outstanding due (business override); the
      // due stays on the bill. lab_incharge must still collect it first.
      if (visit.bill && req.user?.role !== "owner") {
        const billFinancials = computeBillFinancialsFromPersisted(visit.bill);
        if (billFinancials.dueAmountInPaise > 0) {
          return res.status(400).json({
            error: "BILL_DUE",
            message: `Cannot finalize while bill has due amount ₹${(billFinancials.dueAmountInPaise / 100).toFixed(2)}.`,
            dueAmountInPaise: billFinancials.dueAmountInPaise,
          });
        }
      }

      const completedAt = new Date();
      await prisma.visit.update({
        where: { id },
        data: { status: "COMPLETED" },
      });

      await logAction({
        branchId: req.branchId!,
        actionType: "FINALIZE",
        entityType: "Visit",
        entityId: visit.id,
        userId: req.user?.id!,
        newValues: {
          status: "COMPLETED",
          noReport: true,
          waivedOrderIds: waivedReportableOrders.map((o) => o.id),
          completedAt: completedAt.toISOString(),
        },
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
      });

      // Derive payouts exactly like the normal path — the referring doctor /
      // centre still earns on a films-only test (the close is money-neutral).
      const periodStartDate = new Date(completedAt);
      periodStartDate.setHours(0, 0, 0, 0);
      const periodEndDate = new Date(completedAt);
      periodEndDate.setHours(23, 59, 59, 999);
      const noReportPayoutTasks: Array<Promise<unknown>> = [];
      const noReportReferralDoctorId = visit.referrals[0]?.referralDoctorId;
      const noReportDiagnosticCenterId =
        visit.diagnosticCenterReferrals[0]?.diagnosticCenterId;
      if (noReportReferralDoctorId) {
        noReportPayoutTasks.push(
          derivePayout(
            "REFERRAL",
            noReportReferralDoctorId,
            visit.branchId,
            periodStartDate,
            periodEndDate,
          ),
        );
      }
      if (noReportDiagnosticCenterId) {
        noReportPayoutTasks.push(
          derivePayout(
            "DIAGNOSTIC_CENTER",
            noReportDiagnosticCenterId,
            visit.branchId,
            periodStartDate,
            periodEndDate,
          ),
        );
      }
      if (noReportPayoutTasks.length > 0) {
        const settled = await Promise.allSettled(noReportPayoutTasks);
        for (const r of settled) {
          if (r.status === "rejected") {
            console.error(
              "Auto-refresh payout after no-report completion failed:",
              r.reason,
            );
          }
        }
      }

      // Deliberately NO sendReportReady() — a films-only visit issues no report
      // and sends no report message to the patient.
      return res.json({ success: true, status: "COMPLETED", noReport: true });
    }

    // Owners may finalize with an outstanding due (business override); the due
    // stays on the bill. lab_incharge must still collect it before finalizing.
    if (visit.bill && req.user?.role !== "owner") {
      const billFinancials = computeBillFinancialsFromPersisted(visit.bill);
      if (billFinancials.dueAmountInPaise > 0) {
        return res.status(400).json({
          error: "BILL_DUE",
          message: `Cannot finalize report while bill has due amount ₹${(billFinancials.dueAmountInPaise / 100).toFixed(2)}.`,
          dueAmountInPaise: billFinancials.dueAmountInPaise,
        });
      }
    }

    const draftVersion = visit.report?.versions[0];
    if (!draftVersion) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "No draft report version found",
      });
    }

    const meaningfulDraftResultKeys = new Set(
      draftVersion.testResults
        .filter(hasMeaningfulResultRow)
        .map((result) => `${result.testOrderId}:${result.testId}`),
    );
    const incompleteOrders = visit.testOrders.filter((order) => {
      const mode = order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE;

      // Orders closed as "no written report needed" (films only) don't block
      // finalize — same as cancelled orders, they're not part of the report.
      if (order.noReportAt) {
        return false;
      }

      if (mode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD) {
        return order.externalUploads.length === 0;
      }

      if (mode !== DiagnosticWorkflowMode.REPORTABLE) {
        return false;
      }

      return getExpectedResultTestIds(order).some(
        (testId) => !meaningfulDraftResultKeys.has(`${order.id}:${testId}`),
      );
    });

    if (incompleteOrders.length > 0) {
      return res.status(400).json({
        error: "INCOMPLETE_REPORT",
        message:
          "Cannot finalize a complete report while some ordered tests are still pending. Release a partial report or enter the remaining results first.",
        pendingTestOrderIds: incompleteOrders.map((order) => order.id),
        pendingTests: incompleteOrders.map(
          (order) => order.testNameSnapshot || order.testCodeSnapshot || order.id,
        ),
      });
    }

    // Compute — BEFORE we flip the current draft to FINALIZED — which orders
    // were already shipped to the patient in a prior FINALIZED (e.g. partial)
    // version. If this finalize adds nothing they haven't already received
    // (the only change since the last release was a films-only close), we stay
    // silent instead of firing a redundant "final" message.
    //
    // "Already shipped" is judged by what each prior finalized SNAPSHOT actually
    // rendered — NOT by TestResult.reportVersionId. A partial release can leave a
    // held-back test's result row tagged to the finalized version without ever
    // rendering it (see the /no-report guard). Using that FK here would count the
    // held-back test as already sent, so once it is finally reported (or reopened
    // then entered) this finalize would wrongly stay silent and the patient would
    // never be told their completed report is ready.
    const priorFinalizedVersions = await prisma.reportVersion.findMany({
      where: { reportId: visit.report!.id, status: "FINALIZED" },
      select: { panelsSnapshot: true, externalUploadsSnapshot: true },
    });
    const priorFinalizedOrderIds = new Set<string>();
    for (const version of priorFinalizedVersions) {
      collectSnapshotTestOrderIds(version.panelsSnapshot, priorFinalizedOrderIds);
      collectSnapshotTestOrderIds(
        version.externalUploadsSnapshot,
        priorFinalizedOrderIds,
      );
    }
    const shipsNewReportContent = reportInclusionOrders.some(
      (o) => !priorFinalizedOrderIds.has(o.id),
    );

    let accessToken: string | null = null;
    const finalizedAt = new Date();

    // JIRA-10: Atomic conditional update to prevent race conditions
    // Only finalize if status is still DRAFT (updateMany returns count=0 if condition not met)
    await prisma.$transaction(async (tx) => {
      const updated = await tx.reportVersion.updateMany({
        where: {
          id: draftVersion.id,
          status: "DRAFT", // Only update if still DRAFT
        },
        data: {
          status: "FINALIZED",
          finalizedAt,
        },
      });

      // If no rows updated, another request already finalized
      if (updated.count === 0) {
        throw new Error("ALREADY_FINALIZED");
      }

      await tx.visit.update({
        where: { id },
        data: { status: "COMPLETED" },
      });

      return updated;
    });

    // E3-10: Create snapshot and access token after successful finalization
    try {
      // Create immutable snapshot
      const snapshot = await createReportSnapshot(draftVersion.id);
      await saveReportSnapshot(draftVersion.id, snapshot);

      // Create access token for report URL
      accessToken = await createAccessToken(draftVersion.id);
    } catch (snapshotErr) {
      // Log but don't fail - snapshot can be recreated later
      console.error(
        "Failed to create snapshot/token (non-critical):",
        snapshotErr,
      );
    }

    // Audit log: Report finalization (CRITICAL)
    await logAction({
      branchId: req.branchId!,
      actionType: "FINALIZE",
      entityType: "Report",
      entityId: draftVersion.id,
      userId: req.user?.id!,
      oldValues: {
        status: "DRAFT",
      },
      newValues: {
        status: "FINALIZED",
        reportVersionId: draftVersion.id,
        visitId: visit.id,
        finalizedAt: finalizedAt.toISOString(),
        reportAccessIssued: !!accessToken,
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    const periodStartDate = new Date(finalizedAt);
    periodStartDate.setHours(0, 0, 0, 0);
    const periodEndDate = new Date(finalizedAt);
    periodEndDate.setHours(23, 59, 59, 999);

    const payoutRefreshTasks: Array<Promise<unknown>> = [];
    const referralDoctorId = visit.referrals[0]?.referralDoctorId;
    const diagnosticCenterId =
      visit.diagnosticCenterReferrals[0]?.diagnosticCenterId;

    if (referralDoctorId) {
      payoutRefreshTasks.push(
        derivePayout(
          "REFERRAL",
          referralDoctorId,
          visit.branchId,
          periodStartDate,
          periodEndDate,
        ),
      );
    }

    if (diagnosticCenterId) {
      payoutRefreshTasks.push(
        derivePayout(
          "DIAGNOSTIC_CENTER",
          diagnosticCenterId,
          visit.branchId,
          periodStartDate,
          periodEndDate,
        ),
      );
    }

    if (payoutRefreshTasks.length > 0) {
      const refreshResults = await Promise.allSettled(payoutRefreshTasks);
      for (const result of refreshResults) {
        if (result.status === "rejected") {
          console.error(
            "Auto-refresh payout after diagnostic finalization failed:",
            result.reason,
          );
        }
      }
    }

    // Fire-and-forget: Send report-ready notification via WhatsApp (non-blocking).
    // Skipped when this finalize ships nothing the patient hasn't already
    // received — e.g. the last remaining test was closed as films-only after a
    // partial report already went out.
    if (shipsNewReportContent) {
      import("../services/notificationService").then(({ sendReportReady }) => {
        sendReportReady(visit.id, accessToken || undefined, "final").catch((err) =>
          console.error(
            "[Notification] Report notification failed (non-blocking):",
            err.message,
          ),
        );
      });
    }

    return res.json({
      success: true,
      status: "COMPLETED",
      reportFinalizedAt: finalizedAt,
    });
  } catch (err: any) {
    // JIRA-10: Handle race condition gracefully
    if (err.message === "ALREADY_FINALIZED") {
      return res.status(409).json({
        error: "CONFLICT",
        message: "Report was already finalized by another request",
      });
    }
    console.error("Finalize report error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to finalize report",
    });
  }
});

// POST /api/visits/diagnostic/:id/release-partial
// Release the results that are ready now while leaving the visit open for
// remaining tests. Finalizes the current DRAFT version, creates a new DRAFT
// (carrying forward existing results), and sends the partial WhatsApp template.
// Visit stays in IN_PROGRESS/WAITING (NOT COMPLETED) and payout is NOT refreshed —
// both happen on the final /finalize call.
router.post("/:id/release-partial", requireRole("owner", "lab_incharge"), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        testOrders: {
          select: {
            id: true,
            workflowMode: true,
            externalUploads: {
              where: { deletedAt: null },
              select: { id: true },
              take: 1,
            },
            testResults: {
              select: { id: true, reportVersionId: true },
            },
          },
        },
        bill: { include: { transactions: true } },
        report: {
          include: {
            versions: {
              where: { status: "DRAFT" },
              orderBy: { versionNum: "desc" },
              take: 1,
              include: {
                testResults: true,
              },
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Diagnostic visit not found",
      });
    }

    if (getReportInclusionOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not use partial release.",
      });
    }

    if (!visit.report) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Report container not found for this visit",
      });
    }

    // Bill-due guard — same rule as /finalize. Backend is the authoritative
    // gate even if the frontend allows the click through. Owners may release
    // with an outstanding due (override); lab_incharge must collect it first.
    if (visit.bill && req.user?.role !== "owner") {
      const billFinancials = computeBillFinancialsFromPersisted(visit.bill);
      if (billFinancials.dueAmountInPaise > 0) {
        return res.status(400).json({
          error: "BILL_DUE",
          message: `Cannot release partial report while bill has due amount ₹${(billFinancials.dueAmountInPaise / 100).toFixed(2)}.`,
          dueAmountInPaise: billFinancials.dueAmountInPaise,
        });
      }
    }

    const draftVersion = visit.report.versions[0];
    if (!draftVersion) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "No draft report version found",
      });
    }

    // Partial-release pre-conditions: at least one report-inclusion order is ready
    // AND at least one report-inclusion order is still pending. Otherwise the
    // staff should be using /finalize (everything ready) or entering results
    // first (nothing ready yet).
    const reportableOrders = getReportableOrders(visit.testOrders);
    const externalUploadOrders = visit.testOrders.filter(
      (order) => order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD,
    );
    const reportInclusionOrders = getReportInclusionOrders(visit.testOrders);
    const draftResultOrderIds = new Set(
      draftVersion.testResults
        .filter(hasMeaningfulResultRow)
        .map((r) => r.testOrderId),
    );
    const readyExternalUploadOrderIds = new Set(
      externalUploadOrders
        .filter((order) => order.externalUploads.length > 0)
        .map((order) => order.id),
    );
    const readyReportableCount = reportableOrders.filter((o) =>
      draftResultOrderIds.has(o.id),
    ).length;
    const readyExternalUploadCount = externalUploadOrders.filter((o) =>
      readyExternalUploadOrderIds.has(o.id),
    ).length;
    const readyReportInclusionCount =
      readyReportableCount + readyExternalUploadCount;
    const pendingReportInclusionCount =
      reportInclusionOrders.length - readyReportInclusionCount;

    // Optional explicit selection from the entry-page partial-release dialog.
    // When provided, only these test orders go into the released version; the
    // rest stay in the next draft. Without it, behaviour is the legacy
    // "release every test order that has a draft result" — kept for
    // backwards compatibility with any caller that doesn't send the body.
    const requestedOrderIds: unknown = (req.body as Record<string, unknown> | undefined)
      ?.testOrderIds;
    const explicitSelection: string[] | null =
      Array.isArray(requestedOrderIds) &&
      requestedOrderIds.every((x) => typeof x === "string")
        ? (requestedOrderIds as string[])
        : null;

    if (explicitSelection) {
      const validVisitOrderIds = new Set(visit.testOrders.map((o) => o.id));
      const invalid = explicitSelection.filter((id) => !validVisitOrderIds.has(id));
      if (invalid.length > 0) {
        return res.status(400).json({
          error: "INVALID_TEST_ORDERS",
          message:
            "One or more selected test orders do not belong to this visit.",
          invalid,
        });
      }
      if (explicitSelection.length === 0) {
        return res.status(400).json({
          error: "NO_RESULTS_TO_RELEASE",
          message: "Select at least one test to release.",
        });
      }
    }

    // Effective set of order ids that will be shipped in the partial release.
    const defaultReleaseOrderIds = [
      ...Array.from(draftResultOrderIds),
      ...Array.from(readyExternalUploadOrderIds),
    ];
    const releaseOrderIds = new Set<string>(
      explicitSelection ?? defaultReleaseOrderIds,
    );

    // The "ready/pending" gating below uses the *effective* selection so
    // `release-partial` is a no-op when nothing would actually get released.
    const effectiveReadyReportableCount = reportableOrders.filter((o) =>
      releaseOrderIds.has(o.id) && draftResultOrderIds.has(o.id),
    ).length;
    const effectiveReadyExternalUploadCount = externalUploadOrders.filter((o) =>
      releaseOrderIds.has(o.id) && readyExternalUploadOrderIds.has(o.id),
    ).length;
    const effectiveReadyReportInclusionCount =
      effectiveReadyReportableCount + effectiveReadyExternalUploadCount;
    const effectivePendingReportInclusionCount =
      reportInclusionOrders.length - effectiveReadyReportInclusionCount;

    if (effectiveReadyReportInclusionCount === 0) {
      // Need at least one actual result row or uploaded external PDF to ship.
      // External-upload-only releases are valid with zero reportable rows, but
      // not with zero ready report-inclusion orders.
      return res.status(400).json({
        error: "NO_RESULTS_TO_RELEASE",
        message:
          "Enter results for at least one test before releasing a partial report.",
      });
    }

    if (!explicitSelection && effectivePendingReportInclusionCount === 0) {
      // Legacy callers (no explicit body) reaching this with nothing pending
      // shouldn't be running partial — caller should use /finalize. Explicit-
      // selection callers can have pending===0 legitimately when the user
      // ticked everything in the dialog: the preview page then routes to
      // /finalize (no body), so /release-partial bodies-with-everything
      // shouldn't happen in normal flow. If they do, we still proceed —
      // the worst case is a duplicate v2 DRAFT that staff can ignore.
      return res.status(400).json({
        error: "USE_FINALIZE_INSTEAD",
        message:
          "All reportable tests have results. Use Finalize Report to send the complete report.",
      });
    }

    let accessToken: string | null = null;
    let newDraftVersionId: string | null = null;
    const finalizedAt = new Date();

    await prisma.$transaction(async (tx) => {
      // 1. If a subset was requested, move the un-selected draft results out of
      //    the current draft *before* finalizing it. They land in a temporary
      //    holding area (the new DRAFT we create in step 3); the current
      //    draft then contains only the selected rows and can be finalized.
      const carryForwardData = dedupeResultRows(draftVersion.testResults); // snapshot before mutation
      if (explicitSelection) {
        const idsToRemoveFromDraft = draftVersion.testResults
          .filter((r) => !releaseOrderIds.has(r.testOrderId))
          .map((r) => r.id);
        if (idsToRemoveFromDraft.length > 0) {
          await tx.testResult.deleteMany({
            where: { id: { in: idsToRemoveFromDraft } },
          });
        }
      }

      // 2. Atomically finalize the current DRAFT (race-safe — same pattern as /finalize).
      const updated = await tx.reportVersion.updateMany({
        where: {
          id: draftVersion.id,
          status: "DRAFT",
        },
        data: {
          status: "FINALIZED",
          finalizedAt,
        },
      });

      if (updated.count === 0) {
        throw new Error("ALREADY_FINALIZED");
      }

      // 3. Create the next DRAFT version for incoming results.
      const nextVersion = await tx.reportVersion.create({
        data: {
          reportId: visit.report!.id,
          versionNum: draftVersion.versionNum + 1,
          status: "DRAFT",
        },
      });
      newDraftVersionId = nextVersion.id;

      // 4. Carry forward ALL original draft results (selected + unselected) so
      //    the next finalize() snapshot is cumulative AND the unselected
      //    template-only narratives stay editable in the new draft.
      if (carryForwardData.length > 0) {
        await tx.testResult.createMany({
          // Preserve the *original* entrant — these results were typed by the
          // earlier technician; the current user only triggered the re-version.
          data: carryForwardData.map((r) => ({
            testOrderId: r.testOrderId,
            testId: r.testId,
            reportVersionId: nextVersion.id,
            value: r.value,
            textValue: r.textValue,
            flag: r.flag,
            notes: r.notes,
            testDefinitionId: r.testDefinitionId,
            enteredByUserId: r.enteredByUserId,
            signerNameOverride: r.signerNameOverride,
            useSigningRule: r.useSigningRule,
            selectedSigningDoctorId: r.selectedSigningDoctorId,
          })),
        });
      }

      // NOTE: visit.status is intentionally NOT set to COMPLETED here.
      // The visit stays open so staff can keep entering results into
      // the new DRAFT version.
      await tx.visit.update({
        where: { id },
        data: { status: "WAITING" },
      });
    });

    // Snapshot + access token (outside the transaction, same pattern as
    // /finalize). When the staff explicitly excluded some orders via the
    // partial-release dialog, scope the snapshot to the selection so external
    // uploads tied to *unselected* orders (e.g. an MRI PDF the radiologist
    // held back) don't get baked into the finalized merged PDF — those
    // uploads stay on the test order and ship in a future version.
    try {
      const snapshot = await createReportSnapshot(draftVersion.id, {
        selectedTestOrderIds: explicitSelection ?? null,
      });
      await saveReportSnapshot(draftVersion.id, snapshot);
      accessToken = await createAccessToken(draftVersion.id);
    } catch (snapshotErr) {
      console.error(
        "Failed to create snapshot/token for partial release (non-critical):",
        snapshotErr,
      );
    }

    // Audit log — uses FINALIZE actionType (no schema migration) but newValues
    // marks this as a partial release for filtering/reporting.
    await logAction({
      branchId: req.branchId!,
      actionType: "FINALIZE",
      entityType: "Report",
      entityId: draftVersion.id,
      userId: req.user?.id!,
      oldValues: {
        status: "DRAFT",
      },
      newValues: {
        status: "FINALIZED",
        kind: "PARTIAL",
        reportVersionId: draftVersion.id,
        nextDraftVersionId: newDraftVersionId,
        visitId: visit.id,
        finalizedAt: finalizedAt.toISOString(),
        readyReportableCount: effectiveReadyReportableCount,
        pendingReportableCount:
          reportableOrders.length - effectiveReadyReportableCount,
        readyReportInclusionCount: effectiveReadyReportInclusionCount,
        pendingReportInclusionCount: effectivePendingReportInclusionCount,
        explicitSelection: explicitSelection ?? null,
        reportAccessIssued: !!accessToken,
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    // Fire-and-forget partial WhatsApp notification.
    import("../services/notificationService").then(({ sendReportReady }) => {
      sendReportReady(visit.id, accessToken || undefined, "partial").catch((err) =>
        console.error(
          "[Notification] Partial report notification failed (non-blocking):",
          err.message,
        ),
      );
    });

    return res.json({
      success: true,
      kind: "partial",
      finalizedVersionId: draftVersion.id,
      finalizedVersionNum: draftVersion.versionNum,
      nextDraftVersionId: newDraftVersionId,
      readyReportableCount: effectiveReadyReportableCount,
      pendingReportableCount:
        reportableOrders.length - effectiveReadyReportableCount,
      readyReportInclusionCount: effectiveReadyReportInclusionCount,
      pendingReportInclusionCount: effectivePendingReportInclusionCount,
      reportFinalizedAt: finalizedAt,
    });
  } catch (err: any) {
    if (err.message === "ALREADY_FINALIZED") {
      return res.status(409).json({
        error: "CONFLICT",
        message: "Report version was already finalized by another request",
      });
    }
    console.error("Release partial report error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to release partial report",
    });
  }
});

export default router;
