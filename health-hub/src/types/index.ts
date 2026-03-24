// ============================================
// ENTITY SEPARATION (ERD-COMPLIANT)
// ============================================
// Patient, Visit, Doctor, Referral, TestOrder, TestResult, Report, ReportVersion
// are ALL separate entities and must remain so.

// ============================================
// BRANCH (Physical Sobhana location)
// ============================================
export interface Branch {
  id: string;
  name: string;         // e.g., "Sobhana – Madhapur"
  code: string;         // e.g., "MPR" for bill prefixes
  address?: string;
  phone?: string;
  isActive: boolean;
  createdAt: Date;
}

// ============================================
// ENUMS
// ============================================
export type Gender = 'M' | 'F' | 'O';
export type IdentifierType = 'PHONE' | 'EMAIL' | 'AADHAR' | 'OTHER';

// ============================================
// PATIENT IDENTIFIER (Extensible identity model)
// ============================================
export interface PatientIdentifier {
  id: string;
  patientId: string;
  type: IdentifierType;
  value: string;
  isPrimary: boolean;
  createdAt: Date;
}

// ============================================
// PATIENT (GLOBAL - shared across branches)
// ============================================
export type AgeUnit = 'DAYS' | 'MONTHS' | 'YEARS';

export interface Patient {
  id: string;
  patientNumber: string;  // P-00001, P-00002, etc.
  name: string;
  age: number; // E2-09: Calculated from YOB/DOB, not stored
  yearOfBirth: number; // E2-09: Required - YOB for age calculation
  dateOfBirth?: Date | string | null; // E2-09: Optional - exact DOB if known
  ageUnit?: AgeUnit; // DAYS, MONTHS, YEARS — for smart age display
  ageDisplay?: string; // e.g., "7 Months", "18 Days", "45 Years"
  gender: Gender;
  address?: string;
  identifiers: PatientIdentifier[];
  createdAt: Date;
}

// ============================================
// DOCTOR (Referral Doctor - external)
// ============================================
export type ReferralPayoutType = 'PERCENTAGE' | 'FIXED_AMOUNT';
export type ReferralSourceType = 'SELF' | 'REFERRED_TO' | 'REFERRED_FROM';

export interface ReferralProductRule {
  id: string;
  productId: string;
  commissionType: ReferralPayoutType;
  commissionPercent?: number | null;
  commissionAmountInPaise?: number | null;
  product?: {
    id: string;
    name: string;
    code: string;
  };
}

export interface ReferralDoctor {
  id: string;
  doctorNumber: string;      // RD-00001, RD-00002, etc.
  name: string;
  phone?: string | null;
  commissionType?: ReferralPayoutType;
  commissionPercent: number;
  commissionAmountInPaise?: number | null;
  clinicDoctorId?: string;   // Link if also a clinic doctor
  productRules?: ReferralProductRule[];
}

export interface DiagnosticCenterProductRule {
  id: string;
  productId: string;
  commissionType: ReferralPayoutType;
  commissionPercent?: number | null;
  commissionAmountInPaise?: number | null;
  product?: {
    id: string;
    name: string;
    code: string;
  };
}

export interface DiagnosticCenter {
  id: string;
  centerNumber: string;
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  commissionType?: ReferralPayoutType;
  commissionPercent: number;
  commissionAmountInPaise?: number | null;
  isActive: boolean;
  productRules?: DiagnosticCenterProductRule[];
  _count?: {
    visitReferrals: number;
    payoutLedger: number;
  };
}

// ============================================
// CLINIC DOCTOR (Internal - for clinic visits/prescriptions)
// ============================================
export interface ClinicDoctor {
  id: string;
  doctorNumber: string;         // CD-00001, CD-00002, etc.
  name: string;
  qualification: string;        // e.g., MBBS, MD (Gen Med)
  specialty: string;            // e.g., General Medicine
  registrationNumber: string;
  phone?: string;
  letterheadNote?: string;      // Optional footer/tagline for prescription print
  referralDoctorId?: string;    // Link if also a referral doctor
}

