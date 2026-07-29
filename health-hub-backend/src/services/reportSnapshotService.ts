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
  commentsHtml?: string;
  /** Per-narrative signer override the radiologist typed below the framed
   *  editor. When non-empty the renderer prints just this name above the
   *  department designation for this panel's page, regardless of any
   *  configured SigningRule. */
  signerNameOverride?: string | null;
  /** Per-report choice (narrative/text) of whether to sign with the
   *  department's configured SigningRule. true = use the rule; false = typed
   *  name + consultant designation. undefined/null on legacy snapshots, where
   *  the renderer preserves the old "rule always wins" behavior. */
  useSigningRule?: boolean | null;
  /** Pinned signing doctor (SigningDoctor.id) for a department that has several
   *  SigningRules (radiology). When set, the renderer keeps only this doctor's
   *  configured signature for the page instead of stamping every rule.
   *  undefined/null = render all the department's rules (single-rule departments
   *  and legacy snapshots). */
  selectedSigningDoctorId?: string | null;
}

export interface DepartmentSnapshot {
  departmentId: string;
  departmentName: string;
  departmentHeaderText: string;
  displayOrder: number;
  showLabIncharge: boolean;
  /** Lab incharge resolved for THIS department (branch+department rule, most
   *  specific wins). `undefined` on snapshots frozen before per-department
   *  incharges existed — the renderer falls back to the top-level labIncharge. */
  labIncharge?: LabInchargeSnapshot | null;
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
  /** When true, the signature image also renders on physical (letterhead)
   *  prints; when false, physical prints show a blank line for a wet signature.
   *  Absent on snapshots frozen before this field existed — treat as false. */
  showSignatureOnPrint: boolean;
  /** When true, the incharge's name + designation render under the signature on
   *  BOTH digital and physical reports (like a doctor block); when false, only
   *  the "Lab Incharge" label shows. Taken live on render (not frozen). */
  showNameOnPrint: boolean;
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

