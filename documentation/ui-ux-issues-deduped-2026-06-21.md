# SOBHANA PORTAL — Deduplicated Issues (distinct problems)

This collapses the 192 raw findings (catalogued in `ui-ux-findings-register-2026-06-21.md`) into distinct, de-duplicated issues — the same root problem reported by multiple reviewers is merged into one entry.

**124 distinct issues** consolidated from 192 raw findings — 🔴 12 critical / 🟠 36 high / 🟡 48 medium / ⚪ 28 low

## Count by theme

| Theme | 🔴 | 🟠 | 🟡 | ⚪ | Total |
| --- | --: | --: | --: | --: | --: |
| Microcopy & Terminology | 1 | 8 | 9 | 7 | 25 |
| Accessibility | 3 | 6 | 6 | 1 | 16 |
| Feedback & States | 3 | 3 | 8 | 3 | 17 |
| Redundancy & Altitude | 0 | 7 | 3 | 3 | 13 |
| Forms & Operator Speed | 1 | 2 | 8 | 3 | 14 |
| Navigation & Wayfinding | 3 | 2 | 3 | 2 | 10 |
| Color System & Tokens | 0 | 3 | 3 | 2 | 8 |
| Responsive & Mobile | 0 | 3 | 3 | 2 | 8 |
| Branding | 1 | 1 | 2 | 1 | 5 |
| Other | 0 | 0 | 2 | 4 | 6 |
| Page-Header & Breadcrumb System | 0 | 1 | 1 | 0 | 2 |
| **Total** | **12** | **36** | **48** | **28** | **124** |

## Microcopy & Terminology

### 1. 🔴 Same concept called Test / Product / Item / Panel across one flow

**CRITICAL** · Microcopy & Terminology · microcopy · effort M · seen 1× (LENS: Microcopy & Terminology)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** The single concept a front-desk operator adds to a bill is referred to by four different nouns in the New Diagnostic Visit flow. The card header is `<CardTitle>Select Tests</CardTitle>` (DiagnosticsNewVisit.tsx:1654) and the validation error is `toast.error("Please select at least one test")` (line 651), but the selector that fills it has placeholder `"Type to search products (e.g., CBP, LFT, Thyroid)..."` (ProductSelector.tsx:103) and empty state `"Start typing to search and add tests, panels, or bill-only items."` (ProductSelector.tsx:438) — three nouns in one sentence. The quick-add dialog then switches to a fourth: `<DialogTitle>Quick Add Bill-Only Item</DialogTitle>` (line 2512) with button `Add Item` (line 2579) and toast `Added bill-only product ${product.name}` (line 447). The confirm dialog labels the count `Tests` (line 2454).
- **Fix:** Standardize on "test" as the patient/staff-facing umbrella noun for the diagnostics flow; keep "product"/"billable_product" confined to code, API payloads, and the owner Config Center where the catalog is managed. Concrete edits: (1) Keep DiagnosticsNewVisit.tsx:1654 "Select Tests" and :651 "Please select at least one test" and :2454 count label "Tests" — these are already correct and become the anchor. (2) ProductSelector.tsx:103 default placeholder -> "Search tests, panels or charges (e.g. CBP, LFT, Thyroid)..."; :438 empty state -> "Start typing to search and add tests, panels or charges." (collapse "bill-only items" into the single word "charges"). (3) For the quick-add path, do NOT relabel it to "test" — it specifically creates a bill-only, non-catalog line, and that distinction is operationally real. Instead make it consistent under the "charge" vocabulary: :2512 DialogTitle -> "Quick Add Charge"; :2579 button -> "Add" (loading "Adding..."); :447 toast -> `Added ${product.name}` (drop the implementation word "product" entirely). Net result: every user-facing string uses only "test", "panel", or "charge", and the word "product"/"item" never appears in staff UI.

### 2. 🟠 Sidebar nav says 'Patient 360' but the page it opens titles itself 'Global Patient Search' (wayfinding/naming break)

**HIGH** · Microcopy & Terminology · navigation · effort S · seen 2× (Clinic & Patient 360, LENS: Microcopy & Terminology)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** The sidebar nav item is `label: 'Patient 360'` for both staff and owner (Sidebar.tsx:77, 128), routing to `/clinic/patient-search`, but the landing page renders `<h1>Global Patient Search</h1>` (GlobalPatientSearch.tsx:92) and sets `subContext="Global Patient Search"`. A user clicks 'Patient 360' and lands on a page named something else — and 'Patient 360' is ALSO the name of the actual per-patient detail view (Patient360.tsx), so one label names two different screens.
- **Fix:** Pick one name per screen. If the search screen is the entry point to Patient 360, label the nav 'Patient Search' (or 'Find Patient') and title the page identically; reserve 'Patient 360' for the per-patient detail page only. Update the nav label, the h1, and the subContext string together so the breadcrumb, sidebar, and page title agree.

### 3. 🟠 Inconsistent currency/number formatting — short (₹1.2L) vs full (₹1,23,456) within a page, a duplicated formatRupees that forces '.00', and a Unicode minus inconsistent with ASCII deltas

**HIGH** · Microcopy & Terminology · consistency · effort M · seen 3× (Owner Money / Doctors / Operations, Payouts)

- **Files:** `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`, `health-hub/src/lib/payoutFormatters.ts`, `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** Money is formatted inconsistently across the owner area. Within OwnerMoneyPage the same kind of value renders differently table-to-table: 'Collected by user' uses `{ short: true }` (₹1.2L, lines 367/370) while 'Oldest unpaid' Owed (255), 'Discount log' Off (429) and Refunds (456/477) use the full form. PayoutDetail.tsx:42-44 re-declares a local `formatRupees` instead of importing the shared one (payoutFormatters.ts:6-10) — drift on the most accuracy-sensitive value — and both force `minimumFractionDigits: 2`, so whole-rupee amounts always show a noisy '.00'. ExternalFlowCard renders 'Net inflow' with a U+2212 MINUS (OwnerDoctors:318-319) while KpiCard deltas use a plain ASCII hyphen (ownerUi.tsx:261-262).
- **Fix:** Centralize on ONE `formatRupees` (delete the PayoutDetail copy and import the shared util) and one short/long policy: pick short-with-tooltip OR full-with-grouping per surface and apply it uniformly to like values. Drop forced '.00' on whole-rupee amounts (omit decimals when the value is integral). Use a single sign convention (ASCII hyphen or a shared formatter) for all deltas/net values.

### 4. 🟠 No capitalization convention — nav is Sentence case for owners but Title Case for staff, and buttons/card/dialog titles mix both with no rule

**HIGH** · Microcopy & Terminology · consistency · effort M · seen 2× (LENS: Microcopy & Terminology)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** The two nav arrays use opposite conventions for identical items: owner nav is Sentence case (`'New diagnostic visit'`, `'Pending results'`, `'Finalized reports'`, `'Live queue'`, `'OP / IP queue'`, Sidebar.tsx:74-96) while staff nav is Title Case for the same destinations. Buttons and titles are equally unruly: Title Case `Create New Patient` (DiagnosticsNewVisit.tsx:1424), `Review & Generate Bill` (2424), `View Patient 360` (GlobalPatientSearch.tsx:238) sit next to Sentence-case labels elsewhere with no governing rule.
- **Fix:** Adopt one capitalization rule app-wide (recommend Sentence case for nav items, buttons, and labels; Title Case only for proper nouns/brand) and apply it to both nav arrays, all Buttons, CardTitles, and DialogTitles. A short style note in the repo + a review checklist prevents re-drift.

### 5. 🟠 Doctor dashboard says 'finalized reports' but lists unsigned DRAFT reports with no visual distinction

**HIGH** · Microcopy & Terminology · microcopy · effort S · seen 1× (Owner & Doctor Dashboards)

- **Files:** `health-hub/src/pages/doctor/DoctorDashboard.tsx`
- **Problem:** The subtitle reads 'Which finalized reports are available for me?' (DoctorDashboard.tsx:67) and the dialog title is 'Report (Read Only)' (line 175), implying signed, final results. But the list explicitly includes DRAFT visits: `reportsWithResults = diagnosticVisits.filter(v => v.status === 'FINALIZED' || v.status === 'DRAFT')` (lines 40-42), and the comment even says 'have results'. Nothing in the row indicates a report is still a draft vs finalized — a doctor could read and act on provisional values believing they are final lab results. This is a clinical trust/safety issue.
- **Fix:** Add an unmissable per-row status badge next to the patient name (line ~130), e.g. <span className={visitView.visit.status === 'FINALIZED' ? 'status-finalized' : 'status-draft'}>{visitView.visit.status === 'FINALIZED' ? 'Final' : 'Draft'}</span> using the existing index.css utility classes (rounded px-2 py-0.5 text-xs font-medium). Also surface the same badge in the dialog header (line 175 area) — change the title to a neutral "Report" and place the Final/Draft badge beside it so the read-only viewer state is explicit. Correct the page subtitle (line 67) from "Which finalized reports are available for me?" to "Reports available to view" (or "Lab reports for my patients") since the list is not finalized-only. Do NOT silently restrict to FINALIZED unless product confirms doctors should never see drafts — preserving drafts WITH a clear badge is the safer change because hiding them may remove visibility doctors currently rely on; clarity over removal.

### 6. 🟠 Run Cycle 'Pay N pending' button does not pay — it just navigates to a list

**HIGH** · Microcopy & Terminology · microcopy · effort S · seen 1× (Payouts)

- **Files:** `health-hub/src/pages/owner/PayoutRunCycle.tsx`
- **Problem:** In the preview step the primary CTA reads `Pay {pendingCount} pending · {amount}` (PayoutRunCycle.tsx:441-443) and is even promoted to the `default` (filled) variant when there's nothing new to derive (438). But its handler is viewAlreadyDerivedInList (260-275), which only closes the sheet and navigates to the filtered list — no payment occurs. A filled, money-labeled button that performs zero financial action is a serious expectation mismatch in a payouts flow.
- **Fix:** Relabel to reflect navigation, not payment: e.g. `Review {pendingCount} pending →` and keep it `variant="outline"` even when totalCounts.will === 0 (drop the conditional `default` promotion at line 438). This also aligns it with the sibling button at line 445-449 which already uses "View N in list" for the no-pending case. Reserve "Pay…" wording for a CTA that actually opens the Mark-Paid dialog. If a true in-flow pay action is desired, that is a larger change (would need the mark-paid mutation wired in); otherwise the minimal correct fix is the relabel + variant change (effort S).

### 7. 🟠 Nav labels disagree with the page titles they lead to (naming drift)

**HIGH** · Microcopy & Terminology · microcopy · effort M · seen 1× (LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/AdminConfigCenter.tsx`
- **Problem:** Sidebar 'Dashboard' (Sidebar.tsx:48) → page h1 says 'Owner overview' (OwnerDashboardV2.tsx:994). Sidebar 'Doctors' (Sidebar.tsx:63) → page h1 says 'Doctors & payouts' (OwnerDoctorsPage.tsx:441). Sidebar 'Admin' (Sidebar.tsx:112,164) and staff sub-item 'Config Center' (line 169) → page h1 says 'Admin Config Center' (AdminConfigCenter.tsx:41). Owner sub-item 'New diagnostic visit' (line 82, lowercase) vs staff sub-item 'New Visit' (line 140, Title Case) vs page h1 'New Diagnostic Visit' — three spellings for one destination.
- **Fix:** Centralize the human-readable name per route so the sidebar label, breadcrumb, and page h1 all read from one source — e.g. a routeMeta map keyed by href ({ '/diagnostics/new': { title: 'New Diagnostic Visit' } }) consumed by both the owner/staff nav arrays and each page's <PageHeader>/h1. This eliminates the dual-array divergence where owner and staff describe the same href with different casing ('New diagnostic visit' vs 'New Visit'). Adopt one casing convention (Title Case for nav labels and titles). Specifically: rename Sidebar.tsx:82 -> 'New Visit', :74 'Live queue' -> 'Live Queue', :96 already-fine; set OwnerDashboardV2.tsx:994 h1 to 'Dashboard' (or rename nav to 'Overview'); set OwnerDoctorsPage.tsx:441 title to 'Doctors' (drop '& payouts' since Payouts is its own nav item at Sidebar.tsx:106). For the 'Admin' parent that links to the same /owner/config as its 'Config Center' child, either make the parent non-clickable or rename the child to avoid the parent/child label collision.

### 8. 🟠 Bill totals get different labels on form vs confirm dialog vs success screen

**HIGH** · Microcopy & Terminology · consistency · effort S · seen 1× (LENS: Microcopy & Terminology)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The same three money values are relabeled at each step of one transaction. The billing form uses `Total bill` (line 2150), `Final total` (line 2254) and `Due balance` (line 2261). The confirm dialog for the very next click uses `Total` (line 2458), `Net payable` (line 2468) and `Due` (line 2479). The success screen uses yet a third set: `Final Total` (line 1104, Title Case this time) and `Due:` (line 1113). 'Final total', 'Net payable' and 'Final Total' are three names for the identical number.
- **Fix:** Adopt a single canonical money vocabulary and use it verbatim on all three surfaces. Recommended set, matching the confirm dialog (which is already the most coherent): "Total" (gross, = totalAmount), "Discount", "Net payable" (amount due, = netPayable), "Paid", "Balance due" (= dueAmount). Concretely: rename "Total bill" (2150) -> "Total"; "Final total" (2254) and "Final Total:" (1104) -> "Net payable"; "Due balance" (2261), "Due" (2479) and "Due:" (1113) -> "Balance due"; and "Received" (2228) -> "Paid". Note the dialog also says "Net payable" while the form/receipt say variants of "Final Total" — pick one term; "Net payable" is the clearer accounting term and is what the input's placeholder math implies (max={netPayable}). Best implemented by extracting these label strings into a shared constants object (e.g. MONEY_LABELS) imported by both the page and the dialog so the three surfaces cannot drift again. Effort S is correct.

### 9. 🟠 Field labeled 'Diagnostic Referral' but every placeholder/error calls it a 'center'

**HIGH** · Microcopy & Terminology · microcopy · effort S · seen 1× (LENS: Microcopy & Terminology)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The billing field `<Label>Diagnostic Referral (optional)</Label>` (line 1778) is backed by a control whose placeholder is `"Search diagnostic center (Enter to skip)"` (line 1823), searchPlaceholder `"Search by center name, phone or number"` (line 1824), emptyText `"No diagnostic centers found."` (line 1825), and ariaLabel `"Diagnostic referral center..."` (line 1826). The quick-add dialog is `Add Diagnostic Center` (line 2632). Meanwhile the sibling field one block up is labeled `Referral Doctor (optional)` (line 1716) — noun-first — so the two parallel fields don't even share a naming pattern ('Referral Doctor' vs 'Diagnostic Referral').
- **Fix:** Rename line 1778 label to "Referral Center (optional)" so it matches its own placeholder/empty-state/dialog (all already say "center"), and keep the sibling at "Referral Doctor (optional)" for a parallel "Referral {X}" pair. This is the minimal change. Also tidy the ariaLabel at 1826 from "Diagnostic referral center" to "Referral center — Enter to skip, Space to open" to mirror the doctor field's ariaLabel pattern (1752). Note the underlying state/ids (selectedCenterId, id="diagnostic-center") are internal and need not change.

### 10. 🟡 Raw internal identifiers/enums leak into the UI (rootDefinitionId footer, DIAGNOSTIC_CENTER enum as a badge and in the print header)

**MEDIUM** · Microcopy & Terminology · microcopy · effort S · seen 2× (Diagnostics Editors & Selectors, Payouts)

- **Files:** `health-hub/src/components/diagnostics/TestInputConfigEditor.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** Developer-facing strings surface to end users. TestInputConfigEditor renders `Saved per rootDefinitionId: {rootDefinitionId}` in a footer (321-323), exposing an internal DB id and a camelCase field name to admins. PayoutDetail renders the raw DB enum directly: the Doctor summary badge shows `{payout.doctorType}` (330-332) so a diagnostic center reads 'DIAGNOSTIC_CENTER' (all-caps, underscored), and the print/payment header repeats it.
- **Fix:** Never render raw ids/enums to users. Remove the rootDefinitionId footer (or gate behind a dev flag — the human-readable testLabel hint already conveys scope). Map enums through a display-label helper (`DIAGNOSTIC_CENTER` → 'Diagnostic Centre') everywhere a doctorType is shown, including the print header.

### 11. 🟡 Inconsistent microcopy with no shared tone/format — terse user-blaming validation toasts, vague/cryptic placeholders, and 'Loading...' vs 'Loading…' spelled two ways

**MEDIUM** · Microcopy & Terminology · microcopy · effort M · seen 3× (LENS: Microcopy & Terminology, LENS: Interaction & Feedback States)

- **Files:** `health-hub/src/pages/owner/DerivePayoutDialog.tsx`, `health-hub/src/pages/owner/PayoutRunCycle.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`
- **Problem:** Copy across the app has no governing voice or format. Validation toasts range from curt commands to user-blaming: `toast.error("Pick a doctor")`/`"Pick a date range"` (DerivePayoutDialog.tsx:85/89), `"Pick at least one doctor type"` (PayoutRunCycle.tsx:138), plus terse 'Enter a valid…' messages in diagnostics. Placeholders are equally inconsistent — cryptic `"D-XXXXX"` (DiagnosticsNewVisit.tsx:1309) with no hint it's an optional bill search, and near-identical search bars use different placeholder text. The loading string itself is spelled two ways: ASCII `'Loading...'` (ManageBillableProducts/ManageClinicalDefinitions/ManagePanelDefinitions/ManageDoctorsAndReferrals) vs the Unicode ellipsis `'Loading…'` (OwnerMoneyPage/OwnerDoctorsPage), with mixed verbs.
- **Fix:** Adopt a small microcopy style guide: validation messages state what's needed in a neutral voice ('Select a doctor to continue'), placeholders are descriptive and example-driven, and one canonical loading string ('Loading…' with the Unicode ellipsis) + verb. Sweep the cited files and centralize repeated strings so tone/format stay consistent.

### 12. 🟡 Generic 'Dashboard' title with no branch/role/date context

**MEDIUM** · Microcopy & Terminology · microcopy · effort S · seen 1× (Staff Dashboard / Home)

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/components/layout/ContextBanner.tsx`
- **Problem:** The h1 is just 'Dashboard' with subtitle "Today's work at a glance" (139-140). For a multi-branch app the page never states which branch's data this is (the ContextBanner shows 'Branch: <name>' separately at the top, ContextBanner.tsx:14-15, so the live data shown here is implicitly branch-scoped but never labeled in the body). There is also no date, despite the dashboard being entirely 'today'-scoped (metrics like Today's OP/IP, Diagnostics Today, lines 249-298).
- **Fix:** Replace the generic title with a greeting + today's date (e.g. 'Good morning — Tuesday, 21 Jun 2026') and/or echo the active branch name so the 'today/this branch' scope is explicit in the content, not only in the banner. This also personalizes a screen staff stare at all day.

### 13. 🟡 Pending queue shows raw DRAFT/WAITING badges with no legend or unified meaning

