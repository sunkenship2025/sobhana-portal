import { Router } from 'express';
import QRCode from 'qrcode';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { generateDiagnosticBillNumber } from '../services/numberService';
import { logAction } from '../services/auditService';
import {
  evaluateDerivedTargets,
  normalizeDependencyCodes,
  type DerivedFormulaTarget,
} from '../services/derivedParameterService';
import { generatePdfFromHtml } from '../services/pdfGenerationService';
import { resolveReferenceRanges } from '../services/referenceRangeService';
import { createAccessToken, recordAccessByReportVersionId } from '../services/reportAccessService';
import {
  buildEphemeralSnapshot,
  createReportSnapshot,
  getReportSnapshot,
  saveReportSnapshot,
} from '../services/reportSnapshotService';
import { resolveProducts, ProductResolutionError } from '../services/productOrderService';
import {
  renderReportHtml,
} from '../services/reportRendererService';
import prisma from '../lib/prisma';
import {
  areReferralPayoutsEqual,
  distributeFixedAmountInPaise,
  normalizeReferralOverrideInput,
  type NormalizedReferralPayout,
} from '../services/referralPayoutService';
import { derivePayout } from '../services/payoutService';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

type PayoutSnapshot = {
  commissionType: 'PERCENTAGE' | 'FIXED_AMOUNT';
  commissionPercentage: number | null;
  commissionAmountInPaise: number | null;
};

type OptionalPayoutSnapshot = {
  commissionType: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
  commissionPercentage: number | null;
  commissionAmountInPaise: number | null;
};

type ResolvedNumericRange = {
  referenceMin: number | null;
  referenceMax: number | null;
  criticalMin: number | null;
  criticalMax: number | null;
};

type LatestDefinitionFormula = {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  formulaExpression: string | null;
  dependsOnCodes: unknown;
};

const DERIVED_MANUAL_OVERRIDE_NOTE = '__DERIVED_MANUAL_OVERRIDE__';
const DERIVED_AUTO_NOTE_PREFIX = 'Auto-calculated: ';

function zeroPayoutSnapshot(): PayoutSnapshot {
  return {
    commissionType: 'PERCENTAGE',
    commissionPercentage: 0,
    commissionAmountInPaise: null,
  };
}

function emptyOptionalPayoutSnapshot(): OptionalPayoutSnapshot {
  return {
    commissionType: null,
    commissionPercentage: null,
    commissionAmountInPaise: null,
  };
}

function buildDerivedMetadata(
  formula: string | null | undefined,
  dependsOnCodesRaw: unknown
): {
  isDerived: boolean;
  formulaExpression: string | null;
  dependsOnCodes: string[] | null;
} {
  const formulaExpression = formula?.trim() || null;
  const dependsOnCodes = normalizeDependencyCodes(dependsOnCodesRaw);

  if (!formulaExpression || dependsOnCodes.length === 0) {
    return {
      isDerived: false,
      formulaExpression: null,
      dependsOnCodes: null,
    };
  }

  return {
    isDerived: true,
    formulaExpression,
    dependsOnCodes,
  };
}

function determineResultFlag(
  numValue: number,
  range: ResolvedNumericRange
): 'CRITICAL_HIGH' | 'CRITICAL_LOW' | 'HIGH' | 'LOW' | 'NORMAL' | null {
  if (range.criticalMax !== null && numValue > range.criticalMax) {
    return 'CRITICAL_HIGH';
  }
  if (range.criticalMin !== null && numValue < range.criticalMin) {
    return 'CRITICAL_LOW';
  }
  if (range.referenceMax !== null && numValue > range.referenceMax) {
    return 'HIGH';
  }
  if (range.referenceMin !== null && numValue < range.referenceMin) {
    return 'LOW';
  }
  if (range.referenceMin !== null || range.referenceMax !== null) {
    return 'NORMAL';
  }
  return null;
}

function isManualDerivedOverrideNote(notes: string | null | undefined): boolean {
  return notes?.trim() === DERIVED_MANUAL_OVERRIDE_NOTE;
}

async function loadLatestDefinitionFormulasByCode(
  codes: Iterable<string>
): Promise<Map<string, LatestDefinitionFormula>> {
  const uniqueCodes = [...new Set(Array.from(codes).map((code) => code.trim()).filter(Boolean))];
  if (uniqueCodes.length === 0) {
    return new Map();
  }

  const definitions = await prisma.testDefinition.findMany({
    where: {
      code: { in: uniqueCodes },
      isLatest: true,
    },
    select: {
      id: true,
      code: true,
      name: true,
      displayOrder: true,
      formulaExpression: true,
      dependsOnCodes: true,
    },
  });

  return new Map(definitions.map((definition) => [definition.code, definition]));
}

function applyReferralRuleToPrices(
  pricesInPaise: number[],
  rule: NormalizedReferralPayout | null
): PayoutSnapshot[] {
  if (!rule) {
    return pricesInPaise.map(() => zeroPayoutSnapshot());
  }

  if (rule.commissionType === 'FIXED_AMOUNT') {
    const distributed = distributeFixedAmountInPaise(
      rule.commissionAmountInPaise ?? 0,
      pricesInPaise
    );

    return distributed.map((commissionAmountInPaise) => ({
      commissionType: 'FIXED_AMOUNT',
      commissionPercentage: null,
      commissionAmountInPaise,
    }));
  }

  return pricesInPaise.map(() => ({
    commissionType: 'PERCENTAGE',
    commissionPercentage: rule.commissionPercent ?? 0,
    commissionAmountInPaise: null,
  }));
}

function applyOptionalReferralRuleToPrices(
  pricesInPaise: number[],
  rule: NormalizedReferralPayout | null
): OptionalPayoutSnapshot[] {
  if (!rule) {
    return pricesInPaise.map(() => emptyOptionalPayoutSnapshot());
  }

  return applyReferralRuleToPrices(pricesInPaise, rule).map((snapshot) => ({
    commissionType: snapshot.commissionType,
    commissionPercentage: snapshot.commissionPercentage,
    commissionAmountInPaise: snapshot.commissionAmountInPaise,
  }));
}

