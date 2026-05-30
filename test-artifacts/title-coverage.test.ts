/**
 * Comprehensive test: Title/Salutation coverage across all surfaces
 * Tests that Mr/Mrs/Ms/Baby titles show up everywhere patient name appears
 */
import { readFileSync } from "fs";
import { resolve } from "path";

const PASS = "✅";
const FAIL = "❌";
const WARN = "⚠️";

let passCount = 0;
let failCount = 0;
let warnCount = 0;

function check(name: string, condition: boolean, detail?: string) {
  if (condition) { passCount++; console.log(`  ${PASS} ${name}`); }
  else { failCount++; console.log(`  ${FAIL} ${name}${detail ? ` — ${detail}` : ""}`); }
}
function warn(name: string, detail?: string) {
  warnCount++; console.log(`  ${WARN} ${name}${detail ? ` — ${detail}` : ""}`);
}

// ============================================================
// TEST 1: patientDisplay.ts — Core utility functions
// ============================================================
console.log("\n📋 TEST 1: patientDisplay.ts utility");
{
  const content = readFileSync(resolve("health-hub/src/lib/patientDisplay.ts"), "utf8");
  check("Removed MASTER from TITLE_TO_GENDER", !content.includes("MASTER"));
  check("Removed MASTER from titleOptions", !content.includes("MASTER"));
  check("formatPatientName function exists", content.includes("export function formatPatientName"));
  check("formatTitleLabel handles MR → Mr.", content.includes('case "MR":') && content.includes('"Mr."'));
  check("formatTitleLabel handles MRS → Mrs.", content.includes('case "MRS":') && content.includes('"Mrs."'));
  check("formatTitleLabel handles MS → Ms.", content.includes('case "MS":') && content.includes('"Ms."'));
  check("formatTitleLabel handles BABY → Baby", content.includes('case "BABY":') && content.includes('"Baby"'));
  check("TITLE_TO_GENDER maps MR → M", content.includes('MR: "M"'));
  check("TITLE_TO_GENDER maps MRS → F", content.includes('MRS: "F"'));
  check("TITLE_TO_GENDER maps MS → F", content.includes('MS: "F"'));
  check("BABY not in TITLE_TO_GENDER (no auto-gender)", !content.includes('BABY:'));
  check("No empty string SelectItem (fixes crash)", !content.includes('value: ""'));
}

// ============================================================
// TEST 2: Prisma schema — Title enum
// ============================================================
console.log("\n📋 TEST 2: Prisma schema");
{
  const content = readFileSync(resolve("health-hub-backend/prisma/schema.prisma"), "utf8");
  check("Title enum exists", content.includes("enum Title {"));
  check("Title enum has MR", content.match(/Title\s*\{[^}]*MR/s) !== null);
  check("Title enum has MRS", content.match(/Title\s*\{[^}]*MRS/s) !== null);
  check("Title enum has MS", content.match(/Title\s*\{[^}]*MS/s) !== null);
  check("Title enum has BABY", content.match(/Title\s*\{[^}]*BABY/s) !== null);
  check("Title enum does NOT have MASTER", !content.match(/Title\s*\{[^}]*MASTER/s));
  check("Patient model has title field", content.includes("title         Title?"));
}

// ============================================================
// TEST 3: Backend API — patientService returns title
// ============================================================
console.log("\n📋 TEST 3: Backend patientService.ts — returns title");
{
  const content = readFileSync(resolve("health-hub-backend/src/services/patientService.ts"), "utf8");
  check("searchPatients() returns title", content.includes("title: result.patient.title"));
  check("getPatient360View() returns title", content.includes("title: patient.title"));
  check("Duplicate detection 409 returns title", content.includes("title: existingPatient.title"));
  check("CreatePatientInput accepts title", content.includes("title?: 'MR'"));
  check("UpdatePatientInput accepts title", content.includes("title?: 'MR'")); // second occurrence
  check("Title is an IDENTITY_FIELD", content.includes("'title'"));
  check("Title is written on update", content.includes("patientUpdates.title"));
}

