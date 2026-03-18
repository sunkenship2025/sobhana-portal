import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import prisma from '../lib/prisma';

const router = Router();

// All routes require authentication
router.use(authMiddleware);

// GET /api/bills/:domain/:visitId - Get bill data for printing
router.get('/:domain/:visitId', async (req: AuthRequest, res) => {
  try {
    const { domain, visitId } = req.params;

    if (domain !== 'CLINIC' && domain !== 'DIAGNOSTICS') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Domain must be CLINIC or DIAGNOSTICS',
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
        bill: true,
        testOrders: {
          include: {
            test: true,
            product: true,
          },
        },
        referrals: {
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
        error: 'NOT_FOUND',
        message: 'Visit not found',
      });
    }

    const phone = visit.patient.identifiers.find((id) => id.type === 'PHONE')?.value || '';
    const hasReferralDoctor = visit.referrals.length > 0;

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
        referralCommissionType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
        referralCommissionAmountInPaise?: number;
      }>;
    } = {
      visit: {
        id: visit.id,
        billNumber: visit.billNumber,
        domain: visit.domain,
        status: visit.status,
        createdAt: visit.createdAt,
        totalAmount: visit.totalAmountInPaise / 100,
        visitType: visit.clinicVisit?.visitType,
        isRevisit: visit.clinicVisit?.isRevisit ?? false,
      },
      patient: {
        name: visit.patient.name,
        age: visit.patient.dateOfBirth 
          ? Math.floor((Date.now() - new Date(visit.patient.dateOfBirth).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
          : new Date().getFullYear() - visit.patient.yearOfBirth, // E2-09: Calculate age from DOB or YOB
        gender: visit.patient.gender,
        phone,
      },
      branch: {
        name: visit.branch.name,
        code: visit.branch.code,
      },
      payment: {
        type: visit.bill?.paymentType || 'CASH',
        status: visit.bill?.paymentStatus || 'PENDING',
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

    if (domain === 'DIAGNOSTICS') {
      // Group test orders by productId to show billable products, not individual tests
      const productGroups = new Map<
        string,
        {
          name: string;
          code: string;
          totalPrice: number;
          referralType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
          referralPercent?: number | null;
          referralAmountInPaise?: number;
        }
      >();
      const ungrouped: typeof billData.items = [];

      for (const order of visit.testOrders) {
        if (order.productId && order.product) {
          const existing = productGroups.get(order.productId);
          if (existing) {
            existing.totalPrice += order.priceInPaise / 100;
            if (hasReferralDoctor && order.referralCommissionType === 'FIXED_AMOUNT') {
              existing.referralAmountInPaise =
                (existing.referralAmountInPaise ?? 0) + (order.referralCommissionAmountInPaise ?? 0);
            }
          } else {
            productGroups.set(order.productId, {
              name: order.product.name,
              code: order.product.code,
              totalPrice: order.priceInPaise / 100,
              referralType: hasReferralDoctor ? order.referralCommissionType : undefined,
              referralPercent: hasReferralDoctor ? order.referralCommissionPercentage : undefined,
              referralAmountInPaise: hasReferralDoctor && order.referralCommissionType === 'FIXED_AMOUNT'
                ? order.referralCommissionAmountInPaise ?? 0
                : undefined,
            });
          }
        } else {
          // Legacy orders without product linkage — fall back to individual test
          ungrouped.push({
            id: order.id,
            name: order.testNameSnapshot || order.test.name,
            code: order.test.code,
            price: order.priceInPaise / 100,
            referralCommissionType: hasReferralDoctor ? order.referralCommissionType : undefined,
            referralCommissionPercent: hasReferralDoctor ? order.referralCommissionPercentage ?? undefined : undefined,
            referralCommissionAmountInPaise:
              hasReferralDoctor && order.referralCommissionType === 'FIXED_AMOUNT'
                ? order.referralCommissionAmountInPaise ?? undefined
                : undefined,
          });
        }
      }

      billData.items = [
        ...Array.from(productGroups.entries()).map(([productId, p]) => ({
          id: productId,
          name: p.name,
          code: p.code,
          price: p.totalPrice,
          referralCommissionType: p.referralType,
          referralCommissionPercent: p.referralPercent ?? undefined,
          referralCommissionAmountInPaise: p.referralAmountInPaise,
        })),
        ...ungrouped,
      ];
    } else {
      // For clinic, items are consultation fees
      if (visit.clinicVisit) {
        billData.items = [
          {
            id: visit.id,
            name: `${visit.clinicVisit.visitType} Consultation`,
            code: 'CONSULT',
            price: visit.clinicVisit.consultationFeeInPaise / 100,
          },
        ];
      }
    }

    return res.json(billData);
  } catch (error) {
    console.error('Get bill data error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve bill data',
    });
  }
});

export default router;