**MEDIUM** · Microcopy & Terminology · microcopy · effort S · seen 1× (Diagnostics Workflow)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/components/ui/status-badge.tsx`
- **Problem:** The pending queue renders `<StatusBadge status={visit.status} />` (DiagnosticsPendingResults.tsx:373) where status is either DRAFT or WAITING. StatusBadge maps DRAFT→'Draft' (status-draft color) and WAITING→'Waiting' (status-pending color) (status-badge.tsx:16,20,29,31). To staff these two labels are opaque — both rows say 'Enter Results' as the action, so the page never explains why one case is 'Draft' and another 'Waiting' (results saved-but-not-finalized vs not-started). The same component also doubles as a payment-status badge on the success screen (NewVisit:1096), so 'Pending' can mean either 'payment pending' or 'results pending' depending on context.
- **Fix:** Use task-oriented labels in the queue (e.g. 'Not started' vs 'In progress / saved') instead of the raw enum, or add a one-line legend. Keep payment-status and visit-status badges visually distinct (different token families) so 'Pending' is never ambiguous.

### 14. 🟡 Inconsistent revisit terminology: 'Revisit OP' / 'Recurring Visit' / 'recurring / revisit … free follow-up'

**MEDIUM** · Microcopy & Terminology · microcopy · effort S · seen 1× (Clinic & Patient 360)

- **Files:** `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** The same concept is named three different ways. ClinicVisitQueue.tsx:290 derives `revisitLabel = visit.visitType === 'OP' ? 'Revisit OP' : 'Recurring Visit'`, and its dialog says 'This is a recurring / revisit consultation with free follow-up' (468). ClinicNewVisit.tsx and Patient360.tsx consistently use just 'Revisit' (e.g. ClinicNewVisit.tsx:1110 'Revisit', Patient360.tsx:626 'Revisit'). Staff see 'Revisit OP' in the queue but 'Revisit' on the slip/360, and 'Recurring Visit' for IP — three labels for one billing concept create confusion about whether these are the same thing.
- **Fix:** Standardize on one term, 'Revisit' (with the OP/IP shown separately as the existing visit-type badge). Drop the OP/IP-dependent label branch in ClinicVisitQueue.tsx:290 and align the dialog wording at line 468 to match the 'No new bill — references the earlier paid visit' phrasing used in ClinicNewVisit.tsx:1111-1114.

### 15. 🟡 Shared AgingBar hardcodes the word 'bills', so Payout aging reads 'X bills' for payouts

**MEDIUM** · Microcopy & Terminology · microcopy · effort S · seen 1× (Owner Money / Doctors / Operations)

- **Files:** `health-hub/src/pages/owner/_shared/ownerUi.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`
- **Problem:** AgingBar in ownerUi.tsx line 296 always renders `${formatRupees(...)} · ${count} bills · ${pct}%`. It is reused by OwnerDoctorsPage's PayoutAgingCard (lines 224-242) where `count = bucket.rowCount` is a count of payout rows, not bills — so the Payout aging buckets incorrectly read e.g. '3 bills' when they are payouts. The card description even says 'By days since derivedAt' (a payout concept) while the rows are labeled 'bills'.
- **Fix:** Add a `unit` prop to AgingBar (default 'bills') and pass `unit="payouts"` from PayoutAgingCard; pluralize correctly (1 bill / 2 bills). This is a one-line interface change plus two call sites.

### 16. 🟡 Delete confirmations and toasts mislabel deactivation as permanent deletion

**MEDIUM** · Microcopy & Terminology · microcopy · effort S · seen 1× (Owner Config & Management Pages)

- **Files:** `health-hub/src/pages/owner/ManageDepartments.tsx`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`
- **Problem:** The trash icon + 'Delete Department?' dialog actually soft-deactivates, and the wording is internally contradictory. ManageDepartments.tsx: dialog title 'Delete Department?' with action button labeled 'Delete'/'Deleting...' (lines 465, 473-474), but the success toast says 'Department deactivated' (line 241) and the dialog body says 'This will deactivate the department.' Same contradiction in ManageDiagnosticCenters.tsx (title 'Delete Diagnostic Center?', toast 'Diagnostic center deactivated', line 235) and the unified ManageDoctorsAndReferrals.tsx centers delete (toast 'Center deactivated', line 689, button 'Delete'). Meanwhile the Active toggle in the same rows ALSO deactivates — so there are two controls doing the same thing with different labels.
- **Fix:** If the action deactivates, label it 'Deactivate' (or 'Archive') with neutral/warning styling, not destructive red, and make the toast/title/body agree. Better: drop the trash button where an Active switch already exists, or reserve the trash for a true hard-delete (as the products/definitions endpoints support).

### 17. 🟡 Clinic legal name is inconsistent across print and public pages

**MEDIUM** · Microcopy & Terminology · consistency · effort S · seen 1× (Print Documents & Legal Pages)

- **Files:** `health-hub/src/components/print/BillReceipt.tsx`, `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/pages/legal/TermsOfService.tsx`, `health-hub/src/pages/Login.tsx`
- **Problem:** The same business is named differently in different surfaces: BillReceipt.tsx line 171-172 uses "Sobhana Diagnostic Centre" / "Sobhana Clinic"; Login.tsx line 90 and PrivacyPolicy.tsx line 10 use the full legal name "Sobhana Diagnostic Centre & Multi Speciality Clinic"; TermsOfService.tsx lines 10/56 abbreviate to just "Sobhana Diagnostic Centre". On legal/financial documents (a bill, a privacy policy) the registered entity name should be identical everywhere.
- **Fix:** Define a single source of truth (e.g. `CLINIC_LEGAL_NAME = 'Sobhana Diagnostic Centre & Multi Speciality Clinic'` and an optional short name) in a constants module and consume it in BillReceipt, the legal pages, and Login. The bill header and legal pages should all show the full registered name.

### 18. 🟡 Flow mixes Visit and Bill as if interchangeable

**MEDIUM** · Microcopy & Terminology · microcopy · effort S · seen 1× (LENS: Microcopy & Terminology)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The page title is `New Diagnostic Visit` (line 1255) and the final CTA is `Review & Generate Bill` (line 2424); the confirm dialog is titled `Confirm Bill` (line 2442) with action `Generate Bill` (line 2499), but the resulting success toast is `Visit created successfully!` (line 1027) and heading `Visit Created Successfully!` (line 1083) — while the same panel then shows `Bill #:` (line 1088). So the user clicks 'Generate Bill', confirms a 'Bill', and is told a 'Visit' was created. The 'Create Another Visit' button (line 1210) reinforces 'visit', but the success metric they see is a bill number.
- **Fix:** Decide the user-facing primary object for this screen. Since it produces both, make the relationship explicit: keep 'New Diagnostic Visit' as the page, but make the CTA and success consistent — e.g. CTA 'Generate bill', success 'Visit registered — Bill #D-12345 generated'. Avoid switching the headline noun between the button ('Bill') and the result ('Visit').

### 19. ⚪ Global Patient Search results meta-strip renders ALL-CAPS literals as content ('SEARCH RESULTS • GLOBAL • READ-ONLY', 'HISTORY SNAPSHOT')

**LOW** · Microcopy & Terminology · microcopy · effort S · seen 2× (Clinic & Patient 360, LENS: Microcopy & Terminology)

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** After searching, the results header renders hardcoded all-caps words separated by bullets — `<span>SEARCH RESULTS</span> • <span>GLOBAL</span> • <span>READ-ONLY</span>` (GlobalPatientSearch.tsx:144-155) — plus a `HISTORY SNAPSHOT` block heading (line 202). The all-caps tokens read like a machine breadcrumb/debug string rather than human copy, and 'GLOBAL'/'READ-ONLY' restate context already established elsewhere.
- **Fix:** Replace the literal all-caps content with normal-case human copy (e.g. 'N patients found') and, if a small-caps look is wanted, achieve it with `uppercase tracking-wide text-muted-foreground` styling on sentence-case text rather than baking ALL-CAPS into the strings. Drop the redundant GLOBAL/READ-ONLY tokens.

### 20. ⚪ Logout button labeled "Sign Out" while login CTA says "Sign In" but the action elsewhere is "login" — minor terminology, plus logout buried at sidebar bottom with no confirm

**LOW** · Microcopy & Terminology · microcopy · effort M · seen 1× (Auth & App Shell)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** The destructive Sign Out action (Sidebar.tsx:326-333 desktop, 358-365 duplicated for the sheet) is a low-emphasis ghost button at the bottom of the nav with no confirmation; on a shared front-desk machine an accidental click instantly logs out and navigates to /login (handleLogout, lines 181-185), discarding any in-progress unsaved registration. The user identity block above it (name + role) is fine, but there is no menu/avatar affordance grouping identity + logout the way users expect.
- **Fix:** Group the user name/role + Sign Out into a small account menu (DropdownMenu on the identity block) rather than an always-visible ghost button, and/or add an AlertDialog confirm for logout when there is unsaved work. At minimum keep the label consistent with the rest of the product's auth verbs.

### 21. ⚪ 'Tests:' label renders with an empty value when only bill-only items exist

**LOW** · Microcopy & Terminology · microcopy · effort S · seen 1× (Diagnostics Workflow)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`
- **Problem:** `formatTestList` returns `labels.join(', ')`, which is an empty string when every order is BILL_ONLY or labels resolve empty (Pending:41-62 / Finalized:22-43). The row then shows `Tests: ` with nothing after it (Pending:356-358, Finalized:264-266). There's also a separate 'Includes bill-only items' chip, so a bill-only-heavy visit can show a dangling, valueless 'Tests:' label.
- **Fix:** Guard the render: only output the 'Tests:' span when `formatTestList(...)` is non-empty, otherwise fall back to a single em-dash or omit it.

### 22. ⚪ 'baseline forming' messaging is duplicated and inconsistently worded across the page

**LOW** · Microcopy & Terminology · microcopy · effort S · seen 1× (Owner & Doctor Dashboards)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`
- **Problem:** The 'not enough data yet' concept is expressed at least four different ways: top banner 'Baseline forming — comparisons available after N more days' (OwnerDashboardV2.tsx:976) and 'Week-over-week comparisons only · 30-day baseline available in N days' (line 979); money card 'baseline forming · {n} of 4 prior samples' (line 451); ops TAT 'TAT — baseline forming · {n}/4 samples' (line 608); KpiCard 'baseline forming' (ownerUi.tsx:266). Mixed punctuation ('of 4' vs '/4'), mixed casing, and overlapping meaning make the same condition read as several different states.
- **Fix:** Standardize one phrasing and one format (e.g. always 'Baseline forming · {n}/4 samples') and centralize it in a shared helper in ownerUi so every surface matches.

### 23. ⚪ Refunds list injects literal leading whitespace before the patient name

**LOW** · Microcopy & Terminology · microcopy · effort S · seen 1× (Owner Money / Doctors / Operations)

- **Files:** `health-hub/src/pages/owner/OwnerMoneyPage.tsx`
- **Problem:** RefundsCard line 470 reads `<span style={{ color: TOKENS.textPrimary }}>                {formatPatientName(...)}</span>` — there is a run of literal space characters between the tag and the JSX expression. JSX collapses leading whitespace before an expression in most cases, but this is clearly accidental copy/paste indentation leaking into rendered output and risks a visible indent before each refund name.
- **Fix:** Remove the stray whitespace so the line is `<span style={{ color: TOKENS.textPrimary }}>{formatPatientName(r.patientName, r.patientTitle)}</span>`.

### 24. ⚪ Owner config area is called Admin, Config Center, and Config interchangeably

