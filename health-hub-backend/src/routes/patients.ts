import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import * as patientService from '../services/patientService';
import * as patient360Service from '../services/patient360Service';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ============================================
// PATIENT 360 ROUTES (Read-Only Aggregation)
// ============================================

// GET /api/patients/:id/360 - Get Patient 360 canonical view
router.get('/:id/360', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const patient360 = await patient360Service.getPatient360(id);
    return res.json(patient360);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Get Patient 360 error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get Patient 360 view'
    });
  }
});

// GET /api/patients/:id/360/visits/:visitId/diagnostic - Get diagnostic visit detail
router.get('/:id/360/visits/:visitId/diagnostic', async (req: AuthRequest, res) => {
  try {
    const { visitId } = req.params;
    const detail = await patient360Service.getDiagnosticVisitDetail(visitId);
    return res.json(detail);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Get diagnostic visit detail error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get diagnostic visit detail'
    });
  }
});

// GET /api/patients/:id/360/visits/:visitId/clinic - Get clinic visit detail
router.get('/:id/360/visits/:visitId/clinic', async (req: AuthRequest, res) => {
  try {
    const { visitId } = req.params;
    const detail = await patient360Service.getClinicVisitDetail(visitId);
    return res.json(detail);
  } catch (err: any) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.error,
        message: err.message
      });
    }
    console.error('Get clinic visit detail error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get clinic visit detail'
    });
  }
});

// GET /api/patients/search/global - Global patient search for Patient 360 navigation
router.get('/search/global', async (req: AuthRequest, res) => {
  try {
    const { phone, patientNumber, name, limit } = req.query;
    const results = await patient360Service.searchPatientsGlobal({
      phone: phone as string,
      patientNumber: patientNumber as string,
      name: name as string,
      limit: limit ? parseInt(limit as string) : undefined
    });
    return res.json(results);
  } catch (err: any) {
    console.error('Global patient search error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to search patients'
    });
  }
});

// ============================================
// EXISTING PATIENT ROUTES
// ============================================

// POST /api/patients - Create new patient
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, age, gender, address, identifiers } = req.body;

    // Validation
    if (!name || !age || !gender || !identifiers) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Name, age, gender, and identifiers are required'
      });
    }

    const patient = await patientService.createPatient({
      name,
      age,
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

export default router;
