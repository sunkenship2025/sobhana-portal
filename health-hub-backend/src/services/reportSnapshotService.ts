/**
 * E3-10: Report Snapshot Service
 * 
 * Creates immutable snapshots of all report data at finalization time.
 * This is the SINGLE SOURCE OF TRUTH for rendering - never read live data.
 * 
 * Supports BOTH architectures:
 *   - Legacy: LabTest → PanelTestItem → PanelDefinition
 *   - New:    TestDefinition → ClinicalPanelItem → ClinicalPanel
 * 
 * When testResult has testDefinitionId, prefers ClinicalPanel chain.
 * Falls back to PanelTestItem chain for legacy data.
 * 
 * Snapshot includes:
 * - panelsSnapshot: Panel layout + test groupings
 * - signaturesSnapshot: Signing doctor details
 * - patientSnapshot: Patient demographics
 * - visitSnapshot: Visit metadata
 * - interpretationsSnapshot: Resolved interpretation texts
 */

import { Gender, DiagnosticWorkflowMode } from '@prisma/client';
import { resolveReferenceRanges } from './referenceRangeService';
import {
  evaluateDerivedTargets,
  normalizeDependencyCodes,
  type DerivedFormulaTarget,
} from './derivedParameterService';
import prisma from '../lib/prisma';

// ============================================================================
// TYPES
// ============================================================================

export interface TestResultSnapshot {
  testOrderId?: string;
  testId: string;
  testDefinitionId?: string;
  testCode: string;
  testName: string;
  value: number | null;
  textValue?: string | null;
  flag: string | null;
  notes: string | null;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  referenceText: string | null;
  criticalMin: number | null;
  criticalMax: number | null;
  sampleType: string | null;
  showMethod?: boolean;
  methodText: string | null;
  displayOrder: number;
  indentLevel: number;
  isBold?: boolean;
  isItalic?: boolean;
  subGroup: string | null;
  joinPrevious?: boolean;
  gridWidth?: number | null;
}

export interface PanelSnapshot {
  panelId: string;
  panelName: string;
  displayName: string;
  layoutType: string;
  panelMethodText?: string | null;
  panelMethodItalic?: boolean;
  sampleType: string | null;
  displayOrder: number;
  departmentId: string;
  departmentName: string;
  departmentHeaderText: string;
  showSubgroups?: boolean;
  showInterpretation?: boolean;
  subgroupMethods?: Record<string, string> | null;
  subgroupTableOverrides?: Record<string, boolean> | null;
  valueDisplayPrefix?: string | null;
  spacedDefinitionsGap?: number;
  tests: TestResultSnapshot[];
  interpretationHtml?: string;
  /** Per-narrative signer override the radiologist typed below the framed
   *  editor. When non-empty the renderer prints just this name above the
   *  department designation for this panel's page, regardless of any
   *  configured SigningRule. */
  signerNameOverride?: string | null;
}

export interface DepartmentSnapshot {
  departmentId: string;
  departmentName: string;
  departmentHeaderText: string;
  displayOrder: number;
  showLabIncharge: boolean;
  panels: PanelSnapshot[];
}

export interface SignatureSnapshot {
  departmentId?: string;
  departmentName?: string;
  doctorId: string;
  doctorName: string;
  degrees: string;
  designation: string;
  registrationNumber: string | null;
  signatureImagePath: string | null;
  signatureImageBase64: string | null;
  showLabInchargeNote: boolean;
  displayOrder: number;
}

export interface LabInchargeSnapshot {
  signerId: string;
  signerName: string;
  designation: string;
  signatureImagePath: string | null;
  signatureImageBase64: string | null;
}

export interface PatientSnapshot {
  patientId: string;
  patientNumber: string;
  name: string;
  title?: string | null;
  gender: string;
  yearOfBirth: number;
  dateOfBirth: string | null;
  age: number;
  ageDisplay: string; // Smart display: "45 Years", "7 Months", "18 Days"
  phone: string | null;
  address: string | null;
}

/** Compute a human-friendly age string from DOB or yearOfBirth + ageUnit */
function computeAgeDisplay(yearOfBirth: number, dateOfBirth?: Date | string | null, ageUnit?: string | null): string {
  const now = new Date();
  // If we have an exact DOB, compute precisely
  if (dateOfBirth) {
    const dob = new Date(dateOfBirth);
    const diffMs = now.getTime() - dob.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays < 30) return `${diffDays} Day${diffDays !== 1 ? 's' : ''}`;
    if (diffDays < 365) {
      const months = Math.floor(diffDays / 30.44);
      return `${months} Month${months !== 1 ? 's' : ''}`;
    }
    const years = Math.floor(diffDays / 365.25);
    return `${years} Year${years !== 1 ? 's' : ''}`;
  }
  // Fallback: use yearOfBirth with ageUnit hint
  const approxAge = now.getFullYear() - yearOfBirth;
  if (ageUnit === 'DAYS') return `${approxAge} Day${approxAge !== 1 ? 's' : ''}`;
  if (ageUnit === 'MONTHS') return `${approxAge} Month${approxAge !== 1 ? 's' : ''}`;
  return `${approxAge} Year${approxAge !== 1 ? 's' : ''}`;
}

export interface VisitSnapshot {
  visitId: string;
  billNumber: string;
  branchId: string;
  branchName: string;
  branchCode: string;
  referralDoctorName: string | null;
  createdAt: string;
  collectedAt: string | null;
  finalizedAt: string;
}

export interface ExternalUploadSnapshot {
  uploadId: string;            // ExternalReportUpload.id (for re-resolving R2 key)
  testOrderId: string;
  productName: string;         // e.g. "USG Pelvis - External"
  productCode: string;
  r2Key: string;
  originalFilename: string;
  pageCount: number | null;
  displayOrder: number;
  uploadedAt: string;
}

export interface ReportSnapshot {
  snapshotVersion: number;   // Schema version for forward-compatible rendering
  reportVersionId: string;
  versionNum: number;
  departments: DepartmentSnapshot[];
  signatures: SignatureSnapshot[];
  labIncharge: LabInchargeSnapshot | null;
  patient: PatientSnapshot;
  visit: VisitSnapshot;
  externalUploads: ExternalUploadSnapshot[];
}

type LatestDefinitionFormula = {
  id: string;
  code: string;
  name: string;
  displayOrder: number;
  formulaExpression: string | null;
  dependsOnCodes: unknown;
  panelItems?: any[];
  interpretationRules?: any[];
  sampleType?: string | null;
  method?: string | null;
  referenceMin?: number | null;
  referenceMax?: number | null;
  referenceUnit?: string | null;
  referenceText?: string | null;
  criticalMin?: number | null;
  criticalMax?: number | null;
};

/**
 * Derive a generic "Consultant <X>" designation from a department name when no
 * SigningRule is configured for that department. Heuristic only:
 *   - "-OLOGY"  → "-ologist"  (RADIOLOGY → Radiologist, PATHOLOGY → Pathologist)
 *   - "-ISTRY"  → "-ist"       (BIOCHEMISTRY → Biochemist, DENTISTRY → Dentist)
 *   - otherwise → "Consultant <Title-cased name>"
 */
