import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import * as doctorService from '../services/doctorService';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// GET /api/doctors/search-by-contact - Search for existing doctors by phone or email
// Returns both referral and clinic doctors to detect duplicates
router.get('/search-by-contact', async (req: AuthRequest, res) => {
  try {
    const { phone, email } = req.query;

    if (!phone && !email) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Provide phone or email to search'
      });
    }

    const [referralDoctor, clinicDoctor] = await Promise.all([
      doctorService.searchReferralDoctorByContact(phone as string, email as string),
      doctorService.searchClinicDoctorByContact(phone as string, email as string)
    ]);

    return res.json({
      referralDoctor: referralDoctor || null,
      clinicDoctor: clinicDoctor || null,
      exists: !!(referralDoctor || clinicDoctor)
    });
  } catch (err: any) {
    console.error('Search doctors by contact error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to search doctors'
    });
  }
});

export default router;
