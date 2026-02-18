import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { generateDiagnosticBillNumber } from '../services/numberService';
import { logAction } from '../services/auditService';
import { decrementForTests } from '../services/stockService';
import { evaluateDerivedParameters } from '../services/derivedParameterService';
import { resolveReferenceRanges } from '../services/referenceRangeService';

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
              include: {
                accessTokens: {
                  take: 1,
                  orderBy: { createdAt: 'desc' },
                  select: { token: true },
                },
              },
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
      reportToken: (v.report?.versions?.[0] as any)?.accessTokens?.[0]?.token || null,
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
            test: {
              include: {
                childTests: {
                  include: {
                    derivedParameter: { select: { id: true } },
                  },
                  orderBy: { displayOrder: 'asc' },
                },
              },
            },
            testResults: {
              include: {
                test: true, // Include test info for each result
              },
            },
          },
        },
        bill: true,
        report: {
          include: {
            versions: {
              include: {
                testResults: {
                  include: {
                    test: true, // Include test info for each result
                  },
                },
                accessTokens: {
                  take: 1, // Only need the first/current token
                  orderBy: { createdAt: 'desc' },
                  select: { token: true },
                },
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
        isPanel: to.test.isPanel,
        referenceRange: {
          min: to.referenceMinSnapshot ?? to.test.referenceMin ?? 0,
          max: to.referenceMaxSnapshot ?? to.test.referenceMax ?? 0,
          unit: to.referenceUnitSnapshot || to.test.referenceUnit || '',
          text: to.test.referenceText || '',
        },
        // Include child tests for panels
        childTests: to.test.isPanel ? to.test.childTests.map((ct: any) => ({
          id: ct.id,
          name: ct.name,
          code: ct.code,
          displayOrder: ct.displayOrder,
          isDerived: !!ct.derivedParameter,
          referenceRange: {
            min: ct.referenceMin ?? 0,
            max: ct.referenceMax ?? 0,
            unit: ct.referenceUnit || '',
            text: ct.referenceText || '',
          },
        })) : [],
        results: to.testResults.map((tr: any) => ({
          ...tr,
          testName: tr.test?.name || '',
          testCode: tr.test?.code || '',
          referenceRange: {
            min: tr.test?.referenceMin ?? 0,
            max: tr.test?.referenceMax ?? 0,
            unit: tr.test?.referenceUnit || '',
            text: tr.test?.referenceText || '',
          },
        })),
      })),
      report: visit.report
        ? {
            id: visit.report.id,
            versions: visit.report.versions.map((v: any) => ({
              id: v.id,
              versionNumber: v.versionNum,
              status: v.status,
              finalizedAt: v.finalizedAt,
              accessToken: v.accessTokens?.[0]?.token || null, // Include token for finalized reports
              testResults: v.testResults.map((tr: any) => ({
                ...tr,
                testName: tr.test?.name || '',
                testCode: tr.test?.code || '',
                referenceRange: {
                  min: tr.test?.referenceMin ?? 0,
                  max: tr.test?.referenceMax ?? 0,
                  unit: tr.test?.referenceUnit || '',
                  text: tr.test?.referenceText || '',
                },
              })),
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

    // Fire-and-forget: Send bill confirmation via WhatsApp (non-blocking)
    import('../services/notificationService').then(({ sendBillConfirmation }) => {
      sendBillConfirmation(result.id).catch((err) =>
        console.error('[Notification] Bill notification failed (non-blocking):', err.message)
      );
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

    // Get visit with report and test orders with their test (including children for panels)
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
        testOrders: {
          include: {
            test: {
              include: {
                childTests: true, // Include child tests for panels
              },
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

    // Build a map: testId -> testOrderId (includes sub-tests)
    const testToOrderMap = new Map<string, string>();
    for (const testOrder of visit.testOrders) {
      // Map the ordered test itself
      testToOrderMap.set(testOrder.testId, testOrder.id);
      // For panels, also map all child tests to the parent order
      if (testOrder.test.isPanel && testOrder.test.childTests) {
        for (const childTest of testOrder.test.childTests) {
          testToOrderMap.set(childTest.id, testOrder.id);
        }
      }
    }

    // Upsert test results
    await prisma.$transaction(async (tx) => {
      for (const result of results) {
        const testOrderId = testToOrderMap.get(result.testId);
        if (!testOrderId) {
          console.warn(`No test order found for testId: ${result.testId}`);
          continue;
        }

        // Delete existing result for this specific testId (not just testOrderId)
        await tx.testResult.deleteMany({
          where: {
            testOrderId,
            testId: result.testId,
            reportVersionId: draftVersion.id,
          },
        });

        // Create new result
        if (result.value !== null && result.value !== undefined) {
          await tx.testResult.create({
            data: {
              testOrderId,
              testId: result.testId, // Store the actual test ID (can be sub-test)
              reportVersionId: draftVersion.id,
              value: parseFloat(result.value),
              flag: result.flag || null,
              notes: result.notes || null,
            },
          });
        }
      }

      // Update visit status to WAITING if still DRAFT or IN_PROGRESS
      if (visit.status === 'DRAFT' || visit.status === 'IN_PROGRESS') {
        await tx.visit.update({
          where: { id },
          data: { status: 'WAITING' },
        });
      }
    });

    // --- Auto-flag results with age-aware reference ranges ---
    try {
      const patient = await prisma.patient.findUnique({
        where: { id: visit.patientId },
        select: { yearOfBirth: true, gender: true },
      });

      if (patient) {
        // Collect test IDs that had numeric values
        const flaggableResults = results.filter(
          (r: any) => r.value !== null && r.value !== undefined && r.testId
        );
        const testIdsForFlags = flaggableResults.map((r: any) => r.testId);

        if (testIdsForFlags.length > 0) {
          const resolvedRanges = await resolveReferenceRanges(
            testIdsForFlags,
            patient.yearOfBirth,
            patient.gender as any
          );

          // Batch-update flags based on resolved ranges
          for (const r of flaggableResults) {
            const range = resolvedRanges.get(r.testId);
            if (!range) continue;

            const numValue = parseFloat(r.value);
            if (isNaN(numValue)) continue;

            let flag: 'HIGH' | 'LOW' | 'NORMAL' | null = null;
            if (range.referenceMax !== null && numValue > range.referenceMax) {
              flag = 'HIGH';
            } else if (range.referenceMin !== null && numValue < range.referenceMin) {
              flag = 'LOW';
            } else if (range.referenceMin !== null || range.referenceMax !== null) {
              flag = 'NORMAL';
            }

            if (flag) {
              const testOrderId = testToOrderMap.get(r.testId);
              if (testOrderId) {
                await prisma.testResult.updateMany({
                  where: {
                    testOrderId,
                    testId: r.testId,
                    reportVersionId: draftVersion.id,
                  },
                  data: { flag },
                });
              }
            }
          }
        }
      }
    } catch (flagErr) {
      // Non-fatal: log but don't fail the whole request
      console.warn('Auto-flag calculation warning:', flagErr);
    }

    // --- Derived Parameters: auto-calculate formula-based values ---
    try {
      // Build resultsByTestCode: { testCode: numericValue }
      const allTestIds = results.map((r: any) => r.testId).filter(Boolean);
      const testsWithCodes = await prisma.labTest.findMany({
        where: { id: { in: allTestIds } },
        select: { id: true, code: true },
      });
      const testIdToCode = new Map(testsWithCodes.map((t) => [t.id, t.code]));

      const resultsByTestCode: Record<string, number> = {};
      for (const r of results) {
        const code = testIdToCode.get(r.testId);
        if (code && r.value !== null && r.value !== undefined) {
          resultsByTestCode[code] = parseFloat(r.value);
        }
      }

      // Get all ordered test IDs (including panel children)
      const orderedTestIds = Array.from(testToOrderMap.keys());
      const derivedResults = await evaluateDerivedParameters(
        orderedTestIds,
        new Map(Object.entries(resultsByTestCode))
      );

      if (derivedResults.length > 0) {
        const draftVer = visit.report?.versions[0];
        if (draftVer) {
          for (const dr of derivedResults) {
            const orderIdForDerived = testToOrderMap.get(dr.testId);
            if (!orderIdForDerived) continue;

            // Upsert derived result
            await prisma.testResult.deleteMany({
              where: {
                testOrderId: orderIdForDerived,
                testId: dr.testId,
                reportVersionId: draftVer.id,
              },
            });
            await prisma.testResult.create({
              data: {
                testOrderId: orderIdForDerived,
                testId: dr.testId,
                reportVersionId: draftVer.id,
                value: dr.value,
                flag: null,
                notes: `Auto-calculated: ${dr.parameterName}`,
              },
            });
          }
        }
      }
    } catch (derivedErr) {
      // Non-fatal: log but don't fail the whole request
      console.warn('Derived parameter calculation warning:', derivedErr);
    }

    return res.json({ success: true });
  } catch (err: any) {
    console.error('Save test results error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to save test results',
    });
  }
});

// POST /api/visits/diagnostic/:id/collect-sample - Record sample collection and decrement stock
router.post('/:id/collect-sample', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const branchId = req.branchId!;
    const userId = req.user!.id;

    // Fetch visit with test orders
    const visit = await prisma.visit.findFirst({
      where: {
        id,
        branchId,
        domain: 'DIAGNOSTICS',
      },
      include: {
        testOrders: {
          include: {
            test: {
              select: { id: true, name: true, sampleType: true, isPanel: true, childTests: { select: { id: true } } },
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

    if (visit.status !== 'DRAFT') {
      return res.status(400).json({
        error: 'INVALID_STATUS',
        message: `Sample can only be collected when visit is in DRAFT status. Current status: ${visit.status}`,
      });
    }

    // Collect all test IDs (including panel children)
    const testIds: string[] = [];
    for (const to of visit.testOrders) {
      testIds.push(to.testId);
      if (to.test.isPanel && to.test.childTests) {
        for (const child of to.test.childTests) {
          testIds.push(child.id);
        }
      }
    }

    // Decrement stock and update status in a transaction
    await prisma.$transaction(async (tx) => {
      // Decrement stock for ordered tests (non-fatal if stock items not configured)
      try {
        await decrementForTests(testIds, visit.billNumber, branchId, userId, tx);
      } catch (stockErr) {
        console.warn('Stock decrement warning (non-fatal):', stockErr);
      }

      // Move visit to IN_PROGRESS
      await tx.visit.update({
        where: { id },
        data: { status: 'IN_PROGRESS' },
      });
    });

    // Audit log
    await logAction({
      actionType: 'FINALIZE',
      entityType: 'Visit',
      entityId: id,
      userId,
      branchId,
      newValues: {
        billNumber: visit.billNumber,
        testCount: testIds.length,
        sampleTypes: [...new Set(visit.testOrders.map((to: any) => to.test.sampleType).filter(Boolean))],
      },
    });

    return res.json({
      success: true,
      status: 'IN_PROGRESS',
      testsCollected: testIds.length,
      sampleTypes: [...new Set(visit.testOrders.map((to) => to.test.sampleType).filter(Boolean))],
    });
  } catch (err: any) {
    console.error('Collect sample error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to record sample collection',
    });
  }
});

// GET /api/visits/diagnostic/:id/preview-report - Generate ephemeral HTML preview of the report
// Staff can see the actual branded report layout BEFORE finalizing (nothing is saved)
router.get('/:id/preview-report', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Verify the visit belongs to this branch
    const visit = await prisma.visit.findFirst({
      where: { id, branchId: req.branchId, domain: 'DIAGNOSTICS' },
      select: { id: true, status: true },
    });

    if (!visit) {
      return res.status(404).json({ error: 'Visit not found' });
    }

    // Build ephemeral snapshot from live data (no persistence)
    const { buildEphemeralSnapshot } = await import('../services/reportSnapshotService');
    const snapshot = await buildEphemeralSnapshot(id);

    // Render HTML using the same renderer as the PDF pipeline
    const { renderReportHtml } = await import('../services/reportRendererService');
    const html = renderReportHtml(snapshot, {
      mode: 'screen',
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  } catch (err: any) {
    console.error('Preview report error:', err);
    return res.status(500).json({
      error: 'PREVIEW_FAILED',
      message: err.message || 'Failed to generate report preview',
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

    let accessToken: string | null = null;

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

    // E3-10: Create snapshot and access token after successful finalization
    try {
      const { createReportSnapshot, saveReportSnapshot } = await import('../services/reportSnapshotService');
      const { createAccessToken } = await import('../services/reportAccessService');

      // Create immutable snapshot
      const snapshot = await createReportSnapshot(draftVersion.id);
      await saveReportSnapshot(draftVersion.id, snapshot);

      // Create access token for report URL
      accessToken = await createAccessToken(draftVersion.id);

      console.log(`📄 Report ${draftVersion.id} finalized with token: ${accessToken}`);
    } catch (snapshotErr) {
      // Log but don't fail - snapshot can be recreated later
      console.error('Failed to create snapshot/token (non-critical):', snapshotErr);
    }

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
        accessToken: accessToken || undefined,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Fire-and-forget: Send report-ready notification via WhatsApp (non-blocking)
    import('../services/notificationService').then(({ sendReportReady }) => {
      sendReportReady(visit.id).catch((err) =>
        console.error('[Notification] Report notification failed (non-blocking):', err.message)
      );
    });

    return res.json({ 
      success: true, 
      status: 'COMPLETED',
      reportToken: accessToken, // Return token for immediate use
    });
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