export function deriveConsultantTitle(departmentName: string): string {
  const lower = departmentName.toLowerCase().trim();
  if (!lower) return 'Consultant';

  if (lower.endsWith('ology')) {
    const stem = lower.slice(0, -5);
    return `Consultant ${stem.charAt(0).toUpperCase()}${stem.slice(1)}ologist`;
  }

  if (lower.endsWith('istry')) {
    const stem = lower.slice(0, -3);
    return `Consultant ${stem.charAt(0).toUpperCase()}${stem.slice(1)}ist`;
  }

  const titled = lower.replace(/\b\w/g, (c) => c.toUpperCase());
  return `Consultant ${titled}`;
}

async function getLiveSignatureSnapshotsForDepartments(departmentIds: string[]): Promise<SignatureSnapshot[]> {
  const uniqueDepartmentIds = [...new Set(departmentIds.filter(Boolean))];
  if (uniqueDepartmentIds.length === 0) {
    return [];
  }

  const mapRuleToSnapshot = (rule: {
    departmentId: string;
    displayOrder: number;
    showLabInchargeNote: boolean;
    department: { name: string };
    signingDoctor: {
      id: string;
      name: string;
      degrees: string;
      designation: string;
      registrationNumber: string | null;
      signatureImagePath: string | null;
      signatureImageBase64: string | null;
    };
  }): SignatureSnapshot => {
    const doc = rule.signingDoctor;

    return {
      departmentId: rule.departmentId,
      departmentName: rule.department.name,
      doctorId: doc.id,
      doctorName: doc.name,
      degrees: doc.degrees,
      designation: doc.designation,
      registrationNumber: doc.registrationNumber,
      signatureImagePath: doc.signatureImagePath,
      signatureImageBase64: doc.signatureImageBase64 || null,
      showLabInchargeNote: rule.showLabInchargeNote,
      displayOrder: rule.displayOrder,
    };
  };

  const signingRules = await prisma.signingRule.findMany({
    where: {
      departmentId: { in: uniqueDepartmentIds },
      isActive: true,
      signingDoctor: {
        isActive: true,
      },
    },
    include: {
      department: true,
      signingDoctor: true,
    },
    orderBy: [
      { departmentId: 'asc' },
      { displayOrder: 'asc' },
    ],
  });

  const ruleSignatures = signingRules.map(mapRuleToSnapshot);
  const matchedDepartmentIds = new Set(
    ruleSignatures
      .map((s) => s.departmentId)
      .filter((id): id is string => Boolean(id)),
  );
  const unmatchedDepartmentIds = uniqueDepartmentIds.filter(
    (id) => !matchedDepartmentIds.has(id),
  );

  if (unmatchedDepartmentIds.length === 0) {
    return ruleSignatures;
  }

  // For every report-touching department that has no SigningRule, emit a
  // department-scoped placeholder ("Consultant Radiologist", etc.) instead of
  // borrowing a doctor from another department. doctorId is left empty so the
  // renderer can short-circuit to a designation-only block.
  const unmatchedDepartments = await prisma.department.findMany({
    where: { id: { in: unmatchedDepartmentIds } },
    select: { id: true, name: true, displayOrder: true },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
  });

  const placeholderSignatures: SignatureSnapshot[] = unmatchedDepartments.map(
    (dept, index) => ({
      departmentId: dept.id,
      departmentName: dept.name,
      doctorId: '',
      doctorName: '',
      degrees: '',
      designation: deriveConsultantTitle(dept.name),
      registrationNumber: null,
      signatureImagePath: null,
      signatureImageBase64: null,
      showLabInchargeNote: false,
      displayOrder: index,
    }),
  );

  return [...ruleSignatures, ...placeholderSignatures];
}

async function getLabInchargeSnapshotForBranch(branchId: string): Promise<LabInchargeSnapshot | null> {
  // Try branch-specific rule first
  const branchRule = await prisma.labInchargeRule.findFirst({
    where: {
      branchId,
      isActive: true,
    },
    include: {
      signingLabIncharge: true,
    },
    orderBy: { displayOrder: 'asc' },
  });

  const rule = branchRule || await prisma.labInchargeRule.findFirst({
    where: {
      branchId: null,
      isActive: true,
    },
    include: {
      signingLabIncharge: true,
    },
    orderBy: { displayOrder: 'asc' },
  });

  if (!rule?.signingLabIncharge) {
    return null;
  }

  const li = rule.signingLabIncharge;
  return {
    signerId: li.id,
    signerName: li.name,
    designation: li.designation,
    signatureImagePath: li.signatureImagePath,
    signatureImageBase64: li.signatureImageBase64 || null,
  };
}

async function backfillStoredSignatureAssets(signatures: SignatureSnapshot[]): Promise<SignatureSnapshot[]> {
  const uniqueDoctorIds = [...new Set(signatures.map(signature => signature.doctorId).filter(Boolean))];
  if (uniqueDoctorIds.length === 0) {
    return signatures;
  }

  const doctors = await prisma.signingDoctor.findMany({
    where: { id: { in: uniqueDoctorIds } },
    select: {
      id: true,
      name: true,
      degrees: true,
      designation: true,
      registrationNumber: true,
      signatureImagePath: true,
      signatureImageBase64: true,
    },
  });

  const doctorMap = new Map(doctors.map(doctor => [doctor.id, doctor]));

  return signatures.map((signature) => {
    const currentDoctor = doctorMap.get(signature.doctorId);
    if (!currentDoctor) {
      return signature;
    }

    return {
      ...signature,
      doctorName: signature.doctorName || currentDoctor.name,
      degrees: signature.degrees || currentDoctor.degrees,
      designation: signature.designation || currentDoctor.designation,
      registrationNumber: signature.registrationNumber || currentDoctor.registrationNumber,
      signatureImagePath: signature.signatureImagePath || currentDoctor.signatureImagePath,
      signatureImageBase64: signature.signatureImageBase64 || currentDoctor.signatureImageBase64 || null,
    };
  });
}

function filterReportableOrders<T extends { workflowMode?: DiagnosticWorkflowMode | null }>(orders: T[]): T[] {
  return orders.filter(
    (order) => (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) === DiagnosticWorkflowMode.REPORTABLE
  );
}

/**
 * Resolve all non-deleted external upload records for the visit's EXTERNAL_UPLOAD orders,
 * shaped for snapshot persistence. Returns an empty array when the visit has none.
 */
