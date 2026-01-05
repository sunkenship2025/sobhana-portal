import { create } from 'zustand';
import type { 
  Patient, 
  DiagnosticVisit, 
  ClinicVisit, 
  LabTest, 
  AppContext, 
  ReferralDoctor,
  ClinicDoctor,
  TestOrder,
  TestResult,
  Report,
  ReportVersion,
  DiagnosticVisitView,
  ClinicVisitView,
  PatientVisitHistoryItem,
} from '@/types';
import { useBranchStore } from './branchStore';

// ============================================
// SAMPLE DATA - Referral Doctors
// ============================================
const SAMPLE_REFERRAL_DOCTORS: ReferralDoctor[] = [
  { id: '1', name: 'Dr. Sharma', phone: '9876543211', commissionPercent: 10 },
  { id: '2', name: 'Dr. Rao', phone: '9876543212', commissionPercent: 15 },
  { id: '3', name: 'Dr. Patel', phone: '9876543213', commissionPercent: 12 },
];

// ============================================
// SAMPLE DATA - Clinic Doctors (internal)
// ============================================
const SAMPLE_CLINIC_DOCTORS: ClinicDoctor[] = [
  {
    id: 'cd-1',
    name: 'Dr. Meera Sharma',
    qualification: 'MBBS, MD (Gen Med)',
    specialty: 'General Medicine',
    registrationNumber: 'TSMC/GM/2020/1234',
    phone: '9876500001',
    letterheadNote: 'Compassionate primary care and preventive health',
  },
  {
    id: 'cd-2',
    name: 'Dr. Arjun Rao',
    qualification: 'MBBS, MS (Ortho)',
    specialty: 'Orthopedics',
    registrationNumber: 'TSMC/ORT/2018/0456',
    phone: '9876500002',
    letterheadNote: 'Bone & joint clinic | Ortho rehab',
  },
];

// ============================================
// SAMPLE DATA - Lab Tests (Master Catalog)
// ============================================
const SAMPLE_LAB_TESTS: LabTest[] = [
  { id: '1', name: 'Complete Blood Count (CBC)', code: 'CBC', price: 350, referenceRange: { min: 0, max: 0, unit: '' } },
  { id: '2', name: 'Thyroid Stimulating Hormone (TSH)', code: 'TSH', price: 450, referenceRange: { min: 0.4, max: 4.0, unit: 'mIU/L' } },
  { id: '3', name: 'Lipid Profile', code: 'LIPID', price: 550, referenceRange: { min: 0, max: 200, unit: 'mg/dL' } },
  { id: '4', name: 'Liver Function Test (LFT)', code: 'LFT', price: 650, referenceRange: { min: 0, max: 0, unit: '' } },
  { id: '5', name: 'Kidney Function Test (KFT)', code: 'KFT', price: 600, referenceRange: { min: 0, max: 0, unit: '' } },
  { id: '6', name: 'Hemoglobin (Hb)', code: 'HB', price: 150, referenceRange: { min: 12, max: 16, unit: 'g/dL' } },
  { id: '7', name: 'Blood Sugar Fasting', code: 'BSF', price: 100, referenceRange: { min: 70, max: 100, unit: 'mg/dL' } },
  { id: '8', name: 'HbA1c', code: 'HBA1C', price: 550, referenceRange: { min: 4, max: 5.6, unit: '%' } },
];

// ============================================
// SAMPLE DATA - Patients
// ============================================
const SAMPLE_PATIENTS: Patient[] = [
  { id: '1', name: 'John Doe', phone: '9876543210', age: 45, gender: 'M', createdAt: new Date() },
  { id: '2', name: 'Jane Doe', phone: '9876543210', age: 42, gender: 'F', createdAt: new Date() },
  { id: '3', name: 'Rahul Kumar', phone: '9123456789', age: 35, gender: 'M', createdAt: new Date() },
];

