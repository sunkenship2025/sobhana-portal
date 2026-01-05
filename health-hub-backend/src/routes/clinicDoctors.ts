import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import * as doctorService from '../services/doctorService';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// POST /api/clinic-doctors - Create clinic doctor
router.post('/', async (req: AuthRequest, res) => {
  try {
    const {
      name,
      qualification,
      specialty,
      registrationNumber,
      phone,
      email,
      letterheadNote,
      referralDoctorId
    } = req.body;

    if (!name || !qualification || !specialty || !registrationNumber) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Name, qualification, specialty, and registrationNumber are required'
      });
    }

    // Check if this person is already a clinic or referral doctor
    const existingClinic = await doctorService.searchClinicDoctorByContact(phone, email);
    if (existingClinic) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `This person is already a clinic doctor: ${existingClinic.name} (${existingClinic.doctorNumber})`
      });
    }

    const existingReferral = await doctorService.searchReferralDoctorByContact(phone, email);
    if (existingReferral && !referralDoctorId) {
      return res.status(400).json({
        error: 'DUPLICATE_DETECTED',
        message: `This person is already a referral doctor: ${existingReferral.name} (${existingReferral.doctorNumber}). Would you like to link them?`,
        referralDoctor: existingReferral
      });
    }

    const doctor = await doctorService.createClinicDoctor({
      name,
      qualification,
      specialty,
      registrationNumber,
      phone,
      email,
      letterheadNote,
      referralDoctorId,
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
    console.error('Create clinic doctor error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create clinic doctor'
    });
  }
});

// GET /api/clinic-doctors - List all clinic doctors
router.get('/', async (req: AuthRequest, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const doctors = await doctorService.listClinicDoctors(includeInactive);
    return res.json(doctors);
  } catch (err: any) {
    console.error('List clinic doctors error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list clinic doctors'
    });
  }
});

// PATCH /api/clinic-doctors/:id - Update clinic doctor
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, qualification, specialty, phone, email, letterheadNote } = req.body;

    const updated = await doctorService.updateClinicDoctor(
      id,
      { name, qualification, specialty, phone, email, letterheadNote },
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
    console.error('Update clinic doctor error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to update clinic doctor'
    });
  }
});

// DELETE /api/clinic-doctors/:id - Deactivate clinic doctor
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const updated = await doctorService.deactivateClinicDoctor(
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
    console.error('Deactivate clinic doctor error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to deactivate clinic doctor'
    });
  }
});

export default router;