async function buildExternalUploadSnapshots(
  testOrders: Array<{
    id: string;
    workflowMode?: DiagnosticWorkflowMode | null;
    testNameSnapshot?: string | null;
    testCodeSnapshot?: string | null;
  }>
): Promise<ExternalUploadSnapshot[]> {
  const uploadOrders = testOrders.filter(
    (order) => order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD
  );
  if (uploadOrders.length === 0) {
    return [];
  }

  const orderById = new Map(uploadOrders.map((order) => [order.id, order]));
  const uploads = await prisma.externalReportUpload.findMany({
    where: {
      testOrderId: { in: uploadOrders.map((order) => order.id) },
      deletedAt: null,
    },
    orderBy: [
      { displayOrder: 'asc' },
      { uploadedAt: 'asc' },
    ],
  });

  return uploads.map((upload): ExternalUploadSnapshot => {
    const order = orderById.get(upload.testOrderId);
    return {
      uploadId: upload.id,
      testOrderId: upload.testOrderId,
      productName: order?.testNameSnapshot || 'External Report',
      productCode: order?.testCodeSnapshot || 'EXT',
      r2Key: upload.r2Key,
      originalFilename: upload.originalFilename,
      pageCount: upload.pageCount,
      displayOrder: upload.displayOrder,
      uploadedAt: upload.uploadedAt.toISOString(),
    };
  });
}

// ============================================================================
// INTERPRETATION MATCHING HELPERS
// ============================================================================

/**
 * Match interpretation using NEW InterpretationRule model (operator-based).
 * Supports NUMERIC (comparison operators) and TEXT (pattern matching) rules.
 */
function matchInterpretationRule(
  value: number | null,
  textValue: string | null,
  rules: any[]
): string | null {
  for (const rule of rules) {
    if (rule.ruleType === 'NUMERIC' && value !== null) {
      const v1 = rule.value1 as number;
      const v2 = rule.value2 as number | null;
      switch (rule.operator) {
        case 'LT':          if (value < v1) return rule.interpretationText; break;
        case 'LTE':         if (value <= v1) return rule.interpretationText; break;
        case 'GT':          if (value > v1) return rule.interpretationText; break;
        case 'GTE':         if (value >= v1) return rule.interpretationText; break;
        case 'EQ':          if (value === v1) return rule.interpretationText; break;
        case 'BETWEEN':     if (v2 !== null && value >= v1 && value <= v2) return rule.interpretationText; break;
        case 'NOT_BETWEEN': if (v2 !== null && (value < v1 || value > v2)) return rule.interpretationText; break;
      }
    } else if (rule.ruleType === 'TEXT' && textValue !== null && rule.operator === 'MATCH') {
      if (rule.textMatch && textValue.toLowerCase().includes(rule.textMatch.toLowerCase())) {
        return rule.interpretationText;
      }
    }
  }
  return null;
}

/**
 * Match interpretation using LEGACY InterpretationTemplate model (min/max range).
 */
function matchLegacyInterpretation(value: number | null, interpretations: any[]): string | null {
  if (value === null || interpretations.length === 0) return null;
  for (const interp of interpretations) {
    const minOk = interp.minValue === null || value >= interp.minValue;
    const maxOk = interp.maxValue === null || value < interp.maxValue;
    if (minOk && maxOk) return interp.interpretationText;
  }
  return null;
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
  value: number,
  range: {
    referenceMin: number | null;
    referenceMax: number | null;
    criticalMin: number | null;
    criticalMax: number | null;
  }
): string | null {
  if (range.criticalMax !== null && value > range.criticalMax) return 'CRITICAL_HIGH';
  if (range.criticalMin !== null && value < range.criticalMin) return 'CRITICAL_LOW';
  if (range.referenceMax !== null && value > range.referenceMax) return 'HIGH';
  if (range.referenceMin !== null && value < range.referenceMin) return 'LOW';
  if (range.referenceMin !== null || range.referenceMax !== null) return 'NORMAL';
  return null;
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
    include: {
      panelItems: {
        include: {
          panel: {
            include: { department: true },
          },
        },
      },
      interpretationRules: {
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' },
      },
    },
  });

  return new Map(definitions.map((definition) => [definition.code, definition]));
}

// ============================================================================
// SHARED PANEL-BUILDING LOGIC
// ============================================================================

/**
 * The Prisma include fragment for testResults that fetches BOTH legacy and new chains.
 * Used by both createReportSnapshot and buildEphemeralSnapshot.
 */
export const testResultInclude = {
  // Legacy chain: LabTest → PanelTestItem → PanelDefinition
  test: {
    include: {
      panelItems: {
        include: {
          panel: {
            include: { department: true },
          },
        },
      },
      interpretations: {
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' as const },
      },
      department: true,
    },
  },
  // New chain: TestDefinition → ClinicalPanelItem → ClinicalPanel
  testDefinition: {
    include: {
      panelItems: {
        include: {
          panel: {
            include: { department: true },
          },
        },
      },
      interpretationRules: {
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' as const },
      },
    },
  },
  testOrder: true,
} as const;

const testOrderIncludeForDerived = {
  test: {
    include: {
      panelItems: {
        include: {
          panel: {
            include: { department: true },
          },
        },
      },
      interpretations: {
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' as const },
      },
      department: true,
      derivedParameter: true,
      childTests: {
        include: {
          panelItems: {
            include: {
              panel: {
                include: { department: true },
              },
            },
          },
          interpretations: {
            where: { isActive: true },
            orderBy: { displayOrder: 'asc' as const },
          },
          department: true,
          derivedParameter: true,
        },
        orderBy: { displayOrder: 'asc' as const },
      },
    },
  },
  testDefinition: {
    include: {
      panelItems: {
        include: {
          panel: {
            include: { department: true },
          },
        },
      },
      interpretationRules: {
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' as const },
      },
    },
  },
  // Include product→panels to determine which panels were actually ordered
  product: {
    include: {
      panels: {
        select: { panelId: true },
      },
    },
  },
} as const;

async function backfillDerivedResults(
  testResults: any[],
  testOrders: any[],
  reportVersionId: string
): Promise<any[]> {
  const existingTestIds = new Set(testResults.map((result) => result.testId));
  const resultsByCode = new Map<string, number>();

  for (const result of testResults) {
    let rawValue: string | number | null = null;

    if (result.value !== null && result.value !== undefined) {
      rawValue = result.value;
    } else if (result.textValue) {
      rawValue = result.textValue;
    }

    if (rawValue === null) continue;
    const numericValue = parseFloat(String(rawValue));
    if (Number.isNaN(numericValue)) continue;

    const code = result.testDefinition?.code || result.test?.code;
    if (code) {
      resultsByCode.set(code, numericValue);
    }
  }

  const latestDefinitionFormulasByCode = await loadLatestDefinitionFormulasByCode(
    testOrders.flatMap((testOrder) => [
      testOrder.testDefinition?.code ||
        testOrder.testCodeSnapshot ||
        testOrder.test.code,
      ...testOrder.test.childTests.map((child: any) => child.code),
    ])
  );

  const derivedTargets: DerivedFormulaTarget[] = [];
  const targetContextByTestId = new Map<string, {
    test: any;
    testDefinition: any;
    testOrder: any;
  }>();

  for (const testOrder of testOrders) {
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

    if (
      !existingTestIds.has(testOrder.testId) &&
      orderDerived.isDerived &&
      orderDerived.formulaExpression &&
      orderDerived.dependsOnCodes
    ) {
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

      targetContextByTestId.set(testOrder.testId, {
        test: testOrder.test,
        testDefinition: testOrder.testDefinition ?? latestOrderDefinition ?? null,
        testOrder,
      });
    }

    for (const childTest of testOrder.test.childTests) {
      const latestChildDefinition = latestDefinitionFormulasByCode.get(childTest.code);
      const childDerived = buildDerivedMetadata(
        childTest.derivedParameter?.formula || latestChildDefinition?.formulaExpression,
        childTest.derivedParameter?.dependsOnTestCodes || latestChildDefinition?.dependsOnCodes
      );

      if (
        !existingTestIds.has(childTest.id) &&
        childDerived.isDerived &&
        childDerived.formulaExpression &&
        childDerived.dependsOnCodes
      ) {
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

        targetContextByTestId.set(childTest.id, {
          test: childTest,
          testDefinition: latestChildDefinition ?? null,
          testOrder,
        });
      }
    }
  }

  const derivedResults = evaluateDerivedTargets(derivedTargets, resultsByCode)
    .filter((result) => result.value !== null);

  const syntheticResults = derivedResults.map((result) => {
    const context = targetContextByTestId.get(result.testId);
    if (!context) {
      return null;
    }

    return {
      id: `derived-${reportVersionId}-${result.testId}`,
      reportVersionId,
      testOrderId: context.testOrder.id,
      testId: result.testId,
      testDefinitionId: result.testDefinitionId ?? null,
      value: result.value,
      textValue: null,
      flag: null,
      notes: `Auto-calculated: ${result.parameterName}`,
      test: context.test,
      testDefinition: context.testDefinition,
      testOrder: context.testOrder,
    };
  }).filter(Boolean);

  return [...testResults, ...syntheticResults];
}

