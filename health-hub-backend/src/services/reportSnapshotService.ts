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

import { PrismaClient, ReportVersion, TestResult, Gender } from '@prisma/client';
import { resolveReferenceRanges } from './referenceRangeService';

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

/**
 * Builds panel map and department snapshots from test results.
 * Supports DUAL architecture:
 *   - If result has testDefinition with panelItems → ClinicalPanel chain (preferred)
 *   - Otherwise → PanelTestItem/PanelDefinition chain (legacy fallback)
 */
function buildPanelsAndDepartments(
  testResults: any[],
  resolvedRanges: Map<string, { referenceMin: number | null; referenceMax: number | null; referenceUnit: string | null; referenceText: string | null; criticalMin: number | null; criticalMax: number | null }>
): DepartmentSnapshot[] {
  const panelMap = new Map<string, { panel: any; results: any[] }>();

  for (const result of testResults) {
    const test = result.test;
    const testDef = result.testDefinition;

    // Determine which architecture to use
    const useNewChain = testDef && testDef.panelItems && testDef.panelItems.length > 0;

    if (useNewChain) {
      // ━━ NEW ARCHITECTURE: ClinicalPanelItem → ClinicalPanel ━━
      for (const panelItem of testDef.panelItems) {
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
          methodText: panelItem.methodText ?? testDef.method ?? null,
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
          methodText: panelItem.methodText ?? testDef?.method ?? test.method ?? null,
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
        methodText: test.method ?? null,
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

  // ============================================================================
  // RESOLVE AGE-AWARE REFERENCE RANGES (dual architecture)
  // ============================================================================

  const allTestIds = reportVersion.testResults.map((r: any) => r.test.id);
  const uniqueTestIds = [...new Set(allTestIds)];

  // Build testDefinitionId map for results that have new-chain FK
  const testDefIdMap = new Map<string, string>();
  for (const r of reportVersion.testResults) {
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

  const departments = buildPanelsAndDepartments(reportVersion.testResults as any[], resolvedRanges);

  // ============================================================================
  // BUILD SIGNATURE SNAPSHOTS
  // ============================================================================
  
  // Get unique department IDs from the report
  const reportDeptIds = new Set(departments.map(d => d.departmentId));
  
  // Fetch signing rules for these departments
  const signingRules = await prisma.signingRule.findMany({
    where: {
      departmentId: { in: Array.from(reportDeptIds) },
      isActive: true,
    },
    include: {
      signingDoctor: true,
    },
    orderBy: { displayOrder: 'asc' },
  });
  
  // Deduplicate doctors (same doctor may sign multiple departments)
  const signatureMap = new Map<string, SignatureSnapshot>();
  
  for (const rule of signingRules) {
    const doc = rule.signingDoctor;
    if (!signatureMap.has(doc.id)) {
      signatureMap.set(doc.id, {
        doctorId: doc.id,
        doctorName: doc.name,
        degrees: doc.degrees,
        designation: doc.designation,
        registrationNumber: doc.registrationNumber,
        signatureImagePath: doc.signatureImagePath,
        signatureImageBase64: doc.signatureImageBase64 || null,
        showLabInchargeNote: rule.showLabInchargeNote,
        displayOrder: rule.displayOrder,
      });
    }
  }

  const signatures = Array.from(signatureMap.values())
    .sort((a, b) => a.displayOrder - b.displayOrder);

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

  // Resolve age-aware reference ranges (dual architecture)
  const allTestIds = reportVersion.testResults.map((r: any) => r.test.id);
  const uniqueTestIds = [...new Set(allTestIds)];

  const testDefIdMap = new Map<string, string>();
  for (const r of reportVersion.testResults) {
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
  const departments = buildPanelsAndDepartments(reportVersion.testResults as any[], resolvedRanges);
  const reportDeptIds = new Set(departments.map(d => d.departmentId));
  const signingRules = await prisma.signingRule.findMany({
    where: {
      departmentId: { in: Array.from(reportDeptIds) },
      isActive: true,
    },
    include: { signingDoctor: true },
    orderBy: { displayOrder: 'asc' },
  });

  const signatureMap = new Map<string, SignatureSnapshot>();
  for (const rule of signingRules) {
    const doc = rule.signingDoctor;
    if (!signatureMap.has(doc.id)) {
      signatureMap.set(doc.id, {
        doctorId: doc.id,
        doctorName: doc.name,
        degrees: doc.degrees,
        designation: doc.designation,
        registrationNumber: doc.registrationNumber,
        signatureImagePath: doc.signatureImagePath,
        signatureImageBase64: doc.signatureImageBase64 || null,
        showLabInchargeNote: rule.showLabInchargeNote,
        displayOrder: rule.displayOrder,
      });
    }
  }

  const signatures = Array.from(signatureMap.values())
    .sort((a, b) => a.displayOrder - b.displayOrder);

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

  return {
    snapshotVersion: (reportVersion.panelsSnapshot as any)?.snapshotVersion ?? 1,
    reportVersionId: reportVersion.id,
    versionNum: reportVersion.versionNum,
    departments: reportVersion.panelsSnapshot as unknown as DepartmentSnapshot[],
    signatures: (reportVersion.signaturesSnapshot || []) as unknown as SignatureSnapshot[],
    patient: reportVersion.patientSnapshot as unknown as PatientSnapshot,
    visit: reportVersion.visitSnapshot as unknown as VisitSnapshot,
  };
}
