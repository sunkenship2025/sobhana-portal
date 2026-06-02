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
      where: { // @ts-ignore Prisma types

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
              where: { // @ts-ignore Prisma types
 status: "FINALIZED" },
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
      where: { // @ts-ignore Prisma types
 id: { in: testIds }, isActive: true },
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
        data: // @ts-ignore
tests.map((test, index) => ({
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
        where: { // @ts-ignore Prisma types
 id },
        data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 totalAmountInPaise: newTotalAmountInPaise },
      });

      // Update bill total
      await tx.bill.updateMany({
        where: { // @ts-ignore Prisma types
 visitId: id },
        data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

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
        where: { // @ts-ignore Prisma types
 id },
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
      where: { // @ts-ignore Prisma types

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
              where: { // @ts-ignore Prisma types
 status: "FINALIZED" },
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
        where: { // @ts-ignore Prisma types
 id: testOrderId },
      });

      // Update visit total
      await tx.visit.update({
        where: { // @ts-ignore Prisma types
 id },
        data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 totalAmountInPaise: newTotalAmountInPaise },
      });

      // Update bill total
      await tx.bill.updateMany({
        where: { // @ts-ignore Prisma types
 visitId: id },
        data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

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
      where: { // @ts-ignore Prisma types

        id,
        branchId: req.branchId,
        domain: "DIAGNOSTICS",
      },
      include: {
        report: {
          include: {
            versions: {
              where: { // @ts-ignore Prisma types
 status: "DRAFT" },
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

    // Upsert test results
    await prisma.$transaction(async (tx) => {
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
          const resultData = {
            value: isText ? null : numericValue,
            textValue: textVal || null,
            flag: result.flag || null,
            notes: normalizedNotes,
            testDefinitionId: context.testDefinitionId,
            enteredByUserId: req.user!.id,
            signerNameOverride: signerOverride,
          };

          await tx.testResult.upsert({
            where: { // @ts-ignore Prisma types

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
        } else {
          await tx.testResult.deleteMany({
            where: { // @ts-ignore Prisma types

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
          where: { // @ts-ignore Prisma types
 id },
          data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 status: "WAITING" },
        });
      }
    });

    // --- Auto-flag results with age-aware reference ranges ---
    try {
      const patient = await prisma.patient.findUnique({
        where: { // @ts-ignore Prisma types
 id: visit.patientId },
        select: { yearOfBirth: true, dateOfBirth: true, gender: true },
      });

      if (patient) {
        // Collect test IDs that had numeric values (fall back to textValue)
        const flaggableResults = uniqueResults.filter((r: any) => {
          if (!r.testId) return false;
          let rawValue: string | number | null = null;
          if (r.value !== null && r.value !== undefined) {
            rawValue = r.value;
          } else if (r.textValue) {
            rawValue = r.textValue;
          }
          if (rawValue === null) return false;
          const numericValue = parseFloat(String(rawValue));
          return !isNaN(numericValue);
        });
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
            const context = resolveResultContext(r);
            if (!context) continue;

            const range = resolvedRanges.get(context.testId);
            if (!range) continue;

            const numValue = (() => {
              if (r.value !== null && r.value !== undefined) return parseFloat(r.value);
              if (r.textValue) return parseFloat(r.textValue);
              return NaN;
            })();
            if (isNaN(numValue)) continue;

            const flag = determineResultFlag(numValue, range);

            if (flag) {
              await prisma.testResult.updateMany({
                where: { // @ts-ignore Prisma types

                  testOrderId: context.testOrderId,
                  testId: context.testId,
                  reportVersionId: draftVersion.id,
                },
                data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 flag },
              });
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
            where: { // @ts-ignore Prisma types
 id: visit.patientId },
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
                where: { // @ts-ignore Prisma types

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
              where: { // @ts-ignore Prisma types

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
                where: { // @ts-ignore Prisma types

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
              where: { // @ts-ignore Prisma types

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
      where: { // @ts-ignore Prisma types

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
        where: { // @ts-ignore Prisma types
 id },
        data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 status: "IN_PROGRESS" },
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

export default router;