function isSyntheticDerivedResult(result: any): boolean {
  return typeof result?.id === 'string' && result.id.startsWith('derived-');
}

function dedupeResultsForSnapshot(testResults: any[]): any[] {
  const byOrderAndTest = new Map<string, any>();

  for (const result of testResults) {
    const key = `${result.testOrderId}:${result.testId}`;
    const existing = byOrderAndTest.get(key);
    if (!existing) {
      byOrderAndTest.set(key, result);
      continue;
    }

    // Persisted rows should win over synthetic derived rows. Between two
    // persisted duplicates, use the newest row to match the DB cleanup
    // migration and preserve the latest technician edit.
    if (isSyntheticDerivedResult(existing) && !isSyntheticDerivedResult(result)) {
      byOrderAndTest.set(key, result);
      continue;
    }
    if (!isSyntheticDerivedResult(existing) && isSyntheticDerivedResult(result)) {
      continue;
    }

    const resultTime = result.createdAt ? new Date(result.createdAt).getTime() : 0;
    const existingTime = existing.createdAt ? new Date(existing.createdAt).getTime() : 0;
    if (
      resultTime > existingTime ||
      (resultTime === existingTime && String(result.id ?? '') > String(existing.id ?? ''))
    ) {
      byOrderAndTest.set(key, result);
    }
  }

  return Array.from(byOrderAndTest.values());
}

function dedupeStoredDepartmentSnapshotTests(
  departments: DepartmentSnapshot[]
): DepartmentSnapshot[] {
  return departments.map((department) => ({
    ...department,
    panels: department.panels.map((panel) => {
      const seenTests = new Set<string>();
      const tests = panel.tests.filter((test) => {
        const key = test.testOrderId
          ? `${test.testOrderId}:${test.testId}`
          : `${test.testId}:${test.testDefinitionId ?? ''}:${test.testCode}`;
        if (seenTests.has(key)) {
          return false;
        }
        seenTests.add(key);
        return true;
      });

      return { ...panel, tests };
    }),
  }));
}

function applyResolvedFlagsToResults(
  testResults: any[],
  resolvedRanges: Map<string, {
    referenceMin: number | null;
    referenceMax: number | null;
    referenceUnit: string | null;
    referenceText: string | null;
    criticalMin: number | null;
    criticalMax: number | null;
  }>
): any[] {
  return testResults.map((result) => {
    let effectiveValue: number | null = null;

    if (result.value !== null && result.value !== undefined) {
      effectiveValue = parseFloat(String(result.value));
    } else if (result.textValue) {
      effectiveValue = parseFloat(result.textValue);
    }

    if (result.flag || effectiveValue === null || Number.isNaN(effectiveValue)) {
      return result;
    }

    const range = resolvedRanges.get(result.test.id);
    if (!range) {
      return result;
    }

    const computedFlag = determineResultFlag(effectiveValue, range);
    if (!computedFlag) {
      return result;
    }

    return {
      ...result,
      flag: computedFlag,
    };
  });
}

/**
 * Builds panel map and department snapshots from test results.
 * Supports DUAL architecture:
 *   - If result has testDefinition with panelItems → ClinicalPanel chain (preferred)
 *   - Otherwise → PanelTestItem/PanelDefinition chain (legacy fallback)
 */