// ============================================
// SAMPLE DATA - Diagnostic Visits (with branchId)
// ============================================
const SAMPLE_DIAGNOSTIC_VISITS: DiagnosticVisit[] = [
  {
    id: '1',
    branchId: 'branch-1',
    billNumber: 'D-MPR-10231',
    patientId: '1',
    domain: 'DIAGNOSTICS',
    totalAmount: 600,
    paymentType: 'CASH',
    paymentStatus: 'PAID',
    status: 'DRAFT',
    referralDoctorId: '1',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '2',
    branchId: 'branch-1',
    billNumber: 'D-MPR-10232',
    patientId: '2',
    domain: 'DIAGNOSTICS',
    totalAmount: 550,
    paymentType: 'ONLINE',
    paymentStatus: 'PAID',
    status: 'RESULTS_PENDING',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '3',
    branchId: 'branch-2',
    billNumber: 'D-KPY-10233',
    patientId: '3',
    domain: 'DIAGNOSTICS',
    totalAmount: 450,
    paymentType: 'CASH',
    paymentStatus: 'PENDING',
    status: 'RESULTS_PENDING',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// ============================================
// SAMPLE DATA - Test Orders (linked to visits)
// ============================================
const SAMPLE_TEST_ORDERS: TestOrder[] = [
  // Visit 1 tests
  { id: 'to1', visitId: '1', testId: '2', testName: 'Thyroid Stimulating Hormone (TSH)', testCode: 'TSH', price: 450, referenceRange: { min: 0.4, max: 4.0, unit: 'mIU/L' } },
  { id: 'to2', visitId: '1', testId: '6', testName: 'Hemoglobin (Hb)', testCode: 'HB', price: 150, referenceRange: { min: 12, max: 16, unit: 'g/dL' } },
  // Visit 2 tests
  { id: 'to3', visitId: '2', testId: '3', testName: 'Lipid Profile', testCode: 'LIPID', price: 550, referenceRange: { min: 0, max: 200, unit: 'mg/dL' } },
  // Visit 3 tests
  { id: 'to4', visitId: '3', testId: '1', testName: 'Complete Blood Count (CBC)', testCode: 'CBC', price: 350, referenceRange: { min: 0, max: 0, unit: '' } },
  { id: 'to5', visitId: '3', testId: '7', testName: 'Blood Sugar Fasting', testCode: 'BSF', price: 100, referenceRange: { min: 70, max: 100, unit: 'mg/dL' } },
];

// ============================================
// SAMPLE DATA - Reports
// ============================================
const SAMPLE_REPORTS: Report[] = [
  { id: 'r1', visitId: '1', currentVersionId: 'rv1', createdAt: new Date() },
];

// ============================================
// SAMPLE DATA - Report Versions
// ============================================
const SAMPLE_REPORT_VERSIONS: ReportVersion[] = [
  { id: 'rv1', reportId: 'r1', versionNumber: 1, status: 'DRAFT', finalizedAt: null, createdAt: new Date() },
];

// ============================================
// SAMPLE DATA - Test Results (linked to report versions)
// ============================================
const SAMPLE_TEST_RESULTS: TestResult[] = [
  { id: 'tr1', testOrderId: 'to1', reportVersionId: 'rv1', testName: 'Thyroid Stimulating Hormone (TSH)', testCode: 'TSH', value: 8.4, referenceRange: { min: 0.4, max: 4.0, unit: 'mIU/L' }, flag: 'HIGH' },
  { id: 'tr2', testOrderId: 'to2', reportVersionId: 'rv1', testName: 'Hemoglobin (Hb)', testCode: 'HB', value: 13.2, referenceRange: { min: 12, max: 16, unit: 'g/dL' }, flag: 'NORMAL' },
];

// ============================================
// SAMPLE DATA - Clinic Visits (with branchId)
// ============================================
const SAMPLE_CLINIC_VISITS: ClinicVisit[] = [
  {
    id: '1',
    branchId: 'branch-1',
    billNumber: 'C-MPR-20341',
    patientId: '1',
    domain: 'CLINIC',
    visitType: 'OP',
    doctorId: 'cd-1',
    totalAmount: 500,
    consultationFee: 500,
    paymentType: 'CASH',
    paymentStatus: 'PAID',
    status: 'WAITING',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: '2',
    branchId: 'branch-2',
    billNumber: 'C-KPY-20342',
    patientId: '2',
    domain: 'CLINIC',
    visitType: 'IP',
    doctorId: 'cd-2',
    hospitalWard: 'Ward B - Room 204',
    totalAmount: 800,
    consultationFee: 800,
    paymentType: 'ONLINE',
    paymentStatus: 'PAID',
    status: 'IN_PROGRESS',
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// ============================================
// STORE INTERFACE
// ============================================
interface AppState {
  // Context
  context: AppContext;
  setContext: (context: AppContext) => void;
  
  // Patients (GLOBAL - shared across branches)
  patients: Patient[];
  addPatient: (patient: Patient) => void;
  searchPatientsByPhone: (phone: string) => Patient[];
  getPatientById: (id: string) => Patient | undefined;
  getPatientVisitHistory: (patientId: string) => PatientVisitHistoryItem[];
  
  // Bill lookup (auto-redirect to correct branch)
  findVisitByBillNumber: (billNumber: string) => { visit: DiagnosticVisit | ClinicVisit; branchId: string } | undefined;
  
  // Referral Doctors
  referralDoctors: ReferralDoctor[];
  addReferralDoctor: (doctor: ReferralDoctor) => void;
  updateReferralDoctor: (id: string, updates: Partial<ReferralDoctor>) => void;
  deleteReferralDoctor: (id: string) => void;
  getReferralDoctorById: (id: string) => ReferralDoctor | undefined;

  // Clinic Doctors (internal)
  clinicDoctors: ClinicDoctor[];
  addClinicDoctor: (doctor: ClinicDoctor) => void;
  updateClinicDoctor: (id: string, updates: Partial<ClinicDoctor>) => void;
  deleteClinicDoctor: (id: string) => void;
  getClinicDoctorById: (id: string) => ClinicDoctor | undefined;
  
  // Lab Tests (Master Catalog)
  labTests: LabTest[];
  addLabTest: (test: LabTest) => void;
  updateLabTest: (id: string, updates: Partial<LabTest>) => void;
  deleteLabTest: (id: string) => void;
  
  // Test Orders
  testOrders: TestOrder[];
  addTestOrders: (orders: TestOrder[]) => void;
  getTestOrdersByVisitId: (visitId: string) => TestOrder[];
  
  // Test Results
  testResults: TestResult[];
  addTestResults: (results: TestResult[]) => void;
  updateTestResults: (results: TestResult[]) => void;
  getTestResultsByReportVersionId: (reportVersionId: string) => TestResult[];
  
  // Reports
  reports: Report[];
  addReport: (report: Report) => void;
  getReportByVisitId: (visitId: string) => Report | undefined;
  
  // Report Versions
  reportVersions: ReportVersion[];
  addReportVersion: (version: ReportVersion) => void;
  updateReportVersion: (id: string, updates: Partial<ReportVersion>) => void;
  getReportVersionById: (id: string) => ReportVersion | undefined;
  getCurrentReportVersion: (visitId: string) => ReportVersion | undefined;
  
  // Diagnostic Visits
  diagnosticVisits: DiagnosticVisit[];
  addDiagnosticVisit: (visit: DiagnosticVisit) => void;
  updateDiagnosticVisit: (id: string, updates: Partial<DiagnosticVisit>) => void;
  getDiagnosticVisitById: (id: string) => DiagnosticVisit | undefined;
  getPendingDiagnosticVisits: () => DiagnosticVisit[];
  getDraftDiagnosticVisits: () => DiagnosticVisit[];
  getFinalizedDiagnosticVisits: () => DiagnosticVisit[];
  
  // Diagnostic Visit Views (denormalized for UI)
  getDiagnosticVisitView: (visitId: string) => DiagnosticVisitView | undefined;
  
  // Clinic Visits
  clinicVisits: ClinicVisit[];
  addClinicVisit: (visit: ClinicVisit) => void;
  updateClinicVisit: (id: string, updates: Partial<ClinicVisit>) => void;
  getClinicVisitView: (visitId: string) => ClinicVisitView | undefined;
  
  // Bill Counter
  billCounter: { diagnostic: number; clinic: number };
  generateBillNumber: (type: 'diagnostic' | 'clinic') => string;
}

// ============================================
// STORE IMPLEMENTATION
// ============================================
export const useAppStore = create<AppState>((set, get) => ({
  // Context
  context: 'dashboard',
  setContext: (context) => set({ context }),
  
  // Patients
  patients: SAMPLE_PATIENTS,
  addPatient: (patient) => set((state) => ({ patients: [...state.patients, patient] })),
  searchPatientsByPhone: (phone) => {
    const { patients } = get();
    return patients.filter((p) => p.phone.includes(phone));
  },
  getPatientById: (id) => {
    const { patients } = get();
    return patients.find((p) => p.id === id);
  },
  
  // Get patient visit history across ALL branches
  getPatientVisitHistory: (patientId) => {
    const { diagnosticVisits, clinicVisits } = get();
    const { getBranchById } = useBranchStore.getState();
    
    const history: PatientVisitHistoryItem[] = [];
    
    // Add diagnostic visits
    diagnosticVisits
      .filter((v) => v.patientId === patientId)
      .forEach((v) => {
        const branch = getBranchById(v.branchId);
        history.push({
          visitId: v.id,
          domain: 'DIAGNOSTICS',
          branchId: v.branchId,
          branchName: branch?.name || 'Unknown Branch',
          billNumber: v.billNumber,
          createdAt: v.createdAt,
        });
      });
    
    // Add clinic visits
    clinicVisits
      .filter((v) => v.patientId === patientId)
      .forEach((v) => {
        const branch = getBranchById(v.branchId);
        history.push({
          visitId: v.id,
          domain: 'CLINIC',
          branchId: v.branchId,
          branchName: branch?.name || 'Unknown Branch',
          billNumber: v.billNumber,
          visitType: v.visitType,
          createdAt: v.createdAt,
        });
      });
    
    // Sort by date descending
    return history.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },
  
  // Find visit by bill number (for auto-redirect)
  findVisitByBillNumber: (billNumber) => {
    const { diagnosticVisits, clinicVisits } = get();
    
    const diagVisit = diagnosticVisits.find((v) => v.billNumber.toLowerCase() === billNumber.toLowerCase());
    if (diagVisit) return { visit: diagVisit, branchId: diagVisit.branchId };
    
    const clinicVisit = clinicVisits.find((v) => v.billNumber.toLowerCase() === billNumber.toLowerCase());
    if (clinicVisit) return { visit: clinicVisit, branchId: clinicVisit.branchId };
    
    return undefined;
  },
  
  // Referral Doctors
  referralDoctors: SAMPLE_REFERRAL_DOCTORS,
  addReferralDoctor: (doctor) => set((state) => ({ 
    referralDoctors: [...state.referralDoctors, doctor] 
  })),
  updateReferralDoctor: (id, updates) => set((state) => ({
    referralDoctors: state.referralDoctors.map((d) => 
      d.id === id ? { ...d, ...updates } : d
    ),
  })),
  deleteReferralDoctor: (id) => set((state) => ({
    referralDoctors: state.referralDoctors.filter((d) => d.id !== id),
  })),
  getReferralDoctorById: (id) => {
    const { referralDoctors } = get();
    return referralDoctors.find((d) => d.id === id);
  },

  // Clinic Doctors
  clinicDoctors: SAMPLE_CLINIC_DOCTORS,
  addClinicDoctor: (doctor) => set((state) => ({
    clinicDoctors: [...state.clinicDoctors, doctor],
  })),
  updateClinicDoctor: (id, updates) => set((state) => ({
    clinicDoctors: state.clinicDoctors.map((d) => (d.id === id ? { ...d, ...updates } : d)),
  })),
  deleteClinicDoctor: (id) => set((state) => ({
    clinicDoctors: state.clinicDoctors.filter((d) => d.id !== id),
  })),
  getClinicDoctorById: (id) => {
    const { clinicDoctors } = get();
    return clinicDoctors.find((d) => d.id === id);
  },
  
  // Lab Tests
  labTests: SAMPLE_LAB_TESTS,
  addLabTest: (test) => set((state) => ({ labTests: [...state.labTests, test] })),
  updateLabTest: (id, updates) => set((state) => ({
    labTests: state.labTests.map((t) => 
      t.id === id ? { ...t, ...updates } : t
    ),
  })),
  deleteLabTest: (id) => set((state) => ({
    labTests: state.labTests.filter((t) => t.id !== id),
  })),
  
  // Test Orders
  testOrders: SAMPLE_TEST_ORDERS,
  addTestOrders: (orders) => set((state) => ({ 
    testOrders: [...state.testOrders, ...orders] 
  })),
  getTestOrdersByVisitId: (visitId) => {
    const { testOrders } = get();
    return testOrders.filter((o) => o.visitId === visitId);
  },
  
  // Test Results
  testResults: SAMPLE_TEST_RESULTS,
  addTestResults: (results) => set((state) => ({ 
    testResults: [...state.testResults, ...results] 
  })),
  updateTestResults: (results) => set((state) => {
    const updatedIds = new Set(results.map((r) => r.id));
    return {
      testResults: [
        ...state.testResults.filter((r) => !updatedIds.has(r.id)),
        ...results,
      ],
    };
  }),
  getTestResultsByReportVersionId: (reportVersionId) => {
    const { testResults } = get();
    return testResults.filter((r) => r.reportVersionId === reportVersionId);
  },
  
  // Reports
  reports: SAMPLE_REPORTS,
  addReport: (report) => set((state) => ({ 
    reports: [...state.reports, report] 
  })),
  getReportByVisitId: (visitId) => {
    const { reports } = get();
    return reports.find((r) => r.visitId === visitId);
  },
  
  // Report Versions
  reportVersions: SAMPLE_REPORT_VERSIONS,
  addReportVersion: (version) => set((state) => ({ 
    reportVersions: [...state.reportVersions, version] 
  })),
  updateReportVersion: (id, updates) => set((state) => ({
    reportVersions: state.reportVersions.map((v) => 
      v.id === id ? { ...v, ...updates } : v
    ),
  })),
  getReportVersionById: (id) => {
    const { reportVersions } = get();
    return reportVersions.find((v) => v.id === id);
  },
  getCurrentReportVersion: (visitId) => {
    const { reports, reportVersions } = get();
    const report = reports.find((r) => r.visitId === visitId);
    if (!report || !report.currentVersionId) return undefined;
    return reportVersions.find((v) => v.id === report.currentVersionId);
  },
  
  // Diagnostic Visits
  diagnosticVisits: SAMPLE_DIAGNOSTIC_VISITS,
  addDiagnosticVisit: (visit) => set((state) => ({ 
    diagnosticVisits: [...state.diagnosticVisits, visit] 
  })),
  updateDiagnosticVisit: (id, updates) => set((state) => ({
    diagnosticVisits: state.diagnosticVisits.map((v) => 
      v.id === id ? { ...v, ...updates, updatedAt: new Date() } : v
    ),
  })),
  getDiagnosticVisitById: (id) => {
    const { diagnosticVisits } = get();
    return diagnosticVisits.find((v) => v.id === id);
  },
  getPendingDiagnosticVisits: () => {
    const { diagnosticVisits } = get();
    return diagnosticVisits.filter((v) => v.status === 'RESULTS_PENDING');
  },
  getDraftDiagnosticVisits: () => {
    const { diagnosticVisits } = get();
    return diagnosticVisits.filter((v) => v.status === 'DRAFT');
  },
  getFinalizedDiagnosticVisits: () => {
    const { diagnosticVisits } = get();
    return diagnosticVisits.filter((v) => v.status === 'FINALIZED');
  },
  
  // Diagnostic Visit View (denormalized for UI)
  getDiagnosticVisitView: (visitId) => {
    const state = get();
    const visit = state.diagnosticVisits.find((v) => v.id === visitId);
    if (!visit) return undefined;
    
    const patient = state.patients.find((p) => p.id === visit.patientId);
    if (!patient) return undefined;
    
    const testOrders = state.testOrders.filter((o) => o.visitId === visitId);
    const referralDoctor = visit.referralDoctorId 
      ? state.referralDoctors.find((d) => d.id === visit.referralDoctorId)
      : undefined;
    
    const report = state.reports.find((r) => r.visitId === visitId);
    const currentReportVersion = report?.currentVersionId
      ? state.reportVersions.find((v) => v.id === report.currentVersionId)
      : undefined;
    
    const results = currentReportVersion
      ? state.testResults.filter((r) => r.reportVersionId === currentReportVersion.id)
      : [];
    
    return {
      visit,
      patient,
      testOrders,
      referralDoctor,
      report,
      currentReportVersion,
      results,
    };
  },
  
  // Clinic Visits
  clinicVisits: SAMPLE_CLINIC_VISITS,
  addClinicVisit: (visit) => set((state) => ({ 
    clinicVisits: [...state.clinicVisits, visit] 
  })),
  updateClinicVisit: (id, updates) => set((state) => ({
    clinicVisits: state.clinicVisits.map((v) => 
      v.id === id ? { ...v, ...updates, updatedAt: new Date() } : v
    ),
  })),
  getClinicVisitView: (visitId) => {
    const state = get();
    const visit = state.clinicVisits.find((v) => v.id === visitId);
    if (!visit) return undefined;
    
    const patient = state.patients.find((p) => p.id === visit.patientId);
    if (!patient) return undefined;
    
    const referralDoctor = visit.referralDoctorId
      ? state.referralDoctors.find((d) => d.id === visit.referralDoctorId)
      : undefined;
    const clinicDoctor = state.getClinicDoctorById(visit.doctorId);
    
    return { visit, patient, referralDoctor, clinicDoctor };
  },
  
  // Bill Counter
  billCounter: { diagnostic: 10234, clinic: 20343 },
  generateBillNumber: (type) => {
    const { billCounter } = get();
    const prefix = type === 'diagnostic' ? 'D' : 'C';
    const number = billCounter[type];
    set({ 
      billCounter: { 
        ...billCounter, 
        [type]: number + 1 
      } 
    });
    return `${prefix}-${number}`;
  },
}));

// Export LAB_TESTS for backward compatibility
export const LAB_TESTS = SAMPLE_LAB_TESTS;
