# HealthFlow Module + Feature Taxonomy (Authoritative)

Multi-tenant white-label taxonomy for the sobhana-portal codebase. Four modules — **Core** (never toggleable), **Diagnostics**, **OP/Clinics**, **IP** (reserved) — plus a **Shared / CrossCutting layer** (cross-domain code that is neither a single module nor pure Core-identity) and a cross-cutting **feature** layer. The "Ambiguous / shared-domain-aware" surfaces are not a module; they are coupling seams (§2) that must degrade gracefully when a module is off.

Synthesis rule applied throughout: where two passes disagreed, the **op-removal deep-trace (opTrace)** wins on "what physically breaks," the **schema pass** wins on "where the seam lives in data," and the **features pass** wins on flag keys/defaults. Disagreements are called out inline under "Resolved conflicts." This revision folds in three adversarial critic passes (completeness, break-op=false, refactor-safety); their accepted findings are marked **[C-fix]** and the few downgraded/rejected points are noted in one line each.

**Placement invariant:** every live route/model/service/page is homed exactly once — in a module (§1.1–1.4), the Shared/CrossCutting layer (§1.5), or the dead-legacy list. Seams (§2) reference those homes; they do not re-home.

---

## 1. Module registry

### 1.1 Core — always on, never toggleable

Auth, identity, money primitives, transport, PDF engine, tokens, sequences, and the shared staff landing. Present in every tenant regardless of modules purchased.

| Kind | Items |
|---|---|
| Routes | `auth.ts` → /api/auth; `branches.ts` → /api/branches; `users.ts` → /api/users; `patients.ts` → /api/patients (identity/CRUD portion; the `/360/timeline` aggregation is a seam, §2); `auditLogs.ts` → /api/audit-logs; `webhooks.ts` → /webhooks/whatsapp; **`billDownload.ts` → /bills/view** (token bill PDF — shared money print; only the CLINIC line-item branch is OP-gated) **[C-fix]** |
| Models | NumberSequence, Patient, PatientIdentifier, PatientChangeLog, Branch, User, AuditLog, MessageLog (transport — see feature `whatsappResultDelivery`) |
| Services | auditService, authService, billAccessService, numberService, patientMatchingService, pdfGenerationService, r2StorageService, whatsappCloudService, tokenService (dead legacy — safe to delete), billFinancialService (pure money math, shared), **billPdfService** (shared bill PDF render; CLINIC `fetchBillData` branch lines 183–256 is OP-gated dead-but-safe) **[C-fix]** |
| Frontend pages | Login, NotFound, legal/PrivacyPolicy, legal/TermsOfService, legal/DataDeletion, owner/_shared/ownerUi.tsx, owner/ManageRoles.tsx; **Dashboard.tsx** (shared staff landing at `/` — its `ClinicVisitSummary` cards **and** its `/visits/clinic` fetch are OP-coupled, see §2 + §3 BLOCKER) **[C-fix]**; **BillPrintPage.tsx** (shared money/print page, routed App.tsx:224 — carries the `reportQrBillGateway` QR, so it degrades with that feature but is otherwise Core) **[C-fix]** |
| Layout/infra | AppLayout, ProtectedRoute, BranchConfirmModal, BranchSelector, ContextBanner |

