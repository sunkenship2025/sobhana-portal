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
export interface Patient {
  id: string;
  patientNumber: string;  // P-00001, P-00002, etc.
  name: string;
  age: number;
  gender: Gender;
  address?: string;
  identifiers: PatientIdentifier[];
  createdAt: Date;
}

// ============================================
// DOCTOR (Referral Doctor - external)
// ============================================
export interface ReferralDoctor {
  id: string;
  doctorNumber: string;      // RD-00001, RD-00002, etc.
  name: string;
  phone: string;
  commissionPercent: number;
  clinicDoctorId?: string;   // Link if also a clinic doctor
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
// LAB TEST (Master catalog)
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
// TEST ORDER (links Visit to ordered tests)
// ============================================
export interface TestOrder {
  id: string;
  visitId: string;
  testId: string;
  testName: string;
  testCode: string;
  priceInPaise: number;
  referenceRange: {
    min: number;
    max: number;
    unit: string;
  };
  referralCommissionPercent?: number; // Optional per-test referral % override
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
  referenceRange: {
    min: number;
    max: number;
    unit: string;
  };
  flag: 'NORMAL' | 'HIGH' | 'LOW' | null;
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