function buildPanelsAndDepartments(
  testResults: any[],
  resolvedRanges: Map<string, { referenceMin: number | null; referenceMax: number | null; referenceUnit: string | null; referenceText: string | null; criticalMin: number | null; criticalMax: number | null }>,
  orderedPanelIds?: Set<string>
): DepartmentSnapshot[] {
  // `signerNameOverride` is the doctor name a radiologist typed into the
  // per-narrative override input. First non-empty value wins at the panel
  // level — in practice narrative panels have one test result, so there's
  // only one signer per panel.
  const panelMap = new Map<
    string,
    { panel: any; results: any[]; signerNameOverride: string | null }
  >();

  // _AUTO_<CODE> panels are auto-generated single-test wrappers created so that
  // standalone tests can be billed and ordered. They are not real clinical groupings.
  // When several auto-only results share a real parent panel (e.g. RFT_PNL holds
  // BLOOD_UREA + S_CREATININE + S_URIC_ACID), render them under the parent panel.
  const isAutoPanelName = (name: string | null | undefined): boolean =>
    typeof name === 'string' && name.startsWith('_AUTO_');

  const rescueScores = new Map<string, number>();
  if (orderedPanelIds && orderedPanelIds.size > 0) {
    for (const result of testResults) {
      const testDef = result.testDefinition;
      const test = result.test;
      const items: any[] = (testDef && testDef.panelItems && testDef.panelItems.length > 0)
        ? testDef.panelItems
        : (test.panelItems || []);
      const orderedItems = items.filter((pi: any) => orderedPanelIds.has(pi.panel.id));
      if (orderedItems.length === 0) continue;
      const hasOrderedNonAuto = orderedItems.some((pi: any) => !isAutoPanelName(pi.panel.name));
      if (hasOrderedNonAuto) continue;
      const seen = new Set<string>();
      for (const pi of items) {
        const p = pi.panel;
        if (isAutoPanelName(p.name)) continue;
        if (seen.has(p.id)) continue;
        seen.add(p.id);
        rescueScores.set(p.id, (rescueScores.get(p.id) || 0) + 1);
      }
    }
  }

  const pickRenderPanelItems = (allPanelItems: any[]): any[] => {
    if (!orderedPanelIds || orderedPanelIds.size === 0) {
      return allPanelItems;
    }
    const orderedItems = allPanelItems.filter((pi: any) => orderedPanelIds.has(pi.panel.id));
    if (orderedItems.length === 0) return [];
    const orderedNonAuto = orderedItems.filter((pi: any) => !isAutoPanelName(pi.panel.name));
    if (orderedNonAuto.length > 0) {
      // Real panel was ordered; ignore AUTO duplicates.
      return orderedNonAuto;
    }
    // Auto-only — try to rescue to a shared non-AUTO parent panel.
    const rescueOptions = allPanelItems.filter(
      (pi: any) => !isAutoPanelName(pi.panel.name) && (rescueScores.get(pi.panel.id) || 0) >= 2
    );
    if (rescueOptions.length > 0) {
      rescueOptions.sort((a: any, b: any) => {
        const sa = rescueScores.get(a.panel.id) || 0;
        const sb = rescueScores.get(b.panel.id) || 0;
        if (sb !== sa) return sb - sa;
        return (a.panel.displayOrder ?? 0) - (b.panel.displayOrder ?? 0);
      });
      return [rescueOptions[0]];
    }
    return orderedItems;
  };

  for (const result of testResults) {
    const test = result.test;
    const testDef = result.testDefinition;

    // Determine which architecture to use
    const useNewChain = testDef && testDef.panelItems && testDef.panelItems.length > 0;

    const resultSignerOverride =
      typeof (result as any).signerNameOverride === 'string' &&
      (result as any).signerNameOverride.trim()
        ? ((result as any).signerNameOverride as string).trim()
        : null;

    if (useNewChain) {
      // ━━ NEW ARCHITECTURE: ClinicalPanelItem → ClinicalPanel ━━
      const chosenItems = pickRenderPanelItems(testDef.panelItems);
      for (const panelItem of chosenItems) {
        const panel = panelItem.panel;
        const key = panel.id;

        if (!panelMap.has(key)) {
          panelMap.set(key, { panel, results: [], signerNameOverride: null });
        }
        if (resultSignerOverride && !panelMap.get(key)!.signerNameOverride) {
          panelMap.get(key)!.signerNameOverride = resultSignerOverride;
        }

        // Match interpretation using InterpretationRule (operator-based)
        const interpretationText = matchInterpretationRule(
          result.value,
          result.textValue ?? null,
          testDef.interpretationRules || []
        );

        panelMap.get(key)!.results.push({
          testOrderId: result.testOrderId,
          testId: test.id,
          testDefinitionId: testDef.id,
          testCode: testDef.code || test.code,
          testName: testDef.name || test.name,
          value: result.value,
          textValue: result.textValue ?? null,
          flag: result.flag,
          notes: result.notes,
          referenceMin: resolvedRanges.get(test.id)?.referenceMin ?? testDef.referenceMin ?? test.referenceMin,
          referenceMax: resolvedRanges.get(test.id)?.referenceMax ?? testDef.referenceMax ?? test.referenceMax,
          referenceUnit: resolvedRanges.get(test.id)?.referenceUnit || testDef.referenceUnit || test.referenceUnit,
          referenceText: resolvedRanges.get(test.id)?.referenceText ?? testDef.referenceText ?? test.referenceText ?? null,
          criticalMin: resolvedRanges.get(test.id)?.criticalMin ?? testDef.criticalMin ?? null,
          criticalMax: resolvedRanges.get(test.id)?.criticalMax ?? testDef.criticalMax ?? null,
          sampleType: panel.sampleType ?? testDef.sampleType ?? test.sampleType ?? null,
          showMethod: panelItem.showMethod ?? false,
          methodText: panelItem.showMethod
            ? (panelItem.methodText ?? testDef.method ?? null)
            : null,
          displayOrder: panelItem.displayOrder,
          indentLevel: panelItem.indentLevel,
          isBold: panelItem.isBold,
          isItalic: panelItem.isItalic,
          subGroup: panelItem.subGroup,
          joinPrevious: panelItem.joinPrevious ?? false,
          gridWidth: panelItem.gridWidth ?? null,
          interpretationText,
        });
      }
    } else if (test.panelItems && test.panelItems.length > 0) {
      // ━━ LEGACY ARCHITECTURE: PanelTestItem → PanelDefinition ━━
      for (const panelItem of test.panelItems) {
        const panel = panelItem.panel;
        const key = panel.id;

        if (!panelMap.has(key)) {
          panelMap.set(key, { panel, results: [], signerNameOverride: null });
        }
        if (resultSignerOverride && !panelMap.get(key)!.signerNameOverride) {
          panelMap.get(key)!.signerNameOverride = resultSignerOverride;
        }

        const interpretationText = matchLegacyInterpretation(
          result.value,
          test.interpretations || []
        );

        panelMap.get(key)!.results.push({
          testOrderId: result.testOrderId,
          testId: test.id,
          testDefinitionId: testDef?.id ?? undefined,
          testCode: test.code,
          testName: test.name,
          value: result.value,
          textValue: result.textValue ?? null,
          flag: result.flag,
          notes: result.notes,
          referenceMin: resolvedRanges.get(test.id)?.referenceMin ?? test.referenceMin,
          referenceMax: resolvedRanges.get(test.id)?.referenceMax ?? test.referenceMax,
          referenceUnit: resolvedRanges.get(test.id)?.referenceUnit || test.referenceUnit,
          referenceText: resolvedRanges.get(test.id)?.referenceText ?? test.referenceText ?? null,
          criticalMin: resolvedRanges.get(test.id)?.criticalMin ?? null,
          criticalMax: resolvedRanges.get(test.id)?.criticalMax ?? null,
          sampleType: test.sampleType ?? null,
          showMethod: panelItem.showMethod ?? false,
          methodText: panelItem.showMethod
            ? (panelItem.methodText ?? testDef?.method ?? test.method ?? null)
            : null,
          displayOrder: panelItem.displayOrder,
          indentLevel: panelItem.indentLevel,
          isBold: panelItem.isBold ?? false,
          isItalic: panelItem.isItalic ?? false,
          subGroup: panelItem.subGroup,
          interpretationText,
        });
      }
    } else {
      // ━━ ORPHAN: test not linked to any panel ━━
      const interpretationText = useNewChain
        ? matchInterpretationRule(result.value, result.textValue ?? null, testDef?.interpretationRules || [])
        : matchLegacyInterpretation(result.value, test.interpretations || []);

      const dept = test.department;
      const deptId = dept?.id || '__general__';
      const orphanPanelKey = `__orphan__${deptId}`;

      if (!panelMap.has(orphanPanelKey)) {
        panelMap.set(orphanPanelKey, {
          panel: {
            id: orphanPanelKey,
            name: dept?.name || 'General',
            displayName: dept?.name || 'General',
            layoutType: 'STANDARD_TABLE',
            panelMethodText: null,
            panelMethodItalic: false,
            displayOrder: 9999,
            department: dept || { id: '__general__', name: 'General', reportHeaderText: '', displayOrder: 9999, showLabIncharge: true },
          },
          results: [],
          signerNameOverride: null,
        });
      }
      if (resultSignerOverride && !panelMap.get(orphanPanelKey)!.signerNameOverride) {
        panelMap.get(orphanPanelKey)!.signerNameOverride = resultSignerOverride;
      }

      panelMap.get(orphanPanelKey)!.results.push({
        testOrderId: result.testOrderId,
        testId: test.id,
        testDefinitionId: testDef?.id ?? undefined,
        testCode: testDef?.code || test.code,
        testName: testDef?.name || test.name,
        value: result.value,
        textValue: result.textValue ?? null,
        flag: result.flag,
        notes: result.notes,
        referenceMin: resolvedRanges.get(test.id)?.referenceMin ?? test.referenceMin,
        referenceMax: resolvedRanges.get(test.id)?.referenceMax ?? test.referenceMax,
        referenceUnit: resolvedRanges.get(test.id)?.referenceUnit || test.referenceUnit,
        referenceText: resolvedRanges.get(test.id)?.referenceText ?? test.referenceText ?? null,
        criticalMin: resolvedRanges.get(test.id)?.criticalMin ?? null,
        criticalMax: resolvedRanges.get(test.id)?.criticalMax ?? null,
        sampleType: test.sampleType ?? null,
        showMethod: false,
        methodText: null,
        displayOrder: test.displayOrder ?? 0,
        indentLevel: 0,
        isBold: false,
        isItalic: false,
        subGroup: null,
        interpretationText,
      });
    }
  }

  // Group panels by department
  const departmentMap = new Map<string, DepartmentSnapshot>();

  for (const [_panelId, { panel, results, signerNameOverride }] of panelMap) {
    const dept = panel.department;
    const deptId = dept.id;

    if (!departmentMap.has(deptId)) {
      departmentMap.set(deptId, {
        departmentId: deptId,
        departmentName: dept.name,
        departmentHeaderText: dept.reportHeaderText,
        displayOrder: dept.displayOrder,
        showLabIncharge: (dept as { showLabIncharge?: boolean }).showLabIncharge ?? true,
        panels: [],
      });
    }

    // Sort results by display order
    results.sort((a: any, b: any) => a.displayOrder - b.displayOrder);

    // Build interpretation HTML for panels with showInterpretation
    let interpretationHtml: string | undefined;
    const shouldShowInterp = panel.showInterpretation === true
      || panel.layoutType === 'INTERPRETATION_SINGLE'; // legacy compat
    if (shouldShowInterp) {
      const panelTemplate = panel.summaryInterpretationTemplate?.trim();
      if (panelTemplate) {
        interpretationHtml = panelTemplate;
      } else {
        const interpretations = results
          .filter((r: any) => r.interpretationText)
          .map((r: any) => r.interpretationText);
        if (interpretations.length > 0) {
          interpretationHtml = interpretations.join('\n\n');
        }
      }
    }

    departmentMap.get(deptId)!.panels.push({
      panelId: panel.id,
      panelName: panel.name,
      displayName: panel.displayName,
      layoutType: panel.layoutType,
      panelMethodText: panel.panelMethodText ?? null,
      panelMethodItalic: panel.panelMethodItalic ?? false,
      sampleType: panel.sampleType ?? null,
      displayOrder: panel.displayOrder,
      departmentId: deptId,
      departmentName: dept.name,
      departmentHeaderText: dept.reportHeaderText,
      showSubgroups: panel.showSubgroups ?? undefined,
      showInterpretation: panel.showInterpretation ?? undefined,
      subgroupMethods: (panel.subgroupMethods as Record<string, string>) ?? null,
      subgroupTableOverrides: (panel.subgroupTableOverrides as Record<string, boolean>) ?? null,
      valueDisplayPrefix: panel.valueDisplayPrefix ?? null,
      spacedDefinitionsGap: panel.spacedDefinitionsGap ?? 0,
      tests: results,
      interpretationHtml,
      signerNameOverride,
    });
  }

  // Sort departments and panels
  const departments = Array.from(departmentMap.values())
    .sort((a, b) => a.displayOrder - b.displayOrder);

  for (const dept of departments) {
    dept.panels.sort((a, b) => a.displayOrder - b.displayOrder);
  }

  return departments;
}