    // Infants entered in MONTHS: past a year, show "Y Year Z Months" instead of
    // collapsing to a bare "1 Year" (16 months → "1 Year 4 Months"). Matches
    // getPatientAgeDisplay so bill and report agree.
    if (ageUnit === 'MONTHS') {
      let totalMonths =
        (now.getFullYear() - dob.getFullYear()) * 12 +
        (now.getMonth() - dob.getMonth());
      if (now.getDate() < dob.getDate()) totalMonths -= 1;
      totalMonths = Math.max(0, totalMonths);
      if (totalMonths < 12) {
        return `${totalMonths} Month${totalMonths !== 1 ? 's' : ''}`;
      }
      const years = Math.floor(totalMonths / 12);
      const months = totalMonths % 12;
      const yearPart = `${years} Year${years !== 1 ? 's' : ''}`;
      return months > 0
        ? `${yearPart} ${months} Month${months !== 1 ? 's' : ''}`
        : yearPart;
    }

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
  branchAddress: string | null;
  branchPhone: string | null;
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

function labInchargeToSnapshot(li: {
  id: string;
  name: string;
  designation: string;
  signatureImagePath: string | null;
  signatureImageBase64: string | null;
  showSignatureOnPrint: boolean;
  showNameOnPrint: boolean;
}): LabInchargeSnapshot {
  return {
    signerId: li.id,
    signerName: li.name,
    designation: li.designation,
    signatureImagePath: li.signatureImagePath,
    signatureImageBase64: li.signatureImageBase64 || null,
    showSignatureOnPrint: li.showSignatureOnPrint,
    showNameOnPrint: li.showNameOnPrint,
  };
}

/**
 * Resolve the lab incharge for each department of a report, plus a global
 * fallback for department-less pages. Every department is matched most-specific
 * first against the active LabInchargeRules:
 *   (branch, dept) → (branch, All Depts) → (All Branches, dept) → (All, All).
 * One incharge may own many rules; a (branch, dept) slot has at most one.
 */
async function resolveLabInchargesForReport(
  branchId: string,
  departmentIds: string[],
): Promise<{ byDepartment: Map<string, LabInchargeSnapshot>; fallback: LabInchargeSnapshot | null }> {
  // One query for every rule that could apply to this branch — this branch's own
  // rules plus the All-Branches (null) rules. Resolution is done in memory.
  const rules = await prisma.labInchargeRule.findMany({
    where: {
      isActive: true,
      OR: [{ branchId }, { branchId: null }],
    },
    include: { signingLabIncharge: true, departments: true },
    orderBy: { displayOrder: 'asc' },
  });

  // A rule with no department rows covers All Departments; otherwise it covers
  // exactly its listed departments. `deptId === null` asks for the All-Departments
  // (catch-all) rule at a branch scope.
  const pick = (thisBranch: boolean, deptId: string | null) =>
    rules.find((r) => {
      if ((thisBranch ? r.branchId === branchId : r.branchId === null) === false) return false;
      const coversAll = r.departments.length === 0;
      return deptId === null
        ? coversAll
        : !coversAll && r.departments.some((d) => d.departmentId === deptId);
    });

  const resolveForDept = (deptId: string): LabInchargeSnapshot | null => {
    const rule =
      pick(true, deptId) || // (branch, dept)
      pick(true, null) || // (branch, All Departments)
      pick(false, deptId) || // (All Branches, dept)
      pick(false, null); // (All Branches, All Departments)
    return rule?.signingLabIncharge ? labInchargeToSnapshot(rule.signingLabIncharge) : null;
  };

  const byDepartment = new Map<string, LabInchargeSnapshot>();
  for (const deptId of [...new Set(departmentIds.filter(Boolean))]) {
    const snap = resolveForDept(deptId);
    if (snap) byDepartment.set(deptId, snap);
  }

  // Department-less pages (empty-results fallback) use the branch-wide default.
  const fallbackRule = pick(true, null) || pick(false, null);
  const fallback = fallbackRule?.signingLabIncharge
    ? labInchargeToSnapshot(fallbackRule.signingLabIncharge)
    : null;

  return { byDepartment, fallback };
}

/**
 * Set each department's Lab Incharge visibility from its signing rule(s). The
 * "Show lab incharge" checkbox on the SigningRule (showLabInchargeNote, default
 * on) is the single source of truth — a department with no signing rule, or one
 * whose rule is unchecked, hides the block. Multi-rule departments (radiology)
 * show it if ANY active rule opts in. Frozen into the snapshot at creation like
 * the rest of the department data, so finalized reports stay immutable.
 */
function applyLabInchargeVisibility(
  departments: DepartmentSnapshot[],
  signatures: SignatureSnapshot[],
): void {
  const showByDept = new Map<string, boolean>();
  for (const sig of signatures) {
    if (!sig.departmentId || !sig.doctorId) continue; // ignore no-rule placeholders
    showByDept.set(
      sig.departmentId,
      (showByDept.get(sig.departmentId) ?? false) || sig.showLabInchargeNote === true,
    );
  }
  for (const dept of departments) {
    dept.showLabIncharge = showByDept.get(dept.departmentId) ?? false;
  }
}

/**
 * Refresh frozen lab incharge snapshots (top-level + per-department) from the
 * live SigningLabIncharge in a single query. Identity + signature image stay
 * FROZEN (medico-legal: the report shows who actually signed it); only the
 * showSignatureOnPrint / showNameOnPrint display flags are taken live, mirroring
 * the pre-feature behavior.
 * Returns the merged top-level; mutates each department's labIncharge in place.
 */
async function rehydrateStoredLabIncharges(
  topLevel: LabInchargeSnapshot | null,
  departments: DepartmentSnapshot[],
): Promise<LabInchargeSnapshot | null> {
  const frozen: LabInchargeSnapshot[] = [];
  if (topLevel?.signerId) frozen.push(topLevel);
  for (const dept of departments) {
    if (dept.labIncharge?.signerId) frozen.push(dept.labIncharge);
  }
  const ids = [...new Set(frozen.map((f) => f.signerId))];
  if (ids.length === 0) return topLevel;

  const current = await prisma.signingLabIncharge.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      designation: true,
      signatureImagePath: true,
      signatureImageBase64: true,
      showSignatureOnPrint: true,
      showNameOnPrint: true,
    },
  });
  const map = new Map(current.map((c) => [c.id, c]));

  const merge = (f: LabInchargeSnapshot | null): LabInchargeSnapshot | null => {
    if (!f?.signerId) return f ?? null;
    const c = map.get(f.signerId);
    if (!c) return f; // signer deleted — keep the frozen snapshot
    return {
      signerId: f.signerId,
      signerName: f.signerName || c.name,
      designation: f.designation || c.designation,
      signatureImagePath: f.signatureImagePath || c.signatureImagePath,
      signatureImageBase64: f.signatureImageBase64 || c.signatureImageBase64 || null,
      showSignatureOnPrint: c.showSignatureOnPrint, // LIVE
      showNameOnPrint: c.showNameOnPrint, // LIVE
    };
  };

  for (const dept of departments) {
    if (dept.labIncharge !== undefined) dept.labIncharge = merge(dept.labIncharge);
  }
  return merge(topLevel);
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