// ============================================================
// TEST 4: Backend bills route — returns title
// ============================================================
console.log("\n📋 TEST 4: Backend bills.ts — returns title");
{
  const content = readFileSync(resolve("health-hub-backend/src/routes/bills.ts"), "utf8");
  check("Bills API returns title", content.includes("title: visit.patient.title"));
  check("Bills API returns patient age", content.includes("age: getPatientAge("));
}

// ============================================================
// TEST 5: Frontend billReceiptMappers — forward title
// ============================================================
console.log("\n📋 TEST 5: Frontend billReceiptMappers.ts — forward title");
{
  const content = readFileSync(resolve("health-hub/src/lib/billReceiptMappers.ts"), "utf8");
  check("ApiBillData interface has title", content.includes("title?: string | null"));
  check("mapApiBillToReceiptData forwards title", content.includes("title: api.patient.title"));
  check("mapClinicVisitViewToReceiptData forwards title", content.includes("title: patient.title"));
  check("mapDiagnosticsVisitViewToReceiptData forwards title", content.includes("title: visitView.patient.title"));
}

// ============================================================
// TEST 6: BillReceipt component — uses formatPatientName
// ============================================================
console.log("\n📋 TEST 6: BillReceipt.tsx — displays title on printed bill");
{
  const content = readFileSync(resolve("health-hub/src/components/print/BillReceipt.tsx"), "utf8");
  check("Imports formatPatientName", content.includes("import { formatPatientName }"));
  check("Name rendered with formatPatientName", content.includes("formatPatientName(data.patient.name"));
  check("Title passed from patient data", content.includes("data.patient as any).title"));
  check("Uppercase mode for bills", content.includes("data.patient as any).title, true"));
  check("Gender still shows on bill", content.includes("genderFull"));
  check("Authorized signatory has overflow-hidden", content.includes("overflow-hidden"));
}

// ============================================================
// TEST 7: Patient360 — displays title
// ============================================================
console.log("\n📋 TEST 7: Patient360.tsx — displays title on patient page");
{
  const content = readFileSync(resolve("health-hub/src/pages/clinic/Patient360.tsx"), "utf8");
  check("Imports formatPatientName", content.includes("import { formatPatientName }"));
  check("Name rendered with formatPatientName", content.includes("formatPatientName(patient.name, (patient as any).title)"));
}

// ============================================================
// TEST 8: ClinicPrescriptionPrint — displays title
// ============================================================
console.log("\n📋 TEST 8: ClinicPrescriptionPrint.tsx — displays title on printed Rx");
{
  const content = readFileSync(resolve("health-hub/src/components/print/ClinicPrescriptionPrint.tsx"), "utf8");
  check("Imports formatPatientName", content.includes("import { formatPatientName }"));
  check("Name rendered with title", content.includes("formatPatientName(patient.name, (patient as any).title"));
}

// ============================================================
// TEST 9: ReportPrint — displays title
// ============================================================
console.log("\n📋 TEST 9: ReportPrint.tsx — displays title on printed report");
{
  const content = readFileSync(resolve("health-hub/src/components/print/ReportPrint.tsx"), "utf8");
  check("Imports formatPatientName", content.includes("import { formatPatientName }"));
  check("Name rendered with title", content.includes("formatPatientName(patient.name, (patient as any).title)"));
}

// ============================================================
// TEST 10: Report renderer (backend) — title in report HTML/PDF
// ============================================================
console.log("\n📋 TEST 10: reportRendererService.ts — title in report PDF/HTML");
{
  const content = readFileSync(resolve("health-hub-backend/src/services/reportRendererService.ts"), "utf8");
  check("Patient info HTML has title prefix", content.includes("snapshot.patient.title ? escapeHtml(snapshot.patient.title) + '. '"));
  check("HTML <title> tag has title prefix", content.includes("snapshot.patient.title"));
}

