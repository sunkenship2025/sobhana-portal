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

**RESOLVED (user, Jul 4):** (1) **Tag-based gating** — no physical `src/modules/*` reorg; middleware + NavItem tags + static resolver + the one Patient360 relocation. (2) **Diagnostics stays a real module** (symmetry, future non-lab tenants). (3) **Payouts/referrals = Shared/CrossCutting** — always available, degrade when OP off (drop CLINIC payee bucket); not a Diagnostics-owned switch. (4) **New features default OFF for new signups (opt-in per deal), preserve existing tenants**; `perTenantMessageQuota` on-for-new / off-for-Sobhana. → §7 refactor plan is confirmed as-is. (5) **GPS `register()` under op=off** still open (product micro-call) — default proposed: route to `/diagnostics/new` (keeps the CTA useful) unless you'd rather hide it.

---

1. **Physical module folders vs tag-based gating.** This doc recommends **tag-based** (gates at call sites) plus the single Patient360 relocation, because the import graph resists a clean `src/modules/*` split and a big move risks Sobhana + concurrent-session conflicts. Do you want the lighter tag approach, or a full physical `src/modules/{core,diagnostics,op}` reorg (higher cost, cleaner long-term boundary)?

2. **Is Diagnostics ever actually toggleable, or Core-in-practice?** No tenant is a "lab without Diagnostics." We can either keep Diagnostics as a real module (symmetry, future non-lab tenants) or fold its always-on core (catalog, report engine) into Core and only keep the *leaf* Diagnostics features toggleable. Which framing do you want the config to encode?

3. **Who owns payouts/referrals — Core, Diagnostics, or CrossCutting?** Referral commission is computed per diagnostic TestOrder but the Pay-Run ledger aggregates all four payee types across domains. This doc homes payouts.ts / payoutService / **payoutCategorize** / DoctorPayoutRule in the **Shared/CrossCutting layer** (degrades when OP off, not a whole-feature switch). Confirm — or if you'd rather referrals+payouts be a hard Diagnostics-owned feature (off ⇒ no payout worklist at all), that changes the gate placement.

