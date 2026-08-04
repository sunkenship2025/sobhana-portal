import { Router } from "express";
import { authMiddleware, AuthRequest } from "../middleware/auth";
import prisma from "../lib/prisma";
import { buildDiagnosticBillItems } from "../services/billItemService";
import { buildBillFinancialResponse } from "../services/billFinancialService";
import { getPatientAge, getPatientAgeDisplay } from "../utils/validation";
import { buildReportGatewayQr } from "../services/reportQrService";

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/bills/:domain/:visitId - Get bill data for printing
router.get("/:domain/:visitId", async (req: AuthRequest, res) => {
  try {
    const { domain, visitId } = req.params;

    if (domain !== "CLINIC" && domain !== "DIAGNOSTICS") {
      return res.status(400).json({
        error: "VALIDATION_ERROR",
        message: "Domain must be CLINIC or DIAGNOSTICS",
      });
    }

    const visit = await prisma.visit.findFirst({
      where: {
        id: visitId,
        domain,
      },
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        branch: true,
        bill: { include: { transactions: true } },
        testOrders: {
          orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
          include: {
            test: true,
            product: true,
          },
        },
        referrals: {
          where: { deletedAt: null },
          include: {
            referralDoctor: true,
          },
        },
        clinicVisit: {
          include: {
            clinicDoctor: true,
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: "NOT_FOUND",
        message: "Visit not found",
      });
    }

    const phone =
      visit.patient.identifiers.find((id) => id.type === "PHONE")?.value || "";
    const hasReferralDoctor = visit.referrals.length > 0;
    let originalVisitSummary: {
      billNumber: string | null;
      createdAt: Date | null;
    } | null = null;

    if (domain === "CLINIC" && visit.clinicVisit?.originalVisitId) {
      const originalVisit = await prisma.visit.findUnique({
        where: { id: visit.clinicVisit.originalVisitId },
        select: {
          createdAt: true,
          bill: {
            select: {
              billNumber: true,
            },
          },
        },
      });

      originalVisitSummary = {
        billNumber: originalVisit?.bill?.billNumber || null,
        createdAt: originalVisit?.createdAt || null,
      };
    }

    const billFinancials = buildBillFinancialResponse(visit.bill);

    // Transform data for printing
    const billData: {
      visit: any;
      patient: any;
      branch: any;
      payment: any;
      doctor: any;
      referralDoctor: any;
      items: Array<{
        id: string;
        name: string;
        code: string;
        price: number;
        referralCommissionPercent?: number;
        referralCommissionType?: "PERCENTAGE" | "FIXED_AMOUNT";
        referralCommissionAmountInPaise?: number;
      }>;
      reportQr?: { show: boolean; url?: string; dataUrl?: string };
    } = {
      visit: {
        id: visit.id,
        visitRef: visit.billNumber,
        billNumber: visit.bill?.billNumber || null,
        hasBill: Boolean(visit.bill),
        domain: visit.domain,
        status: visit.status,
        createdAt: visit.createdAt,
        billedAt: visit.bill?.billedAt || visit.bill?.createdAt || null,
        totalAmount: visit.totalAmountInPaise / 100,
        ...billFinancials,
        visitType: visit.clinicVisit?.visitType,
        tokenNumber: visit.clinicVisit?.tokenNumber ?? null,
        isRevisit: visit.clinicVisit?.isRevisit ?? false,
        originalVisitBillNumber: originalVisitSummary?.billNumber || null,
        originalVisitDate: originalVisitSummary?.createdAt || null,
      },
      patient: {
        name: visit.patient.name,
        title: visit.patient.title,
        age: getPatientAge(
          visit.patient.dateOfBirth,
          visit.patient.yearOfBirth,
        ),
        ageUnit: visit.patient.ageUnit || "YEARS",
        ageDisplay: getPatientAgeDisplay(
          visit.patient.dateOfBirth,
          visit.patient.yearOfBirth,
          visit.patient.ageUnit,
        ),
        gender: visit.patient.gender,
        phone,
      },
      branch: {
        name: visit.branch.name,
        code: visit.branch.code,
      },
      payment: {
        type: null,
        transactions:
          visit.bill?.transactions?.map((t) => ({
            paymentType: t.paymentType,
            amountInPaise: t.amountInPaise,
          })) || [],
        status: visit.bill?.paymentStatus || null,
      },
      doctor: visit.clinicVisit?.clinicDoctor
        ? {
            name: visit.clinicVisit.clinicDoctor.name,
            qualification: visit.clinicVisit.clinicDoctor.qualification,
          }
        : null,
      referralDoctor: visit.referrals[0]?.referralDoctor
        ? {
            name: visit.referrals[0].referralDoctor.name,
          }
        : null,
      items: [],
    };

    if (domain === "DIAGNOSTICS") {
      billData.items = buildDiagnosticBillItems(
        visit.testOrders.map((order) => ({
          id: order.id,
          productId: order.productId,
          product: order.product
            ? {
                id: order.product.id,
                name: order.product.name,
                code: order.product.code,
              }
            : null,
          testName: order.testNameSnapshot || order.test.name,
          testCode: order.testCodeSnapshot || order.test.code,
          priceInPaise: order.priceInPaise,
          referralCommissionType: hasReferralDoctor
            ? order.referralCommissionType
            : undefined,
          referralCommissionPercentage: hasReferralDoctor
            ? order.referralCommissionPercentage
            : undefined,
          referralCommissionAmountInPaise: hasReferralDoctor
            ? order.referralCommissionAmountInPaise
            : undefined,
        })),
      );
    } else {
      // For clinic, items are consultation fees
      if (visit.clinicVisit) {
        billData.items = [
          {
            id: visit.id,
            name: visit.clinicVisit.isRevisit
              ? `${visit.clinicVisit.visitType} Revisit Consultation`
              : `${visit.clinicVisit.visitType} Consultation`,
            code: "CONSULT",
            price: visit.clinicVisit.consultationFeeInPaise / 100,
          },
        ];
      }
    }

    // Report QR — only for diagnostics visits that produce a patient-facing
    // report (suppressed for bill-only / all-cancelled / films-only visits).
    // Encodes the token-gated /r/:token gateway that resolves at scan time.
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    billData.reportQr = await buildReportGatewayQr({
      visitId: visit.id,
      orders: visit.testOrders,
      baseUrl,
    });

    return res.json(billData);
  } catch (error) {
    console.error("Get bill data error:", error);
    return res.status(500).json({
      error: "INTERNAL_ERROR",
      message: "Failed to retrieve bill data",
    });
  }
});

export default router;
