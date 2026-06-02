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
import { PayoutSnapshot, OptionalPayoutSnapshot, ResolvedNumericRange, LatestDefinitionFormula, DERIVED_MANUAL_OVERRIDE_NOTE, DERIVED_AUTO_NOTE_PREFIX, zeroPayoutSnapshot, emptyOptionalPayoutSnapshot, buildDerivedMetadata, propagatePanelByProductId, determineResultFlag, isManualDerivedOverrideNote, hasMeaningfulResultRow, getExpectedResultTestIds, dedupeResultRows, TestInputConfigPayload, DEFAULT_INPUT_CONFIG, normalizeInputConfig, loadInputConfigsByRootId, loadLatestDefinitionFormulasByCode, applyReferralRuleToPrices, applyOptionalReferralRuleToPrices, loadFinalizedReportSnapshotForVisit, getVisitComposition, getReportableOrders, getReportInclusionOrders } from "./shared";

const router = Router();



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
          where: { // @ts-ignore Prisma types
 testId: { in: Array.from(allTestIds) } },
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

    const clinicalPanelItems = allTestDefinitionIds.size
      ? await prisma.clinicalPanelItem.findMany({
          where: { // @ts-ignore Prisma types

            testDefinitionId: { in: Array.from(allTestDefinitionIds) },
          },
          orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
          select: {
            testDefinitionId: true,
            panel: {
              select: { id: true, name: true, displayName: true },
            },
          },
        })
      : [];
    const clinicalPanelByDefinitionId = new Map<
      string,
      { id: string; name: string; displayName: string }
    >();
    for (const item of clinicalPanelItems) {
      if (!clinicalPanelByDefinitionId.has(item.testDefinitionId)) {
        clinicalPanelByDefinitionId.set(item.testDefinitionId, item.panel);
      }
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
              panel,
            };
          });
          return propagatePanelByProductId(orders);
        })(),
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
      where: { // @ts-ignore Prisma types

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
          where: { // @ts-ignore Prisma types
 reportId: visitBase.report.id },
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
          where: { // @ts-ignore Prisma types

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
      where: { // @ts-ignore Prisma types
 visitId: id },
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
            signerNameOverride: true,
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
          where: { // @ts-ignore Prisma types

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
          where: { // @ts-ignore Prisma types

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
          where: { // @ts-ignore Prisma types

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
      testIds,
      productIds,
      paymentType,
      discountType,
      discountValue,
      discountReason,
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
      where: { // @ts-ignore Prisma types
 id: req.branchId },
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
        where: { // @ts-ignore Prisma types
 id: referralDoctorId },
        include: {
          productRules: {
            where: { // @ts-ignore Prisma types
 isActive: true },
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
          where: { // @ts-ignore Prisma types
 id: diagnosticCenterId },
          include: {
            productRules: {
              where: { // @ts-ignore Prisma types
 isActive: true },
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
        where: { // @ts-ignore Prisma types
 id: { in: testIds } },
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
          discountReason,
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
        // Create visit
        const visit = await tx.visit.create({
          // @ts-ignore Prisma strict typing
          data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

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
          data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

            visitId: visit.id,
            billNumber,
            branchId: req.branchId!,
            totalAmountInPaise,
            discountReason: billFinancials.discountReason,
            discountType: billFinancials.discountType,
            discountPercentage: billFinancials.discountPercentage,
            discountAmountInPaise: billFinancials.discountAmountInPaise,
            paidAmountInPaise: billFinancials.paidAmountInPaise,
            // @ts-ignore Prisma strict typing
            paymentStatus: billFinancials.paymentStatus,
            // @ts-ignore Prisma strict typing
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

        // Create referral if specified
        if (referralDoctorId) {
          await tx.referralDoctor_Visit.create({
            // @ts-ignore Prisma strict typing
            data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

              visitId: visit.id,
              referralDoctorId,
              branchId: req.branchId!,
            },
          });
        }

        // Create diagnostic center referral if specified
        if (diagnosticCenterId) {
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
          await tx.diagnosticCenter_Visit.create({
            // @ts-ignore Prisma strict typing
            data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

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
                where: { // @ts-ignore Prisma types

                  referralDoctorId,
                  productId,
                },
              });
              continue;
            }

            await tx.referralDoctorProductRule.upsert({
              where: { // @ts-ignore Prisma types

                referralDoctorId_productId: {
                  referralDoctorId,
                  productId,
                },
              },
              update: {
                commissionType: override.commissionType,
                commissionPercent: override.commissionPercent,
                commissionAmountInPaise: override.commissionAmountInPaise,
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
                isActive: true,
          // @ts-ignore Prisma strict typing
              },
          // @ts-ignore Prisma strict typing
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
                where: { // @ts-ignore Prisma types

                  diagnosticCenterId,
                  productId,
                },
              });
              continue;
            }

            await tx.diagnosticCenterProductRule.upsert({
              where: { // @ts-ignore Prisma types

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
          // @ts-ignore Prisma strict typing
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

          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
        // Create test orders with metadata snapshot (E3-03)
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
          // @ts-ignore Prisma strict typing
        await tx.testOrder.createMany({
          // @ts-ignore Prisma strict typing
          data: // @ts-ignore
testOrderData.map((tod) => ({
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

        if (createComposition.hasReportInclusionOrders) {
          // Both REPORTABLE and EXTERNAL_UPLOAD orders flow into a single
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
          // DiagnosticReport — the merged PDF combines rendered values with
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
          // appended uploads.
            // @ts-ignore Prisma strict typing
          const report = await tx.diagnosticReport.create({
            // @ts-ignore Prisma strict typing
            data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

              visitId: visit.id,
              branchId: req.branchId!,
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
            },
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
            // @ts-ignore Prisma strict typing
          });
            // @ts-ignore Prisma strict typing

            // @ts-ignore Prisma strict typing
          await tx.reportVersion.create({
            // @ts-ignore Prisma strict typing
            data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

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
      where: { // @ts-ignore Prisma types
 id: result.id },
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
      import("../../services/notificationService").then(
        ({ sendBillConfirmation }) => {
          sendBillConfirmation(result.id).catch((err: any) =>
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
    console.error("Create diagnostic visit error:", err);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to create diagnostic visit",
    });
  }
});

export default router;