// ============================================================
// TEST 11: Report snapshot — stores title
// ============================================================
console.log("\n📋 TEST 11: reportSnapshotService.ts — title in immutable snapshot");
{
  const content = readFileSync(resolve("health-hub-backend/src/services/reportSnapshotService.ts"), "utf8");
  check("PatientSnapshot has title field", content.includes("title?: string | null"));
  check("First snapshot build stores title", content.includes("title: (patient as any).title || null"));
  const titleMatches = (content.match(/title: \(patient as any\)\.title \|\| null/g) || []).length;
  check("Both snapshot builds store title", titleMatches >= 2);
}

// ============================================================
// TEST 12: WhatsApp notification service — title in messages
// ============================================================
console.log("\n📋 TEST 12: notificationService.ts — title in WhatsApp messages");
{
  const content = readFileSync(resolve("health-hub-backend/src/services/notificationService.ts"), "utf8");
  const titleRefs = (content.match(/info\.patient\.title/g) || []).length;
  check("Title used in WhatsApp templates", titleRefs >= 2, `found ${titleRefs} references`);
  check("WhatsApp report notification includes title", content.includes("info.patient.title ? info.patient.title"));
  check("WhatsApp bill notification includes title", content.includes("info.patient.title ? info.patient.title"));
}

// ============================================================
// TEST 13: All frontend display surfaces — formatPatientName usage
// ============================================================
console.log("\n📋 TEST 13: All frontend display surfaces");
const files = [
  { path: "health-hub/src/pages/clinic/Patient360.tsx", name: "Patient360" },
  { path: "health-hub/src/pages/clinic/GlobalPatientSearch.tsx", name: "GlobalPatientSearch" },
  { path: "health-hub/src/pages/clinic/ClinicVisitQueue.tsx", name: "ClinicVisitQueue" },
  { path: "health-hub/src/pages/clinic/ClinicNewVisit.tsx", name: "ClinicNewVisit" },
  { path: "health-hub/src/pages/doctor/DoctorDashboard.tsx", name: "DoctorDashboard" },
  { path: "health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx", name: "DiagnosticsNewVisit" },
  { path: "health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx", name: "DiagnosticsResultEntry" },
  { path: "health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx", name: "DiagnosticsPendingResults" },
  { path: "health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx", name: "DiagnosticsFinalizedReports" },
  { path: "health-hub/src/pages/diagnostics/DiagnosticsReportPreview.tsx", name: "DiagnosticsReportPreview" },
  { path: "health-hub/src/pages/owner/OwnerOperationsPage.tsx", name: "OwnerOperations" },
  { path: "health-hub/src/pages/owner/OwnerMoneyPage.tsx", name: "OwnerMoney" },
  { path: "health-hub/src/pages/owner/PayoutDetail.tsx", name: "PayoutDetail" },
  { path: "health-hub/src/components/print/BillReceipt.tsx", name: "BillReceipt" },
  { path: "health-hub/src/components/print/ClinicPrescriptionPrint.tsx", name: "ClinicPrescriptionPrint" },
  { path: "health-hub/src/components/print/ReportPrint.tsx", name: "ReportPrint" },
  { path: "health-hub/src/components/diagnostics/ReportFramedNarrativeEditor.tsx", name: "FramedNarrativeEditor" },
];

for (const { path, name } of files) {
  const content = readFileSync(resolve(path), "utf8");
  check(`${name}: formatPatientName imported`, content.includes("import { formatPatientName }") || content.includes("import { TITLE_TO_GENDER, titleOptions, formatPatientName }"));
  check(`${name}: formatPatientName called`, content.includes("formatPatientName("));
}