4. **New-feature default policy.** This doc encodes: existing (Sobhana) preserves current behavior (on), new signups lean (OP/external-lab/referral-centers off, `perTenantMessageQuota` on). Confirm the standing rule for *future* features — default new modules **off** for both, and require an explicit opt-in per deal? And confirm `perTenantMessageQuota` should default **on for new / off for Sobhana** (it protects HealthFlow's shared Meta bill, not the tenant).

5. **GPS register() target under op=off (product call, surfaced by the break trace).** When a diagnostics-only tenant's patient hub fires "register new visit," should it launch `/diagnostics/new`, or should the register CTA be hidden/relabelled entirely? The engineering fix is flag-awareness either way; the product default is yours. **[C-raised]**

---

## Feature & Entitlement Catalog v2 (complete)

> Supersedes the first pass (`HEALTHFLOW_MODULE_TAXONOMY.md`, 33 code-capability features). That pass captured "what the app does" but missed entire entitlement *classes*: fine-grained UI/surface toggles, RBAC/role entitlements, access & security policies, commercial limits, and — this revision adds — the **statutory-billing, localization, notification-fabric, white-label-depth, interop, and subscription-lifecycle** classes a mature multi-tenant, multi-country vertical LIS (Crelio-class) must gate. The 33 already-cataloged features are **referenced, not repeated** — the one exception is `reportQrBillGateway`, which is **split** into `billQr` + `reportGateway`. Every row: `key | type | built? | default-existing | default-new | mechanism/surface | effort`.

**What this revision folds in (two-critic review):** (1) an *adversarial-completeness* pass added tax/GST, invoice numbering, per-tenant timezone, working-hours calendar, SMS/email channels + white-label email, data residency, i18n language pack, subscription lifecycle + plan tier, white-label branding depth, online payments, outbound webhooks, interop/format-level exports, self-service backup/restore, per-report metering, beta channel, and SSO/SCIM; (2) a *security-mechanism* pass reframed the `branch.ts` IDOR as a ship-now access-control bug (not a license nicety), **demoted concurrent-session-cap from PRIMARY to a secondary anti-sharing signal**, made **device-binding the PRIMARY location lever** (hard server-side count, not owner-approval, not a copyable cookie), corrected the shared-login false-positive posture to **alert-before-block / never default evict-oldest**, split login-lockout to per-account + per-IP with step-up for high-privilege accounts, moved owner/finalize 2FA to TOTP, and **dropped GPS geofence from license enforcement entirely**. Rejected/reframed points are listed at the end of the security section with a one-line reason each.

---

### 1. Modules (the 4 big domains — recap only)

| module | one-line |
|---|---|
| **Core** | Shared spine: auth, branches, billing, patients, print, WhatsApp plumbing, payouts/referrals cross-cutting layer. Always on. |
| **Diagnostics** | Real module — lab orders, result entry, signing rules, report rendering, TAT. The product's heart. |
| **OP (Outpatient)** | `opClinicsModule` — consultations, clinic prescriptions (Rx/bill print), OP billing. |
| **IP (Inpatient)** | `ipInpatientModule` (roadmap) — admissions, bed/ward, IP billing. Built Axora-ready/isolated. |

---

### 2. Capability features (finer code toggles + localization/statutory-billing config the rescan found, beyond the 33)

| key | type | built? | default-existing | default-new | mechanism / surface | effort |
|---|---|---|---|---|---|---|
| `physicalLetterheadMode` | boolean | built | on | on | `?mode=physical` on report PDF routes; `mergedReportPdfService.ts:165` sets `drawOverlay=false`; `pdfGenerationService.ts:215` picks `pdf-physical` Puppeteer profile (strips header/footer for pre-printed stationery) | S |
| `narrativeReportPanels` | boolean | built | on | on | `PanelLayoutType` enum `schema.prisma:189`; `reportRendererService.ts:623` renders rich-text HTML block instead of numeric table for `TEXT_ONLY`/`IMAGING_NARRATIVE`; `clinicalPanels.ts:45` validates item count | S |
| `narrativeSignerOverride` | boolean | built | on | on | `TestResult.signerNameOverride` `schema.prisma:829`; `reportRendererService.ts:696` uses plain name in signature block instead of resolving the SigningRule. Disabling locks all signatures to `signingRulesEngine` | S |
| `whatsappTenantKillSwitch` | boolean | partial | on | **off** | Today `process.env.WHATSAPP_ENABLED` (`whatsappCloudService.ts:26`) — one env var for the whole server; needs per-tenant boolean read at send time. Global credential-level gate (distinct from `whatsappResultDelivery`/`whatsappPayoutStatement`). New tenants off until WABA creds provisioned | M |
| `loginBruteForceThreshold` | struct | built | 12 attempts / 15 min | 12 / 15 min | `ATTEMPT_THRESHOLD`/`ATTEMPT_WINDOW_SEC`/`LOCKOUT_DURATION_SEC` hardcoded in `lib/loginLockout.ts:23-25` (Redis INCR+TTL, keyed on **email only** — see the DoS-hardening note in §5). Constant source moves to Control-DB (NABL tenants may want 5) | M |
| `currencyLocale` | struct | not-built | INR / en-IN | INR / en-IN | `formatCurrency()` `patientDisplay.ts:7`, `referralPayouts.ts:17`, `payoutFormatters.ts:21` all hardcode `en-IN` + paise÷100. Needs tenant `locale`+`currencySymbol`+`subunitDivisor` (VND has no subunit — divisor itself must be per-tenant). Cross-cutting; required for Vietnam expansion | L |
| `tenantTimezone` | struct (IANA) | not-built | Asia/Kolkata (server-global) | tenant IANA | **Exact sibling of `currencyLocale`, was missed.** `Asia/Kolkata` hardcoded in `statementDownload.ts:60`, `notificationService.ts:598`, `moneyDaySheetExportService.ts:16,28`, `billPdfService.ts:282,288`, `ownerDashboardV2Service.ts:19`; only `reportRendererService.ts:35` reads a single server-global `BUSINESS_TIME_ZONE`. Thread a per-tenant IANA tz through every `toLocaleString`, "today"/day-boundary, TAT math, cron and send-window — else TAT/dunning/purge/quiet-hours are wrong for Vietnam (ICT)/France (CET) | L |
| `taxConfig` | struct | not-built | **none** (0 GST fields) | statutory per-tenant | **Blocks the first commercial Indian tenant, not an upsell.** Grep confirms 0 `gstin/hsn/cgst/sgst/igst` refs in `schema.prisma`/`src` — the app cannot render a GST-compliant invoice. Add `gstin`, `taxRegime` (regular/composition/unregistered), `taxInclusive`, per-service HSN/SAC rate table (`cgstPct`/`sgstPct`/`igstPct`), `placeOfSupply`, `printTaxBreakdownOnBill`; resolved at bill render (`billPdfService`/`BillReceipt.tsx`) | L |
| `invoiceNumbering` | struct | partial | hardcoded `D-{BRANCH_CODE}-{SEQ}` | tenant scheme | `NumberSequence` (`schema.prisma:245`) + compiled `billNumber` format (`schema.prisma:510`, `589`); no prefix, no FY reset, no separate GST-invoice series. India requires a configurable, unbroken, FY-reset sequential series per registration. Add `{ scheme, prefix, perBranch, resetCadence: none\|financial_year\|calendar_year, padWidth, separateGstSeries }` consumed by `NumberSequence` generation | M |
| `uiReportLanguagePack` | enum (i18n) | not-built | en | en | **Was missed — `currencyLocale` formats money only, not language.** i18n resource bundles for the FE shell + report/bill templates (Vietnamese, French). FE i18n framework + externalized report template strings; required alongside Vietnam/France expansion | L |
| `businessHoursCalendar` | struct | not-built | 24×7 (no calendar) | per-branch schedule | **Absent everywhere.** Add per-branch open/close + weekly schedule + `holidayCalendar` dates (depends on `tenantTimezone`). Consumed by (a) business-hours TAT pausing so nights/holidays don't count as SLA breach, (b) appointment + home-collection scheduling, (c) message quiet-hours (no 2am WhatsApp) | M |

> `clinicRxPrintMode` (Rx/Bill/Both) is listed under UI/Surface Toggles (it is a print-surface enum, gated by `opClinicsModule`).

---

### 3. UI / surface toggles (incl. white-label branding depth)

| key | type | built? | default-existing | default-new | mechanism / surface | effort |
|---|---|---|---|---|---|---|
| `billQr` | boolean | built | on | **off** (new) | **SPLIT from `reportQrBillGateway`.** `shouldShowReportQr()` in `reportQrService.ts`; rendered on paper bill `billPdfService.ts:277` + WhatsApp bill PDF + `BillReceipt.tsx:215`. Auto-suppressed when all orders are bill-only/cancelled/films-only. Controls only the "Scan for your report" QR block on the bill | S |
| `reportGateway` | boolean | built | on | **off** (new) | **SPLIT from `reportQrBillGateway`.** Public stateless route `routes/reportGateway.ts` (`/r/:token`): 302 to finalized PDF, partial interstitial, or branded "being prepared" polling page. Disabling it while `billQr` is on would break the scan UX — toggle together. **Now paired with a mandatory `reportGatewayRateLimit` policy (§5)** | S |
| `clinicRxPrintMode` | enum (rx/bill/both) | built | both | both | `printMode` prop on `ClinicPrescriptionPrint.tsx:17-18`; becomes a per-tenant/branch default in config. Only meaningful when `opClinicsModule` on | S |
| `letterheadRenderMode` | enum (preprinted/rendered) | partial | preprinted | **rendered** | `LabProfile.letterheadMode` + `printMarginTopMm`/`printMarginBottomMm` (3 new cols). Preprinted leaves calibrated margins + no header; rendered draws full header/logo. Sobhana = 32mm/22mm calibrated → preprinted; new clients print on blank A4 → rendered (cheaper) | S |
| `branchColorTheme` | enum | partial | hardcoded per branch (CNT navy-red, IDPL teal, JGG purple, BLN light-blue) | tenant-default at onboarding | `getBranchTheme()`/`getBranchCSSVars()` in `branchTheme.ts` inject CSS vars — but the colour map is a compiled `Record<string,BranchTheme>`, not DB. To complete: add `sidebarBg`/`accent`/`bannerBg` to Branch (or a `TenantBranding` table) feeding the existing injection | M |
| `customLogoUpload` | boolean | not-built | on (Sobhana logo compiled) | **off** | Uploaded logo → `TenantBranding` table feeding report/bill PDF header + sidebar; replaces the per-branch compiled asset. Backs the same injection point as `branchColorTheme` | M |
| `customFavicon` | boolean | not-built | on | **off** | Per-tenant favicon served by the FE shell | S |
| `customReportFooter` | string | not-built | Sobhana footer | tenant/blank | Configurable report/bill footer block (address/accreditation line) rendered by the PDF footer renderer | S |
| `poweredByBadgeRemoval` | boolean | not-built | on (removed) | **off** | **The classic white-label upsell lever** the ₹999 "HealthFlow" go-to-market implicitly sells: a "Powered by HealthFlow" badge on report/bill/portal, removable on the paid white-label tier. Sobhana (founding white-label) = removed | S |
| `pdfWatermark` | enum | not-built | off | off | Optional `DRAFT`/branded watermark on report/bill PDFs; per-tenant text + opacity via the PDF renderer | S |

> `physicalLetterheadMode` (capability, §2) and `letterheadRenderMode` (this table) are related but distinct: the former is the runtime `?mode=physical` PDF profile switch that already exists; the latter is the per-tenant *default* + margin config that decides which mode a tenant lands in. Both are kept because Sobhana runs both modes live.

---

### 4. RBAC / role entitlements

| key | type | built? | default-existing | default-new | mechanism / surface | effort |
|---|---|---|---|---|---|---|
| `labInchargeRoleEnabled` | boolean | built | true | true | Gate `ASSIGNABLE_ROLES` in `users.ts` (remove `lab_incharge`) + collapse finalize/release-partial `requireRole` in `diagnosticVisits.ts:4905,5194` to owner-only. On flag-write, downgrade existing `lab_incharge` accounts to `staff`. Disabling implicitly forces `nonOwnerFinalizeAllowed=false` | M |
| `nonOwnerFinalizeAllowed` | boolean | built | true | true | Same two `requireRole('owner','lab_incharge')` calls (`diagnosticVisits.ts:4905,5194`); when off, allowed set collapses to `('owner')` while `lab_incharge` keeps data-entry rights everywhere else. Dependent on `labInchargeRoleEnabled`. (This is `labInchargeCanFinalize` from the rescan — same entitlement.) | S |
| `salesRoleEnabled` | boolean | built | true | **false** | Gate `ASSIGNABLE_ROLES` in `users.ts` (remove `sales`). Sales portal is deliberately minimal (referral + payout nav only, no WhatsApp send — `PayoutStatement.tsx:88`, `Sidebar.tsx:199`). Role stays in the DB enum; gate is whether the owner can assign it. Sub-25-seat centres manage referrals themselves | M |
| `ownerSelfManagesUsers` | boolean | partial/not-built | on* | on | `/api/users` router already `requireRole('owner')`; add a feature-flag check → 403 `FEATURE_DISABLED` when off. **New build needed:** `POST /api/users` (owner-gated create w/ hashed pw scoped to tenant) + deactivate endpoint + Create/Deactivate in `ManageRoles.tsx`. Today register is `admin`-gated (`auth.ts:152`) so owners can't seed staff — not scalable for 25 tenants. `admin` becomes platform-superadmin only | L |
| `vendorSuperAccountEnabled` | boolean | not-built | true | true | Dormant `super` role in `UserRole` enum; not in FE type/middleware. Build: vendor-side JWT `role='super'` + tenant claim; `authMiddleware` recognises it and bypasses tenant isolation for support. Flag honours/denies the bypass per tenant; audit every super action with a distinct `actionType`. **The grant must be a short-TTL, owner-consented, self-revoking break-glass — see `vendorBreakGlassExpiry` (§5); a permanent bypass is the wrong default even when audited.** The only entitlement true for both defaults — vendor can't support a tenant they can't reach; turning off requires the owner's written, logged consent | L |

*`ownerSelfManagesUsers` default-existing resolved to **on** — Sobhana's owner already self-manages; the "off" only applies to enterprise/regulated tenants who opt into vendor-only provisioning.

**Notes grounded in the code audit:** `UserRole` has 6 values (`staff, doctor, owner, admin, lab_incharge, sales`) but the FE exposes only 4 active — `doctor`/`admin` are legacy/dormant and need no entitlement. `owner` is structurally immutable (`users.ts` hard-blocks reassigning it) so no `ownerRoleEnabled` toggle. The finalize gate is the *only* place `lab_incharge` outranks `staff`. Enterprise identity (`ssoProvisioning`, SAML/OIDC/SCIM) is cataloged under §5 as an access policy, parked for a future enterprise tier (not relevant to the sub-25-seat segment).

---

### 5. Access & security policies

| key | type | built? | default-existing | default-new | mechanism / surface | effort |
|---|---|---|---|---|---|---|
| `loginLockoutRateLimit` | boolean | **built** | on | on | `middleware/rateLimit.ts` (Redis per-IP 5/min + per-credential) + `lib/loginLockout.ts` (rolling 15-min/12-attempt, 423, fail-open). **Hardening required (see note below):** lockout is keyed on **email only** (`loginLockout.ts:27-28`) → targeted account-lockout DoS; and it **fails open on Redis outage**. Thresholds still to be exposed per-tenant (`loginBruteForceThreshold`, §2) | S |
| `branchLocationPinning` → **rename `branchAccessAllowlist`** | boolean | partial | off→**on** (fix) | on | **ACTIVE IDOR / broken object-level authz — ship now as a standalone access-control fix, not a SaaS-rollout nicety.** `middleware/branch.ts:76-97`: any authenticated user can set `X-Branch-Id` to *any* active branch; `prisma.branch.findUnique({where:{id}})` checks only exists+isActive — **no per-user allow-list AND no tenant scoping**, so a staffer scoped to branch A can read/write branch B's patients, reports and money by changing one header. Fix: add a `UserBranch` allow-list join and validate the header against it; in the shared-DB path also scope the branch lookup by `tenantId`; 403 on any non-granted branch (owner gets all branches in-tenant, never cross-tenant). Also underpins the license model | M |
| `reportGatewayRateLimit` | struct | not-built (gap) | none | on | **Largest unauthenticated PII surface.** Public `/r/:token` (`routes/reportGateway.ts`) has no throttle → token-enumeration risk. Add per-IP + per-tenant sliding window (reuse `rateLimit.ts`), require high-entropy opaque tokens, and return a generic 404 on miss (no enumeration oracle). Ships with `reportGateway` | M |
| `sessionTimeout` | struct | partial | 1d absolute, no idle | per-tenant | JWT `expiresIn '1d'` (`authService.ts:188`) + 24h cookie (`auth.ts:19`), no idle timeout. Absolute-lifetime knob is trivial; any idle timeout must be **activity-based, not wall-clock**, and set well above a realistic front-desk gap (reception constantly steps away for samples) or it manufactures mid-workflow logouts. Idle needs the session registry → sequence after `concurrentSessionCap` | S |
| `csrfSameSitePolicy` | enum | partial | 24h httpOnly cookie, no CSRF token | SameSite + token | Auth is a cookie but no CSRF defense on mutating routes. Set `SameSite=Lax/Strict` on the auth cookie + a synchronizer/double-submit token on state-changing POST/PATCH/DELETE | S |
| `auditLogVisibility` | boolean | partial | on | on | `AuditLog` model (`schema.prisma:943`) + `/api/audit-logs` exist; add per-tenant flag + owner in-app view/export gate | S |
| `auditLogIntegrity` | boolean | not-built | off | **on** | "Keep forever" is decided but nothing stops an owner or super account from editing/deleting audit rows. Make `AuditLog` append-only (DB revoke UPDATE/DELETE + hash-chain each row to `prevHash`) so tampering is detectable. Pairs with `vendorSuperAccountEnabled` and DPDP/NABL evidentiary needs | M |
| `piiAccessAuditLog` | boolean | not-built | off | **on** | `AuditLog` records **mutations only**; there is no "who viewed which patient/report" access log — DPDP/NABL reviewers expect one. Log read access to report/patient PII with actor/time/subject (append-only via `auditLogIntegrity`) | M |
| `passwordPolicy` | enum | not-built | off | off | bcrypt exists but no complexity/length/rotation. Per-tenant policy validated in set/change-password path; optional `passwordChangedAt` column | S |
| `twoFactorAuth` | enum (off/otp-whatsapp/otp-email/totp) | not-built | off | off | Second factor verified before the JWT cookie is set. **For owner/finalize use TOTP** (otplib, secret on `User`) — WhatsApp-OTP is deliverability-dependent (Meta OTP-template throttling, WABA limits) and SIM-swap/phishable, i.e. the weakest option precisely where you want the strongest. Reserve WhatsApp/email-OTP for low-friction patient-facing gating (`patientOtpGate`) | L |
| `vendorBreakGlassExpiry` | number (min) | not-built | never-expires | 60 min | Amends `vendorSuperAccountEnabled` (§4): the super grant is audited but never expires. Make it a short-TTL, owner-consented, self-revoking break-glass token (auto-revoke at expiry); enterprise-standard for cross-tenant support access | M |
| `dataExportPermission` | boolean | not-built | on | off | Master security gate on bulk/raw exports (day-sheet, patient list, result dumps) — `moneyDaySheetExport` ships bulk export with no gate today. Format-level narrowing is `exportFormatsAllowed`; interop formats are §7. Relevant to white-label data-ownership + downgrade enforcement | S |
| `exportFormatsAllowed` | list | not-built | all | csv (base) | Refines `dataExportPermission` with a format allow-list (CSV/XLSX/JSON). Base tier = CSV only; XLSX/JSON on higher tiers; HL7/FHIR/accounting are separate roadmap features (§7) | S |
| `notificationChannelPriority` | list | not-built | [whatsapp] | ordered fallback | Per-tenant ordered delivery fallback `[whatsapp, sms, email]` consumed by `notificationService`; when a WhatsApp send fails (template reject / 24h-window), fall through to the next **enabled** channel. Removes today's silent single-point-of-failure. Depends on `smsChannelEnabled`/`emailNotificationsEnabled` (§7) | S |
| `dataResidencyRegion` | enum (in/vn/eu) + `crossBorderTransferAllowed` bool | not-built | in | tenant region | DB-per-tenant on one Hetzner box gives physical residency *by accident*; declare it explicitly for DPA/DPDP and to constrain the backup/restic target region + a future EU-tenant route. Material given Vietnam(VND)+France. (Field-level PII encryption-at-rest is **not** a per-tenant toggle — see rejection note; full-disk LUKS + DB-per-tenant covers at-rest platform-wide) | M |
| `mobileAccessEnabled` | boolean | not-built | on | **off** | Login-time client-type detection (UA/`X-Client` + PWA flag) stamped as a JWT claim; `authMiddleware` rejects mobile-origin tokens when off. Gate the mobile FE build behind a signed origin (UA is spoofable). Pairs with `patientPwaPortal`/`referringDoctorPortal` | M |
| `ipAllowlist` | list (CIDR) | not-built | none | none (opt-in) | Middleware after auth: resolve tenant+branch, compare `req.ip` (set `trust proxy` for Render/Caddy XFF) against stored per-branch CIDR list → 403 on miss. **Opt-in only** for clinics with a genuine static IP (high false-positive on dynamic PPPoE/CGNAT/4G; VPN-defeatable — see location subsection) | M |
| `concurrentSessionCap` | struct | not-built | unlimited | plan-sized, **alert-mode** | Add `jti` to each token; register in a Redis set keyed by userId/tenant (cookie TTL); `authMiddleware` checks `jti` still a member. **Anti-credential-sharing signal, NOT a location control (demoted — see subsection).** Default `onExceed:alert` (soft signal to owner + HealthFlow admin); **never default `evictOldest` — that logs staff out mid-signing; explicit opt-in only.** Also unlocks forced-logout | L |
| `deviceBinding` (`deviceCap`) | struct | not-built | unlimited | plan seats, **hard ceiling** | **PRIMARY location lever.** First login issues a signed httpOnly device-id cookie; the **hard numeric cap lives server-side in the registry, not in owner approval and not in the cookie** (the cookie is only an identifier — a copyable bearer token). Enforce the count at the registry; detect the same device-id arriving from disjoint networks simultaneously (cookie-clone signal). Owner-approval is *not* a control against the owner (the license adversary IS the owner). IP-independent → best fit for dynamic-IP clinics | L |
| `forcedLogoutRevocation` | boolean | not-built | off | off | Stateless JWTs can't be revoked mid-life; `isActive` only bites next request. True revocation needs the `jti` registry (shared with `concurrentSessionCap`): delete `jti`(s) from Redis to kill sessions immediately. Bundle with session cap | L |
| `loginGeoAnomalyAlert` | boolean | not-built | off | off | Geo-IP each login (MaxMind/ipinfo), store last city/coords/time; impossible-travel/new-city → **soft alert** to owner + HealthFlow admin via `MessageLog`. **BACKSTOP — detection, not a block.** Weak vs same-city sharing | M |
| `apiKeyRotationPolicy` | struct | not-built | n/a | on (when `apiAccessEnabled`) | `apiAccessEnabled` (§6) gates key *existence*; this governs `{ maxAgeDays, autoExpire, allowedScopes[] }` — forced rotation + least-scope on issued keys | S |
| `ssoProvisioning` | struct | not-built | off | off | SAML/OIDC federation + SCIM provisioning `{ samlEnabled, idpMetadataUrl, scimProvisioning }` for a future enterprise tier. **Parked** — not relevant to the sub-25-seat segment; listed for catalog completeness | L |
| `gpsGeofence` | boolean | not-built | off | off | Mobile PWA sends `navigator.geolocation`; backend checks distance to branch coords. **Dropped from license enforcement (see rejection note).** Position only as an optional mobile home-collection convenience — never a location control | XL |

**Login-lockout DoS hardening (grounded):** `loginLockout.ts:27-28` keys the counter/lock on **email only** — 12 deliberate bad logins lock the owner (who holds finalize authority) out for 15 min, repeatably, potentially stalling clinical report release. Combine per-account with per-IP logic so one hostile IP can't lock a victim; for high-privilege accounts (owner/finalize) prefer a **CAPTCHA/step-up challenge over a hard 423**. Add a short circuit-breaker on the fail-open path (alert + tighten cookie/IP checks) so a forced Redis outage doesn't silently disable brute-force protection.

---

### 6. Commercial limits, quotas & subscription lifecycle

| key | type | built? | default-existing | default-new | mechanism / surface | effort |
|---|---|---|---|---|---|---|
| `subscriptionLifecycle` | struct (top-level) | not-built | { legacy plan, founding, active } | plan template | **The backbone every entitlement hangs from — was missing.** Top-level `{ planId, planTier, accountStatus: trial\|active\|past_due\|grace\|suspended\|cancelled, activationDate, trialEndsAt, gracePeriodDays, readOnlyMode }`. Entitlement templates key off `planId`; the dunning cron sets `accountStatus`; `authMiddleware` forces read-only when `suspended`. `trialDurationDays` (below) feeds `trialEndsAt` | M |
| `maxBranches` | number | not-built | unlimited | **1** | `POST /branches` reads limit, `COUNT` active branches, HTTP 402 if ≥ limit. Active-only; archived don't count. Multi-branch is a natural upsell | S |
| `maxUsers` | number | not-built | unlimited | **5** | `POST` user/invite counts active users vs limit → 402; owner reserved (doesn't count). Per-role sublimits deferred | S |
| `maxSigningDoctors` | number | not-built | unlimited | **2** | `POST /signing-doctors` counts active vs limit → 402; soft-delete frees a slot. Lab-size proxy / upsell signal | S |
| `maxReportsPerMonth` | number | not-built | unlimited (-1) | plan-sized | **Core billed-unit meter — the natural per-report LIS pricing dimension, was absent.** `INCR reportcount:{tenant}:{yyyymm}` (TTL=month-end) on finalize; block/soft-alert at cap, alert at 80%. Same pattern as `msgMonthlyLimit`; the lever to enforce/upsell on actual throughput | S |
| `msgMonthlyLimit` | number | partial | unlimited (-1) | **500** | INCR `msgcount:{tenant}:{yyyymm}` (TTL=month-end) before send in `whatsappCloudService.ts`; block + alert at cap; alert at 80%. Numeric companion to the cataloged `perTenantMessageQuota` toggle. HealthFlow pays the Meta bill → cost protection | S |
| `msgBurstRatePerMin` | number | not-built | unlimited | **10** | Redis sliding window/min (same pattern as `rateLimit.ts`), alongside `msgMonthlyLimit`; soft-delay (queue next window) not hard drop. Safety valve vs a runaway automation burning the monthly quota | S |
| `pdfConcurrencySlots` | number | partial | 2 | **1** | `pdfGenerationService.ts:17-25` has a global `PDF_MAX_CONCURRENT` pool; add per-tenant slicing via `pdf:active:{tenant}` Redis hash — queue (don't reject) beyond the tenant slot; global pool stays the outer bound. Prevents one tenant monopolizing Chromium during batch finalization | M |
| `storageGbLimit` | number | not-built | unlimited | **10** | On PDF-gen + external upload, check tenant running total (Control-DB, inc/dec on write/delete) → 402 before writing; nightly reconcile cron catches drift. No object-storage layer today (greenfield). Must be generous — Neon's 0.5 GB cap was a documented rejection reason | L |
| `reportRetentionDays` | number | not-built | unlimited (no purge) | **730** | Nightly cron purges report files older than N days (soft-tombstone → hard-delete after grace day), decrements storage total, skips active/disputed orders. 0 = no purge. 2yr is below the medico-legal floor — document in the DPA | M |
| `backupRetentionDays` | number | not-built | 30 | 30 | Nightly per-tenant `pg_dump` → B2 (SELFHOST_PLAN §6) passes value to restic `--keep-within`/rclone lifecycle. Hetzner 7-slot VM snapshot is independent. Extended history (90d) = premium upsell | S |
| `selfServiceBackupExport` | boolean | not-built | off | off (premium) | Owner-triggered **encrypted** `pg_dump`/report-bundle download — data-ownership expectation for white-label tenants. Distinct from `backupRetentionDays` (retention only) | M |
| `selfServiceRestore` / `pointInTimeRestoreDays` | number | not-built | 0 | 0 (premium) | Owner-facing restore / PITR window as a premium gate; off = vendor-assisted restore only | L |
| `customDomainEnabled` | boolean | not-built | false | false | Caddy On-Demand TLS ask-endpoint (`GET /internal/caddy/ask?domain=X`) checks Control-DB → 200 issues cert, 403 refuses (prevents LE rate-limit exhaustion). The per-tenant boolean the ask-endpoint reads; complements the cataloged `customDomainWhiteLabel`. Sobhana uses a healthflow.in subdomain → false | M |
| `apiAccessEnabled` | boolean | not-built | false | false | Tenant may generate long-lived scoped API keys (governed by `apiKeyRotationPolicy`, §5); key middleware checks `tenantId` + flag; `POST /api-keys` → 402 when off. No public API today. Entitlement for the analyzer add-on tier (on-prem HealthFlow Agent needs a static key) | M |
| `supportTier` | enum (standard/priority) | not-built | priority | standard | Read-only routing flag in Control-DB; no app enforcement — Retool/Crisp intake reads it. `standard`=public 1-business-day SLA; `priority`=accelerated (Sobhana=founding). Upsell lever | S |
| `trialDurationDays` | number | not-built | 0 (Sobhana = founding, not on trial) | **14** | Control-DB `trial_ends_at = activation_date + N`; feeds `subscriptionLifecycle.trialEndsAt`; dunning/auto-suspend cron compares `NOW()`; payment failures suppressed during trial; at expiry w/o payment → D-3 reminder → D+0 → `accountStatus:suspended`. Clock starts at go-live, not signup. Extendable per pilot | S |

> **Audit-log retention** is intentionally excluded from `limits{}` — resolved "keep forever" (medico-legal, DPDP-erasure-exempt); a design constant, enforced append-only via `auditLogIntegrity` (§5), not a per-tenant limit. All rows depend on the Control-DB tenants registry (Phase A).

---

### 7. Roadmap features / modules & notification-fabric channels (net-new)

| key | type | built? | default-existing | default-new | mechanism / surface | effort |
|---|---|---|---|---|---|---|
| `smsChannelEnabled` | boolean + provider/DLT | not-built | off | off | `notificationService.ts:3` already advertises "WhatsApp + SMS fallback" but **nothing gates SMS and there is no provider/DLT-template config** — so a WhatsApp template-rejection/24h-window failure silently drops report/bill delivery with no fallback. Add SMS provider creds + DLT template ids; consumed as a fallback channel per `notificationChannelPriority` (§5) | M |
| `emailNotificationsEnabled` | boolean | not-built | off | off | No email delivery path exists despite `twoFactorAuth: otp-email` presupposing one. Gate report/bill/statement/OTP email delivery; per-tenant SMTP/provider config | M |
| `emailSenderDomain` | struct (SPF/DKIM) | not-built | off | off | **Email equivalent of `wabaBrandedSender`** (which covers WhatsApp only): branded from-domain + SMTP + SPF/DKIM so mail sends as the tenant's brand. Depends on `emailNotificationsEnabled` | M |
| `onlinePaymentsEnabled` | boolean + gatewayConfig | not-built | off | off | `billQr`/`reportGateway` deliver reports but nothing gates taking patient payment online. Add Razorpay/UPI/Stripe `{ provider, keys, perBranch }`; per-transaction-cost toggle. Low priority for the segment | M |
| `outboundWebhooks` | struct | not-built | off | off | `routes/webhooks.ts` is inbound Meta-delivery-receipts only; `apiAccessEnabled` is pull, not push. Add a per-tenant endpoint/secret registry + event allow-list (`order.created`, `report.finalized`, `payment.received`); delivery-worker gated on the flag. Enables HIS/ERP integration | M |
| `hl7FhirExport` | boolean | not-built | off | off | Healthcare interop export (HL7 v2 / FHIR / ABDM-format) for the analyzer/interop tier; net-new, no exporter today. Master-gated by `dataExportPermission` (§5) | L |
| `accountingExport` | boolean | not-built | off | off | Tally/accounting-format export of billing/day-sheet data; net-new | M |
| `scheduledExports` | boolean | not-built | off | off | Cron-scheduled recurring export (day-sheet/patient list) delivered by email/webhook; depends on the channel + `dataExportPermission` | M |
| `betaFeaturesOptIn` | boolean | not-built | on (Sobhana = founding gets previews) | off | Per-tenant early-access channel; feature templates can branch on it to expose preview builds. Low priority; listed for completeness | S |
| `mobileStaffPwa` | boolean | not-built | false | false | PWA manifest + service worker; `useMobileLayout.ts` gates mobile nav/views. Distinct from `patientPwaPortal`. Targets reception on tablets, phlebotomists on phones. Roadmap bans *native* apps; PWA shell is viable solo-founder work | M |
| `gpsPhlebotomistTracking` | boolean | not-built | false | false | Phlebotomist PWA pushes pings to `/api/home-collection/location`; dispatcher live map; new `LocationPing` model. Sub-feature of `homeSampleCollection` but first-class (real-time infra cost) | L |
| `homeCollectionRouteOptimization` | boolean | not-built | false | false | Gates a route-opt API (Dista/Locus/Google Route Optimization); off = manual drag-order. Roadmap: "integrate routing, don't build a VRP solver." Upsell for 5+ collections/day | M |
| `digitalConsentCapture` | boolean | not-built | false | false | Tap-to-sign configurable consent template at registration/collection; `ConsentLog` w/ timestamp+IP+device. Distinct from `dpdpConsentManagement` (backend log/erasure) | M |
| `dpdpConsentManagement` | boolean | not-built | false | false | (1) separate `Patient.whatsappMarketingOptIn` (Act bans bundled purposes); (2) `ConsentLog` w/ actor/purpose; (3) right-to-erasure workflow scrubbing live PII (audit logs exempt). DPDP enforcement ~May 2027. **Compliance prerequisite, not upsell** — ship before first commercial tenant | M |
| `patientOtpGate` | boolean | not-built | false | false | `/r/:token` redirects to OTP entry before serving report; OTP to registered phone via WhatsApp/SMS; token+OTP validated w/ short TTL. Roadmap's compliant delivery path. **WhatsApp-OTP is fine here** (patient-facing, low-friction) — but not for owner/finalize (§5 `twoFactorAuth`) | S |
| `wabaBrandedSender` | boolean | partial | true | **false** | Control-DB stores `wa_phone_number_id`/`wa_access_token`/`wa_app_secret`/`wa_verify_token` per tenant; `whatsappCloudService.ts` selects creds by `tenantId`; off = no WhatsApp (WABA is per-business under Meta ToS, no shared fallback). New tenants need own WABA + template approval (3-5 days, start at signing). Sobhana has its own WABA → true | M |
| `crossBranchConsolidatedAnalytics` | boolean | partial | true | false | Extends `ownerDashboardV2Service` to aggregate revenue/visits/TAT/top-tests/top-referrers across ALL branches (tenant-prefixed cache) + "All Branches" selector. Cataloged `ownerAnalyticsDashboard` is per-branch. Upsell for 2+ branch chains | M |
| `panicValueCriticalAlerts` | boolean | not-built | false | false | On `CRITICAL_HIGH`/`CRITICAL_LOW` flag (`criticalMin`/`criticalMax` on TestDefinition), immediate in-app + optional WhatsApp to signing doctor + branch head. **SELFHOST §20 flagged panic values as invisible/un-alerted in prod** — the `computeFlag` fix (`reportRendererService.ts:184-190`) ships unconditionally as a bug fix; this toggle gates the *alert delivery*. NABL/ISO 15189 requires panic-value notification | M |

> Already covered by the 33 and NOT re-cataloged: `analyzerInterfacing`, `homeSampleCollection`, `resultBasedReminders`, `referringDoctorPortal`, `patientPwaPortal`, `marketingCampaigns`, `inventoryReagentManagement`, `nablAccreditationReporting`, `customDomainWhiteLabel`, `abdmAbhaIntegration`, `perTenantMessageQuota`, `ipInpatientModule`.

---

### Location / one-branch-one-location enforcement (revised: device-binding-first)

**Short answer: No — IP allowlisting is NOT the right primary lever for this segment, and neither is a concurrent-session cap.** Small Indian clinics run dynamic residential PPPoE and CGNAT-shared 4G, so IP allowlisting locks out legit staff, is desktop-only, and is trivially defeated with a cheap VPN to the allowed IP. And a **session cap counts sessions, not locations**: a cost-motivated operator runs a second site entirely within a seat-sized cap (cap=3 → two seats at site A + one at site B never trips), so it is close to security-theater *as a location control* — its real value is anti-credential-sharing. Lead with the thing you are actually licensing: **a physical, always-on desktop per site → trusted-device binding.**

| mechanism | robustness (as location control) | false-positive risk | works on | bypass | effort |
|---|---|---|---|---|---|
| **Device binding** (hard server-side device count = plan seats; cookie is only an identifier) — **PRIMARY** | strong | low | desktop + mobile | clone the device cookie → mitigated by enforcing the count at the registry + detecting one device-id on disjoint networks; re-register → blocked by the hard cap (owner approval is *not* the boundary) | L |
| **Concurrent-session cap** (Redis `jti` registry) — **SECONDARY / anti-credential-sharing signal, not a location control** | weak (as location) | medium (evict-oldest logs staff out) | desktop + mobile | run a second site within a seat-sized cap | L |
| **Login geo-IP / impossible-travel ALERT** — **BACKSTOP (detect, don't block)** | medium | low | desktop + mobile | three clinics in the *same* city never trip impossible-travel | M |
| **IP allowlist (per-branch CIDR)** — **opt-in only** | weak | high | desktop web only | cheap VPN/tunnel; dynamic-IP rotation locks out legit staff | M |
| **GPS geofence (mobile)** — **DROPPED as a control** | none (theater) | medium | mobile only | fake-GPS apps; permission-deniable; desktop "geolocation" is IP/WiFi triangulation | XL |

**Recommended layered model (decisive):**
1. **PRIMARY — trusted-device binding.** Signed httpOnly device-id cookie + a **hard numeric device count enforced server-side in the registry**, sized to plan seats. Each physical always-on clinic desktop = one bound device, so a 1-branch tenant physically can't equip a 2nd/3rd site. IP-independent → immune to the dynamic-IP problem. **The numeric cap is the boundary — not owner approval (the owner is the license adversary and will approve their own second-site devices), and not the cookie (a copyable bearer token; detect the same device-id from disjoint networks simultaneously as a clone signal).**
2. **SECONDARY — concurrent-session cap** as an **anti-credential-sharing** signal only. Default **alert-before-block** (soft signal to owner + HealthFlow admin, feeding the upsell conversation); **never default evict-oldest** — that logs staff out mid report-signing. Not marketed as one-branch enforcement.
3. **BACKSTOP — login geo-IP / impossible-travel ALERTS** to owner + HealthFlow admin. Never a block.
4. **PREREQUISITE (ship now, independent of licensing) — fix the `middleware/branch.ts:76-97` IDOR.** It is an active broken-object-level-authorization bug: validate `X-Branch-Id` against a per-user `UserBranch` allow-list AND scope the branch lookup by `tenantId`. Also add `reportGatewayRateLimit` — `/r/:token` is the largest unauthenticated PII surface and today has no throttle.

**Shared-login reality (critical for a solo founder):** small clinics routinely share ONE login across the front desk and several machines. Default **all caps generous and alert-first**, encourage per-user accounts *before* enabling any cap, and keep idle timeout activity-based (or off) on reception desks. A day-one hard 423/evict-oldest posture manufactures exactly the support load the founder cannot absorb.

Reserve **IP allowlist** and **GPS** as opt-in convenience only (GPS purely as a mobile home-collection nicety, never a license control). Device binding + the branch-IDOR fix + alert-mode session cap enforce the license on desktop and mobile at low false-positive risk — exactly what dynamic-IP clinics need.

**Rejected / reframed critic points (one line each):**
- **GPS geofence as a location/license control — REJECTED (security-theater):** desktop "geolocation" is IP/WiFi triangulation, spoofable and permission-deniable; keep only as an optional mobile home-collection convenience.
- **Concurrent-session cap as PRIMARY location lever — REJECTED:** it caps sessions, not locations; a lean operator runs a 2nd site within a seat-sized cap. Demoted to a secondary anti-credential-sharing signal.
- **IP allowlist as a mainstream control — REJECTED for this segment:** dynamic PPPoE/CGNAT/4G → high false-positive lockouts and VPN-defeatable; opt-in for genuine static IPs only.
- **Owner-approval as the device-binding control — REJECTED:** the license adversary IS the owner; the hard server-side numeric count is the boundary, not approval and not the copyable cookie.
- **WhatsApp-OTP as 2FA for owner/finalize — REJECTED:** deliverability-dependent + SIM-swap/phishable; use TOTP for owner/finalize and reserve WhatsApp-OTP for patient-facing `patientOtpGate`.
- **Per-tenant field-level PII encryption-at-rest toggle — REJECTED for this segment:** full-disk LUKS + DB-per-tenant already covers at-rest uniformly and field encryption breaks search/index for negligible marginal gain; the per-tenant knob is `dataResidencyRegion`, not field encryption.
- **SSO/SAML/SCIM — INCLUDED but PARKED:** genuinely absent, so cataloged (`ssoProvisioning`) for completeness, but deferred to a future enterprise tier — irrelevant to the sub-25-seat clinic segment.

---

### How these extend the config shape

The Control-DB tenant record gains a top-level **`lifecycle{}`** block (the backbone entitlement templates key off) plus the numeric **`limits{}`** and **`policies{}`** blocks alongside the existing `modules{}` / `features{}`. Tag-based gating is extended with `getLimit(key)`, `getPolicy(key)`, and lifecycle-aware resolution (`accountStatus:suspended` forces read-only middleware-wide).

```jsonc
{
  "tenantId": "clnt_0_sobhana",
  "brand": { "name": "Sobhana Diagnostics", "domain": "sobhana.healthflow.in" },

  "lifecycle": {
    "planId": "legacy_founding",
    "planTier": "founding",
    "accountStatus": "active",       // trial | active | past_due | grace | suspended | cancelled
    "activationDate": "2025-01-01",
    "trialEndsAt": null,             // founding client, not on trial
    "gracePeriodDays": 7,
    "readOnlyMode": false
  },

  "modules": { "core": true, "diagnostics": true, "op": true, "ip": false },

  "features": {
    // ...the existing 33 stay as-is...
    // reportQrBillGateway REMOVED — split into billQr + reportGateway:
    "billQr": true,
    "reportGateway": true,

    // capability + localization/statutory-billing (§2):
    "physicalLetterheadMode": true,
    "narrativeReportPanels": true,
    "narrativeSignerOverride": true,
    "whatsappTenantKillSwitch": true,
    "tenantTimezone": "Asia/Kolkata",
    "uiReportLanguagePack": "en",
    "taxConfig": {
      "gstin": "36XXXXXXXXXXXZX", "taxRegime": "regular", "taxInclusive": false,
      "placeOfSupply": "36-TG", "printTaxBreakdownOnBill": true,
      "rates": [ { "hsnSac": "9993", "cgstPct": 0, "sgstPct": 0, "igstPct": 0 } ] // diagnostics exempt
    },
    "invoiceNumbering": {
      "scheme": "D-{BRANCH_CODE}-{SEQ}", "prefix": "D", "perBranch": true,
      "resetCadence": "financial_year", "padWidth": 5, "separateGstSeries": false
    },
    "businessHoursCalendar": { "enabled": false }, // 24x7 legacy

    // UI / surface + white-label depth (§3):
    "clinicRxPrintMode": "both",
    "letterheadRenderMode": "preprinted",
    "branchColorTheme": "tenant-default",
    "customLogoUpload": true, "customFavicon": true,
    "customReportFooter": "…", "poweredByBadgeRemoval": true, "pdfWatermark": "off",

    // RBAC (§4):
    "labInchargeRoleEnabled": true, "nonOwnerFinalizeAllowed": true,
    "salesRoleEnabled": true, "ownerSelfManagesUsers": true,
    "vendorSuperAccountEnabled": true,

    // notification-fabric + interop + roadmap:
    "smsChannelEnabled": false, "emailNotificationsEnabled": false,
    "emailSenderDomain": null, "onlinePaymentsEnabled": false,
    "outboundWebhooks": false, "hl7FhirExport": false,
    "accountingExport": false, "scheduledExports": false, "betaFeaturesOptIn": true,
    "wabaBrandedSender": true, "crossBranchConsolidatedAnalytics": true,
    "panicValueCriticalAlerts": false
    // ...all other roadmap features: false
  },

  "limits": {
    "maxBranches": -1, "maxUsers": -1, "maxSigningDoctors": -1,
    "maxReportsPerMonth": -1,
    "msgMonthlyLimit": -1, "msgBurstRatePerMin": -1,
    "pdfConcurrencySlots": 2, "storageGbLimit": -1,
    "reportRetentionDays": 0, "backupRetentionDays": 30,
    "selfServiceBackupExport": false, "pointInTimeRestoreDays": 0,
    "trialDurationDays": 0,
    "concurrentSessionCap": { "max": -1, "onExceed": "alert", "evictOldest": false },
    "deviceCap": { "max": -1, "onExceed": "alert", "hardCeiling": true },
    "loginBruteForceThreshold": { "attempts": 12, "windowSec": 900, "lockoutSec": 900, "perIp": true },
    "customDomainEnabled": true, "apiAccessEnabled": false, "supportTier": "priority"
  },

  "policies": {
    "branchAccessAllowlist": true,       // enforce per-user UserBranch list (was branchLocationPinning)
    "reportGatewayRateLimit": { "perIpPerMin": 20, "perTenantPerMin": 120 },
    "csrfSameSitePolicy": "lax",
    "sessionTimeout": { "absoluteSec": 86400, "idleSec": 0, "idleMode": "activity-based" },
    "mobileAccessEnabled": true,
    "ipAllowlist": [],                   // empty = disabled (opt-in)
    "twoFactorAuth": "off",              // owner/finalize → totp when on
    "passwordPolicy": { "minLen": 8, "classes": 0, "maxAgeDays": 0 },
    "loginGeoAnomalyAlert": false, "forcedLogoutRevocation": false,
    "auditLogVisibility": true, "auditLogIntegrity": true, "piiAccessAuditLog": true,
    "dataExportPermission": true, "exportFormatsAllowed": ["csv","xlsx","json"],
    "notificationChannelPriority": ["whatsapp"],
    "currencyLocale": { "locale": "en-IN", "symbol": "₹", "subunitDivisor": 100 },
    "dataResidencyRegion": "in", "crossBorderTransferAllowed": false,
    "apiKeyRotationPolicy": { "maxAgeDays": 90, "autoExpire": true, "allowedScopes": [] },
    "vendorBreakGlassExpiry": 60,        // minutes
    "ssoProvisioning": { "samlEnabled": false, "idpMetadataUrl": null, "scimProvisioning": false }
  }
}
```

**Diagnostics-only new-signup example** (small single-branch lab; everything new OFF, tighter limits, no OP/IP, no WABA until creds provisioned; **caps in alert-mode, idle timeout off on shared reception, per-account+IP lockout**):

```jsonc
{
  "tenantId": "clnt_042_newlab",
  "brand": { "name": "Sunrise Labs", "domain": "sunrise.healthflow.in" },

  "lifecycle": {
    "planId": "starter_diagnostics", "planTier": "starter", "accountStatus": "trial",
    "activationDate": "2026-07-04", "trialEndsAt": "2026-07-18",
    "gracePeriodDays": 3, "readOnlyMode": false
  },

  "modules": { "core": true, "diagnostics": true, "op": false, "ip": false },

  "features": {
    "billQr": false, "reportGateway": false,
    "physicalLetterheadMode": false, "narrativeReportPanels": false,
    "narrativeSignerOverride": false, "whatsappTenantKillSwitch": false,
    "tenantTimezone": "Asia/Kolkata", "uiReportLanguagePack": "en",
    "taxConfig": { "gstin": null, "taxRegime": "unregistered", "taxInclusive": true, "printTaxBreakdownOnBill": false, "rates": [] },
    "invoiceNumbering": { "scheme": "INV-{SEQ}", "prefix": "INV", "perBranch": false, "resetCadence": "financial_year", "padWidth": 5, "separateGstSeries": false },
    "businessHoursCalendar": { "enabled": true, "weekly": "…", "holidays": [] },
    "letterheadRenderMode": "rendered", "clinicRxPrintMode": "both",
    "branchColorTheme": "tenant-default",
    "customLogoUpload": false, "customFavicon": false,
    "customReportFooter": null, "poweredByBadgeRemoval": false, "pdfWatermark": "off",
    "labInchargeRoleEnabled": true, "nonOwnerFinalizeAllowed": true,
    "salesRoleEnabled": false, "ownerSelfManagesUsers": true,
    "vendorSuperAccountEnabled": true,
    "smsChannelEnabled": false, "emailNotificationsEnabled": false, "emailSenderDomain": null,
    "onlinePaymentsEnabled": false, "outboundWebhooks": false,
    "hl7FhirExport": false, "accountingExport": false, "scheduledExports": false,
    "betaFeaturesOptIn": false,
    "wabaBrandedSender": false, "crossBranchConsolidatedAnalytics": false,
    "panicValueCriticalAlerts": false, "dpdpConsentManagement": false
    // ...all other roadmap features: false
  },

  "limits": {
    "maxBranches": 1, "maxUsers": 5, "maxSigningDoctors": 2,
    "maxReportsPerMonth": 1500,
    "msgMonthlyLimit": 500, "msgBurstRatePerMin": 10,
    "pdfConcurrencySlots": 1, "storageGbLimit": 10,
    "reportRetentionDays": 730, "backupRetentionDays": 30,
    "selfServiceBackupExport": false, "pointInTimeRestoreDays": 0,
    "trialDurationDays": 14,
    "concurrentSessionCap": { "max": 3, "onExceed": "alert", "evictOldest": false }, // alert-first, never evict on day one
    "deviceCap": { "max": 2, "onExceed": "alert", "hardCeiling": true },             // PRIMARY location lever, server-enforced
    "loginBruteForceThreshold": { "attempts": 12, "windowSec": 900, "lockoutSec": 900, "perIp": true },
    "customDomainEnabled": false, "apiAccessEnabled": false, "supportTier": "standard"
  },

  "policies": {
    "branchAccessAllowlist": true,
    "reportGatewayRateLimit": { "perIpPerMin": 20, "perTenantPerMin": 60 },
    "csrfSameSitePolicy": "strict",
    "sessionTimeout": { "absoluteSec": 86400, "idleSec": 0, "idleMode": "activity-based" }, // idle OFF on shared reception; if enabled, activity-based
    "mobileAccessEnabled": false,
    "ipAllowlist": [],                   // opt-in only; empty for dynamic-IP clinic
    "twoFactorAuth": "off",              // owner/finalize → totp, not whatsapp-otp
    "passwordPolicy": { "minLen": 10, "classes": 2, "maxAgeDays": 0 },
    "loginGeoAnomalyAlert": true,        // soft backstop / upsell signal
    "forcedLogoutRevocation": false,
    "auditLogVisibility": true, "auditLogIntegrity": true, "piiAccessAuditLog": true,
    "dataExportPermission": false, "exportFormatsAllowed": ["csv"],
    "notificationChannelPriority": ["whatsapp"],
    "currencyLocale": { "locale": "en-IN", "symbol": "₹", "subunitDivisor": 100 },
    "dataResidencyRegion": "in", "crossBorderTransferAllowed": false,
    "apiKeyRotationPolicy": { "maxAgeDays": 90, "autoExpire": true, "allowedScopes": [] },
    "vendorBreakGlassExpiry": 60,
    "ssoProvisioning": { "samlEnabled": false, "idpMetadataUrl": null, "scimProvisioning": false }
  }
}
```

Resolution stays static and mechanical: `getModules()`/`getFeatures()` read `modules{}`/`features{}`; `getLimit(key)` returns the numeric/struct cap (`-1`/`0` = unlimited/off, checked at the enforcement point — branch/user/report create, send-gate, PDF dispatch, cron); `getPolicy(key)` returns the security/localization policy consumed by `authMiddleware`, the branch-context middleware (IDOR fix), the session-registry/device-binding middleware, the bill renderer (`taxConfig`/`invoiceNumbering`/`currencyLocale`), and `notificationService` (channel priority). A new lifecycle guard reads `lifecycle.accountStatus`: `suspended`→read-only, `grace`→banner + read-write, `cancelled`→login blocked. New signups inherit an OFF/tight/trial template keyed to `planId`; Sobhana (client #0) carries the unlimited/on legacy record, preserving current behavior.

---

## Config Center sections as feature toggles + the `visibleIf` gate (decided Jul 4)

**Decision (user Jul 4):** each admin Config Center section is a first-class **feature-list entry** — toggled in settings, which hides its editor tab (underlying data/behavior untouched; it's a declutter/operational toggle). Gating is **role-wise AND feature/module-wise** — a tab shows iff `visibleIf(roles, modules, features)` passes *both*. The Config Center already gates tabs by `roles` (`AdminConfigCenter.tsx` TABS array); we add `modules`/`features` next to `roles` and filter identically.

| Config Center tab | Feature key | Role gate | Module/feature gate |
|---|---|---|---|
| Clinical Definitions | `clinicalDefinitionsEditor` | super | diagnostics |
| Panel Definitions | `panelDefinitionsEditor` | super | diagnostics |
| Departments | `departmentsEditor` | super | diagnostics |
| Signers & Rules | `signersAndRulesEditor` | super | `signingRulesEngine` |
| Billable Products | `billableProductsEditor` | owner, staff | diagnostics |
| Referrals | `referralsEditor` | owner, staff, sales | `referralDoctorPayouts` (Clinic-Doctors sub-tab = `op`; Outside Labs = `externalLabOutsourcing`; Diagnostic Centers = `diagnosticReferralCenters`) |
| Roles | `rolesEditor` | owner | `ownerSelfManagesUsers` |

**One primitive everywhere:** `visibleIf(roles, modules, features)` drives Config Center tabs + sidebar nav items/sub-items + App routes + owner dashboard tiles + the backend `requireModule`/`requireFeature` guards + seed. Replaces today's ad-hoc scatter (roles on tabs, a separate `salesNavItems`, role checks in routes). Flip a feature off → its tab, nav item, route, and seed all follow; role still governs *who* sees it when on. For clinical tabs already super-only, the role gate does most of the hiding; the feature flag adds "off even for super when the tenant doesn't use it." The two compose — neither redundant.
