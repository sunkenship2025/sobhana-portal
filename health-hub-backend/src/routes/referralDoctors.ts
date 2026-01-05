import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import * as doctorService from '../services/doctorService';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ==================== REFERRAL DOCTORS ====================

// POST /api/referral-doctors - Create referral doctor
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, phone, email, commissionPercent, clinicDoctorId } = req.body;

    if (!name || commissionPercent === undefined) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Name and commissionPercent are required'
      });
    }

    // Check if this person is already a referral or clinic doctor
    const existingReferral = await doctorService.searchReferralDoctorByContact(phone, email);
    if (existingReferral) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `This person is already a referral doctor: ${existingReferral.name} (${existingReferral.doctorNumber})`
      });
    }

    const existingClinic = await doctorService.searchClinicDoctorByContact(phone, email);
    if (existingClinic && !clinicDoctorId) {
      return res.status(400).json({
        error: 'DUPLICATE_DETECTED',
        message: `This person is already a clinic doctor: ${existingClinic.name} (${existingClinic.doctorNumber}). Would you like to link them?`,
        clinicDoctor: existingClinic
      });
    }

    const doctor = await doctorService.createReferralDoctor({
      name,
      phone,
      email,
      commissionPercent,
      clinicDoctorId,
      branchId: req.branchId!,
      userId: req.user?.id
    });

    return res.status(201).json(doctor);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Create referral doctor error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create referral doctor'
    });
  }
});

// GET /api/referral-doctors - List all referral doctors
router.get('/', async (req: AuthRequest, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const doctors = await doctorService.listReferralDoctors(includeInactive);
    return res.json(doctors);
  } catch (err: any) {
    console.error('List referral doctors error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list referral doctors'
    });
  }
});

// PATCH /api/referral-doctors/:id - Update referral doctor
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, phone, email, commissionPercent } = req.body;

    const updated = await doctorService.updateReferralDoctor(
      id,
      { name, phone, email, commissionPercent },
      req.branchId!,
      req.user?.id
    );

    return res.json(updated);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Update referral doctor error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to update referral doctor'
    });
  }
});

// DELETE /api/referral-doctors/:id - Deactivate referral doctor
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const updated = await doctorService.deactivateReferralDoctor(
      id,
      req.branchId!,
      req.user?.id
    );

    return res.json(updated);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Deactivate referral doctor error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to deactivate referral doctor'
    });
  }
});

export default router;