function filterReportableOrders<
  T extends {
    workflowMode?: DiagnosticWorkflowMode | null;
    cancelledAt?: Date | string | null;
    noReportAt?: Date | string | null;
  },
>(orders: T[]): T[] {
  return orders.filter(
    (order) =>
      !order.cancelledAt &&
      !order.noReportAt &&
      (order.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE) === DiagnosticWorkflowMode.REPORTABLE
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
    cancelledAt?: Date | string | null;
    noReportAt?: Date | string | null;
  }>
): Promise<ExternalUploadSnapshot[]> {
  const uploadOrders = testOrders.filter(
    (order) =>
      order.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD &&
      // A cancelled order, or one closed as "no report needed" (films only,
      // patient declined the report), must not bake its PDF into the snapshot —
      // even if a file was uploaded before it was waived.
      !order.cancelledAt &&
      !order.noReportAt
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

/**
 * Panel membership is looked up by exact testDefinitionId, but TestDefinitions
 * are versioned: re-saving a ClinicalPanel re-points its ClinicalPanelItems at
 * the LATEST definition versions, which orphans in-flight TestOrders/TestResults
 * that still reference an older version (their testDefinition.panelItems comes
 * back empty and the result falls into the "General" orphan panel). Backfill
 * empty panelItems from any sibling version of the same rootDefinitionId so
 * historical orders keep rendering inside their panel.
 */
async function backfillPanelItemsByRoot(testResults: any[]): Promise<void> {
  const orphanDefsByRoot = new Map<string, any[]>();
  for (const result of testResults) {
    const testDef = result.testDefinition;
    if (
      testDef?.rootDefinitionId &&
      (!testDef.panelItems || testDef.panelItems.length === 0)
    ) {
      const list = orphanDefsByRoot.get(testDef.rootDefinitionId) || [];
      list.push(testDef);
      orphanDefsByRoot.set(testDef.rootDefinitionId, list);
    }
  }
  if (orphanDefsByRoot.size === 0) return;

  const siblingItems = await prisma.clinicalPanelItem.findMany({
    where: {
      testDefinition: {
        rootDefinitionId: { in: [...orphanDefsByRoot.keys()] },
      },
    },
    orderBy: [{ displayOrder: 'asc' }, { createdAt: 'asc' }],
    include: {
      panel: { include: { department: true } },
      testDefinition: { select: { rootDefinitionId: true } },
    },
  });

  const itemsByRoot = new Map<string, any[]>();
  for (const item of siblingItems) {
    const root = item.testDefinition.rootDefinitionId;
    const list = itemsByRoot.get(root) || [];
    list.push(item);
    itemsByRoot.set(root, list);
  }

  for (const [root, defs] of orphanDefsByRoot) {
    const items = itemsByRoot.get(root);
    if (!items || items.length === 0) continue;
    for (const def of defs) {
      def.panelItems = items;
    }
  }
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
    { panel: any; results: any[]; signerNameOverride: string | null; useSigningRule: boolean | null; selectedSigningDoctorId: string | null }
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

    const resultUseSigningRule =
      typeof (result as any).useSigningRule === 'boolean'
        ? ((result as any).useSigningRule as boolean)
        : null;

    const resultSelectedSigningDoctorId =
      typeof (result as any).selectedSigningDoctorId === 'string' &&
      (result as any).selectedSigningDoctorId.trim()
        ? ((result as any).selectedSigningDoctorId as string).trim()
        : null;

    if (useNewChain) {
      // ━━ NEW ARCHITECTURE: ClinicalPanelItem → ClinicalPanel ━━
      const chosenItems = pickRenderPanelItems(testDef.panelItems);
      for (const panelItem of chosenItems) {
        const panel = panelItem.panel;
        const key = panel.id;

        if (!panelMap.has(key)) {
          panelMap.set(key, { panel, results: [], signerNameOverride: null, useSigningRule: null, selectedSigningDoctorId: null });
        }
        if (resultSignerOverride && !panelMap.get(key)!.signerNameOverride) {
          panelMap.get(key)!.signerNameOverride = resultSignerOverride;
        }
        if (resultUseSigningRule !== null && panelMap.get(key)!.useSigningRule === null) {
          panelMap.get(key)!.useSigningRule = resultUseSigningRule;
        }
        if (resultSelectedSigningDoctorId !== null && panelMap.get(key)!.selectedSigningDoctorId === null) {
          panelMap.get(key)!.selectedSigningDoctorId = resultSelectedSigningDoctorId;
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
          testName: panelItem.displayLabel ?? (testDef.name || test.name),
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
          panelMap.set(key, { panel, results: [], signerNameOverride: null, useSigningRule: null, selectedSigningDoctorId: null });
        }
        if (resultSignerOverride && !panelMap.get(key)!.signerNameOverride) {
          panelMap.get(key)!.signerNameOverride = resultSignerOverride;
        }
        if (resultUseSigningRule !== null && panelMap.get(key)!.useSigningRule === null) {
          panelMap.get(key)!.useSigningRule = resultUseSigningRule;
        }
        if (resultSelectedSigningDoctorId !== null && panelMap.get(key)!.selectedSigningDoctorId === null) {
          panelMap.get(key)!.selectedSigningDoctorId = resultSelectedSigningDoctorId;
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
          useSigningRule: null,
          selectedSigningDoctorId: null,
        });
      }
      if (resultSignerOverride && !panelMap.get(orphanPanelKey)!.signerNameOverride) {
        panelMap.get(orphanPanelKey)!.signerNameOverride = resultSignerOverride;
      }
      if (resultUseSigningRule !== null && panelMap.get(orphanPanelKey)!.useSigningRule === null) {
        panelMap.get(orphanPanelKey)!.useSigningRule = resultUseSigningRule;
      }
      if (resultSelectedSigningDoctorId !== null && panelMap.get(orphanPanelKey)!.selectedSigningDoctorId === null) {
        panelMap.get(orphanPanelKey)!.selectedSigningDoctorId = resultSelectedSigningDoctorId;
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

  for (const [_panelId, { panel, results, signerNameOverride, useSigningRule, selectedSigningDoctorId }] of panelMap) {
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

    // Build COMMENTS + INTERPRETATION HTML (rich text). Gated by the "Show
    // Comments" toggle (persisted as showInterpretation). Panels edited before
    // the comments/interpretation split fall back to the legacy
    // summaryInterpretationTemplate for their comments text.
    let commentsHtml: string | undefined;
    let interpretationHtml: string | undefined;
    const showBoxes = panel.showInterpretation === true
      || panel.layoutType === 'INTERPRETATION_SINGLE'; // legacy compat
    if (showBoxes) {
      const meaningful = (s?: string | null) =>
        s && s.replace(/<[^>]*>/g, '').replace(/&nbsp;/gi, ' ').trim() ? s : undefined;
      commentsHtml = meaningful(panel.comments) ?? meaningful(panel.summaryInterpretationTemplate);
      interpretationHtml = meaningful(panel.interpretation);
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
      commentsHtml,
      signerNameOverride,
      useSigningRule,
      selectedSigningDoctorId,
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
                where: { deletedAt: null },
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
  // Results entered against since-cancelled orders — or orders closed as "no
  // written report needed" (films only) — must not render.
  const activeTestResults = (filteredTestResults as any[]).filter(
    (r: any) =>
      !r.testOrder?.cancelledAt &&
      !r.testOrder?.noReportAt &&
      // "Upload instead": a switched order (workflowMode flipped to
      // EXTERNAL_UPLOAD) keeps its pre-switch typed draft rows so a toggle-back
      // restores them — but those rows must NEVER bake into the rendered
      // panelsSnapshot; the uploaded PDF is the report. The orderedPanelIds gate
      // only filters these out on MULTI-order visits (a lone switched order
      // contributes no reportable panel id), so this is the real guard.
      r.testOrder?.workflowMode !== DiagnosticWorkflowMode.EXTERNAL_UPLOAD,
  );
  const augmentedTestResults = dedupeResultsForSnapshot(await backfillDerivedResults(
    activeTestResults,
    reportableOrders as any[],
    reportVersion.id
  ));
  await backfillPanelItemsByRoot(augmentedTestResults);

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
  applyLabInchargeVisibility(departments, signatures);
  const { byDepartment: labInchargeByDept, fallback: labIncharge } =
    await resolveLabInchargesForReport(
      visit.branchId,
      departments.map((department) => department.departmentId),
    );
  for (const department of departments) {
    department.labIncharge = labInchargeByDept.get(department.departmentId) ?? null;
  }

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
    branchAddress: visit.branch.address,
    branchPhone: visit.branch.phone,
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
        where: { deletedAt: null },
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

  // Results entered against since-cancelled orders — or orders closed as "no
  // written report needed" (films only) — must not render.
  const activeTestResults = (filteredTestResults as any[]).filter(
    (r: any) =>
      !r.testOrder?.cancelledAt &&
      !r.testOrder?.noReportAt &&
      // "Upload instead": a switched order (workflowMode flipped to
      // EXTERNAL_UPLOAD) keeps its pre-switch typed draft rows so a toggle-back
      // restores them — but those rows must NEVER bake into the rendered
      // panelsSnapshot; the uploaded PDF is the report. The orderedPanelIds gate
      // only filters these out on MULTI-order visits (a lone switched order
      // contributes no reportable panel id), so this is the real guard.
      r.testOrder?.workflowMode !== DiagnosticWorkflowMode.EXTERNAL_UPLOAD,
  );

  // External-upload visits have no test results — the report content is the
  // appended PDFs themselves. Only block when there's neither values nor uploads.
  if (activeTestResults.length === 0 && externalUploads.length === 0) {
    throw new Error('No test results entered yet');
  }
  const augmentedTestResults = dedupeResultsForSnapshot(await backfillDerivedResults(
    activeTestResults,
    reportableOrders as any[],
    reportVersion.id
  ));
  await backfillPanelItemsByRoot(augmentedTestResults);

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
  applyLabInchargeVisibility(departments, signatures);
  const { byDepartment: labInchargeByDept, fallback: labIncharge } =
    await resolveLabInchargesForReport(
      visit.branchId,
      departments.map((department) => department.departmentId),
    );
  for (const department of departments) {
    department.labIncharge = labInchargeByDept.get(department.departmentId) ?? null;
  }

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
    branchAddress: visit.branch.address,
    branchPhone: visit.branch.phone,
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

// ============================================================================
// DRAFT PREVIEW (Report Builder) — render an UNSAVED panel through the EXACT
// same pipeline the finalized report uses, seeded with a mock patient + values.
// buildEphemeralSnapshot can't be reused (it reads the visit from the DB and
// throws for unsaved drafts), so we assemble the ReportSnapshot literal here
// and feed it into the shared buildPanelsAndDepartments + real signature
// resolution. renderReportHtml(snapshot, {profile}) then produces byte-identical
// HTML to production — screen for digital, pdf-physical for letterhead.
// ============================================================================

export interface DraftPanelPreviewInput {
  branch: { id: string; name: string; code: string; address: string | null; phone: string | null };
  department: { id: string; name: string; reportHeaderText: string; displayOrder?: number; showLabIncharge?: boolean };
  panel: {
    code: string;      // ClinicalPanel.name (unique code)
    label: string;     // ClinicalPanel.displayName (human label)
    layoutType: string;
    sampleType?: string | null;
    panelMethodText?: string | null;
    panelMethodItalic?: boolean;
    showSubgroups?: boolean;
    showInterpretation?: boolean;
    subgroupMethods?: Record<string, string> | null;
    subgroupTableOverrides?: Record<string, boolean> | null;
    valueDisplayPrefix?: string | null;
    spacedDefinitionsGap?: number;
    comments?: string | null;
    interpretation?: string | null;
    summaryInterpretationTemplate?: string | null;
  };
  items: Array<{
    testDefinition: {
      code: string;
      name: string;
      method?: string | null;
      sampleType?: string | null;
      referenceMin?: number | null;
      referenceMax?: number | null;
      referenceUnit?: string | null;
      referenceText?: string | null;
      criticalMin?: number | null;
      criticalMax?: number | null;
      interpretationRules?: any[];
    };
    displayOrder?: number;
    showMethod?: boolean;
    methodText?: string | null;
    indentLevel?: number;
    isBold?: boolean;
    isItalic?: boolean;
    subGroup?: string | null;
    joinPrevious?: boolean;
    gridWidth?: number | null;
    displayLabel?: string | null;
    mockValue?: number | null;
    mockTextValue?: string | null;
  }>;
  patient?: {
    name?: string;
    title?: string | null;
    gender?: string;
    yearOfBirth?: number;
    dateOfBirth?: string | null;
    ageUnit?: string | null;
    patientNumber?: string;
    phone?: string | null;
    address?: string | null;
  };
  billNumber?: string;
}

export async function buildDraftPanelSnapshot(input: DraftPanelPreviewInput): Promise<ReportSnapshot> {
  const dept = {
    id: input.department.id,
    name: input.department.name,
    reportHeaderText: input.department.reportHeaderText || input.department.name,
    displayOrder: input.department.displayOrder ?? 0,
    showLabIncharge: input.department.showLabIncharge ?? true,
  };

  // ONE synthetic ClinicalPanel shared by every item (mirrors panelItem.panel).
  const SP: any = {
    id: 'draft-panel',
    name: input.panel.code,                          // → snapshot.panelName
    displayName: input.panel.label || input.panel.code, // → snapshot.displayName (panel title)
    layoutType: input.panel.layoutType,
    panelMethodText: input.panel.panelMethodText ?? null,
    panelMethodItalic: input.panel.panelMethodItalic ?? false,
    sampleType: input.panel.sampleType ?? null,
    displayOrder: 0,
    showSubgroups: input.panel.showSubgroups ?? false,
    showInterpretation: input.panel.showInterpretation ?? false,
    subgroupMethods: input.panel.subgroupMethods ?? null,
    subgroupTableOverrides: input.panel.subgroupTableOverrides ?? null,
    valueDisplayPrefix: input.panel.valueDisplayPrefix ?? null,
    spacedDefinitionsGap: input.panel.spacedDefinitionsGap ?? 0,
    comments: input.panel.comments ?? null,
    interpretation: input.panel.interpretation ?? null,
    summaryInterpretationTemplate: input.panel.summaryInterpretationTemplate ?? null,
    department: dept,
  };

  // Build synthetic results in the exact shape buildPanelsAndDepartments expects
  // (new-chain: result.testDefinition.panelItems[].panel populated).
  const results = input.items.map((item, idx) => {
    const td = item.testDefinition;
    const value = typeof item.mockValue === 'number' ? item.mockValue : null;
    const flag =
      value !== null
        ? determineResultFlag(value, {
            referenceMin: td.referenceMin ?? null,
            referenceMax: td.referenceMax ?? null,
            criticalMin: td.criticalMin ?? null,
            criticalMax: td.criticalMax ?? null,
          })
        : null;

    const panelItem: any = {
      panel: SP,
      displayOrder: item.displayOrder ?? idx,
      showMethod: item.showMethod ?? false,
      methodText: item.methodText ?? null,
      indentLevel: item.indentLevel ?? 0,
      isBold: item.isBold ?? false,
      isItalic: item.isItalic ?? false,
      subGroup: item.subGroup ?? null,
      joinPrevious: item.joinPrevious ?? false,
      gridWidth: item.gridWidth ?? null,
      displayLabel: item.displayLabel ?? null,
    };

    const testDefinition: any = {
      id: `draft-def-${idx}`,
      code: td.code,
      name: td.name,
      method: td.method ?? null,
      sampleType: td.sampleType ?? null,
      referenceMin: td.referenceMin ?? null,
      referenceMax: td.referenceMax ?? null,
      referenceUnit: td.referenceUnit ?? null,
      referenceText: td.referenceText ?? null,
      criticalMin: td.criticalMin ?? null,
      criticalMax: td.criticalMax ?? null,
      interpretationRules: td.interpretationRules ?? [],
      panelItems: [panelItem],
    };

    const test: any = {
      id: `draft-test-${idx}`,
      code: td.code,
      referenceMin: td.referenceMin ?? null,
      referenceMax: td.referenceMax ?? null,
      referenceUnit: td.referenceUnit ?? null,
      referenceText: td.referenceText ?? null,
      sampleType: td.sampleType ?? null,
      displayOrder: item.displayOrder ?? idx,
      panelItems: [],
    };

    return {
      testOrderId: undefined,
      testDefinitionId: testDefinition.id,
      test,
      testDefinition,
      value,
      textValue: item.mockTextValue ?? null,
      flag,
      notes: null,
    };
  });

  const departments = buildPanelsAndDepartments(results as any[], new Map(), undefined);

  // Resolve REAL signatures + lab incharge for the department so the preview's
  // signature block is exactly what a finalized report would show.
  const deptIds = departments.map((d) => d.departmentId);
  const signatures = await getLiveSignatureSnapshotsForDepartments(deptIds);
  applyLabInchargeVisibility(departments, signatures);
  const { byDepartment: labInchargeByDept, fallback: labIncharge } =
    await resolveLabInchargesForReport(input.branch.id, deptIds);
  for (const department of departments) {
    department.labIncharge = labInchargeByDept.get(department.departmentId) ?? null;
  }

  const p = input.patient || {};
  const currentYear = new Date().getFullYear();
  const yearOfBirth = p.yearOfBirth ?? currentYear - 35;
  const patient: PatientSnapshot = {
    patientId: 'draft-patient',
    patientNumber: p.patientNumber ?? 'PREVIEW-001',
    name: p.name ?? 'Sample Patient',
    title: p.title ?? null,
    gender: p.gender ?? 'F',
    yearOfBirth,
    dateOfBirth: p.dateOfBirth ?? null,
    age: currentYear - yearOfBirth,
    ageDisplay: computeAgeDisplay(yearOfBirth, p.dateOfBirth ?? null, p.ageUnit ?? null),
    phone: p.phone ?? null,
    address: p.address ?? null,
  };

  const nowIso = new Date().toISOString();
  const visit: VisitSnapshot = {
    visitId: 'draft-visit',
    billNumber: input.billNumber ?? 'PREVIEW',
    branchId: input.branch.id,
    branchName: input.branch.name,
    branchCode: input.branch.code,
    branchAddress: input.branch.address,
    branchPhone: input.branch.phone,
    referralDoctorName: null,
    createdAt: nowIso,
    collectedAt: nowIso,
    finalizedAt: nowIso,
  };

  return {
    snapshotVersion: 1,
    reportVersionId: 'draft-preview',
    versionNum: 1,
    departments,
    signatures,
    labIncharge,
    patient,
    visit,
    externalUploads: [],
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

  // Re-hydrate frozen lab incharge snapshots — the per-department signers (new
  // snapshots) and the top-level fallback (all snapshots). Identity + signature
  // image stay frozen for immutability; only showSignatureOnPrint is taken live
  // so toggling it governs past and future physical prints. Mutates each
  // department's labIncharge in place.
  const labIncharge = await rehydrateStoredLabIncharges(
    (reportVersion.labInchargeSnapshot as unknown as LabInchargeSnapshot | null) ?? null,
    departments,
  );

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