**LOW** · Microcopy & Terminology · microcopy · effort S · seen 1× (LENS: Microcopy & Terminology)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The same configuration area (route `/owner/config`) is labeled `'Admin'` as the owner/staff nav group (Sidebar.tsx:112,164), `'Config Center'` as a sub-item (Sidebar.tsx:169), and is referenced in-flow as 'Config Center' in helper text: `"Saved defaults come from Config Center."` (DiagnosticsNewVisit.tsx:1859,2007) and `"Config Center: ..."` (lines 1893,2041).
- **Fix:** Pick one name for the destination and use it in both the nav and the references to it. Recommend 'Config Center' everywhere (it's the more descriptive, already-used-in-helper-text name): rename the nav group/sub-item to 'Config Center' so the in-flow hint points to a label users can actually see.

### 25. ⚪ WhatsApp opt-in label word order flips between new and existing patient

**LOW** · Microcopy & Terminology · consistency · effort S · seen 1× (LENS: Microcopy & Terminology)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The identical opt-in checkbox is worded two ways. New-patient form: `Send reports & bill confirmations via WhatsApp` (DiagnosticsNewVisit.tsx:1643). Existing-patient billing block: `Send bill confirmation & reports via WhatsApp` (line 2412). The two differ in order ('reports & bill confirmations' vs 'bill confirmation & reports') and number ('confirmations' vs 'confirmation').
- **Fix:** Use one canonical string for the WhatsApp opt-in everywhere (extract to a shared constant): 'Send bill confirmation and reports via WhatsApp'. Audit other duplicated controls (Add Doctor / Add Center dialogs) for the same single-source treatment.

## Accessibility

### 26. 🔴 Icon-only action buttons across Manage*/diagnostics rows have no accessible name (no text, no aria-label; title= alone is unreliable)

**CRITICAL** · Accessibility · accessibility · effort M · seen 4× (Diagnostics Workflow, Owner Config & Management Pages, LENS: Accessibility)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`, `health-hub/src/pages/owner/ManageDepartments.tsx`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManageDoctors.tsx`, `health-hub/src/pages/owner/ManageClinicDoctors.tsx`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`
- **Problem:** Dozens of row-action buttons render only a lucide icon with no text or aria-label, e.g. ManageDoctorsAndReferrals.tsx:989-990/1186-1187/1506-1507 (`<Button size="icon"><Pencil/></Button>` with neither title nor aria-label) — a screen reader announces only 'button'. A second cluster relies on the HTML `title` attribute as the only accessible name (ManageBillableProducts.tsx:561/564/567 `title="Edit"`, ManageClinicalDefinitions.tsx:845/852, ManagePanelDefinitions.tsx:911/917, DiagnosticsFinalizedReports.tsx:271-308 Eye/Printer/MessageCircle), which is not reliably announced and never shown on touch devices. In ManageDoctorsAndReferrals the rupee icon is overloaded for two different meanings, and on mobile the finalized-report actions render as a bare 3-col icon grid so staff must guess which icon sends a report to a patient.
- **Fix:** Add an explicit `aria-label` to every icon-only Button matching its action ('Edit doctor', 'Delete department', 'Send via WhatsApp', etc.); keep `title` only as a hover tooltip, never as the sole accessible name. On mobile (the finalized-report grid) show a short visible text label beside the icon so the destructive 'send report' action is unmistakable. Disambiguate the overloaded rupee icon. Consider a small `<IconButton label>` wrapper that requires a label so this can't regress.

### 27. 🔴 Form controls are not programmatically labeled — ~136 Labels lack htmlFor, result-entry value inputs and the global search input have no accessible name

**CRITICAL** · Accessibility · accessibility · effort L · seen 3× (Diagnostics Workflow, Clinic & Patient 360, LENS: Accessibility)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx`, `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx`, `health-hub/src/components/patient360/PatientEditDialog.tsx`
- **Problem:** Of 206 `<Label>` usages only 70 pass `htmlFor`; ~136 do not and the adjacent inputs carry no matching `id` (e.g. ManageBillableProducts.tsx:604-605 `<Label>Name *</Label><Input value={formName}/>`, DiagnosticsNewVisit.tsx:1445 `<Label>Title</Label>`, PatientEditDialog.tsx:223). In DiagnosticsResultEntry each test row is a bare `<Label className="font-medium">{testName}</Label>` with no htmlFor and the value `<Input>` has no id/aria-label (1539-1609), so a screen reader hears only 'edit text' with no test name, unit or reference range. The GlobalPatientSearch input (123-133) has only a placeholder, no `<Label>`/aria-label, and the ClinicNewVisit phone-lookup button is icon-only with no name.
- **Fix:** Wire `htmlFor`/`id` pairs on every Label+control (sweep all Manage* dialogs, DiagnosticsNewVisit, PatientEditDialog). For repeated rows (result entry) generate a stable id per row (`result-${resultKey}`) and add `aria-label="${testName} (${testCode}) value, reference ${displayRefText}"` so unit/range is announced inline; mark redundant mobile column-hint spans `aria-hidden`. Give the global search input an associated `<Label>` (or `aria-label`) and the phone-lookup button an aria-label. A lint rule requiring htmlFor on Label would prevent regression.

### 28. 🔴 Core semantic tokens fail WCAG contrast: warning/success use white foreground, status-badge tints put same-hue text below 3:1, and result flags are low-contrast colored text

**CRITICAL** · Accessibility · accessibility · effort M · seen 3× (LENS: Design System & Visual Consistency, LENS: Accessibility)

- **Files:** `health-hub/src/index.css`, `health-hub/tailwind.config.ts`, `health-hub/src/components/ui/status-badge.tsx`, `health-hub/src/components/ui/flag-badge.tsx`
- **Problem:** index.css:36-37 sets `--warning: 38 92% 50%` (#f59e0b) with `--warning-foreground: 0 0% 100%` (white) → 2.14:1, far below AA; `--success` (line 33-34) is similar. Status badges set saturated text over the same hue at 0.15 alpha — `.status-draft` amber text on its tint = 1.87:1, finalized/paid green tints also fail 3:1 (index.css:405-423, status-badge.tsx:38). FlagBadge (flag-badge.tsx:18) renders flags as colored text only — `flag-normal` green #1ba853 on white = 3.10:1 (below 4.5:1 for its `text-xs`), warning #f5a201 on white = 2.09:1.
- **Fix:** Recompute foreground colors for the warning/success tokens to a dark ink that meets ≥4.5:1 on the token color (or darken the token itself). Raise status-badge tint contrast (darker text or a deeper border + denser background) so each badge meets ≥3:1 (and ≥4.5:1 for its small text). For flags keep the HIGH/LOW/NORMAL word (already present) and bump the text/border to AA contrast. Add a contrast unit-test/snapshot over the token pairs so regressions are caught.

### 29. 🟠 Per-branch accent fails WCAG contrast both as text on the near-white background and as white-on-accent (btn-branch-outline hover, hardcoded accentForeground)

**HIGH** · Accessibility · accessibility · effort M · seen 3× (LENS: Design System & Visual Consistency, LENS: Accessibility)

- **Files:** `health-hub/src/lib/branchTheme.ts`, `health-hub/src/index.css`, `health-hub/src/pages/Dashboard.tsx`
- **Problem:** branchTheme.ts hardcodes `accentForeground: '#ffffff'` for every branch (lines 27/35/43/52) and `var(--branch-accent)` is used both as a text color on the near-white `--background` (#fafafa) and as a white-on-accent fill. Measured: accent-as-text — Dashboard.tsx:294/312 IDPL teal, BLN blue #3b82f6, JGG purple #8b5cf6 all fail; white-on-accent — `.btn-branch-outline:hover` (index.css:396-399) sets accent bg + white text: IDPL teal = 2.49:1, BLN blue = 3.68:1, JGG purple = 4.23:1, all below 4.5:1.
- **Fix:** Stop using the branch accent as body text on light backgrounds (use `--foreground` and reserve accent for chrome/large UI). Replace the hardcoded `accentForeground: '#ffffff'` with a per-branch computed foreground that meets ≥4.5:1 against each accent (darken accents that can't carry white, or pair light accents with dark text). Re-verify btn-branch-outline hover and the context banner after the change.

### 30. 🟠 Hand-rolled owner charts (V2 revenue trend, TAT histogram) have no axis values, tooltips, or accessibility, and hardcode magic ceilings

**HIGH** · Accessibility · data-density · effort M · seen 2× (Owner & Doctor Dashboards, Owner Money / Doctors / Operations)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** The owner dashboards render charts as bare SVG with no readable data. The 30-day revenue trend is a hand-rolled polyline+dots with `preserveAspectRatio="none"` (OwnerDashboardV2.tsx:722-756) — no Y axis, no value labels, no hover tooltip, so the owner can't read any actual figure. The TAT histogram clamps SLA/p50/p95 markers against a magic literal `33` minutes (OwnerOperationsPage.tsx:121/124/128) while axis labels read '0m/15m/30m+' (201-203), so anything above ~33m is silently pinned to the right edge, and it too has no tooltip/accessible representation.
- **Fix:** Render these with the charting library already used by the legacy dashboard (recharts) — or at minimum add Y-axis ticks, value labels, and hover tooltips — so figures are readable; expose a text/table alternative for AT (e.g. an aria-label summary or visually-hidden data table). Replace the hardcoded 33-minute ceiling with a data-driven max (and a '>Nm' overflow indicator).

### 31. 🟠 Critical signals are encoded by color/tint alone with no text or icon (owner action-queue severity chips; money/doctor/ops flags, overdue ages, rate breaches)

**HIGH** · Accessibility · accessibility · effort M · seen 2× (Owner & Doctor Dashboards, Owner Money / Doctors / Operations)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** The most decision-critical elements rely on color only. On OwnerDashboardV2 the action chips — the 'what needs my decision' list — encode urgency solely as a 2px colored left border (386-397, `borderLeftWidth:2, borderLeftColor: severityColor(...)`), so high/medium/low are otherwise indistinguishable and the low-severity color also fails contrast. Across OwnerMoneyPage/OwnerDoctorsPage/OwnerOperationsPage, signals are conveyed only by tint: heavy-cash branches `background:'#FFF8E1'`, solo-cash users an amber cell, flagged discounts a red tint `#FCEBEB30`, high-rate doctors a red row tint — none carry a text label, so the meaning is invisible to colorblind/AT users and on grayscale.
- **Fix:** Pair every color-coded signal with a non-color cue: a text label/badge ('High', 'Heavy cash', 'Overdue 45d', 'Rate breach') and/or an icon, in addition to the tint. Make the action-chip severity a labeled badge rather than a thin border, and ensure the colors themselves meet contrast.

### 32. 🟠 Owner BranchFilter/PeriodFilter/RefreshButton are raw native controls — inconsistent with the app's shadcn Select, with no aria-label and no visible focus styling

**HIGH** · Accessibility · consistency · effort M · seen 2× (Owner & Doctor Dashboards, Owner Money / Doctors / Operations)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`, `health-hub/src/pages/doctor/DoctorDashboard.tsx`
- **Problem:** The owner area's filter controls bypass the shadcn system and a11y. Both owner BranchFilters render a bare HTML `<select>` with inline border color and no `aria-label` (OwnerDashboardV2.tsx:336-353; ownerUi.tsx:314-328), unlike the Doctor dashboard and the rest of the app which use shadcn `Select`; the native select also has no visible focus ring. The icon-only RefreshButton (ownerUi.tsx:404-413) has only a `title` (RefreshCw) which isn't reliably announced, and the PeriodFilter segmented `<button>` group (352-366) lacks labels/group semantics.
- **Fix:** Replace the native `<select>` BranchFilters with shadcn `Select` (consistent popover styling, keyboard, visible focus) and add `aria-label`. Give the RefreshButton a real `aria-label="Refresh"` (keep title as tooltip). Give the PeriodFilter group an accessible name (role=group + aria-label) and a visible focus-visible ring on each segment.

### 33. 🟠 ProductSelector & TestSelector are hand-rolled comboboxes with no ARIA/listbox semantics and a fragile 200ms blur-timeout dropdown (no Popover, no outside-click/scroll handling)

**HIGH** · Accessibility · accessibility · effort L · seen 2× (Diagnostics Editors & Selectors)

- **Files:** `health-hub/src/components/diagnostics/ProductSelector.tsx`, `health-hub/src/components/diagnostics/TestSelector.tsx`
- **Problem:** Both selectors render a plain `<Input>` plus an absolutely-positioned `<div>` dropdown of `<div>` rows (ProductSelector.tsx:296-368, TestSelector.tsx:178-226) with no `role="combobox"`/`aria-expanded`/`aria-activedescendant`/`aria-controls`/`role="listbox"`/`role="option"`/`aria-selected`; keyboard nav is reimplemented by hand (ArrowDown/Up/Enter, `highlightedIndex`) and never exposed to AT, so a screen-reader user gets an unlabeled text box with invisible results. The list also closes via `onBlur={()=>setTimeout(()=>setIsOpen(false),200)}` (ProductSelector.tsx:272): not in a Popover, it doesn't reposition on scroll, has no portal/collision handling (clips inside scroll parents), the rows aren't tabbable, and the 200ms race silently drops slow clicks. The sibling TestValueCombobox already uses shadcn Command/Popover correctly — the right primitive exists.
- **Fix:** Rebuild both on shadcn Popover + cmdk `<Command>` (`<CommandInput>`/`<CommandList>`/`<CommandGroup>` preserving the department/product-type grouping/`<CommandItem>` per row): cmdk supplies role=listbox/option, aria-selected, aria-activedescendant, type-ahead, full keyboard nav, outside-click dismissal, Escape, portal rendering and collision-aware positioning for free — deleting the manual handleKeyDown/highlightedIndex/blur-timeout machinery. Keep the per-row price/badges/code markup inside each CommandItem; give the no-results state role=status. (After this, TestSelector is dead code — see the dead-components issue.)

### 34. 🟠 Sidebar nav links and active group have no visible keyboard focus indicator

**HIGH** · Accessibility · accessibility · effort S · seen 1× (LENS: Accessibility)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/index.css`
- **Problem:** The primary nav links are bare `<Link>` elements styled only with hover/active background (Sidebar.tsx:224-228 and 265-269) and define no `focus-visible` ring. There are no focus classes anywhere in Sidebar.tsx. Even where a ring would appear, the global `--ring` is `0 0% 20%` (#333, index.css:41) — a dark ring that is nearly invisible on the dark navy/teal/purple sidebar backgrounds.
- **Fix:** Add focus-visible styles to the Link className in BOTH branches of renderNavContent (lines 224-227 and 265-268). Use a light ring for contrast on the dark sidebar, e.g. 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80'. Drop the ring-offset suggested in the original finding: the offset color must equal the element's background, but inactive links sit on --branch-sidebar-bg while active links use --branch-sidebar-active, so a single hardcoded offset will mismatch one state. Instead use a ringless offset by relying on ring-2 alone, or use 'focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-white/80' so the ring renders inside the link bounds and stays visible regardless of active/inactive background. This is S effort.

### 35. 🟡 Status/metric icons are decorative-only with no accessible labels

**MEDIUM** · Accessibility · accessibility · effort S · seen 1× (Staff Dashboard / Home)

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** Every lucide icon (FlaskConical, Stethoscope, Users, Clock, AlertCircle, CheckCircle2, etc., e.g. 154-157, 175-178, 291, 306-312) carries meaning (warning state, all-clear state) but has no aria-label/aria-hidden treatment. The AlertCircle conveys 'attention needed' and CheckCircle2 conveys 'all clear' purely visually; screen-reader users get nothing, and the warning is also color-only (text-warning at 154/160).
- **Fix:** Mark purely decorative icons aria-hidden="true", and for state-bearing ones (warning AlertCircle, All Clear CheckCircle2) provide an accessible label or accompanying visually-hidden text. Ensure the warning state is conveyed by more than color (it already adds an icon + text, so just expose them to AT).

### 36. 🟡 Toolbar mixes native <select>/<input type=color> with shadcn Buttons — inconsistent styling, focus rings, and a11y labels

**MEDIUM** · Accessibility · consistency · effort M · seen 1× (Diagnostics Editors & Selectors)

- **Files:** `health-hub/src/components/diagnostics/RichTextToolbar.tsx`
- **Problem:** The block/font/size pickers are raw native `<select>` elements (lines 57-91) styled ad-hoc with `focus:ring-2 focus:ring-primary/25`, while the format actions are shadcn `<Button variant="ghost">` with a different `focus-visible` ring inherited from the Button component. The color pickers are bare `<input type="color">` inside a `<label>` (lines 212-234). None of the three selects has an accessible name (no `aria-label` / associated `<label>`) — a screen reader announces an unlabeled combobox; the font-size select is just '8' / '12'. Native selects also can't match the app's Select dropdown look (DiagnosticsNewVisit uses shadcn Select elsewhere).
- **Fix:** Swap the three native selects for shadcn `Select` components (consistent popover styling, keyboard, and `aria-label`) and add `aria-label="Block format"/"Font family"/"Font size"`. Give the color `<input>`s an `aria-label` (the visible 'Text'/'Highlight' text isn't programmatically associated). Unify focus-ring treatment across all toolbar controls.

### 37. 🟡 Loading spinner and full-screen report modal lack ARIA/focus handling

**MEDIUM** · Accessibility · accessibility · effort M · seen 1× (Clinic & Patient 360)

- **Files:** `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** The page loading state is a bare `<div className="animate-spin …">` with no `role="status"`/`aria-label` and no visible text (Patient360.tsx:412-414), so non-sighted users get no 'Loading' announcement. The full-screen report preview is a hand-rolled `<div className="fixed inset-0 z-50 …">` (740-812) rather than a Dialog: it has no `role="dialog"`/aria-modal, no focus trap, and no Escape-to-close — only the X button closes it, and focus is not returned to the trigger. Background content stays focusable behind the overlay.
- **Fix:** Give the spinner `role="status"` with an sr-only 'Loading patient…' label (or reuse a shared Spinner component). Convert the preview overlay to shadcn `Dialog`/`DialogContent` (full-screen variant) to get focus trap, Escape handling, aria-modal, and focus restoration for free.

### 38. 🟡 No skip-to-content link; keyboard users must tab through the full sidebar every page

**MEDIUM** · Accessibility · accessibility · effort S · seen 1× (LENS: Accessibility)

- **Files:** `health-hub/src/components/layout/AppLayout.tsx`
- **Problem:** AppLayout renders the Sidebar then `<main>` (AppLayout.tsx:25-36) but provides no skip link. A grep for 'skip' / skip-link in the layout finds none. The sidebar contains ~8-12 links plus sub-items and a Sign Out button, all of which a keyboard user must tab through on every page load before reaching content.
- **Fix:** Add a visually-hidden-until-focused skip link as the first focusable element, e.g. `<a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 ...">Skip to content</a>` and give `<main id="main" tabIndex={-1}>`.

### 39. 🟡 Active-branch context banner is a presentational div, not an announced region

**MEDIUM** · Accessibility · accessibility · effort S · seen 1× (LENS: Accessibility)

- **Files:** `health-hub/src/components/layout/ContextBanner.tsx`, `health-hub/src/components/layout/BranchSelector.tsx`
- **Problem:** ContextBanner.tsx:11 is a plain `<div className="context-banner ...">` showing the critical 'Branch: <name>' context with no landmark/role and no live-region semantics. When a staff/owner switches branch via BranchSelector (which mutates global state and changes accent theme, prices, and which patients are in scope), nothing is announced to screen-reader users.
- **Fix:** Wrap the branch text in an `aria-live="polite"` region, or fire a polite live announcement on branch change ('Active branch changed to <name>'). Optionally mark the banner with role="region" aria-label="Active branch context".

### 40. 🟡 Payout table rows are clickable but not keyboard-operable as rows

**MEDIUM** · Accessibility · accessibility · effort M · seen 1× (LENS: Accessibility)

- **Files:** `health-hub/src/components/payouts/PayoutsTable.tsx`
- **Problem:** PayoutsTable.tsx:163-179 renders `<TableRow className="cursor-pointer" onClick={...onRowClick(row)}>` with no tabIndex, role, or onKeyDown, so the row itself cannot be activated by keyboard. This is partially mitigated because each row also contains an explicit `aria-label="View details"` button (lines 246-256), but the `cursor-pointer` affordance is a mouse-only promise.
- **Fix:** Prefer keeping navigation on the explicit View button and remove row-level onClick + cursor-pointer to avoid the false affordance; or, if rows must stay clickable, add `tabIndex={0} role="button" aria-label={...}` and an onKeyDown for Enter/Space. (Contrast with DiagnosticsNewVisit.tsx:1329+ which correctly implements role=listbox/option with full keyboard handling — reuse that pattern.)

### 41. ⚪ Owner sidebar section headers (white/40) fall below text contrast

**LOW** · Accessibility · accessibility · effort S · seen 1× (LENS: Accessibility)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** Sidebar.tsx:258 renders the 'Operations'/'Workflows' group headers as `text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40`. Measured against the navy sidebar (#1B2B58), white at 40% opacity is ~3.48:1 — below the 4.5:1 needed for this small 10px text.
- **Fix:** Raise to at least text-white/60 (≈5.9:1 here) for the section labels, or increase the font size. Keep /40 only for truly decorative dividers.

## Feedback & States

### 42. 🔴 Native `window.confirm()` used for the money-critical duplicate-patient decision (off-brand, unstyled, OK/Cancel inverted vs intent) in both diagnostics and clinic flows

**CRITICAL** · Feedback & States · interaction-feedback · effort M · seen 3× (Diagnostics Workflow, Clinic & Patient 360, LENS: Interaction & Feedback States)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`
- **Problem:** At the most consequential moment of registration — whether a new bill attaches to an existing patient or forks a duplicate medical record — both flows fire a native OS dialog: `window.confirm("⚠️ Potential Duplicate Detected\n\n...")` at DiagnosticsNewVisit.tsx:734-743 and the identical block at ClinicNewVisit.tsx:352-361. It is unstyled (breaks Sobhana branding), unscannable (a wall of \n-joined text with • glyphs), and the buttons are inverted from intent: 'OK to USE EXISTING' vs 'Cancel to CREATE NEW' — front-desk staff under time pressure routinely mis-map OK/Cancel, risking duplicate records or wrong-record merges.
- **Fix:** Replace window.confirm with the existing shadcn AlertDialog (note it can't be a synchronous drop-in: on a 409, stash the parsed `existing` patient in state and halt the submit instead of blocking on confirm()). Render an AlertDialog showing a structured card of the existing record — patientNumber, formatPatientName, ageDisplay, gender, masked phone — not a text blob. Provide two intent-labeled actions and remove all OK/Cancel ambiguity: a primary, autofocused `Use existing ({patientNumber})` (the safe, visually dominant choice) and a destructive-variant `Create new record anyway` that runs the forceDuplicate retry. Extract `onUseExisting`/`onForceCreate` handlers so the async create/bill chain resumes correctly. Build it once and share between the diagnostics and clinic flows.

### 43. 🔴 Core data fetches fail silently to console.error, so an API/network error is indistinguishable from a legitimately empty result (Dashboard even shows a false 'All Clear')

**CRITICAL** · Feedback & States · error-handling · effort M · seen 2× (Staff Dashboard / Home, LENS: Interaction & Feedback States)

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`
- **Problem:** Multiple primary-data fetches catch errors with only `console.error(...)` and set loading=false, leaving an empty page that looks like 'no data' (DiagnosticsNewVisit.tsx:218, DiagnosticsPendingResults, DiagnosticsFinalizedReports). The Dashboard is the worst case: its catch only logs (Dashboard.tsx:90-94) and leaves the visit arrays empty, so `metrics.hasPendingWork` is false and the page renders a confident green 'All Clear — Operations are running smoothly' (304-325) — a failed load is indistinguishable from a genuinely quiet branch.
- **Fix:** Add an `error` state to each fetch (reset to false alongside setLoading(true), set true in catch). Render a destructive shadcn `<Alert>` (AlertCircle + 'Couldn't load …' + a Retry button that re-invokes the fetch) INSTEAD of the data region — not merely above it — so stale zeros aren't shown next to the error. On the Dashboard, gate the entire 'All Clear' branch on `!error && !loading` so the soothing message can never appear without a confirmed successful response. Extract fetch fns (useCallback) so Retry can re-invoke them.

### 44. 🔴 Payout bulk actions don't guard paid rows up front — bulk delete silently destroys PAID payouts, and bulk 'Mark Paid' is always enabled and fails after the click

**CRITICAL** · Feedback & States · error-handling · effort M · seen 2× (Payouts)

- **Files:** `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/components/payouts/PayoutDeleteDialog.tsx`, `health-hub/src/components/payouts/PayoutBulkActionBar.tsx`
- **Problem:** Bulk operations validate too late (or not at all). openBulkDelete/submitBulkDelete (PayoutsList.tsx:294-330) delete every selected row (`ids = selectedRows.map(r=>r.id)`) with zero check for `paidAt` — mark-paid has a guard (line 228) but delete has none, so an owner can irreversibly destroy already-PAID payouts with no distinct warning. Conversely PayoutBulkActionBar.tsx:52-54 renders 'Mark Paid' with no disabled state, so a mixed paid+pending selection is rejected only after the click via an error toast ('Selection includes already-paid payouts. Filter to Pending first.').
- **Fix:** Guard both actions in the selection, not after. Disable (with a tooltip reason) 'Mark Paid' and 'Delete' when the selection contains paid rows, and for delete add a distinct destructive confirmation that explicitly names how many PAID payouts would be removed (or block deletion of paid payouts entirely). Surface the disabled reason before the user commits.

### 45. 🟠 Three competing loading patterns (Skeleton vs Loader2 vs nothing) with no shared component; some forms (New Diagnostic Visit) declare isLoading but never render it

**HIGH** · Feedback & States · interaction-feedback · effort L · seen 6× (Staff Dashboard / Home, Owner & Doctor Dashboards, Owner Money / Doctors / Operations, Payouts, LENS: Interaction & Feedback States)

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/pages/doctor/DoctorDashboard.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`, `health-hub/src/components/payouts/PayoutsTable.tsx`, `health-hub/src/pages/owner/PayoutsByDoctor.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/pages/owner/AdminConfigCenter.tsx`
- **Problem:** Loading is rendered three incompatible ways with no shared primitive: owner pages use Skeletons (OwnerMoneyPage.tsx:538 FullPageSkeleton; also OwnerDashboard/Operations/PayoutsList/ByDoctor), diagnostics/clinic pages use Loader2 spinners, and the Dashboard uses a tiny text line ('Loading live branch data…', 143-148) while the metric cards still render computed zeros from empty arrays — so the user sees '0'/'All Clear' flash before real numbers populate, with no aria-live. Worst: New Diagnostic Visit declares `const [isLoading,setIsLoading]=useState(true)` (line 94) and `setIsLoading(false)` (220) but NEVER reads isLoading in render, so the full 2675-line form (phone lookup, selectors, payment) is interactive before products/doctors load.
- **Fix:** Build one shared loading convention (a `<LoadingState>`/skeleton set + a spinner for inline buttons) and apply it consistently. On the Dashboard render Skeletons inside the metric cards instead of computed zeros and wrap the indicator in `role="status" aria-live="polite"`; suppress 'All Clear' until a successful fetch. On New Diagnostic Visit actually consume isLoading — render a skeleton/disabled form until the lookups resolve so staff can't act on empty selectors.

### 46. 🟠 Unsafe (patient as any).title access can crash list rows

**HIGH** · Feedback & States · error-handling · effort S · seen 1× (Diagnostics Workflow)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`
- **Problem:** Both list pages render `formatPatientName(patient?.name || 'Unknown', (patient as any).title)` (DiagnosticsPendingResults.tsx:345, DiagnosticsFinalizedReports.tsx:255). The name argument is null-guarded with `patient?.name` — implying patient can be null — but the very next argument dereferences `(patient as any).title` without optional chaining. If a visit ever comes back with a missing patient, the guarded name is moot and the row throws, taking down the whole list render.
- **Fix:** Replace `(patient as any).title` with `patient?.title` in both files. Also drop the `as any` cast by typing `patient` properly (the visit type should carry an optional `title` field). For full graceful degradation, skip rows with no patient: in `visitsWithDetails.map`/filter, fall back to a single 'Unknown patient' display rather than relying on per-field optional chaining scattered across the JSX. While here, fix the sibling unsafe access at DiagnosticsPendingResults.tsx:187 (`patient?.name.toLowerCase()` -> `patient?.name?.toLowerCase()`).

### 47. 🟠 Signing rule and lab-incharge-rule deletes fire immediately with no confirmation

**HIGH** · Feedback & States · error-handling · effort M · seen 1× (Owner Config & Management Pages)

- **Files:** `health-hub/src/pages/owner/ManageSigningDoctors.tsx`
- **Problem:** Every other delete in this area gets an AlertDialog confirm (departments, doctors, centers, products, panels, definitions). But the two RULE tables in Signing Doctors delete on a single click with zero confirmation: the trash Button onClick={() => handleDeleteRule(rule.id)} (line 857) and onClick={() => handleDeleteLabInchargeRule(rule.id)} (line 1028) call the DELETE fetch directly. There is no AlertDialog gating these — compare the carefully gated handleDeleteDoctor (AlertDialog at line 1445) in the same file.
- **Fix:** Introduce two confirm states mirroring the existing pattern (e.g. deleteRuleId / deleteLabInchargeRuleId) and add two AlertDialogs alongside the ones at lines 1445 and 1467. The trash buttons should set the pending id (onClick={() => setDeleteRuleId(rule.id)}) rather than calling the handler; the AlertDialogAction calls handleDeleteRule. Populate the AlertDialogDescription from the rule row so it names the department and signing doctor (e.g. "Remove Dr. {rule.signingDoctorName} as the signer for {rule.departmentName}? Lab reports for this department will no longer carry this signature."), and for the lab-incharge rule name the branch/department + incharge. Reuse the className="bg-destructive text-destructive-foreground" action styling already used on lines 1459/1481 for visual consistency.

### 48. 🟡 Patient search/lookup surfaces lack loading, empty, and error feedback (Global Patient Search results, New Visit phone-lookup, and the 'no patients found' case)

**MEDIUM** · Feedback & States · interaction-feedback · effort M · seen 3× (LENS: Interaction & Feedback States)

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** Across the patient-lookup feature, async lookups give no in-region feedback. On Global Patient Search the only signal is the button label flipping to 'Searching...' (136); the results area renders nothing new (isSearching used only at 134/136), so on 3G the page looks frozen. On New Diagnostic Visit, `handleSearch` (465) and `handlePhoneChange` (486) track no loading state and only `console.error` on failure (481/501); the Search button is never disabled and shows no busy indicator. And when a 10-digit phone returns zero matches the Matching-Patients card (renders at 1319) shows only the 'Create New Patient' button and the arrow-keys hint — never a 'no patients found' message — so staff can't tell 'no results' from 'still searching'.
- **Fix:** Give every lookup a loading state in the results region (skeleton rows or a spinner with role=status), an explicit empty state ('No patients found — create a new record'), and an inline error with retry on failure (not just console.error). Disable/spinner the Search button while a lookup is in flight. Ideally route these through a shared search-results component so all lookup surfaces behave the same.

### 49. 🟡 Dialog in-flight feedback is button-label-only — the confirm button shows no spinner/working state while busy and the rest of the dialog (inputs, Cancel) stays active during the request

**MEDIUM** · Feedback & States · interaction-feedback · effort S · seen 2× (Diagnostics Editors & Selectors, LENS: Interaction & Feedback States)

- **Files:** `health-hub/src/components/diagnostics/PartialReleaseSelectorDialog.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** Dialogs signal 'working' only on the primary button, and incompletely. PartialReleaseSelectorDialog uses its `busy` prop only to disable buttons (177/182) — the confirm still renders a static `confirmLabel` ('Continue → Preview') with no spinner, reading as a frozen UI on a slow connection (PdfPreview.tsx:93 already shows the Loader2 idiom). The quick-add Product/Doctor/Center dialogs flip the primary button to 'Adding...' (2579/2622/2665) but leave all inputs and the Cancel button enabled during the POST, so a user can edit fields or cancel mid-request with no overlay/in-flight feedback.
- **Fix:** While busy, render `<Loader2 className="animate-spin"/>` + a working label inside the confirm button AND disable the dialog's inputs and Cancel (or show a lightweight overlay) so the whole dialog reflects the in-flight state, matching the PdfPreview spinner idiom.

### 50. 🟡 404 page is off-brand, unauthenticated-only-styled, and uses a raw <a> that drops to a public route

**MEDIUM** · Feedback & States · error-handling · effort S · seen 1× (Auth & App Shell)

- **Files:** `health-hub/src/pages/NotFound.tsx`, `health-hub/src/App.tsx`
- **Problem:** NotFound.tsx renders a bare `404 / Oops! Page not found` on `bg-muted` with no SOBHANA branding, no sidebar/app shell, and a plain `<a href="/">Return to Home`. Because the catch-all `<Route path="*" element={<NotFound />}/>` (App.tsx:237) is outside any ProtectedRoute/AppLayout, an authenticated user who mistypes a URL is dumped onto a context-less, brand-less screen and the `<a href="/">` triggers a full page reload (losing SPA state) and sends owners/doctors to the staff dashboard `/` rather than their own home. "Oops!" is also too casual for a clinical/financial tool.
- **Fix:** Wrap NotFound in the app shell when authenticated (or at least add the SOBHANA logo + muted-foreground copy), replace `<a>` with a react-router `<Link>`/`<Button asChild>`, and route the user to their role home (owner→/owner, doctor→/doctor, else /) using the same role logic in App.tsx:90. Drop "Oops!" for neutral copy like "This page doesn't exist."

### 51. 🟡 Login surfaces errors only via toast; no inline/ARIA error region and password field has no reveal

**MEDIUM** · Feedback & States · interaction-feedback · effort M · seen 1× (Auth & App Shell)

- **Files:** `health-hub/src/pages/Login.tsx`
- **Problem:** On failed login, Login.tsx:31 calls `toast.error(...)` only — there is no inline, persistent error message tied to the form via `aria-describedby`/`role="alert"`, so a screen-reader user or anyone who misses the transient toast gets no durable feedback about why sign-in failed. The password input (lines 134-145) has no show/hide toggle, which is standard for typo-prone clinical staff, and the submit button's only loading feedback is text swap to "Signing in..." with `disabled:opacity-50` (lines 153,159) — no spinner.
- **Fix:** Add an inline error container with `role="alert"` above/below the fields (kept in addition to the toast), wire `aria-invalid`/`aria-describedby` on the inputs, add an eye-toggle button to the password field, and put a Loader2 spinner in the submit button during isLoading.

### 52. 🟡 RichTextToolbar 'inactive' state is misleading: muted to 60% but every control still fires

**MEDIUM** · Feedback & States · interaction-feedback · effort S · seen 1× (Diagnostics Editors & Selectors)

- **Files:** `health-hub/src/components/diagnostics/RichTextToolbar.tsx`, `health-hub/src/components/diagnostics/ReportFramedNarrativeEditor.tsx`
- **Problem:** The `active` prop is documented as 'controls are visually muted and skip mousedown.preventDefault' (line 35), and ReportFramedNarrativeEditor passes `active={isActive}` so the toolbar dims to `opacity-60` (line 53) before the editor is focused. But the buttons are NOT disabled and their handlers do not check `active` — every `onMouseDown` still calls `event.preventDefault()` and `dispatch(...)` (e.g. lines 99-103). The doc comment's claim that it 'skip[s] mousedown.preventDefault' is false. So a user sees greyed-out controls (signal: 'these don't work yet') yet clicking Bold while nothing is focused still dispatches a no-op execCommand. The dropdowns (block/font/size selects, color inputs) aren't dimmed or guarded at all.
- **Fix:** Either make the muted state real (add `disabled={!active}` to the Buttons/selects/color inputs and early-return from `dispatch` when `!active`), or drop the muting entirely and keep the toolbar fully live (execCommand auto-focuses the editor anyway). Do not show a disabled-looking affordance that is actually live — fix the doc comment to match whichever behavior you keep.

### 53. 🟡 Run Cycle preview/derive runs N sequential requests with a single static spinner and no per-type progress or cancel

**MEDIUM** · Feedback & States · interaction-feedback · effort M · seen 1× (Payouts)

- **Files:** `health-hub/src/pages/owner/PayoutRunCycle.tsx`
- **Problem:** runPreview (PayoutRunCycle.tsx:136-170) and runDerive (172-205) loop over selected doctor types issuing one fetch each, awaited serially, while the UI shows only a generic 'Building preview…' / 'Deriving payouts…' line (370-375, 464-469). For a 3-type monthly run across many doctors this can take a while with no indication of which type is in flight, no progress count, and no way to cancel. If derive fails mid-loop, runDerive `continue`s (193) and silently produces partial results with only a per-type toast.
- **Fix:** Show stepwise progress ('Deriving Referral doctors… (1/3)') by tracking the current type in state, and a determinate count where possible. On partial failure, surface a persistent summary in the results panel (which types failed) rather than relying on transient toasts.

### 54. 🟡 ReportViewPage redirect shows an infinite spinner with no timeout or failure recovery

**MEDIUM** · Feedback & States · error-handling · effort S · seen 1× (Print Documents & Legal Pages)

- **Files:** `health-hub/src/pages/ReportViewPage.tsx`
- **Problem:** ReportViewPage immediately `window.location.replace(redirectUrl)` (lines 19-23) and otherwise shows a spinner with "Opening your report..." (lines 40-45). If the backend report endpoint is slow, down, or returns an error page, the only feedback the patient ever sees on this page before the redirect is a spinner; if the replace fails silently or the target errors, there is no timeout, no retry, and no way back. The missing-token branch (lines 25-38) is handled well, but the success path has no fallback.
- **Fix:** Keep the redirect, but add a fallback after a few seconds: if still on the page, show a visible "Open report" anchor link to `redirectUrl` plus a "having trouble?" message, so a stalled or blocked redirect (popup/security blockers, slow network) still gives the patient an actionable link.

### 55. 🟡 No shared EmptyState component — empty results re-implemented per page with differing icons/copy

**MEDIUM** · Feedback & States · consistency · effort M · seen 1× (LENS: Interaction & Feedback States)

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** Each screen hand-rolls its own empty state with inconsistent structure. GlobalPatientSearch.tsx:159-166 uses a Card with a centered User icon + two-line copy; ClinicVisitQueue.tsx:283 is a bare 'No visits found.' line inside a spinner branch; ProductSelector.tsx:436-440 is a one-liner 'Start typing to search…'; and DiagnosticsNewVisit's matching-patients zero-result case has no empty state at all (see related finding). There is no EmptyState primitive (a find for *empty* returns nothing), so icon presence, vertical padding (py-12 vs py-4), and tone vary screen to screen.
- **Fix:** Create a shared <EmptyState icon title description action> component and use it for all 'no results'/'nothing yet' cases (search, queues, selectors). Standardize padding, icon size/opacity, and a one-line-plus-hint copy pattern. This also gives a natural home for the error-empty variant from the silent-failure finding.

### 56. ⚪ Branch confirm modal is non-dismissible by design but offers no cancel/keyboard escape and uses a hand-rolled button instead of DialogFooter

**LOW** · Feedback & States · interaction-feedback · effort S · seen 1× (Auth & App Shell)

- **Files:** `health-hub/src/components/layout/BranchConfirmModal.tsx`
- **Problem:** BranchConfirmModal.tsx:77-79 hides the close button and blocks Escape + outside-click (`[&>button.absolute]:hidden`, `onEscapeKeyDown` preventDefault, `onPointerDownOutside` preventDefault). That is intentional (must pick a branch) but the only escape hatch is a successful selection — there's no way to log out/cancel from this trapped state if branches fail to load (the Continue button just stays disabled per line 139). The CTA is a bare full-width `<Button>` (line 136) rather than living in a `<DialogFooter>`, diverging from the shadcn dialog pattern used elsewhere.
- **Fix:** Keep it modal but add a secondary 'Sign out' / 'Cancel' affordance for the failure case (branches empty after load), and wrap the action in `<DialogFooter>`. Also show an explicit error state if fetchBranches resolves with zero active branches instead of an indefinitely-disabled Continue.

### 57. ⚪ Inconsistent search thresholds: results render at 1 char but the 'No results' state only at 2

**LOW** · Feedback & States · interaction-feedback · effort S · seen 1× (Diagnostics Editors & Selectors)

- **Files:** `health-hub/src/components/diagnostics/ProductSelector.tsx`, `health-hub/src/components/diagnostics/TestSelector.tsx`
- **Problem:** filteredProducts starts matching as soon as `searchQuery.trim()` is non-empty — i.e. 1 character (ProductSelector.tsx line 114). But the empty/no-results message is gated on `searchQuery.length >= 2` (line 371; TestSelector.tsx line 229). So typing a single character that matches nothing shows neither results NOR the 'No products found' message NOR the quick-add fallback — the dropdown just silently doesn't appear, which reads as broken. The Add-Bill-Only escape hatch is unreachable for 1-char queries.
- **Fix:** Use one consistent threshold. Either render the no-results/quick-add state from 1 char (`searchQuery.trim().length >= 1`) or require 2 chars before searching at all, so the user never sees a dead, blank dropdown state.

### 58. ⚪ Print button stays disabled while logo loads with no clear affordance

**LOW** · Feedback & States · interaction-feedback · effort S · seen 1× (Print Documents & Legal Pages)

- **Files:** `health-hub/src/pages/BillPrintPage.tsx`, `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** BillPrintPage disables the print button until the logo loads: `disabled={!logoLoaded || generating}` with label "Preparing Print..." (lines 142-151). The logo onerror handler in BillReceipt (lines 153-156) does flip logoLoaded true on failure, so it won't hang forever — but the disabled state has no visible spinner and the button is positioned `fixed top-4 right-4` with `z-50`, where on a long bill it can overlap the receipt's top content. There is also no toast/explanation if PDF generation throws (line 104 only console.errors then silently falls back to window.print()).
- **Fix:** Add a small inline spinner to the "Preparing Print..." / "Generating PDF..." states for clearer feedback, and surface a user-visible toast on PDF-generation failure instead of a silent console error + fallback. Consider constraining the fixed button so it cannot overlap receipt content on narrow viewports.

## Redundancy & Altitude

### 59. 🟠 ContextBanner shows the active branch name twice (static 'Branch: <name>' label + selector trigger showing the same name)

**HIGH** · Redundancy & Altitude · redundancy · effort S · seen 2× (Auth & App Shell, LENS: Responsive & Mobile)

- **Files:** `health-hub/src/components/layout/ContextBanner.tsx`, `health-hub/src/components/layout/BranchSelector.tsx`
- **Problem:** ContextBanner renders a static 'Branch: <name>' block AND the BranchSelector next to it, and the selector trigger renders the very same name. ContextBanner.tsx:14-16 prints `<span>Branch:</span> <span>{activeBranch?.name}</span>` while BranchSelector.tsx:111-113 renders `<Building2/> {activeBranch.name} <ChevronDown/>`. For staff/owner the branch name is displayed twice side by side on every authenticated page; for doctors the static label duplicates the non-interactive name pill (BranchSelector.tsx:94-101). On mobile the banner is `flex flex-col` (ContextBanner.tsx:11) so the name stacks above a full-width selector that also shows it, doubling vertical space.
- **Fix:** Drop the static 'Branch:' + name block (ContextBanner.tsx:12-17) entirely; the BranchSelector trigger is the canonical interactive control. If a 'switch branch' affordance is desired, add `aria-label="Switch branch"` to the trigger Button rather than visible duplicate text. The empty/'Not Selected' state already lives in BranchSelector (lines 53-64), so nothing is lost. Use the reclaimed left-side space for the page/subContext wayfinding breadcrumb.

### 60. 🟠 Dashboard queue/results links are duplicated across cards and three labels ('View Queue'/'View Admissions'/'Visit Queue') resolve to the identical /clinic/queue route

**HIGH** · Redundancy & Altitude · redundancy · effort S · seen 2× (Staff Dashboard / Home)

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** Several dashboard actions appear twice and several distinct labels share one destination. 'Enter Results' is both a Pending-Lab-Results card button (164-168) and a Quick-Action tile (233-238, same /diagnostics/pending). The clinic queue is linked three times with three labels but one destination: 'View Queue' (186), 'View Admissions' (207), 'Visit Queue' (240) all → /clinic/queue — and 'View Admissions' implies an IP-only view that doesn't exist. New Diagnostic/Clinic Visit tiles also duplicate the sidebar.
- **Fix:** Make each control map to a distinct destination-or-state. Delete the duplicate 'Enter Results'/'Visit Queue' Quick-Action tiles (the card CTAs are canonical); keep create flows only in Quick Actions. For the queue: if /clinic/queue can filter, deep-link 'View OP Queue' → ?type=OP and 'View IP Admissions' → ?type=IP so differing labels map to differing states; if it can't filter, use one honest verb ('View Queue') on both since identical destinations shouldn't wear different verbs.

### 61. 🟠 Owner/Admin Manage* pages have no shared table/page/form primitives — every tab copy-pastes thead/tbody styling, header/search/empty/loading scaffold, and uses three different create/edit containers

**HIGH** · Redundancy & Altitude · consistency · effort L · seen 3× (Owner Money / Doctors / Operations, Owner Config & Management Pages)

- **Files:** `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManageDepartments.tsx`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`
- **Problem:** The same management chrome is copy-pasted with drift across the AdminConfigCenter tabs. Five hand-rolled tables repeat the identical inline `<thead><tr style={{ color: TOKENS.textTertiary,... }}>` + `borderTop: '0.5px solid '+TOKENS.border` row styling (OwnerMoneyPage, OwnerDoctorsPage, OwnerOperationsPage). Each tab also reimplements the same header (h2 + icon + muted subtitle + size='sm' New button), search, empty, loading and footer scaffold (ManageBillableProducts:479-489, ManagePanelDefinitions:844-854, ManageClinicalDefinitions:702-714, ManageDepartments, ManageSigningDoctors) with subtle drift. And the add/edit affordance differs per tab for no functional reason — Products/Departments/Clinical-Defs/Panels open a modal Dialog while sibling tabs use an inline panel.
- **Fix:** Extract shared primitives: a `<DataTable>` (token-styled thead/row), a `<ManagePageScaffold>` (header + search + empty + loading + footer), and one canonical create/edit container (pick modal Dialog OR inline drawer and use it for every tab). Migrate all Manage*/owner tables onto them so styling and behavior stop drifting.

### 62. 🟠 Unreferenced dead/legacy components still ship in the tree (NavLink, TestSelector, ManageDoctors/ManageClinicDoctors/ManageDiagnosticCenters)

**HIGH** · Redundancy & Altitude · redundancy · effort S · seen 3× (Auth & App Shell, Diagnostics Editors & Selectors, Owner Config & Management Pages)

- **Files:** `health-hub/src/components/NavLink.tsx`, `health-hub/src/components/diagnostics/TestSelector.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`, `health-hub/src/pages/owner/ManageDoctors.tsx`, `health-hub/src/pages/owner/ManageClinicDoctors.tsx`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx`, `health-hub/src/App.tsx`
- **Problem:** Several components are imported nowhere yet remain. `components/NavLink.tsx` (a Link wrapper with activeClassName/pendingClassName) has zero importers — the sidebar uses plain react-router Link with manual isActive logic. `components/diagnostics/TestSelector.tsx` (283 lines) is a near-identical earlier copy of ProductSelector with zero importers and divergent behavior (groups by department, priceInPaise/100 vs effectivePrice, no quick-add). And ManageDoctors/ManageClinicDoctors/ManageDiagnosticCenters are explicitly documented as replaced by the unified ManageDoctorsAndReferrals, yet still contain debug console.logs.
- **Fix:** Delete NavLink.tsx, TestSelector.tsx (+ its local LabTest interface), and the three legacy Manage* pages, then run `tsc`/build to confirm no dangling references. Add a CI lint (knip / ts-prune / eslint no-unused) so orphaned components are caught automatically instead of by manual audit. (ProductSelector is the strict superset of TestSelector — no salvage value.)

### 63. 🟠 Primary actions sit 4th on the page, below three KPI cards

**HIGH** · Redundancy & Altitude · visual-hierarchy · effort M · seen 1× (Staff Dashboard / Home)

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** Page order is: header (138-141), three large metric cards (150-213), THEN the Quick Actions card (215-247). A front-desk user's primary intent on landing is to start a new visit, not to read KPIs. The actions a speed user needs are pushed below the fold behind passive read-only metrics.
- **Fix:** Promote the two create actions specifically. Add a compact action bar directly under the h1 (line 141) using existing branch-accent button styling, e.g. a flex row with primary "New Diagnostic Visit" (to /diagnostics/new) and "New Clinic Visit" (to /clinic/new), with "New Diagnostic Visit" as variant="default" (filled, branch accent) to mark it the dominant action. Keep the KPI cards where they are since they already carry contextual deep-link buttons (Enter Results / View Queue), but DROP the now-redundant "New Diagnostic Visit" / "New Clinic Visit" tiles from the Quick Actions grid (222, 228) to avoid duplicate create entry points, leaving Quick Actions for the secondary "Enter Results" / "Visit Queue" navigation only. This fixes both the hierarchy issue and a latent redundancy. Effort S-M.

### 64. 🟠 'Pending Work' / 'All Clear' card adds no information

**HIGH** · Redundancy & Altitude · data-density · effort S · seen 1× (Staff Dashboard / Home)

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** The bottom card (301-328) only restates what the three KPI cards already show: when there is work it says 'There are items requiring attention. Check pending results and patient queues above.' and when not, 'Operations are running smoothly.' It contains no counts, no list of which items, and no link — it tells the user to scroll back UP to the cards they just read.
- **Fix:** Best option: delete the card entirely (301-328). The three accent/warning-styled KPI cards (150-213) already signal status — the top "Pending Lab Results" card even turns warning-colored at line 151 — so a separate status banner is pure duplication and pushes content down. If the team wants a summary band, replace the prose with a compact, conditional alert that renders ONLY when hasPendingWork is true (suppress the "All Clear" state — an empty dashboard with zero-count cards already communicates calm), using shadcn Alert with an inline actionable list built from the already-computed metrics, e.g. map non-zero values to linked rows: `{metrics.pendingResults.length > 0 && <Link to="/diagnostics/pending">{metrics.pendingResults.length} reports awaiting entry</Link>}`, `{metrics.waitingOP.length > 0 && <Link to="/clinic/queue">{metrics.waitingOP.length} OP patients waiting</Link>}`, etc. Move this above the KPI grid, not below it, so the "items requiring attention" sit at the top of the scan path rather than the bottom.

### 65. 🟠 Two full owner dashboards ship simultaneously with conflicting visual languages

**HIGH** · Redundancy & Altitude · consistency · effort L · seen 1× (Owner & Doctor Dashboards)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/OwnerDashboard.tsx`, `health-hub/src/App.tsx`
- **Problem:** `/owner` renders OwnerDashboardV2 and `/owner/legacy` renders OwnerDashboard (App.tsx:155-163), and the two are designed in completely different idioms. Legacy uses shadcn Card/Badge/Alert, recharts (ComposedChart/BarChart, OwnerDashboard.tsx:15-26), a dark gradient hero `bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800` (line 788), 3xl bold headings, and rounded-3xl/28px radii. V2 uses 12px-radius flat cards, hand-rolled SVG charts, a muted off-white page, 20px medium headings, and the inline TOKENS palette. They also disagree on terminology: legacy 'Decision-First Owner Dashboard' / 'Revenue trend' vs V2 'Owner overview' / 'Revenue trend · 30 days'. Anyone landing on the legacy URL (still reachable, still wrapped in tabs/links elsewhere) sees a visually unrelated product. Maintaining both doubles the surface for drift.
- **Fix:** Pick V2 as canonical and remove the legacy surface: delete OwnerDashboard.tsx and replace the /owner/legacy route with a hard redirect to /owner (`<Route path="/owner/legacy" element={<Navigate to="/owner" replace />} />`) so any stale bookmark resolves to the real product. Correct the premise: there are NO in-app links to /owner/legacy, so no nav/tab cleanup is needed — the page is simply orphaned-but-routed. If the recharts visuals (doctor-contribution, anomaly band) are still wanted, port those specific charts into V2 rather than retaining a parallel page. Separately, while consolidating, fix V2's own token violation: replace the inline hardcoded-hex TOKENS object (OwnerDashboardV2.tsx:119-141) with the project's CSS-var design tokens from index.css/tailwind.config.ts so the canonical dashboard actually honors per-branch accent theming — otherwise V2 will drift from the rest of the app the same way legacy did.

### 66. 🟡 Page h1 merely restates the active nav label, adding no information while the only context strip shows just 'Branch:' (redundant titles)

**MEDIUM** · Redundancy & Altitude · redundancy · effort S · seen 2× (Diagnostics Workflow, LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsReportPreview.tsx`, `health-hub/src/components/layout/ContextBanner.tsx`, `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`
- **Problem:** Above the content the ContextBanner shows only 'Branch: <name>' (ContextBanner.tsx:14-16) with no section/page context, and then each page's h1 just repeats the nav word: 'Dashboard' (Dashboard.tsx:139), 'Pending Results' (DiagnosticsPendingResults.tsx:282), 'Visit Queue' (ClinicVisitQueue), 'Finalized Reports' (DiagnosticsFinalizedReports:195) — which on Finalized/Pending is compounded by a second CardTitle restating the same words plus a count ('Finalized Reports (N)' / 'Result Queue (N)'). The sidebar active item and banner already establish location, so the h1 is pure repetition.
- **Fix:** Let the shared PageHeader/breadcrumb carry location and free each page's h1 to add value (counts, scope, date) instead of echoing the nav. Where a CardTitle duplicates the h1, reduce it to just the count/filters (e.g. header row 'Finalized Reports · 12', card header carries only filters/actions).

### 67. 🟡 Visit-created success screen is verbose, exclamatory, and pushes the next action down

**MEDIUM** · Redundancy & Altitude · data-density · effort M · seen 1× (Diagnostics Workflow)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** After every single registration, the entire viewport is replaced by a centered success card: a 64px check icon, `<h2 ...>Visit Created Successfully!</h2>` (DiagnosticsNewVisit.tsx:1080-1083), then a 6-row key/value block (Bill #, Payment Status, Final Total, Due, Visit Status, sometimes Report Flow + Referred By) and three full-width stacked buttons (Print Bill / Create Another Visit / View Pending Results). For a front-desk role processing dozens of patients an hour, this full-page interstitial with celebratory copy and an oversized icon is friction on every bill.
- **Fix:** Make this a compact confirmation: smaller icon, drop the exclamation, collapse the detail rows into one or two lines (Bill # + total + due), and make 'Create Another Visit' the clear primary. Consider a toast + inline summary banner instead of a full screen takeover so staff can immediately start the next patient with the form still visible.

### 68. 🟡 'Read-Only' is repeated 5+ times on the Patient 360 view (redundant noise)

**MEDIUM** · Redundancy & Altitude · redundancy · effort S · seen 1× (Clinic & Patient 360)

- **Files:** `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** Patient 360 hammers 'Read-Only' everywhere: header banner pill 'Read-Only' (Patient360.tsx:460-463), Financial Summary card badge 'Read-Only' (531-533), the footer paragraph 'This is a complete, read-only record…' (716-720), the visit drawer title badge 'Read-Only' (195-197), and the drawer's full Lock-icon 'Read-Only View' panel (336-345). Meanwhile the Patient Identity card IS editable (PatientEditDialog at 472) and the visit drawer offers Print/WhatsApp/Print-Bill actions — so the blanket 'read-only' messaging is both repetitive and partly inaccurate, undermining trust in the labeling.
- **Fix:** State read-only once, authoritatively — keep the single header banner pill and remove the duplicate Financial-Summary badge and the footer sentence. In the visit drawer, replace the redundant title badge + bottom Lock panel with one concise line, and reword so it's clear that *history is read-only but you can still print/share* (the current drawer literally says 'No changes can be made' while exposing Print Bill / WhatsApp).

### 69. ⚪ Search-result cards are low-density: one tall card per patient with verbose History Snapshot

**LOW** · Redundancy & Altitude · data-density · effort M · seen 1× (Clinic & Patient 360)

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** Each result is a full Card with a CardHeader, a muted 'HISTORY SNAPSHOT' sub-box listing up to 3 visits with '• Diagnostic Visit — Branch — Date' rows, plus a full-width 'View Patient 360' button (GlobalPatientSearch.tsx:172-241). With several matches the user must scroll a lot to compare patients; the primary disambiguators (name, phone, age/gender) compete visually with the snapshot. The whole card is also not clickable — only the bottom button navigates, so a fast front-desk user can't just click the row.
- **Fix:** Tighten to a compact result row: name + age/gender + phone + patientNumber on one line, a single-line 'last visit: <type> · <branch> · <date>' summary, and make the entire card clickable to open Patient 360 (keep the explicit button for discoverability but add an onClick + hover state on the Card and role/tabindex for keyboard). Reserve the full snapshot for the 360 page itself.

### 70. ⚪ Rows expose both a Status badge and a Switch (and a delete) doing overlapping jobs

**LOW** · Redundancy & Altitude · redundancy · effort S · seen 1× (Owner Config & Management Pages)

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`
- **Problem:** Products and Panels rows show an Active/Inactive Badge in a Status column AND an Active Switch in the Actions cluster that controls the same isActive flag (ManageBillableProducts.tsx:554-557 badge + 570-574 switch; ManagePanelDefinitions.tsx:904-908 badge + 920-924 switch). The badge is purely redundant readout of the switch sitting two columns over. In Clinical Definitions the Switch's only meaning ('Visible in clinical forms') is conveyed solely via a title tooltip (line 871) with no visible label, so its purpose is unclear next to the separate Status badge.
- **Fix:** Keep the inline Switch as the single source of truth and drop the redundant Status badge column (or vice-versa). For the Definitions visibility switch, add a small visible label or move it to a clearly-labeled column header so its distinct meaning is obvious.

### 71. ⚪ Doctor name and period are repeated three times in the detail header + summary cards

**LOW** · Redundancy & Altitude · redundancy · effort S · seen 1× (Payouts)

- **Files:** `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** On the detail page the doctor name appears in the page subtitle (PayoutDetail.tsx:276 `{payout.doctorName} • {period}`) and again as a full summary card ('Doctor' card, 327-333), and the period appears in that same subtitle (276) AND as its own 'Period' summary card (344-347). The first summary card essentially restates the header. This burns one of four card slots and adds redundancy without new information; the doctor-type Badge is the only net-new datum in that card.
- **Fix:** Drop the redundant 'Doctor' and/or 'Period' summary cards (already in the subtitle) and reallocate the space — e.g. surface the type badge inline next to the title, and use the freed card slots for higher-value metrics (line-item count, average commission, or paid date). Keep the four-card grid balanced.

## Forms & Operator Speed

### 72. 🔴 Visible filters that don't actually filter — Doctor dashboard Date filter is never applied, and the Payouts By-Doctor tab ignores the Status/Doctor filters shown above it

**CRITICAL** · Forms & Operator Speed · interaction-feedback · effort M · seen 2× (Owner & Doctor Dashboards, Payouts)

- **Files:** `health-hub/src/pages/doctor/DoctorDashboard.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/PayoutsByDoctor.tsx`
- **Problem:** Filters are rendered prominently but not wired into the query. DoctorDashboard shows a 'Date' Select (Today/Yesterday/This Week, 74-86) bound to `dateFilter`, but `filteredReports` only ever filters on `search` — `dateFilter` is never read (52-60), so changing it does nothing. On Payouts, switching to the By-Doctor tab (PayoutsList.tsx:655-673) keeps the Type/Doctor/Status filter row on screen but only passes `doctorType`,`startDate`,`endDate`,`q` down (657-662) — the Status (Pending/Paid) and Doctor/Center filters are silently ignored, so the visible filter state lies about what's shown.
- **Fix:** Either apply each visible filter to the underlying data, or hide/disable filters that don't apply to the current view. Wire `dateFilter` into DoctorDashboard's filter predicate; pass Status and Doctor/Center through to the By-Doctor tab (or gray them out with a note when that tab can't honor them) so the visible controls always match the rendered results.

### 73. 🟠 Bill Number search input on New Visit does nothing

**HIGH** · Forms & Operator Speed · interaction-feedback · effort M · seen 1× (Diagnostics Workflow)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The Patient Lookup card renders a second field: `<Label htmlFor="bill">Bill Number (optional)</Label>` bound to `billSearch` (DiagnosticsNewVisit.tsx:1304-1312, state at :99). `billSearch` is written by onChange but never read anywhere — `handleSearch` (:464) and the whole submit path ignore it. Typing a bill number and pressing Enter or clicking Search has zero effect.
- **Fix:** Either wire `billSearch` into the lookup (search visits/patients by bill number and populate matches) or remove the field entirely. If kept as a stub, hide it behind a feature flag rather than shipping a visibly inert input.

### 74. 🟠 Split-payment amounts do string arithmetic, breaking the live cash/online feedback

**HIGH** · Forms & Operator Speed · interaction-feedback · effort S · seen 1× (Clinic & Patient 360)

- **Files:** `health-hub/src/pages/clinic/ClinicNewVisit.tsx`
- **Problem:** `consultationFee` is a string state (initialized `useState(DEFAULT_CONSULTATION_FEE)` = '500'). When SPLIT is chosen, `setSplitAmounts({ cash: consultationFee, online: 0 })` stores the STRING '500' as cash (ClinicNewVisit.tsx:1165), and the auto-balancing uses `consultationFee - cash` (1196) and `consultationFee - online` (1210). String-minus-number coerces unpredictably (e.g. '500' - 100 = 400 works, but the initial cash field shows the raw string and any concatenation paths misbehave), and `Math.max(0, '500' - cash)` is fragile. The user sees an inconsistent/incorrect split breakdown — direct feedback corruption at the point of taking money.
- **Fix:** Parse the fee once and use a number everywhere. Add `const feeNum = Number.parseInt(consultationFee, 10) || 0;` (you already compute `parsedConsultationFee` at line 427 — reuse/lift that). Then: line 1165 -> `setSplitAmounts({ cash: feeNum, online: 0 })`; line 1196 -> `online: Math.max(0, feeNum - cash)`; line 1210 -> `cash: Math.max(0, feeNum - online)`. This guarantees `splitAmounts.cash`/`online` are always numbers, fixing the string-typed amount sent at line 464. Additionally, since the fee Input is editable, re-seed `splitAmounts` when `consultationFee` changes while SPLIT is active (e.g. an effect or in the fee onChange) so the split doesn't go stale against the new total. Finally, add a validation hint when `splitAmounts.cash + splitAmounts.online !== feeNum` so reception can't under/over-allocate, and block submit in that case.

### 75. 🟡 Rich-text editing relies entirely on deprecated document.execCommand with no keyboard shortcuts

**MEDIUM** · Forms & Operator Speed · interaction-feedback · effort M · seen 1× (Diagnostics Editors & Selectors)

- **Files:** `health-hub/src/components/diagnostics/RichTextSurface.tsx`, `health-hub/src/components/diagnostics/RichTextToolbar.tsx`
- **Problem:** All formatting goes through `commandDocument.execCommand(command, false, valueArg)` (RichTextSurface.tsx line 224), a long-deprecated, inconsistently-implemented API (the font-size path even has to post-process `<font size>` legacy tags back into spans, lines 240-250 — a sign of the API's fragility). Doctors writing narrative reports get no Ctrl/Cmd+B/I/U shortcuts wired through the surface (the toolbar is mouse-only via onMouseDown), and there is no onKeyDown shortcut handling on the contentEditable. For a keyboard-heavy Indian front-desk/doctor audience, mouse-only bold/italic in a long-form editor is notable friction.
- **Fix:** Add a keydown handler on the RichTextSurface that maps Ctrl/Cmd+B/I/U (and optionally Ctrl+Z/Y) to `runCommand('bold'|'italic'|'underline')`, and surface those shortcuts in the toolbar button `title`s (e.g. title="Bold (Ctrl+B)"). Longer term, migrate off execCommand to a maintained editor (Tiptap/Lexical), but shortcut support is the high-value near-term fix.

### 76. 🟡 Enter-to-advance silently no-ops with an empty selection, with no on-screen affordance

**MEDIUM** · Forms & Operator Speed · microcopy · effort S · seen 1× (Diagnostics Editors & Selectors)

- **Files:** `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** handleKeyDown only advances (`onDone()`) when the search is empty AND `selectedProductIds.length > 0` (lines 220-227); otherwise Enter does nothing. The reasoning is sound (the billing section isn't rendered yet), but there is no visible button or hint for advancing — the only way forward is an undiscoverable empty-input Enter, and pressing it with zero selections gives no feedback (no toast, no shake, nothing). New front-desk staff have no way to learn the flow. The empty state text 'Start typing to search and add tests, panels, or bill-only items.' (line 438) never mentions Enter-to-continue.
- **Fix:** Add a visible primary 'Continue' / 'Next →' button (disabled with a tooltip 'Add at least one item' when selection is empty) so advancing is discoverable and the disabled reason is explicit; keep the Enter shortcut as an accelerator and mention it in helper text.

### 77. 🟡 Phone/Name search toggle is two full-width buttons instead of a Tabs/SegmentedControl

**MEDIUM** · Forms & Operator Speed · interaction-feedback · effort S · seen 1× (Clinic & Patient 360)

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** The search-type selector (GlobalPatientSearch.tsx:102-119) is two equally-weighted `flex-1` Buttons ('Search by Phone (recommended)' default vs 'Search by Name' outline). This is a mutually-exclusive choice (a toggle), but rendering it as two large competing primary/outline buttons reads as two separate actions, eats vertical space, and the '(recommended)' microcopy crammed into the button label is awkward. There is also no semantic grouping (no role=tablist / radiogroup), so screen readers announce two unrelated buttons.
- **Fix:** Use shadcn `Tabs` (TabsList/TabsTrigger 'Phone' | 'Name') or a Toggle/segmented control above the input — visually a single control with two segments. Move '(recommended)' out of the label into helper text or a small Badge. This compresses the form and gives correct tab/radio semantics.

### 78. 🟡 Doctor leaderboard is sort-locked to net and dumps up to all rows with no sort/filter/sticky header

**MEDIUM** · Forms & Operator Speed · data-density · effort L · seen 1× (Owner Money / Doctors / Operations)

- **Files:** `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`
- **Problem:** LeaderboardCard (lines 83-220) is fixed-sorted by net descending (description line 89) with only a 'show top 25 / show all (N)' toggle (lines 91-104). An owner cannot sort by Owed, Commission, Rate, or Visits — the columns that drive payout decisions — nor filter to referral-only / active-only, and 'show all' can render a very long, un-paginated table with a non-sticky header so the column meanings scroll off. Inactive doctors are only signaled by `opacity: 0.6` (line 137), another color/opacity-only cue with no toggle to hide them.
- **Fix:** Make column headers clickable to sort (with an aria-sort indicator), add a sticky `thead`, and add quick filters (type: referral/clinic; active only; owed > 0). Reuse the extracted OwnerTable primitive so sorting is shared with the other tables.

### 79. 🟡 Search inputs are inconsistent: client-filter vs server-filter, icon offsets differ, max-widths differ

**MEDIUM** · Forms & Operator Speed · consistency · effort M · seen 1× (Owner Config & Management Pages)

- **Files:** `health-hub/src/pages/owner/ManageDepartments.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx`
- **Problem:** Search behaves differently per tab. Departments and Signing-Doctors filter client-side on already-loaded data (ManageDepartments.tsx:254-258, ManageSigningDoctors.tsx:679-684). Products/Panels/Clinical-Defs send the query to the server on every keystroke with NO debounce — search state is in the fetch dependency array (ManageBillableProducts.tsx:160-174 fetchProducts depends on search; ManageClinicalDefinitions.tsx:272-286), so each character triggers a network request. Even the search box styling drifts: icon left-2 (Products:493, Panels:858) vs left-2.5 (Departments:285, Signing:711), and container max-w-md vs max-w-sm.
- **Fix:** Standardize on a debounced (300-400ms) search hook reused everywhere, decide client-vs-server per dataset size and document it, and use one shared SearchInput component with fixed icon offset and width.

### 80. 🟡 Clinical Definition dialog shows two separate 'Critical Values' switches bound to one state

**MEDIUM** · Forms & Operator Speed · interaction-feedback · effort S · seen 1× (Owner Config & Management Pages)

- **Files:** `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`
- **Problem:** Inside the same definition dialog there are two distinct 'Critical Values' switches in two different accordion sections, both bound to the single formShowCritical state: one in 'General Reference Range' (id=critical-toggle-general, line 996-1001) and one in 'Age/Gender Specific Ranges' (id=critical-toggle-ranges, line 1092-1097). Toggling either flips both, and only the second section's switch actually gates whether critical columns render in the range grid. A user toggling the General one will see the Age/Gender grid columns appear/disappear unexpectedly.
- **Fix:** Use a single labeled 'Show critical values' control at the dialog level (e.g. in the header) rather than duplicating it in two sections, or give each section independent critical-enable state if they are meant to differ.

### 81. 🟡 Panel save swaps Name and Code into the wrong API fields, contradicting the form labels

**MEDIUM** · Forms & Operator Speed · information-architecture · effort M · seen 1× (Owner Config & Management Pages)

- **Files:** `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`
- **Problem:** The form shows 'Name *' bound to formName and 'Code *' bound to formCode (lines 959-960, 963-967). But handleSave sends name: formCode.trim() and displayName: formName.trim() (lines 715-716) — i.e. the human-entered Name is stored as displayName and the Code is stored as name. The list table then renders panel.name as the 'Name' column (line 893) and panel.code as 'Code' (line 891). This label/field inversion is a latent data-integrity/comprehension trap and makes the page's mental model (what is 'name'?) inconsistent with every other entity here where name == display name.
- **Fix:** Align field semantics with labels: send name from formName and code from formCode (or rename the backing fields). At minimum add a comment, but ideally normalize so 'Name' always maps to the display name across products/panels/definitions.

### 82. 🟡 Custom date range on the list has no start≤end validation or feedback (dialog has it, list doesn't)

**MEDIUM** · Forms & Operator Speed · error-handling · effort S · seen 1× (Payouts)

- **Files:** `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/DerivePayoutDialog.tsx`
- **Problem:** The custom-range inputs (PayoutsList.tsx:444-460) feed straight into effectiveRange and the fetch with no guard. A user can set startDate after endDate and the list silently fetches an inverted range, returning an empty table with the generic 'No payouts match your filters' message — no hint that the dates are reversed. The single-derive dialog gets this right (DerivePayoutDialog.tsx:92-95 toasts 'Start date must be before end date'), so the behavior is inconsistent within the same module. The date inputs also lack `min`/`max` cross-bounds.
- **Fix:** Add a min/max relationship on the two date inputs (`max={state.endDate}` on start, `min={state.startDate}` on end) and/or an inline validation message + skip the fetch when start>end, mirroring the dialog's check.

### 83. ⚪ Create-Another-Visit reset drops the title field, leaving stale title state

**LOW** · Forms & Operator Speed · error-handling · effort S · seen 1× (Diagnostics Workflow)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The success screen's 'Create Another Visit' handler resets newPatient with an object literal that omits `title`: `setNewPatient({ name: "", age: "", ageUnit: "YEARS", dateOfBirth: "", gender: "M", whatsappOptIn: true })` (DiagnosticsNewVisit.tsx:1196-1203), whereas the initial state (:129-137) includes `title: ""`. The previous patient's title is therefore not cleared on reset.
- **Fix:** Include `title: ""` in the reset object (and consider extracting an `INITIAL_NEW_PATIENT` constant reused by both the initial state and the reset to prevent future drift).

### 84. ⚪ Preset value rows allow blank/duplicate entries with no inline validation

**LOW** · Forms & Operator Speed · error-handling · effort S · seen 1× (Diagnostics Editors & Selectors)

- **Files:** `health-hub/src/components/diagnostics/TestInputConfigEditor.tsx`
- **Problem:** `addOption` pushes an empty string (line 58) and `setOption` allows any text including blanks and duplicates of existing presets. Blanks/dupes are only silently dropped on save (cleanedOptions filter, line 383; bulk dedupe at lines 78-87) — but the manual add/edit path gives no inline feedback, so an admin can create three empty rows or two 'Positive' rows and only discover they vanished after saving. The bulk-paste path dedupes but the single-add path does not, an inconsistency.
- **Fix:** Mark empty/duplicate option Inputs with a destructive border + a small inline hint (e.g. 'Blank values are ignored' / 'Duplicate'), and consider disabling Add while the last row is still empty, so the validation behavior is visible before save rather than a surprise after.

### 85. ⚪ Preset option list keyed by array index, breaking drag-reorder identity and focus retention

**LOW** · Forms & Operator Speed · interaction-feedback · effort M · seen 1× (Diagnostics Editors & Selectors)

- **Files:** `health-hub/src/components/diagnostics/TestInputConfigEditor.tsx`
- **Problem:** The editable preset list uses `key={idx}` (line 167) on `<li>` rows that are also draggable/reorderable (reorder at lines 65-71). With index keys, reordering or deleting a row makes React reuse DOM nodes by position rather than identity, so the currently-focused input or in-progress text can jump to a different value after a drag/delete, and drag animations are janky. Drag is also mouse-only — no keyboard reorder affordance despite the otherwise keyboard-conscious app.
- **Fix:** Key rows by a stable id (assign a uid when adding an option, or at minimum `key={`${idx}-${opt}`}` as a stopgap). Add keyboard reorder (e.g. Alt+ArrowUp/Down on the focused row) or a small up/down button pair for non-pointer users.

## Navigation & Wayfinding

### 86. 🔴 Multiple distinct routes collapse to one component that never reads the pathname (Money: /money/bills|cash|discounts; Ops: /ops/queue|pending|audit)

**CRITICAL** · Navigation & Wayfinding · navigation · effort L · seen 3× (Owner Money / Doctors / Operations, LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/App.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** App.tsx:165-179 wires `/money/bills`, `/money/cash`, `/money/discounts` all to `<OwnerMoneyPage/>`, and App.tsx:190-203 wires `/ops/queue`, `/ops/pending`, `/ops/audit` all to `<OwnerOperationsPage/>`. Neither page reads `useLocation`/`pathname` (grep returns nothing), so every URL renders the identical screen with a fixed header ('Money' / Operations) regardless of which sub-section the user navigated to — the URL implies distinct sub-pages that don't exist. Additionally `/ops/pending` has no sidebar entry at all (Sidebar.tsx:74-75 lists only Live queue and Audit & alerts), so it is a reachable-only-by-deep-link orphan.
- **Fix:** Decide per area: either (a) read the pathname and render a distinct sub-view/tab/filtered state per route (e.g. Money bills vs cash vs discounts; Ops queue vs pending vs audit), updating the page header to name the active sub-section; or (b) collapse to a single canonical route plus in-page tabs and delete the redundant routes. Either way, remove orphan routes with no nav entry (or add the nav entry for /ops/pending). Update the sidebar so each nav destination maps to a distinct, honest URL+state.

### 87. 🔴 Patient search / Patient 360 is absent from the dashboard entirely

**CRITICAL** · Navigation & Wayfinding · information-architecture · effort M · seen 1× (Staff Dashboard / Home)

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/App.tsx`
- **Problem:** Patient lookup is a core, high-frequency front-desk action (it has its own top-level sidebar entry 'Patient 360' → '/clinic/patient-search', Sidebar.tsx:127-133, and route App.tsx:136). Yet the Dashboard never surfaces it: the Quick Actions grid (Dashboard.tsx:220-245) only contains New Diagnostic Visit, New Clinic Visit, Enter Results, and Visit Queue. A staff member who lands on the home page to find an existing patient has zero one-click path and must locate the sidebar item.
- **Fix:** Both fixes are good; prefer doing both. (1) Add an autofocused search field at the top of the dashboard that on Enter navigates to /clinic/patient-search?q={query} (and update PatientSearch to read the q param), giving true keyboard-first lookup: land on home → type → Enter. (2) Add a fifth 'Patient 360' tile to the Quick Actions grid — the grid is already responsive (md:grid-cols-2 lg:grid-cols-4 at Dashboard.tsx:220), so a 5th item wraps to a balanced 4+1 / 2+2+1 without a layout rework; reuse the same Users icon and btn-branch-outline styling as the existing tiles and link to /clinic/patient-search. Note the Visit Queue tile reuses the Users icon, so give the new Patient 360 tile a distinct icon (e.g. lucide Search or UserSearch) to avoid icon collision in the grid.

### 88. 🔴 Branch performance rows link to /branches/:id, which is not a route (lands on NotFound)

**CRITICAL** · Navigation & Wayfinding · navigation · effort S · seen 1× (Owner & Doctor Dashboards)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/App.tsx`
- **Problem:** Every branch name in the performance table is a link: `<Link to={`/branches/${r.branchId}`}>` (OwnerDashboardV2.tsx:883). There is no `/branches/:branchId` (or any `/branches/...`) route in App.tsx — the only matching route is the catch-all `<Route path="*" element={<NotFound />} />` (App.tsx:237). So clicking the most prominent drill-down in the table — the owner's primary 'where do I intervene' affordance — silently dumps them on a 404. The links are also styled blue (`color: TOKENS.info`) signaling they work.
- **Fix:** Repoint to the existing branch-scoped dashboard the page already supports: `to={`/owner?branch=${r.branchId}`}`. Note that the branch filter (lines 952-957) keys on the value used by the branch selector — confirm whether it expects `branchId` or `branchCode` and pass the matching field so the filter actually resolves (a mismatched id would render an empty/unfiltered view rather than 404, which is still a defect). Do NOT just style-disable the link without a target: a non-navigable branch name in a "where do I intervene" table is itself a missed affordance. Preferred long-term fix is a real `/owner/branches/:branchId` detail route. Also avoid the inline `style={{ color: TOKENS.info }}` link styling in favor of a shared link/button-link component so dead vs. live links are visually consistent app-wide.

### 89. 🟠 AppLayout's `context`/`subContext` props are passed by every page but never rendered (dead wayfinding API)

**HIGH** · Navigation & Wayfinding · information-architecture · effort M · seen 3× (Auth & App Shell, Clinic & Patient 360, LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/components/layout/AppLayout.tsx`, `health-hub/src/components/layout/ContextBanner.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`, `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** AppLayout's signature is `AppLayout({ children, context, subContext, hideContextBanner })` (AppLayout.tsx:14) but the body (lines 22-38) never reads `context` or `subContext` — ContextBanner is rendered with no props and only reads the branch store. ~6 pages are forced to pass meaningful wayfinding strings that are silently discarded: `subContext="Global Patient Search"` (GlobalPatientSearch.tsx:88), `subContext="Patient 360"` (Patient360.tsx:411/421/442), `subContext="Reception"` (ClinicNewVisit.tsx:548, ClinicVisitQueue.tsx:215), plus owner pages PayoutsList/PayoutDetail. The intended section/page wayfinding is wired up at every call site but never reaches the screen.
- **Fix:** Render the props (normalized, not raw). Pass `context`/`subContext` into ContextBanner and render a breadcrumb/section label on the LEFT of the banner: a humanized `context` ('Clinic'/'Owner'/'Diagnostics') + `<ChevronRight className="size-3"/>` + `subContext`, with `aria-current` semantics. Audit call-site labels first: title-case route keys ('payouts' → 'Payouts') and fix the misleading 'Reception' label on ClinicVisitQueue.tsx:215 (it is the Visit Queue). This restores wayfinding and lets the BranchSelector carry branch identity (freeing the redundant static 'Branch:' text). Prefer rendering over deleting — the labels already exist; this is the data source for the shared PageHeader breadcrumb.

### 90. 🟠 Owner and staff see the same workflows at radically different depths and labels

**HIGH** · Navigation & Wayfinding · information-architecture · effort L · seen 1× (LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** ownerNavItems and staffNavItems (Sidebar.tsx:46-173) are entirely separate trees with overlapping destinations placed differently. Patient 360 is a TOP-LEVEL item for staff (line 128) but for owners it is buried two levels deep under Operations › Workflows (lines 77-81). The diagnostics workflow is a clean 'Diagnostics' group for staff (lines 135-152: New Visit / Pending Results / Finalized Reports) but for owners those same routes are dumped flat inside the 'Operations' dropdown alongside ops items (lines 82-96). Owners get a 'My Reports' item pointing at /doctor (line 100-104, the doctor dashboard) which staff never see, despite the same route existing.
- **Fix:** Define ONE nav tree as the single source of truth and derive each role's view by filtering on per-item/per-subItem `roles` (the NavItem/NavSubItem interfaces at lines 27-44 already carry a `roles` field, so the filter at lines 187-189 and 212-214 just needs to consume a unified array instead of branching on ownerNavItems vs staffNavItems). Concretely: keep top-level Diagnostics and Clinic groups for BOTH roles with identical labels (pick one casing, e.g. 'New Visit', 'Pending Results', 'Finalized Reports', 'OP / IP Queue'); make Patient 360 top-level for both; keep an owner-only Operations group containing ONLY genuine ops items (Live queue, Audit & alerts); and gate Money/Doctors/Payouts/Admin items with roles:['owner']. This removes the duplicate label drift and gives the owner one-click access to the operational tasks they actually perform, while collapsing two IAs into one.

### 91. 🟡 Sidebar parent group rows look clickable but aren't (rendered as <div>), and the active state relies on a CSS var with no contrast guarantee / no aria-current

**MEDIUM** · Navigation & Wayfinding · accessibility · effort M · seen 2× (Auth & App Shell, LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** Active nav items are styled only via inline `style={{ backgroundColor: 'var(--branch-sidebar-active)' }}` with `text-white` (Sidebar.tsx:228, 243, 269) — no guaranteed contrast between `--branch-sidebar-active` and white across branch themes, and no `aria-current="page"` on the active Link, so AT users get no programmatic 'current page' cue. Separately, the render logic only emits a `<Link>` for items with zero visible subItems (218-233); items WITH subItems render a non-interactive `<div>` group header (236-247) that highlights when a child is active and visually matches clickable rows — yet the owner 'Operations' item has a real `href: '/ops/queue'` (line 72), so it invites clicks that do nothing.
- **Fix:** Add `aria-current={isActive ? 'page' : undefined}` to nav Links. Ensure `--branch-sidebar-active` meets ≥4.5:1 against white in every branch theme (or pair it with a left accent bar). Make each parent group row a real `<Link>` to its `href` (Operations already has one) so it navigates, or visually de-emphasize it (uppercase section label) so it doesn't read as interactive.

### 92. 🟡 Finalize/Release lives only inside the preview modal with no affordance on the page

**MEDIUM** · Navigation & Wayfinding · navigation · effort S · seen 1× (Diagnostics Workflow)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsReportPreview.tsx`
- **Problem:** On the Report Preview page the only on-page action besides 'Back to Edit' is a secondary 'Preview Report Before Finalization' button (DiagnosticsReportPreview.tsx:978-990); the actual Finalize / Release-Partial buttons are rendered exclusively inside the full-screen preview modal header (:1046-1068). A user who has already reviewed the report on the page itself has no way to finalize without re-opening the modal, and there is no visible hint that finalize lives behind 'Preview'.
- **Fix:** Either label the secondary button to set expectations (e.g. 'Preview & Finalize') or surface a disabled-until-previewed Finalize button on the page itself. At minimum add helper text explaining that finalize happens after the mandatory preview step.

### 93. 🟡 Many real routes have no sidebar entry (orphans) — only reachable via deep links

**MEDIUM** · Navigation & Wayfinding · navigation · effort M · seen 1× (LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/App.tsx`, `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** Mapping App.tsx routes against Sidebar.tsx nav: detail routes /diagnostics/results/:visitId (App.tsx:116), /diagnostics/preview/:visitId (121), /clinic/patient-360/:patientId (141), /owner/payouts/:id (218), /people/doctors/:id (185), and whole pages like /owner/legacy (160), /money/cash (170), /money/discounts (175), /ops/pending (195) have no nav entry. /owner/legacy (the old OwnerDashboard) is fully reachable yet invisible. The staff 'OP / IP Queue' destination /clinic/queue is present, but /clinic/patient-search appears for staff yet has no owner-equivalent top-level entry.
- **Fix:** Audit the route table: delete or feature-flag /owner/legacy; either add Money sub-nav (Bills/Cash/Discounts) so those routes are reachable, or collapse them to query params on one route. Document detail routes as intentionally nav-less.

### 94. ⚪ Empty state tells users to 'clear filters' but the page provides no clear-filters control

**LOW** · Navigation & Wayfinding · navigation · effort S · seen 1× (Payouts)

- **Files:** `health-hub/src/pages/owner/PayoutsList.tsx`
- **Problem:** The filtered empty state advises 'Try widening the date range or clearing filters.' (PayoutsList.tsx:784-785), but there is no Clear/Reset button anywhere on the page — the `reset()` helper exists in usePayoutFiltersFromUrl.ts:109-111 but is never wired up. The user must manually reverse each Type/Doctor/Status/preset/search control. The active-filter detection (hasActiveFilters, 743-751) is already computed, so the trigger condition is known.
- **Fix:** Render a 'Clear filters' button (text or ghost) in the filters row or in the empty state when `hasActiveFilters(state)` is true, calling the existing `reset()` from the filters hook.

### 95. ⚪ Owner nav reuses the same icons for different items (Money & Payouts share WalletCards; Doctors & My Reports share UserRound)

**LOW** · Navigation & Wayfinding · visual-hierarchy · effort S · seen 1× (LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** In ownerNavItems: 'Money' uses icon WalletCards (Sidebar.tsx:56) and 'Payouts' ALSO uses WalletCards (line 108). 'Doctors' uses UserRound (line 63) and 'My Reports' ALSO uses UserRound (line 102). So two pairs of distinct top-level destinations are visually identical at a glance.
- **Fix:** Give each top-level item a unique icon: e.g. Payouts → HandCoins/Receipt, My Reports → FileText/ClipboardList, keeping WalletCards for Money and UserRound for Doctors. Audit the lucide import set (Sidebar.tsx:4-16) for one-icon-per-destination.

## Color System & Tokens

### 96. 🟠 ~354 raw Tailwind palette colors bypass the design-token system across ~30 files (incl. clinic status colors, rich-text editors, legacy dashboard, legal pages)

**HIGH** · Color System & Tokens · branding · effort L · seen 5× (Diagnostics Editors & Selectors, Clinic & Patient 360, Owner & Doctor Dashboards, Print Documents & Legal Pages, LENS: Design System & Visual Consistency)

- **Files:** `health-hub/src/components/diagnostics/RichTextNarrativeEditor.tsx`, `health-hub/src/components/diagnostics/RichTextToolbar.tsx`, `health-hub/src/index.css`, `health-hub/src/pages/clinic/Patient360.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/owner/OwnerDashboard.tsx`, `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/pages/legal/TermsOfService.tsx`, `health-hub/src/pages/legal/DataDeletion.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/components/patient360/PatientEditDialog.tsx`, `health-hub/tailwind.config.ts`
- **Problem:** `grep -rnE "(text|bg|border|ring)-(red|green|blue|amber|...)-[0-9]" src` returns 354 hits; the token palette (success/warning/destructive/muted/foreground) is largely ignored (success token used 8× vs `text/bg-green-600/700` 29×; warning 10× vs amber literals). Concrete instances: Patient360 getStatusColor returns raw `text-green-600`/`text-amber-600`/`text-blue-600` (82-95) and ClinicVisitQueue/ClinicNewVisit payment colors; RichTextNarrativeEditor/Toolbar hardcode `border-slate-200 bg-white`, a literal-hex gradient `bg-[linear-gradient(...#ffffff...)]` and `text-slate-600/900` throughout (so the editor stays bright-white and illegible in dark mode and never reflects the branch accent); the legacy OwnerDashboard scatters `from-slate-950`, `red-50/red-700/emerald-50/emerald-700`, `fill="#dc2626"`; and the three legal pages use `text-gray-900/700/500` + `text-blue-600 underline`.
- **Fix:** Replace raw palette utilities with semantic tokens repo-wide: status colors → `text-success`/`text-warning`/`text-destructive`; surfaces → `bg-card`/`bg-background`/`border-border`; text → `text-foreground`/`text-muted-foreground`; links → `text-primary`. For the rich-text editor specifically: wrapper `border-border bg-card`, toolbar `border-border bg-muted/80`, content `bg-background text-foreground`, placeholder `color: hsl(var(--muted-foreground))`, and a `--ring`-derived focus ring; verify in both light and `.dark`. Add a lint rule (eslint / a custom check) banning `-(red|green|blue|amber|slate|gray)-[0-9]` outside index.css so new off-token colors are caught in CI. Audit token contrast after the swap (see the contrast issues).

### 97. 🟠 Owner area ships a parallel hardcoded-hex `TOKENS` JS object applied via inline styles, duplicated between OwnerDashboardV2 and ownerUi

**HIGH** · Color System & Tokens · consistency · effort L · seen 5× (Owner & Doctor Dashboards, Owner Money / Doctors / Operations, LENS: Design System & Visual Consistency, LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`, `health-hub/src/index.css`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`, `health-hub/src/lib/branchTheme.ts`
- **Problem:** ownerUi.tsx:18-41 defines a hand-maintained `TOKENS` object of raw hex (`healthy:'#0F6E56'`, `critical:'#A32D2D'`, `info:'#185FA5'`, `page:'#FAFAF8'`, `textPrimary:'#1F1F1E'`…) consumed via inline `style={{ color: TOKENS.x }}` everywhere across OwnerMoneyPage/OwnerDoctorsPage/OwnerOperationsPage — a full parallel design system in parallel to index.css/tailwind tokens. OwnerDashboardV2.tsx:117-145 then RE-DECLARES its own private copy of nearly the same object (plus SectionCard/SectionLabel/DisplayNumber/StatRow/MiniBar/formatRupees/formatIstDateTime helpers that ownerUi already exports), so the two copies diverge. None of it reacts to the branch accent or supports dark mode.
- **Fix:** Delete the inline-hex TOKENS mechanism: map each TOKENS key to the equivalent index.css design token (e.g. `healthy`→`--success`, `critical`→`--destructive`, `info`→`--primary`, `textPrimary`→`--foreground`) and convert inline `style={{}}` to Tailwind token classes. First, remove OwnerDashboardV2's private duplicates and import TOKENS/SectionCard/DisplayNumber/formatRupees/etc. from ownerUi as the single source — then migrate ownerUi itself onto the real tokens so the whole owner area follows branch theming and dark mode for free.

### 98. 🟠 Status/type badge system: canonical StatusBadge is underused (7 files) while status pills are re-hardcoded with raw palette, the 'pending' hue is inverted, and `--status-unpaid` has no CSS class / no UNPAID mapping

**HIGH** · Color System & Tokens · branding · effort M · seen 4× (Owner Config & Management Pages, Payouts, LENS: Design System & Visual Consistency)

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`, `health-hub/src/components/payouts/PayoutsTable.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`, `health-hub/src/pages/owner/PayoutRunCycle.tsx`, `health-hub/src/index.css`, `health-hub/tailwind.config.ts`, `health-hub/src/components/ui/status-badge.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** The canonical StatusBadge is imported in only 7 files while status/category pills are reinvented inline with raw palette classes across many: ManageClinicalDefinitions.tsx (`ACTIVE:'bg-green-100 text-green-800'`, `LOCKED:'bg-yellow-100 text-yellow-800'`), ManageBillableProducts/ManagePanelDefinitions Active/Inactive badges (`bg-green-100`/`bg-gray-100`), and the Payouts area which hardcodes its own status colors and even inverts the 'pending' hue (PayoutsTable/PayoutsList/PayoutDetail/PayoutRunCycle). index.css defines theme-aware status tokens (`--status-pending` blue, `--status-paid`/`--success` green, `--status-unpaid`/`--destructive` red) plus `.status-badge`/`.status-pending`/`.status-paid` utilities that go unused; worse, `--status-unpaid` (index.css:57) has NO `.status-unpaid` rule and status-badge.tsx (9-23) maps no UNPAID case.
- **Fix:** Make StatusBadge the single status-pill primitive: add the missing `.status-unpaid` utility and an UNPAID mapping, then replace every inline `bg-*-100 text-*-800` status/type pill (Manage* pages, Payouts) with `<StatusBadge>` driven by the status tokens so 'pending' renders the intended blue everywhere and badges are theme-aware. Add a lint check to block re-introducing inline status pills.

### 99. 🟡 Primary KPI numbers are styled as low-emphasis muted text

**MEDIUM** · Color System & Tokens · visual-hierarchy · effort S · seen 1× (Staff Dashboard / Home)

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** The big count is the single most important datum in each card, yet Waiting OP (181) and Active IP (202) render `text-3xl font-bold text-muted-foreground`, and Pending Lab Results uses text-muted-foreground whenever the count is 0 (160). Using the muted/secondary token for the hero number contradicts its visual weight — a non-zero queue of waiting patients shows in the same de-emphasized gray as the descriptive caption beneath it.
- **Fix:** Use text-foreground for the count when > 0 (reserve muted only for a true zero, if desired). Keep the warning/accent emphasis for actionable thresholds. Captions like 'in queue' stay muted; the number should not.

### 100. 🟡 .dark theme is fully defined and scattered through dark: variants but never activated

**MEDIUM** · Color System & Tokens · consistency · effort M · seen 1× (LENS: Design System & Visual Consistency)

- **Files:** `health-hub/src/index.css`, `health-hub/tailwind.config.ts`, `health-hub/src/pages/owner/OwnerDashboard.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** index.css lines 74-117 define a complete `.dark` token set and tailwind.config.ts line 4 enables `darkMode: ["class"]`, yet there is no ThemeProvider, no theme toggle, and no code that ever adds the `dark` class to the document (grep for classList/documentElement/setTheme manipulation returns nothing). Meanwhile some files sprinkle `dark:` variants (OwnerDashboard.tsx lines 206/213/1037 `dark:border-red-900/60 dark:bg-red-950/40`, ProductSelector.tsx lines 62-66) which can never render. Only 5 of 39 page files have any dark: styling, so even if toggled the app would be broken in dark mode (hundreds of raw `text-gray-900`/`bg-blue-50` have no dark counterpart).
- **Fix:** Decide: if dark mode is not a near-term goal, delete the .dark block, set darkMode off, and strip the scattered dark: variants to remove dead/misleading code. If it is planned, add a ThemeProvider + toggle and convert raw palette colors to tokens first (depends on raw-palette-bypasses-tokens) so dark mode actually works.

### 101. 🟡 CardTitle defaults to text-2xl and is overridden in ~23 call sites

**MEDIUM** · Color System & Tokens · consistency · effort S · seen 1× (LENS: Design System & Visual Consistency)

- **Files:** `health-hub/src/components/ui/card.tsx`
- **Problem:** card.tsx line 19 sets CardTitle to `text-2xl font-semibold leading-none tracking-tight` (the stock shadcn default sized for marketing cards). In a dense dashboard/forms app this is too large, so it is overridden with `text-base/text-lg/text-sm` in ~23 places, meaning the component's default is almost never the intended size and every consumer has to remember to shrink it. text-2xl is also the single most over-large heading in the app.
- **Fix:** Lower the CardTitle default to match the app's actual usage (e.g. `text-base font-semibold leading-none tracking-tight` or text-lg), so most cards need no override and visual rhythm is consistent. Then remove the now-redundant per-card size overrides.

### 102. ⚪ Branch accent color applied inconsistently (icon vs text, with !important overrides)

**LOW** · Color System & Tokens · branding · effort M · seen 1× (Staff Dashboard / Home)

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/index.css`
- **Problem:** var(--branch-accent) is applied ad hoc via inline style across many spots: as icon color on most cards, as the big number color only for Reports Finalized (294-296), and as text color for 'All Clear' (311-312). Quick Action buttons use the .btn-branch-outline utility which forces the accent via `!important` on border AND color (index.css:392-399). The result is no consistent rule for when accent means 'brand chrome' vs 'positive/finalized state', and the !important utility will fight any future theming.
- **Fix:** Define semantic intent: keep brand accent for chrome/icons only, and use the success token for 'finalized/all clear' states rather than the branch color, OR document accent-as-success and apply it uniformly. Replace inline style={{color: 'var(--branch-accent)'}} repetition with a small utility class and drop the !important by raising specificity instead.

### 103. ⚪ Off-scale arbitrary font sizes (text-[9px]/[10px]/[11px]/[15px]) break the type scale

**LOW** · Color System & Tokens · consistency · effort M · seen 1× (LENS: Design System & Visual Consistency)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** 50 arbitrary pixel font sizes appear: `text-[10px]` (25x), `text-[11px]` (19x), `text-[9px]` (3x), `text-[15px]` (3x). These sit between Tailwind's scale steps (text-xs=12px, text-sm=14px, text-base=16px) and are applied ad-hoc, so micro-labels render at five different sub-12px sizes across the diagnostics and owner pages. `text-[9px]`/`text-[10px]` are also below the practical legibility floor for dense lab data.
- **Fix:** Replace with scale steps: collapse [9px]/[10px]/[11px] to a single `text-xs` (or add one deliberate `text-2xs` token in tailwind.config fontSize if a sub-12px label is truly needed), and [15px]→`text-sm`/`text-base`. Avoid sub-10px sizes for any data the staff must read at speed.

## Responsive & Mobile

### 104. 🟠 Non-responsive fixed grids and pixel-track layouts overflow horizontally on small screens (admin reference-range editor, product/panel dialogs)

**HIGH** · Responsive & Mobile · responsive · effort M · seen 2× (Owner Config & Management Pages, LENS: Responsive & Mobile)

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/OwnerDashboardV2.tsx`
- **Problem:** Admin forms use fixed tracks with no breakpoints. The reference-range editor uses `grid-cols-[120px_1fr_1fr_1fr_1fr_1fr_1fr_1fr_28px]` for the header and every row (ManageClinicalDefinitions.tsx:1112/1123) — 9 columns including a 120px label and a 28px delete, so it overflows on a tablet. The product dialog (`grid-cols-2`, ManageBillableProducts.tsx:602) and the panel basic-info block (`grid grid-cols-2`, ManagePanelDefinitions.tsx:957) have no sm:/md: prefix, so on a narrow tablet (common at a front desk) the paired fields cramp or clip.
- **Fix:** Add responsive breakpoints: collapse fixed grids to single-column below md (`grid-cols-1 md:grid-cols-2`), and make the reference-range editor horizontally scroll within a constrained container OR reflow to stacked rows on small screens. Audit all fixed pixel-track grids for a mobile fallback.

### 105. 🟠 Owner dashboards are desktop-only — maxWidth 1440 with lg:-only breakpoints, and the hand-rolled trend SVG overflows/distorts on tablet and phone

**HIGH** · Responsive & Mobile · responsive · effort M · seen 2× (Owner & Doctor Dashboards, LENS: Responsive & Mobile)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** OwnerDashboardV2 wraps content in `style={{ maxWidth: 1440 }}` (988) and most KPI rows jump straight from 1 column to 5 (`grid-cols-1 ... lg:grid-cols-5`, 931/1075; `lg:grid-cols-3`, 611/939) with no md:/sm: step, so on any tablet (768-1023px) the layout is a long single column. The revenue trend SVG compounds it: its viewBox is `0 0 ${trend.length*14} 140` rendered at `width="100%"` with `preserveAspectRatio="none"` (723-728), so 30 points (420 wide) squeezed into a ~320px phone card stretches the geometry horizontally and distorts stroke widths.
- **Fix:** Add intermediate breakpoints (`md:grid-cols-2 lg:grid-cols-3/5`) and replace the hard `maxWidth:1440` with a responsive container so tablets get a real multi-column layout. Render the trend with a responsive charting component (recharts ResponsiveContainer) or drop `preserveAspectRatio="none"` and use a proper aspect-ratio box so the chart doesn't distort on small screens.

### 106. 🟠 Every data table is horizontal-scroll-only on mobile (no column hiding or card fallback), and the payout sticky header is applied without a constrained scroll container so it doesn't help and can mis-stick under the mobile top bar

**HIGH** · Responsive & Mobile · responsive · effort L · seen 2× (LENS: Responsive & Mobile)

- **Files:** `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`, `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/components/payouts/PayoutsTable.tsx`
- **Problem:** A grep for responsive column hiding (`md:table-cell` / `hidden ... table-cell`) returns ZERO hits across src — every table is just wrapped in `overflow-x-auto` (PayoutsTable.tsx:90, OwnerMoneyPage.tsx:395, OwnerOperationsPage.tsx:251/434/491, OwnerDoctorsPage, OwnerDashboardV2, ManagePanelDefinitions, ManageBillableProducts), so on a phone every table is a wide horizontal scroll with no priority columns or card fallback. The attempted mitigation makes it worse: PayoutsTable marks its header `sticky top-0` (92) inside that unconstrained `overflow-x-auto` wrapper (90), but with the 64px mobile top bar (Sidebar `h-16`) and no height-constrained scroll container, `top-0` is relative to the viewport root, so the sticky header doesn't help the horizontal-scroll problem and can mis-stick under the top bar.
- **Fix:** Define a responsive table strategy: mark low-priority columns `hidden md:table-cell` and/or provide a stacked card layout below md for the key tables (payouts, money, doctors, ops, manage*). For sticky headers, put the table in a height-constrained, vertically-scrollable container so `sticky top-0` works, and offset for the mobile top bar. Bake this into the shared DataTable primitive so every table gets it.

### 107. 🟡 Interactive controls fall below the 44px touch-target — owner refresh/filter buttons, dialog close, and the repeated 12px 'open ↗' drill-down links

**MEDIUM** · Responsive & Mobile · navigation · effort S · seen 2× (Owner & Doctor Dashboards, LENS: Responsive & Mobile)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/components/ui/button.tsx`
- **Problem:** Several primary controls are too small to tap reliably. The owner dashboard refresh is a custom `px-3 py-1.5` button around a `h-3.5 w-3.5` icon (~28px tall, OwnerDashboardV2.tsx:1010-1023) and is the only refresh affordance; the shadcn icon button, dialog close, and filter controls also sit below 44px on touch. Each owner section's drill-down is a tiny 12px lowercase 'open ↗' text link with no padding, no underline, and a Unicode arrow standing in for an icon (OwnerDashboardV2.tsx:569-575/615-621/642-648/671-677) — well below the 44px guideline and low-affordance.
- **Fix:** Bump interactive controls to a ≥44px touch target (or add padding to reach it): give refresh/filter/close buttons a comfortable size on touch, and turn 'open ↗' into a properly sized, underlined link or a Button with an icon and adequate hit area. Establish a minimum-target rule for all icon/text controls.

### 108. 🟡 New Visit is a long single-column form with a large empty right canvas

**MEDIUM** · Responsive & Mobile · visual-hierarchy · effort L · seen 1× (Diagnostics Workflow)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The whole registration form is centered in `max-w-3xl mx-auto space-y-6` (DiagnosticsNewVisit.tsx:1252) and stacks Patient Lookup → Matching Patients → New Patient → Select Tests → Billing as five full-width cards, each appearing sequentially. On a desktop front-desk monitor this leaves wide empty margins while the live bill summary (Total/Discount/Final/Due) is buried at the bottom of the Billing card (:2146-2273), forcing staff to scroll away from the test selector to see the running total.
- **Fix:** On lg+ screens, use a two-column layout (form steps on the left, a sticky bill-summary/total panel on the right) so the live total and 'Generate Bill' CTA stay in view while selecting tests and entering payment.

### 109. 🟡 Panel-definition Live Preview is hidden below lg with no alternative way to see it on tablet/mobile

**MEDIUM** · Responsive & Mobile · responsive · effort M · seen 1× (LENS: Responsive & Mobile)

- **Files:** `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`
- **Problem:** The right-hand Live Preview column is `w-[360px] shrink-0 hidden lg:block` (ManagePanelDefinitions.tsx:1476). Below the lg breakpoint it is simply removed, with no toggle/drawer fallback, so on a tablet or phone the owner edits a panel definition with zero preview of what they are building.
- **Fix:** Provide the preview on small screens via a `Sheet`/`Dialog` triggered by a 'Preview' button (shown only `lg:hidden`), reusing the same preview component, instead of dropping it.

### 110. ⚪ Sticky bulk action bar can overlap pagination on short result sets

**LOW** · Responsive & Mobile · responsive · effort M · seen 1× (Payouts)

- **Files:** `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/components/payouts/PayoutBulkActionBar.tsx`
- **Problem:** The bulk bar is `fixed … bottom-4` (PayoutBulkActionBar.tsx:37) and the page reserves `pb-24` (PayoutsList.tsx:404). With only a few rows selected on a short page, the floating pill sits over the pagination/page-size controls (PayoutsList.tsx:598-648) and the 'By Doctor' footer totals (PayoutsByDoctor.tsx:190-203), which are NOT inside that padded container — they can be obscured. On small/zoomed viewports the horizontally-laid-out pill (count + 4-5 buttons) can also overflow the screen width with no wrapping.
- **Fix:** Ensure all scrollable content (including the by-doctor footer) lives inside the `pb-24` container, or increase bottom padding when the bar is visible. For narrow screens, allow the pill to wrap or switch to a full-width bottom bar layout below `sm`.

### 111. ⚪ Global Patient Search uses centered header + large bottom margin that wastes mobile viewport before the keyboard-first input

**LOW** · Responsive & Mobile · responsive · effort S · seen 1× (LENS: Responsive & Mobile)

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** The header is `text-center mb-8` with an `text-2xl` title and a subtitle (GlobalPatientSearch.tsx:91-96), and the search-type tabs use long labels (`Search by Phone (recommended)`, line 109). On a phone the two tab buttons stack (`flex-col`, line 102) and the long parenthetical label may wrap, pushing the actual phone-number input far below the fold before the staff member can start typing.
- **Fix:** Left-align and shrink the header (`text-xl`, remove `mb-8` → `mb-4`) and tighten the tab labels (`Phone` / `Name` with the icon) so the input is near the top on mobile. Consider auto-focusing the input.

## Branding

### 112. 🔴 Print documents render placeholder or missing clinic identity — ReportPrint hardcodes fake 'DIAGNOSTIC CENTER / 123 Medical Street', and BillReceipt computes clinicLabel but never renders the clinic name

**CRITICAL** · Branding · branding · effort S · seen 2× (Print Documents & Legal Pages)

- **Files:** `health-hub/src/components/print/ReportPrint.tsx`, `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** The printed/patient-facing documents lack real Sobhana identity. ReportPrint.tsx hardcodes scaffold placeholder branding in the lab-report header: line 15 `<h1>DIAGNOSTIC CENTER</h1>`, line 16 `123 Medical Street, City - 123456`, line 17 `Phone: 1234567890 | Email: info@diagnostic.com` — none of it is Sobhana. BillReceipt.tsx computes `const clinicLabel = isDiagnostic ? "Sobhana Diagnostic Centre" : "Sobhana Clinic"` (170-172) but grep confirms `clinicLabel` is referenced only at line 170 — it is never placed in the JSX, so the printed bill header (188-229) shows only a logo image and omits the clinic name entirely.
- **Fix:** Render real Sobhana identity in both documents from a single branding source (branch/clinic config): replace ReportPrint's placeholder header with the actual clinic name/address/contact, and place the already-computed `clinicLabel` into the BillReceipt header. Drive name, address, and contact from one config object so print docs can't drift from placeholders again.

### 113. 🟠 Legal pages (Privacy/Terms/Data-Deletion) have zero Sobhana branding, no app shell, and are unreachable from any in-app nav, login, or footer

**HIGH** · Branding · branding · effort M · seen 3× (Print Documents & Legal Pages, LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/pages/legal/TermsOfService.tsx`, `health-hub/src/pages/legal/DataDeletion.tsx`, `health-hub/src/App.tsx`, `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** All three public legal pages render a bare `<div className="min-h-screen bg-white py-16 px-6">` with an unbranded `<h1>` and body text (PrivacyPolicy/TermsOfService/DataDeletion line 2-4) — no Sobhana logo, no header/nav, no footer, and each uses its own off-scale title style (`text-3xl font-bold text-gray-900`). Their routes `/privacy`, `/terms`, `/data-deletion` are registered (App.tsx:228-230) but grep finds no link to them anywhere — not from the login page, a footer, or settings — so they are reachable only by typing the URL, despite being the pages app-store/WhatsApp review processes expect to find linked.
- **Fix:** Wrap the legal pages in a shared branded shell (SOBHANA logo header + footer, token colors, one consistent title recipe via the new PageHeader) and add footer/login links pointing to them so they are discoverable. Fold their gray/blue literals into the token migration.

### 114. 🟡 Brand navy/red hardcoded as raw hex (`#1B2B58`/`#D91C2B`) in Login and BranchConfirmModal instead of tokens (theming bypass)

**MEDIUM** · Branding · branding · effort M · seen 2× (Auth & App Shell, LENS: Design System & Visual Consistency)

- **Files:** `health-hub/src/pages/Login.tsx`, `health-hub/src/components/layout/BranchConfirmModal.tsx`, `health-hub/src/index.css`, `health-hub/src/main.tsx`
- **Problem:** The Sobhana brand colors exist as CSS vars (index.css:46 `--branch-sidebar-bg: #1B2B58`, :49 `--branch-accent: #D91C2B`) yet Login.tsx and BranchConfirmModal.tsx hardcode the raw hex ~20×: Login.tsx:41/47 `bg-[#1B2B58]`, :70/89/104/127 `text-[#1B2B58]`, :76/83 `text-[#D91C2B]`, :120/143 `focus:ring-[#D91C2B] focus:border-[#D91C2B]`, :154 `bg-[#D91C2B] hover:bg-red-700`; BranchConfirmModal.tsx:72 fallback `'#1B2B58'`, :90 `text-[#1B2B58]`, :140 `bg-[#D91C2B]`. These literals won't follow per-branch accent theming and drift silently if the palette changes.
- **Fix:** Promote the two brand colors to named Tailwind tokens (`brand-navy`, `brand-red`) in tailwind.config.ts/index.css and replace the arbitrary-value hex utilities with them (`bg-brand-navy`, `text-brand-red`, `focus:ring-brand-red`). Reuse the existing destructive/accent tokens for the red CTA so the primary button matches buttons elsewhere.

### 115. 🟡 Login hero image is hotlinked to an ephemeral Google aida-public URL with no fallback

**MEDIUM** · Branding · branding · effort S · seen 1× (Auth & App Shell)

- **Files:** `health-hub/src/pages/Login.tsx`
- **Problem:** Login.tsx:43 sets the left hero `src` to a long-lived-looking but ephemeral `https://lh3.googleusercontent.com/aida-public/AB6AX...` URL (an AI-generated-asset host). This is an external runtime dependency on the very first screen of the product: if the URL expires or the lab has no internet, the hero panel shows a broken image over `bg-[#1B2B58]` with no fallback, undermining first-impression trust. It also leaks a third-party request before the user has authenticated.
- **Fix:** Self-host the hero image in /public (or import it as an asset so Vite fingerprints it) and reference it locally. The panel already has a navy background and gradient overlay as a graceful fallback, but the primary asset must not be a third-party hotlink.

### 116. ⚪ Logo iconography differs between Login (biotech+medical_services glyphs) and shell (Microscope lucide icon)

**LOW** · Branding · branding · effort M · seen 1× (Auth & App Shell)

- **Files:** `health-hub/src/pages/Login.tsx`, `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** The previously-reported MedCare/flask issue is FIXED — Login.tsx:86 now reads 'SOBHANA' with the navy/red wordmark. However the logo mark is inconsistent across surfaces: Login.tsx:67-81 builds the mark from Material Symbols glyphs `biotech` + `medical_services`, while the sidebar/sheet brand (Sidebar.tsx:291, 313, 345) uses the lucide `Microscope` icon next to the SOBHANA wordmark. Two different logo marks for the same brand reads as inconsistent and means the brand depends on the externally-loaded Material Symbols font (index.html:11) on the login screen only.
- **Fix:** Standardize on one logo mark. Extract the SOBHANA wordmark+icon into a single `<BrandLogo size>` component (using one icon source — ideally a self-hosted SVG, not a webfont glyph) and use it in Login, Sidebar desktop, and the mobile sheet so the mark is identical everywhere.

## Other

### 117. 🟡 Bill totals list Paid Amount before Discount, breaking the arithmetic narrative

**MEDIUM** · Other · information-architecture · effort S · seen 1× (Print Documents & Legal Pages)

- **Files:** `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** In the totals block (BillReceipt.tsx lines 359-388) the rows render in order: Total Amount (line 361), Paid Amount (line 367), then conditionally Disc. Amount (line 373), then Due Amount (line 381). A reader cannot follow the math: a receipt should read Total → Discount → Net/Payable → Paid → Due. Showing Paid before Discount makes it look like the patient paid the full pre-discount total, and Net/Payable is never shown at all even though `netAmount` is already computed (lines 63-66).
- **Fix:** Reorder to: Total Amount, Disc. Amount (when >0), Net Payable (always, using `netAmount`), Paid Amount, Due Amount (when >0). This gives a coherent top-to-bottom calculation and surfaces the net payable the customer actually owes.

### 118. 🟡 Branch address is selected by fragile string-matching on branch name

**MEDIUM** · Other · error-handling · effort M · seen 1× (Print Documents & Legal Pages)

- **Files:** `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** The printed address is chosen by lowercasing branchName and substring-matching (BillReceipt.tsx lines 211-221): `includes('kidcare') || includes('gutta')`, `includes('balanagar')`, else default to the Chintal address. If a branch is renamed, added, or its name does not contain one of these magic substrings, the bill silently prints the WRONG physical address (the Chintal default) on a financial/legal receipt. There is also a spelling mismatch: the Balanagar entry hardcodes "Shobhana Complex" (with an extra h) inside addresses for a brand spelled "Sobhana" everywhere else.
- **Fix:** Drive the printed address from branch data (return address/phone from the bills API alongside branch.name/code) instead of string-sniffing the display name. At minimum, key off `branch.code` rather than fuzzy name matching, and reconcile the "Shobhana" vs "Sobhana" spelling so it does not look like a typo on every Balanagar bill.

### 119. ⚪ Hand-rolled inline SVG lock icon instead of the lucide Lock used everywhere else

**LOW** · Other · consistency · effort S · seen 1× (Diagnostics Workflow)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsReportPreview.tsx`
- **Problem:** The prior-partial-release banner in ResultEntry draws a raw inline `<svg ... viewBox="0 0 20 20">` lock path (DiagnosticsResultEntry.tsx:1967-1978), while the visually-identical banner in ReportPreview uses the imported lucide `<Lock className="... text-blue-700" />` (DiagnosticsReportPreview.tsx:662). Two implementations of the same icon in two copies of the same banner.
- **Fix:** Replace the inline SVG with the lucide `Lock` icon already imported in the sibling file, and extract the duplicated 'prior partial release' banner into one shared component used by both pages.

### 120. ⚪ 'Visit Timeline' is a flat card list with no temporal grouping or visual spine

**LOW** · Other · visual-hierarchy · effort M · seen 1× (Clinic & Patient 360)

- **Files:** `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** The section is titled 'Visit Timeline (Newest → Oldest)' (Patient360.tsx:577-582) but renders as identical stacked cards (591-711) with a per-card date column. There is no connecting spine, no year/month grouping, and no visual distinction between recent and old visits — for a patient with many visits across branches this reads as an undifferentiated list, not a timeline, making it hard to scan history at a glance. The right-hand actions column is also fixed `min-w-[140px]` even when there's only a 'View Details' button, wasting horizontal space.
- **Fix:** Either rename to 'Visit History' (honest about being a list) or make it a real timeline: group by month/year headers, add a left rail/connector, and dim/condense older entries. Let the actions column shrink to content width when 'View Report' is absent.

### 121. ⚪ Totals values prefix a literal ": " inside the right-aligned cell, breaking tabular-num alignment

**LOW** · Other · consistency · effort S · seen 1× (Print Documents & Legal Pages)

- **Files:** `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** Each total value is rendered as `: {fmt(...)}` inside a right-aligned `flex justify-between` span with `fontVariantNumeric: 'tabular-nums'` (BillReceipt.tsx lines 362-364, 368-370, 375-377, 383-385). Because the colon-space is part of the same right-aligned, tabular-numeric span, the colons themselves get right-aligned against the number column, so the colons sit immediately left of digits of varying length and do not line up vertically; the tabular-nums benefit (clean decimal column) is partly defeated by the leading ': '. The patient-details grid uses a separate colon span pattern, so this is also inconsistent within the same document.
- **Fix:** Move the colon out of the numeric span: render the label as `<span>Total Amount :</span>` and the value as a pure numeric `<span style={{fontVariantNumeric:'tabular-nums'}}>{fmt(...)}</span>`, so only digits occupy the right column and the decimal points align.

### 122. ⚪ Print and legal pages set no document.title, so saved PDFs / browser tabs are unlabeled

**LOW** · Other · microcopy · effort S · seen 1× (Print Documents & Legal Pages)

- **Files:** `health-hub/src/pages/BillPrintPage.tsx`, `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/pages/legal/TermsOfService.tsx`, `health-hub/src/pages/legal/DataDeletion.tsx`, `health-hub/src/pages/ReportViewPage.tsx`
- **Problem:** Grep finds no `document.title`, `<title>`, or Helmet usage in any of these pages. When a desktop user uses the browser Print dialog on BillPrintPage (window.print(), line 112), the suggested PDF filename and print header default to the app/tab title rather than something like the bill number. Likewise the legal pages and report-view tab carry the generic app title. (The mobile path does set a filename via `pdf.save(\`${billNo}.pdf\`)` at line 103, which highlights the desktop gap.)
- **Fix:** Set `document.title` per page: on BillPrintPage use the bill/visit ref (e.g. `Bill ${receiptData.billNumber}`) once data loads so the desktop Print-to-PDF filename and header are meaningful; give the legal pages titles like "Privacy Policy — Sobhana".

## Page-Header & Breadcrumb System

### 123. 🟠 No shared PageHeader/breadcrumb component — every page hand-rolls an inconsistent h1 and deep routes have no back-affordance

**HIGH** · Page-Header & Breadcrumb System · consistency · effort L · seen 4× (Auth & App Shell, LENS: Design System & Visual Consistency, LENS: Information Architecture & Navigation)

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`, `health-hub/src/pages/owner/AdminConfigCenter.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`, `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/owner/OwnerDashboard.tsx`, `health-hub/src/pages/Login.tsx`, `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/components/ui/breadcrumb.tsx`, `health-hub/src/components/layout/AppLayout.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`
- **Problem:** There is no shared page-title component and no breadcrumb anywhere, so each page invents its own h1 with drifting type recipes: `text-2xl font-bold` (Dashboard.tsx:139, DiagnosticsPendingResults.tsx:282, AdminConfigCenter.tsx:41, ClinicNewVisit.tsx:648), `text-2xl font-bold text-gray-900` (PayoutsList.tsx:408, PayoutDetail.tsx:275), `text-3xl font-semibold tracking-tight` (OwnerDashboard.tsx:752), and an inline-styled 20px `font-medium` in the owner V2 area (OwnerDashboardV2.tsx:993, _shared/ownerUi.tsx:384) — four recipes total (`text-2xl font-bold` ×22, `text-3xl font-bold` ×8, `text-3xl font-semibold` ×6, `text-2xl font-semibold` ×1). A full shadcn Breadcrumb (breadcrumb.tsx) is implemented but grep finds zero imports anywhere, so on deep routes (/clinic/patient-360/:id, /owner/payouts/:id) the user has no 'where am I / how do I go back up' affordance beyond the sidebar.
- **Fix:** Introduce one app-wide `<PageHeader title subtitle breadcrumbs actions />` (title `text-2xl font-semibold tracking-tight text-foreground`, subtitle `text-sm text-muted-foreground`, right-aligned actions slot). (a) Build the breadcrumb row on the ALREADY-EXISTING but unused `components/ui/breadcrumb.tsx`; (b) REPLACE the off-token OwnerPageHeader in _shared/ownerUi.tsx (delete its inline `style={{ fontSize: 20 }}`/`font-medium`/TOKENS coloring) and re-export it as a thin wrapper over the new shared PageHeader so the 4 owner pages migrate for free; (c) replace raw `text-gray-900`/`text-gray-500` in PayoutsList/PayoutDetail with `text-foreground`/`text-muted-foreground`. Best rendered from AppLayout fed by the existing context/subContext props so deep routes get an automatic breadcrumb + back-affordance.

### 124. 🟡 Search page centers its h1 while every other clinic page left-aligns

**MEDIUM** · Page-Header & Breadcrumb System · consistency · effort S · seen 1× (Clinic & Patient 360)

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`
- **Problem:** GlobalPatientSearch.tsx:91 wraps the title in `<div className="text-center mb-8">` with `<h1 className="text-2xl font-bold text-foreground">`. Every sibling page left-aligns the same pattern: ClinicNewVisit.tsx:647 (`<div><h1 className="text-2xl font-bold">New Clinic Visit</h1>`), ClinicVisitQueue.tsx:217 (`<h1 className="text-2xl font-bold">Visit Queue</h1>`), and Patient360.tsx left-aligns everything. The centered header makes the search page feel like a different app and breaks the established top-left title + muted subtitle rhythm.
- **Fix:** Drop `text-center` and use the shared left-aligned pattern: `<div><h1 className="text-2xl font-bold">…</h1><p className="text-muted-foreground mt-1">…</p></div>`. Consider extracting a small `<PageHeader title subtitle />` component so all four pages stay aligned.