async function loadFinalizedReportSnapshotForVisit(visitId: string) {
  const visit = await prisma.visit.findFirst({
    where: {
      id: visitId,
      domain: 'DIAGNOSTICS',
    },
    select: {
      billNumber: true,
      report: {
        select: {
          versions: {
            where: { status: 'FINALIZED' },
            orderBy: { versionNum: 'desc' },
            take: 1,
            select: {
              id: true,
            },
          },
        },
      },
    },
  });

  if (!visit) {
    return {
      ok: false as const,
      status: 404,
      error: 'NOT_FOUND',
      message: 'Diagnostic visit not found',
    };
  }

  const reportVersionId = visit.report?.versions?.[0]?.id;
  if (!reportVersionId) {
    return {
      ok: false as const,
      status: 404,
      error: 'REPORT_NOT_FOUND',
      message: 'Finalized report not found',
    };
  }

  const snapshot = await getReportSnapshot(reportVersionId);
  if (!snapshot) {
    return {
      ok: false as const,
      status: 404,
      error: 'REPORT_NOT_AVAILABLE',
      message: 'Finalized report snapshot not found',
    };
  }

  return {
    ok: true as const,
    billNumber: visit.billNumber,
    reportVersionId,
    snapshot,
  };
}

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
    const transformed = visits.map((v) => {
      const currentVersion = v.report?.versions[0] || null;

      return {
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
        billedAt: v.bill?.billedAt || v.bill?.createdAt || null,
        reportFinalizedAt: currentVersion?.status === 'FINALIZED' ? currentVersion.finalizedAt : null,
        referralDoctorId: v.referrals[0]?.referralDoctorId || null,
        referralDoctor: v.referrals[0]?.referralDoctor || null,
        testOrders: v.testOrders.map((to) => ({
          id: to.id,
          visitId: to.visitId,
          testId: to.testId,
          productId: to.productId,
          testDefinitionId: to.testDefinitionId,
          // E3-03: Use snapshotted metadata (fallback to live data for backward compatibility)
          testName: to.testNameSnapshot || to.test.name,
          testCode: to.testCodeSnapshot || to.test.code,
          price: to.priceInPaise / 100,
          priceInPaise: to.priceInPaise,
          referralCommissionType: to.referralCommissionType,
          referralCommissionPercent: to.referralCommissionPercentage,
          referralCommissionAmountInPaise: to.referralCommissionAmountInPaise,
          referenceRange: {
            min: to.referenceMinSnapshot ?? to.test.referenceMin ?? 0,
            max: to.referenceMaxSnapshot ?? to.test.referenceMax ?? 0,
            unit: to.referenceUnitSnapshot || to.test.referenceUnit || '',
          },
        })),
        report: v.report
          ? {
              id: v.report.id,
              currentVersion,
            }
          : null,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
      };
    });

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
                department: { select: { id: true, name: true, reportHeaderText: true } },
                derivedParameter: {
                  select: {
                    id: true,
                    parameterName: true,
                    formula: true,
                    dependsOnTestCodes: true,
                  },
                },
                childTests: {
                  include: {
                    derivedParameter: {
                      select: {
                        id: true,
                        parameterName: true,
                        formula: true,
                        dependsOnTestCodes: true,
                      },
                    },
                  },
                  orderBy: { displayOrder: 'asc' },
                },
                panelItems: {
                  include: {
                    panel: {
                      include: {
                        department: { select: { id: true, name: true } },
                      },
                    },
                  },
                  take: 1,
                },
              },
            },
            testDefinition: {
              include: {
                department: { select: { id: true, name: true } },
                panelItems: {
                  include: {
                    panel: {
                      include: {
                        department: { select: { id: true, name: true } },
                      },
                    },
                  },
                  take: 1,
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

    // Resolve age/gender-aware reference ranges for all tests (including child tests)
    const patient = visit.patient;
    const allTestIds: string[] = [];
    for (const to of visit.testOrders) {
      allTestIds.push(to.testId);
      if (to.test.isPanel && to.test.childTests) {
        for (const ct of to.test.childTests) {
          allTestIds.push(ct.id);
        }
      }
    }
    const uniqueTestIds = [...new Set(allTestIds)];

    // Build testDefinitionId map from testOrders
    const testDefIdMap = new Map<string, string>();
    for (const to of visit.testOrders) {
      if (to.testDefinitionId) {
        testDefIdMap.set(to.testId, to.testDefinitionId);
      }
    }

    const resolvedRanges = await resolveReferenceRanges(
      uniqueTestIds,
      patient.yearOfBirth,
      patient.gender as any,
      testDefIdMap.size > 0 ? testDefIdMap : undefined,
      patient.dateOfBirth
    );

    const latestDefinitionFormulasByCode = await loadLatestDefinitionFormulasByCode(
      visit.testOrders.flatMap((to) => [
        to.testCodeSnapshot || to.testDefinition?.code || to.test.code,
        ...to.test.childTests.map((child) => child.code),
      ])
    );

    // Helper to build referenceRange from resolved + fallback data
    const buildRange = (
      testId: string,
      defaultMin: number | null,
      defaultMax: number | null,
      defaultUnit: string | null,
      defaultText?: string | null
    ) => {
      const resolved = resolvedRanges.get(testId);
      return {
        min: resolved?.referenceMin ?? defaultMin ?? 0,
        max: resolved?.referenceMax ?? defaultMax ?? 0,
        unit: resolved?.referenceUnit || defaultUnit || '',
        text: defaultText || '',
      };
    };
    // Transform to frontend format
    const latestFinalizedVersion = visit.report?.versions.find((version: any) => version.status === 'FINALIZED') || null;

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
      billedAt: visit.bill?.billedAt || visit.bill?.createdAt || null,
      reportFinalizedAt: latestFinalizedVersion?.finalizedAt || null,
      referralDoctorId: visit.referrals[0]?.referralDoctorId || null,
      referralDoctor: visit.referrals[0]?.referralDoctor || null,
      testOrders: visit.testOrders.map((to) => {
        const orderCode =
          to.testCodeSnapshot || to.testDefinition?.code || to.test.code;
        const latestOrderDefinition = latestDefinitionFormulasByCode.get(orderCode);
        const orderDerived =
          to.testDefinition?.formulaExpression
            ? buildDerivedMetadata(
                to.testDefinition.formulaExpression,
                to.testDefinition.dependsOnCodes
              )
            : to.test.derivedParameter?.formula
              ? buildDerivedMetadata(
                  to.test.derivedParameter.formula,
                  to.test.derivedParameter.dependsOnTestCodes
                )
              : buildDerivedMetadata(
                  latestOrderDefinition?.formulaExpression,
                  latestOrderDefinition?.dependsOnCodes
                );

        return {
          id: to.id,
          visitId: to.visitId,
          testId: to.testId,
          productId: to.productId,
          testDefinitionId: to.testDefinitionId,
          testName: to.testNameSnapshot || to.test.name,
          testCode: to.testCodeSnapshot || to.test.code,
          price: to.priceInPaise / 100,
          priceInPaise: to.priceInPaise,
          referralCommissionType: to.referralCommissionType,
          referralCommissionPercent: to.referralCommissionPercentage,
          referralCommissionAmountInPaise: to.referralCommissionAmountInPaise,
          isPanel: to.test.isPanel,
          isDerived: orderDerived.isDerived,
          formulaExpression: orderDerived.formulaExpression,
          dependsOnCodes: orderDerived.dependsOnCodes,
          department: (() => {
            const dept = to.testDefinition?.panelItems?.[0]?.panel?.department
              || to.test.panelItems?.[0]?.panel?.department
              || to.testDefinition?.department
              || to.test.department;
            return dept ? { id: dept.id, name: dept.name } : null;
          })(),
          panel: (() => {
            const panel = to.testDefinition?.panelItems?.[0]?.panel
              || to.test.panelItems?.[0]?.panel
              || null;
            return panel
              ? {
                  id: panel.id,
                  name: panel.name,
                  displayName: panel.displayName,
                }
              : null;
          })(),
          referenceRange: buildRange(
            to.testId,
            to.referenceMinSnapshot ?? to.testDefinition?.referenceMin ?? to.test.referenceMin,
            to.referenceMaxSnapshot ?? to.testDefinition?.referenceMax ?? to.test.referenceMax,
            to.referenceUnitSnapshot || to.testDefinition?.referenceUnit || to.test.referenceUnit,
            to.testDefinition?.referenceText || to.test.referenceText
          ),
          childTests: to.test.isPanel ? to.test.childTests.map((ct: any) => {
            const latestChildDefinition = latestDefinitionFormulasByCode.get(ct.code);
            const childDerived = buildDerivedMetadata(
              ct.derivedParameter?.formula || latestChildDefinition?.formulaExpression,
              ct.derivedParameter?.dependsOnTestCodes || latestChildDefinition?.dependsOnCodes
            );

            return {
              id: ct.id,
              name: ct.name,
              code: ct.code,
              displayOrder: ct.displayOrder,
              isDerived: childDerived.isDerived,
              formulaExpression: childDerived.formulaExpression,
              dependsOnCodes: childDerived.dependsOnCodes,
              referenceRange: buildRange(ct.id, ct.referenceMin, ct.referenceMax, ct.referenceUnit, ct.referenceText),
            };
          }) : [],
          results: to.testResults.map((tr: any) => ({
            ...tr,
            manualOverride: isManualDerivedOverrideNote(tr.notes),
            testName: tr.test?.name || '',
            testCode: tr.test?.code || '',
            referenceRange: buildRange(tr.testId, tr.test?.referenceMin, tr.test?.referenceMax, tr.test?.referenceUnit, tr.test?.referenceText),
          })),
        };
      }),
      report: visit.report
        ? {
            id: visit.report.id,
            versions: visit.report.versions.map((v: any) => ({
              id: v.id,
              versionNumber: v.versionNum,
              status: v.status,
              finalizedAt: v.finalizedAt,
              testResults: v.testResults.map((tr: any) => ({
                ...tr,
                manualOverride: isManualDerivedOverrideNote(tr.notes),
                testName: tr.test?.name || '',
                testCode: tr.test?.code || '',
                referenceRange: buildRange(tr.testId, tr.test?.referenceMin, tr.test?.referenceMax, tr.test?.referenceUnit, tr.test?.referenceText),
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
// Accepts EITHER productIds (new architecture) OR testIds (legacy)
router.post('/', async (req: AuthRequest, res) => {
  try {
    const {
      patientId,
      referralDoctorId,
      diagnosticCenterId,
      referralOverrides,
      diagnosticCenterOverrides,
      testIds,
      productIds,
      paymentType,
      paymentStatus,
      sendWhatsApp,
    } = req.body;

    const hasProducts = productIds && Array.isArray(productIds) && productIds.length > 0;
    const hasTests = testIds && Array.isArray(testIds) && testIds.length > 0;

    // Validation
    if (!patientId || (!hasProducts && !hasTests)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Patient ID and at least one product or test are required',
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

    let defaultReferralRule: NormalizedReferralPayout | null = null;
    const referralRuleByProductId = new Map<string, NormalizedReferralPayout>();
    let defaultDiagnosticCenterRule: NormalizedReferralPayout | null = null;
    const diagnosticCenterRuleByProductId = new Map<string, NormalizedReferralPayout>();

    if (referralDoctorId) {
      const referralDoc = await prisma.referralDoctor.findUnique({
        where: { id: referralDoctorId },
        include: {
          productRules: {
            where: { isActive: true },
          },
        },
      });

      if (!referralDoc) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Referral doctor not found',
        });
      }

      defaultReferralRule = {
        commissionType: referralDoc.commissionType,
        commissionPercent: referralDoc.commissionPercent,
        commissionAmountInPaise: referralDoc.commissionAmountInPaise,
      };

      for (const rule of referralDoc.productRules) {
        referralRuleByProductId.set(rule.productId, {
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
        });
      }
    }

    if (diagnosticCenterId) {
      const diagnosticCenter = await prisma.diagnosticReferralCenter.findUnique({
        where: { id: diagnosticCenterId },
        include: {
          productRules: {
            where: { isActive: true },
          },
        },
      });

      if (!diagnosticCenter) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Diagnostic center not found',
        });
      }

      defaultDiagnosticCenterRule = {
        commissionType: diagnosticCenter.commissionType,
        commissionPercent: diagnosticCenter.commissionPercent,
        commissionAmountInPaise: diagnosticCenter.commissionAmountInPaise,
      };

      for (const rule of diagnosticCenter.productRules) {
        diagnosticCenterRuleByProductId.set(rule.productId, {
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
        });
      }
    }

    const overrides = new Map<string, NormalizedReferralPayout>();
    const diagnosticCenterOverrideMap = new Map<string, NormalizedReferralPayout>();
    if (referralOverrides && typeof referralOverrides === 'object') {
      try {
        for (const [key, value] of Object.entries(referralOverrides)) {
          const normalized = normalizeReferralOverrideInput(value);
          if (normalized) {
            overrides.set(key, normalized);
          }
        }
      } catch (validationErr: any) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: validationErr.message,
        });
      }
    }

    if (diagnosticCenterOverrides && typeof diagnosticCenterOverrides === 'object') {
      try {
        for (const [key, value] of Object.entries(diagnosticCenterOverrides)) {
          const normalized = normalizeReferralOverrideInput(value);
          if (normalized) {
            diagnosticCenterOverrideMap.set(key, normalized);
          }
        }
      } catch (validationErr: any) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: validationErr.message,
        });
      }
    }

    // ── Resolve tests + pricing ──
    // Two paths: product-based (new) or direct test-based (legacy)
    let totalAmountInPaise = 0;
    let testOrderData: Array<{
      testId: string;
      testDefinitionId?: string;
      productId?: string;
      priceInPaise: number;
      testNameSnapshot: string;
      testCodeSnapshot: string;
      referenceMinSnapshot: number | null;
      referenceMaxSnapshot: number | null;
      referenceUnitSnapshot: string | null;
      referralCommissionType: 'PERCENTAGE' | 'FIXED_AMOUNT';
      referralCommissionPercentage: number | null;
      referralCommissionAmountInPaise: number | null;
      diagnosticCenterCommissionType: 'PERCENTAGE' | 'FIXED_AMOUNT' | null;
      diagnosticCenterCommissionPercentage: number | null;
      diagnosticCenterCommissionAmountInPaise: number | null;
    }> = [];

    if (hasProducts) {
      // ── New architecture: resolve BillableProducts ──
      try {
        const resolved = await resolveProducts(productIds, req.branchId!);

        for (const rp of resolved) {
          const effectiveRule =
            overrides.get(rp.productId) ??
            referralRuleByProductId.get(rp.productId) ??
            defaultReferralRule;
          const effectiveDiagnosticCenterRule =
            diagnosticCenterOverrideMap.get(rp.productId) ??
            diagnosticCenterRuleByProductId.get(rp.productId) ??
            defaultDiagnosticCenterRule;
          const referralSnapshots = applyReferralRuleToPrices(
            rp.testOrders.map((to) => to.priceInPaise),
            effectiveRule
          );
          const diagnosticCenterSnapshots = applyOptionalReferralRuleToPrices(
            rp.testOrders.map((to) => to.priceInPaise),
            effectiveDiagnosticCenterRule
          );

          for (const [index, to] of rp.testOrders.entries()) {
            testOrderData.push({
              testId: to.labTestId,
              testDefinitionId: to.testDefinitionId,
              productId: to.productId,
              priceInPaise: to.priceInPaise,
              testNameSnapshot: to.testName,
              testCodeSnapshot: to.testCode,
              referenceMinSnapshot: to.referenceMin,
              referenceMaxSnapshot: to.referenceMax,
              referenceUnitSnapshot: to.referenceUnit,
              referralCommissionType: referralSnapshots[index].commissionType,
              referralCommissionPercentage: referralSnapshots[index].commissionPercentage,
              referralCommissionAmountInPaise: referralSnapshots[index].commissionAmountInPaise,
              diagnosticCenterCommissionType: diagnosticCenterSnapshots[index].commissionType,
              diagnosticCenterCommissionPercentage: diagnosticCenterSnapshots[index].commissionPercentage,
              diagnosticCenterCommissionAmountInPaise:
                diagnosticCenterSnapshots[index].commissionAmountInPaise,
            });
          }
          totalAmountInPaise += rp.effectivePrice;
        }
      } catch (err) {
        if (err instanceof ProductResolutionError) {
          return res.status(400).json({
            error: err.code,
            message: err.message,
            details: err.details,
          });
        }
        throw err;
      }
    } else {
      // ── Legacy path: direct LabTest IDs ──
      const tests = await prisma.labTest.findMany({
        where: { id: { in: testIds } },
      });

      if (tests.length !== testIds.length) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'One or more tests not found',
        });
      }

      totalAmountInPaise = tests.reduce((sum, t) => sum + t.priceInPaise, 0);

      testOrderData = tests.map((test) => {
        const effectiveRule = overrides.get(test.id) ?? defaultReferralRule;
        const referralSnapshot = applyReferralRuleToPrices([test.priceInPaise], effectiveRule)[0];
        const diagnosticCenterSnapshot = applyOptionalReferralRuleToPrices(
          [test.priceInPaise],
          diagnosticCenterOverrideMap.get(test.id) ?? defaultDiagnosticCenterRule
        )[0];

        return {
          testId: test.id,
          priceInPaise: test.priceInPaise,
          testNameSnapshot: test.name,
          testCodeSnapshot: test.code,
          referenceMinSnapshot: test.referenceMin,
          referenceMaxSnapshot: test.referenceMax,
          referenceUnitSnapshot: test.referenceUnit,
          referralCommissionType: referralSnapshot.commissionType,
          referralCommissionPercentage: referralSnapshot.commissionPercentage,
          referralCommissionAmountInPaise: referralSnapshot.commissionAmountInPaise,
          diagnosticCenterCommissionType: diagnosticCenterSnapshot.commissionType,
          diagnosticCenterCommissionPercentage: diagnosticCenterSnapshot.commissionPercentage,
          diagnosticCenterCommissionAmountInPaise: diagnosticCenterSnapshot.commissionAmountInPaise,
        };
      });
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

      // Create diagnostic center referral if specified
      if (diagnosticCenterId) {
        await tx.diagnosticCenter_Visit.create({
          data: {
            visitId: visit.id,
            diagnosticCenterId,
            referralType: 'REFERRED_FROM',
            branchId: req.branchId!,
          },
        });
      }

      if (referralDoctorId && hasProducts && overrides.size > 0) {
        for (const productId of productIds.filter((id: string) => overrides.has(id))) {
          const override = overrides.get(productId);
          if (!override) continue;

          if (areReferralPayoutsEqual(override, defaultReferralRule)) {
            await tx.referralDoctorProductRule.deleteMany({
              where: {
                referralDoctorId,
                productId,
              },
            });
            continue;
          }

          await tx.referralDoctorProductRule.upsert({
            where: {
              referralDoctorId_productId: {
                referralDoctorId,
                productId,
              },
            },
            update: {
              commissionType: override.commissionType,
              commissionPercent: override.commissionPercent,
              commissionAmountInPaise: override.commissionAmountInPaise,
              isActive: true,
            },
            create: {
              referralDoctorId,
              productId,
              commissionType: override.commissionType,
              commissionPercent: override.commissionPercent,
              commissionAmountInPaise: override.commissionAmountInPaise,
              isActive: true,
            },
          });
        }
      }

      if (diagnosticCenterId && hasProducts && diagnosticCenterOverrideMap.size > 0) {
        for (const productId of productIds.filter((id: string) => diagnosticCenterOverrideMap.has(id))) {
          const override = diagnosticCenterOverrideMap.get(productId);
          if (!override) continue;

          if (areReferralPayoutsEqual(override, defaultDiagnosticCenterRule)) {
            await tx.diagnosticCenterProductRule.deleteMany({
              where: {
                diagnosticCenterId,
                productId,
              },
            });
            continue;
          }

          await tx.diagnosticCenterProductRule.upsert({
            where: {
              diagnosticCenterId_productId: {
                diagnosticCenterId,
                productId,
              },
            },
            update: {
              commissionType: override.commissionType,
              commissionPercent: override.commissionPercent,
              commissionAmountInPaise: override.commissionAmountInPaise,
              isActive: true,
            },
            create: {
              diagnosticCenterId,
              productId,
              commissionType: override.commissionType,
              commissionPercent: override.commissionPercent,
              commissionAmountInPaise: override.commissionAmountInPaise,
              isActive: true,
            },
          });
        }
      }

      // Create test orders with metadata snapshot (E3-03)
      await tx.testOrder.createMany({
        data: testOrderData.map((tod) => ({
          visitId: visit.id,
          testId: tod.testId,
          branchId: req.branchId!,
          priceInPaise: tod.priceInPaise,
          referralCommissionType: tod.referralCommissionType,
          referralCommissionPercentage: tod.referralCommissionPercentage,
          referralCommissionAmountInPaise: tod.referralCommissionAmountInPaise,
          diagnosticCenterCommissionType: tod.diagnosticCenterCommissionType,
          diagnosticCenterCommissionPercentage: tod.diagnosticCenterCommissionPercentage,
          diagnosticCenterCommissionAmountInPaise: tod.diagnosticCenterCommissionAmountInPaise,
          testNameSnapshot: tod.testNameSnapshot,
          testCodeSnapshot: tod.testCodeSnapshot,
          referenceMinSnapshot: tod.referenceMinSnapshot,
          referenceMaxSnapshot: tod.referenceMaxSnapshot,
          referenceUnitSnapshot: tod.referenceUnitSnapshot,
          testDefinitionId: tod.testDefinitionId ?? null,
          productId: tod.productId ?? null,
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
    if (sendWhatsApp) {
      import('../services/notificationService').then(({ sendBillConfirmation }) => {
        sendBillConfirmation(result.id).catch((err) =>
          console.error('[Notification] Bill notification failed (non-blocking):', err.message)
        );
      });
    }

    return res.status(201).json({
      id: completeVisit!.id,
      billNumber: completeVisit!.billNumber,
      patientId: completeVisit!.patientId,
      totalAmount: completeVisit!.totalAmountInPaise / 100,
      status: completeVisit!.status,
      billedAt: completeVisit!.bill?.billedAt || completeVisit!.bill?.createdAt || null,
      reportFinalizedAt: null,
      createdAt: completeVisit!.createdAt,
      referralDoctor: completeVisit!.referrals[0]?.referralDoctor || null,
      testOrders: completeVisit!.testOrders.map((to) => ({
        id: to.id,
        visitId: to.visitId,
        testId: to.testId,
        productId: to.productId,
        testDefinitionId: to.testDefinitionId,
        testName: to.testNameSnapshot || to.test.name,
        testCode: to.testCodeSnapshot || to.test.code,
        priceInPaise: to.priceInPaise,
        referralCommissionType: to.referralCommissionType,
        referralCommissionPercent: to.referralCommissionPercentage,
        referralCommissionAmountInPaise: to.referralCommissionAmountInPaise,
        diagnosticCenterCommissionType: to.diagnosticCenterCommissionType,
        diagnosticCenterCommissionPercent: to.diagnosticCenterCommissionPercentage,
        diagnosticCenterCommissionAmountInPaise: to.diagnosticCenterCommissionAmountInPaise,
      })),
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
      billedAt: updated!.bill?.billedAt || updated!.bill?.createdAt || null,
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
        diagnosticCenterReferrals: {
          include: {
            diagnosticCenter: true,
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

    const defaultReferralRule =
      visit.referrals.length > 0 && visit.referrals[0].referralDoctor
        ? {
            commissionType: visit.referrals[0].referralDoctor.commissionType,
            commissionPercent: visit.referrals[0].referralDoctor.commissionPercent,
            commissionAmountInPaise: visit.referrals[0].referralDoctor.commissionAmountInPaise,
          }
        : null;
    const defaultDiagnosticCenterRule =
      visit.diagnosticCenterReferrals.length > 0 && visit.diagnosticCenterReferrals[0].diagnosticCenter
        ? {
            commissionType: visit.diagnosticCenterReferrals[0].diagnosticCenter.commissionType,
            commissionPercent: visit.diagnosticCenterReferrals[0].diagnosticCenter.commissionPercent,
            commissionAmountInPaise:
              visit.diagnosticCenterReferrals[0].diagnosticCenter.commissionAmountInPaise,
          }
        : null;

    // Calculate additional amount
    const additionalAmountInPaise = tests.reduce((sum, t) => sum + t.priceInPaise, 0);
    const newTotalAmountInPaise = visit.totalAmountInPaise + additionalAmountInPaise;
    const referralSnapshots = tests.map((test) =>
      applyReferralRuleToPrices([test.priceInPaise], defaultReferralRule)[0]
    );
    const diagnosticCenterSnapshots = tests.map((test) =>
      applyOptionalReferralRuleToPrices([test.priceInPaise], defaultDiagnosticCenterRule)[0]
    );

    // Create test orders with metadata snapshot in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Create test orders with snapshotted metadata (E3-03)
      await tx.testOrder.createMany({
        data: tests.map((test, index) => ({
          visitId: visit.id,
          testId: test.id,
          branchId: req.branchId!,
          priceInPaise: test.priceInPaise,
          referralCommissionType: referralSnapshots[index].commissionType,
          referralCommissionPercentage: referralSnapshots[index].commissionPercentage,
          referralCommissionAmountInPaise: referralSnapshots[index].commissionAmountInPaise,
          diagnosticCenterCommissionType: diagnosticCenterSnapshots[index].commissionType,
          diagnosticCenterCommissionPercentage: diagnosticCenterSnapshots[index].commissionPercentage,
          diagnosticCenterCommissionAmountInPaise:
            diagnosticCenterSnapshots[index].commissionAmountInPaise,
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
                derivedParameter: {
                  select: {
                    parameterName: true,
                    formula: true,
                    dependsOnTestCodes: true,
                  },
                },
                childTests: {
                  include: {
                    derivedParameter: {
                      select: {
                        parameterName: true,
                        formula: true,
                        dependsOnTestCodes: true,
                      },
                    },
                  },
                }, // Include child tests for panels
              },
            },
            testDefinition: {
              select: {
                id: true,
                code: true,
                name: true,
                displayOrder: true,
                formulaExpression: true,
                dependsOnCodes: true,
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

    const manualDerivedOverrideTestIds = new Set<string>(
      results
        .filter((result: any) => result?.manualOverride === true && result?.testId)
        .map((result: any) => result.testId)
    );

    // Build a map: testId -> testOrderId (includes sub-tests)
    const testToOrderMap = new Map<string, string>();
    // Build a map: testId -> testDefinitionId (from testOrder, for new-arch linking)
    const testToDefIdMap = new Map<string, string>();
    for (const testOrder of visit.testOrders) {
      // Map the ordered test itself
      testToOrderMap.set(testOrder.testId, testOrder.id);
      if (testOrder.testDefinitionId) {
        testToDefIdMap.set(testOrder.testId, testOrder.testDefinitionId);
      }
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

        // Create new result (either numeric value, textValue, or text notes)
        if (result.value !== null && result.value !== undefined || result.textValue || (result.notes && result.notes.trim())) {
          const numericValue = result.value != null ? parseFloat(result.value) : NaN;
          const isText = isNaN(numericValue);
          const defId = testToDefIdMap.get(result.testId) ?? null;
          const normalizedNotes = manualDerivedOverrideTestIds.has(result.testId)
            ? DERIVED_MANUAL_OVERRIDE_NOTE
            : (result.notes || null);
          // Prefer explicit textValue from frontend; fall back to notes for legacy clients
          const textVal = result.textValue || (isText ? (normalizedNotes || String(result.value ?? '')) : null);
          await tx.testResult.create({
            data: {
              testOrderId,
              testId: result.testId,
              reportVersionId: draftVersion.id,
              value: isText ? null : numericValue,
              textValue: textVal || null,
              flag: result.flag || null,
              notes: normalizedNotes,
              testDefinitionId: defId,
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
        select: { yearOfBirth: true, dateOfBirth: true, gender: true },
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
            patient.gender as any,
            undefined,
            patient.dateOfBirth
          );

          // Batch-update flags based on resolved ranges
          for (const r of flaggableResults) {
            const range = resolvedRanges.get(r.testId);
            if (!range) continue;

            const numValue = parseFloat(r.value);
            if (isNaN(numValue)) continue;

            const flag = determineResultFlag(numValue, range);

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
      const latestDefinitionFormulasByCode = await loadLatestDefinitionFormulasByCode(
        visit.testOrders.flatMap((testOrder) => [
          testOrder.testDefinition?.code ||
            testOrder.testCodeSnapshot ||
            testOrder.test.code,
          ...testOrder.test.childTests.map((child) => child.code),
        ])
      );

      const resultsByTestCode = new Map<string, number>();
      for (const r of results) {
        if (r.value === null || r.value === undefined) continue;

        const numericValue = parseFloat(r.value);
        if (isNaN(numericValue)) continue;

        const testOrder = visit.testOrders.find((order) => order.testId === r.testId);
        if (testOrder) {
          resultsByTestCode.set(
            testOrder.testDefinition?.code ||
              testOrder.testCodeSnapshot ||
              testOrder.test.code,
            numericValue
          );
          continue;
        }

        for (const order of visit.testOrders) {
          const childTest = order.test.childTests.find((child) => child.id === r.testId);
          if (childTest) {
            resultsByTestCode.set(childTest.code, numericValue);
            break;
          }
        }
      }

      const derivedTargets: DerivedFormulaTarget[] = [];
      for (const testOrder of visit.testOrders) {
        const orderCode =
          testOrder.testDefinition?.code ||
          testOrder.testCodeSnapshot ||
          testOrder.test.code;
        const latestOrderDefinition = latestDefinitionFormulasByCode.get(orderCode);
        const orderDerived =
          testOrder.testDefinition?.formulaExpression
            ? buildDerivedMetadata(
                testOrder.testDefinition.formulaExpression,
                testOrder.testDefinition.dependsOnCodes
              )
            : testOrder.test.derivedParameter?.formula
              ? buildDerivedMetadata(
                  testOrder.test.derivedParameter.formula,
                  testOrder.test.derivedParameter.dependsOnTestCodes
                )
              : buildDerivedMetadata(
                  latestOrderDefinition?.formulaExpression,
                  latestOrderDefinition?.dependsOnCodes
                );

        if (orderDerived.isDerived && orderDerived.formulaExpression && orderDerived.dependsOnCodes) {
          derivedTargets.push({
            testId: testOrder.testId,
            testDefinitionId: testOrder.testDefinitionId ?? null,
            code: orderCode,
            parameterName:
              testOrder.testDefinition?.name ||
              testOrder.test.derivedParameter?.parameterName ||
              latestOrderDefinition?.name ||
              testOrder.testNameSnapshot ||
              testOrder.test.name,
            formula: orderDerived.formulaExpression,
            dependsOnCodes: orderDerived.dependsOnCodes,
            displayOrder:
              testOrder.testDefinition?.displayOrder ??
              latestOrderDefinition?.displayOrder ??
              testOrder.test.displayOrder ??
              0,
          });
        }

        for (const childTest of testOrder.test.childTests) {
          const latestChildDefinition = latestDefinitionFormulasByCode.get(childTest.code);
          const childDerived = buildDerivedMetadata(
            childTest.derivedParameter?.formula || latestChildDefinition?.formulaExpression,
            childTest.derivedParameter?.dependsOnTestCodes || latestChildDefinition?.dependsOnCodes
          );

          if (childDerived.isDerived && childDerived.formulaExpression && childDerived.dependsOnCodes) {
            derivedTargets.push({
              testId: childTest.id,
              testDefinitionId: null,
              code: childTest.code,
              parameterName:
                childTest.derivedParameter?.parameterName ||
                latestChildDefinition?.name ||
                childTest.name,
              formula: childDerived.formulaExpression,
              dependsOnCodes: childDerived.dependsOnCodes,
              displayOrder:
                latestChildDefinition?.displayOrder ??
                childTest.displayOrder ??
                0,
            });
          }
        }
      }

      const derivedResults = evaluateDerivedTargets(
        derivedTargets,
        resultsByTestCode
      );

      if (derivedResults.length > 0) {
        const draftVer = visit.report?.versions[0];
        if (draftVer) {
          const patient = await prisma.patient.findUnique({
            where: { id: visit.patientId },
            select: { yearOfBirth: true, dateOfBirth: true, gender: true },
          });

          const derivedTestIds = derivedResults
            .filter((dr) => dr.value !== null)
            .map((dr) => dr.testId);

          const derivedRanges =
            patient && derivedTestIds.length > 0
              ? await resolveReferenceRanges(
                  derivedTestIds,
                  patient.yearOfBirth,
                  patient.gender as any,
                  testToDefIdMap.size > 0 ? testToDefIdMap : undefined,
                  patient.dateOfBirth
                )
              : new Map();

          for (const dr of derivedResults) {
            const orderIdForDerived = testToOrderMap.get(dr.testId);
            if (!orderIdForDerived) continue;

            if (manualDerivedOverrideTestIds.has(dr.testId)) {
              continue;
            }

            // Upsert derived result
            await prisma.testResult.deleteMany({
              where: {
                testOrderId: orderIdForDerived,
                testId: dr.testId,
                reportVersionId: draftVer.id,
              },
            });

            if (dr.value === null) {
              continue;
            }

            const derivedRange = derivedRanges.get(dr.testId);
            const derivedFlag = derivedRange
              ? determineResultFlag(dr.value, derivedRange)
              : null;

            await prisma.testResult.create({
              data: {
                testOrderId: orderIdForDerived,
                testId: dr.testId,
                reportVersionId: draftVer.id,
                value: dr.value,
                flag: derivedFlag,
                notes: `${DERIVED_AUTO_NOTE_PREFIX}${dr.parameterName}`,
                testDefinitionId:
                  dr.testDefinitionId ??
                  testToDefIdMap.get(dr.testId) ??
                  null,
              },
            });
          }

          for (const manualTestId of manualDerivedOverrideTestIds) {
            const manualInput = results.find((result: any) => result.testId === manualTestId);
            const manualOrderId = testToOrderMap.get(manualTestId);

            if (!manualInput || !manualOrderId) {
              continue;
            }

            const numericValue = manualInput.value !== null && manualInput.value !== undefined
              ? parseFloat(manualInput.value)
              : NaN;

            await prisma.testResult.deleteMany({
              where: {
                testOrderId: manualOrderId,
                testId: manualTestId,
                reportVersionId: draftVer.id,
              },
            });

            if (isNaN(numericValue)) {
              continue;
            }

            const manualRange = derivedRanges.get(manualTestId);
            const manualFlag = manualRange
              ? determineResultFlag(numericValue, manualRange)
              : null;

            await prisma.testResult.create({
              data: {
                testOrderId: manualOrderId,
                testId: manualTestId,
                reportVersionId: draftVer.id,
                value: numericValue,
                flag: manualFlag,
                notes: DERIVED_MANUAL_OVERRIDE_NOTE,
                testDefinitionId:
                  testToDefIdMap.get(manualTestId) ?? null,
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

    // Update status in a transaction
    await prisma.$transaction(async (tx) => {
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
    const snapshot = await buildEphemeralSnapshot(id);

    // Render HTML using the same renderer as the PDF pipeline
    const html = renderReportHtml(snapshot, {
      profile: 'screen',
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

// GET /api/visits/diagnostic/:id/finalized-report - Staff-only HTML view of the finalized report
router.get('/:id/finalized-report', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const loaded = await loadFinalizedReportSnapshotForVisit(id);

    if (!loaded.ok) {
      return res.status(loaded.status).json({
        error: loaded.error,
        message: loaded.message,
      });
    }

    const autoPrint = req.query.print === 'true';
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const qrDataUrl = autoPrint
      ? await QRCode.toDataURL(`${baseUrl}/reports/${await createAccessToken(loaded.reportVersionId)}`, {
          width: 100,
          margin: 1,
          color: { dark: '#000000', light: '#ffffff' },
        })
      : '';

    const html = renderReportHtml(loaded.snapshot, {
      profile: 'screen',
      baseUrl,
      qrDataUrl,
    });
    const finalHtml = autoPrint
      ? html.replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},600)}</script></body>')
      : html;

    await recordAccessByReportVersionId(
      loaded.reportVersionId,
      autoPrint ? 'PRINT' : 'VIEW',
      req.ip,
      req.get('user-agent'),
      req.user?.id
    );

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(finalHtml);
  } catch (err: any) {
    console.error('Finalized report view error:', err);
    return res.status(500).json({
      error: 'GENERATION_FAILED',
      message: 'Failed to generate finalized report view',
    });
  }
});

// GET /api/visits/diagnostic/:id/finalized-report/pdf - Staff-only finalized report PDF
router.get('/:id/finalized-report/pdf', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const mode = req.query.mode === 'physical' ? 'physical' : 'digital';
    const loaded = await loadFinalizedReportSnapshotForVisit(id);

    if (!loaded.ok) {
      return res.status(loaded.status).json({
        error: loaded.error,
        message: loaded.message,
      });
    }

    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const reportToken = await createAccessToken(loaded.reportVersionId);
    const reportUrl = `${baseUrl}/reports/${reportToken}`;
    const qrDataUrl = await QRCode.toDataURL(reportUrl, {
      width: 100,
      margin: 1,
      color: { dark: '#000000', light: '#ffffff' },
    });

    const html = renderReportHtml(loaded.snapshot, {
      profile: mode === 'physical' ? 'pdf-physical' : 'pdf-digital',
      baseUrl,
      qrDataUrl,
    });
    const pdfBuffer = await generatePdfFromHtml(html, { mode });

    await recordAccessByReportVersionId(
      loaded.reportVersionId,
      mode === 'physical' ? 'PRINT' : 'DOWNLOAD',
      req.ip,
      req.get('user-agent'),
      req.user?.id
    );

    const filename = mode === 'physical'
      ? `Report-${loaded.billNumber}-print.pdf`
      : `Report-${loaded.billNumber}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(pdfBuffer);
  } catch (err: any) {
    console.error('Finalized report PDF error:', err);
    return res.status(500).json({
      error: 'GENERATION_FAILED',
      message: 'Failed to generate finalized report PDF',
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
        referrals: {
          select: {
            referralDoctorId: true,
          },
        },
        diagnosticCenterReferrals: {
          select: {
            diagnosticCenterId: true,
          },
        },
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
    const finalizedAt = new Date();

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
          finalizedAt,
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
      // Create immutable snapshot
      const snapshot = await createReportSnapshot(draftVersion.id);
      await saveReportSnapshot(draftVersion.id, snapshot);

      // Create access token for report URL
      accessToken = await createAccessToken(draftVersion.id);
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
        finalizedAt: finalizedAt.toISOString(),
        reportAccessIssued: !!accessToken,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    const periodStartDate = new Date(finalizedAt);
    periodStartDate.setHours(0, 0, 0, 0);
    const periodEndDate = new Date(finalizedAt);
    periodEndDate.setHours(23, 59, 59, 999);

    const payoutRefreshTasks: Array<Promise<unknown>> = [];
    const referralDoctorId = visit.referrals[0]?.referralDoctorId;
    const diagnosticCenterId = visit.diagnosticCenterReferrals[0]?.diagnosticCenterId;

    if (referralDoctorId) {
      payoutRefreshTasks.push(
        derivePayout('REFERRAL', referralDoctorId, visit.branchId, periodStartDate, periodEndDate)
      );
    }

    if (diagnosticCenterId) {
      payoutRefreshTasks.push(
        derivePayout(
          'DIAGNOSTIC_CENTER',
          diagnosticCenterId,
          visit.branchId,
          periodStartDate,
          periodEndDate
        )
      );
    }

    if (payoutRefreshTasks.length > 0) {
      const refreshResults = await Promise.allSettled(payoutRefreshTasks);
      for (const result of refreshResults) {
        if (result.status === 'rejected') {
          console.error('Auto-refresh payout after diagnostic finalization failed:', result.reason);
        }
      }
    }

    // Fire-and-forget: Send report-ready notification via WhatsApp (non-blocking)
    import('../services/notificationService').then(({ sendReportReady }) => {
      sendReportReady(visit.id, accessToken || undefined).catch((err) =>
        console.error('[Notification] Report notification failed (non-blocking):', err.message)
      );
    });

    return res.json({ 
      success: true, 
      status: 'COMPLETED',
      reportFinalizedAt: finalizedAt,
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
