# File: src/routes/diagnosticVisits.ts (Part 1)

Lines 1–850 of 4146.

```ts
import { Router } from "express";
import QRCode from "qrcode";
import {
  DiagnosticWorkflowMode,
  ReportStatus,
  VisitStatus,
} from "@prisma/client";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import { branchContextMiddleware } from "../middleware/branch";
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
import { buildDiagnosticBillItems } from "../services/billItemService";
import {
  deriveDiagnosticVisitComposition,
  isPureBillOnlyVisit,
} from "../services/diagnosticWorkflowService";
import {
  areReferralPayoutsEqual,
  distributeFixedAmountInPaise,
  normalizeReferralOverrideInput,
  type NormalizedReferralPayout,
} from "../services/referralPayoutService";
import { derivePayout } from "../services/payoutService";
import {
  buildBillFinancialResponse,
  collectBillDue,
  computeBillFinancialsFromPersisted,
  normalizeBillFinancialInput,
  recomputeBillFinancialsForSubtotal,
} from "../services/billFinancialService";

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

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
  T extends { workflowMode?: DiagnosticWorkflowMode | null },
>(orders: T[]): T[] {
  return orders.filter(
    (order) =>
      (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
      DiagnosticWorkflowMode.REPORTABLE,
  );
}

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

// GET /api/visits/diagnostic - List diagnostic visits
// When patientId is provided: Returns ALL visits for that patient across ALL branches (Patient 360 view)
// When patientId is omitted: Returns visits for current branch only (daily operations)
router.get("/", async (req: AuthRequest, res) => {
  try {
    const { status, patientId } = req.query;

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

    const visits = await prisma.visit.findMany({
      where,
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        referrals: {
          include: {
            referralDoctor: true,
          },
        },
        testOrders: {
          include: {
            test: true,
          },
        },
        bill: { include: { transactions: true } },
        report: {
          include: {
            versions: {
              orderBy: { versionNum: "desc" },
              take: 1,
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    // Transform to frontend format
    const transformed = visits.map((v) => {
      const currentVersion = v.report?.versions[0] || null;
      const composition = getVisitComposition(
        v.testOrders,
        v.status,
        currentVersion ? [currentVersion] : [],
      );
      const billFinancials = buildBillFinancialResponse(v.bill);

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
        paymentStatus: v.bill?.paymentStatus || "PENDING",
        ...billFinancials,
        billedAt: v.bill?.billedAt || v.bill?.createdAt || null,
        reportFinalizedAt:
          currentVersion?.status === "FINALIZED"
            ? currentVersion.finalizedAt
            : null,
        hasReportableOrders: composition.hasReportableOrders,
        hasBillOnlyOrders: composition.hasBillOnlyOrders,
        hasExternalUploadOrders: composition.hasExternalUploadOrders,
        hasReportInclusionOrders: composition.hasReportInclusionOrders,
        hasEntryScreenOrders: composition.hasEntryScreenOrders,
        hasFinalizedReport: composition.hasFinalizedReport,
        nextAction: composition.nextAction,
        referralDoctorId: v.referrals[0]?.referralDoctorId || null,
        referralDoctor: v.referrals[0]?.referralDoctor || null,
        testOrders: v.testOrders.map((to) => ({
          id: to.id,
          visitId: to.visitId,
          testId: to.testId,
          productId: to.productId,
          testDefinitionId: to.testDefinitionId,
          workflowMode: to.workflowMode,
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
        })),
        report: v.report
          ? {
              id: v.report.id,
              currentVersion,
            }
          : null,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      };
    });

    return res.json(transformed);
  } catch (err: any) {
    console.error("List diagnostic visits error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to list diagnostic visits",
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

    const firstLabPanelItemByTestId = new Map<
      string,
      (typeof labPanelItems)[number]
    >();
    for (const panelItem of labPanelItems) {
      if (!firstLabPanelItemByTestId.has(panelItem.testId)) {
        firstLabPanelItemByTestId.set(panelItem.testId, panelItem);
      }
    }

    const testDefinitionIds = [
      ...new Set(
        rawTestOrders
          .map((order) => order.testDefinitionId)
          .filter((definitionId): definitionId is string =>
            Boolean(definitionId),
          ),
      ),
    ];

    const definitionPanelItems = testDefinitionIds.length
      ? await prisma.clinicalPanelItem.findMany({
          where: {
            testDefinitionId: {
              in: testDefinitionIds,
            },
          },
          orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
          select: {
            testDefinitionId: true,
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

    const firstDefinitionPanelItemByDefinitionId = new Map<
      string,
      (typeof definitionPanelItems)[number]
    >();
    for (const panelItem of definitionPanelItems) {
      if (
        !firstDefinitionPanelItemByDefinitionId.has(panelItem.testDefinitionId)
      ) {
        firstDefinitionPanelItemByDefinitionId.set(
          panelItem.testDefinitionId,
          panelItem,
        );
      }
    }

    const testOrders = rawTestOrders.map((order) => {
      const labPanelItem = firstLabPanelItemByTestId.get(order.testId);
```
