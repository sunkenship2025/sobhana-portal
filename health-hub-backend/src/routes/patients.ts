import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import * as patientService from '../services/patientService';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// POST /api/patients - Create new patient
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, age, dateOfBirth, gender, address, identifiers } = req.body;

    // E2-09: Validation - require either age or dateOfBirth
    if (!name || (!age && !dateOfBirth) || !gender || !identifiers) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Name, age or dateOfBirth, gender, and identifiers are required'
      });
    }

    const patient = await patientService.createPatient({
      name,
      age,
      dateOfBirth: dateOfBirth ? new Date(dateOfBirth + 'T00:00:00.000Z') : undefined, // E2-09: Parse as UTC midnight to avoid timezone issues
      gender,
      address,
      identifiers,
      branchId: req.branchId!,
      userId: req.user?.id
    });

    return res.status(201).json(patient);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Create patient error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create patient'
    });
  }
});

// GET /api/patients/search - Search patients
router.get('/search', async (req: AuthRequest, res) => {
  try {
    const { phone, email, name, limit } = req.query;

    const patients = await patientService.searchPatients({
      phone: phone as string,
      email: email as string,
      name: name as string,
      limit: limit ? parseInt(limit as string) : undefined
    });

    return res.json(patients);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Search patients error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to search patients'
    });
  }
});

// GET /api/patients/:id - Get patient by ID
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const patient = await patientService.getPatientById(id);

    if (!patient) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Patient not found'
      });
    }

    return res.json(patient);
  } catch (err: any) {
    console.error('Get patient error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get patient'
    });
  }
});

// GET /api/patients/:id/360 - Get complete Patient 360 view (read-only, global)
router.get('/:id/360', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const patient360 = await patientService.getPatient360View(id);

    if (!patient360) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Patient not found'
      });
    }

    return res.json(patient360);
  } catch (err: any) {
    console.error('Get patient 360 error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get patient 360 view'
    });
  }
});

// PATCH /api/patients/:id - Update patient details
// SHP-14 (E2-13a): Immediate edit with mandatory reason for identity fields
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, age, gender, address, phone, email, changeReason } = req.body;

    const updatedPatient = await patientService.updatePatient({
      patientId: id,
      updates: {
        name,
        age,
        gender,
        address,
        phone,
        email
      },
      changeReason,
      userId: req.user?.id!,
      userRole: req.user?.role!,
      branchId: req.branchId!
    });

    return res.json(updatedPatient);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Update patient error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to update patient'
    });
  }
});

// GET /api/patients/:id/change-history - Get patient change history
router.get('/:id/change-history', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const changeHistory = await patientService.getPatientChangeHistory(id);

    return res.json(changeHistory);
  } catch (err: any) {
    console.error('Get patient change history error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get patient change history'
    });
  }
});

export default router;
