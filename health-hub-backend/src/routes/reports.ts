import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { generateReportToken, verifyReportToken } from '../services/tokenService';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();
const prisma = new PrismaClient();

// POST /api/reports/generate-token - Generate a secure token for viewing a report
// Requires authentication
router.post('/generate-token', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const { reportVersionId } = req.body;

    if (!reportVersionId) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'reportVersionId is required',
      });
    }

    // Verify the report version exists and is FINALIZED
    const reportVersion = await prisma.reportVersion.findUnique({
      where: { id: reportVersionId },
      include: {
        report: {
          include: {
            visit: true,
          },
        },
      },
    });

    if (!reportVersion) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Report version not found',
      });
    }

    if (reportVersion.status !== 'FINALIZED') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Report must be finalized before generating access token',
      });
    }

    const patientId = reportVersion.report.visit.patientId;
    const token = generateReportToken(reportVersionId, patientId);

    return res.json({ token });
  } catch (error) {
    console.error('Generate report token error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to generate report token',
    });
  }
});

// GET /api/reports/view?token=xyz - View a report using a signed token
// NO authentication required - token provides authorization
router.get('/view', async (req, res) => {
  try {
    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Token is required',
      });
    }

    // Verify and decode the token
    let decoded;
    try {
      decoded = verifyReportToken(token);
    } catch (error) {
      return res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'Invalid or expired token',
      });
    }

    // Fetch the report version with all related data
    const reportVersion = await prisma.reportVersion.findUnique({
      where: { id: decoded.reportVersionId },
      include: {
        testResults: {
          orderBy: { id: 'asc' },
        },
        report: {
          include: {
            visit: {
              include: {
                patient: {
                  include: {
                    identifiers: true,
                  },
                },
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
                branch: true,
              },
            },
          },
        },
      },
    });

    if (!reportVersion) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Report not found',
      });
    }

    // Verify patient ID matches
    if (reportVersion.report.visit.patientId !== decoded.patientId) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Token does not match report patient',
      });
    }

    // Verify report is FINALIZED
    if (reportVersion.status !== 'FINALIZED') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Report is not finalized',
      });
    }

    // Transform to frontend format
    const visit = reportVersion.report.visit;
    const phone = visit.patient.identifiers.find((id) => id.type === 'PHONE')?.value || '';

    const reportData = {
      reportVersion: {
        id: reportVersion.id,
        versionNum: reportVersion.versionNum,
        status: reportVersion.status,
        finalizedAt: reportVersion.finalizedAt,
        testResults: reportVersion.testResults.map((tr) => ({
          id: tr.id,
          testOrderId: tr.testOrderId,
          value: tr.value,
          flag: tr.flag,
          notes: tr.notes,
        })),
      },
      visit: {
        id: visit.id,
        billNumber: visit.billNumber,
        status: visit.status,
        createdAt: visit.createdAt,
        totalAmount: visit.totalAmountInPaise / 100,
        domain: visit.domain,
      },
      patient: {
        name: visit.patient.name,
        age: visit.patient.age,
        gender: visit.patient.gender,
        phone,
      },
      testOrders: visit.testOrders.map((order) => ({
        id: order.id,
        testId: order.testId,
        testName: order.test.name,
        testCode: order.test.code,
        referenceRange: {
          min: order.test.referenceMin || 0,
          max: order.test.referenceMax || 0,
          unit: order.test.referenceUnit || '',
        },
      })),
      referralDoctor: visit.referrals[0]?.referralDoctor
        ? {
            name: visit.referrals[0].referralDoctor.name,
          }
        : null,
      branch: {
        name: visit.branch.name,
        code: visit.branch.code,
      },
    };

    return res.json(reportData);
  } catch (error) {
    console.error('View report error:', error);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to retrieve report',
    });
  }
});

export default router;
