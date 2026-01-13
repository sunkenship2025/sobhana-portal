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

// ============================================
// PAYOUT TYPES
// ============================================
export type PayoutDoctorType = 'REFERRAL' | 'CLINIC';
export type PaymentType = 'CASH' | 'ONLINE' | 'CHEQUE';

export interface PayoutLineItem {
  visitId: string;
  billNumber: string;
  patientName: string;
  date: string;
  testOrFee: string;
  amountInPaise: number;
  commissionPercentage?: number;
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
// PATIENT 360 TYPES (Read-Only Aggregation View)
// ============================================

/**
 * Visit timeline item for Patient 360 - represents a single visit row
 * This is the anchor entity in the timeline
 */
export interface VisitTimelineItem {
  visitId: string;
  domain: VisitDomain;
  branchId: string;
  branchName: string;
  branchCode: string;
  billNumber: string;
  visitDate: string; // ISO date
  status: string; // DiagnosticVisitStatus or ClinicVisitStatus
  totalAmountInPaise: number;
  paymentStatus: PaymentStatus;
  paymentType: PaymentType;
  
  // Domain-specific fields
  visitType?: VisitType; // OP/IP for clinic visits only
  
  // Report info (diagnostics only)
  hasReport: boolean;
  reportFinalized: boolean;
  reportFinalizedAt?: string;
  
  // Referral info
  referralDoctorId?: string;
  referralDoctorName?: string;
  
  // Clinic doctor info (clinic visits only)
  clinicDoctorId?: string;
  clinicDoctorName?: string;
}

/**
 * Diagnostic visit detail for the side drawer
 */
export interface DiagnosticVisitDetail {
  visitId: string;
  branchName: string;
  billNumber: string;
  visitDate: string;
  status: DiagnosticVisitStatus;
  totalAmountInPaise: number;
  paymentStatus: PaymentStatus;
  paymentType: PaymentType;
  
  // Referral
  referralDoctor?: {
    id: string;
    name: string;
    phone?: string;
  };
  
  // Tests ordered
  testOrders: {
    id: string;
    testName: string;
    testCode: string;
    priceInPaise: number;
    referenceRange: {
      min: number;
      max: number;
      unit: string;
    };
  }[];
  
  // Results (if report exists)
  results?: {
    testOrderId: string;
    testName: string;
    testCode: string;
    value: number | null;
    flag: 'NORMAL' | 'HIGH' | 'LOW' | null;
    referenceRange: {
      min: number;
      max: number;
      unit: string;
    };
  }[];
  
  // Report info
  report?: {
    id: string;
    currentVersionId: string | null;
    versionNumber: number;
    status: ReportVersionStatus;
    finalizedAt: string | null;
  };
}

/**
 * Clinic visit detail for the side drawer
 */
export interface ClinicVisitDetail {
  visitId: string;
  branchName: string;
  billNumber: string;
  visitDate: string;
  visitType: VisitType;
  status: ClinicVisitStatus;
  consultationFeeInPaise: number;
  paymentStatus: PaymentStatus;
  paymentType: PaymentType;
  hospitalWard?: string;
  
  // Clinic doctor
  clinicDoctor: {
    id: string;
    name: string;
    qualification: string;
    specialty: string;
    registrationNumber: string;
    phone?: string;
  };
  
  // Referral (if any)
  referralDoctor?: {
    id: string;
    name: string;
    phone?: string;
  };
}

/**
 * Financial summary for Patient 360
 */
export interface PatientFinancialSummary {
  totalDiagnosticsBilledInPaise: number;
  totalClinicBilledInPaise: number;
  totalPaidInPaise: number;
  totalPendingInPaise: number;
  visitCount: {
    diagnostics: number;
    clinic: number;
    total: number;
  };
}

/**
 * Complete Patient 360 view - single API response
 * This is the canonical patient view
 */
export interface Patient360View {
  // Patient identity (global, immutable)
  patient: {
    id: string;
    patientNumber: string;
    name: string;
    age: number;
    gender: Gender;
    address?: string;
    primaryPhone?: string;
    identifiers: {
      type: IdentifierType;
      value: string;
      isPrimary: boolean;
    }[];
    createdAt: string;
  };
  
  // Visit timeline (all branches, all domains, newest first)
  visits: VisitTimelineItem[];
  
  // Financial summary (read-only aggregation)
  financialSummary: PatientFinancialSummary;
  
  // Metadata
  lastVisitDate?: string;
  branchesVisited: {
    id: string;
    name: string;
    code: string;
  }[];
}