**Relocated-into-Core (from opTrace, overrides frontend pass's "Ambiguous" filing):** `GlobalPatientSearch.tsx` and `Patient360.tsx` are **Core cross-domain patient-identity pages** currently mis-filed under `pages/clinic/` and served at `/clinic/patient-search` + `/clinic/patient-360/:patientId`. They must survive OP=off. The domain aggregation inside them is a seam (§2), but the pages themselves are Core. **Action: relocate both to `pages/patients/` and off the `/clinic` URL namespace before OP is made toggleable — see §3 #1 and §7 step 2 for the full deep-link/context surgery this requires.**

### 1.2 Diagnostics — toggleable (the lab)

| Kind | Items |
|---|---|
| Routes | diagnosticVisits.ts → /api/visits/diagnostic; referralDoctors.ts → /api/referral-doctors; departments.ts; diagnosticCenters.ts; externalLabs.ts; externalUploads.ts; signingDoctors.ts; signingLabIncharges.ts; signingRules.ts; labInchargeRules.ts; reports.ts (410 stub); reportDownload.ts → /reports/:token; reportGateway.ts → /r/:token; clinicalDefinitions.ts; clinicalPanels.ts; billableProducts.ts; testInputConfigs.ts; **legacy dead (commented out in index.ts):** labTests.ts, panels.ts |
| Models | ReferralDoctor, ReferralDoctorProductRule, ReferralDoctor_Visit, LabTest, TestOrder, DiagnosticReport, ReportVersion, TestResult, Department, PanelDefinition, PanelTestItem, SigningDoctor, SigningRule, SigningLabIncharge, LabInchargeRule, InterpretationTemplate, ReportAccessToken, ReportAccessLog, TestAgeRange, DerivedParameter, DiagnosticReferralCenter, DiagnosticCenterProductRule, ExternalLab, ExternalLabProductRule, DiagnosticCenter_Visit, TestDefinition, TestDefinitionRange, InterpretationRule, ClinicalPanel, ClinicalPanelItem, BillableProduct, BillableProductPanel, ExternalReportUpload, **ProductBranchPricing** (single home = here; hangs off BillableProduct — feature-gated via the `branchPricingOverrides` flag, which is therefore a **Diagnostics** feature, not Core — resolves the double-home) **[C-fix]**, TestInputConfig, DerivedParameterDef |
| Services | billItemService, clinicalDefinitionService, derivedParameterService, diagnosticCenterService, diagnosticWorkflowService, externalLabService, mergedReportPdfCache, mergedReportPdfService, productExportService, productOrderService, referenceRangeService, reportAccessService, reportQrService, reportRendererService, reportSnapshotService, visitCorrectionService |
| Frontend | diagnostics/DiagnosticsNewVisit, DiagnosticsPendingResults, DiagnosticsFinalizedReports, DiagnosticsResultEntry, DiagnosticsReportPreview; ReportViewPage; owner/ManageClinicalDefinitions, ManagePanelDefinitions, ManageDepartments, ManageSigningDoctors, ManageDiagnosticCenters, OutsideLabs; staffNavItems['Diagnostics']; ownerNavItems['Payouts']>'Outside Labs' |

**Moved out (was mis-filed here):** `payoutCategorize` → §1.5 Shared/CrossCutting. It is payout infrastructure imported by payoutService (category engine over all 4 payee types incl LAB/DIAGNOSTIC_CENTER/REFERRAL/CLINIC), not a Diagnostics service; the feature table already calls it CrossCutting under `doctorPayoutsPayRun`. **[C-fix]**

**Note on the "Diagnostics catalog is Core" temptation:** TestDefinition/ClinicalPanel/BillableProduct/Department could look Core, but every one is tied to the diagnostic workflow (workflowMode: DiagnosticWorkflowMode, ClinicalPanel FKs). They are **Diagnostics**, not Core. If a diagnostics-off tenant ever existed they'd be dead — but there is no such tenant (a lab without Diagnostics is not a lab). Diagnostics is effectively always-on today but stays a module for symmetry (see open decision §8.2).

### 1.3 OP / Clinics — toggleable (the "might not need clinics" module)

| Kind | Items |
|---|---|
| Routes | clinicVisits.ts → /api/visits/clinic; clinicDoctors.ts → /api/clinic-doctors; **CLINIC branch of** bills.ts `GET /:domain/:visitId` (consultation-fee bill items, lines ~75, 201-210) |
| Models | ClinicVisit, ClinicDoctor; **OP-only columns on shared tables:** DoctorPayoutLedger.clinicDoctorId + doctorType=CLINIC; Visit.clinicVisit relation + Visit.domain=CLINIC value; enum ClinicVisitType{OP,IP} |
| Services | doctorService **clinic-doctor half** (searchClinicDoctorByContact, createClinicDoctor, listClinicDoctors, deactivateClinicDoctor); payoutService **CLINIC case** (derivePayoutForClinicDoctor ~line 351, PAYOUT_TYPES_ORDER CLINIC entry ~1768); numberService.generateClinicDoctorNumber; visitCorrectionService clinic paths |
| Frontend | clinic/ClinicNewVisit, clinic/ClinicVisitQueue; owner/ManageClinicDoctors; App.tsx routes /clinic/new, /clinic/queue; Sidebar staff 'Clinic' group + owner 'Workflows' clinic sub-items; **Clinic Doctors sub-tab** of ManageDoctorsAndReferrals (the outer Referrals tab is Shared/CrossCutting — see §1.5) |

### 1.4 IP / Inpatient — reserved, not built

| Kind | Items |
|---|---|
| Only forward reference | `enum ClinicVisitType { OP, IP }` variant on ClinicVisit (schema.prisma:110). No models, routes, services, or pages exist. |
| Note | IP currently **rides on the OP module** (shares the ClinicVisit table via visitType). When IP becomes its own toggle, ClinicVisit.visitType is the clean split point. Scaffold `ipInpatientModule` off for all tenants now so the flag exists. |

### 1.5 Shared / CrossCutting layer — not a module, homes the cross-domain code **[C-fix]**

Genuinely cross-domain surfaces that read/aggregate across Diagnostics + OP. They are not route-gated (they serve Core dashboards and Core cross-search); they read the module flag internally and branch (§6). Every item below has its **single home here**, and its degrade rule in §2.

| Kind | Items |
|---|---|
| Routes | `doctors.ts` → /api/doctors (cross-domain patient/doctor search, `/search-by-contact` fan-out over ReferralDoctor + ClinicDoctor — a live mounted route, not homeless) **[C-fix]**; `bills.ts` → /api/bills (money ledger, seam §2); `payouts.ts` → /api/payouts (Pay-Run worklist); `statementDownload.ts`; `moneyDaySheet.ts`; `ownerDashboard.ts` + owner aggregation routes |
| Services | `payoutCategorize` (payout category engine, CATEGORY_ORDER over 4 payee types) **[C-fix]**; payoutService, payoutExportService, statementAccessService; ownerMoneyService, ownerMetricsService, ownerOperationsService, ownerDoctorsService, ownerDashboardV2Service; patient360Util; referralPayoutService (**already a standalone file** — the "promote referral math to Core" step is therefore smaller than earlier framing implied) |
| Models (shared superset — no single-module home; gated at seam/service layer, never at schema) | Visit, Bill, PaymentTransaction, OrderRefund, DoctorPayoutLedger; **DoctorPayoutRule** (used cross-domain for referral/lab/DC/clinic rates — homed here, not Diagnostics) **[C-fix, low-stakes]** |
| Frontend | OwnerMoneyPage, OwnerDashboardV2, **OwnerDoctorsPage, OwnerOperationsPage** (the asymmetric omission — now listed beside their twins) **[C-fix]**; PayoutsList, PayoutStatement; ManageDoctorsAndReferrals (outer Referrals tab; its Clinic Doctors sub-tab is OP, §1.3) |

**Dead legacy (safe to delete, same treatment as tokenService / labTests.ts / panels.ts):** `owner/ManageDoctors.tsx` — no importers anywhere (AdminConfigCenter uses ManageDoctorsAndReferrals; `grep 'from .*ManageDoctors\b'` returns nothing). Silently dropped by the draft; recorded here. **[C-fix]**

---

## 2. Coupling seams (the "Ambiguous" surfaces)

These aggregate or branch across Diagnostics + OP. **Never call them Core.** The root of every one is `Visit.domain` (VisitDomain = DIAGNOSTICS | CLINIC, schema.prisma:508). Because the schema is a single-table superset design, **you cannot drop a module at the schema layer** — enforcement is at the service/route layer with domain filters. In a DB-per-tenant superset clone the CLINIC enum value and clinicDoctorId column simply go unwritten.

Behavior rule shorthand: **BLOCK** = reject at write-time; **EXCLUDE** = drop rows from query/response; **HIDE** = remove UI element; **ZERO-OK** = leave aggregation (returns 0 harmlessly) but omit the tile; **TOLERATE** = frontend must not throw on a 403/empty from a gated dependency.

| Seam | Surfaces | Rule when OP=off |
|---|---|---|
| **Visit.domain** (master seam) | Visit table, enum | **BLOCK** creation of domain=CLINIC visits (write-time guard). Enum member stays. Every query that reads Visit without a domain filter must add `domain=DIAGNOSTICS` or it silently mixes modules. |
| **Staff Dashboard fetch** (BLOCKER seam — new) | Dashboard.tsx lines 68–85 `Promise.all([fetch('/visits/diagnostic'), fetch('/visits/clinic')])` then `if (!diagnosticRes.ok \|\| !clinicRes.ok) throw`; cards lines 195–253 | **TOLERATE first, then gate.** Once `/api/visits/clinic` gets `requireModule('op')`, `clinicRes` 403s and the throw blanks the **entire Core home** (incl. the diagnostics "Pending Lab Results" card). **Fix must ship in the same release as, or before, the backend guard:** skip the `/visits/clinic` fetch when op=off (default `clinicVisits=[]`), OR only throw on `diagnosticRes` failure. Then also HIDE the three OP cards ("Waiting OP", "Active IP", "New Clinic Visit"). See §3 #0. **[C-fix, blocker]** |
| **Bill / PaymentTransaction / OrderRefund** | bills.ts `GET /:domain/:visitId`, billDownload.ts, billPdfService, billFinancialService | Money ledger is domain-agnostic; the only OP-specific logic is the consultation-fee line-item branch. **BLOCK/reject** `domain=CLINIC` at the bill route (404) when OP off; the CLINIC branch of billPdfService (fetchBillData lines 183–256, revisitNote block) is dead-but-safe — tighten validator to enabled-domain set. billDownload.ts serves BillAccessToken PDFs and is otherwise Core. Severity: **low** (no CLINIC visits exist to request). |
| **DoctorPayoutLedger / payouts.ts / PayoutsList** | payouts.ts, payoutService (derivePayout switch bodies ~725/743/1702), payoutCategorize, payoutExportService, statementDownload.ts, PayoutsList.tsx, PayoutStatement.tsx | **EXCLUDE** CLINIC from PAYOUT_TYPES_ORDER (line ~1768) + the derive loop; **HIDE** the CLINIC filter chip/bulk-review bucket. clinicDoctorId column stays, never populated. Verified safe: the worklist builds from existing ledger rows, so an op-off tenant with no CLINIC rows yields an empty group (not an error); the fix removes the empty bucket. This is the deepest code seam — the switch/case shares one function body; remove the CLINIC case without touching REFERRAL/LAB/DIAGNOSTIC_CENTER. |
| **Owner money** (ownerMoneyService, moneyDaySheetExportService, OwnerMoneyPage, moneyDaySheet.ts) | domain filter ALL\|DIAGNOSTICS\|CLINIC; clinicVisit.findMany (lines ~352/390); CLINIC rows special-cased (testCount=1, "Consultation — Dr. X", CLINIC→'OP' export label) | **HIDE** the CLINIC segment from the domain toggle. Server already returns zero clinic bills, so **ZERO-OK** on math — UI gating only. |
| **Owner metrics** (ownerMetricsService) | visits groupBy → {diagnostics, clinic} | **ZERO-OK** aggregation; **HIDE/omit** the clinic volume tile from the response. topReferringDoctors/topTests are Diagnostics-only (drop only if Diagnostics off). |
| **Owner operations** (ownerOperationsService) | inQueueClinic + clinicQueue section; clinicVisit.findMany (~374/396) | **HIDE** the CLINIC queue card; **EXCLUDE** CLINIC from the groupBy consumers so no permanent empty "0" card ships. Severity: **medium**. |
| **Owner doctors** (ownerDoctorsService) | netClinicRevenueInPaise, clinicVisitsInWindow, clinicCommissionInPaise; clinicVisit.findMany (~262) | **EXCLUDE** CLINIC doctorType rows; **HIDE/zero** the clinic revenue card + clinic leaderboard section. |
| **Owner dashboard V2** (ownerDashboardV2Service, OwnerDashboardV2.tsx) | **10** inline prisma.clinicVisit queries (verified — not "6+"), clinicCommissionInPaise helper, 3-tile pulse | **EXCLUDE**/guard every clinicVisit call; **HIDE** the clinic pulse tile + inQueueClinic action-queue entry. No clean boundary to flip — needs per-call guards. |
| **Patient 360 timeline** (patient360Util, patientService, Patient360.tsx, GlobalPatientSearch.tsx) | patientService `/360/timeline` unconditionally `include`s `clinicVisit:{clinicDoctor}` (lines 367–370) and branches on `domain==='CLINIC'` (444–450); TimelineFilters.domain = DIAGNOSTICS\|CLINIC; buildTimelineWhere | Pages stay (Core). **Two things must land together or an op-off tenant gets a dead always-empty CLINIC filter:** (a) buildTimelineWhere must **reject/omit** CLINIC from valid filter values and from its WHERE output; (b) Patient360 must **HIDE** the CLINIC domain-filter option and the clinic VisitInspector branch. The unconditional `include` is safe in the superset clone (table exists, returns null for diagnostic visits) — correctness rests entirely on (a)+(b). **Add a test asserting the timeline WHERE never emits domain=CLINIC under op=off.** **[C-fix]** |
| **GlobalPatientSearch register CTA** (new) | GPS `register()` line 74 `navigate('/clinic/new', …)` | The primary CTA on the supposedly-Core hub dead-ends into ClinicNewVisit, which §6 wraps in `<ModuleRoute module="op">` and 404s when op=off. **Make register() flag-aware:** route to `/diagnostics/new` when op=off, or hide/relabel the CTA. Product must decide which new-visit flow a diagnostics-only patient hub launches. See §3 #1b. **[C-fix]** |
| **doctors.ts /search-by-contact** | Promise.all over ReferralDoctor + ClinicDoctor (line 25) | **Safe as-is under the chosen superset strategy** (downgraded from "highest-risk"): in the DB-per-tenant superset clone ClinicDoctor always exists and `searchClinicDoctorByContact` simply returns empty under op=off — no hard error. The split-into-two-optional-paths work is **deferred and NOT part of the OP-toggle refactor**; it only matters under a fork-the-schema strategy this doc explicitly rejects. **[C-fix, downgraded]** |
| **messages.ts** | send-report (Diagnostics), send-bill (both) | send-report untouched by OP. Add a CLINIC guard on send-bill so stale clinic bill resends can't fire when OP off. |
| **StatementAccessToken / statementDownload.ts** | token → DoctorPayoutLedger (any payee type) | **BLOCK** issuance of CLINIC-type statements; route has no module gate, so a CLINIC token would otherwise resolve. |
| **ManageDoctorsAndReferrals mount fetch** (low, new) | `useEffect(()=>fetchClinicDoctors(),[token])` line 395 fires `GET /clinic-doctors` on every mount | Not a break (line 388 uses safe `if (res.ok) setClinicDoctors(...)`, swallowing 403) but it is dead 403 noise, and it proves that **hiding the sub-tab does not stop the mount fetch**. **Early-return fetchClinicDoctors when op=off** in addition to hiding the tab. **[C-fix]** |

**Resolved conflict:** the frontend pass labeled `ManageBillableProducts` and `BillableProduct` "Ambiguous" (speculating OP consultation packages). The schema pass is authoritative: `BillableProduct.workflowMode` uses `DiagnosticWorkflowMode` and all panel FKs are ClinicalPanel — **it is Diagnostics today.** Recorded as a *future* seam only (if OP ever needs packaged consult products). Do not gate it on OP now.

**Superset assumption (load-bearing):** the "no schema surgery" verdict AND both `doctors.ts /search-by-contact` and `patientService`'s unconditional `clinicVisit` include depend on ClinicVisit/ClinicDoctor tables being **physically present** in every per-tenant clone even when op=off. If a future deployment ever drops those tables per-tenant, both become hard errors and both need guarding. The draft acknowledged this only for doctors.ts; it applies to patientService too. **[C-fix]**

---

## 3. OP=off verdict — is it a clean boundary?

**Verdict: MOSTLY-CLEAN, with one BLOCKER that the draft under-specified.** Data-model boundary is genuinely clean — ClinicVisit/ClinicDoctor are separate tables hanging off Visit via an **optional 1:1**, and **no Diagnostics code path ever reads ClinicVisit** (verified: billFinancialService references clinic only in a comment line 72; diagnosticWorkflowService/diagnosticVisits have zero clinic reads). Turning OP off requires **zero schema surgery** in a DB-per-tenant superset clone. The coupling is in **two presentation layers** (owner aggregations + nav), **one Core-landing-page fetch that hard-throws**, and one dangerous naming wart.

**What breaks, by severity:**

| # | Location | Sev | Problem | Fix |
|---|---|---|---|---|
| 0 | Dashboard.tsx (`/`, every staff user) clinic fetch throw (68–85) | **BLOCKER** | Once `/api/visits/clinic` 403s, `!clinicRes.ok` fires the throw and the **entire Core home** renders the "Couldn't load this branch's data" card — incl. the diagnostics card. The draft's "conditionally renders ClinicVisitSummary" addressed the OP cards but **not** the fetch coupling, the actual break. | **Ship frontend TOLERATE before/with the backend guard:** skip the clinic fetch (default `[]`) when op=off, or only throw on `diagnosticRes` failure. Then hide the three OP cards (195–253). Ordering is mandatory (§7 3a). **[C-fix]** |
| 1a | Patient360 + GlobalPatientSearch under `pages/clinic/`, `/clinic/patient-search` + `/clinic/patient-360/:patientId` | **HIGH** | A naive "hide everything /clinic" toggle deletes the **Core** patient hub every tenant needs — **both** the search route and the `:patientId` detail route. | **Do first:** relocate BOTH to `pages/patients/` + `/patients/search` + `/patients/:patientId`; keep always-on; HIDE only the CLINIC domain-filter option. **[C-fix: name both routes]** |
| 1b | GPS `register()` → `/clinic/new`; deep-links openPatient (65) / openVisit (68) / goBack (72) → `/clinic/*`; both pages `AppLayout context="clinic"` | **HIGH** | A file move + one redirect does NOT make these namespace-clean: the register CTA dead-ends into an OP-gated page, and every internal link bounces through the OP-gated `/clinic/*`. The pages also inherit OP nav/theming via `context="clinic"`. | On relocation, rewrite **all** nav strings to `/patients/*`, make register() flag-aware (`/diagnostics/new` when op=off), and give the pages a new non-'clinic' `AppLayout` context (e.g. `'patients'`) so they don't inherit OP-gated nav. **[C-fix]** |
| 2 | Sidebar.tsx (staff 'Clinic' ~171-179; owner 'Workflows' sub-items + matchPrefixes ~80-115) | **HIGH** | Clinic nav hardcoded; owner 'Workflows' fuses clinic+diagnostics and its landing href points at /clinic/patient-search. | Make NavItems + subItems flag-aware (filter clinic items when op=off); repoint Workflows landing href to the relocated `/patients`. |
| 3 | ownerOperationsService (clinic queue card + inQueueClinic bucket) | MED | Permanent empty "0" clinic card + KPI math allocates a CLINIC bucket. | Gate card + bucket behind op flag; drop CLINIC from groupBy consumers. |
| 4 | ownerMetricsService (visits groupBy → clinic) | MED | Clinic volume figure always 0. | Keep aggregation (harmless), omit clinic tile from response when op off. |
| 5 | ownerMoneyService + OwnerMoneyPage/moneyDaySheet (domain filter, CLINIC row special-case) | MED | Dead CLINIC filter chip + unreachable CLINIC row branch still shipped. | HIDE CLINIC segment from domain toggle; server already returns zero — UI gating only. |
| 6 | ownerDoctorsService (referral+clinic commission blend) | MED | Clinic doctor rollups always empty but section renders. | Guard clinic aggregation + CLINIC doctorType branch; drop clinic rows/section. |
| 7 | payoutService (PAYOUT_TYPES_ORDER CLINIC ~1768; derive loop) + PayoutsList | MED | Empty CLINIC bucket in Pay-Run type filter/bulk-review. | Filter CLINIC out of order array + derive loop + PayoutsList type pills. Ledger column stays. |
| 8 | bills.ts (domain=CLINIC validation + consultation-fee branch) | LOW | CLINIC path ships but unreachable (no CLINIC visits). | Leave dead-but-safe, or tighten validator to enabled-domain set. |
| 9 | moneyDaySheetExportService (CLINIC→'OP' label) | LOW | Unreachable branch ships. | No action; optionally reject domain=CLINIC export when op off. |
| 10 | ManageDoctorsAndReferrals mount fetch (395) | LOW | Dead 403 noise per mount (swallowed, not a break). | Early-return fetchClinicDoctors when op=off. **[C-fix]** |
| 11 | schema.prisma VisitDomain enum | LOW | Unused CLINIC enum member. | Keep as shared superset; do NOT fork schema. Enforce at write-time. |

**Two genuinely dangerous warts:** **#0** (Dashboard fetch — the single biggest hole, mandatory ordering) and **#1a/#1b** (Patient360/GlobalPatientSearch are Core dressed as OP). Both must be handled **before** OP is toggleable.

---

## 4. Feature registry

Legend: **E** = default for existing (Sobhana = client #0), **N** = default for new signup. Modules noted; "CrossCutting" = a coupling-seam feature that must degrade when `opClinicsModule` is off.

### Built features

| Key | Module | E | N | Key surfaces |
|---|---|---|---|---|
| `opClinicsModule` | OP | on | **off** | clinicVisits.ts, clinicDoctors.ts, ClinicVisit, ClinicDoctor, Visit.domain, ClinicNewVisit/Queue, Sidebar |
| `externalLabOutsourcing` | Diagnostics | on | **off** | externalLabs.ts, ExternalLab(+ProductRule), externalLabService, payoutService outside-lab payable, OutsideLabs.tsx |
| `diagnosticReferralCenters` | Diagnostics | on | **off** | diagnosticCenters.ts, DiagnosticReferralCenter(+ProductRule), DiagnosticCenter_Visit, ManageDiagnosticCenters.tsx |
| `referralDoctorPayouts` | CrossCutting | on | on | referralDoctors.ts, ReferralDoctor(+ProductRule), ReferralDoctor_Visit, referralPayoutService, ManageDoctorsAndReferrals |
| `doctorPayoutsPayRun` | CrossCutting | on | on | payouts.ts, DoctorPayoutLedger, DoctorPayoutRule, payoutService/Categorize/Export, PayoutsList, PayoutStatement |
| `makePatientSelfPayout` | CrossCutting | on | on | payouts.ts, payoutService, PayoutStatement (commit d3fa24d) |
| `whatsappResultDelivery` | Core (capability) | on | on | messages.ts, MessageLog, notificationService, whatsappCloudService, templates lab_report_ready/bill_receipt |
| `partialReportRelease` | Diagnostics | on | on | notificationService (lab_report_partial_ready), diagnosticVisits, diagnosticWorkflowService |
| `reportQrBillGateway` | Core | on | on | reportGateway.ts /r/:token, BillAccessToken, reportQrService, billAccessService, reportAccessService, ReportViewPage, **BillPrintPage** (8e7180e) |
| `filmsOnlyClose` | Diagnostics | on | on | diagnosticVisits, diagnosticWorkflowService, reportSnapshotService, TestOrder, DiagnosticReport (Jul 4) |
| `externalReportUpload` | Diagnostics | on | on | externalUploads.ts, ExternalReportUpload, mergedReportPdfService/Cache, r2StorageService |
| `signingRulesEngine` | Diagnostics | on | on | signingRules/Doctors/LabIncharges/labInchargeRules, SigningDoctor/Rule/LabIncharge, ManageSigningDoctors |
| `derivedParameters` | Diagnostics | on | on | DerivedParameter(Def), derivedParameterService, clinicalPanels, TestInputConfig |
| `ageSpecificReferenceRanges` | Diagnostics | on | on | TestAgeRange, TestDefinitionRange, referenceRangeService, TestDefinition |
| `interpretationTemplates` | Diagnostics | on | on | InterpretationTemplate, InterpretationRule, ClinicalPanel.narrativeTemplateHtml, ReportFramedNarrativeEditor |
| `branchPricingOverrides` | **Diagnostics** | on | on | ProductBranchPricing, BillableProduct, billableProducts.ts, ManageBillableProducts — **reclassified Core→Diagnostics** to resolve the ProductBranchPricing double-home (model hangs off BillableProduct) **[C-fix]** |
| `patient360History` | CrossCutting | on | on | patient360Util, patients.ts, Patient360, GlobalPatientSearch |
| `ownerAnalyticsDashboard` | CrossCutting | on | on | ownerDashboard.ts, ownerDashboardV2/Metrics/Money/Doctors/Operations services, OwnerDashboardV2, OwnerDoctorsPage, OwnerOperationsPage |
| `moneyDaySheetExport` | CrossCutting | on | on | moneyDaySheetExportService, ownerMoneyService, moneyDaySheet.ts, OwnerMoneyPage |
| `whatsappPayoutStatement` | CrossCutting | on | on | statementDownload.ts, StatementAccessToken, statementAccessService, notificationService (payout_statement) |
| `cancelRefundCorrection` | CrossCutting | on | on | OrderRefund, visitCorrectionService, billFinancialService, bills.ts, diagnosticVisits.ts |

### Not-built (roadmap-only; "build-for-one", all default off unless noted)

| Key | Module | E | N | Note |
|---|---|---|---|---|
| `ipInpatientModule` | IP | off | off | Reserved; only ClinicVisitType.IP exists |
| `analyzerInterfacing` | Diagnostics | off | off | HL7/ASTM 90-day moat; future /api/ingest; zero code |
| `homeSampleCollection` | Diagnostics | off | off | booking + phlebotomist + consent; zero code |
| `resultBasedReminders` | Diagnostics | off | off | repeat-test WA nudges; needs scheduler |
| `referringDoctorPortal` | CrossCutting | off | off | referral-doctor login |
| `patientPwaPortal` | Core | off | off | OTP gate + PWA over /r/:token |
| `marketingCampaigns` | CrossCutting | off | off | separate whatsappMarketingOptIn consent; ~7.5x template cost |
| `inventoryReagentManagement` | Diagnostics | off | off | — |
| `nablAccreditationReporting` | Diagnostics | off | off | IQC / Levey-Jennings |
| `customDomainWhiteLabel` | CrossCutting | off | off | Caddy On-Demand TLS |
| `abdmAbhaIntegration` | CrossCutting | off | off | DEFER/IGNORE per roadmap |
| `perTenantMessageQuota` | CrossCutting | off | **on** | Protective default: caps HealthFlow's shared Meta bill; **on for new signups, off for self-run Sobhana** |

---

## 5. Config shape (Control DB per tenant)

`modules{}` = big domains (gate whole route groups + write-time visit-creation). `features{}` = finer capabilities. A feature is only effective if its owning module is on; the resolver ANDs them.

```jsonc
// Tenant config record (Control DB)
{
  "tenantId": "acme-labs",
  "modules": {
    "core":        true,        // immutable, always true
    "diagnostics": true,        // effectively always-on
    "op":          false,       // the "might not need clinics" switch
    "ip":          false        // reserved
  },
  "features": {
    // Diagnostics leaf features
    "externalLabOutsourcing":    false,
    "diagnosticReferralCenters": false,
    "partialReportRelease":      true,
    "filmsOnlyClose":            true,
    "externalReportUpload":      true,
    "signingRulesEngine":        true,
    "derivedParameters":         true,
    "ageSpecificReferenceRanges":true,
    "interpretationTemplates":   true,
    "branchPricingOverrides":    true,   // Diagnostics (was mis-labelled Core)
    // Core-capability features
    "whatsappResultDelivery":    true,
    "reportQrBillGateway":       true,
    // CrossCutting (degrade when op=false)
    "referralDoctorPayouts":     true,
    "doctorPayoutsPayRun":       true,
    "makePatientSelfPayout":     true,
    "patient360History":         true,
    "ownerAnalyticsDashboard":   true,
    "moneyDaySheetExport":       true,
    "whatsappPayoutStatement":   true,
    "cancelRefundCorrection":    true,
    // platform guard
    "perTenantMessageQuota":     true    // new-signup default
  }
}
```

**Diagnostics-only new signup (lean):** `op:false, ip:false`; `externalLabOutsourcing:false, diagnosticReferralCenters:false`; everything else per the table above; `perTenantMessageQuota:true`.

**Sobhana (client #0, full, no-op gates):** `op:true, ip:false`; all built features `true`; `perTenantMessageQuota:false`. This config makes every gate a pass-through, so introducing the gating code is a behavioral no-op for Sobhana.

Resolver contract: `isOn(feature) = modules[owningModule(feature)] && features[feature]`. CrossCutting features check `modules.op` at the aggregation level (§6), not as an on/off of the whole feature.

**Flag source (mechanism — the no-op guarantee rests on this):** pre-self-host / single-tenant, `modules{}`/`features{}` is a **static module-level resolver** (`getModules()` / `getFeatures()`) that the aggregators and middleware **import directly**. This makes the gating diff add a *branch* but not a *parameter* — no signature changes, no tenant threading, so the change is literally a no-op for Sobhana (`op:true`). **Per-request tenant resolution** (Control-DB lookup → request context → threaded into the deep aggregators) is a **separate, later, multi-tenant step**, explicitly out of scope for the OP-toggle refactor. Until it exists, the aggregators read the static resolver. **[C-fix]**

---

## 6. Gating seams (enforcement)

### Backend — `requireModule()` / `requireFeature()` middleware

Mount as route-group guards in `index.ts`:

```
app.use('/api/visits/clinic',  requireModule('op'),        clinicVisitsRouter);
app.use('/api/clinic-doctors', requireModule('op'),        clinicDoctorsRouter);
app.use('/api/external-labs',  requireFeature('externalLabOutsourcing'), externalLabsRouter);
app.use('/api/external-uploads', requireFeature('externalReportUpload'), externalUploadsRouter);
app.use('/api/diagnostic-centers', requireFeature('diagnosticReferralCenters'), diagnosticCentersRouter);
// Core / Diagnostics-core / Shared-CrossCutting routes: no route guard
```

**Write-time guard (master seam):** `clinicVisits.ts` is the **sole CLINIC-visit creation path** (verified: it is the only clinic-visit route mount; `patientService`/`bills.ts` only *read* clinicVisit). Therefore `requireModule('op')` on `/api/visits/clinic` **already blocks creation** — the additional `if (domain==='CLINIC' && !modules.op) throw ModuleDisabled` inside a shared service is **optional belt-and-suspenders hardening, not required**. Do not edit shared services for it unless a back-door creation path is later introduced. **[C-fix — avoids an unnecessary shared-service edit]**

**Shared aggregators do NOT get a route guard** (they serve Core dashboards); they import the static resolver and branch:

```
// ownerOperationsService, ownerMoneyService, ownerMetricsService,
// ownerDoctorsService, ownerDashboardV2Service, payoutService, patient360Util
const { op } = getModules();
const domains = op ? ['DIAGNOSTICS','CLINIC'] : ['DIAGNOSTICS'];
// build WHERE from `domains`; omit CLINIC cards/tiles/payee-type from the response
```

Payout derive loop: `PAYOUT_TYPES_ORDER.filter(t => t !== 'CLINIC' || getModules().op)`.

### Frontend — nav + route hiding

1. **Dashboard.tsx (BLOCKER — do this in/before the same release as the backend guard):** make the `/visits/clinic` fetch conditional on the op flag (skip → `clinicVisits=[]`) or tolerate a 403 without throwing (throw only on `diagnosticRes` failure); then conditionally render the three OP cards. **[C-fix]**
2. **Sidebar.tsx** — add `modules?: ModuleKey[]` / `features?: FeatureKey[]` to each NavItem *and subItem*, filtered at render exactly like `roles` already are. Gate at the **subItem** level for the Workflows group (keep Diagnostics links, drop clinic links). Repoint the Workflows landing href off `/clinic/patient-search` to `/patients/search`.
3. **App.tsx** — wrap `/clinic/*` route declarations in a `<ModuleRoute module="op">` guard that 404s when off. Declare the `/patients/*` routes (relocated Patient360/search) **always mounted, outside the guard**. Declare the `/clinic/patient-search` → `/patients/search` **compatibility redirect OUTSIDE/ABOVE the ModuleRoute guard** (or drop it and accept a clean 404) so an op-off tenant's old bookmark still redirects instead of 404-ing. **[C-fix]**
4. **AdminConfigCenter.tsx** — add a `modules`/`features` field to the TABS array; gate the **Clinic Doctors inner sub-tab** of ManageDoctorsAndReferrals, keeping the outer Referrals tab alive. Additionally, make `fetchClinicDoctors()` **early-return when op=off** so the mount doesn't fire a dead 403. **[C-fix]**
5. **GlobalPatientSearch.tsx** — make `register()` flag-aware (`/diagnostics/new` when op=off, or hide/relabel the CTA); rewrite `openPatient`/`openVisit`/`goBack` to `/patients/*`; switch `AppLayout context` off `'clinic'`. **[C-fix]**
6. **Component-level** — OwnerMoney/Operations/Doctors/DashboardV2 hide their clinic cards; Patient360 hides the CLINIC domain-filter option (must land with the backend buildTimelineWhere CLINIC-omission).

### Seed differences

- Sobhana seed → all modules/features on except `ip`, `perTenantMessageQuota`, and the not-built roadmap flags.
- New-signup seed template → `op:false, ip:false`, `externalLabOutsourcing:false`, `diagnosticReferralCenters:false`, `perTenantMessageQuota:true`, rest of built Diagnostics/CrossCutting features on.
- `seed-tenant.ts` reads the config record and skips seeding ClinicDoctor demo rows when `op:false`. (Verified: the new-signup `seed-tenant.ts` already seeds no clinic doctors — its only "clinic" hits are clinicalPanel/clinicalPanelItem, which are Diagnostics. Sobhana's full `seed.ts` does seed clinic, but that tenant is `op:true`.)

---

## 7. Up-front refactor plan ("divide beforehand")

**Recommendation: tag-based gating, NOT a physical `src/modules/{core,diagnostics,op}` move — with ONE targeted physical relocation.**

Rationale: the import graph is deeply interwoven at the coupling seams (payoutService's single switch body, ownerDashboardV2's 10 inline clinicVisit queries, doctorService's co-located CRUD). A wholesale folder move would be a large, unreviewable diff (hundreds of relative-import rewrites across root-level `src/` frontend + `health-hub-backend/src`) and a near-certain merge conflict with the concurrent session — and it buys little, because the real gates live at *call sites and aggregation branches*, which a folder move doesn't solve. (It would not create circular imports — the resolver is a dependency-free leaf — but diff-size and merge risk alone justify rejecting it.) The lighter-touch approach: a `modules{}`/`features{}` static resolver + `requireModule/requireFeature` middleware + NavItem tags, plus **one physical move** that is genuinely load-bearing (Patient360/GlobalPatientSearch out of `/clinic`). Do the two service splits (`doctorService`; the referral-math promotion — note `referralPayoutService.ts` **already exists as a standalone file**, so this is smaller than "extract to Core" implies) opportunistically, not as a big-bang.

**Target end-state (logical, achieved by tags + gates, not folders):**
- Core + Shared/CrossCutting routes unguarded (aggregators branch internally).
- Diagnostics leaf routes behind `requireFeature`.
- OP routes behind `requireModule('op')`; Visit creation blocked by the OP route guard (write-time service guard optional).
- CrossCutting aggregators import the static resolver and branch.
- Patient360/search physically at `/patients`, with all internal links + AppLayout context de-cliniced.

**Everything defaults all-on for Sobhana → the entire change is a behavioral no-op for the existing client.**

### Steps (concrete, low-risk, each independently shippable; step 3 split for merge-safety)

1. **Introduce the flag plumbing as a pure no-op.** Add the tenant `modules{}`/`features{}` record (Control DB or, pre-self-host, a **static config module with `getModules()`/`getFeatures()` the services import directly**), the resolver `isOn()`, and `requireModule()`/`requireFeature()` middleware that **read the flags but are not yet mounted anywhere**. Seed Sobhana all-on. Ship. Zero behavior change; nothing is gated yet. This de-risks everything after it. **State explicitly:** per-request tenant resolution is a *separate later step*; step 1 ships only the static resolver, so no aggregator signatures change. **[C-fix]**

2. **Relocate Patient360 + GlobalPatientSearch to `/patients` (the dangerous wart).** Move both files from `pages/clinic/` to `pages/patients/`; add **both** `/patients/search` **and** `/patients/:patientId` routes in App.tsx as canonical; rewrite **every** internal nav string (`openPatient`, `openVisit`, `goBack`, `register`) off `/clinic/*`; give the pages a new non-`'clinic'` `AppLayout` context (e.g. `'patients'`); keep `/clinic/patient-search` → `/patients/search` as a redirect **declared outside the future ModuleRoute guard** for one release; repoint the Sidebar Workflows landing href. Confirm no other component deep-links `/clinic/patient-360/:id` before step 3b flips the guard. Still no gating — a pure relocation so step 3's OP gate can't nuke a Core page. Verify patient search/history/detail work under the new paths with op still on. **[C-fix: both routes, deep-links, context, redirect placement]**

3. **Gate the OP module end-to-end, all-on for Sobhana — split into three independently reviewable diffs** to minimize merge-conflict surface against the concurrent session (which touches payoutService + owner\*Service):

   - **3a — Backend route guards + the Dashboard fetch tolerance (ship together, ordering is mandatory).** Mount `requireModule('op')` on `/api/visits/clinic` + `/api/clinic-doctors`; **in the same release (or before), ship the Dashboard.tsx clinic-fetch TOLERATE fix** so the Core home doesn't blank. Small, self-contained, testable via a scratch `op:false` tenant. The write-time service guard is optional hardening (clinicVisits.ts is the sole creation path). **[C-fix: extracted 3a; Dashboard ordering]**
   - **3b — Frontend nav + route hiding.** Sidebar NavItem/subItem tags; `<ModuleRoute module="op">` over `/clinic/*` (redirect route declared above it); AdminConfigCenter TABS + `fetchClinicDoctors` early-return; GPS `register()` flag-awareness; Patient360 CLINIC domain-filter hide (paired with 3c's buildTimelineWhere change).
   - **3c — Aggregator branching, ideally one service per commit.** Make money/metrics/operations/doctors/dashboardV2/payoutService/patient360Util read `getModules().op` and branch the domain list / hide clinic cards / filter the CLINIC payee bucket. Each is a no-op for `op:true`.

   Test the whole by flipping a scratch tenant to `op:false` and confirming clinic nav/routes/cards vanish while diagnostics + Patient360 + payouts (minus CLINIC bucket) + the staff Dashboard stay intact.

**Rollback story:** steps 1 (pure add) and 2 (relocation + redirect) revert cleanly via `git revert`. For a bad step-3 ship, the rollback is **not** a revert — it is **force `op:true` statically** in the resolver (instant, every gate becomes a pass-through again), because defaults are on. Say this so nobody unpicks interleaved flag-reads under pressure. **[C-fix]**

**No-op verification gate (prove step 3 doesn't change Sobhana):** the `op:false` scratch-tenant test proves *gating works*, not that `op:true` is *unchanged*. Add a **golden-master diff**: snapshot the owner dashboard / payouts / money / metrics API responses with `op:true` before and after step 3 and assert byte-equality. **[C-fix]**

(Later, non-blocking: split `doctorService` into referral/clinic files; promote the already-standalone `referralPayoutService` commission math to a Core util once the CLINIC path is factored out of payoutService; gate the Diagnostics leaf features individually.)

---

## 8. Open decisions for the user

1. **Physical module folders vs tag-based gating.** This doc recommends **tag-based** (gates at call sites) plus the single Patient360 relocation, because the import graph resists a clean `src/modules/*` split and a big move risks Sobhana + concurrent-session conflicts. Do you want the lighter tag approach, or a full physical `src/modules/{core,diagnostics,op}` reorg (higher cost, cleaner long-term boundary)?

2. **Is Diagnostics ever actually toggleable, or Core-in-practice?** No tenant is a "lab without Diagnostics." We can either keep Diagnostics as a real module (symmetry, future non-lab tenants) or fold its always-on core (catalog, report engine) into Core and only keep the *leaf* Diagnostics features toggleable. Which framing do you want the config to encode?

3. **Who owns payouts/referrals — Core, Diagnostics, or CrossCutting?** Referral commission is computed per diagnostic TestOrder but the Pay-Run ledger aggregates all four payee types across domains. This doc homes payouts.ts / payoutService / **payoutCategorize** / DoctorPayoutRule in the **Shared/CrossCutting layer** (degrades when OP off, not a whole-feature switch). Confirm — or if you'd rather referrals+payouts be a hard Diagnostics-owned feature (off ⇒ no payout worklist at all), that changes the gate placement.

4. **New-feature default policy.** This doc encodes: existing (Sobhana) preserves current behavior (on), new signups lean (OP/external-lab/referral-centers off, `perTenantMessageQuota` on). Confirm the standing rule for *future* features — default new modules **off** for both, and require an explicit opt-in per deal? And confirm `perTenantMessageQuota` should default **on for new / off for Sobhana** (it protects HealthFlow's shared Meta bill, not the tenant).

5. **GPS register() target under op=off (product call, surfaced by the break trace).** When a diagnostics-only tenant's patient hub fires "register new visit," should it launch `/diagnostics/new`, or should the register CTA be hidden/relabelled entirely? The engineering fix is flag-awareness either way; the product default is yours. **[C-raised]**