// ============================================================================
// SNAPSHOT CREATION
// ============================================================================

/**
 * Creates a complete snapshot of the report at finalization time.
 * This data is FROZEN and used for all future rendering.
 *
 * @param reportVersionId Version to snapshot.
 * @param options.selectedTestOrderIds When provided, the snapshot only
 *   includes results AND external uploads tied to these test orders. Used
 *   by the partial-release flow so unselected uploads (e.g. an MRI PDF the
 *   radiologist held back) don't get baked into the finalized version.
 */
export async function createReportSnapshot(
  reportVersionId: string,
  options?: { selectedTestOrderIds?: string[] | null },
): Promise<ReportSnapshot> {
  // Fetch all required data
  // IMPORTANT: panelItems lives on the INDIVIDUAL test (e.g. HB, RBC), NOT the parent panel (CBP).
  // testResult.test = the actual sub-test → has panelItems
  // testResult.testOrder.test = the ordered panel → has snapshot metadata
  const reportVersion = await prisma.reportVersion.findUnique({
    where: { id: reportVersionId },
    include: {
      testResults: {
        include: testResultInclude,
      },
      report: {
        include: {
          visit: {
            include: {
              patient: {
                include: {
                  identifiers: {
                    where: { type: 'PHONE', isPrimary: true },
                    take: 1,
                  },
                },
              },
              branch: true,
              referrals: {
                include: {
                  referralDoctor: true,
                },
                take: 1,
              },
              testOrders: {
                include: testOrderIncludeForDerived,
              },
            },
          },
        },
      },
    },
  });

  if (!reportVersion) {
    throw new Error(`ReportVersion ${reportVersionId} not found`);
  }

  const visit = reportVersion.report.visit;
  const patient = visit.patient;
  const allReportableOrders = filterReportableOrders(visit.testOrders as any[]);

  // Optional per-order scoping: when this snapshot is being created from a
  // partial release that explicitly excluded some orders (typically external
  // PDF uploads the radiologist held back), the snapshot should only contain
  // the selected orders. Otherwise the "all visit.testOrders" path would
  // silently bake the excluded MRI/X-ray PDFs into the finalized merged PDF.
  const selectedSet =
    options?.selectedTestOrderIds && options.selectedTestOrderIds.length > 0
      ? new Set(options.selectedTestOrderIds)
      : null;
  const reportableOrders = selectedSet
    ? allReportableOrders.filter((o: any) => selectedSet.has(o.id))
    : allReportableOrders;
  const filteredTestOrders = selectedSet
    ? (visit.testOrders as any[]).filter((o: any) => selectedSet.has(o.id))
    : (visit.testOrders as any[]);
  const filteredTestResults = selectedSet
    ? (reportVersion.testResults as any[]).filter((r: any) =>
        selectedSet.has(r.testOrderId),
      )
    : (reportVersion.testResults as any[]);

  const externalUploads = await buildExternalUploadSnapshots(filteredTestOrders);
  const augmentedTestResults = dedupeResultsForSnapshot(await backfillDerivedResults(
    filteredTestResults as any[],
    reportableOrders as any[],
    reportVersion.id
  ));

  // ============================================================================
  // RESOLVE AGE-AWARE REFERENCE RANGES (dual architecture)
  // ============================================================================

  const allTestIds = augmentedTestResults.map((r: any) => r.test.id);
  const uniqueTestIds = [...new Set(allTestIds)];

  // Build testDefinitionId map for results that have new-chain FK
  const testDefIdMap = new Map<string, string>();
  for (const r of augmentedTestResults) {
    if ((r as any).testDefinitionId && (r as any).testDefinition) {
      testDefIdMap.set(r.test.id, (r as any).testDefinitionId);
    }
  }

  const resolvedRanges = await resolveReferenceRanges(
    uniqueTestIds,
    patient.yearOfBirth,
    patient.gender as Gender,
    testDefIdMap.size > 0 ? testDefIdMap : undefined,
    patient.dateOfBirth
  );

  const flaggedResults = applyResolvedFlagsToResults(
    augmentedTestResults as any[],
    resolvedRanges
  );

  // Extract ordered panel IDs from test orders (prevents showing unordered panels)
  const orderedPanelIds = new Set<string>();
  for (const order of reportableOrders) {
    if (order.product?.panels) {
      for (const pp of order.product.panels) {
        orderedPanelIds.add(pp.panelId);
      }
    }
  }

  const departments = buildPanelsAndDepartments(
    flaggedResults as any[],
    resolvedRanges,
    orderedPanelIds.size > 0 ? orderedPanelIds : undefined
  );

  // ============================================================================
  // BUILD SIGNATURE SNAPSHOTS
  // ============================================================================
  
  const signatures = await getLiveSignatureSnapshotsForDepartments(
    departments.map(department => department.departmentId),
  );
  const labIncharge = await getLabInchargeSnapshotForBranch(visit.branchId);

  // ============================================================================
  // BUILD PATIENT SNAPSHOT
  // ============================================================================

  const currentYear = new Date().getFullYear();
  const age = currentYear - patient.yearOfBirth;
  
  const patientSnapshot: PatientSnapshot = {
    patientId: patient.id,
    patientNumber: patient.patientNumber,
    name: patient.name,
    title: (patient as any).title || null,
    gender: patient.gender,
    yearOfBirth: patient.yearOfBirth,
    dateOfBirth: patient.dateOfBirth?.toISOString() || null,
    age,
    ageDisplay: computeAgeDisplay(patient.yearOfBirth, patient.dateOfBirth, (patient as any).ageUnit),
    phone: patient.identifiers[0]?.value || null,
    address: patient.address,
  };
  
  const visitSnapshot: VisitSnapshot = {
    visitId: visit.id,
    billNumber: visit.billNumber,
    branchId: visit.branchId,
    branchName: visit.branch.name,
    branchCode: visit.branch.code,
    referralDoctorName: visit.referrals[0]?.referralDoctor.name || null,
    createdAt: visit.createdAt.toISOString(),
    collectedAt: visit.createdAt.toISOString(), // Sample collection time defaults to registration
    finalizedAt: new Date().toISOString(),
  };

  return {
    snapshotVersion: 1,
    reportVersionId,
    versionNum: reportVersion.versionNum,
    departments,
    signatures,
    labIncharge,
    patient: patientSnapshot,
    visit: visitSnapshot,
    externalUploads,
  };
}