// ============================================
// LAB TEST (Legacy master catalog — deprecated, kept for backward compat)
// ============================================
export interface LabTest {
  id: string;
  name: string;
  code: string;
  priceInPaise: number;
  referenceRange: {
    min: number;
    max: number;
    unit: string;
  };
}

// ============================================
// NEW ARCHITECTURE: TestDefinition → ClinicalPanel → BillableProduct
// ============================================

export type DefinitionStatus = 'DRAFT' | 'ACTIVE' | 'LOCKED' | 'DEPRECATED' | 'ARCHIVED';

export interface TestDefinition {
  id: string;
  rootDefinitionId: string;
  name: string;
  code: string;
  version: number;
  isLatest: boolean;
  status: DefinitionStatus;
  sampleType: string | null;
  method: string | null;
  referenceUnit: string | null;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceText: string | null;
  formulaExpression: string | null;
  dependsOnCodes: string[] | null;
  interpretationMode: string;
  departmentId: string | null;
  displayOrder: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  department?: { id: string; name: string } | null;
  ranges?: TestDefinitionRange[];
  interpretationRules?: InterpretationRule[];
  _count?: { panelItems: number };
}

export interface TestDefinitionRange {
  id?: string;
  testDefinitionId: string;
  minAgeDays: number | null;
  maxAgeDays: number | null;
  gender: Gender | null;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  referenceText: string | null;
}

export interface InterpretationRule {
  id?: string;
  testDefinitionId: string;
  ruleType: string;
  operator: string;
  value1: number | null;
  value2: number | null;
  textMatch: string | null;
  interpretationText: string;
  severity: string | null;
  displayOrder: number;
  isActive: boolean;
}

export interface ClinicalPanelItem {
  id: string;
  panelId: string;
  testDefinitionId: string;
  displayOrder: number;
  subgroup: string | null;
  testDefinition?: TestDefinition;
}

export interface ClinicalPanel {
  id: string;
  name: string;
  code: string;
  layoutType: string;
  departmentId: string | null;
  isActive: boolean;
  summaryInterpretationTemplate: string | null;
  createdAt: string;
  updatedAt: string;
  department?: { id: string; name: string } | null;
  items: ClinicalPanelItem[];
}

export interface BillableProductPanel {
  id: string;
  productId: string;
  panelId: string;
  displayOrder: number;
  panel?: ClinicalPanel;
}

export interface ProductBranchPricing {
  id: string;
  productId: string;
  branchId: string;
  price: number;
  isActive: boolean;
  branch?: { id: string; name: string };
}

export interface BillableProduct {
  id: string;
  name: string;
  code: string;
  productType: string;
  basePrice: number;
  isActive: boolean;
  description: string | null;
  createdAt: string;
  updatedAt: string;
  components: { testDefinitionId: string; testDefinition?: TestDefinition }[];
  branchPricing: ProductBranchPricing[];
  effectivePrice?: number; // Branch-resolved price from API
}

// ============================================
// TEST ORDER (links Visit to ordered tests)
// E3-03: Test metadata is snapshotted at order time
// Supports both legacy testId and new testDefinitionId
// ============================================
export interface TestOrder {
  id: string;
  visitId: string;
  testId?: string | null;             // Legacy LabTest FK (nullable)
  testDefinitionId?: string | null;   // New TestDefinition FK
  productId?: string | null;          // BillableProduct FK for traceability
  panelId?: string | null;            // ClinicalPanel FK for traceability
  testName: string;       // Snapshotted test name at order time
  testCode: string;       // Snapshotted test code at order time
  priceInPaise: number;   // Snapshotted price at order time
  referenceRange: {       // Snapshotted reference range at order time
    min: number;
    max: number;
    unit: string;
  };
  referenceText?: string | null;      // For qualitative tests
  referralCommissionType?: ReferralPayoutType;
  referralCommissionPercent?: number;
  referralCommissionAmountInPaise?: number | null;
  diagnosticCenterCommissionType?: ReferralPayoutType | null;
  diagnosticCenterCommissionPercent?: number | null;
  diagnosticCenterCommissionAmountInPaise?: number | null;
}

