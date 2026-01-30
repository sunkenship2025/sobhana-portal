import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { generateDiagnosticBillNumber } from '../services/numberService';
import { logAction } from '../services/auditService';

const router = Router();
const prisma = new PrismaClient();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// GET /api/visits/diagnostic - List diagnostic visits
// When patientId is provided: Returns ALL visits for that patient across ALL branches (Patient 360 view)
// When patientId is omitted: Returns visits for current branch only (daily operations)
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { status, patientId } = req.query;

    const where: any = {
      domain: 'DIAGNOSTICS',
    };

    // Patient 360 view: Show all visits across branches for specific patient
    // Branch-scoped view: Show only visits in current branch
    if (patientId) {
      where.patientId = patientId;
      // NOTE: No branchId filter when querying by patientId (cross-branch patient history)
    } else {
      where.branchId = req.branchId; // Branch-scoped for list queries
    }

    if (status) {
      where.status = status;
    }

    const visits = await prisma.visit.findMany({
      where,
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        referrals: {
          include: {
            referralDoctor: true,
          },
        },
        testOrders: {
          include: {
            test: true,
          },
        },
        bill: true,
        report: {
          include: {
            versions: {
              orderBy: { versionNum: 'desc' },
              take: 1,
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Transform to frontend format
    const transformed = visits.map((v) => ({
      id: v.id,
      branchId: v.branchId,
      billNumber: v.billNumber,
      patientId: v.patientId,
      patient: v.patient,
      domain: v.domain,
      status: v.status,
      totalAmount: v.totalAmountInPaise / 100,
      paymentType: v.bill?.paymentType || 'CASH',
      paymentStatus: v.bill?.paymentStatus || 'PENDING',
      referralDoctorId: v.referrals[0]?.referralDoctorId || null,
      referralDoctor: v.referrals[0]?.referralDoctor || null,
      testOrders: v.testOrders.map((to) => ({
        id: to.id,
        visitId: to.visitId,
        testId: to.testId,
        // E3-03: Use snapshotted metadata (fallback to live data for backward compatibility)
        testName: to.testNameSnapshot || to.test.name,
        testCode: to.testCodeSnapshot || to.test.code,
        price: to.priceInPaise / 100,
        referenceRange: {
          min: to.referenceMinSnapshot ?? to.test.referenceMin ?? 0,
          max: to.referenceMaxSnapshot ?? to.test.referenceMax ?? 0,
          unit: to.referenceUnitSnapshot || to.test.referenceUnit || '',
        },
      })),
      report: v.report
        ? {
            id: v.report.id,
            currentVersion: v.report.versions[0] || null,
          }
        : null,
      createdAt: v.createdAt,
      updatedAt: v.updatedAt,
    }));

    return res.json(transformed);
  } catch (err: any) {
    console.error('List diagnostic visits error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list diagnostic visits',
    });
  }
});

// GET /api/visits/diagnostic/:id - Get single diagnostic visit
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: 'DIAGNOSTICS',
      },
      include: {
        patient: {
          include: {
            identifiers: true,
          },
        },
        referrals: {
          include: {
            referralDoctor: true,
          },
        },
        testOrders: {
          include: {
            test: true,
            testResults: true,
          },
        },
        bill: true,
        report: {
          include: {
            versions: {
              include: {
                testResults: true,
              },
              orderBy: { versionNum: 'desc' },
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Diagnostic visit not found',
      });
    }

    // Transform to frontend format
    const transformed = {
      id: visit.id,
      branchId: visit.branchId,
      billNumber: visit.billNumber,
      patientId: visit.patientId,
      patient: visit.patient,
      domain: visit.domain,
      status: visit.status,
      totalAmount: visit.totalAmountInPaise / 100,
      paymentType: visit.bill?.paymentType || 'CASH',
      paymentStatus: visit.bill?.paymentStatus || 'PENDING',
      referralDoctorId: visit.referrals[0]?.referralDoctorId || null,
      referralDoctor: visit.referrals[0]?.referralDoctor || null,
      testOrders: visit.testOrders.map((to) => ({
        id: to.id,
        visitId: to.visitId,
        testId: to.testId,
        // E3-03: Use snapshotted metadata (fallback to live data for backward compatibility)
        testName: to.testNameSnapshot || to.test.name,
        testCode: to.testCodeSnapshot || to.test.code,
        price: to.priceInPaise / 100,
        referenceRange: {
          min: to.referenceMinSnapshot ?? to.test.referenceMin ?? 0,
          max: to.referenceMaxSnapshot ?? to.test.referenceMax ?? 0,
          unit: to.referenceUnitSnapshot || to.test.referenceUnit || '',
        },
        results: to.testResults,
      })),
      report: visit.report
        ? {
            id: visit.report.id,
            versions: visit.report.versions.map((v) => ({
              id: v.id,
              versionNumber: v.versionNum,
              status: v.status,
              finalizedAt: v.finalizedAt,
              testResults: v.testResults,
            })),
          }
        : null,
      createdAt: visit.createdAt,
      updatedAt: visit.updatedAt,
    };

    return res.json(transformed);
  } catch (err: any) {
    console.error('Get diagnostic visit error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get diagnostic visit',
    });
  }
});

