import { Router } from "express";

import QRCode from "qrcode";

import {
  DiagnosticWorkflowMode,
  ReportStatus,
  VisitStatus,
} from "@prisma/client";

import { authMiddleware, AuthRequest } from "../../middleware/auth";

import { branchContextMiddleware } from "../../middleware/branch";

import { generateDiagnosticBillNumber } from "../../services/numberService";

import { logAction } from "../../services/auditService";

import {
  evaluateDerivedTargets,
  normalizeDependencyCodes,
  type DerivedFormulaTarget,
} from "../../services/derivedParameterService";

import { resolveReferenceRanges } from "../../services/referenceRangeService";

import {
  createAccessToken,
  recordAccessByReportVersionId,
} from "../../services/reportAccessService";

import {
  buildEphemeralSnapshot,
  createReportSnapshot,
  getReportSnapshot,
  saveReportSnapshot,
} from "../../services/reportSnapshotService";

import {
  resolveProducts,
  ProductResolutionError,
} from "../../services/productOrderService";

import { renderReportHtml } from "../../services/reportRendererService";

import { generateMergedReportPdf } from "../../services/mergedReportPdfService";

import prisma from "../../lib/prisma";

import { buildDiagnosticBillItems } from "../../services/billItemService";

import {
  deriveDiagnosticVisitComposition,
  isPureBillOnlyVisit,
} from "../../services/diagnosticWorkflowService";

import {
  areReferralPayoutsEqual,
  distributeFixedAmountInPaise,
  normalizeReferralOverrideInput,
  type NormalizedReferralPayout,
} from "../../services/referralPayoutService";

import { derivePayout } from "../../services/payoutService";

import {
  buildBillFinancialResponse,
  collectBillDue,
  computeBillFinancialsFromPersisted,
  normalizeBillFinancialInput,
  recomputeBillFinancialsForSubtotal,
} from "../../services/billFinancialService";

export

type PayoutSnapshot = {
  commissionType: "PERCENTAGE" | "FIXED_AMOUNT";
  commissionPercentage: number | null;
  commissionAmountInPaise: number | null;
};

export

type OptionalPayoutSnapshot = {
  commissionType: "PERCENTAGE" | "FIXED_AMOUNT" | null;
  commissionPercentage: number | null;
  commissionAmountInPaise: number | null;
};

export

type ResolvedNumericRange = {
  referenceMin: number | null;
  referenceMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
};

export

type LatestDefinitionFormula = {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  formulaExpression: string | null;
  dependsOnCodes: unknown;
  rootDefinitionId: string;
};

export

const DERIVED_MANUAL_OVERRIDE_NOTE = "__DERIVED_MANUAL_OVERRIDE__";

export
const DERIVED_AUTO_NOTE_PREFIX = "Auto-calculated: ";

export

function zeroPayoutSnapshot(): PayoutSnapshot {
  return {
    commissionType: "PERCENTAGE",
    commissionPercentage: 0,
    commissionAmountInPaise: null,
  };
}

export

function emptyOptionalPayoutSnapshot(): OptionalPayoutSnapshot {
  return {
    commissionType: null,
    commissionPercentage: null,
    commissionAmountInPaise: null,
  };
}

export

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

export

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

export

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

export

function isManualDerivedOverrideNote(
  notes: string | null | undefined,
): boolean {
  return notes?.trim() === DERIVED_MANUAL_OVERRIDE_NOTE;
}

export

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

export

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

export

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

export

type TestInputConfigPayload = {
  inputType: 'NUMERIC' | 'FREE_TEXT' | 'TEXT_WITH_PRESETS' | 'SELECT_ONLY';
  defaultValue: string | null;
  valueOptions: string[];
};

export

const DEFAULT_INPUT_CONFIG: TestInputConfigPayload = {
  inputType: 'NUMERIC',
  defaultValue: null,
  valueOptions: [],
};

export

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

export

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

export

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

export

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

    return distributed.map((commissionAmountInPaise: number) => ({
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

export

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

export

async function loadFinalizedReportSnapshotForVisit(visitId: string) {
  const visit = await prisma.visit.findFirst({
    where: {
      id: visitId,
      domain: "DIAGNOSTICS",
    },
    select: {
      billNumber: true,
      tenantId: true,
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
    tenantId: visit.tenantId,
    reportVersionId,
    snapshot,
  };
}

export

function getVisitComposition<
  T extends { workflowMode?: DiagnosticWorkflowMode | null },
>(
  orders: T[],
  visitStatus: VisitStatus | string,
  versions: Array<{ status?: ReportStatus | null }> = [],
) {
  return deriveDiagnosticVisitComposition(orders, visitStatus, versions);
}

export

function getReportableOrders<
  T extends { workflowMode?: DiagnosticWorkflowMode | null },
>(orders: T[]): T[] {
  return orders.filter(
    (order) =>
      (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
      DiagnosticWorkflowMode.REPORTABLE,
  );
}

export

/** Orders that contribute to the patient-facing report (REPORTABLE or EXTERNAL_UPLOAD). */
function getReportInclusionOrders<
  T extends { workflowMode?: DiagnosticWorkflowMode | null },
>(orders: T[]): T[] {
  return orders.filter(
    (order) =>
      (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
        DiagnosticWorkflowMode.REPORTABLE ||
      order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD,
  );
}