/**
 * Builds an ephemeral (non-persisted) snapshot from live draft data.
 * Used for staff preview before finalization — same rendering pipeline,
 * but nothing is saved and no finalization status is required.
 *
 * @param visitId Diagnostic visit id.
 * @param options.selectedTestOrderIds When provided, the snapshot only includes
 *   results and external uploads tied to these test orders. Used by the staff
 *   "preview before partial release" flow so the preview matches what will
 *   actually ship to the patient.
 */
export async function buildEphemeralSnapshot(
  visitId: string,
  options?: { selectedTestOrderIds?: string[] | null },
): Promise<ReportSnapshot> {
  // Find the visit's report and its latest version (DRAFT)
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      patient: {
        include: {
          identifiers: {
            where: { type: 'PHONE', isPrimary: true },
            take: 1,
          },
        },
      },
      branch: true,
      referrals: {
        include: { referralDoctor: true },
        take: 1,
      },
      testOrders: {
        include: testOrderIncludeForDerived,
      },
      report: {
        include: {
          versions: {
            orderBy: { versionNum: 'desc' },
            take: 1,
            include: {
              testResults: {
                include: testResultInclude,
              },
            },
          },
        },
      },
    },
  });

  if (!visit) {
    throw new Error(`Visit ${visitId} not found`);
  }

  const reportVersion = visit.report?.versions?.[0];
  if (!reportVersion) {
    throw new Error(`No report version found for visit ${visitId}`);
  }

  const patient = visit.patient;
  const allReportableOrders = filterReportableOrders(visit.testOrders as any[]);

  // Optional per-test scoping: when staff arrived via the partial-release
  // selector dialog, only the chosen test orders should appear in the
  // preview / snapshot. Unsupplied or empty filter ⇒ include everything,
  // matching the legacy behavior.
  const selectedSet =
    options?.selectedTestOrderIds && options.selectedTestOrderIds.length > 0
      ? new Set(options.selectedTestOrderIds)
      : null;
  const reportableOrders = selectedSet
    ? allReportableOrders.filter((o: any) => selectedSet.has(o.id))
    : allReportableOrders;
  const filteredTestOrders = selectedSet
    ? (visit.testOrders as any[]).filter((o: any) => selectedSet.has(o.id))
    : (visit.testOrders as any[]);
  const filteredTestResults = selectedSet
    ? (reportVersion.testResults as any[]).filter((r: any) =>
        selectedSet.has(r.testOrderId),
      )
    : (reportVersion.testResults as any[]);

  const externalUploads = await buildExternalUploadSnapshots(filteredTestOrders);

  // External-upload visits have no test results — the report content is the
  // appended PDFs themselves. Only block when there's neither values nor uploads.
  if (filteredTestResults.length === 0 && externalUploads.length === 0) {
    throw new Error('No test results entered yet');
  }
  const augmentedTestResults = dedupeResultsForSnapshot(await backfillDerivedResults(
    filteredTestResults as any[],
    reportableOrders as any[],
    reportVersion.id
  ));

  // Resolve age-aware reference ranges (dual architecture)
  const allTestIds = augmentedTestResults.map((r: any) => r.test.id);
  const uniqueTestIds = [...new Set(allTestIds)];

  const testDefIdMap = new Map<string, string>();
  for (const r of augmentedTestResults) {
    if ((r as any).testDefinitionId && (r as any).testDefinition) {
      testDefIdMap.set((r as any).test.id, (r as any).testDefinitionId);
    }
  }

  const resolvedRanges = await resolveReferenceRanges(
    uniqueTestIds,
    patient.yearOfBirth,
    patient.gender as Gender,
    testDefIdMap.size > 0 ? testDefIdMap : undefined,
    patient.dateOfBirth
  );

  // Build panel snapshots — shared helper handles dual architecture
  const flaggedResults = applyResolvedFlagsToResults(
    augmentedTestResults as any[],
    resolvedRanges
  );

  // Extract ordered panel IDs from test orders (prevents showing unordered panels)
  const orderedPanelIds = new Set<string>();
  for (const order of reportableOrders) {
    if (order.product?.panels) {
      for (const pp of order.product.panels) {
        orderedPanelIds.add(pp.panelId);
      }
    }
  }

  const departments = buildPanelsAndDepartments(
    flaggedResults as any[],
    resolvedRanges,
    orderedPanelIds.size > 0 ? orderedPanelIds : undefined
  );
  const signatures = await getLiveSignatureSnapshotsForDepartments(
    departments.map(department => department.departmentId),
  );
  const labIncharge = await getLabInchargeSnapshotForBranch(visit.branchId);

  // Build patient snapshot
  const currentYear = new Date().getFullYear();
  const age = currentYear - patient.yearOfBirth;

  const patientSnapshot: PatientSnapshot = {
    patientId: patient.id,
    patientNumber: patient.patientNumber,
    name: patient.name,
    title: (patient as any).title || null,
    gender: patient.gender,
    yearOfBirth: patient.yearOfBirth,
    dateOfBirth: patient.dateOfBirth?.toISOString() || null,
    age,
    ageDisplay: computeAgeDisplay(patient.yearOfBirth, patient.dateOfBirth, (patient as any).ageUnit),
    phone: patient.identifiers[0]?.value || null,
    address: patient.address,
  };

  // Build visit snapshot — use current time as placeholder for finalizedAt
  const visitSnapshot: VisitSnapshot = {
    visitId: visit.id,
    billNumber: visit.billNumber,
    branchId: visit.branchId,
    branchName: visit.branch.name,
    branchCode: visit.branch.code,
    referralDoctorName: visit.referrals[0]?.referralDoctor.name || null,
    createdAt: visit.createdAt.toISOString(),
    collectedAt: visit.createdAt.toISOString(),
    finalizedAt: new Date().toISOString(),
  };

  return {
    snapshotVersion: 1,
    reportVersionId: reportVersion.id,
    versionNum: reportVersion.versionNum,
    departments,
    signatures,
    labIncharge,
    patient: patientSnapshot,
    visit: visitSnapshot,
    externalUploads,
  };
}