// POST /api/visits/diagnostic - Create new diagnostic visit
router.post('/', async (req: AuthRequest, res) => {
  try {
    const {
      patientId,
      referralDoctorId,
      testIds,
      paymentType,
      paymentStatus,
    } = req.body;

    // Validation
    if (!patientId || !testIds || !Array.isArray(testIds) || testIds.length === 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Patient ID and at least one test are required',
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

    // Get tests with prices
    const tests = await prisma.labTest.findMany({
      where: { id: { in: testIds } },
    });

    if (tests.length !== testIds.length) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'One or more tests not found',
      });
    }

    // Calculate total
    const totalAmountInPaise = tests.reduce((sum, t) => sum + t.priceInPaise, 0);

    // Get referral doctor commission if applicable
    let commissionPercent = 0;
    if (referralDoctorId) {
      const referralDoc = await prisma.referralDoctor.findUnique({
        where: { id: referralDoctorId },
      });
      if (referralDoc) {
        commissionPercent = referralDoc.commissionPercent;
      }
    }

    // Generate bill number
    const billNumber = await generateDiagnosticBillNumber(branch.code);

    // Create visit with all related records in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create visit
      const visit = await tx.visit.create({
        data: {
          branchId: req.branchId!,
          patientId,
          domain: 'DIAGNOSTICS',
          status: 'DRAFT',
          billNumber,
          totalAmountInPaise,
        },
      });

      // Create bill
      await tx.bill.create({
        data: {
          visitId: visit.id,
          billNumber,
          branchId: req.branchId!,
          totalAmountInPaise,
          paymentType: paymentType || 'CASH',
          paymentStatus: paymentStatus || 'PENDING',
        },
      });

      // Create referral if specified
      if (referralDoctorId) {
        await tx.referralDoctor_Visit.create({
          data: {
            visitId: visit.id,
            referralDoctorId,
            branchId: req.branchId!,
          },
        });
      }

      // Create test orders with metadata snapshot (E3-03)
      await tx.testOrder.createMany({
        data: tests.map((test) => ({
          visitId: visit.id,
          testId: test.id,
          branchId: req.branchId!,
          priceInPaise: test.priceInPaise,
          referralCommissionPercentage: commissionPercent,
          // E3-03: Snapshot test metadata at order time
          testNameSnapshot: test.name,
          testCodeSnapshot: test.code,
          referenceMinSnapshot: test.referenceMin,
          referenceMaxSnapshot: test.referenceMax,
          referenceUnitSnapshot: test.referenceUnit,
        })),
      });

      // Create empty report with draft version
      const report = await tx.diagnosticReport.create({
        data: {
          visitId: visit.id,
          branchId: req.branchId!,
        },
      });

      await tx.reportVersion.create({
        data: {
          reportId: report.id,
          versionNum: 1,
          status: 'DRAFT',
        },
      });

      // Audit log for visit creation
      await logAction({
        userId: req.user?.id!,
        actionType: 'CREATE',
        entityType: 'VISIT',
        entityId: visit.id,
        branchId: req.branchId!,
        newValues: { domain: 'DIAGNOSTICS', billNumber, patientId, totalAmountInPaise },
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      return visit;
    });

    // Fetch complete visit for response
    const completeVisit = await prisma.visit.findUnique({
      where: { id: result.id },
      include: {
        patient: { include: { identifiers: true } },
        referrals: { include: { referralDoctor: true } },
        testOrders: { include: { test: true } },
        bill: true,
      },
    });

    return res.status(201).json({
      id: completeVisit!.id,
      billNumber: completeVisit!.billNumber,
      patientId: completeVisit!.patientId,
      totalAmount: completeVisit!.totalAmountInPaise / 100,
      status: completeVisit!.status,
      createdAt: completeVisit!.createdAt,
    });
  } catch (err: any) {
    console.error('Create diagnostic visit error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create diagnostic visit',
    });
  }
});

