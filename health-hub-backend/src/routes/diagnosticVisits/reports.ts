import { requireModule } from '../../middleware/moduleGuard';
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

router.use(requireModule('DIAGNOSTICS'));



// All routes require auth + branch context





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
            id: true,
            testId: true,
            testNameSnapshot: true,
            testCodeSnapshot: true,
            workflowMode: true,
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

    if (getReportInclusionOrders(visit.testOrders).length === 0) {
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

    const meaningfulDraftResultKeys = new Set(
      draftVersion.testResults
        .filter(hasMeaningfulResultRow)
        .map((result) => `${result.testOrderId}:${result.testId}`),
    );
    const incompleteOrders = visit.testOrders.filter((order) => {
      const mode = order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE;

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
    import("../../services/notificationService").then(({ sendReportReady }) => {
      sendReportReady(visit.id, accessToken || undefined, "final").catch((err: any) =>
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



// POST /api/visits/diagnostic/:id/release-partial
// Release the results that are ready now while leaving the visit open for
// remaining tests. Finalizes the current DRAFT version, creates a new DRAFT
// (carrying forward existing results), and sends the partial WhatsApp template.
// Visit stays in IN_PROGRESS/WAITING (NOT COMPLETED) and payout is NOT refreshed —
// both happen on the final /finalize call.
router.post("/:id/release-partial", async (req: AuthRequest, res) => {
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

    // Bill-due guard — verbatim from /finalize. Backend is the authoritative
    // gate even if the frontend allows the click through.
    if (visit.bill) {
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
    import("../../services/notificationService").then(({ sendReportReady }) => {
      sendReportReady(visit.id, accessToken || undefined, "partial").catch((err: any) =>
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
