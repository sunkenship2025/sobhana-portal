import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

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
      },
      patient: {
        name: visit.patient.name,
        age: visit.patient.age,
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
      // For diagnostics, items are test orders
      billData.items = visit.testOrders.map((order) => ({
        id: order.id,
        name: order.test.name,
        code: order.test.code,
        price: order.priceInPaise / 100,
        referralCommissionPercent: order.referralCommissionPercentage,
      }));
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