// PATCH /api/visits/diagnostic/:id - Update diagnostic visit status
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { status, paymentStatus, paymentType } = req.body;

    // Check visit exists
    const existing = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: 'DIAGNOSTICS',
      },
    });

    if (!existing) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Diagnostic visit not found',
      });
    }

    // Update visit
    const updated = await prisma.$transaction(async (tx) => {
      if (status) {
        await tx.visit.update({
          where: { id },
          data: { status },
        });
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
        include: { bill: true },
      });
    });

    return res.json({
      id: updated!.id,
      status: updated!.status,
      paymentStatus: updated!.bill?.paymentStatus,
      paymentType: updated!.bill?.paymentType,
    });
  } catch (err: any) {
    console.error('Update diagnostic visit error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to update diagnostic visit',
    });
  }
});

// POST /api/visits/diagnostic/:id/tests - Add tests to existing visit (E3-03)
// Tests can only be added before report finalization
router.post('/:id/tests', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { testIds } = req.body;

    // Validation
    if (!testIds || !Array.isArray(testIds) || testIds.length === 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'At least one test ID is required',
      });
    }

    // Get visit with report status
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: 'DIAGNOSTICS',
      },
      include: {
        referrals: {
          include: {
            referralDoctor: true,
          },
        },
        testOrders: true,
        report: {
          include: {
            versions: {
              where: { status: 'FINALIZED' },
              take: 1,
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Diagnostic visit not found',
      });
    }

    // E3-03: Check if report is finalized - cannot add tests after finalization
    const hasFinalized = visit.report?.versions && visit.report.versions.length > 0;
    if (hasFinalized) {
      return res.status(400).json({
        error: 'REPORT_FINALIZED',
        message: 'Cannot add tests after report has been finalized',
      });
    }

    // Check if any requested tests are already ordered
    const existingTestIds = visit.testOrders.map((to) => to.testId);
    const duplicateTests = testIds.filter((id: string) => existingTestIds.includes(id));
    if (duplicateTests.length > 0) {
      return res.status(400).json({
        error: 'DUPLICATE_TESTS',
        message: 'Some tests are already ordered for this visit',
        duplicateTestIds: duplicateTests,
      });
    }

    // Get tests with prices
    const tests = await prisma.labTest.findMany({
      where: { id: { in: testIds }, isActive: true },
    });

    if (tests.length !== testIds.length) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'One or more tests not found or inactive',
      });
    }

    // Get referral commission if applicable
    let commissionPercent = 0;
    if (visit.referrals.length > 0 && visit.referrals[0].referralDoctor) {
      commissionPercent = visit.referrals[0].referralDoctor.commissionPercent;
    }

    // Calculate additional amount
    const additionalAmountInPaise = tests.reduce((sum, t) => sum + t.priceInPaise, 0);
    const newTotalAmountInPaise = visit.totalAmountInPaise + additionalAmountInPaise;

    // Create test orders with metadata snapshot in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create test orders with snapshotted metadata (E3-03)
      await tx.testOrder.createMany({
        data: tests.map((test) => ({
          visitId: visit.id,
          testId: test.id,
          branchId: req.branchId!,
          priceInPaise: test.priceInPaise,
          referralCommissionPercentage: commissionPercent,
          testNameSnapshot: test.name,
          testCodeSnapshot: test.code,
          referenceMinSnapshot: test.referenceMin,
          referenceMaxSnapshot: test.referenceMax,
          referenceUnitSnapshot: test.referenceUnit,
        })),
      });

      // Update visit total
      await tx.visit.update({
        where: { id },
        data: { totalAmountInPaise: newTotalAmountInPaise },
      });

      // Update bill total
      await tx.bill.updateMany({
        where: { visitId: id },
        data: { totalAmountInPaise: newTotalAmountInPaise },
      });

      return tx.visit.findUnique({
        where: { id },
        include: {
          testOrders: {
            include: { test: true },
          },
          bill: true,
        },
      });
    });

    // Audit log for test addition
    await logAction({
      userId: req.user?.id!,
      actionType: 'UPDATE',
      entityType: 'VISIT',
      entityId: id,
      branchId: req.branchId!,
      oldValues: { testCount: existingTestIds.length, totalAmountInPaise: visit.totalAmountInPaise },
      newValues: { 
        testCount: result!.testOrders.length, 
        totalAmountInPaise: newTotalAmountInPaise,
        addedTestIds: testIds,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.status(201).json({
      message: 'Tests added successfully',
      addedCount: tests.length,
      newTotal: newTotalAmountInPaise / 100,
      testOrders: result!.testOrders.map((to) => ({
        id: to.id,
        testId: to.testId,
        testName: to.testNameSnapshot || to.test.name,
        testCode: to.testCodeSnapshot || to.test.code,
        price: to.priceInPaise / 100,
      })),
    });
  } catch (err: any) {
    console.error('Add tests to visit error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to add tests to visit',
    });
  }
});

