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



// POST /api/visits/diagnostic/:id/collect-due - Collect an additive due payment
router.post("/:id/collect-due", async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { amount, paymentType } = req.body;

    const existing = await prisma.visit.findFirst({
      where: { // @ts-ignore Prisma types

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

    const currentBillFinancials = buildBillFinancialResponse(existing.bill);
    const addedAmountInPaise = Math.max(
      0,
      nextBillFinancials.paidAmountInPaise -
        currentBillFinancials.paidAmountInPaise,
    );
    if (addedAmountInPaise <= 0) {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Collection amount must increase paid amount",
      });
    }

    const normalizedPaymentType =
      paymentType === "ONLINE" ? "ONLINE" : "CASH";

    const updated = await prisma.bill.update({
      where: { // @ts-ignore Prisma types
 id: existing.bill.id },
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        paidAmountInPaise: nextBillFinancials.paidAmountInPaise,
        paymentStatus: nextBillFinancials.paymentStatus,
        transactions: {
          create: {
            amountInPaise: addedAmountInPaise,
            paymentType: normalizedPaymentType,
            collectedByUserId: req.user!.id,
          },
        },
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

export default router;
