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

import { PrismaClient, ReportVersion, TestResult, Gender, DiagnosticWorkflowMode } from '@prisma/client';
import { resolveReferenceRanges } from './referenceRangeService';
import {
  evaluateDerivedTargets,
  normalizeDependencyCodes,
  type DerivedFormulaTarget,
} from './derivedParameterService';

const prisma = new PrismaClient();

// ============================================================================
// TYPES
// ============================================================================

export interface TestResultSnapshot {
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
  tests: TestResultSnapshot[];
  interpretationHtml?: string;
}

export interface DepartmentSnapshot {
  departmentId: string;
  departmentName: string;
  departmentHeaderText: string;
  displayOrder: number;
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

export interface PatientSnapshot {
  patientId: string;
  patientNumber: string;
  name: string;
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

export interface ReportSnapshot {
  snapshotVersion: number;   // Schema version for forward-compatible rendering
  reportVersionId: string;
  versionNum: number;
  departments: DepartmentSnapshot[];
  signatures: SignatureSnapshot[];
  patient: PatientSnapshot;
  visit: VisitSnapshot;
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

  if (signingRules.length > 0) {
    return signingRules.map(mapRuleToSnapshot);
  }

  const fallbackRules = await prisma.signingRule.findMany({
    where: {
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
      { department: { displayOrder: 'asc' } },
      { displayOrder: 'asc' },
    ],
  });

  if (fallbackRules.length > 0) {
    return fallbackRules.map(mapRuleToSnapshot);
  }

  const fallbackDoctors = await prisma.signingDoctor.findMany({
    where: { isActive: true },
    orderBy: [
      { createdAt: 'asc' },
      { name: 'asc' },
    ],
  });

  return fallbackDoctors.map((doctor, index) => ({
    doctorId: doctor.id,
    doctorName: doctor.name,
    degrees: doctor.degrees,
    designation: doctor.designation,
    registrationNumber: doctor.registrationNumber,
    signatureImagePath: doctor.signatureImagePath,
    signatureImageBase64: doctor.signatureImageBase64 || null,
    showLabInchargeNote: index === 0,
    displayOrder: index,
  }));
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
    if (result.value === null || result.value === undefined) continue;
    const numericValue = Number(result.value);
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
    if (result.flag || result.value === null || result.value === undefined) {
      return result;
    }

    const range = resolvedRanges.get(result.test.id);
    if (!range) {
      return result;
    }

    const computedFlag = determineResultFlag(Number(result.value), range);
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
  const panelMap = new Map<string, { panel: any; results: any[] }>();

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

    if (useNewChain) {
      // ━━ NEW ARCHITECTURE: ClinicalPanelItem → ClinicalPanel ━━
      const chosenItems = pickRenderPanelItems(testDef.panelItems);
      for (const panelItem of chosenItems) {
        const panel = panelItem.panel;
        const key = panel.id;

        if (!panelMap.has(key)) {
          panelMap.set(key, { panel, results: [] });
        }

        // Match interpretation using InterpretationRule (operator-based)
        const interpretationText = matchInterpretationRule(
          result.value,
          result.textValue ?? null,
          testDef.interpretationRules || []
        );

        panelMap.get(key)!.results.push({
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
          interpretationText,
        });
      }
    } else if (test.panelItems && test.panelItems.length > 0) {
      // ━━ LEGACY ARCHITECTURE: PanelTestItem → PanelDefinition ━━
      for (const panelItem of test.panelItems) {
        const panel = panelItem.panel;
        const key = panel.id;

        if (!panelMap.has(key)) {
          panelMap.set(key, { panel, results: [] });
        }

        const interpretationText = matchLegacyInterpretation(
          result.value,
          test.interpretations || []
        );

        panelMap.get(key)!.results.push({
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
            department: dept || { id: '__general__', name: 'General', reportHeaderText: '', displayOrder: 9999 },
          },
          results: [],
        });
      }