// DELETE /api/visits/diagnostic/:id/tests/:testOrderId - Remove test from visit (E3-03)
// Tests can only be removed before report finalization
router.delete('/:id/tests/:testOrderId', async (req: AuthRequest, res) => {
  try {
    const { id, testOrderId } = req.params;

    // Get visit with report status
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: 'DIAGNOSTICS',
      },
      include: {
        testOrders: true,
        report: {
          include: {
            versions: {
              where: { status: 'FINALIZED' },
              take: 1,
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Diagnostic visit not found',
      });
    }

    // E3-03: Check if report is finalized
    const hasFinalized = visit.report?.versions && visit.report.versions.length > 0;
    if (hasFinalized) {
      return res.status(400).json({
        error: 'REPORT_FINALIZED',
        message: 'Cannot remove tests after report has been finalized',
      });
    }

    // Find the test order to remove
    const testOrder = visit.testOrders.find((to) => to.id === testOrderId);
    if (!testOrder) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Test order not found',
      });
    }

    // Must have at least one test remaining
    if (visit.testOrders.length <= 1) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Cannot remove the last test from a visit',
      });
    }

    // Calculate new total
    const newTotalAmountInPaise = visit.totalAmountInPaise - testOrder.priceInPaise;

    // Remove test order in a transaction
    await prisma.$transaction(async (tx) => {
      // Delete the test order
      await tx.testOrder.delete({
        where: { id: testOrderId },
      });

      // Update visit total
      await tx.visit.update({
        where: { id },
        data: { totalAmountInPaise: newTotalAmountInPaise },
      });

      // Update bill total
      await tx.bill.updateMany({
        where: { visitId: id },
        data: { totalAmountInPaise: newTotalAmountInPaise },
      });
    });

    // Audit log for test removal
    await logAction({
      userId: req.user?.id!,
      actionType: 'UPDATE',
      entityType: 'VISIT',
      entityId: id,
      branchId: req.branchId!,
      oldValues: { testCount: visit.testOrders.length, totalAmountInPaise: visit.totalAmountInPaise },
      newValues: { 
        testCount: visit.testOrders.length - 1, 
        totalAmountInPaise: newTotalAmountInPaise,
        removedTestOrderId: testOrderId,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({
      message: 'Test removed successfully',
      newTotal: newTotalAmountInPaise / 100,
    });
  } catch (err: any) {
    console.error('Remove test from visit error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to remove test from visit',
    });
  }
});