// ============================================
// TEST RESULT (immutable after report finalization)
// ============================================
export interface TestResult {
  id: string;
  testOrderId: string;
  reportVersionId: string;
  testName: string;
  testCode: string;
  value: number | null;
  notes?: string | null;              // Text-based values for qualitative tests
  referenceRange: {
    min: number;
    max: number;
    unit: string;
  };
  referenceText?: string | null;
  flag: 'NORMAL' | 'HIGH' | 'LOW' | null;
  interpretationText?: string | null;
  interpretationSeverity?: string | null;
}

// ============================================
// VISIT (The Anchor Entity)
// ============================================
export type VisitDomain = 'DIAGNOSTICS' | 'CLINIC';
export type VisitType = 'OP' | 'IP'; // Only for CLINIC domain
export type PaymentType = 'CASH' | 'ONLINE' | 'CHEQUE';
export type PaymentStatus = 'PAID' | 'PENDING';

// ============================================
// VISIT REFERRAL (Explicit doctor access control)
// ============================================
export interface VisitReferral {
  visitId: string;
  referralDoctorId: string;
}

// Base Visit (BRANCH-SCOPED)
export interface BaseVisit {
  id: string;
  branchId: string;     // Every visit belongs to exactly one branch
  billNumber: string;
  patientId: string;
  domain: VisitDomain;
  totalAmountInPaise: number;
  paymentType: PaymentType;
  paymentStatus: PaymentStatus;
  createdAt: Date;
  updatedAt: Date;
}

// Diagnostic Visit Status (lifecycle only, finalization is on ReportVersion)
export type DiagnosticVisitStatus = 'DRAFT' | 'IN_PROGRESS' | 'COMPLETED';

export interface DiagnosticVisit extends BaseVisit {
  domain: 'DIAGNOSTICS';
  status: DiagnosticVisitStatus;
}

// Clinic Visit Status
export type ClinicVisitStatus = 'WAITING' | 'IN_PROGRESS' | 'COMPLETED';

export interface ClinicVisit extends BaseVisit {
  domain: 'CLINIC';
  visitType: VisitType;
  doctorId: string; // Consulting doctor (internal ClinicDoctor.id)
  hospitalWard?: string;
  consultationFeeInPaise: number;
  isRevisit?: boolean;
  originalVisitId?: string;
  status: ClinicVisitStatus;
}

// ============================================
// REPORT (Logical container - one per visit)
// ============================================
export interface Report {
  id: string;
  visitId: string;
  currentVersionId: string | null; // Points to latest ReportVersion
  createdAt: Date;
}

// ============================================
// REPORT VERSION (Legal artifact - IMMUTABLE after finalization)
// ============================================
export type ReportVersionStatus = 'DRAFT' | 'FINALIZED';

export interface ReportVersion {
  id: string;
  reportId: string;
  versionNumber: number;
  status: ReportVersionStatus;
  finalizedAt: Date | null;
  createdAt: Date;
}

// ============================================
// CONTEXT TYPES (Navigation)
// ============================================
export type AppContext = 'dashboard' | 'diagnostics' | 'clinic' | 'doctor' | 'owner';

// ============================================
// PATIENT VISIT HISTORY (Cross-branch lookup)
// ============================================
export interface PatientVisitHistoryItem {
  visitId: string;
  domain: VisitDomain;
  branchId: string;
  branchName: string;
  billNumber: string;
  visitType?: 'OP' | 'IP'; // Only for clinic
  createdAt: Date;
}

// ============================================
// DENORMALIZED VIEW TYPES (For UI display only)
// ============================================
// These are computed/joined views, NOT stored entities

export interface DiagnosticVisitView {
  visit: DiagnosticVisit;
  patient: Patient;
  testOrders: TestOrder[];
  referral?: VisitReferral;          // Explicit referral link
  referralDoctor?: ReferralDoctor;   // Denormalized for display
  diagnosticCenter?: DiagnosticCenter;
  report?: Report;
  currentReportVersion?: ReportVersion;
  results: TestResult[];
}