      panelMap.get(orphanPanelKey)!.results.push({
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

  for (const [_panelId, { panel, results }] of panelMap) {
    const dept = panel.department;
    const deptId = dept.id;

    if (!departmentMap.has(deptId)) {
      departmentMap.set(deptId, {
        departmentId: deptId,
        departmentName: dept.name,
        departmentHeaderText: dept.reportHeaderText,
        displayOrder: dept.displayOrder,
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
      const interpretations = results
        .filter((r: any) => r.interpretationText)
        .map((r: any) => r.interpretationText);
      if (interpretations.length > 0) {
        interpretationHtml = interpretations.join('\n\n');
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
      tests: results,
      interpretationHtml,
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
 */
export async function createReportSnapshot(reportVersionId: string): Promise<ReportSnapshot> {
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
  const reportableOrders = filterReportableOrders(visit.testOrders as any[]);
  const augmentedTestResults = await backfillDerivedResults(
    reportVersion.testResults as any[],
    reportableOrders as any[],
    reportVersion.id
  );

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

  // ============================================================================
  // BUILD PATIENT SNAPSHOT
  // ============================================================================
  
  const currentYear = new Date().getFullYear();
  const age = currentYear - patient.yearOfBirth;
  
  const patientSnapshot: PatientSnapshot = {
    patientId: patient.id,
    patientNumber: patient.patientNumber,
    name: patient.name,
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
    patient: patientSnapshot,
    visit: visitSnapshot,
  };
}

/**
 * Builds an ephemeral (non-persisted) snapshot from live draft data.
 * Used for staff preview before finalization — same rendering pipeline,
 * but nothing is saved and no finalization status is required.
 */
export async function buildEphemeralSnapshot(visitId: string): Promise<ReportSnapshot> {
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

  if (reportVersion.testResults.length === 0) {
    throw new Error('No test results entered yet');
  }

  const patient = visit.patient;
  const reportableOrders = filterReportableOrders(visit.testOrders as any[]);
  const augmentedTestResults = await backfillDerivedResults(
    reportVersion.testResults as any[],
    reportableOrders as any[],
    reportVersion.id
  );

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

  // Build patient snapshot
  const currentYear = new Date().getFullYear();
  const age = currentYear - patient.yearOfBirth;

  const patientSnapshot: PatientSnapshot = {
    patientId: patient.id,
    patientNumber: patient.patientNumber,
    name: patient.name,
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
    patient: patientSnapshot,
    visit: visitSnapshot,
  };
}

/**
 * Saves the snapshot to the ReportVersion record.
 * Called during finalization.
 */
export async function saveReportSnapshot(
  reportVersionId: string,
  snapshot: ReportSnapshot
): Promise<void> {
  await prisma.reportVersion.update({
    where: { id: reportVersionId },
    data: {
      panelsSnapshot: snapshot.departments as any,
      signaturesSnapshot: snapshot.signatures as any,
      patientSnapshot: snapshot.patient as any,
      visitSnapshot: snapshot.visit as any,
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
      patientSnapshot: true,
      visitSnapshot: true,
    },
  });

  if (!reportVersion || reportVersion.status !== 'FINALIZED') {
    return null;
  }

  if (!reportVersion.panelsSnapshot || !reportVersion.patientSnapshot || !reportVersion.visitSnapshot) {
    return null;
  }

  const departments = reportVersion.panelsSnapshot as unknown as DepartmentSnapshot[];
  const storedSignatures = (reportVersion.signaturesSnapshot || []) as unknown as SignatureSnapshot[];
  const hasDepartmentScopedSignatures = storedSignatures.length > 0
    && storedSignatures.every((signature) => Boolean(signature.departmentId));
  const signatures = hasDepartmentScopedSignatures
    ? await backfillStoredSignatureAssets(storedSignatures)
    : await getLiveSignatureSnapshotsForDepartments(departments.map(department => department.departmentId));

  return {
    snapshotVersion: (reportVersion.panelsSnapshot as any)?.snapshotVersion ?? 1,
    reportVersionId: reportVersion.id,
    versionNum: reportVersion.versionNum,
    departments,
    signatures,
    patient: reportVersion.patientSnapshot as unknown as PatientSnapshot,
    visit: reportVersion.visitSnapshot as unknown as VisitSnapshot,
  };
}
