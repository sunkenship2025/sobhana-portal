import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { generateClinicBillNumber } from '../services/numberService';

const router = Router();
const prisma = new PrismaClient();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// GET /api/visits/clinic - List all clinic visits for current branch
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { status, doctorId } = req.query;

    const where: any = {
      branchId: req.branchId,
      domain: 'CLINIC',
    };

    if (status) {
      where.clinicVisit = { status };
    }

    const visits = await prisma.visit.findMany({
      where,
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        clinicVisit: {
          include: {
            clinicDoctor: true,
          },
        },
        bill: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Filter by doctor if specified
    let filteredVisits = visits;
    if (doctorId) {
      filteredVisits = visits.filter((v) => v.clinicVisit?.clinicDoctorId === doctorId);
    }

    // Transform to frontend format
    const transformed = filteredVisits.map((v) => ({
      id: v.id,
      branchId: v.branchId,
      billNumber: v.billNumber,
      patientId: v.patientId,
      patient: v.patient,
      domain: v.domain,
      status: v.clinicVisit?.status || v.status,
      visitType: v.clinicVisit?.visitType || 'OP',
      hospitalWard: v.clinicVisit?.hospitalWard || null,
      doctorId: v.clinicVisit?.clinicDoctorId || null,
      doctor: v.clinicVisit?.clinicDoctor || null,
      totalAmount: v.totalAmountInPaise / 100,
      consultationFee: (v.clinicVisit?.consultationFeeInPaise || 0) / 100,
      paymentType: v.bill?.paymentType || 'CASH',
      paymentStatus: v.bill?.paymentStatus || 'PENDING',
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }));

    return res.json(transformed);
  } catch (err: any) {
    console.error('List clinic visits error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list clinic visits',
    });
  }
});

// GET /api/visits/clinic/:id - Get single clinic visit
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: 'CLINIC',
      },
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        clinicVisit: {
          include: {
            clinicDoctor: true,
          },
        },
        bill: true,
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Clinic visit not found',
      });
    }

    const transformed = {
      id: visit.id,
      branchId: visit.branchId,
      billNumber: visit.billNumber,
      patientId: visit.patientId,
      patient: visit.patient,
      domain: visit.domain,
      status: visit.clinicVisit?.status || visit.status,
      visitType: visit.clinicVisit?.visitType || 'OP',
      hospitalWard: visit.clinicVisit?.hospitalWard || null,
      doctorId: visit.clinicVisit?.clinicDoctorId || null,
      doctor: visit.clinicVisit?.clinicDoctor || null,
      totalAmount: visit.totalAmountInPaise / 100,
      consultationFee: (visit.clinicVisit?.consultationFeeInPaise || 0) / 100,
      paymentType: visit.bill?.paymentType || 'CASH',
      paymentStatus: visit.bill?.paymentStatus || 'PENDING',
      createdAt: visit.createdAt,
      updatedAt: visit.updatedAt,
    };

    return res.json(transformed);
  } catch (err: any) {
    console.error('Get clinic visit error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get clinic visit',
    });
  }
});

// POST /api/visits/clinic - Create new clinic visit
router.post('/', async (req: AuthRequest, res) => {
  try {
    const {
      patientId,
      doctorId,
      visitType,
      hospitalWard,
      consultationFee,
      paymentType,
      paymentStatus,
    } = req.body;

    // Validation
    if (!patientId || !doctorId || !visitType || consultationFee === undefined) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Patient ID, doctor ID, visit type, and consultation fee are required',
      });
    }

    // Get branch code for bill number
    const branch = await prisma.branch.findUnique({
      where: { id: req.branchId },
    });

    if (!branch) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Invalid branch',
      });
    }

    // Verify doctor exists
    const doctor = await prisma.clinicDoctor.findUnique({
      where: { id: doctorId },
    });

    if (!doctor) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Doctor not found',
      });
    }

    // Convert fee to paise
    const consultationFeeInPaise = Math.round(consultationFee * 100);

    // Generate bill number
    const billNumber = await generateClinicBillNumber(branch.code);

    // Create visit with all related records in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create visit
      const visit = await tx.visit.create({
        data: {
          branchId: req.branchId!,
          patientId,
          domain: 'CLINIC',
          status: 'WAITING',
          billNumber,
          totalAmountInPaise: consultationFeeInPaise,
        },
      });

      // Create bill
      await tx.bill.create({
        data: {
          visitId: visit.id,
          billNumber,
          branchId: req.branchId!,
          totalAmountInPaise: consultationFeeInPaise,
          paymentType: paymentType || 'CASH',
          paymentStatus: paymentStatus || 'PENDING',
        },
      });

      // Create clinic visit details
      await tx.clinicVisit.create({
        data: {
          visitId: visit.id,
          clinicDoctorId: doctorId,
          visitType,
          hospitalWard: visitType === 'IP' ? hospitalWard : null,
          consultationFeeInPaise,
          status: 'WAITING',
        },
      });

      return visit;
    });

    // Fetch complete visit for response
    const completeVisit = await prisma.visit.findUnique({
      where: { id: result.id },
      include: {
        patient: { include: { identifiers: true } },
        clinicVisit: { include: { clinicDoctor: true } },
        bill: true,
      },
    });

    return res.status(201).json({
      id: completeVisit!.id,
      billNumber: completeVisit!.billNumber,
      patientId: completeVisit!.patientId,
      totalAmount: completeVisit!.totalAmountInPaise / 100,
      status: completeVisit!.clinicVisit?.status || 'WAITING',
      createdAt: completeVisit!.createdAt,
    });
  } catch (err: any) {
    console.error('Create clinic visit error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create clinic visit',
    });
  }
});

// PATCH /api/visits/clinic/:id - Update clinic visit status
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus, paymentType } = req.body;

    // Check visit exists
    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: 'CLINIC',
      },
      include: {
        clinicVisit: true,
      },
    });

    if (!existing) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Clinic visit not found',
      });
    }

    // Update visit
    const updated = await prisma.$transaction(async (tx) => {
      if (status) {
        // Update both visit and clinic visit status
        await tx.visit.update({
          where: { id },
          data: { status },
        });

        if (existing.clinicVisit) {
          await tx.clinicVisit.update({
            where: { id: existing.clinicVisit.id },
            data: { status },
          });
        }
      }

      if (paymentStatus || paymentType) {
        await tx.bill.updateMany({
          where: { visitId: id },
          data: {
            ...(paymentStatus && { paymentStatus }),
            ...(paymentType && { paymentType }),
          },
        });
      }

      return tx.visit.findUnique({
        where: { id },
        include: { bill: true, clinicVisit: true },
      });
    });

    return res.json({
      id: updated!.id,
      status: updated!.clinicVisit?.status || updated!.status,
      paymentStatus: updated!.bill?.paymentStatus,
      paymentType: updated!.bill?.paymentType,
    });
  } catch (err: any) {
    console.error('Update clinic visit error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to update clinic visit',
    });
  }
});

// DELETE /api/visits/clinic/:id - Delete/cancel clinic visit
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: 'CLINIC',
      },
    });

    if (!existing) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Clinic visit not found',
      });
    }

    // Mark as cancelled instead of hard delete
    await prisma.visit.update({
      where: { id },
      data: { status: 'CANCELLED' },
    });

    return res.json({ success: true });
  } catch (err: any) {
    console.error('Delete clinic visit error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to delete clinic visit',
    });
  }
});

export default router;
