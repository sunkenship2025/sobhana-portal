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
import { generatePdfFromHtml } from "../services/pdfGenerationService";
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
        paymentType: Array.isArray((v as any).bill?.transactions) && (v as any).bill.transactions.length > 0 ? Array.from(new Set((v as any).bill.transactions.map((t: any) => t.paymentType))).join(", ") : null,
        paymentStatus: v.bill?.paymentStatus || "PENDING",
        ...billFinancials,
        billedAt: v.bill?.billedAt || v.bill?.createdAt || null,
        reportFinalizedAt:
          currentVersion?.status === "FINALIZED"
            ? currentVersion.finalizedAt
            : null,
        hasReportableOrders: composition.hasReportableOrders,
        hasBillOnlyOrders: composition.hasBillOnlyOrders,
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
      const definitionPanelItem = order.testDefinitionId
        ? firstDefinitionPanelItemByDefinitionId.get(order.testDefinitionId)
        : undefined;

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
        text: defaultText || "",
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
      paymentType: Array.isArray((visit as any).bill?.transactions) && (visit as any).bill.transactions.length > 0 ? Array.from(new Set((visit as any).bill.transactions.map((t: any) => t.paymentType))).join(", ") : null,
      paymentStatus: visit.bill?.paymentStatus || "PENDING",
      ...billFinancials,
      billedAt: visit.bill?.billedAt || visit.bill?.createdAt || null,
      reportFinalizedAt: latestFinalizedVersion?.finalizedAt || null,
      hasReportableOrders: composition.hasReportableOrders,
      hasBillOnlyOrders: composition.hasBillOnlyOrders,
      hasFinalizedReport: composition.hasFinalizedReport,
      nextAction: composition.nextAction,
      referralDoctorId: visit.referrals[0]?.referralDoctorId || null,
      referralDoctor: visit.referrals[0]?.referralDoctor || null,
      testOrders: visit.testOrders.map((to) => {
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
          referralCommissionType: to.referralCommissionType,
          referralCommissionPercent: to.referralCommissionPercentage,
          referralCommissionAmountInPaise: to.referralCommissionAmountInPaise,
          isPanel: to.test.isPanel,
          isDerived: orderDerived.isDerived,
          formulaExpression: orderDerived.formulaExpression,
          dependsOnCodes: orderDerived.dependsOnCodes,
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

                return {
                  id: ct.id,
                  name: ct.name,
                  code: ct.code,
                  displayOrder: ct.displayOrder,
                  isDerived: childDerived.isDerived,
                  formulaExpression: childDerived.formulaExpression,
                  dependsOnCodes: childDerived.dependsOnCodes,
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
      }),
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
      testIds,
      productIds,
      paymentType,
      discountType,
      discountValue,
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

    let defaultReferralRule: NormalizedReferralPayout | null = null;
    const referralRuleByProductId = new Map<string, NormalizedReferralPayout>();
    let defaultDiagnosticCenterRule: NormalizedReferralPayout | null = null;
    const diagnosticCenterRuleByProductId = new Map<
      string,
      NormalizedReferralPayout
    >();

    if (referralDoctorId) {
      const referralDoc = await prisma.referralDoctor.findUnique({
        where: { id: referralDoctorId },
        include: {
          productRules: {
            where: { isActive: true },
          },
        },
      });

      if (!referralDoc) {
        return res.status(400).json({
          error: "VALIDATION_ERROR",
          message: "Referral doctor not found",
        });
      }

      defaultReferralRule = {
        commissionType: referralDoc.commissionType,
        commissionPercent: referralDoc.commissionPercent,
        commissionAmountInPaise: referralDoc.commissionAmountInPaise,
      };

      for (const rule of referralDoc.productRules) {
        referralRuleByProductId.set(rule.productId, {
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
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
    }> = [];

    if (hasProducts) {
      // ── New architecture: resolve BillableProducts ──
      try {
        const resolved = await resolveProducts(productIds, req.branchId!);

        for (const rp of resolved) {
          const effectiveRule =
            overrides.get(rp.productId) ??
            referralRuleByProductId.get(rp.productId) ??
            defaultReferralRule;
          const effectiveDiagnosticCenterRule =
            diagnosticCenterOverrideMap.get(rp.productId) ??
            diagnosticCenterRuleByProductId.get(rp.productId) ??
            defaultDiagnosticCenterRule;
          const referralSnapshots = applyReferralRuleToPrices(
            rp.testOrders.map((to) => to.priceInPaise),
            effectiveRule,
          );
          const diagnosticCenterSnapshots = applyOptionalReferralRuleToPrices(
            rp.testOrders.map((to) => to.priceInPaise),
            effectiveDiagnosticCenterRule,
          );

          for (const [index, to] of rp.testOrders.entries()) {
            testOrderData.push({
              testId: to.labTestId,
              testDefinitionId: to.testDefinitionId,
              productId: to.productId,
              workflowMode: to.workflowMode,
              priceInPaise: to.priceInPaise,
              testNameSnapshot: to.testName,
              testCodeSnapshot: to.testCode,
              referenceMinSnapshot: to.referenceMin,
              referenceMaxSnapshot: to.referenceMax,
              referenceUnitSnapshot: to.referenceUnit,
              referralCommissionType: referralSnapshots[index].commissionType,
              referralCommissionPercentage:
                referralSnapshots[index].commissionPercentage,
              referralCommissionAmountInPaise:
                referralSnapshots[index].commissionAmountInPaise,
              diagnosticCenterCommissionType:
                diagnosticCenterSnapshots[index].commissionType,
              diagnosticCenterCommissionPercentage:
                diagnosticCenterSnapshots[index].commissionPercentage,
              diagnosticCenterCommissionAmountInPaise:
                diagnosticCenterSnapshots[index].commissionAmountInPaise,
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

      testOrderData = tests.map((test) => {
        const effectiveRule = overrides.get(test.id) ?? defaultReferralRule;
        const referralSnapshot = applyReferralRuleToPrices(
          [test.priceInPaise],
          effectiveRule,
        )[0];
        const diagnosticCenterSnapshot = applyOptionalReferralRuleToPrices(
          [test.priceInPaise],
          diagnosticCenterOverrideMap.get(test.id) ??
            defaultDiagnosticCenterRule,
        )[0];

        return {
          testId: test.id,
          workflowMode: DiagnosticWorkflowMode.REPORTABLE,
          priceInPaise: test.priceInPaise,
          testNameSnapshot: test.name,
          testCodeSnapshot: test.code,
          referenceMinSnapshot: test.referenceMin,
          referenceMaxSnapshot: test.referenceMax,
          referenceUnitSnapshot: test.referenceUnit,
          referralCommissionType: referralSnapshot.commissionType,
          referralCommissionPercentage: referralSnapshot.commissionPercentage,
          referralCommissionAmountInPaise:
            referralSnapshot.commissionAmountInPaise,
          diagnosticCenterCommissionType:
            diagnosticCenterSnapshot.commissionType,
          diagnosticCenterCommissionPercentage:
            diagnosticCenterSnapshot.commissionPercentage,
          diagnosticCenterCommissionAmountInPaise:
            diagnosticCenterSnapshot.commissionAmountInPaise,
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

    let billFinancials;
    try {
      billFinancials = normalizeBillFinancialInput(
        {
          totalAmountInPaise,
          discountType,
          discountValue,
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
    const initialVisitStatus = createComposition.hasReportableOrders
      ? VisitStatus.DRAFT
      : VisitStatus.COMPLETED;

    // Generate bill number
    const billNumber = await generateDiagnosticBillNumber(branch.code);

    // Create visit with all related records in a transaction
    const result = await prisma.$transaction(
      async (tx) => {
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
        await tx.bill.create({
          data: {
            visitId: visit.id,
            billNumber,
            branchId: req.branchId!,
            totalAmountInPaise,
            discountType: billFinancials.discountType,
            discountPercentage: billFinancials.discountPercentage,
            discountAmountInPaise: billFinancials.discountAmountInPaise,
            paidAmountInPaise: billFinancials.paidAmountInPaise,
            paymentStatus: billFinancials.paymentStatus,
            transactions:
              billFinancials.paidAmountInPaise > 0
                ? {
                    create:
                      Array.isArray(payments) && payments.length > 0
                        ? payments.map((p: any) => ({
                            amountInPaise: p.amountInPaise ?? Math.round((p.amount || 0) * 100),
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

            if (areReferralPayoutsEqual(override, defaultReferralRule)) {
              await tx.referralDoctorProductRule.deleteMany({
                where: {
                  referralDoctorId,
                  productId,
                },
              });
              continue;
            }

            await tx.referralDoctorProductRule.upsert({
              where: {
                referralDoctorId_productId: {
                  referralDoctorId,
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
          data: testOrderData.map((tod) => ({
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
            testNameSnapshot: tod.testNameSnapshot,
            testCodeSnapshot: tod.testCodeSnapshot,
            referenceMinSnapshot: tod.referenceMinSnapshot,
            referenceMaxSnapshot: tod.referenceMaxSnapshot,
            referenceUnitSnapshot: tod.referenceUnitSnapshot,
            testDefinitionId: tod.testDefinitionId ?? null,
            productId: tod.productId ?? null,
          })),
        });

        if (createComposition.hasReportableOrders) {
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

    if (!createComposition.hasReportableOrders) {
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
        referrals: { include: { referralDoctor: true } },
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

    // Fire-and-forget: Send bill confirmation via WhatsApp (non-blocking)
    if (sendWhatsApp) {
      import("../services/notificationService").then(
        ({ sendBillConfirmation }) => {
          sendBillConfirmation(result.id).catch((err) =>
            console.error(
              "[Notification] Bill notification failed (non-blocking):",
              err.message,
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
      paymentType: Array.isArray((completeVisit as any)!.bill?.transactions) && (completeVisit as any)!.bill.transactions.length > 0 ? Array.from(new Set(((completeVisit as any)!.bill.transactions as any[]).map((t) => t.paymentType))).join(", ") : null,
      paymentStatus: completeVisit!.bill?.paymentStatus || "PENDING",
      ...completeBillFinancials,
      billedAt:
        completeVisit!.bill?.billedAt || completeVisit!.bill?.createdAt || null,
      reportFinalizedAt: null,
      hasReportableOrders: createComposition.hasReportableOrders,
      hasBillOnlyOrders: createComposition.hasBillOnlyOrders,
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
        await tx.bill.updateMany({
          where: { visitId: id },
          data: {
            paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
            paymentStatus: nextBillFinancials.paymentStatus,
          },
        });

        // Record additive transaction for the newly paid amount
        const previousPaid = existing.bill?.paidAmountInPaise || 0;
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
      paymentType: Array.isArray((updated as any)!.bill?.transactions) && (updated as any)!.bill.transactions.length > 0 ? Array.from(new Set(((updated as any)!.bill.transactions as any[]).map((t) => t.paymentType))).join(", ") : null,
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
    const { amount, paymentType } = req.body;

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

    let nextBillFinancials;
    try {
      nextBillFinancials = collectBillDue(existing.bill, amount);
    } catch (validationErr: any) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: validationErr.message,
      });
    }

    const updated = await prisma.bill.update({
      where: { id: existing.bill.id },
      data: {
        paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
        paymentStatus: nextBillFinancials.paymentStatus,
        transactions: {
          create: {
            amountInPaise: Math.max(
              0,
              nextBillFinancials.paidAmountInPaise -
                existing.bill.paidAmountInPaise,
            ),
            paymentType: paymentType || "CASH",
            collectedByUserId: req.user!.id,
          },
        },
      },
    });

    const billFinancials = buildBillFinancialResponse(updated);

    return res.json({
      id: existing.id,
      status: existing.status,
      paymentType: Array.isArray((updated as any).transactions) && (updated as any).transactions.length > 0 ? Array.from(new Set(((updated as any).transactions as any[]).map((t) => t.paymentType))).join(", ") : null,
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

// POST /api/visits/diagnostic/:id/tests - Add tests to existing visit (E3-03)
// Tests can only be added before report finalization
router.post("/:id/tests", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { testIds } = req.body;

    // Validation
    if (!testIds || !Array.isArray(testIds) || testIds.length === 0) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "At least one test ID is required",
      });
    }

    // Get visit with report status
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        referrals: {
          include: {
            referralDoctor: true,
          },
        },
        diagnosticCenterReferrals: {
          include: {
            diagnosticCenter: true,
          },
        },
        testOrders: {
          select: {
            id: true,
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

    // E3-03: Check if report is finalized - cannot add tests after finalization
    const hasFinalized =
      visit.report?.versions && visit.report.versions.length > 0;
    if (hasFinalized) {
      return res.status(400).json({
        error: "REPORT_FINALIZED",
        message: "Cannot add tests after report has been finalized",
      });
    }

    if (isPureBillOnlyVisit(visit.testOrders)) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message:
          "Pure bill-only visits cannot be converted into reportable visits through add-tests.",
      });
    }

    // Check if any requested tests are already ordered
    const existingTestIds = visit.testOrders.map((to) => to.testId);
    const duplicateTests = testIds.filter((id: string) =>
      existingTestIds.includes(id),
    );
    if (duplicateTests.length > 0) {
      return res.status(400).json({
        error: "DUPLICATE_TESTS",
        message: "Some tests are already ordered for this visit",
        duplicateTestIds: duplicateTests,
      });
    }

    // Get tests with prices
    const tests = await prisma.labTest.findMany({
      where: { id: { in: testIds }, isActive: true },
    });

    if (tests.length !== testIds.length) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "One or more tests not found or inactive",
      });
    }

    const defaultReferralRule =
      visit.referrals.length > 0 && visit.referrals[0].referralDoctor
        ? {
            commissionType: visit.referrals[0].referralDoctor.commissionType,
            commissionPercent:
              visit.referrals[0].referralDoctor.commissionPercent,
            commissionAmountInPaise:
              visit.referrals[0].referralDoctor.commissionAmountInPaise,
          }
        : null;
    const defaultDiagnosticCenterRule =
      visit.diagnosticCenterReferrals.length > 0 &&
      visit.diagnosticCenterReferrals[0].diagnosticCenter
        ? {
            commissionType:
              visit.diagnosticCenterReferrals[0].diagnosticCenter
                .commissionType,
            commissionPercent:
              visit.diagnosticCenterReferrals[0].diagnosticCenter
                .commissionPercent,
            commissionAmountInPaise:
              visit.diagnosticCenterReferrals[0].diagnosticCenter
                .commissionAmountInPaise,
          }
        : null;

    // Calculate additional amount
    const additionalAmountInPaise = tests.reduce(
      (sum, t) => sum + t.priceInPaise,
      0,
    );
    const newTotalAmountInPaise =
      visit.totalAmountInPaise + additionalAmountInPaise;
    const nextBillFinancials = visit.bill
      ? recomputeBillFinancialsForSubtotal(visit.bill, newTotalAmountInPaise)
      : null;
    const referralSnapshots = tests.map(
      (test) =>
        applyReferralRuleToPrices([test.priceInPaise], defaultReferralRule)[0],
    );
    const diagnosticCenterSnapshots = tests.map(
      (test) =>
        applyOptionalReferralRuleToPrices(
          [test.priceInPaise],
          defaultDiagnosticCenterRule,
        )[0],
    );

    // Create test orders with metadata snapshot in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create test orders with snapshotted metadata (E3-03)
      await tx.testOrder.createMany({
        data: tests.map((test, index) => ({
          visitId: visit.id,
          testId: test.id,
          branchId: req.branchId!,
          workflowMode: DiagnosticWorkflowMode.REPORTABLE,
          priceInPaise: test.priceInPaise,
          referralCommissionType: referralSnapshots[index].commissionType,
          referralCommissionPercentage:
            referralSnapshots[index].commissionPercentage,
          referralCommissionAmountInPaise:
            referralSnapshots[index].commissionAmountInPaise,
          diagnosticCenterCommissionType:
            diagnosticCenterSnapshots[index].commissionType,
          diagnosticCenterCommissionPercentage:
            diagnosticCenterSnapshots[index].commissionPercentage,
          diagnosticCenterCommissionAmountInPaise:
            diagnosticCenterSnapshots[index].commissionAmountInPaise,
          testNameSnapshot: test.name,
          testCodeSnapshot: test.code,
          referenceMinSnapshot: test.referenceMin,
          referenceMaxSnapshot: test.referenceMax,
          referenceUnitSnapshot: test.referenceUnit,
        })),
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
                paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
                paymentStatus: nextBillFinancials.paymentStatus,
              }
            : {}),
        },
      });

      return tx.visit.findUnique({
        where: { id },
        include: {
          testOrders: {
            include: { test: true },
          },
          bill: { include: { transactions: true } },
        },
      });
    });

    // Audit log for test addition
    await logAction({
      userId: req.user?.id!,
      actionType: "UPDATE",
      entityType: "VISIT",
      entityId: id,
      branchId: req.branchId!,
      oldValues: {
        testCount: existingTestIds.length,
        totalAmountInPaise: visit.totalAmountInPaise,
      },
      newValues: {
        testCount: result!.testOrders.length,
        totalAmountInPaise: newTotalAmountInPaise,
        addedTestIds: testIds,
      },
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
    });

    return res.status(201).json({
      message: "Tests added successfully",
      addedCount: tests.length,
      newTotal: newTotalAmountInPaise / 100,
      testOrders: result!.testOrders.map((to) => ({
        id: to.id,
        testId: to.testId,
        testName: to.testNameSnapshot || to.test.name,
        testCode: to.testCodeSnapshot || to.test.code,
        price: to.priceInPaise / 100,
      })),
    });
  } catch (err: any) {
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

    const reportableOrderCount = visit.testOrders.filter(
      (order) =>
        (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
        DiagnosticWorkflowMode.REPORTABLE,
    ).length;

    if (
      (testOrder.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) ===
        DiagnosticWorkflowMode.REPORTABLE &&
      reportableOrderCount <= 1
    ) {
      return res.status(400).json({
        error: "LAST_REPORTABLE_ORDER",
        message:
          "Cannot remove the last reportable order from a diagnostic visit.",
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

    const reportableOrders = getReportableOrders(visit.testOrders);
    if (reportableOrders.length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not use result entry.",
      });
    }

    const draftVersion = visit.report?.versions[0];
    if (!draftVersion) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "No draft report version found",
      });
    }

    const manualDerivedOverrideTestIds = new Set<string>(
      results
        .filter(
          (result: any) => result?.manualOverride === true && result?.testId,
        )
        .map((result: any) => result.testId),
    );

    // Build a map: testId -> testOrderId (includes sub-tests)
    const testToOrderMap = new Map<string, string>();
    // Build a map: testId -> testDefinitionId (from testOrder, for new-arch linking)
    const testToDefIdMap = new Map<string, string>();
    for (const testOrder of reportableOrders) {
      // Map the ordered test itself
      testToOrderMap.set(testOrder.testId, testOrder.id);
      if (testOrder.testDefinitionId) {
        testToDefIdMap.set(testOrder.testId, testOrder.testDefinitionId);
      }
      // For panels, also map all child tests to the parent order
      if (testOrder.test.isPanel && testOrder.test.childTests) {
        for (const childTest of testOrder.test.childTests) {
          testToOrderMap.set(childTest.id, testOrder.id);
        }
      }
    }

    // Upsert test results
    await prisma.$transaction(async (tx) => {
      for (const result of results) {
        const testOrderId = testToOrderMap.get(result.testId);
        if (!testOrderId) {
          console.warn(`No test order found for testId: ${result.testId}`);
          continue;
        }

        // Delete existing result for this specific testId (not just testOrderId)
        await tx.testResult.deleteMany({
          where: {
            testOrderId,
            testId: result.testId,
            reportVersionId: draftVersion.id,
          },
        });

        // Create new result (either numeric value, textValue, or text notes)
        if (
          (result.value !== null && result.value !== undefined) ||
          result.textValue ||
          (result.notes && result.notes.trim())
        ) {
          const numericValue =
            result.value != null ? parseFloat(result.value) : NaN;
          const isText = isNaN(numericValue);
          const defId = testToDefIdMap.get(result.testId) ?? null;
          const normalizedNotes = manualDerivedOverrideTestIds.has(
            result.testId,
          )
            ? DERIVED_MANUAL_OVERRIDE_NOTE
            : result.notes || null;
          // Prefer explicit textValue from frontend; fall back to notes for legacy clients
          const textVal =
            result.textValue ||
            (isText ? normalizedNotes || String(result.value ?? "") : null);
          await tx.testResult.create({
            data: {
              testOrderId,
              testId: result.testId,
              reportVersionId: draftVersion.id,
              value: isText ? null : numericValue,
              textValue: textVal || null,
              flag: result.flag || null,
              notes: normalizedNotes,
              testDefinitionId: defId,
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

    // --- Auto-flag results with age-aware reference ranges ---
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: visit.patientId },
        select: { yearOfBirth: true, dateOfBirth: true, gender: true },
      });

      if (patient) {
        // Collect test IDs that had numeric values
        const flaggableResults = results.filter(
          (r: any) => r.value !== null && r.value !== undefined && r.testId,
        );
        const testIdsForFlags = flaggableResults.map((r: any) => r.testId);

        if (testIdsForFlags.length > 0) {
          const resolvedRanges = await resolveReferenceRanges(
            testIdsForFlags,
            patient.yearOfBirth,
            patient.gender as any,
            undefined,
            patient.dateOfBirth,
          );

          // Batch-update flags based on resolved ranges
          for (const r of flaggableResults) {
            const range = resolvedRanges.get(r.testId);
            if (!range) continue;

            const numValue = parseFloat(r.value);
            if (isNaN(numValue)) continue;

            const flag = determineResultFlag(numValue, range);

            if (flag) {
              const testOrderId = testToOrderMap.get(r.testId);
              if (testOrderId) {
                await prisma.testResult.updateMany({
                  where: {
                    testOrderId,
                    testId: r.testId,
                    reportVersionId: draftVersion.id,
                  },
                  data: { flag },
                });
              }
            }
          }
        }
      }
    } catch (flagErr) {
      // Non-fatal: log but don't fail the whole request
      console.warn("Auto-flag calculation warning:", flagErr);
    }

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
      for (const r of results) {
        if (r.value === null || r.value === undefined) continue;

        const numericValue = parseFloat(r.value);
        if (isNaN(numericValue)) continue;

        const testOrder = reportableOrders.find(
          (order) => order.testId === r.testId,
        );
        if (testOrder) {
          resultsByTestCode.set(
            testOrder.testDefinition?.code ||
              testOrder.testCodeSnapshot ||
              testOrder.test.code,
            numericValue,
          );
          continue;
        }

        for (const order of reportableOrders) {
          const childTest = order.test.childTests.find(
            (child) => child.id === r.testId,
          );
          if (childTest) {
            resultsByTestCode.set(childTest.code, numericValue);
            break;
          }
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
            const orderIdForDerived = testToOrderMap.get(dr.testId);
            if (!orderIdForDerived) continue;

            if (manualDerivedOverrideTestIds.has(dr.testId)) {
              continue;
            }

            // Upsert derived result
            await prisma.testResult.deleteMany({
              where: {
                testOrderId: orderIdForDerived,
                testId: dr.testId,
                reportVersionId: draftVer.id,
              },
            });

            if (dr.value === null) {
              continue;
            }

            const derivedRange = derivedRanges.get(dr.testId);
            const derivedFlag = derivedRange
              ? determineResultFlag(dr.value, derivedRange)
              : null;

            await prisma.testResult.create({
              data: {
                testOrderId: orderIdForDerived,
                testId: dr.testId,
                reportVersionId: draftVer.id,
                value: dr.value,
                flag: derivedFlag,
                notes: `${DERIVED_AUTO_NOTE_PREFIX}${dr.parameterName}`,
                testDefinitionId:
                  dr.testDefinitionId ?? testToDefIdMap.get(dr.testId) ?? null,
              },
            });
          }

          for (const manualTestId of manualDerivedOverrideTestIds) {
            const manualInput = results.find(
              (result: any) => result.testId === manualTestId,
            );
            const manualOrderId = testToOrderMap.get(manualTestId);

            if (!manualInput || !manualOrderId) {
              continue;
            }

            const numericValue =
              manualInput.value !== null && manualInput.value !== undefined
                ? parseFloat(manualInput.value)
                : NaN;

            await prisma.testResult.deleteMany({
              where: {
                testOrderId: manualOrderId,
                testId: manualTestId,
                reportVersionId: draftVer.id,
              },
            });

            if (isNaN(numericValue)) {
              continue;
            }

            const manualRange = derivedRanges.get(manualTestId);
            const manualFlag = manualRange
              ? determineResultFlag(numericValue, manualRange)
              : null;

            await prisma.testResult.create({
              data: {
                testOrderId: manualOrderId,
                testId: manualTestId,
                reportVersionId: draftVer.id,
                value: numericValue,
                flag: manualFlag,
                notes: DERIVED_MANUAL_OVERRIDE_NOTE,
                testDefinitionId: testToDefIdMap.get(manualTestId) ?? null,
              },
            });
          }
        }
      }
    } catch (derivedErr) {
      // Non-fatal: log but don't fail the whole request
      console.warn("Derived parameter calculation warning:", derivedErr);
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
// Returns finalized frozen snapshot when available, otherwise a live ephemeral snapshot
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

    if (getReportableOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not have a report snapshot.",
      });
    }

    const loaded = await loadFinalizedReportSnapshotForVisit(id);
    if (loaded.ok) {
      return res.json(loaded.snapshot);
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

// GET /api/visits/diagnostic/:id/preview-report - Generate ephemeral HTML preview of the report
// Staff can see the actual branded report layout BEFORE finalizing (nothing is saved)
router.get("/:id/preview-report", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

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

    if (getReportableOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not have a report preview.",
      });
    }

    // Build ephemeral snapshot from live data (no persistence)
    const snapshot = await buildEphemeralSnapshot(id);

    // Render HTML using the same renderer as the PDF pipeline
    const html = renderReportHtml(snapshot, {
      profile: "screen",
      baseUrl: `${req.protocol}://${req.get("host")}`,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    return res.send(html);
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

    const html = renderReportHtml(loaded.snapshot, {
      profile: mode === "physical" ? "pdf-physical" : "pdf-digital",
      baseUrl,
      qrDataUrl,
    });
    const pdfBuffer = await generatePdfFromHtml(html, { mode });

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
    if (composition.hasReportableOrders || !composition.hasBillOnlyOrders) {
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

// POST /api/visits/diagnostic/:id/finalize - Finalize report
router.post("/:id/finalize", async (req: AuthRequest, res) => {
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
        bill: { include: { transactions: true } },
        report: {
          include: {
            versions: {
              where: { status: "DRAFT" },
              orderBy: { versionNum: "desc" },
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

    if (getReportableOrders(visit.testOrders).length === 0) {
      return res.status(400).json({
        error: "BILL_ONLY_VISIT",
        message: "Pure bill-only visits do not use report finalization.",
      });
    }

    if (visit.bill) {
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

    // Fire-and-forget: Send report-ready notification via WhatsApp (non-blocking)
    import("../services/notificationService").then(({ sendReportReady }) => {
      sendReportReady(visit.id, accessToken || undefined).catch((err) =>
        console.error(
          "[Notification] Report notification failed (non-blocking):",
          err.message,
        ),
      );
    });

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

export default router;