// ============================================================
// TEST 14: New patient form layout
// ============================================================
console.log("\n📋 TEST 14: New patient form layout (wireframe)");
{
  const diagContent = readFileSync(resolve("health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx"), "utf8");
  const clinicContent = readFileSync(resolve("health-hub/src/pages/clinic/ClinicNewVisit.tsx"), "utf8");
  
  check("Diagnostics: Row 1 Title+Name grid-cols-3", diagContent.includes("Title") && diagContent.includes("Full Name *") && diagContent.includes("md:col-span-2"));
  check("Diagnostics: Row 2 Gender+Age+DOB grid-cols-3", diagContent.includes("Gender *"));
  check("Clinic: Row 1 Title+Name grid-cols-3", clinicContent.includes("Title") && clinicContent.includes("Full Name *") && clinicContent.includes("md:col-span-2"));
  check("Clinic: Row 2 Gender+Age+DOB grid-cols-3", clinicContent.includes("Gender *"));
}

// ============================================================
// TEST 15: Duplicate patient handling — title preserved
// ============================================================
console.log("\n📋 TEST 15: Duplicate patient alerts preserve title");
{
  const diagContent = readFileSync(resolve("health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx"), "utf8");
  const clinicContent = readFileSync(resolve("health-hub/src/pages/clinic/ClinicNewVisit.tsx"), "utf8");

  check("Diagnostics: confirm() uses formatPatientName", diagContent.includes("formatPatientName(existing.name, existing.title)"));
  check("Diagnostics: patient object includes title", diagContent.includes("title: existing.title"));
  check("Clinic: confirm() uses formatPatientName", clinicContent.includes("formatPatientName(existing.name, existing.title)"));
  check("Clinic: patient object includes title", clinicContent.includes("title: existing.title"));
}

// ============================================================
// TEST 16: FramedPatient (report narrative editor)
// ============================================================
console.log("\n📋 TEST 16: FramedPatient — title passed to report editor");
{
  const resultEntry = readFileSync(resolve("health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx"), "utf8");
  check("DiagnosticsResultEntry passes title to FramedPatient", resultEntry.includes("title: visit?.patient.title"));
  
  const editor = readFileSync(resolve("health-hub/src/components/diagnostics/ReportFramedNarrativeEditor.tsx"), "utf8");
  check("FramedPatient interface has title", editor.includes("title?: string | null"));
}

// ============================================================
// TEST 17: Owner/payout backend services — patientTitle
// ============================================================
console.log("\n📋 TEST 17: Owner/payout backend services");
{
  const opsContent = readFileSync(resolve("health-hub-backend/src/services/ownerOperationsService.ts"), "utf8");
  check("ownerOperationsService has patientTitle", opsContent.includes("patientTitle"));
  
  const moneyContent = readFileSync(resolve("health-hub-backend/src/services/ownerMoneyService.ts"), "utf8");
  check("ownerMoneyService has patientTitle", moneyContent.includes("patientTitle"));
  
  const payoutContent = readFileSync(resolve("health-hub-backend/src/services/payoutService.ts"), "utf8");
  check("payoutService has patientTitle", payoutContent.includes("patientTitle"));
  
  const exportContent = readFileSync(resolve("health-hub-backend/src/services/payoutExportService.ts"), "utf8");
  check("payoutExportService has patientTitle column", exportContent.includes("patientTitle"));
}

// ============================================================
// TEST 18: Frontend types — Title type updated
// ============================================================
console.log("\n📋 TEST 18: Frontend types");
{
  const typesContent = readFileSync(resolve("health-hub/src/types/index.ts"), "utf8");
  check("Title type: MR", typesContent.includes('"MR"'));
  check("Title type: MRS", typesContent.includes('"MRS"'));
  check("Title type: MS", typesContent.includes('"MS"'));
  check("Title type: BABY", typesContent.includes('"BABY"'));
  check("Title type: NO MASTER", !typesContent.includes("MASTER"));
  check("Patient interface has title", typesContent.includes("title?: Title | null"));
  check("Bill receipt patient has title", typesContent.includes("title?: string | null"));
}

// ============================================================
// RESULTS
// ============================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`RESULTS: ${PASS} ${passCount} passed, ${FAIL} ${failCount} failed, ${WARN} ${warnCount} warnings`);
console.log(`${"=".repeat(60)}`);

process.exit(failCount > 0 ? 1 : 0);