export interface ClinicVisitView {
  visit: ClinicVisit;
  patient: Patient;
  referral?: VisitReferral;          // Explicit referral link
  referralDoctor?: ReferralDoctor;   // Denormalized for display
  clinicDoctor?: ClinicDoctor;
}

// ============================================
// PATIENT 360 TYPES (Read-Only Global View)
// ============================================

// Visit timeline item for Patient 360 display
export interface VisitTimelineItem {
  visitId: string;
  domain: VisitDomain;
  billNumber: string;
  branchId: string;
  branchName: string;
  visitType?: VisitType;             // Only for CLINIC domain
  status: string;                     // DiagnosticVisitStatus or ClinicVisitStatus
  doctorName?: string;               // Clinic doctor name (for clinic visits)
  totalAmountInPaise: number;
  paymentType: PaymentType;
  paymentStatus: PaymentStatus;
  createdAt: Date;
  // Diagnostic specific
  reportStatus?: ReportVersionStatus; // DRAFT | FINALIZED (only if report exists)
  reportVersionId?: string;           // For "View Report" link
  finalizedAt?: Date | null;
}

// Complete Patient 360 view (backend-assembled)
export interface Patient360View {
  patient: Patient;
  visitTimeline: VisitTimelineItem[];
  totalVisits: number;
  branches: { id: string; name: string }[]; // Branches with activity
}

// Search result with history snapshot
export interface PatientSearchResult {
  patient: Patient;
  historySnapshot: {
    visitId: string;
    domain: VisitDomain;
    branchName: string;
    visitType?: VisitType;
    createdAt: Date;
  }[];
  totalVisits: number;
}

// ============================================
// PAYOUT TYPES
// ============================================
export type PayoutDoctorType = 'REFERRAL' | 'CLINIC' | 'DIAGNOSTIC_CENTER';
// PaymentType is defined above in VISIT section

export interface PayoutLineItem {
  visitId: string;
  productId?: string | null;
  billNumber: string;
  patientName: string;
  date: string;
  testOrFee: string;
  amountInPaise: number;
  commissionType?: ReferralPayoutType;
  commissionPercentage?: number;
  commissionAmountInPaise?: number;
  commissionLabel?: string;
  derivedCommissionInPaise: number;
}

export interface PayoutSummary {
  id: string;
  doctorType: PayoutDoctorType;
  doctorId: string;
  doctorName: string;
  branchId: string;
  branchName: string;
  periodStartDate: string;
  periodEndDate: string;
  derivedAmountInPaise: number;
  derivedAt: string;
  paidAt: string | null;
  paymentMethod: PaymentType | null;
}

export interface PayoutDetail extends PayoutSummary {
  paymentReferenceId: string | null;
  notes: string | null;
  reviewedAt: string | null;
  lineItems: PayoutLineItem[];
}

// ============================================
// SHARED BILL RECEIPT TYPE (For unified print)
// ============================================

export interface BillReceiptItem {
  id: string;
  name: string;
  price: number;            // Already in rupees (not paise)
  referralType?: ReferralPayoutType;
  referralPercent?: number;
  referralAmountInPaise?: number;
}

export interface BillReceiptData {
  billNumber: string;
  date: string | Date;      // ISO string or Date object
  domain: 'CLINIC' | 'DIAGNOSTICS';
  visitType?: string;       // 'OP' | 'IP' for clinic
  isRevisit?: boolean;
  branchName?: string;
  patient: {
    name: string;
    phone: string;
    age: number;
    ageDisplay?: string; // e.g., "7 Months", "18 Days"
    gender: string;         // 'M' | 'F' | 'O'
  };
  doctor?: {
    name: string;
    qualification?: string;
    specialty?: string;
  };
  referralDoctor?: {
    name: string;
  };
  paymentType: string;
  paymentStatus: string;
  totalAmount: number;      // Already in rupees
  items: BillReceiptItem[];
}