/**
 * Saves the snapshot to the ReportVersion record.
 * Called during finalization.
 *
 * SIGNATURE DEDUPLICATION:
 * Signature image bytes (`signatureImageBase64`, ~30-150KB per ReportVersion)
 * are NOT persisted into `signaturesSnapshot`. Instead the snapshot stores
 * doctor identity + cosmetic fields, and `getReportSnapshot` re-hydrates the
 * image bytes from `SigningDoctor` at read time via `backfillStoredSignatureAssets`.
 *
 * Trade-off: if a doctor's signature image is later updated, historical
 * reports will render with the new image. Doctor identity (name, registration
 * number) is still snapshotted, so the legal/identifying info is preserved.
 *
 * IMPORTANT: do NOT hard-delete `SigningDoctor` rows — historical reports
 * will lose their signature image. Soft-delete via `isActive=false` only.
 */
export async function saveReportSnapshot(
  reportVersionId: string,
  snapshot: ReportSnapshot
): Promise<void> {
  // Strip signature image bytes before persisting. They live on `SigningDoctor`
  // and `SigningLabIncharge` and are hydrated at read time.
  const slimSignatures = snapshot.signatures.map((sig) => {
    const { signatureImageBase64: _omit, ...rest } = sig;
    void _omit;
    return rest;
  });

  const slimLabIncharge = snapshot.labIncharge
    ? { ...snapshot.labIncharge, signatureImageBase64: undefined }
    : null;

  await prisma.reportVersion.update({
    where: { id: reportVersionId },
    data: {
      panelsSnapshot: snapshot.departments as any,
      signaturesSnapshot: slimSignatures as any,
      labInchargeSnapshot: slimLabIncharge as any,
      patientSnapshot: snapshot.patient as any,
      visitSnapshot: snapshot.visit as any,
      externalUploadsSnapshot: snapshot.externalUploads as any,
    },
  });
}

/**
 * Retrieves the stored snapshot from ReportVersion.
 * This is the ONLY data source for rendering.
 */
export async function getReportSnapshot(reportVersionId: string): Promise<ReportSnapshot | null> {
  const reportVersion = await prisma.reportVersion.findUnique({
    where: { id: reportVersionId },
    select: {
      id: true,
      versionNum: true,
      status: true,
      panelsSnapshot: true,
      signaturesSnapshot: true,
      labInchargeSnapshot: true,
      patientSnapshot: true,
      visitSnapshot: true,
      externalUploadsSnapshot: true,
    },
  });

  if (!reportVersion || reportVersion.status !== 'FINALIZED') {
    return null;
  }

  if (!reportVersion.panelsSnapshot || !reportVersion.patientSnapshot || !reportVersion.visitSnapshot) {
    return null;
  }

  const departments = dedupeStoredDepartmentSnapshotTests(
    reportVersion.panelsSnapshot as unknown as DepartmentSnapshot[]
  );
  const storedSignatures = (reportVersion.signaturesSnapshot || []) as unknown as SignatureSnapshot[];
  const hasDepartmentScopedSignatures = storedSignatures.length > 0
    && storedSignatures.every((signature) => Boolean(signature.departmentId));
  const signatures = hasDepartmentScopedSignatures
    ? await backfillStoredSignatureAssets(storedSignatures)
    : await getLiveSignatureSnapshotsForDepartments(departments.map(department => department.departmentId));

  // Re-hydrate lab incharge signature if stored
  let labIncharge: LabInchargeSnapshot | null = (reportVersion.labInchargeSnapshot as unknown as LabInchargeSnapshot | null) ?? null;
  if (labIncharge?.signerId) {
    const currentLabIncharge = await prisma.signingLabIncharge.findUnique({
      where: { id: labIncharge.signerId },
      select: {
        id: true,
        name: true,
        designation: true,
        signatureImagePath: true,
        signatureImageBase64: true,
      },
    });
    if (currentLabIncharge) {
      labIncharge = {
        signerId: currentLabIncharge.id,
        signerName: currentLabIncharge.name,
        designation: currentLabIncharge.designation,
        signatureImagePath: currentLabIncharge.signatureImagePath,
        signatureImageBase64: currentLabIncharge.signatureImageBase64 || null,
      };
    }
  }

  const externalUploads =
    (reportVersion.externalUploadsSnapshot as unknown as ExternalUploadSnapshot[] | null) ?? [];

  return {
    snapshotVersion: (reportVersion.panelsSnapshot as any)?.snapshotVersion ?? 1,
    reportVersionId: reportVersion.id,
    versionNum: reportVersion.versionNum,
    departments,
    signatures,
    labIncharge,
    patient: reportVersion.patientSnapshot as unknown as PatientSnapshot,
    visit: reportVersion.visitSnapshot as unknown as VisitSnapshot,
    externalUploads,
  };
}
