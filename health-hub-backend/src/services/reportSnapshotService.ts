/**
 * E3-10: Report Snapshot Service
 * 
 * Creates immutable snapshots of all report data at finalization time.
 * This is the SINGLE SOURCE OF TRUTH for rendering - never read live data.
 * 
 * Snapshot includes:
 * - panelsSnapshot: Panel layout + test groupings
 * - signaturesSnapshot: Signing doctor details
 * - patientSnapshot: Patient demographics
 * - visitSnapshot: Visit metadata
 * - interpretationsSnapshot: Resolved interpretation texts
 */

import { PrismaClient, ReportVersion, TestResult } from '@prisma/client';

const prisma = new PrismaClient();

// ============================================================================
// TYPES
// ============================================================================

export interface TestResultSnapshot {
  testId: string;
  testCode: string;
  testName: string;
  value: number | null;
  flag: string | null;
  notes: string | null;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  methodText: string | null;
  displayOrder: number;
  indentLevel: number;
  subGroup: string | null;
}

export interface PanelSnapshot {
  panelId: string;
  panelName: string;
  displayName: string;
  layoutType: string;
  displayOrder: number;
  departmentId: string;
  departmentName: string;
  departmentHeaderText: string;
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
  signatureImagePath: string;
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
  phone: string | null;
  address: string | null;
}

export interface VisitSnapshot {
  visitId: string;
  billNumber: string;
  branchId: string;
  branchName: string;
  branchCode: string;
  referralDoctorName: string | null;
  createdAt: string;
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
        include: {
          // The actual sub-test (HB, RBC, etc.) — this has panelItems
          test: {
            include: {
              panelItems: {
                include: {
                  panel: {
                    include: {
                      department: true,
                    },
                  },
                },
              },
              interpretations: {
                where: { isActive: true },
                orderBy: { displayOrder: 'asc' },
              },
            },
          },
          // The test order — has snapshot metadata (name, code, reference ranges at order time)
          testOrder: true,
        },
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
  // BUILD PANEL SNAPSHOTS (Grouped by Department)
  // ============================================================================
  
  // Group test results by panel
  const panelMap = new Map<string, { panel: any; results: any[] }>();
  
  for (const result of reportVersion.testResults) {
    const testOrder = result.testOrder;
    const test = result.test; // The actual sub-test (HB, RBC, etc.) — has panelItems
    
    // Find which panel this test belongs to via PanelTestItem mapping
    for (const panelItem of test.panelItems) {
      const panel = panelItem.panel;
      const key = panel.id;
      
      if (!panelMap.has(key)) {
        panelMap.set(key, { panel, results: [] });
      }
      
      // Match interpretation based on value
      let interpretationText: string | null = null;
      if (result.value !== null && test.interpretations.length > 0) {
        for (const interp of test.interpretations) {
          const minOk = interp.minValue === null || result.value >= interp.minValue;
          const maxOk = interp.maxValue === null || result.value < interp.maxValue;
          if (minOk && maxOk) {
            interpretationText = interp.interpretationText;
            break;
          }
        }
      }
      
      panelMap.get(key)!.results.push({
        testId: test.id,
        testCode: test.code,   // Sub-test code (HB, RBC, etc.)
        testName: test.name,   // Sub-test name (Haemoglobin, RBC Count, etc.)
        value: result.value,
        flag: result.flag,
        notes: result.notes,
        referenceMin: test.referenceMin,
        referenceMax: test.referenceMax,
        referenceUnit: test.referenceUnit,
        methodText: panelItem.methodText,
        displayOrder: panelItem.displayOrder,
        indentLevel: panelItem.indentLevel,
        subGroup: panelItem.subGroup,
        interpretationText,
      });
    }
  }
  
  // Group panels by department
  const departmentMap = new Map<string, DepartmentSnapshot>();
  
  for (const [panelId, { panel, results }] of panelMap) {
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
    results.sort((a, b) => a.displayOrder - b.displayOrder);
    
    // Build interpretation HTML for INTERPRETATION_SINGLE panels
    let interpretationHtml: string | undefined;
    if (panel.layoutType === 'INTERPRETATION_SINGLE') {
      const interpretations = results
        .filter(r => r.interpretationText)
        .map(r => r.interpretationText);
      if (interpretations.length > 0) {
        interpretationHtml = interpretations.join('\n\n');
      }
    }
    
    departmentMap.get(deptId)!.panels.push({
      panelId: panel.id,
      panelName: panel.name,
      displayName: panel.displayName,
      layoutType: panel.layoutType,
      displayOrder: panel.displayOrder,
      departmentId: deptId,
      departmentName: dept.name,
      departmentHeaderText: dept.reportHeaderText,
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
    phone: patient.identifiers[0]?.value || null,
    address: patient.address,
  };

  // ============================================================================
  // BUILD VISIT SNAPSHOT
  // ============================================================================
  
  const visitSnapshot: VisitSnapshot = {
    visitId: visit.id,
    billNumber: visit.billNumber,
    branchId: visit.branchId,
    branchName: visit.branch.name,
    branchCode: visit.branch.code,
    referralDoctorName: visit.referrals[0]?.referralDoctor.name || null,
    createdAt: visit.createdAt.toISOString(),
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