// POST /api/visits/diagnostic/:id/results - Save test results
router.post('/:id/results', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { results } = req.body;

    if (!results || !Array.isArray(results)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Results array is required',
      });
    }

    // Get visit with report
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: 'DIAGNOSTICS',
      },
      include: {
        report: {
          include: {
            versions: {
              where: { status: 'DRAFT' },
              orderBy: { versionNum: 'desc' },
              take: 1,
            },
          },
        },
        testOrders: true,
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Diagnostic visit not found',
      });
    }

    const draftVersion = visit.report?.versions[0];
    if (!draftVersion) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'No draft report version found',
      });
    }

    // Upsert test results
    await prisma.$transaction(async (tx) => {
      for (const result of results) {
        const testOrder = visit.testOrders.find((to) => to.testId === result.testId);
        if (!testOrder) continue;

        // Delete existing result if any
        await tx.testResult.deleteMany({
          where: {
            testOrderId: testOrder.id,
            reportVersionId: draftVersion.id,
          },
        });

        // Create new result
        if (result.value !== null && result.value !== undefined) {
          await tx.testResult.create({
            data: {
              testOrderId: testOrder.id,
              reportVersionId: draftVersion.id,
              value: parseFloat(result.value),
              flag: result.flag || null,
              notes: result.notes || null,
            },
          });
        }
      }

      // Update visit status to RESULTS_PENDING if still DRAFT
      if (visit.status === 'DRAFT') {
        await tx.visit.update({
          where: { id },
          data: { status: 'WAITING' },
        });
      }
    });

    return res.json({ success: true });
  } catch (err: any) {
    console.error('Save test results error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to save test results',
    });
  }
});

// POST /api/visits/diagnostic/:id/finalize - Finalize report
router.post('/:id/finalize', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId: req.branchId,
        domain: 'DIAGNOSTICS',
      },
      include: {
        report: {
          include: {
            versions: {
              where: { status: 'DRAFT' },
              orderBy: { versionNum: 'desc' },
              take: 1,
            },
          },
        },
      },
    });

    if (!visit) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Diagnostic visit not found',
      });
    }

    const draftVersion = visit.report?.versions[0];
    if (!draftVersion) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'No draft report version found',
      });
    }

    // JIRA-10: Atomic conditional update to prevent race conditions
    // Only finalize if status is still DRAFT (updateMany returns count=0 if condition not met)
    await prisma.$transaction(async (tx) => {
      const updated = await tx.reportVersion.updateMany({
        where: { 
          id: draftVersion.id,
          status: 'DRAFT'  // Only update if still DRAFT
        },
        data: {
          status: 'FINALIZED',
          finalizedAt: new Date(),
        },
      });

      // If no rows updated, another request already finalized
      if (updated.count === 0) {
        throw new Error('ALREADY_FINALIZED');
      }

      await tx.visit.update({
        where: { id },
        data: { status: 'COMPLETED' },
      });

      return updated;
    });

    // Audit log: Report finalization (CRITICAL)
    await logAction({
      branchId: req.branchId!,
      actionType: 'FINALIZE',
      entityType: 'Report',
      entityId: draftVersion.id,
      userId: req.user?.id!,
      oldValues: {
        status: 'DRAFT',
      },
      newValues: {
        status: 'FINALIZED',
        reportVersionId: draftVersion.id,
        visitId: visit.id,
        finalizedAt: new Date().toISOString(),
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ success: true, status: 'COMPLETED' });
  } catch (err: any) {
    // JIRA-10: Handle race condition gracefully
    if (err.message === 'ALREADY_FINALIZED') {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'Report was already finalized by another request',
      });
    }
    console.error('Finalize report error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to finalize report',
    });
  }
});

export default router;
