# SOBHANA PORTAL — Complete Findings Register (all 192)

**Date:** 2026-06-21  ·  **Companion to:** `ui-ux-audit-2026-06-21.md` (the synthesized vision/roadmap).

This is the itemized list — every individual finding from the 16 reviewers, numbered, with file(s), the problem, and the specific fix. The audit doc folds these into themes; this is the raw register.

**Severity totals:** 🔴 Critical 13 · 🟠 High 57 · 🟡 Medium 82 · ⚪ Low 40 — **192 total**

## Count by area

| # | Area | 🔴 | 🟠 | 🟡 | ⚪ | Total |
|---|---|---|---|---|---|---|
| 1 | Auth & App Shell | 0 | 3 | 5 | 4 | 12 |
| 2 | Staff Dashboard / Home | 2 | 3 | 5 | 1 | 11 |
| 3 | Diagnostics Workflow | 1 | 3 | 6 | 3 | 13 |
| 4 | Diagnostics Editors & Selectors | 0 | 3 | 6 | 4 | 13 |
| 5 | Clinic & Patient 360 | 0 | 4 | 7 | 3 | 14 |
| 6 | Owner & Doctor Dashboards | 2 | 5 | 5 | 2 | 14 |
| 7 | Owner Money / Doctors / Operations | 1 | 4 | 6 | 2 | 13 |
| 8 | Owner Config & Management Pages | 0 | 4 | 6 | 2 | 12 |
| 9 | Payouts | 1 | 3 | 5 | 4 | 13 |
| 10 | Print Documents & Legal Pages | 1 | 2 | 6 | 3 | 12 |
| 11 | LENS: Design System & Visual Consistency | 1 | 3 | 6 | 1 | 11 |
| 12 | LENS: Information Architecture & Navigation | 0 | 5 | 5 | 2 | 12 |
| 13 | LENS: Microcopy & Terminology | 1 | 3 | 5 | 3 | 12 |
| 14 | LENS: Accessibility | 2 | 6 | 3 | 1 | 12 |
| 15 | LENS: Responsive & Mobile | 0 | 3 | 2 | 3 | 8 |
| 16 | LENS: Interaction & Feedback States | 1 | 3 | 4 | 2 | 10 |

---

## Auth & App Shell

_The shell is functional and the previously-flagged MedCare branding has been fixed (Login now correctly self-brands as SOBHANA), but it carries real wayfinding and consistency debt: ContextBanner prints the active branch name twice, AppLayout requires two props (context, subContext) that it never renders, there is no shared PageHeader/breadcrumb so every page hand-rolls an inconsistent h1, and core brand colors are hardcoded as hex 20 times instead of using the existing CSS tokens. Error/empty states (NotFound) are also off-brand and unauthenticated._

### 1. 🟠 ContextBanner shows the active branch name twice (static label + dropdown showing the same name)
**HIGH** · redundancy · effort S · verified (high)

- **Files:** `health-hub/src/components/layout/ContextBanner.tsx`, `health-hub/src/components/layout/BranchSelector.tsx`
- **Problem:** ContextBanner renders a static "Branch: <name>" block AND the BranchSelector right next to it, and the selector's trigger renders the very same name. ContextBanner.tsx:14-16 prints `<span>Branch:</span> <span>{activeBranch?.name}</span>`, while BranchSelector.tsx:111-113 renders `<Building2/> {activeBranch.name} <ChevronDown/>` in its trigger button. For staff/owner the active branch name is therefore displayed twice, side by side, on every authenticated page. The static label is also redundant for doctors, where BranchSelector.tsx:94-101 already shows the name in a non-interactive pill.
- **Fix:** Drop the static "Branch:" + name block (ContextBanner.tsx:12-17) entirely; the BranchSelector trigger already names the branch and is the canonical interactive control. Two role-specific refinements: (1) Staff/owner — the selector trigger (lines 107-114) already carries Building2 + name + ChevronDown, so no label is needed; if a "Branch:" affordance is desired add aria-label="Switch branch" to the trigger Button rather than rendering visible duplicate text. (2) Doctors — since their pill (lines 97-100) is non-interactive, that pill IS the single source of truth; keep it and still drop the ContextBanner static block. Also handle the empty state the static block currently covered: the "Not Selected"/"Select Branch" messaging already lives in BranchSelector (lines 53-64), so removing the ContextBanner block loses nothing. Use the reclaimed left-side space for the page/subContext wayfinding noted in ctx-banner-subcontext-dead-prop. Effort S is correct.

### 2. 🟠 AppLayout requires `context` and `subContext` props that are never rendered (dead props / lost wayfinding)
**HIGH** · information-architecture · effort M · verified (high)

- **Files:** `health-hub/src/components/layout/AppLayout.tsx`, `health-hub/src/components/layout/ContextBanner.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`, `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** AppLayout.tsx:14 destructures `context` (a required AppContext prop) and `subContext`, but the function body (lines 22-37) never uses either — ContextBanner is rendered with no props and only reads the branch store. Every page is forced to pass `context="clinic"`, `context="owner"`, etc., and several pass meaningful labels like `subContext="Patient 360"`, `subContext="Global Patient Search"`, `subContext="Reception"` (Patient360.tsx:411, GlobalPatientSearch.tsx:88, ClinicVisitQueue.tsx:215, ClinicNewVisit.tsx:548) that are silently discarded. The intended section/page wayfinding is wired up at every call site but never reaches the screen.
- **Fix:** Render the props, but normalize them rather than dumping raw strings. (1) In AppLayout, pass `context` and `subContext` into ContextBanner: `<ContextBanner context={context} subContext={subContext} />`. (2) Add typed props to ContextBanner and render a breadcrumb/section label on the LEFT of the banner, e.g. a humanized `context` ("Clinic" / "Owner" / "Diagnostics") + a `<ChevronRight className="size-3" />` separator + `subContext`, using muted-foreground text and `aria-current` semantics. (3) Before shipping, audit the call-site labels for consistency: title-case route keys ("payouts" -> "Payouts") and fix the misleading "Reception" label on ClinicVisitQueue.tsx:215 (it is the Visit Queue, not Reception). Consider deriving the context-display name from a small map instead of trusting each call site. This restores wayfinding AND can replace the redundant static "Branch:" left-text (per ctx-banner-branch-name-duplicate), moving the BranchSelector to carry the branch identity. If the team does not want a breadcrumb, the alternative is to delete both props and strip them from all ~11 call sites — but rendering is the higher-value choice since the labels already exist.

### 3. 🟠 No shared PageHeader/breadcrumb component; every page hand-rolls an inconsistent h1
**HIGH** · consistency · effort L · verified (high)

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`, `health-hub/src/pages/owner/AdminConfigCenter.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`, `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`
- **Problem:** There is no shared page-title component, so each page invents its own h1 with drifting classes: `text-2xl font-bold text-foreground` (Dashboard.tsx:139), `text-2xl font-bold` (DiagnosticsPendingResults.tsx:282, AdminConfigCenter.tsx:41, ClinicNewVisit.tsx:648), `text-2xl font-bold text-gray-900` (PayoutsList.tsx:408, PayoutDetail.tsx:275), `text-3xl font-semibold tracking-tight` (OwnerDashboard.tsx:752), and an inline-styled `font-medium` `fontSize: 20` (OwnerDashboardV2.tsx:993, _shared/ownerUi.tsx:384). Title size, weight, and color are inconsistent across the app, and there is no breadcrumb anywhere, so on deep routes (e.g. /clinic/patient-360/:id, /owner/payouts/:id) the user has no "where am I / how do I go back up" affordance beyond the sidebar.
- **Fix:** Introduce one app-wide `<PageHeader title subtitle breadcrumbs actions />` in src/components/ (title `text-2xl font-semibold tracking-tight text-foreground`, subtitle `text-sm text-muted-foreground`, right-aligned actions slot). Crucially: (a) build the breadcrumb row on the ALREADY-EXISTING but unused src/components/ui/breadcrumb.tsx rather than inventing a new one; (b) REPLACE the off-token OwnerPageHeader in _shared/ownerUi.tsx (delete its inline `style={{ fontSize: 20 }}` / `font-medium` / TOKENS coloring) and re-export it as a thin wrapper over the new shared PageHeader so the 4 owner pages migrate for free; (c) replace the raw `text-gray-900`/`text-gray-500` in PayoutsList/PayoutDetail with `text-foreground`/`text-muted-foreground`. Best rendered from AppLayout fed by the existing context/subContext props (already passed everywhere, e.g. `subContext="payouts"`) so deep routes like /owner/payouts/:id and /clinic/patient-360/:id get an automatic breadcrumb + back-affordance.

### 4. 🟡 Brand navy/red hardcoded as raw hex instead of design tokens (theming bypass)
**MEDIUM** · branding · effort M

- **Files:** `health-hub/src/pages/Login.tsx`, `health-hub/src/components/layout/BranchConfirmModal.tsx`, `health-hub/src/index.css`
- **Problem:** The Sobhana brand colors exist as CSS vars in index.css (`--branch-sidebar-bg: #1B2B58` line 46, `--branch-accent: #D91C2B` line 49) yet Login.tsx and BranchConfirmModal.tsx hardcode the raw hex ~20 times: e.g. Login.tsx:41 `bg-[#1B2B58]`, :70 `text-[#1B2B58]`, :76/:83 `text-[#D91C2B]`, :104/:127 `text-[#1B2B58]`, :120/:143 `focus:ring-[#D91C2B] focus:border-[#D91C2B]`, :154 `bg-[#D91C2B]`; BranchConfirmModal.tsx:72 fallback `'#1B2B58'`, :90 `text-[#1B2B58]`, :140 `bg-[#D91C2B]`. These literals will not follow the per-branch accent theming the rest of the app uses and will silently drift if the brand palette changes.
- **Fix:** Promote the two brand colors to named Tailwind tokens (e.g. `brand-navy`, `brand-red`) in tailwind.config.ts / index.css and replace the arbitrary-value hex utilities with them (`bg-brand-navy`, `text-brand-red`, `focus:ring-brand-red`). The destructive/accent tokens may already cover the red CTA — reuse them where appropriate so the primary button matches buttons elsewhere.

### 5. 🟡 404 page is off-brand, unauthenticated-only-styled, and uses a raw <a> that drops to a public route
**MEDIUM** · error-handling · effort S

- **Files:** `health-hub/src/pages/NotFound.tsx`, `health-hub/src/App.tsx`
- **Problem:** NotFound.tsx renders a bare `404 / Oops! Page not found` on `bg-muted` with no SOBHANA branding, no sidebar/app shell, and a plain `<a href="/">Return to Home`. Because the catch-all `<Route path="*" element={<NotFound />}/>` (App.tsx:237) is outside any ProtectedRoute/AppLayout, an authenticated user who mistypes a URL is dumped onto a context-less, brand-less screen and the `<a href="/">` triggers a full page reload (losing SPA state) and sends owners/doctors to the staff dashboard `/` rather than their own home. "Oops!" is also too casual for a clinical/financial tool.
- **Fix:** Wrap NotFound in the app shell when authenticated (or at least add the SOBHANA logo + muted-foreground copy), replace `<a>` with a react-router `<Link>`/`<Button asChild>`, and route the user to their role home (owner→/owner, doctor→/doctor, else /) using the same role logic in App.tsx:90. Drop "Oops!" for neutral copy like "This page doesn't exist."

### 6. 🟡 Login hero image is hotlinked to an ephemeral Google aida-public URL with no fallback
**MEDIUM** · branding · effort S

- **Files:** `health-hub/src/pages/Login.tsx`
- **Problem:** Login.tsx:43 sets the left hero `src` to a long-lived-looking but ephemeral `https://lh3.googleusercontent.com/aida-public/AB6AX...` URL (an AI-generated-asset host). This is an external runtime dependency on the very first screen of the product: if the URL expires or the lab has no internet, the hero panel shows a broken image over `bg-[#1B2B58]` with no fallback, undermining first-impression trust. It also leaks a third-party request before the user has authenticated.
- **Fix:** Self-host the hero image in /public (or import it as an asset so Vite fingerprints it) and reference it locally. The panel already has a navy background and gradient overlay as a graceful fallback, but the primary asset must not be a third-party hotlink.

### 7. 🟡 Sidebar active state relies on a CSS var with no contrast guarantee and parent group rows look clickable but aren't
**MEDIUM** · accessibility · effort M

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** Active nav items are styled only via inline `style={{ backgroundColor: 'var(--branch-sidebar-active)' }}` with `text-white` (Sidebar.tsx:228, 243, 269). There is no guaranteed contrast between `--branch-sidebar-active` and white text across all branch themes, and no `aria-current="page"` is set on the active Link, so screen-reader users get no programmatic 'current page' cue. Separately, parent group headers (e.g. Diagnostics, Clinic, Operations) render as a styled `<div>` (lines 238-247) that is NOT a link — it highlights when a child is active and visually matches the clickable rows, inviting clicks that do nothing.
- **Fix:** Add `aria-current={isActive ? 'page' : undefined}` to the nav Links. Ensure `--branch-sidebar-active` meets >=4.5:1 against white in every branch theme (or pair it with a left accent bar instead of a full fill). Make the parent group row either a real Link to its `href` (it already has one, e.g. /diagnostics) or visually de-emphasize it (e.g. uppercase section label) so it doesn't read as an interactive item.

### 8. 🟡 Login surfaces errors only via toast; no inline/ARIA error region and password field has no reveal
**MEDIUM** · interaction-feedback · effort M

- **Files:** `health-hub/src/pages/Login.tsx`
- **Problem:** On failed login, Login.tsx:31 calls `toast.error(...)` only — there is no inline, persistent error message tied to the form via `aria-describedby`/`role="alert"`, so a screen-reader user or anyone who misses the transient toast gets no durable feedback about why sign-in failed. The password input (lines 134-145) has no show/hide toggle, which is standard for typo-prone clinical staff, and the submit button's only loading feedback is text swap to "Signing in..." with `disabled:opacity-50` (lines 153,159) — no spinner.
- **Fix:** Add an inline error container with `role="alert"` above/below the fields (kept in addition to the toast), wire `aria-invalid`/`aria-describedby` on the inputs, add an eye-toggle button to the password field, and put a Loader2 spinner in the submit button during isLoading.

### 9. ⚪ Logout button labeled "Sign Out" while login CTA says "Sign In" but the action elsewhere is "login" — minor terminology, plus logout buried at sidebar bottom with no confirm
**LOW** · microcopy · effort M

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** The destructive Sign Out action (Sidebar.tsx:326-333 desktop, 358-365 duplicated for the sheet) is a low-emphasis ghost button at the bottom of the nav with no confirmation; on a shared front-desk machine an accidental click instantly logs out and navigates to /login (handleLogout, lines 181-185), discarding any in-progress unsaved registration. The user identity block above it (name + role) is fine, but there is no menu/avatar affordance grouping identity + logout the way users expect.
- **Fix:** Group the user name/role + Sign Out into a small account menu (DropdownMenu on the identity block) rather than an always-visible ghost button, and/or add an AlertDialog confirm for logout when there is unsaved work. At minimum keep the label consistent with the rest of the product's auth verbs.

### 10. ⚪ Branch confirm modal is non-dismissible by design but offers no cancel/keyboard escape and uses a hand-rolled button instead of DialogFooter
**LOW** · interaction-feedback · effort S

- **Files:** `health-hub/src/components/layout/BranchConfirmModal.tsx`
- **Problem:** BranchConfirmModal.tsx:77-79 hides the close button and blocks Escape + outside-click (`[&>button.absolute]:hidden`, `onEscapeKeyDown` preventDefault, `onPointerDownOutside` preventDefault). That is intentional (must pick a branch) but the only escape hatch is a successful selection — there's no way to log out/cancel from this trapped state if branches fail to load (the Continue button just stays disabled per line 139). The CTA is a bare full-width `<Button>` (line 136) rather than living in a `<DialogFooter>`, diverging from the shadcn dialog pattern used elsewhere.
- **Fix:** Keep it modal but add a secondary 'Sign out' / 'Cancel' affordance for the failure case (branches empty after load), and wrap the action in `<DialogFooter>`. Also show an explicit error state if fetchBranches resolves with zero active branches instead of an indefinitely-disabled Continue.

### 11. ⚪ NavLink compatibility component is dead code — imported nowhere
**LOW** · redundancy · effort S

- **Files:** `health-hub/src/components/NavLink.tsx`
- **Problem:** src/components/NavLink.tsx defines a `NavLink` wrapper with `activeClassName`/`pendingClassName` compatibility props, but a repo-wide search for imports of '@/components/NavLink' returns zero hits — the sidebar uses plain react-router `Link` with manual isActive logic (Sidebar.tsx:2,220-232). This is leftover scaffolding that misleads future contributors into thinking there's a shared active-link primitive.
- **Fix:** Delete src/components/NavLink.tsx, OR actually adopt it in Sidebar.tsx to replace the hand-rolled isItemActive/isSubItemActive logic (it would also give correct aria-current handling for free). Pick one — don't keep an unused parallel implementation.

### 12. ⚪ Logo iconography differs between Login (biotech+medical_services glyphs) and shell (Microscope lucide icon)
**LOW** · branding · effort M

- **Files:** `health-hub/src/pages/Login.tsx`, `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** The previously-reported MedCare/flask issue is FIXED — Login.tsx:86 now reads 'SOBHANA' with the navy/red wordmark. However the logo mark is inconsistent across surfaces: Login.tsx:67-81 builds the mark from Material Symbols glyphs `biotech` + `medical_services`, while the sidebar/sheet brand (Sidebar.tsx:291, 313, 345) uses the lucide `Microscope` icon next to the SOBHANA wordmark. Two different logo marks for the same brand reads as inconsistent and means the brand depends on the externally-loaded Material Symbols font (index.html:11) on the login screen only.
- **Fix:** Standardize on one logo mark. Extract the SOBHANA wordmark+icon into a single `<BrandLogo size>` component (using one icon source — ideally a self-hosted SVG, not a webfont glyph) and use it in Login, Sidebar desktop, and the mobile sheet so the mark is identical everywhere.

---

## Staff Dashboard / Home

_The dashboard is metric-first rather than action-first: a speed-focused front-desk user must scroll past three KPI cards before reaching the actions they actually came for, and the single most common task — patient search/registration lookup — has no presence on the page at all. There is heavy duplication (same routes linked 2-3 times under different labels), a content-free filler card, and a silent failure mode where a fetch error renders as a reassuring "All Clear"._

### 13. 🔴 Patient search / Patient 360 is absent from the dashboard entirely
**CRITICAL** · information-architecture · effort M · verified (high)

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/App.tsx`
- **Problem:** Patient lookup is a core, high-frequency front-desk action (it has its own top-level sidebar entry 'Patient 360' → '/clinic/patient-search', Sidebar.tsx:127-133, and route App.tsx:136). Yet the Dashboard never surfaces it: the Quick Actions grid (Dashboard.tsx:220-245) only contains New Diagnostic Visit, New Clinic Visit, Enter Results, and Visit Queue. A staff member who lands on the home page to find an existing patient has zero one-click path and must locate the sidebar item.
- **Impact:** Front-desk staff register and look up returning patients constantly; forcing them into the sidebar for the single most common task directly slows the speed-driven workflow this role is built around.
- **Fix:** Both fixes are good; prefer doing both. (1) Add an autofocused search field at the top of the dashboard that on Enter navigates to /clinic/patient-search?q={query} (and update PatientSearch to read the q param), giving true keyboard-first lookup: land on home → type → Enter. (2) Add a fifth 'Patient 360' tile to the Quick Actions grid — the grid is already responsive (md:grid-cols-2 lg:grid-cols-4 at Dashboard.tsx:220), so a 5th item wraps to a balanced 4+1 / 2+2+1 without a layout rework; reuse the same Users icon and btn-branch-outline styling as the existing tiles and link to /clinic/patient-search. Note the Visit Queue tile reuses the Users icon, so give the new Patient 360 tile a distinct icon (e.g. lucide Search or UserSearch) to avoid icon collision in the grid.

### 14. 🔴 Fetch failure silently renders zeros and a false 'All Clear'
**CRITICAL** · error-handling · effort M · verified (high)

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** The catch block only logs: `console.error('Failed to fetch dashboard data:', error)` (90-94) and leaves diagnosticVisits/clinicVisits as empty arrays. With empty data, metrics.hasPendingWork is false, so the bottom card renders 'All Clear' with 'No pending lab results or waiting patients. Operations are running smoothly.' (304-325). A network/API error therefore looks identical to a genuinely quiet branch — staff get a confident green 'all good' message when the data simply failed to load.
- **Impact:** False reassurance on a clinical operations dashboard is a trust/safety problem — pending lab results or waiting patients could be hidden behind a soothing message.
- **Fix:** Add `const [error, setError] = useState(false)`; reset to false at the start of the fetch (alongside setLoading(true), line 62) and call setError(true) in the catch (line 91). Render priority should be: loading spinner -> if error, a destructive Alert (shadcn `<Alert variant="destructive">` with AlertCircle, AlertTitle "Couldn't load branch data", AlertDescription, and a Button to re-trigger the fetch) shown INSTEAD of the metric cards and the All Clear/Pending card — not merely above them, so stale zeros aren't displayed next to the error. Gate the entire "All Clear" branch on `!error && !loading` so the soothing message can never appear without a confirmed successful response. Extract fetchDashboardData out of the effect (or wrap with useCallback) so the Retry button can re-invoke it. Optionally distinguish "no data loaded yet" from "zero pending work" by only rendering counts after a successful fetch.

### 15. 🟠 Primary actions sit 4th on the page, below three KPI cards
**HIGH** · visual-hierarchy · effort M · verified (medium)

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** Page order is: header (138-141), three large metric cards (150-213), THEN the Quick Actions card (215-247). A front-desk user's primary intent on landing is to start a new visit, not to read KPIs. The actions a speed user needs are pushed below the fold behind passive read-only metrics.
- **Impact:** Every shift starts with avoidable scrolling/hunting for the create actions, undermining the speed-first design goal for this role.
- **Fix:** Promote the two create actions specifically. Add a compact action bar directly under the h1 (line 141) using existing branch-accent button styling, e.g. a flex row with primary "New Diagnostic Visit" (to /diagnostics/new) and "New Clinic Visit" (to /clinic/new), with "New Diagnostic Visit" as variant="default" (filled, branch accent) to mark it the dominant action. Keep the KPI cards where they are since they already carry contextual deep-link buttons (Enter Results / View Queue), but DROP the now-redundant "New Diagnostic Visit" / "New Clinic Visit" tiles from the Quick Actions grid (222, 228) to avoid duplicate create entry points, leaving Quick Actions for the secondary "Enter Results" / "Visit Queue" navigation only. This fixes both the hierarchy issue and a latent redundancy. Effort S-M.

### 16. 🟠 'Enter Results' and queue links are duplicated across cards
**HIGH** · redundancy · effort S · verified (high)

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** Multiple actions appear twice. 'Enter Results' is a button in the Pending Lab Results card (164-168, → /diagnostics/pending) AND a Quick Action tile (233-238, same route). The clinic queue is linked three times with three different labels but the same destination: 'View Queue' (185-189), 'View Admissions' (206-210), and 'Visit Queue' (239-244) all point to /clinic/queue. New Diagnostic/Clinic Visit Quick Actions (221-232) also duplicate the sidebar.
- **Impact:** Repeating the same action under different names increases scan cost and erodes the sense that each control does something distinct.
- **Fix:** Two distinct problems with two distinct fixes. (1) The "Enter Results" Quick Action tile (233-238) and "Visit Queue" tile (239-244) are pure duplicates of card CTAs — delete them. The Quick Actions card should retain only the create flows that have no card equivalent: "New Diagnostic Visit" and "New Clinic Visit" (221-231). (2) Do NOT collapse the two card CTAs into a single "OP / IP Queue" label — the OP card (waiting) and IP card (admissions) are genuinely different cohorts, so a shared label would erase a meaningful distinction. Instead, keep both card CTAs but make their destinations honest: if /clinic/queue can deep-link to a filtered view, link to /clinic/queue?type=OP and /clinic/queue?type=IP so the differing labels ("View OP Queue" / "View IP Admissions") map to differing states; if the route cannot filter, unify the verb ("View Queue" on both) since identical destinations should not wear different verbs. Net result: each control on the page maps to a distinct destination-or-state, with create actions living only in Quick Actions and queue/results navigation living only on their metric cards.

### 17. 🟠 'Pending Work' / 'All Clear' card adds no information
**HIGH** · data-density · effort S · verified (high)

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** The bottom card (301-328) only restates what the three KPI cards already show: when there is work it says 'There are items requiring attention. Check pending results and patient queues above.' and when not, 'Operations are running smoothly.' It contains no counts, no list of which items, and no link — it tells the user to scroll back UP to the cards they just read.
- **Impact:** Low-value filler increases page length and pushes real content further from view on a dashboard meant for at-a-glance scanning.
- **Fix:** Best option: delete the card entirely (301-328). The three accent/warning-styled KPI cards (150-213) already signal status — the top "Pending Lab Results" card even turns warning-colored at line 151 — so a separate status banner is pure duplication and pushes content down. If the team wants a summary band, replace the prose with a compact, conditional alert that renders ONLY when hasPendingWork is true (suppress the "All Clear" state — an empty dashboard with zero-count cards already communicates calm), using shadcn Alert with an inline actionable list built from the already-computed metrics, e.g. map non-zero values to linked rows: `{metrics.pendingResults.length > 0 && <Link to="/diagnostics/pending">{metrics.pendingResults.length} reports awaiting entry</Link>}`, `{metrics.waitingOP.length > 0 && <Link to="/clinic/queue">{metrics.waitingOP.length} OP patients waiting</Link>}`, etc. Move this above the KPI grid, not below it, so the "items requiring attention" sit at the top of the scan path rather than the bottom.

### 18. 🟡 Three different labels resolve to the identical /clinic/queue route
**MEDIUM** · consistency · effort S

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** 'View Queue' (Waiting OP card, 186), 'View Admissions' (Active IP card, 207), and 'Visit Queue' (Quick Action, 240) all navigate to the same /clinic/queue. 'View Admissions' especially implies a distinct IP-only destination that does not exist; staff may expect to land on a filtered admissions view and instead get the generic combined queue.
- **Impact:** Mismatched label-to-destination breaks predictability and wastes a click re-filtering after arrival.
- **Fix:** If the queue page supports OP/IP filtering, deep-link with a query/tab param (e.g. /clinic/queue?tab=ip) so 'View Admissions' actually filters. Otherwise unify the label to 'OP / IP Queue' everywhere to set correct expectations.

### 19. 🟡 Loading state is a tiny text line; cards flash zeros then jump
**MEDIUM** · interaction-feedback · effort M

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** While loading, the only feedback is a small 'Loading live branch data...' line (143-148). The metric cards below still render immediately with computed zeros from empty arrays, so the user briefly sees '0' / 'All Clear' before real numbers populate, causing a content flash and potential misread. The spinner is also not announced to assistive tech (no aria-live/role=status).
- **Impact:** The momentary fake-zero/All-Clear flash can mislead a fast-scanning user, and screen-reader users get no announcement that data is loading.
- **Fix:** Render skeleton placeholders (shadcn Skeleton) inside the metric cards while loading instead of computed zeros, and wrap the loading indicator in role="status" aria-live="polite". Suppress the 'All Clear' card until a successful fetch completes.

### 20. 🟡 Primary KPI numbers are styled as low-emphasis muted text
**MEDIUM** · visual-hierarchy · effort S

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** The big count is the single most important datum in each card, yet Waiting OP (181) and Active IP (202) render `text-3xl font-bold text-muted-foreground`, and Pending Lab Results uses text-muted-foreground whenever the count is 0 (160). Using the muted/secondary token for the hero number contradicts its visual weight — a non-zero queue of waiting patients shows in the same de-emphasized gray as the descriptive caption beneath it.
- **Impact:** The most decision-relevant value (how many patients are waiting) is visually under-weighted, slowing the glance these cards exist to enable.
- **Fix:** Use text-foreground for the count when > 0 (reserve muted only for a true zero, if desired). Keep the warning/accent emphasis for actionable thresholds. Captions like 'in queue' stay muted; the number should not.

### 21. 🟡 Generic 'Dashboard' title with no branch/role/date context
**MEDIUM** · microcopy · effort S

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/components/layout/ContextBanner.tsx`
- **Problem:** The h1 is just 'Dashboard' with subtitle "Today's work at a glance" (139-140). For a multi-branch app the page never states which branch's data this is (the ContextBanner shows 'Branch: <name>' separately at the top, ContextBanner.tsx:14-15, so the live data shown here is implicitly branch-scoped but never labeled in the body). There is also no date, despite the dashboard being entirely 'today'-scoped (metrics like Today's OP/IP, Diagnostics Today, lines 249-298).
- **Impact:** On a multi-branch system, unlabeled branch- and date-scoped numbers risk being read against the wrong branch/day; a generic title wastes prime page real estate.
- **Fix:** Replace the generic title with a greeting + today's date (e.g. 'Good morning — Tuesday, 21 Jun 2026') and/or echo the active branch name so the 'today/this branch' scope is explicit in the content, not only in the banner. This also personalizes a screen staff stare at all day.

### 22. 🟡 Status/metric icons are decorative-only with no accessible labels
**MEDIUM** · accessibility · effort S

- **Files:** `health-hub/src/pages/Dashboard.tsx`
- **Problem:** Every lucide icon (FlaskConical, Stethoscope, Users, Clock, AlertCircle, CheckCircle2, etc., e.g. 154-157, 175-178, 291, 306-312) carries meaning (warning state, all-clear state) but has no aria-label/aria-hidden treatment. The AlertCircle conveys 'attention needed' and CheckCircle2 conveys 'all clear' purely visually; screen-reader users get nothing, and the warning is also color-only (text-warning at 154/160).
- **Impact:** Status meaning conveyed only through color/icon is invisible to screen-reader and low-vision users — a WCAG 1.4.1 (use of color) and name/role/value gap.
- **Fix:** Mark purely decorative icons aria-hidden="true", and for state-bearing ones (warning AlertCircle, All Clear CheckCircle2) provide an accessible label or accompanying visually-hidden text. Ensure the warning state is conveyed by more than color (it already adds an icon + text, so just expose them to AT).

### 23. ⚪ Branch accent color applied inconsistently (icon vs text, with !important overrides)
**LOW** · branding · effort M

- **Files:** `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/index.css`
- **Problem:** var(--branch-accent) is applied ad hoc via inline style across many spots: as icon color on most cards, as the big number color only for Reports Finalized (294-296), and as text color for 'All Clear' (311-312). Quick Action buttons use the .btn-branch-outline utility which forces the accent via `!important` on border AND color (index.css:392-399). The result is no consistent rule for when accent means 'brand chrome' vs 'positive/finalized state', and the !important utility will fight any future theming.
- **Impact:** Inconsistent color semantics weaken the visual language (is accent 'brand' or 'success'?), and the !important overrides make the accent fragile to maintain across branches.
- **Fix:** Define semantic intent: keep brand accent for chrome/icons only, and use the success token for 'finalized/all clear' states rather than the branch color, OR document accent-as-success and apply it uniformly. Replace inline style={{color: 'var(--branch-accent)'}} repetition with a small utility class and drop the !important by raising specificity instead.

---

## Diagnostics Workflow

_The diagnostics flow is functionally rich but suffers from systemic redundancy (every page re-states its title that the sidebar/banner already imply), a jarring native window.confirm() at the most trust-sensitive moment (duplicate-patient detection), an inconsistent and unexplained mix of status badges, a dead/non-functional Bill Number search field, and several accessibility gaps (no label-for on result inputs, empty alt/role on header icons, color-only flags). The New Visit form is a long single-column canvas with low data density and a verbose success screen._

### 24. 🔴 Native window.confirm() used for the high-stakes duplicate-patient decision
**CRITICAL** · interaction-feedback · effort M · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** At the single most consequential moment of registration — deciding whether a new bill attaches to an existing patient or forks a duplicate medical record — the app fires a native OS dialog: `const userConfirm = window.confirm("⚠️ Potential Duplicate Detected\n\n" + ...)` (DiagnosticsNewVisit.tsx:734-743). It is unstyled (breaks Sobhana branding), unscannable (a wall of \n-joined text with bullet glyphs •), and the OK/Cancel buttons are inverted from intent: "OK to USE EXISTING" vs "Cancel to CREATE NEW" — front-desk staff under time pressure routinely mis-map OK/Cancel, risking duplicate patient records or wrong-record merges.
- **Impact:** Wrong choice fragments or merges patient history — a data-integrity and trust hazard in a medical app, made worse by an ambiguous, unbranded dialog the staff can't visually parse at speed.
- **Fix:** Replace window.confirm with the existing shadcn AlertDialog, but note it cannot be a synchronous drop-in: the submit handler must be restructured. On a 409, stash the parsed `existing` patient in state (e.g. setDuplicateCandidate(existing)) and halt the submit instead of blocking on confirm(). Render an AlertDialog whose AlertDialogContent shows a structured card of the existing record — patientNumber, formatPatientName(name,title), ageDisplay, gender, masked phone — not a text blob. Provide two explicit, intent-labeled actions and remove all OK/Cancel ambiguity: a primary AlertDialogAction "Use existing ({existing.patientNumber})" that resolves the reuse path (current lines 750-764), and a destructive-variant AlertDialogAction "Create new record anyway" (className with bg-destructive) that runs the forceDuplicate retry (current lines 766+). Put the safe choice (Use existing) as the visually dominant primary and autofocus it; style the duplicate-creation action as destructive so a glance distinguishes them. Because the original used confirm() inside an await flow, wrap the two branches in promise-resolving callbacks or move them out of handleSubmit into onUseExisting/onForceCreate handlers so the async create/bill chain (which continues after this block) resumes correctly after the user chooses.

### 25. 🟠 Bill Number search input on New Visit does nothing
**HIGH** · interaction-feedback · effort M · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The Patient Lookup card renders a second field: `<Label htmlFor="bill">Bill Number (optional)</Label>` bound to `billSearch` (DiagnosticsNewVisit.tsx:1304-1312, state at :99). `billSearch` is written by onChange but never read anywhere — `handleSearch` (:464) and the whole submit path ignore it. Typing a bill number and pressing Enter or clicking Search has zero effect.
- **Impact:** A prominent field that silently does nothing erodes trust and wastes the time of speed-driven front-desk staff who assume it lets them pull up a prior visit by bill number.
- **Fix:** Either wire `billSearch` into the lookup (search visits/patients by bill number and populate matches) or remove the field entirely. If kept as a stub, hide it behind a feature flag rather than shipping a visibly inert input.

### 26. 🟠 Result-entry value inputs lack programmatic label association
**HIGH** · accessibility · effort M · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx`
- **Problem:** Each test row renders the name as a bare `<Label className="font-medium">{testName}</Label>` with no htmlFor, and the value `<Input>` has no id/aria-label (DiagnosticsResultEntry.tsx:1539-1541 and 1584-1609). The mobile column hints are plain `<span>Value</span>` (:1570), not associated. A screen-reader user tabbing to the input hears only 'edit text' with no test name, unit, or reference range. The same gap applies to the FlagBadge cell which conveys HIGH/LOW only via color/text with no row context.
- **Impact:** Doctors/lab staff using assistive tech (or even sighted users relying on the column header that scrolls off) cannot tell which test an input belongs to — a real accessibility barrier on the core data-entry screen, with patient-safety implications for entering a value against the wrong test.
- **Fix:** Generate a stable id per row (e.g. `const valueInputId = `result-${resultKey}``) and wire `htmlFor={valueInputId}` on the Label plus `id={valueInputId}` on both the `<Input>` and the `TestValueCombobox` trigger. Belt-and-suspenders: also add `aria-label={`${testName} (${testCode}) value${displayRefText ? `, reference ${displayRefText}` : ''}`}` so the unit/range is announced inline (the htmlFor alone won't carry the reference range). Mark the mobile column-hint spans (:1570, :1627, :1644) `aria-hidden="true"` since they are redundant once the input is labelled. For the flag, change FlagBadge to expose context for AT — wrap the input cell's status in `aria-describedby` pointing at the flag element, or render the chip with `<span role="status">{testName}: {flag}</span>` for the visually-hidden portion — rather than the proposed `aria-live`, which would spam announcements as the user tabs through unrelated rows. Avoid `aria-live` on a static per-row chip.

### 27. 🟠 Unsafe (patient as any).title access can crash list rows
**HIGH** · error-handling · effort S · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`
- **Problem:** Both list pages render `formatPatientName(patient?.name || 'Unknown', (patient as any).title)` (DiagnosticsPendingResults.tsx:345, DiagnosticsFinalizedReports.tsx:255). The name argument is null-guarded with `patient?.name` — implying patient can be null — but the very next argument dereferences `(patient as any).title` without optional chaining. If a visit ever comes back with a missing patient, the guarded name is moot and the row throws, taking down the whole list render.
- **Impact:** A single malformed visit (missing patient) crashes the entire Pending/Finalized list instead of degrading gracefully to 'Unknown', blocking staff from all other rows.
- **Fix:** Replace `(patient as any).title` with `patient?.title` in both files. Also drop the `as any` cast by typing `patient` properly (the visit type should carry an optional `title` field). For full graceful degradation, skip rows with no patient: in `visitsWithDetails.map`/filter, fall back to a single 'Unknown patient' display rather than relying on per-field optional chaining scattered across the JSX. While here, fix the sibling unsafe access at DiagnosticsPendingResults.tsx:187 (`patient?.name.toLowerCase()` -> `patient?.name?.toLowerCase()`).

### 28. 🟡 Every diagnostics page re-states a title the sidebar/banner already imply
**MEDIUM** · redundancy · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsReportPreview.tsx`
- **Problem:** Each page opens with a large h1 + muted subtitle block: `<h1 className="text-2xl font-bold">New Diagnostic Visit</h1>` + 'Register a patient...' (NewVisit:1254-1257), 'Pending Results' + 'Which lab cases still need results entered?' (Pending:282-285), 'Finalized Reports' + subtitle (Finalized:195-196), 'Report Preview' (Preview:632). The active nav item in Sidebar and the ContextBanner already establish where the user is, so the h1 is pure repetition and the second card heading compounds it — e.g. Finalized Reports has BOTH an h1 'Finalized Reports' AND a CardTitle 'Finalized Reports (N)' (Finalized:195 and :238). Pending Results likewise has the h1 plus 'Result Queue (N)' card title.
- **Impact:** Triple-stacked labeling (sidebar + h1 + card title) pushes the actual work (the queue/form) below the fold and adds visual noise without information, hurting the speed-driven workflows this app is built for.
- **Fix:** Drop the redundant card title where it duplicates the h1: on Finalized Reports keep the h1 and change the card title to just the count, or vice-versa. Consider moving page title + count into a single header row (e.g. `Finalized Reports · 12`) so the count lives with the h1 and the card header carries only filters/actions.

### 29. 🟡 Visit-created success screen is verbose, exclamatory, and pushes the next action down
**MEDIUM** · data-density · effort M

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** After every single registration, the entire viewport is replaced by a centered success card: a 64px check icon, `<h2 ...>Visit Created Successfully!</h2>` (DiagnosticsNewVisit.tsx:1080-1083), then a 6-row key/value block (Bill #, Payment Status, Final Total, Due, Visit Status, sometimes Report Flow + Referred By) and three full-width stacked buttons (Print Bill / Create Another Visit / View Pending Results). For a front-desk role processing dozens of patients an hour, this full-page interstitial with celebratory copy and an oversized icon is friction on every bill.
- **Impact:** High-frequency repetitive task gets a low-density, attention-grabbing screen each time; the most likely next action ('Create Another Visit') is the middle button, not the primary visual focus, slowing the loop.
- **Fix:** Make this a compact confirmation: smaller icon, drop the exclamation, collapse the detail rows into one or two lines (Bill # + total + due), and make 'Create Another Visit' the clear primary. Consider a toast + inline summary banner instead of a full screen takeover so staff can immediately start the next patient with the form still visible.

### 30. 🟡 Pending queue shows raw DRAFT/WAITING badges with no legend or unified meaning
**MEDIUM** · microcopy · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/components/ui/status-badge.tsx`
- **Problem:** The pending queue renders `<StatusBadge status={visit.status} />` (DiagnosticsPendingResults.tsx:373) where status is either DRAFT or WAITING. StatusBadge maps DRAFT→'Draft' (status-draft color) and WAITING→'Waiting' (status-pending color) (status-badge.tsx:16,20,29,31). To staff these two labels are opaque — both rows say 'Enter Results' as the action, so the page never explains why one case is 'Draft' and another 'Waiting' (results saved-but-not-finalized vs not-started). The same component also doubles as a payment-status badge on the success screen (NewVisit:1096), so 'Pending' can mean either 'payment pending' or 'results pending' depending on context.
- **Impact:** Two different badge vocabularies (visit lifecycle vs payment) share one component and color set, and the queue's DRAFT/WAITING distinction is undocumented — staff can't tell at a glance which lab cases are partially done.
- **Fix:** Use task-oriented labels in the queue (e.g. 'Not started' vs 'In progress / saved') instead of the raw enum, or add a one-line legend. Keep payment-status and visit-status badges visually distinct (different token families) so 'Pending' is never ambiguous.

### 31. 🟡 Icon-only action buttons rely on title attribute only; no accessible name
**MEDIUM** · accessibility · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`
- **Problem:** The finalized-report row actions are three icon-only buttons (Eye/Printer/MessageCircle) with only a `title="View Report"` / `title="Print"` / `title="Send via WhatsApp"` (DiagnosticsFinalizedReports.tsx:271-308). `title` is not a reliable accessible name (not announced consistently by screen readers, never shown on touch devices), and on mobile they render as a 3-col grid of bare icons (`grid-cols-3`, :270) with no visible text — staff must guess which icon sends a report to a patient.
- **Impact:** On the most sensitive action (WhatsApp-ing a medical report to a patient) there is no visible or reliably-announced label, risking mis-taps and excluding assistive-tech users.
- **Fix:** Add `aria-label` to each icon button (matching the title), and on mobile show a short text label beside the icon (the grid already gives full-width cells) so the destructive 'send report' action is unmistakable.

### 32. 🟡 Finalize/Release lives only inside the preview modal with no affordance on the page
**MEDIUM** · navigation · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsReportPreview.tsx`
- **Problem:** On the Report Preview page the only on-page action besides 'Back to Edit' is a secondary 'Preview Report Before Finalization' button (DiagnosticsReportPreview.tsx:978-990); the actual Finalize / Release-Partial buttons are rendered exclusively inside the full-screen preview modal header (:1046-1068). A user who has already reviewed the report on the page itself has no way to finalize without re-opening the modal, and there is no visible hint that finalize lives behind 'Preview'.
- **Impact:** The terminal action of the entire workflow is hidden one level deep with no labeling that it's there, confusing staff who expect a Finalize button on the page they're looking at.
- **Fix:** Either label the secondary button to set expectations (e.g. 'Preview & Finalize') or surface a disabled-until-previewed Finalize button on the page itself. At minimum add helper text explaining that finalize happens after the mandatory preview step.

### 33. 🟡 New Visit is a long single-column form with a large empty right canvas
**MEDIUM** · visual-hierarchy · effort L

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The whole registration form is centered in `max-w-3xl mx-auto space-y-6` (DiagnosticsNewVisit.tsx:1252) and stacks Patient Lookup → Matching Patients → New Patient → Select Tests → Billing as five full-width cards, each appearing sequentially. On a desktop front-desk monitor this leaves wide empty margins while the live bill summary (Total/Discount/Final/Due) is buried at the bottom of the Billing card (:2146-2273), forcing staff to scroll away from the test selector to see the running total.
- **Impact:** Low information density and a lot of vertical scrolling for a high-frequency desktop task; the running bill total — the number staff quote to the patient — is not persistently visible.
- **Fix:** On lg+ screens, use a two-column layout (form steps on the left, a sticky bill-summary/total panel on the right) so the live total and 'Generate Bill' CTA stay in view while selecting tests and entering payment.

### 34. ⚪ 'Tests:' label renders with an empty value when only bill-only items exist
**LOW** · microcopy · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`
- **Problem:** `formatTestList` returns `labels.join(', ')`, which is an empty string when every order is BILL_ONLY or labels resolve empty (Pending:41-62 / Finalized:22-43). The row then shows `Tests: ` with nothing after it (Pending:356-358, Finalized:264-266). There's also a separate 'Includes bill-only items' chip, so a bill-only-heavy visit can show a dangling, valueless 'Tests:' label.
- **Impact:** A label with no value reads as a rendering bug and adds noise to dense queue rows.
- **Fix:** Guard the render: only output the 'Tests:' span when `formatTestList(...)` is non-empty, otherwise fall back to a single em-dash or omit it.

### 35. ⚪ Hand-rolled inline SVG lock icon instead of the lucide Lock used everywhere else
**LOW** · consistency · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsReportPreview.tsx`
- **Problem:** The prior-partial-release banner in ResultEntry draws a raw inline `<svg ... viewBox="0 0 20 20">` lock path (DiagnosticsResultEntry.tsx:1967-1978), while the visually-identical banner in ReportPreview uses the imported lucide `<Lock className="... text-blue-700" />` (DiagnosticsReportPreview.tsx:662). Two implementations of the same icon in two copies of the same banner.
- **Impact:** Icon weight/sizing can drift between the two banners, and the bespoke SVG bypasses the lucide stroke conventions used across the app — a maintenance and visual-consistency nit.
- **Fix:** Replace the inline SVG with the lucide `Lock` icon already imported in the sibling file, and extract the duplicated 'prior partial release' banner into one shared component used by both pages.

### 36. ⚪ Create-Another-Visit reset drops the title field, leaving stale title state
**LOW** · error-handling · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The success screen's 'Create Another Visit' handler resets newPatient with an object literal that omits `title`: `setNewPatient({ name: "", age: "", ageUnit: "YEARS", dateOfBirth: "", gender: "M", whatsappOptIn: true })` (DiagnosticsNewVisit.tsx:1196-1203), whereas the initial state (:129-137) includes `title: ""`. The previous patient's title is therefore not cleared on reset.
- **Impact:** Next registration can carry the prior patient's title (e.g. 'Dr'/'Mrs') into a fresh form, producing a wrong honorific on the bill/report unless the operator notices.
- **Fix:** Include `title: ""` in the reset object (and consider extracting an `INITIAL_NEW_PATIENT` constant reused by both the initial state and the reset to prevent future drift).

---

## Diagnostics Editors & Selectors

_The selectors and rich-text editors are functional and thoughtfully commented, but they bypass shadcn primitives in favor of hand-rolled dropdowns (no ARIA/listbox semantics, blur-timeout patterns), ship a fully duplicated dead TestSelector, hardcode a slate/white palette that ignores the brand token system and dark mode in the rich-text editors, and rely on the deprecated document.execCommand API with no keyboard shortcuts. Several feedback states (muted-but-clickable toolbar, no busy state on confirm, no disabled-affordance on advance) mislead users._

### 37. 🟠 ProductSelector & TestSelector are hand-rolled comboboxes with no ARIA/listbox semantics
**HIGH** · accessibility · effort L · verified (high)

- **Files:** `health-hub/src/components/diagnostics/ProductSelector.tsx`, `health-hub/src/components/diagnostics/TestSelector.tsx`
- **Problem:** Both selectors render a plain `<Input>` plus an absolutely-positioned `<div>` dropdown of `<div>` rows (ProductSelector.tsx lines 296-368, TestSelector.tsx lines 178-226). There is no `role="combobox"`, `aria-expanded`, `aria-activedescendant`, `aria-controls`, `role="listbox"`/`role="option"`, or `aria-selected`. Keyboard nav is reimplemented by hand (ArrowDown/Up/Enter in handleKeyDown) with a `highlightedIndex` that is never exposed to assistive tech. Meanwhile the sibling `TestValueCombobox.tsx` correctly uses shadcn's `Command`/`Popover` with `role="combobox"` (line 77) and aria-expanded (line 78). So the codebase already has the right primitive — these two components diverge from it. A screen-reader user gets an unlabeled text box with invisible results and no announcement of the highlighted item.
- **Fix:** Rebuild both on shadcn Command + Popover. Note the nearest in-repo reference (TestValueCombobox.tsx) is a Button-triggered combobox, not a typeahead text field, so the right pattern here is a Popover containing cmdk's <Command> with <CommandInput> (the search box), <CommandList>, <CommandGroup> (preserving the department / product-type groupings already present), and <CommandItem> per row — cmdk supplies role=listbox/option, aria-selected, aria-activedescendant, type-ahead filtering and full keyboard nav for free, and lets you delete the manual handleKeyDown/highlightedIndex/listRef/blur-timeout machinery. Keep the existing per-row markup (price, badges, code) inside each CommandItem and call handleAdd/handleAddTest from onSelect. If a full rewrite is out of scope, the minimal fallback must also fix labeling, not just roles: (1) on the Input add role="combobox", aria-expanded={isOpen}, aria-controls={listId}, aria-autocomplete="list", and an accessible name (aria-label since the only label is a placeholder); (2) role="listbox" + id={listId} on the dropdown container; (3) role="option", aria-selected={flatIdx===highlightedIndex}, and a stable id per row; (4) aria-activedescendant on the Input pointing at the highlighted row's id; (5) ensure the highlighted row scrolls into view (scrollIntoView) since AT users can't see it. Also give the no-results state role="status"/aria-live="polite" so "No products/tests found" is announced.

### 38. 🟠 TestSelector is dead code duplicating ProductSelector (drift risk, redundancy)
**HIGH** · redundancy · effort S · verified (high)

- **Files:** `health-hub/src/components/diagnostics/TestSelector.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** A repo-wide grep finds zero importers of `TestSelector` — only `ProductSelector` is wired up (DiagnosticsNewVisit.tsx). TestSelector.tsx (283 lines) is a near-identical earlier copy of ProductSelector: same search input, same blur-timeout dropdown, same chip rendering, same running-total footer, but with subtly different behavior (groups by department instead of product type, uses `priceInPaise/100` instead of `effectivePrice`, no quick-add, no Enter-to-advance focus-flow). Keeping two divergent copies of the same widget guarantees they rot apart and confuses the next engineer about which is canonical.
- **Fix:** Delete TestSelector.tsx outright (along with its local LabTest interface) — it is unreferenced dead code, so removal is zero-risk and an S-effort win. After deleting, run `npm run build` (tsc) to confirm no dangling references and ideally enable a lint rule (eslint no-unused / knip / ts-prune) so future orphaned components are caught in CI rather than by manual audit. Do NOT attempt to merge the two: ProductSelector is strictly the superset (product-type grouping, branch-resolved effectivePrice with override strike-through, quick-add bill-only, Enter-to-advance focus-flow), so there is no salvage value in TestSelector. If a tests-only variant is ever needed, gate ProductSelector's existing behavior via a prop (e.g. a productType filter or an allowQuickAdd/onDone toggle) instead of re-forking.

### 39. 🟠 Rich-text editors hardcode a slate/white palette, ignoring design tokens, branch accent, and dark mode
**HIGH** · branding · effort M · verified (high)

- **Files:** `health-hub/src/components/diagnostics/RichTextNarrativeEditor.tsx`, `health-hub/src/components/diagnostics/RichTextToolbar.tsx`, `health-hub/src/index.css`
- **Problem:** RichTextNarrativeEditor.tsx wraps the editor in `border border-slate-200 bg-white shadow-sm` (line 30), a hardcoded white surface with `bg-[linear-gradient(180deg,#ffffff_0%,#fbfdff_100%)]` (line 39) and literal hex `shadow-[...rgba(15,23,42,0.4)]`. RichTextToolbar.tsx hardcodes `bg-slate-50/95`, `text-slate-600`, `border-slate-200`, `text-slate-900` throughout (lines 43, 52, 60, 98...). index.css sets the empty placeholder color to a literal `#94a3b8` (line 449). None of these use the `bg-card`/`bg-background`/`border-border`/`text-foreground`/`text-muted-foreground` tokens the rest of the app uses, so the editor stays bright white in dark mode (illegible) and never reflects the per-branch accent. Compare to TestInputConfigEditor, which correctly uses `border-primary bg-primary/5` token classes.
- **Fix:** Replace slate/white literals with semantic tokens throughout: editor wrapper -> `border-border bg-card`; toolbar shell -> `border-border bg-muted/80`; toolbar buttons -> `text-muted-foreground hover:bg-accent hover:text-accent-foreground` with active state `bg-accent text-accent-foreground`; selects/color-labels -> `border-border bg-background text-foreground`; dividers -> `bg-border`; content surface -> `border-border bg-background text-foreground`. For the placeholder (index.css line 449) use `color: hsl(var(--muted-foreground))` instead of `#94a3b8`. Note the gradient on line 39 and the focus shadow on line 47 both bake in literal hex — replace the gradient with `bg-card` (or a token-driven gradient) and the `shadow-[...rgba(37,99,235,0.3)]` focus shadow with a `--primary`/`--ring`-derived value (e.g. `focus-within:ring-2 focus-within:ring-ring`) so the editor truly reflects the branch accent rather than a fixed blue. Verify token contrast in both light and `.dark` after the swap.

### 40. 🟡 RichTextToolbar 'inactive' state is misleading: muted to 60% but every control still fires
**MEDIUM** · interaction-feedback · effort S

- **Files:** `health-hub/src/components/diagnostics/RichTextToolbar.tsx`, `health-hub/src/components/diagnostics/ReportFramedNarrativeEditor.tsx`
- **Problem:** The `active` prop is documented as 'controls are visually muted and skip mousedown.preventDefault' (line 35), and ReportFramedNarrativeEditor passes `active={isActive}` so the toolbar dims to `opacity-60` (line 53) before the editor is focused. But the buttons are NOT disabled and their handlers do not check `active` — every `onMouseDown` still calls `event.preventDefault()` and `dispatch(...)` (e.g. lines 99-103). The doc comment's claim that it 'skip[s] mousedown.preventDefault' is false. So a user sees greyed-out controls (signal: 'these don't work yet') yet clicking Bold while nothing is focused still dispatches a no-op execCommand. The dropdowns (block/font/size selects, color inputs) aren't dimmed or guarded at all.
- **Fix:** Either make the muted state real (add `disabled={!active}` to the Buttons/selects/color inputs and early-return from `dispatch` when `!active`), or drop the muting entirely and keep the toolbar fully live (execCommand auto-focuses the editor anyway). Do not show a disabled-looking affordance that is actually live — fix the doc comment to match whichever behavior you keep.

### 41. 🟡 Rich-text editing relies entirely on deprecated document.execCommand with no keyboard shortcuts
**MEDIUM** · interaction-feedback · effort M

- **Files:** `health-hub/src/components/diagnostics/RichTextSurface.tsx`, `health-hub/src/components/diagnostics/RichTextToolbar.tsx`
- **Problem:** All formatting goes through `commandDocument.execCommand(command, false, valueArg)` (RichTextSurface.tsx line 224), a long-deprecated, inconsistently-implemented API (the font-size path even has to post-process `<font size>` legacy tags back into spans, lines 240-250 — a sign of the API's fragility). Doctors writing narrative reports get no Ctrl/Cmd+B/I/U shortcuts wired through the surface (the toolbar is mouse-only via onMouseDown), and there is no onKeyDown shortcut handling on the contentEditable. For a keyboard-heavy Indian front-desk/doctor audience, mouse-only bold/italic in a long-form editor is notable friction.
- **Fix:** Add a keydown handler on the RichTextSurface that maps Ctrl/Cmd+B/I/U (and optionally Ctrl+Z/Y) to `runCommand('bold'|'italic'|'underline')`, and surface those shortcuts in the toolbar button `title`s (e.g. title="Bold (Ctrl+B)"). Longer term, migrate off execCommand to a maintained editor (Tiptap/Lexical), but shortcut support is the high-value near-term fix.

### 42. 🟡 Toolbar mixes native <select>/<input type=color> with shadcn Buttons — inconsistent styling, focus rings, and a11y labels
**MEDIUM** · consistency · effort M

- **Files:** `health-hub/src/components/diagnostics/RichTextToolbar.tsx`
- **Problem:** The block/font/size pickers are raw native `<select>` elements (lines 57-91) styled ad-hoc with `focus:ring-2 focus:ring-primary/25`, while the format actions are shadcn `<Button variant="ghost">` with a different `focus-visible` ring inherited from the Button component. The color pickers are bare `<input type="color">` inside a `<label>` (lines 212-234). None of the three selects has an accessible name (no `aria-label` / associated `<label>`) — a screen reader announces an unlabeled combobox; the font-size select is just '8' / '12'. Native selects also can't match the app's Select dropdown look (DiagnosticsNewVisit uses shadcn Select elsewhere).
- **Fix:** Swap the three native selects for shadcn `Select` components (consistent popover styling, keyboard, and `aria-label`) and add `aria-label="Block format"/"Font family"/"Font size"`. Give the color `<input>`s an `aria-label` (the visible 'Text'/'Highlight' text isn't programmatically associated). Unify focus-ring treatment across all toolbar controls.

### 43. 🟡 Selector dropdowns close on a 200ms blur timeout — fragile, no outside-click/scroll handling, dropdown can't be tabbed into
**MEDIUM** · interaction-feedback · effort M

- **Files:** `health-hub/src/components/diagnostics/ProductSelector.tsx`, `health-hub/src/components/diagnostics/TestSelector.tsx`
- **Problem:** Both selectors close the results list via `onBlur={() => setTimeout(() => setIsOpen(false), 200)}` (ProductSelector.tsx line 272). This is a known-brittle pattern: the dropdown is an absolutely-positioned div not in a Popover, so it doesn't reposition on scroll, has no portal/collision handling (it can clip inside scrollable parents), and the rows are `<div>`s reachable only by mouse — Tab can't move focus into them. The 200ms race also means a slow click after focus loss silently fails. shadcn Popover/Command (used in TestValueCombobox) handles all of this natively.
- **Fix:** Move the results list into a shadcn `Popover` anchored to the input (or full Command combobox), which gives outside-click dismissal, Escape handling, portal rendering, and collision-aware positioning for free, removing the setTimeout race.

### 44. 🟡 PartialReleaseSelectorDialog confirm button has no loading state when busy
**MEDIUM** · interaction-feedback · effort S

- **Files:** `health-hub/src/components/diagnostics/PartialReleaseSelectorDialog.tsx`
- **Problem:** The dialog accepts a `busy` prop and uses it only to disable the buttons (lines 177, 182: `disabled={busy || releasing === 0}`). The confirm button still just renders `{confirmLabel}` ('Continue → Preview') with no spinner or label change while busy. On a slow connection the user clicks, the button greys out, and there is no positive 'working…' signal — easy to read as a frozen UI and click elsewhere. PdfPreview.tsx in the same area correctly shows a `Loader2` spinner for its loading state (line 93), so the spinner idiom exists.
- **Fix:** When `busy`, render a `<Loader2 className="mr-2 h-4 w-4 animate-spin" />` plus a working label (e.g. 'Releasing…') inside the confirm Button, matching the PdfPreview loading idiom.

### 45. 🟡 Enter-to-advance silently no-ops with an empty selection, with no on-screen affordance
**MEDIUM** · microcopy · effort S

- **Files:** `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** handleKeyDown only advances (`onDone()`) when the search is empty AND `selectedProductIds.length > 0` (lines 220-227); otherwise Enter does nothing. The reasoning is sound (the billing section isn't rendered yet), but there is no visible button or hint for advancing — the only way forward is an undiscoverable empty-input Enter, and pressing it with zero selections gives no feedback (no toast, no shake, nothing). New front-desk staff have no way to learn the flow. The empty state text 'Start typing to search and add tests, panels, or bill-only items.' (line 438) never mentions Enter-to-continue.
- **Fix:** Add a visible primary 'Continue' / 'Next →' button (disabled with a tooltip 'Add at least one item' when selection is empty) so advancing is discoverable and the disabled reason is explicit; keep the Enter shortcut as an accelerator and mention it in helper text.

### 46. ⚪ Inconsistent search thresholds: results render at 1 char but the 'No results' state only at 2
**LOW** · interaction-feedback · effort S

- **Files:** `health-hub/src/components/diagnostics/ProductSelector.tsx`, `health-hub/src/components/diagnostics/TestSelector.tsx`
- **Problem:** filteredProducts starts matching as soon as `searchQuery.trim()` is non-empty — i.e. 1 character (ProductSelector.tsx line 114). But the empty/no-results message is gated on `searchQuery.length >= 2` (line 371; TestSelector.tsx line 229). So typing a single character that matches nothing shows neither results NOR the 'No products found' message NOR the quick-add fallback — the dropdown just silently doesn't appear, which reads as broken. The Add-Bill-Only escape hatch is unreachable for 1-char queries.
- **Fix:** Use one consistent threshold. Either render the no-results/quick-add state from 1 char (`searchQuery.trim().length >= 1`) or require 2 chars before searching at all, so the user never sees a dead, blank dropdown state.

### 47. ⚪ TestInputConfigEditor leaks raw rootDefinitionId to end users (developer-facing string in UI)
**LOW** · microcopy · effort S

- **Files:** `health-hub/src/components/diagnostics/TestInputConfigEditor.tsx`
- **Problem:** The editor renders `Saved per rootDefinitionId: {rootDefinitionId}` in a footer (lines 321-323), exposing an internal database ID and the literal camelCase field name `rootDefinitionId` to the owner/admin configuring tests. The testLabel hint above also says 'shared across every version, every panel that uses it' (lines 95-98) which already communicates the scope in plain language — the ID line is pure developer debug noise in a production UI.
- **Fix:** Remove the rootDefinitionId footer line (or hide it behind a dev-only flag). The human-readable testLabel hint already conveys the 'shared everywhere' scope; surfacing an opaque ID adds no user value and erodes the polished feel.

### 48. ⚪ Preset value rows allow blank/duplicate entries with no inline validation
**LOW** · error-handling · effort S

- **Files:** `health-hub/src/components/diagnostics/TestInputConfigEditor.tsx`
- **Problem:** `addOption` pushes an empty string (line 58) and `setOption` allows any text including blanks and duplicates of existing presets. Blanks/dupes are only silently dropped on save (cleanedOptions filter, line 383; bulk dedupe at lines 78-87) — but the manual add/edit path gives no inline feedback, so an admin can create three empty rows or two 'Positive' rows and only discover they vanished after saving. The bulk-paste path dedupes but the single-add path does not, an inconsistency.
- **Fix:** Mark empty/duplicate option Inputs with a destructive border + a small inline hint (e.g. 'Blank values are ignored' / 'Duplicate'), and consider disabling Add while the last row is still empty, so the validation behavior is visible before save rather than a surprise after.

### 49. ⚪ Preset option list keyed by array index, breaking drag-reorder identity and focus retention
**LOW** · interaction-feedback · effort M

- **Files:** `health-hub/src/components/diagnostics/TestInputConfigEditor.tsx`
- **Problem:** The editable preset list uses `key={idx}` (line 167) on `<li>` rows that are also draggable/reorderable (reorder at lines 65-71). With index keys, reordering or deleting a row makes React reuse DOM nodes by position rather than identity, so the currently-focused input or in-progress text can jump to a different value after a drag/delete, and drag animations are janky. Drag is also mouse-only — no keyboard reorder affordance despite the otherwise keyboard-conscious app.
- **Fix:** Key rows by a stable id (assign a uid when adding an option, or at minimum `key={`${idx}-${opt}`}` as a stopgap). Add keyboard reorder (e.g. Alt+ArrowUp/Down on the focused row) or a small up/down button pair for non-pointer users.

---

## Clinic & Patient 360

_The Patient 360 flow is functional but suffers from a hard naming/wayfinding split (sidebar "Patient 360" vs page "Global Patient Search"), a dead subContext prop that is never rendered anywhere, inconsistent page-header patterns (centered vs left-aligned), repetitive "Read-Only" badging, hardcoded status colors that bypass design tokens, and several friction/accessibility gaps (native window.confirm for duplicate handling, no field labels on big search-type buttons, no a11y on custom spinners/modal). The New Visit billing flow also has a broken split-payment numeric state._

### 50. 🟠 Sidebar says 'Patient 360', the page titles itself 'Global Patient Search' (wayfinding break)
**HIGH** · navigation · effort S · verified (high)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** The sidebar nav item is `label: 'Patient 360'` for both staff and owner (Sidebar.tsx:77 and :128), routing to `/clinic/patient-search`. But the landing page renders `<h1 ...>Global Patient Search</h1>` (GlobalPatientSearch.tsx:92). A user clicks 'Patient 360' and lands on a page titled 'Global Patient Search' with no 'Patient 360' label visible until they drill into an individual patient. The in-file doc comment even mislabels this: 'Global Search (/clinic/patient-search) - Search by phone/name across all branches' (Patient360.tsx:28). The two screens are conceptually one feature ('Patient 360') but are named as if they were two.
- **Fix:** Standardize on "Patient 360" as the feature name. In GlobalPatientSearch.tsx: change the h1 (line 92) to "Patient 360" and update the AppLayout subContext (line 88) from "Global Patient Search" to "Patient 360" so the breadcrumb matches too. Keep the descriptive search intent as the sub-line — tighten line 94 to "Search any patient across all Sobhana branches" (uses brand name, clarifies cross-branch scope). The "Search by Phone / Search by Name" tabs already convey that this is the search entry point, so a separate "Search" page title is redundant. Optionally update the Patient360.tsx doc comment (line 28) to call it "Patient 360 — Search (/clinic/patient-search)" for internal consistency.

### 51. 🟠 Duplicate-patient detection uses native window.confirm (off-brand, unstyled, OK/Cancel inverted)
**HIGH** · error-handling · effort M · verified (high)

- **Files:** `health-hub/src/pages/clinic/ClinicNewVisit.tsx`
- **Problem:** On a 409 duplicate, the flow shows a raw browser `window.confirm(...)` with emoji and bullet text (ClinicNewVisit.tsx:352-361). This is unstyled OS chrome (breaks the Sobhana brand), is not keyboard/focus-managed by the app, and dangerously overloads the generic OK/Cancel buttons: 'Click OK to USE EXISTING patient / Click Cancel to CREATE NEW patient anyway'. A front-desk user moving fast can easily hit the wrong one and create a duplicate medical record — a data-integrity and trust risk in a patient system.
- **Fix:** Replace window.confirm with a shadcn AlertDialog. Because the confirm sits inside an async submit handler awaiting a user decision, refactor so the 409 path sets React state (e.g. setDuplicateCandidate(existing) and a pending-payload ref) and surfaces a controlled <AlertDialog open={!!duplicateCandidate}>. Render the existing patient card (patientNumber, formatted name+title, ageDisplay/age, gender, phone) and TWO explicit AlertDialogAction buttons with unambiguous verbs: "Use existing patient" (primary, autoFocus so the safe option is the default focus) and "Create new patient anyway" (use the destructive/outline variant via buttonVariants). Resolve the awaiting promise (or call the appropriate continuation) based on which button is pressed, and ensure the rest of the visit submit flow resumes after the choice. Avoid making "create new" the default-focused action. Note the same pattern should be audited elsewhere if window.confirm is used in other flows.

### 52. 🟠 Global search input and patient-card data have no accessible labels / icon-only buttons lack names
**HIGH** · accessibility · effort S · verified (high)

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`
- **Problem:** The search Input (GlobalPatientSearch.tsx:123-133) has only a placeholder, no `<Label>`/aria-label, so screen readers announce an unlabeled textbox. In ClinicNewVisit.tsx:674-680 the phone-lookup button is icon-only (`<Search/>` with no text and no aria-label) — announced as just 'button'. The search-results CardTitle packs name | age | gender separated by literal pipe `<span>|</span>` characters (GlobalPatientSearch.tsx:178-185), which screen readers read as 'vertical bar', producing 'Name vertical bar 45 yrs vertical bar M'.
- **Fix:** Add a visible or sr-only Label tied to the search input via htmlFor/id; add `aria-label="Search"` to the icon-only lookup button (and to the modal close X in Patient360.tsx:787-799 which is also icon-only). Replace the literal '|' separators with CSS dividers or wrap each datum in its own element with `aria-hidden` on the visual pipe, or use a comma-joined visually-hidden string.

### 53. 🟠 Split-payment amounts do string arithmetic, breaking the live cash/online feedback
**HIGH** · interaction-feedback · effort S · verified (high)

- **Files:** `health-hub/src/pages/clinic/ClinicNewVisit.tsx`
- **Problem:** `consultationFee` is a string state (initialized `useState(DEFAULT_CONSULTATION_FEE)` = '500'). When SPLIT is chosen, `setSplitAmounts({ cash: consultationFee, online: 0 })` stores the STRING '500' as cash (ClinicNewVisit.tsx:1165), and the auto-balancing uses `consultationFee - cash` (1196) and `consultationFee - online` (1210). String-minus-number coerces unpredictably (e.g. '500' - 100 = 400 works, but the initial cash field shows the raw string and any concatenation paths misbehave), and `Math.max(0, '500' - cash)` is fragile. The user sees an inconsistent/incorrect split breakdown — direct feedback corruption at the point of taking money.
- **Fix:** Parse the fee once and use a number everywhere. Add `const feeNum = Number.parseInt(consultationFee, 10) || 0;` (you already compute `parsedConsultationFee` at line 427 — reuse/lift that). Then: line 1165 -> `setSplitAmounts({ cash: feeNum, online: 0 })`; line 1196 -> `online: Math.max(0, feeNum - cash)`; line 1210 -> `cash: Math.max(0, feeNum - online)`. This guarantees `splitAmounts.cash`/`online` are always numbers, fixing the string-typed amount sent at line 464. Additionally, since the fee Input is editable, re-seed `splitAmounts` when `consultationFee` changes while SPLIT is active (e.g. an effect or in the fee onChange) so the split doesn't go stale against the new total. Finally, add a validation hint when `splitAmounts.cash + splitAmounts.online !== feeNum` so reception can't under/over-allocate, and block submit in that case.

### 54. 🟡 subContext prop is passed on every page but never rendered (dead API)
**MEDIUM** · information-architecture · effort M

- **Files:** `health-hub/src/components/layout/AppLayout.tsx`, `health-hub/src/components/layout/ContextBanner.tsx`, `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`
- **Problem:** Every page passes a subContext string — `subContext="Global Patient Search"` (GlobalPatientSearch.tsx:88), `subContext="Patient 360"` (Patient360.tsx:411/421/442), `subContext="Reception"` (ClinicNewVisit.tsx:548/645, ClinicVisitQueue.tsx:215). AppLayout declares the prop (AppLayout.tsx:11/14) but only ever renders `<ContextBanner />`, which takes NO props and shows only 'Branch: <name>' (ContextBanner.tsx). So none of these sub-context labels appear in the UI. The intended secondary wayfinding (which workflow you're in) is silently dropped on every clinic screen.
- **Fix:** Either wire it up — pass `subContext` into ContextBanner and render it next to the branch (e.g. 'Branch: Main • Reception'), giving each page a visible context crumb — or delete the prop from AppLayout and all call sites to stop implying functionality that doesn't exist. Wiring it up is the higher-value fix and would also solve the Patient 360 naming-drift wayfinding gap.

### 55. 🟡 Search page centers its h1 while every other clinic page left-aligns
**MEDIUM** · consistency · effort S

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`
- **Problem:** GlobalPatientSearch.tsx:91 wraps the title in `<div className="text-center mb-8">` with `<h1 className="text-2xl font-bold text-foreground">`. Every sibling page left-aligns the same pattern: ClinicNewVisit.tsx:647 (`<div><h1 className="text-2xl font-bold">New Clinic Visit</h1>`), ClinicVisitQueue.tsx:217 (`<h1 className="text-2xl font-bold">Visit Queue</h1>`), and Patient360.tsx left-aligns everything. The centered header makes the search page feel like a different app and breaks the established top-left title + muted subtitle rhythm.
- **Fix:** Drop `text-center` and use the shared left-aligned pattern: `<div><h1 className="text-2xl font-bold">…</h1><p className="text-muted-foreground mt-1">…</p></div>`. Consider extracting a small `<PageHeader title subtitle />` component so all four pages stay aligned.

### 56. 🟡 Phone/Name search toggle is two full-width buttons instead of a Tabs/SegmentedControl
**MEDIUM** · interaction-feedback · effort S

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** The search-type selector (GlobalPatientSearch.tsx:102-119) is two equally-weighted `flex-1` Buttons ('Search by Phone (recommended)' default vs 'Search by Name' outline). This is a mutually-exclusive choice (a toggle), but rendering it as two large competing primary/outline buttons reads as two separate actions, eats vertical space, and the '(recommended)' microcopy crammed into the button label is awkward. There is also no semantic grouping (no role=tablist / radiogroup), so screen readers announce two unrelated buttons.
- **Fix:** Use shadcn `Tabs` (TabsList/TabsTrigger 'Phone' | 'Name') or a Toggle/segmented control above the input — visually a single control with two segments. Move '(recommended)' out of the label into helper text or a small Badge. This compresses the form and gives correct tab/radio semantics.

### 57. 🟡 'Read-Only' is repeated 5+ times on the Patient 360 view (redundant noise)
**MEDIUM** · redundancy · effort S

- **Files:** `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** Patient 360 hammers 'Read-Only' everywhere: header banner pill 'Read-Only' (Patient360.tsx:460-463), Financial Summary card badge 'Read-Only' (531-533), the footer paragraph 'This is a complete, read-only record…' (716-720), the visit drawer title badge 'Read-Only' (195-197), and the drawer's full Lock-icon 'Read-Only View' panel (336-345). Meanwhile the Patient Identity card IS editable (PatientEditDialog at 472) and the visit drawer offers Print/WhatsApp/Print-Bill actions — so the blanket 'read-only' messaging is both repetitive and partly inaccurate, undermining trust in the labeling.
- **Fix:** State read-only once, authoritatively — keep the single header banner pill and remove the duplicate Financial-Summary badge and the footer sentence. In the visit drawer, replace the redundant title badge + bottom Lock panel with one concise line, and reword so it's clear that *history is read-only but you can still print/share* (the current drawer literally says 'No changes can be made' while exposing Print Bill / WhatsApp).

### 58. 🟡 Status colors hardcoded (text-green-600/amber-600/blue-700) instead of design tokens
**MEDIUM** · branding · effort M

- **Files:** `health-hub/src/pages/clinic/Patient360.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`
- **Problem:** Status/payment coloring bypasses the success/warning/destructive + status tokens defined in index.css/tailwind.config. Patient360.tsx getStatusColor returns raw `text-green-600` / `text-amber-600` / `text-blue-600` (82-95), and payment status uses `text-green-600`/`text-amber-600` inline (242, 656). 'Revisit' info uses `text-blue-700 border-blue-200` (625, 665, 250). ClinicVisitQueue.tsx and ClinicNewVisit.tsx repeat the same blue-50/blue-200/amber-50 hardcodes (e.g. ClinicNewVisit.tsx:1023-1066, 1137-1155). This is a systemic divergence from the token system — the app ships a StatusBadge component (used elsewhere in these very files) yet plain text statuses are recolored by hand, so dark mode and per-branch theming will be inconsistent.
- **Fix:** Route all status/payment text through the token classes (text-success / text-warning / text-destructive) and reuse `StatusBadge` for the 'Report Finalized / Results Pending' states in the timeline instead of colored `<p>`. Add a single semantic token for the 'revisit/info' blue (e.g. an `info` token) and replace the scattered blue-50/100/200/700 literals.

### 59. 🟡 Loading spinner and full-screen report modal lack ARIA/focus handling
**MEDIUM** · accessibility · effort M

- **Files:** `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** The page loading state is a bare `<div className="animate-spin …">` with no `role="status"`/`aria-label` and no visible text (Patient360.tsx:412-414), so non-sighted users get no 'Loading' announcement. The full-screen report preview is a hand-rolled `<div className="fixed inset-0 z-50 …">` (740-812) rather than a Dialog: it has no `role="dialog"`/aria-modal, no focus trap, and no Escape-to-close — only the X button closes it, and focus is not returned to the trigger. Background content stays focusable behind the overlay.
- **Fix:** Give the spinner `role="status"` with an sr-only 'Loading patient…' label (or reuse a shared Spinner component). Convert the preview overlay to shadcn `Dialog`/`DialogContent` (full-screen variant) to get focus trap, Escape handling, aria-modal, and focus restoration for free.

### 60. 🟡 Inconsistent revisit terminology: 'Revisit OP' / 'Recurring Visit' / 'recurring / revisit … free follow-up'
**MEDIUM** · microcopy · effort S

- **Files:** `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** The same concept is named three different ways. ClinicVisitQueue.tsx:290 derives `revisitLabel = visit.visitType === 'OP' ? 'Revisit OP' : 'Recurring Visit'`, and its dialog says 'This is a recurring / revisit consultation with free follow-up' (468). ClinicNewVisit.tsx and Patient360.tsx consistently use just 'Revisit' (e.g. ClinicNewVisit.tsx:1110 'Revisit', Patient360.tsx:626 'Revisit'). Staff see 'Revisit OP' in the queue but 'Revisit' on the slip/360, and 'Recurring Visit' for IP — three labels for one billing concept create confusion about whether these are the same thing.
- **Fix:** Standardize on one term, 'Revisit' (with the OP/IP shown separately as the existing visit-type badge). Drop the OP/IP-dependent label branch in ClinicVisitQueue.tsx:290 and align the dialog wording at line 468 to match the 'No new bill — references the earlier paid visit' phrasing used in ClinicNewVisit.tsx:1111-1114.

### 61. ⚪ 'Visit Timeline' is a flat card list with no temporal grouping or visual spine
**LOW** · visual-hierarchy · effort M

- **Files:** `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** The section is titled 'Visit Timeline (Newest → Oldest)' (Patient360.tsx:577-582) but renders as identical stacked cards (591-711) with a per-card date column. There is no connecting spine, no year/month grouping, and no visual distinction between recent and old visits — for a patient with many visits across branches this reads as an undifferentiated list, not a timeline, making it hard to scan history at a glance. The right-hand actions column is also fixed `min-w-[140px]` even when there's only a 'View Details' button, wasting horizontal space.
- **Fix:** Either rename to 'Visit History' (honest about being a list) or make it a real timeline: group by month/year headers, add a left rail/connector, and dim/condense older entries. Let the actions column shrink to content width when 'View Report' is absent.

### 62. ⚪ Search-result cards are low-density: one tall card per patient with verbose History Snapshot
**LOW** · data-density · effort M

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** Each result is a full Card with a CardHeader, a muted 'HISTORY SNAPSHOT' sub-box listing up to 3 visits with '• Diagnostic Visit — Branch — Date' rows, plus a full-width 'View Patient 360' button (GlobalPatientSearch.tsx:172-241). With several matches the user must scroll a lot to compare patients; the primary disambiguators (name, phone, age/gender) compete visually with the snapshot. The whole card is also not clickable — only the bottom button navigates, so a fast front-desk user can't just click the row.
- **Fix:** Tighten to a compact result row: name + age/gender + phone + patientNumber on one line, a single-line 'last visit: <type> · <branch> · <date>' summary, and make the entire card clickable to open Patient 360 (keep the explicit button for discoverability but add an onClick + hover state on the Card and role/tabindex for keyboard). Reserve the full snapshot for the 360 page itself.

### 63. ⚪ Results meta-bar uses ALL-CAPS bullet-separated 'SEARCH RESULTS • GLOBAL • READ-ONLY' that reads as a status code
**LOW** · microcopy · effort S

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** After searching, the results header is `SEARCH RESULTS • GLOBAL • READ-ONLY … N patient(s) found` (GlobalPatientSearch.tsx:144-155). The all-caps tokens separated by bullets look like a machine breadcrumb/debug string rather than human copy, and 'GLOBAL'/'READ-ONLY' restate context already implied by the page. The count is also phrased as 'N patient(s) found' with the literal '(s)' pluralization.
- **Fix:** Replace with plain sentence-case copy, e.g. left side 'Results' and right side a proper pluralized count ('1 patient' / '3 patients' via a small helper). Drop the redundant GLOBAL/READ-ONLY tokens here (the page already establishes global scope).

---

## Owner & Doctor Dashboards

_The live owner dashboard (OwnerDashboardV2) is a thoughtful, decision-first redesign, but it abandons the project's entire design-token system in favor of a hardcoded inline hex palette, creating a second, parallel visual language that diverges from both the shadcn/Tailwind system and the still-shipping legacy OwnerDashboard. The Doctor dashboard is comparatively under-built with a non-functional date filter, missing loading/error states, and microcopy that contradicts its actual behavior._

### 64. 🔴 Branch performance rows link to /branches/:id, which is not a route (lands on NotFound)
**CRITICAL** · navigation · effort S · verified (high)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/App.tsx`
- **Problem:** Every branch name in the performance table is a link: `<Link to={`/branches/${r.branchId}`}>` (OwnerDashboardV2.tsx:883). There is no `/branches/:branchId` (or any `/branches/...`) route in App.tsx — the only matching route is the catch-all `<Route path="*" element={<NotFound />} />` (App.tsx:237). So clicking the most prominent drill-down in the table — the owner's primary 'where do I intervene' affordance — silently dumps them on a 404. The links are also styled blue (`color: TOKENS.info`) signaling they work.
- **Fix:** Repoint to the existing branch-scoped dashboard the page already supports: `to={`/owner?branch=${r.branchId}`}`. Note that the branch filter (lines 952-957) keys on the value used by the branch selector — confirm whether it expects `branchId` or `branchCode` and pass the matching field so the filter actually resolves (a mismatched id would render an empty/unfiltered view rather than 404, which is still a defect). Do NOT just style-disable the link without a target: a non-navigable branch name in a "where do I intervene" table is itself a missed affordance. Preferred long-term fix is a real `/owner/branches/:branchId` detail route. Also avoid the inline `style={{ color: TOKENS.info }}` link styling in favor of a shared link/button-link component so dead vs. live links are visually consistent app-wide.

### 65. 🔴 Doctor dashboard Date filter is rendered but never applied — selecting Yesterday/This Week does nothing
**CRITICAL** · interaction-feedback · effort M · verified (high)

- **Files:** `health-hub/src/pages/doctor/DoctorDashboard.tsx`
- **Problem:** The dashboard shows a prominent 'Date' Select with Today/Yesterday/This Week (DoctorDashboard.tsx:74-86) bound to `dateFilter` (line 35,76). But `filteredReports` only ever filters on `search` — `dateFilter` is never read in the filter (lines 52-60). Changing the dropdown re-renders the same list with zero effect. A doctor trying to find yesterday's reports will conclude the data is missing or the app is broken.
- **Fix:** Wire `dateFilter` into `filteredReports` by comparing `visitView.visit.createdAt` against IST day boundaries. Important: do the date math in Asia/Kolkata, not the browser locale (use a helper that computes the IST midnight for today/yesterday and a 7-day window), since createdAt is a UTC ISO string and naive `new Date().setHours(0,0,0,0)` will be off for users in other timezones and around the IST day boundary. Combine it with the existing search predicate (AND), e.g. `return matchesDate(visitView.visit.createdAt, dateFilter) && matchesSearch(...)`. Also reconsider the default: 'today' currently implies a filter that does not exist; either truly default to today's reports once wired, or change the default/label to 'All'. If implementation is deferred, remove the Select entirely rather than ship a control that contradicts the displayed data. Effort M is correct.

### 66. 🟠 OwnerDashboardV2 hardcodes an entire hex palette, bypassing the index.css/Tailwind token system
**HIGH** · consistency · effort L · verified (high)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`, `health-hub/src/index.css`
- **Problem:** The live owner dashboard defines a private `TOKENS` object of raw hex values and uses it via inline `style={{}}` everywhere instead of the design tokens that the rest of the app consumes. OwnerDashboardV2.tsx:119-143 declares `const TOKENS = { healthy:'#0F6E56', caution:'#854F0B', critical:'#A32D2D', info:'#185FA5', textPrimary:'#1F1F1E', surface:'#FFFFFF', page:'#FAFAF8', border:'rgba(0,0,0,0.08)', ... }`. None of these map to the established tokens in index.css (`--success: 142 72% 40%`, `--destructive: 0 72% 51%`, `--warning: 38 92% 50%`, `--card`, `--border: 0 0% 88%`, `--muted-foreground: 0 0% 40%`). For example the success green is `#0F6E56` here vs `hsl(142 72% 40%)` ≈ `#1CA672` in the token system, and the page background is hardcoded `#FAFAF8` (line 988) instead of `bg-background`. The result is two different greens, two different reds, two different grays, two different card surfaces across the app. It also defeats dark mode (the `.dark` block in index.css cannot reach these inline hexes) and per-branch theming.
- **Fix:** Delete the `TOKENS` object and render with the existing semantic utilities/CSS vars: `text-foreground`, `text-muted-foreground`, `bg-card`, `border-border`, `text-success`/`text-destructive`/`text-warning` (add `text-success`/`bg-success` mappings in tailwind.config if missing). Replace inline `style` color props with Tailwind classes so dark mode and branch accents work. If a few categorical chart colors genuinely have no token, define them once as CSS vars in index.css (e.g. `--chart-reportable`) rather than inline literals.

### 67. 🟠 Two full owner dashboards ship simultaneously with conflicting visual languages
**HIGH** · consistency · effort L · verified (high)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/OwnerDashboard.tsx`, `health-hub/src/App.tsx`
- **Problem:** `/owner` renders OwnerDashboardV2 and `/owner/legacy` renders OwnerDashboard (App.tsx:155-163), and the two are designed in completely different idioms. Legacy uses shadcn Card/Badge/Alert, recharts (ComposedChart/BarChart, OwnerDashboard.tsx:15-26), a dark gradient hero `bg-gradient-to-br from-slate-950 via-slate-900 to-slate-800` (line 788), 3xl bold headings, and rounded-3xl/28px radii. V2 uses 12px-radius flat cards, hand-rolled SVG charts, a muted off-white page, 20px medium headings, and the inline TOKENS palette. They also disagree on terminology: legacy 'Decision-First Owner Dashboard' / 'Revenue trend' vs V2 'Owner overview' / 'Revenue trend · 30 days'. Anyone landing on the legacy URL (still reachable, still wrapped in tabs/links elsewhere) sees a visually unrelated product. Maintaining both doubles the surface for drift.
- **Fix:** Pick V2 as canonical and remove the legacy surface: delete OwnerDashboard.tsx and replace the /owner/legacy route with a hard redirect to /owner (`<Route path="/owner/legacy" element={<Navigate to="/owner" replace />} />`) so any stale bookmark resolves to the real product. Correct the premise: there are NO in-app links to /owner/legacy, so no nav/tab cleanup is needed — the page is simply orphaned-but-routed. If the recharts visuals (doctor-contribution, anomaly band) are still wanted, port those specific charts into V2 rather than retaining a parallel page. Separately, while consolidating, fix V2's own token violation: replace the inline hardcoded-hex TOKENS object (OwnerDashboardV2.tsx:119-141) with the project's CSS-var design tokens from index.css/tailwind.config.ts so the canonical dashboard actually honors per-branch accent theming — otherwise V2 will drift from the rest of the app the same way legacy did.

### 68. 🟠 Doctor dashboard says 'finalized reports' but lists unsigned DRAFT reports with no visual distinction
**HIGH** · microcopy · effort S · verified (high)

- **Files:** `health-hub/src/pages/doctor/DoctorDashboard.tsx`
- **Problem:** The subtitle reads 'Which finalized reports are available for me?' (DoctorDashboard.tsx:67) and the dialog title is 'Report (Read Only)' (line 175), implying signed, final results. But the list explicitly includes DRAFT visits: `reportsWithResults = diagnosticVisits.filter(v => v.status === 'FINALIZED' || v.status === 'DRAFT')` (lines 40-42), and the comment even says 'have results'. Nothing in the row indicates a report is still a draft vs finalized — a doctor could read and act on provisional values believing they are final lab results. This is a clinical trust/safety issue.
- **Fix:** Add an unmissable per-row status badge next to the patient name (line ~130), e.g. <span className={visitView.visit.status === 'FINALIZED' ? 'status-finalized' : 'status-draft'}>{visitView.visit.status === 'FINALIZED' ? 'Final' : 'Draft'}</span> using the existing index.css utility classes (rounded px-2 py-0.5 text-xs font-medium). Also surface the same badge in the dialog header (line 175 area) — change the title to a neutral "Report" and place the Final/Draft badge beside it so the read-only viewer state is explicit. Correct the page subtitle (line 67) from "Which finalized reports are available for me?" to "Reports available to view" (or "Lab reports for my patients") since the list is not finalized-only. Do NOT silently restrict to FINALIZED unless product confirms doctors should never see drafts — preserving drafts WITH a clear badge is the safer change because hiding them may remove visibility doctors currently rely on; clarity over removal.

### 69. 🟠 V2 revenue trend is a bare unlabeled SVG with no axis values, tooltips, or accessibility
**HIGH** · data-density · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`
- **Problem:** The 30-day revenue chart is hand-rolled SVG (OwnerDashboardV2.tsx:722-756): a polyline plus dots, with `preserveAspectRatio="none"` (line 727) which stretches stroke widths non-uniformly. There is no Y axis, no value labels, and no hover tooltip — an owner cannot read any actual rupee figure off it; the description 'two largest outliers marked' (line 720) just colors two dots red with no value shown. The `<svg>` has no `role="img"`/`aria-label`, so it is invisible to screen readers and provides no text alternative. Meanwhile the legacy dashboard already has a full recharts trend with band, axis currency formatting, and a tooltip (OwnerDashboard.tsx:907-937). For a money-decision chart this is a real information loss.
- **Fix:** Port to the recharts ComposedChart/LineChart already used in OwnerDashboard.tsx (no new dep — recharts is in package.json:62), wrapped in ResponsiveContainer so it gets a YAxis with currencyFormatter tick labels, an XAxis, and a Tooltip showing each day's ₹ net for free. Preserve the existing top-2-outlier semantics by passing the outlier flag into a custom dot (mirror the legacy TrendDot pattern at line 932) rather than recoloring raw <circle>s. Add role="img" plus an aria-label on the chart container summarizing the trend (e.g. "30-day net revenue trend, ₹X to ₹Y, peak on <date>") for a screen-reader text alternative, and consider an aria-hidden visually-hidden data table for full SR access. If a full port is deferred, the minimum fix is: remove preserveAspectRatio="none" (use the default to avoid stroke distortion), render at least a few Y gridline value labels, add a role/aria-label, and surface each point's value via <title> on the circles for native hover/SR tooltips.

### 70. 🟠 Action queue chips encode severity only in a thin 2px left border; low-severity color fails contrast
**HIGH** · accessibility · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`
- **Problem:** The single most important element of the 'what needs my decision' page — the action chips — encodes urgency only as a 2px colored left border (OwnerDashboardV2.tsx:386-397, `borderLeftWidth: 2, borderLeftColor: severityColor(...)`). High vs medium vs low is otherwise indistinguishable (same surface, same text color). For low severity the indicator color is `TOKENS.textTertiary` `#888780` (severityColor, lines 185-189) — a 2px line of low-contrast gray that is effectively invisible. Color is also the sole carrier of meaning (a WCAG 1.4.1 use-of-color failure), and the chips have no text label of the severity. The 'open ↗' / '+N more' links across the page likewise rely on `↗` glyphs and color-only blue with no underline (lines 569-575, 615-621).
- **Fix:** Make severity legible non-visually and non-color-only: (1) Add a textual/iconic severity cue to each chip — reuse SeverityBadge from src/pages/owner/_shared/ownerUi.tsx (lines 457-483), or prefix high chips with a lucide AlertTriangle icon + visually-hidden text. (2) Replace the 2px left border with a full-height left bar (e.g. 4px) plus a tinted background using the severity color at low opacity, so the indicator is perceivable and meets non-text contrast (WCAG 1.4.11); never rely on #888780 alone for low severity. (3) Sort chips[] by severity (high → medium → low) before chips.slice(0,6) at line 376 so the most urgent items are first and not silently dropped into '+N more'. (4) For the 'open ↗' links (lines 569-575, 615-621) add `textDecoration: 'underline'` (mirror line 433, NOT NumericLink which is itself underline-less) and replace the bare `↗` glyph with a lucide ExternalLink icon plus accessible label so the affordance does not depend on color.

### 71. 🟡 TOKENS palette and formatting helpers are duplicated verbatim between V2 page and ownerUi shared module
**MEDIUM** · redundancy · effort M

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`
- **Problem:** ownerUi.tsx already exports `TOKENS`, `SectionCard`, `SectionLabel`, `DisplayNumber`, `StatRow`, `MiniBar`, `formatRupees`, `formatIstDateTime`, `BranchFilter`, `RefreshButton`, `ErrorCard` (ownerUi.tsx:18-453). OwnerDashboardV2.tsx re-declares its own private copies of nearly all of them: `TOKENS` (lines 119-143, identical hex values), `formatRupees` (147-154), `formatIstDateTime` (156-172), `SectionLabel` (193-206), `SectionCard` (208-246), `DisplayNumber` (248-263), `StatRow` (265-290), `MiniBar` (292-322), `BranchFilter` (326-354), plus inline copies of the refresh button (1010-1024) and error card (1045-1069). Two copies of a token table is exactly how the greens/reds drift apart over time, and the page is ~250 lines longer than it needs to be.
- **Fix:** Import the shared primitives from `_shared/ownerUi` and delete the local duplicates in OwnerDashboardV2.tsx. The local `BranchFilter` even takes a `branches` prop the shared one already sources from the store — consolidate on the shared signature.

### 72. 🟡 Doctor dashboard has no loading or error feedback; empty state is bare text
**MEDIUM** · interaction-feedback · effort M

- **Files:** `health-hub/src/pages/doctor/DoctorDashboard.tsx`
- **Problem:** The page reads from the synchronous app store with no loading skeleton or error boundary — if data is still hydrating the doctor sees an instantly 'empty' list. The only empty state is a centered line 'No reports found.' (DoctorDashboard.tsx:112-115) with no icon, no guidance, and the same text whether there are genuinely zero reports for the day or the search simply matched nothing. By contrast the owner dashboards both provide skeletons and retry affordances (OwnerDashboard.tsx:739-744 DashboardSkeleton; OwnerDashboardV2.tsx:926-946).
- **Fix:** Add a skeleton/loading state, and differentiate the two empty conditions: 'No reports for the selected date' vs 'No results match your search' with a clear-search action. Use the FileText icon and muted illustration treatment consistent with the rest of the app's empty states.

### 73. 🟡 Repeated 'open ↗' text links are low-affordance and hard to tap on mobile
**MEDIUM** · navigation · effort S

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`
- **Problem:** Every section's drill-down is a tiny 12px lowercase 'open ↗' text link in the card's rightSlot (OwnerDashboardV2.tsx:569-575, 615-621, 642-648, 671-677). At 12px with no padding, no underline, and a Unicode arrow standing in for an icon, these are below the 44px touch-target guideline, low contrast (`TOKENS.info` on white), and easy to miss. The same pattern repeats 4+ times so the cost is systemic. Lowercase 'open' also clashes with the app's otherwise sentence/Title-case microcopy.
- **Fix:** Use a consistent ghost `Button size="sm"` or `NumericLink` with a real lucide `ArrowUpRight`/`ExternalLink` icon and adequate hit area, and capitalize ('Open'). Consider making the whole card header clickable for the primary drill-down.

### 74. 🟡 Trend SVG width scales with point count (trend.length * 14) and can overflow / distort on small screens
**MEDIUM** · responsive · effort M

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`
- **Problem:** The trend SVG viewBox is `0 0 ${trend.length * 14} 140` rendered at `width="100%"` with `preserveAspectRatio="none"` (OwnerDashboardV2.tsx:723-728). With 30 points the intrinsic coordinate space is 420 wide squeezed into a phone's ~320px card, so 'none' stretches the geometry horizontally and the 1.5px stroke and 1.5/3px dots distort. The revenue-mix stacked bar and the 6-column branch table (lines 853-868) also only get `overflow-x-auto` (line 852), pushing the owner into horizontal scrolling on mobile with no column priority. No mobile-specific layout is provided for the 5-column money/payout split (lines 1075-1082) beyond the lg breakpoint stack.
- **Fix:** Use a responsive chart (recharts ResponsiveContainer as legacy does) instead of a stretched viewBox; keep `preserveAspectRatio` default. For the branch table on mobile, hide secondary columns (Avg ticket, TAT) or switch to a stacked card list below `sm`.

### 75. 🟡 Legacy owner dashboard scatters ad-hoc Tailwind/hex colors (slate gradient, red/emerald/amber, purple/teal bars)
**MEDIUM** · branding · effort M

- **Files:** `health-hub/src/pages/owner/OwnerDashboard.tsx`
- **Problem:** The legacy dashboard (still routed at /owner/legacy) uses non-token colors throughout: dark hero `from-slate-950 via-slate-900 to-slate-800` (OwnerDashboard.tsx:788), signal badges hardcode `red-50/red-700/emerald-50/emerald-700/slate` (lines 205-221), anomaly dot `fill="#dc2626"` (line 351), comparison bars `#1d4ed8`/`#bfdbfe` (lines 869-870), trend line `#0f4f85` (line 931), and the doctor-contribution charts pass `barColor="#0f766e"` (teal) and `barColor="#7c3aed"` (purple) (lines 1083,1090) — colors that appear nowhere in the brand token set (grayscale primary + success/warning/destructive). The purple referral bar in particular is an arbitrary off-brand accent. None of these map to `--success`/`--destructive`/`--warning` or the branch accent.
- **Fix:** If this page survives the V2 migration, replace literal colors with CSS-var-backed chart tokens (`hsl(var(--destructive))`, `hsl(var(--success))`, branch accent) and a single defined categorical chart palette; drop the dark slate hero in favor of the app's light surface to match the rest of the product. If it is being retired, this is moot — see the two-dashboards finding.

### 76. ⚪ 'baseline forming' messaging is duplicated and inconsistently worded across the page
**LOW** · microcopy · effort S

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`
- **Problem:** The 'not enough data yet' concept is expressed at least four different ways: top banner 'Baseline forming — comparisons available after N more days' (OwnerDashboardV2.tsx:976) and 'Week-over-week comparisons only · 30-day baseline available in N days' (line 979); money card 'baseline forming · {n} of 4 prior samples' (line 451); ops TAT 'TAT — baseline forming · {n}/4 samples' (line 608); KpiCard 'baseline forming' (ownerUi.tsx:266). Mixed punctuation ('of 4' vs '/4'), mixed casing, and overlapping meaning make the same condition read as several different states.
- **Fix:** Standardize one phrasing and one format (e.g. always 'Baseline forming · {n}/4 samples') and centralize it in a shared helper in ownerUi so every surface matches.

### 77. ⚪ Branch filter uses a raw native <select>, inconsistent with the app's shadcn Select and missing focus styling
**LOW** · consistency · effort S

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`, `health-hub/src/pages/doctor/DoctorDashboard.tsx`
- **Problem:** Both owner BranchFilters render a bare HTML `<select>` styled with inline border color (OwnerDashboardV2.tsx:336-353; ownerUi.tsx:315-327), while the Doctor dashboard and the rest of the app use the shadcn `Select` component (DoctorDashboard.tsx:76-85). The native select has no visible focus ring matching `--ring`, no consistent chevron, and ignores dark mode. Two different dropdown components appear within the same owner/doctor surface area.
- **Fix:** Replace the native `<select>` in the owner BranchFilter with the shadcn `Select`/`SelectTrigger` already used elsewhere so focus ring, sizing, and theming are consistent across roles.

---

## Owner Money / Doctors / Operations

_These three owner pages are well-built single-screen dashboards with a clean shared component vocabulary, but they have a critical wayfinding failure (three Money sub-routes and three Operations sub-routes all render byte-identical pages with no tabs, scroll, or active-section indication), plus systemic inconsistencies in currency formatting, table styling, color-only signaling, and accessibility (selects/links without labels or focus affordances)._

### 78. 🔴 /money/bills, /money/cash, /money/discounts all render the exact same page with no sub-section indication
**CRITICAL** · navigation · effort L · verified (high)

- **Files:** `health-hub/src/App.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** App.tsx lines 165-179 wire three distinct routes — `/money/bills`, `/money/cash`, `/money/discounts` — all to `<OwnerMoneyPage />`. OwnerMoneyPage.tsx never reads the URL (no `useLocation`/`pathname` — confirmed by grep returning nothing), so all three URLs show the identical scrollable dashboard. The header always says just `title="Money"` (line 521). Sidebar.tsx gives Money `matchPrefixes: ['/money/']` (line 59) so every money URL only highlights the top-level 'Money' item. There are no tabs, no anchor scroll, and no active-sub-section cue. An owner who clicks 'Discounts' lands at the top of the same page as 'Bills' with zero feedback that anything changed, and the three URLs are indistinguishable wayfinding dead-ends.
- **Fix:** Make the sub-routes real. Restructure the route as `/money/:section?` (or keep the three explicit paths) and inside OwnerMoneyPage read the segment with `useParams`/`useLocation`. Render a shadcn `Tabs` row directly under OwnerPageHeader with `value` derived from the path and `onValueChange` calling `navigate('/money/' + section)` (Bills / Cash / Discounts), then conditionally render only the matching section group per tab so each URL shows distinct content. Also pass the active section into the header subtitle (e.g. `Discounts · {timestamp} · {branch}`) and add the three as collapsible sidebar sub-items under Money so the active child highlights. If the product intent is genuinely a single scrollable dashboard, instead collapse to one `/money` route and delete the fake sub-routes plus their sidebar entry — do not leave three URLs that resolve to identical output. A plain scroll-to-anchor `useEffect` is the weakest option since it leaves all three URLs showing the same DOM and breaks on back/forward; prefer the Tabs+conditional-render approach.

### 79. 🟠 /ops/queue, /ops/pending, /ops/audit render the same page; /ops/pending has no nav entry
**HIGH** · navigation · effort M · verified (high)

- **Files:** `health-hub/src/App.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`, `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** App.tsx lines 190-203 map `/ops/queue`, `/ops/pending`, `/ops/audit` all to `<OwnerOperationsPage />`, which (like Money) never reads the path. The sidebar (Sidebar.tsx lines 74-75) only lists 'Live queue' (/ops/queue) and 'Audit & alerts' (/ops/audit) — `/ops/pending` is a reachable route with no nav entry and identical content, a ghost page. 'Audit & alerts' suggests a focused audit view but delivers the full operations dashboard, so the audit feed (AuditFeedCard) is buried below the TAT histogram and two queue cards.
- **Fix:** Two-part fix. (1) Make the sub-routes actually differentiate: read useParams/useLocation pathname in OwnerOperationsPage; for /ops/audit, set the header title/subtitle to "Audit & alerts" and either render AuditFeedCard + CommsFailuresCard first (reorder by route) or auto-scroll to the audit section via a ref + useEffect(scrollIntoView). The histogram's existing breach drilldown already deep-links to /diagnostics/pending?filter=overdue (line 215), so /ops/queue can stay as the default full dashboard. (2) Resolve /ops/pending: it is a true orphan with no nav entry and no distinct content — delete the route from App.tsx (lines 195-199). If a "pending/overdue" operations view is genuinely wanted, give it distinct content and add a matching sidebar sub-item; otherwise removing it is the cleaner fix. Avoid the "collapse to one /operations route" option unless you also drop the sidebar sub-items, since keeping nav links that all resolve to identical pages is the core defect.

### 80. 🟠 Currency formatting mixes short (₹1.2L) and full (₹1,23,456) inconsistently within the same page
**HIGH** · consistency · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`
- **Problem:** In OwnerMoneyPage the same kind of value is formatted differently table-to-table: 'Collected by user' renders Cash/Online with `{ short: true }` (lines 367, 370 -> ₹1.2L) while 'Oldest unpaid' Owed (line 255), 'Discount log' Off (line 429), and Refunds amounts (lines 456, 477) use full digits (₹1,23,456). So two money tables on one screen present rupees in two different notations. KpiCards use short (lines 546-565) but their `sub` lines also use short, while detail tables below use full — there is no rule. This makes columns hard to scan and compare and looks unpolished for a money page where owners reconcile exact figures.
- **Fix:** Adopt one explicit rule: SHORT (₹1.2L/₹1.2k) for at-a-glance aggregates — KPI tiles, bar/chart labels (AgingBar, CashByBranch totals) — and FULL en-IN digits for every per-row table cell an owner reconciles (OldestUnpaid Owed, DiscountLog Off, Refunds total + recent rows are already correct; the violations are the inverse — CashByUser Cash/Online at 367/370 should switch to full to match the sibling OldestUnpaid table). Make this hard to get wrong by replacing the single formatRupees({short}) toggle with two named exports in ownerUi.tsx — formatRupeesCompact() and formatRupeesFull() — and a lint/code-review note on call-site intent, rather than a boolean callers keep guessing. Then sweep OwnerDoctorsPage: its leaderboard rows (Gross/Commission/Net/Owed at 185/188/202/210) and payout-aging rows (380) are per-row reconciliation cells and should use formatRupeesFull(); keep its KPI tiles (466-481) and external-flow summary numbers compact. This yields one convention across Money, Doctors, and any other owner table.

### 81. 🟠 Flags, overdue ages, and rate breaches are encoded by color/tint alone with no text label
**HIGH** · accessibility · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** Critical signals are conveyed only through color or background tint: heavy-cash branches get `background:'#FFF8E1'` (OwnerMoneyPage line 284), solo-cash users an amber cell (line 364), flagged discounts a red tint `#FCEBEB30` (line 418), high-rate doctors a red row tint (OwnerDoctorsPage line 136), overdue days switch to `TOKENS.critical`/`TOKENS.caution` text (OwnerMoneyPage line 249; OwnerOperations age line 268-273). None carry a text/icon/aria cue, so the meaning is invisible to color-blind owners and to screen readers, and the descriptions ('tinted amber', 'tinted red') only appear once in a SectionCard subtitle far from the row. WCAG 1.4.1 (use of color) is violated.
- **Fix:** Add a non-color affordance per flagged row that survives both color-blindness and screen readers. Given this codebase uses inline styles + TOKENS rather than utility classes: (1) For the boolean flags (flagHeavyCash, flagSoloCash, discount flag, flagHighRate), render a small lucide AlertTriangle next to the value with an accessible label, e.g. `{b.flagHeavyCash && <AlertTriangle size={12} style={{ color: TOKENS.caution }} aria-label="heavy cash share (>70%)" />}`, or a compact text chip ('>70% cash', '>80% cash', 'high rate', 'large discount'). Keep the tint as reinforcement, not the sole signal. (2) For the threshold-derived color ramps (daysOverdue, ageMinutes) that have no boolean, append a textual qualifier or aria-label to the cell rather than just switching `color`, e.g. wrap the value: `<span title={r.daysOverdue > 30 ? 'severely overdue' : 'overdue'}>{r.daysOverdue}d</span>` plus an inline icon when over the critical threshold. (3) Strengthen the faint `#FCEBEB30` tint to an opaque, contrast-checked token (e.g. a destructive-subtle background from index.css) so the visual cue is actually perceptible. (4) Move the meaning out of the SectionCard subtitle into a real legend or per-row cue so it is recoverable at the point of data, not 20 rows away.

### 82. 🟠 Branch/period filters and icon-only refresh lack labels and visible focus styling
**HIGH** · accessibility · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/_shared/ownerUi.tsx`
- **Problem:** BranchFilter `<select>` (ownerUi.tsx lines 314-328) and the RefreshButton (lines 404-413) have no `aria-label`; the refresh button is icon-only (RefreshCw) with only a `title`, which is not reliably announced. PeriodFilter is a segmented group of `<button>`s (lines 352-366) with no `role`/`aria-pressed` and the active state is conveyed by background color only. None of these controls, nor the many inline `<Link style={{...}}>` (e.g. 'send all reminders ↗', 'view all ↗'), define a `:focus-visible` ring — all focus styling is inline `style` which cannot express focus states, so keyboard users get no visible focus indicator across the whole owner surface.
- **Fix:** Add `aria-label="Filter by branch"` to the select and `aria-label="Refresh"` to RefreshButton; give PeriodFilter buttons `aria-pressed={k===value}`. Replace inline `style` with Tailwind classes so `focus-visible:ring-2 focus-visible:ring-ring` applies, or migrate filters to shadcn `Select`/`ToggleGroup` and links to `buttonVariants`/styled anchors that include focus rings.

### 83. 🟡 Shared AgingBar hardcodes the word 'bills', so Payout aging reads 'X bills' for payouts
**MEDIUM** · microcopy · effort S

- **Files:** `health-hub/src/pages/owner/_shared/ownerUi.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`
- **Problem:** AgingBar in ownerUi.tsx line 296 always renders `${formatRupees(...)} · ${count} bills · ${pct}%`. It is reused by OwnerDoctorsPage's PayoutAgingCard (lines 224-242) where `count = bucket.rowCount` is a count of payout rows, not bills — so the Payout aging buckets incorrectly read e.g. '3 bills' when they are payouts. The card description even says 'By days since derivedAt' (a payout concept) while the rows are labeled 'bills'.
- **Fix:** Add a `unit` prop to AgingBar (default 'bills') and pass `unit="payouts"` from PayoutAgingCard; pluralize correctly (1 bill / 2 bills). This is a one-line interface change plus two call sites.

### 84. 🟡 Five hand-rolled tables duplicate the same thead/tbody styling instead of one shared Table primitive
**MEDIUM** · consistency · effort L

- **Files:** `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** Every table repeats the identical inline `<thead><tr style={{ color: TOKENS.textTertiary, textAlign:'left', fontWeight:400 }}>` block and `borderTop: '0.5px solid ' + TOKENS.border` row styling — OwnerMoneyPage (OldestUnpaid 216-260, CashByUser 333-378, DiscountLog 396-445), OwnerDoctorsPage (Leaderboard 112-215, RecentPayouts 340-403), OwnerOperationsPage (DiagnosticsQueue 252-297, Audit 435-478, CommsFailures 492-533). This is ~8 copies of the same markup; spacing (`py-2`/`pb-2`) and `fontSize:12` are re-declared each time, and the project already uses shadcn/ui which ships a Table component. Drift is inevitable (e.g. some tables wrap in `overflow-x-auto`, OldestUnpaid does not — line 216).
- **Fix:** Extract an `OwnerTable`/`OwnerTh`/`OwnerTd` primitive into ownerUi.tsx (or adopt shadcn `Table`/`TableHead`/`TableRow`) so header style, row border, padding, and the `overflow-x-auto` wrapper are defined once and reused. Reduces every table to columns + rows.

### 85. 🟡 Pages use a parallel JS TOKENS palette and hex literals instead of the Tailwind/index.css design tokens
**MEDIUM** · branding · effort L

- **Files:** `health-hub/src/pages/owner/_shared/ownerUi.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** ownerUi.tsx lines 18-41 define a hand-maintained `TOKENS` object of raw hex values (`healthy:'#0F6E56'`, `critical:'#A32D2D'`, `page:'#FAFAF8'`, etc.) used via inline `style={{ color: TOKENS.x }}` everywhere, in parallel to the project's real design tokens in index.css / tailwind.config.ts (grayscale primary + success/warning/destructive + status/flag tokens). On top of that, ad-hoc hex literals appear inline that aren't even in TOKENS: `#FFF8E1` (OwnerMoneyPage 284, 364), `#FCEBEB30` (418; OwnerDoctors 136, 257), `#E5F0FB`/`#E5F4ED` avatar tints (OwnerDoctors 148, OwnerOps 345, 391), `#E5F4ED60` (OwnerDoctors 288). The owner pages therefore ignore the per-branch accent CSS vars entirely and will not track any future token/theme change, and 'success/destructive' semantics are duplicated under different names ('healthy'/'critical').
- **Fix:** Map TOKENS to the existing CSS variables (e.g. `var(--success)`, `var(--destructive)`, `var(--muted-foreground)`) or, better, replace inline styles with Tailwind utility classes (`text-destructive`, `bg-warning/10`) so the owner surface inherits the design system and branch accents. Promote the stray flag tints (`#FFF8E1`, `#FCEBEB30`) into named tokens.

### 86. 🟡 Header subtitle flashes 'Loading…' and filters render before data, but skeleton replaces the whole body
**MEDIUM** · interaction-feedback · effort M

- **Files:** `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** On every page the subtitle shows the literal `'Loading…'` while loading (OwnerMoneyPage line 527, OwnerDoctors 447, OwnerOps 577) and `FullPageSkeleton` replaces the entire content region (OwnerMoneyPage 538). Because the query refetches on an interval (5m for Money/Doctors, 30s for Operations) and on branch/period change, switching a filter discards the current data and drops to a full skeleton + 'Loading…' subtitle each time, a jarring full-page flash on a live dashboard rather than an in-place update. The KPI grid/section layout is also not preserved in the skeleton, so the page reflows.
- **Fix:** Keep showing the prior data with a subtle `isFetching` dimming/spinner (RefreshButton already spins) instead of swapping to FullPageSkeleton on refetch; reserve the skeleton for the true first load (`isLoading && !data`). Replace the 'Loading…' subtitle with the last generatedAt timestamp or an empty string to avoid the flash.

### 87. 🟡 TAT histogram hardcodes a 33-minute axis ceiling and has no accessible/tooltip representation
**MEDIUM** · data-density · effort M

- **Files:** `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** TatHistogramCard scales the SLA/p50/p95 markers and clamps values against a magic literal `33` minutes (lines 121, 124, 128) while the axis labels read '0m / 15m / 30m+' (lines 201-203). Any report finalized above ~33m is clamped onto the right edge with no indication, and if `slaMinutes` ever exceeds 33 the dashed SLA line falls off the chart. The chart is a bare `<svg>` with no `<title>`/`aria-label`, no per-bar tooltip, and no legend explaining that the two blue dashed lines are p50 and p95 (only the footer text at line 209 names them) — owners cannot read a specific bin's count or which dashed line is which.
- **Fix:** Derive the axis ceiling from the data (e.g. `Math.max(slaMinutes*1.2, p95, maxBinRangeMax)`) instead of `33`; add `<title>` per `<rect>` (or a hover tooltip) with the bin range and count, an `aria-label` on the svg summarizing p50/p95/SLA, and a tiny inline legend mapping the blue-dashed vs red-dashed lines.

### 88. 🟡 Doctor leaderboard is sort-locked to net and dumps up to all rows with no sort/filter/sticky header
**MEDIUM** · data-density · effort L

- **Files:** `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`
- **Problem:** LeaderboardCard (lines 83-220) is fixed-sorted by net descending (description line 89) with only a 'show top 25 / show all (N)' toggle (lines 91-104). An owner cannot sort by Owed, Commission, Rate, or Visits — the columns that drive payout decisions — nor filter to referral-only / active-only, and 'show all' can render a very long, un-paginated table with a non-sticky header so the column meanings scroll off. Inactive doctors are only signaled by `opacity: 0.6` (line 137), another color/opacity-only cue with no toggle to hide them.
- **Fix:** Make column headers clickable to sort (with an aria-sort indicator), add a sticky `thead`, and add quick filters (type: referral/clinic; active only; owed > 0). Reuse the extracted OwnerTable primitive so sorting is shared with the other tables.

### 89. ⚪ Refunds list injects literal leading whitespace before the patient name
**LOW** · microcopy · effort S

- **Files:** `health-hub/src/pages/owner/OwnerMoneyPage.tsx`
- **Problem:** RefundsCard line 470 reads `<span style={{ color: TOKENS.textPrimary }}>                {formatPatientName(...)}</span>` — there is a run of literal space characters between the tag and the JSX expression. JSX collapses leading whitespace before an expression in most cases, but this is clearly accidental copy/paste indentation leaking into rendered output and risks a visible indent before each refund name.
- **Fix:** Remove the stray whitespace so the line is `<span style={{ color: TOKENS.textPrimary }}>{formatPatientName(r.patientName, r.patientTitle)}</span>`.

### 90. ⚪ External flow 'Net inflow' uses a Unicode minus glyph inconsistent with the rest of the app's deltas
**LOW** · consistency · effort S

- **Files:** `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`
- **Problem:** ExternalFlowCard renders the net as `Net inflow {net >= 0 ? '+' : '−'}{formatRupees(Math.abs(net))}` (OwnerDoctors lines 318-319) using a U+2212 MINUS SIGN, while KpiCard deltas use a plain ASCII hyphen via the numeric sign of `delta.percent` (ownerUi.tsx lines 261-262) and elsewhere negatives come straight from `toLocaleString`. So negative money is shown three different ways across owner pages (− glyph, ASCII -, and raw locale formatting), and `formatRupees` itself has no sign convention.
- **Fix:** Pick one sign convention (recommend letting `formatRupees` handle the sign, or consistently using the ASCII '-') and apply it everywhere a signed money/delta value is shown so negatives read identically across KPI deltas and the External flow net.

---

## Owner Config & Management Pages

_These CRUD pages are functional but show heavy systemic inconsistency: three near-identical "management table" patterns (Dialog vs. inline Card form vs. Sheet), divergent destructive-action confirmation (toast-only Delete in two tabs, proper AlertDialog elsewhere), three fully dead legacy page files with leftover console.log debug, and a recurring hardcoded color-token problem (bg-green-100 / yellow-50 / blue-600) that bypasses the design system and creates contrast/brand drift. The unified AdminConfigCenter is the right direction, but its child tabs each reinvent headers, empty/loading states, and form layout._

### 91. 🟠 Three legacy standalone management pages are dead code (with debug console.logs)
**HIGH** · redundancy · effort S · verified (high)

- **Files:** `health-hub/src/pages/owner/ManageDoctors.tsx`, `health-hub/src/pages/owner/ManageClinicDoctors.tsx`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx`, `health-hub/src/App.tsx`
- **Problem:** ManageDoctorsAndReferrals.tsx explicitly documents it replaced these three files ('Unified tab component combining: Referral Doctors (ex-ManageDoctors), Clinic Doctors (ex-ManageClinicDoctors), Diagnostic Centers (ex-ManageDiagnosticCenters)'). App.tsx routes /owner/doctors and /owner/clinic-doctors to <Navigate to="/owner/config?tab=referrals"> and the standalone files are never imported anywhere (verified: grep finds only their own definitions). They are dead code. Worse, ManageDoctors.tsx:100-122 still ships raw debug logging: console.log('Searching for clinic doctor by name:', name), console.log('Clinic doctors found:', ...), console.log('Match found:', match). The dead files also carry an OLDER, inferior UX (e.g. ManageDoctors.tsx only supports a single flat commissionPercent, no product-specific payout rules) that diverges from the live unified version — a trap for the next developer who edits the wrong file.
- **Impact:** Maintenance hazard and trust risk: a future fix applied to the dead file silently does nothing; the divergent old commission model could be reintroduced. Stray console.logs leak doctor-search internals to the browser console in production.
- **Fix:** Delete all three dead files outright: src/pages/owner/ManageDoctors.tsx, ManageClinicDoctors.tsx, ManageDiagnosticCenters.tsx. They are unreachable (no imports; routes 301-redirect to /owner/config) and the only live implementation is ManageDoctorsAndReferrals.tsx. Deletion is safe and removes the divergent flat-commissionPercent model that could be reintroduced by a developer editing the wrong file. Drop the "console.logs leak in production" justification — because the files are tree-shaken out of the bundle, the real risk is purely maintenance/divergence, not a runtime leak; lead with that. To prevent recurrence, add an ESLint no-console rule (allow console.warn/error) plus a CI unused-files check (e.g. knip or ts-prune) so orphaned modules fail the build.

### 92. 🟠 Create/Edit forms use three different UI containers across sibling tabs
**HIGH** · consistency · effort L · verified (high)

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManageDepartments.tsx`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`
- **Problem:** Within the SAME AdminConfigCenter tab set, the add/edit affordance differs per tab with no functional reason. Products/Departments/Clinical-Defs/Panels open a modal <Dialog> (e.g. ManageBillableProducts.tsx:589, ManageDepartments.tsx:376, ManageClinicalDefinitions.tsx:915, ManagePanelDefinitions.tsx:939). The Referrals tab renders an inline <Card className="border-primary/30"> form that pushes the table down (ManageDoctorsAndReferrals.tsx:721-937, 1026, 1223). Signing Doctors uses a right-side <Sheet> (ManageSigningDoctors.tsx:1044) for doctors but a <Dialog> for rules (line 1201). A user moving between tabs gets a different spatial model (centered modal vs. page-shift vs. slide-in drawer) for the identical 'add a record' task.
- **Impact:** Breaks the learned interaction model; the inline-Card pattern on Referrals also scrolls the table out of view and gives no scrim/focus-trap, unlike the modal tabs. Feels like several apps stitched together rather than one cohesive admin surface.
- **Fix:** Standardize on a SINGLE container per form-size class and centralize it. Concretely: (1) Convert the three inline `<Card className="border-primary/30">` forms in ManageDoctorsAndReferrals.tsx (722/1027/1224) and the rules <Dialog> in ManageSigningDoctors.tsx (1201) to match their tab siblings. (2) Decide by form length, not per-page whim: short, single-column forms (Departments, signing rules) -> <Dialog className="sm:max-w-lg">; long/multi-section forms (Signing Doctors, Products, Panels, Clinical Defs, Referral/Clinic/Center doctors) -> <Sheet> side panel. Note this means Products/Panels/Clinical (currently Dialog) should move to Sheet for true consistency — the original rec implies this but should state it explicitly since it contradicts their current Dialog usage. (3) Extract a shared `<ManagementFormShell mode="sheet|dialog" title submitting onSubmit>` wrapper so the open-state, header, scroll container (overflow-y-auto max-h), and footer (Cancel/Save with disabled+spinner) are defined once and every tab consumes it — this also fixes the divergent DialogContent max-w values (max-w-lg vs 3xl vs 6xl) currently scattered across files. Critically, all variants then get a scrim + focus-trap, which the inline-Card forms lack today.

### 93. 🟠 Signing rule and lab-incharge-rule deletes fire immediately with no confirmation
**HIGH** · error-handling · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/ManageSigningDoctors.tsx`
- **Problem:** Every other delete in this area gets an AlertDialog confirm (departments, doctors, centers, products, panels, definitions). But the two RULE tables in Signing Doctors delete on a single click with zero confirmation: the trash Button onClick={() => handleDeleteRule(rule.id)} (line 857) and onClick={() => handleDeleteLabInchargeRule(rule.id)} (line 1028) call the DELETE fetch directly. There is no AlertDialog gating these — compare the carefully gated handleDeleteDoctor (AlertDialog at line 1445) in the same file.
- **Impact:** An owner can irreversibly remove a department→doctor signing assignment (which controls who legally signs lab reports) with one mis-click and no undo. This is a compliance-sensitive, destructive action presented more casually than deleting a department.
- **Fix:** Introduce two confirm states mirroring the existing pattern (e.g. deleteRuleId / deleteLabInchargeRuleId) and add two AlertDialogs alongside the ones at lines 1445 and 1467. The trash buttons should set the pending id (onClick={() => setDeleteRuleId(rule.id)}) rather than calling the handler; the AlertDialogAction calls handleDeleteRule. Populate the AlertDialogDescription from the rule row so it names the department and signing doctor (e.g. "Remove Dr. {rule.signingDoctorName} as the signer for {rule.departmentName}? Lab reports for this department will no longer carry this signature."), and for the lab-incharge rule name the branch/department + incharge. Reuse the className="bg-destructive text-destructive-foreground" action styling already used on lines 1459/1481 for visual consistency.

### 94. 🟠 Status/type badges use hardcoded Tailwind palette colors instead of design tokens
**HIGH** · branding · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`
- **Problem:** The system defines success/warning/destructive + status/flag tokens in index.css/tailwind.config.ts, but these pages hardcode raw palette classes everywhere. Examples: Active/Inactive badge uses bg-green-100 text-green-800 / bg-gray-100 text-gray-800 (ManageBillableProducts.tsx:555, ManagePanelDefinitions.tsx:905); PRODUCT_TYPES/WORKFLOW_MODES color maps use bg-blue-100, bg-purple-100, bg-emerald-100, bg-amber-100, bg-sky-100 (lines 87-95); STATUS_COLORS uses bg-green-100/bg-yellow-100/bg-orange-100 (ManageClinicalDefinitions.tsx:107-112); effective-price uses text-blue-600 (ManageBillableProducts.tsx:548); LAYOUT_TYPES colors hardcoded (ManagePanelDefinitions.tsx:100-104); 'Yes' lab-incharge badge bg-green-100 text-green-800 (ManageSigningDoctors.tsx:844). The 'Referral/Clinic Doctor Found' alerts hardcode border-yellow-500 bg-yellow-50 text-yellow-800/700 (ManageDoctorsAndReferrals.tsx:814-820, 1114-1120).
- **Impact:** Per-branch accent theming and dark-mode token swaps cannot reach these badges, so the management UI will not re-skin per branch and may fail contrast in dark mode (e.g. text-green-800 on a themed dark surface). It also fragments the visual language: 'active green' here won't match success-green elsewhere.
- **Fix:** Replace literal palette classes with the existing semantic tokens, which already have light+dark variants. For the two-state Active/Inactive badge prefer shadcn Badge variants: `variant={isActive ? 'default' : 'secondary'}` or, to keep green, `className={isActive ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'}` (note: use bg-success/15 to match the existing `.success` utility at index.css:411, not /10). For effective-price use `text-primary` (or a dedicated token) instead of `text-blue-600`. For the "Doctor Found" alerts, use `<Alert variant="warning">` if defined, or `className="border-warning/50 bg-warning/10"` with `text-warning` for icon/heading and `text-warning-foreground`/`text-muted-foreground` for body — never raw text-yellow-700. For the multi-value maps (PRODUCT_TYPES, WORKFLOW_MODES, LAYOUT_TYPES, STATUS_COLORS) that need MORE than the 3 semantic tokens, either (a) add named chart/category tokens to index.css (e.g. --category-1..n with dark variants) and reference them, or (b) accept that these are categorical and at minimum centralize them in ONE shared helper (e.g. src/lib/badgeColors.ts) so all owner tabs import the same map — today STATUS/type maps are duplicated per file. Do not leave the maps as raw -100/-800 literals, since text-*-800 fails contrast on dark surfaces.

### 95. 🟡 Each tab reimplements the same header/search/empty/loading/footer scaffold
**MEDIUM** · redundancy · effort L

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManageDepartments.tsx`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx`
- **Problem:** The same management-table chrome is copy-pasted with subtle drift. Headers: h2 text-lg font-semibold + icon + muted subtitle + size='sm' New button (ManageBillableProducts.tsx:479-489, ManagePanelDefinitions.tsx:844-854, ManageClinicalDefinitions.tsx:702-714, ManageDepartments.tsx:269-281). The 'Showing N record(s)' footer is reinvented per page with inconsistent wording: 'Showing {n} product{s}' (BillableProducts:585), 'Showing {n} panel{s}' (Panels:935), 'Showing {n} definition{s}' (Definitions:911), but Departments says 'Showing {filtered} of {total} departments' (line 372) and Signing/Referrals have NO count footer at all. Empty/loading copy also drifts: 'No products found' vs 'No panels found' vs Departments' richer 'No departments yet. Create one to get started.' vs Referrals' 'No referral doctors yet.'
- **Impact:** Inconsistent counts and empty-state quality across tabs make the surface feel unpolished; every new entity page re-pays the boilerplate cost and re-introduces drift.
- **Fix:** Extract a <ManagementTablePage> (or hook) owning header (icon/title/subtitle/action), search input, loading skeleton, empty state, table wrapper, and the result-count footer. Standardize the empty state to the Departments pattern (explains next action) and always show a consistent count footer.

### 96. 🟡 Search inputs are inconsistent: client-filter vs server-filter, icon offsets differ, max-widths differ
**MEDIUM** · consistency · effort M

- **Files:** `health-hub/src/pages/owner/ManageDepartments.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx`
- **Problem:** Search behaves differently per tab. Departments and Signing-Doctors filter client-side on already-loaded data (ManageDepartments.tsx:254-258, ManageSigningDoctors.tsx:679-684). Products/Panels/Clinical-Defs send the query to the server on every keystroke with NO debounce — search state is in the fetch dependency array (ManageBillableProducts.tsx:160-174 fetchProducts depends on search; ManageClinicalDefinitions.tsx:272-286), so each character triggers a network request. Even the search box styling drifts: icon left-2 (Products:493, Panels:858) vs left-2.5 (Departments:285, Signing:711), and container max-w-md vs max-w-sm.
- **Impact:** Unthrottled server search hammers the API and causes janky result flicker as the owner types; mixed client/server semantics mean identical-looking boxes behave differently (one filters loaded inactive items, another refetches). Pixel-level icon drift is visible side by side.
- **Fix:** Standardize on a debounced (300-400ms) search hook reused everywhere, decide client-vs-server per dataset size and document it, and use one shared SearchInput component with fixed icon offset and width.

### 97. 🟡 Delete confirmations and toasts mislabel deactivation as permanent deletion
**MEDIUM** · microcopy · effort S

- **Files:** `health-hub/src/pages/owner/ManageDepartments.tsx`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`
- **Problem:** The trash icon + 'Delete Department?' dialog actually soft-deactivates, and the wording is internally contradictory. ManageDepartments.tsx: dialog title 'Delete Department?' with action button labeled 'Delete'/'Deleting...' (lines 465, 473-474), but the success toast says 'Department deactivated' (line 241) and the dialog body says 'This will deactivate the department.' Same contradiction in ManageDiagnosticCenters.tsx (title 'Delete Diagnostic Center?', toast 'Diagnostic center deactivated', line 235) and the unified ManageDoctorsAndReferrals.tsx centers delete (toast 'Center deactivated', line 689, button 'Delete'). Meanwhile the Active toggle in the same rows ALSO deactivates — so there are two controls doing the same thing with different labels.
- **Impact:** Owners cannot tell whether data is gone forever or just hidden; the red destructive 'Delete' styling implies irreversible loss for an action that is reversible, which either causes undue fear or false confidence. Redundant with the Active switch already in the row.
- **Fix:** If the action deactivates, label it 'Deactivate' (or 'Archive') with neutral/warning styling, not destructive red, and make the toast/title/body agree. Better: drop the trash button where an Active switch already exists, or reserve the trash for a true hard-delete (as the products/definitions endpoints support).

### 98. 🟡 Icon-only action buttons lack accessible names; rupee icon overloaded for two meanings
**MEDIUM** · accessibility · effort S

- **Files:** `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`, `health-hub/src/pages/owner/ManageDepartments.tsx`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`
- **Problem:** Row actions are icon-only Buttons with no aria-label and inconsistent title attributes. In ManageDoctorsAndReferrals.tsx the Edit and Delete buttons have neither title nor aria-label (e.g. lines 989-990, 1186-1187, 1506-1507) — a screen reader announces only 'button'. Departments/Centers edit & delete likewise have no aria-label (ManageDepartments.tsx:356-361). Additionally the IndianRupee icon means TWO different things with no text: in ManageBillableProducts.tsx (line 564) it opens 'Branch Pricing' (has title), but in ManageDoctorsAndReferrals.tsx (lines 984-987) the same icon navigates to a payouts page (title 'View payouts'). Same glyph, two destinations.
- **Impact:** Keyboard/screen-reader owners cannot distinguish Edit/Delete/Pricing/Payouts; the duplicated rupee icon is ambiguous even to sighted users.
- **Fix:** Add aria-label (and consistent title) to every icon-only action button. Differentiate the two rupee actions with distinct icons or accompanying text (e.g. a 'Pricing' tag vs a 'Payouts' wallet icon). Consider an overflow '…' menu to reduce the 3-4 icon cluster per row.

### 99. 🟡 Clinical Definition dialog shows two separate 'Critical Values' switches bound to one state
**MEDIUM** · interaction-feedback · effort S

- **Files:** `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`
- **Problem:** Inside the same definition dialog there are two distinct 'Critical Values' switches in two different accordion sections, both bound to the single formShowCritical state: one in 'General Reference Range' (id=critical-toggle-general, line 996-1001) and one in 'Age/Gender Specific Ranges' (id=critical-toggle-ranges, line 1092-1097). Toggling either flips both, and only the second section's switch actually gates whether critical columns render in the range grid. A user toggling the General one will see the Age/Gender grid columns appear/disappear unexpectedly.
- **Impact:** Confusing phantom coupling: the owner thinks they are enabling critical values for one section but it silently changes another, with no indication the two are the same control.
- **Fix:** Use a single labeled 'Show critical values' control at the dialog level (e.g. in the header) rather than duplicating it in two sections, or give each section independent critical-enable state if they are meant to differ.

### 100. 🟡 Panel save swaps Name and Code into the wrong API fields, contradicting the form labels
**MEDIUM** · information-architecture · effort M

- **Files:** `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`
- **Problem:** The form shows 'Name *' bound to formName and 'Code *' bound to formCode (lines 959-960, 963-967). But handleSave sends name: formCode.trim() and displayName: formName.trim() (lines 715-716) — i.e. the human-entered Name is stored as displayName and the Code is stored as name. The list table then renders panel.name as the 'Name' column (line 893) and panel.code as 'Code' (line 891). This label/field inversion is a latent data-integrity/comprehension trap and makes the page's mental model (what is 'name'?) inconsistent with every other entity here where name == display name.
- **Impact:** Confuses anyone mapping the UI to the data model or debugging; risks displaying the code where a name is expected if any consumer reads panel.name directly.
- **Fix:** Align field semantics with labels: send name from formName and code from formCode (or rename the backing fields). At minimum add a comment, but ideally normalize so 'Name' always maps to the display name across products/panels/definitions.

### 101. ⚪ Form fields use fixed grid-cols-2 / md-only grids that break on small/narrow viewports
**LOW** · responsive · effort S

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`
- **Problem:** The product dialog form uses a non-responsive grid-cols-2 (ManageBillableProducts.tsx:602) and the panel basic-info block also uses grid grid-cols-2 (ManagePanelDefinitions.tsx:957) with no sm:/md: prefix, so on a narrow tablet (common at a front desk) Name/Code and Type/Workflow stay cramped into two columns rather than stacking. The pricing-override rows (line 771) and line-item rows are fixed flex layouts that overflow on small widths. Contrast with the doctor forms which correctly use md:grid-cols-2 to stack on mobile.
- **Impact:** On smaller owner/staff screens the configuration dialogs become cramped and inputs shrink below comfortable tap/typing size.
- **Fix:** Use grid-cols-1 sm:grid-cols-2 for these dialog field grids (matching the md:grid-cols-2 pattern already used in the doctor forms) so fields stack gracefully on narrow viewports.

### 102. ⚪ Rows expose both a Status badge and a Switch (and a delete) doing overlapping jobs
**LOW** · redundancy · effort S

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`
- **Problem:** Products and Panels rows show an Active/Inactive Badge in a Status column AND an Active Switch in the Actions cluster that controls the same isActive flag (ManageBillableProducts.tsx:554-557 badge + 570-574 switch; ManagePanelDefinitions.tsx:904-908 badge + 920-924 switch). The badge is purely redundant readout of the switch sitting two columns over. In Clinical Definitions the Switch's only meaning ('Visible in clinical forms') is conveyed solely via a title tooltip (line 871) with no visible label, so its purpose is unclear next to the separate Status badge.
- **Impact:** Wastes a column and adds visual noise; the duplicated active indicator competes for attention, and the unlabeled visibility switch in Definitions is easily mistaken for an active/inactive toggle.
- **Fix:** Keep the inline Switch as the single source of truth and drop the redundant Status badge column (or vice-versa). For the Definitions visibility switch, add a small visible label or move it to a clearly-labeled column header so its distinct meaning is obvious.

---

## Payouts

_The Payouts module is functionally rich and largely well-structured (URL-driven filters, server-side totals, tabular-nums money), but it has real financial-trust gaps: bulk delete silently destroys PAID payout records, status badges hardcode raw Tailwind palette colors that contradict the design system's status tokens (and invert the "pending" hue), the By-Doctor tab ignores the Status/Doctor filters that appear to apply to it, and several reactive/feedback states (bulk Mark-Paid enablement, Run-Cycle "Pay N pending" mislabeling) confuse the core money workflow._

### 103. 🔴 Bulk delete silently destroys PAID payouts with no distinct warning
**CRITICAL** · error-handling · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/components/payouts/PayoutDeleteDialog.tsx`
- **Problem:** openBulkDelete (PayoutsList.tsx:294-298) and submitBulkDelete (300-330) delete every selected row — `const ids = selectedRows.map((r) => r.id)` — with zero check for `paidAt`. Mark-paid has a guard (line 228 blocks bulk if `!selectedAllPending`), but delete has none, so an owner can wipe out already-PAID commission records (a financial/audit trail) in one click. The confirm dialog (PayoutDeleteDialog.tsx:42-49) says only 'Delete N payouts? This action cannot be undone…' and never mentions that some/all are paid. The toast even reframes server-side filtering as 'were already gone' (321), masking that paid rows were destroyed.
- **Fix:** In PayoutsList.tsx compute `const selectedPaidCount = selectedRows.filter((r) => r.paidAt).length;` and pass it into PayoutDeleteDialog as a new `paidCount` prop (the dialog already takes a plain `count`, so this is a minimal extension). In the dialog, when `paidCount > 0` render a distinct destructive callout below the description — e.g. an amber/destructive bordered block: "{paidCount} of these are already PAID. Deleting permanently removes settled commission records from the doctor's payout history and exports." For true parity with the mark-paid guard (line 228), the strongest fix is to block deletion of paid rows outright: in openBulkDelete, if any `selectedRows` has `paidAt`, `toast.error("Selection includes already-paid payouts. Filter to Pending first.")` and return — mirroring openBulkMarkPaid exactly. If owners legitimately need to delete paid records, keep the dialog warning but additionally gate the confirm behind a type-to-confirm or a second checkbox ("I understand this deletes a settled financial record"). Separately, fix the misleading toast: do not label any non-deleted remainder as "already gone" when the selection contained paid rows; instead reflect the actual server response shape (consider returning paidDeletedCount from the API like the mark-paid endpoint returns paidIds/conflictIds, and surface it).

### 104. 🟠 Status badges hardcode raw Tailwind palette instead of design-system status tokens (and invert the 'pending' hue)
**HIGH** · branding · effort M · verified (high)

- **Files:** `health-hub/src/components/payouts/PayoutsTable.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`, `health-hub/src/pages/owner/PayoutRunCycle.tsx`, `health-hub/src/index.css`, `health-hub/tailwind.config.ts`
- **Problem:** index.css defines dedicated, theme-aware status tokens — `--status-pending: 220 80% 50%` (blue), `--status-paid`/`--success` (green), `--status-unpaid`/`--destructive` (red) — plus `.status-badge`/`.status-pending`/`.status-paid` utilities. Payouts ignores all of them and hardcodes raw palette across ~30 sites. PayoutsTable.tsx:229-235 renders Pending as `bg-yellow-50 text-yellow-700 border-yellow-200`, and PayoutDetail.tsx:382-387 uses `bg-yellow-100`/`text-yellow-700` for Pending. But the system's `--status-pending` is BLUE, so payouts present 'pending' in a color the rest of the app reserves for warnings/draft. Money summary cards even mix metaphors: PayoutsList.tsx:539 puts 'Pending Amount' in `text-red-600`/`bg-red-100` while the adjacent 'Pending Payouts' count is yellow (532) — pending money looks like an error/overdue state. These literals also won't adapt in dark mode (tokens have `.dark` overrides; `yellow-700` does not).
- **Fix:** Replace the hardcoded yellow/green/red classes in all four payouts files with the existing utilities: use .status-badge .status-pending and .status-badge .status-paid for the table/detail badges, or bg-success/15 text-success and bg-destructive/15 text-destructive for inline icon tints. Align pending to the blue --status-pending so payouts match the rest of the app, and stop coloring 'Pending Amount' red (PayoutsList.tsx:539-540) — reserve destructive for genuinely overdue payouts. NOTE: while adopting tokens, also add a --status-pending override inside the .dark block in index.css (lines ~96-103) — currently only --success/--warning/--destructive/--status-* primary values are themed and --status-pending has no dark variant, so token adoption alone still needs a dark-mode value for full correctness. Optionally raise the >12px contrast: status-pending at /0.15 alpha on dark backgrounds should be validated for WCAG AA.

### 105. 🟠 By-Doctor tab silently ignores the Status and Doctor filters that remain visible above it
**HIGH** · consistency · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/PayoutsByDoctor.tsx`
- **Problem:** When the user switches to the By-Doctor tab (PayoutsList.tsx:655-673), the filter row — Type, Doctor/Center, and especially Status (Pending/Paid) — stays on screen, but only `doctorType`, `startDate`, `endDate`, `q` are passed down (657-662). The Status filter and the Doctor/Center filter are dropped entirely, so a user who selected Status=Pending still sees Paid totals in every rollup row (PayoutsByDoctor.tsx:171-175), and selecting a single doctor has no effect on this tab. The controls appear to apply but don't — a classic 'dead control' trust problem in a money view.
- **Fix:** Either (a) hide/disable the Status and Doctor/Center filters while the By-Doctor tab is active (they aren't supported by `summary-by-doctor`), with a small caption explaining the pivot shows both pending and paid; or (b) pass `status`/`doctorId` through and have the rollup honor them. Option (a) is the smaller, honest fix.

### 106. 🟠 Run Cycle 'Pay N pending' button does not pay — it just navigates to a list
**HIGH** · microcopy · effort S · verified (high)

- **Files:** `health-hub/src/pages/owner/PayoutRunCycle.tsx`
- **Problem:** In the preview step the primary CTA reads `Pay {pendingCount} pending · {amount}` (PayoutRunCycle.tsx:441-443) and is even promoted to the `default` (filled) variant when there's nothing new to derive (438). But its handler is viewAlreadyDerivedInList (260-275), which only closes the sheet and navigates to the filtered list — no payment occurs. A filled, money-labeled button that performs zero financial action is a serious expectation mismatch in a payouts flow.
- **Fix:** Relabel to reflect navigation, not payment: e.g. `Review {pendingCount} pending →` and keep it `variant="outline"` even when totalCounts.will === 0 (drop the conditional `default` promotion at line 438). This also aligns it with the sibling button at line 445-449 which already uses "View N in list" for the no-pending case. Reserve "Pay…" wording for a CTA that actually opens the Mark-Paid dialog. If a true in-flow pay action is desired, that is a larger change (would need the mark-paid mutation wired in); otherwise the minimal correct fix is the relabel + variant change (effort S).

### 107. 🟡 Bulk 'Mark Paid' is always enabled; clicking with paid rows fails after the fact instead of guiding
**MEDIUM** · interaction-feedback · effort M

- **Files:** `health-hub/src/components/payouts/PayoutBulkActionBar.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`
- **Problem:** PayoutBulkActionBar.tsx:52-54 renders 'Mark Paid' with no disabled state. If the selection mixes paid + pending rows, openBulkMarkPaid (PayoutsList.tsx:226-235) rejects the whole action with an error toast 'Selection includes already-paid payouts. Filter to Pending first.' after the click. The user is punished for an action the UI never prevented, and the bar shows a combined `totalInPaise` (selectedTotalInPaise, line 209-212) that sums paid + pending amounts — overstating what 'Mark Paid' would actually settle.
- **Fix:** Pass `selectedAllPending` / a `pendingCount`+`pendingTotal` to the bar. Disable Mark Paid (with a tooltip) when the selection isn't all-pending, OR change the flow to mark only the pending subset and label the button 'Mark N pending paid'. Show the pending-only total next to it rather than the mixed total.

### 108. 🟡 Run Cycle preview/derive runs N sequential requests with a single static spinner and no per-type progress or cancel
**MEDIUM** · interaction-feedback · effort M

- **Files:** `health-hub/src/pages/owner/PayoutRunCycle.tsx`
- **Problem:** runPreview (PayoutRunCycle.tsx:136-170) and runDerive (172-205) loop over selected doctor types issuing one fetch each, awaited serially, while the UI shows only a generic 'Building preview…' / 'Deriving payouts…' line (370-375, 464-469). For a 3-type monthly run across many doctors this can take a while with no indication of which type is in flight, no progress count, and no way to cancel. If derive fails mid-loop, runDerive `continue`s (193) and silently produces partial results with only a per-type toast.
- **Fix:** Show stepwise progress ('Deriving Referral doctors… (1/3)') by tracking the current type in state, and a determinate count where possible. On partial failure, surface a persistent summary in the results panel (which types failed) rather than relying on transient toasts.

### 109. 🟡 formatRupees is duplicated and forces '.00' decimals on whole-rupee amounts
**MEDIUM** · consistency · effort S

- **Files:** `health-hub/src/lib/payoutFormatters.ts`, `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** PayoutDetail.tsx:42-44 re-declares a local `formatRupees` instead of importing the shared one from payoutFormatters.ts:6-10 (every other payout file imports it) — a drift risk for the most accuracy-sensitive thing in the module. Both versions use `minimumFractionDigits: 2` only, so a whole-rupee commission renders '₹12,500.00' everywhere; in dense tables (PayoutsTable amount column, summary cards) the trailing '.00' adds visual noise across hundreds of rows. There is also no `maximumFractionDigits`, so any non-integer paise/100 (e.g. fractional rounding) could render 3+ decimals inconsistently.
- **Fix:** Delete the local copy in PayoutDetail.tsx and import from payoutFormatters. In the shared formatter, set both `minimumFractionDigits: 2, maximumFractionDigits: 2` (lock to paise precision), or — for table density — drop decimals when the amount is a whole rupee. Pick one rule and apply it everywhere.

### 110. 🟡 PayoutDetail leaks raw enum 'DIAGNOSTIC_CENTER' as a doctor-type badge and in the print/payment header
**MEDIUM** · microcopy · effort S

- **Files:** `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** The detail page renders the raw DB enum to users: the Doctor summary badge shows `{payout.doctorType}` directly (PayoutDetail.tsx:330-332), so a diagnostic center reads 'DIAGNOSTIC_CENTER' (all-caps, underscored). The print header repeats it: `{payout.doctorName} ({payout.doctorType})` (312). The payment method is likewise shown raw — `{payout.paymentMethod}` (409) prints 'ONLINE' / 'CHEQUE' instead of 'Online Transfer' / 'Cheque'. payoutFormatters already provides `formatDoctorTypeLabel` for exactly this, and it's unused here.
- **Fix:** Use `formatDoctorTypeLabel(payout.doctorType)` for the badge and print header (→ 'Diagnostic Center'), and add a small payment-method label map ('Online Transfer'/'Cheque'/'Cash') for line 409. The list/table already humanizes via formatDoctorTypeShort; the detail page should not regress to raw enums.

### 111. 🟡 Custom date range on the list has no start≤end validation or feedback (dialog has it, list doesn't)
**MEDIUM** · error-handling · effort S

- **Files:** `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/DerivePayoutDialog.tsx`
- **Problem:** The custom-range inputs (PayoutsList.tsx:444-460) feed straight into effectiveRange and the fetch with no guard. A user can set startDate after endDate and the list silently fetches an inverted range, returning an empty table with the generic 'No payouts match your filters' message — no hint that the dates are reversed. The single-derive dialog gets this right (DerivePayoutDialog.tsx:92-95 toasts 'Start date must be before end date'), so the behavior is inconsistent within the same module. The date inputs also lack `min`/`max` cross-bounds.
- **Fix:** Add a min/max relationship on the two date inputs (`max={state.endDate}` on start, `min={state.startDate}` on end) and/or an inline validation message + skip the fetch when start>end, mirroring the dialog's check.

### 112. ⚪ Detail page uses bare centered text for loading/not-found while the rest of the module uses skeletons
**LOW** · interaction-feedback · effort M

- **Files:** `health-hub/src/pages/owner/PayoutDetail.tsx`, `health-hub/src/components/payouts/PayoutsTable.tsx`, `health-hub/src/pages/owner/PayoutsByDoctor.tsx`
- **Problem:** PayoutDetail's loading state is a single centered 'Loading payout details...' string (PayoutDetail.tsx:230-238) and not-found is 'Payout not found' text (240-248), whereas PayoutsTable.tsx:150-159 and PayoutsByDoctor.tsx:115-120 use skeleton rows, and PayoutsList summary cards use `<Skeleton/>`. The detail page also offers no action on the not-found state (no 'Back to payouts' button), unlike other empty states that guide the user.
- **Fix:** Replace the loading text with a skeleton layout matching the detail cards/table for visual consistency, and give the not-found state a 'Back to Payouts' button (the 404 path already navigates away, but the rendered fallback should still be actionable).

### 113. ⚪ Doctor name and period are repeated three times in the detail header + summary cards
**LOW** · redundancy · effort S

- **Files:** `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** On the detail page the doctor name appears in the page subtitle (PayoutDetail.tsx:276 `{payout.doctorName} • {period}`) and again as a full summary card ('Doctor' card, 327-333), and the period appears in that same subtitle (276) AND as its own 'Period' summary card (344-347). The first summary card essentially restates the header. This burns one of four card slots and adds redundancy without new information; the doctor-type Badge is the only net-new datum in that card.
- **Fix:** Drop the redundant 'Doctor' and/or 'Period' summary cards (already in the subtitle) and reallocate the space — e.g. surface the type badge inline next to the title, and use the freed card slots for higher-value metrics (line-item count, average commission, or paid date). Keep the four-card grid balanced.

### 114. ⚪ Empty state tells users to 'clear filters' but the page provides no clear-filters control
**LOW** · navigation · effort S

- **Files:** `health-hub/src/pages/owner/PayoutsList.tsx`
- **Problem:** The filtered empty state advises 'Try widening the date range or clearing filters.' (PayoutsList.tsx:784-785), but there is no Clear/Reset button anywhere on the page — the `reset()` helper exists in usePayoutFiltersFromUrl.ts:109-111 but is never wired up. The user must manually reverse each Type/Doctor/Status/preset/search control. The active-filter detection (hasActiveFilters, 743-751) is already computed, so the trigger condition is known.
- **Fix:** Render a 'Clear filters' button (text or ghost) in the filters row or in the empty state when `hasActiveFilters(state)` is true, calling the existing `reset()` from the filters hook.

### 115. ⚪ Sticky bulk action bar can overlap pagination on short result sets
**LOW** · responsive · effort M

- **Files:** `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/components/payouts/PayoutBulkActionBar.tsx`
- **Problem:** The bulk bar is `fixed … bottom-4` (PayoutBulkActionBar.tsx:37) and the page reserves `pb-24` (PayoutsList.tsx:404). With only a few rows selected on a short page, the floating pill sits over the pagination/page-size controls (PayoutsList.tsx:598-648) and the 'By Doctor' footer totals (PayoutsByDoctor.tsx:190-203), which are NOT inside that padded container — they can be obscured. On small/zoomed viewports the horizontally-laid-out pill (count + 4-5 buttons) can also overflow the screen width with no wrapping.
- **Fix:** Ensure all scrollable content (including the by-doctor footer) lives inside the `pb-24` container, or increase bottom padding when the bar is visible. For narrow screens, allow the pill to wrap or switch to a full-width bottom bar layout below `sm`.

---

## Print Documents & Legal Pages

_The clinic prescription + bill print path (BillReceipt / ClinicPrescriptionPrint) is reasonably polished, but ReportPrint.tsx is an orphaned, placeholder-branded component that would leak "DIAGNOSTIC CENTER / 123 Medical Street" onto a real lab report if ever wired up. The bill header silently drops the clinic name (computed but unused), totals are ordered illogically, and the three legal pages are completely off-brand (no logo, no Sobhana visual identity, hardcoded gray/blue colors instead of design tokens) and are not linked from anywhere in the app._

### 116. 🔴 ReportPrint uses fake placeholder clinic identity ("DIAGNOSTIC CENTER", "123 Medical Street")
**CRITICAL** · branding · effort S · verified (high)

- **Files:** `health-hub/src/components/print/ReportPrint.tsx`
- **Problem:** ReportPrint.tsx renders a lab report header with hardcoded placeholder branding: line 15 `<h1 ...>DIAGNOSTIC CENTER</h1>`, line 16 `<p>123 Medical Street, City - 123456</p>`, line 17 `Phone: 1234567890 | Email: info@diagnostic.com`. None of this is Sobhana branding — it is scaffolding/lorem data. The component is also orphaned (grep finds it imported nowhere and rendered nowhere), so it is dead code that nonetheless ships in the bundle and is a landmine: the moment anyone wires it to a report screen it prints a legally-named medical document with a fictitious lab name, address, phone and email onto a patient's results.
- **Fix:** Delete ReportPrint.tsx outright. Beyond the placeholder branding, this orphaned component would also produce a non-compliant document even after a branding fix: it has no logo, no per-branch address, a bare unlabeled second signature line (lines 85-87), and uses Tailwind utility classes (`bg-gray-100`, `text-red-600`) and `max-w-2xl mx-auto` that do not match BillReceipt's print-tuned inline-style/letterhead approach — so it is not a viable report template even with real data swapped in. The live report path already exists (BillReceipt plus the server-side letterhead per reportAccess.ts). Removing dead code is lower risk than maintaining a latent landmine. Only if a dedicated lab-report print layout is genuinely planned should it be kept — in which case rebuild its header to reuse BillReceipt's BILL_LOGO_URL, branchName, the per-branch address IIFE, and phone string, ideally extracted into a shared <PrintLetterhead> component so the two print surfaces cannot drift.

### 117. 🟠 Printed bill header omits the clinic name; clinicLabel is computed but never rendered
**HIGH** · branding · effort S · verified (high)

- **Files:** `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** BillReceipt.tsx line 170-172 computes `const clinicLabel = isDiagnostic ? "Sobhana Diagnostic Centre" : "Sobhana Clinic";` but grep confirms `clinicLabel` is referenced only on line 170 — it is never placed in the JSX. The actual header (lines 188-229) shows only a logo image (`alt="Sobhana"`), the branch name, an address line, a phone line, and "Requisition cum Receipt". So the printed legal receipt has no spelled-out clinic name at all; if the logo image fails to load (the onerror handler at line 153 just hides it and proceeds), the bill prints with no business name whatsoever — only a branch label and address.
- **Fix:** Render clinicLabel as text in the header, directly under the logo (around line 201), so the business name always prints even when the logo fails: `<div className="font-semibold" style={{fontSize:'13px'}}>{clinicLabel}</div>`. Caveat: do NOT blindly substitute the "full legal name" suggested in the original recommendation — the existing variable already branches on isDiagnostic ("Sobhana Diagnostic Centre" vs "Sobhana Clinic"). Before changing the wording, confirm the canonical legal entity name against Login/legal pages; if they differ, fix the brand-name inconsistency at the source (a shared constant) rather than hardcoding a third variant here. As a defensive improvement, also consider showing the text name unconditionally and keeping the logo as a visual enhancement, rather than relying on logo visibility for branding.

### 118. 🟠 Legal pages have zero Sobhana branding — generic white page, no logo, no header/footer
**HIGH** · branding · effort M · verified (high)

- **Files:** `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/pages/legal/TermsOfService.tsx`, `health-hub/src/pages/legal/DataDeletion.tsx`
- **Problem:** All three public legal pages render a bare `<div className="min-h-screen bg-white py-16 px-6">` with an unbranded `<h1>` and body text (PrivacyPolicy.tsx line 2-4, TermsOfService.tsx line 2-4, DataDeletion.tsx line 2-4). There is no Sobhana logo, no app header/nav, no footer, and no link back to the app. For a Meta WhatsApp Business API review (these pages exist for that compliance), a reviewer landing on `/privacy` sees an anonymous document with no visual proof it belongs to Sobhana. It looks like an unfinished template, not a page from the Sobhana brand.
- **Fix:** Create a shared `LegalPageLayout` wrapper (e.g. src/pages/legal/LegalPageLayout.tsx) and refactor all three pages to use it, eliminating the duplicated bare-div structure. The layout should include: (1) a header with `<img src="/sobhana-whitebg.png" alt="Sobhana Diagnostic Centre & Multi Speciality Clinic" />` (the existing white-bg asset already used in BillReceipt/Sidebar) plus the full legal name; (2) a "Back to portal" link (`<Link to="/">`); (3) a footer with copyright (`© {new Date().getFullYear()} Sobhana Diagnostic Centre & Multi Speciality Clinic`) and the canonical contact line. Since no central address/phone constant currently exists, first add one (e.g. export `LEGAL_ENTITY = { name, address, phone, email }` in src/lib or a new src/config/legal.ts) and reference it from both the footer and the inline "Contact" sections so the email (currently hardcoded three times) and address live in one place. Take props for `title` and `lastUpdated` so each page passes only its content as children. Keep the existing prose; this is purely a wrapper extraction plus brand chrome.

### 119. 🟡 Legal pages hardcode gray/blue Tailwind colors instead of design tokens
**MEDIUM** · consistency · effort S

- **Files:** `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/pages/legal/TermsOfService.tsx`, `health-hub/src/pages/legal/DataDeletion.tsx`
- **Problem:** The legal pages use raw color utilities — `text-gray-900` (headings), `text-gray-700` (body), `text-gray-500` (date), and links styled `text-blue-600 underline` (PrivacyPolicy.tsx lines 4-8, 66; same pattern in TermsOfService.tsx lines 4-8, 63 and DataDeletion.tsx lines 4-8, 19). The rest of the app is built on grayscale primary + token-based colors in index.css/tailwind.config.ts; `text-blue-600` links in particular appear nowhere else in this design system and clash with the Sobhana accent. This is the only place `blue-600` is used for interactive text.
- **Fix:** Swap to the design tokens: headings `text-foreground`, body `text-muted-foreground`, date `text-muted-foreground`, and links to `text-primary underline-offset-4 hover:underline` (or the branch accent var). This keeps legal pages consistent with the rest of the portal and respects the grayscale-primary system.

### 120. 🟡 Legal pages exist as routes but are not linked from anywhere in the app
**MEDIUM** · navigation · effort S

- **Files:** `health-hub/src/App.tsx`, `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/pages/legal/TermsOfService.tsx`, `health-hub/src/pages/legal/DataDeletion.tsx`
- **Problem:** Routes `/privacy`, `/terms`, `/data-deletion` are registered (App.tsx lines 228-230) but grep for `/privacy`, `/terms`, `/data-deletion` outside of route definitions returns nothing — no footer, login page, or settings link points to them. They are reachable only by typing the URL. For WhatsApp Business / app-store compliance these URLs usually need to be discoverable, and users have no in-app way to find their privacy rights or data-deletion instructions.
- **Fix:** Add a small footer (at minimum on the Login page and ideally a global app footer) with links to Privacy Policy, Terms of Service, and Data Deletion. Reuse the branded LegalPageLayout footer so the links are consistent.

### 121. 🟡 Bill totals list Paid Amount before Discount, breaking the arithmetic narrative
**MEDIUM** · information-architecture · effort S

- **Files:** `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** In the totals block (BillReceipt.tsx lines 359-388) the rows render in order: Total Amount (line 361), Paid Amount (line 367), then conditionally Disc. Amount (line 373), then Due Amount (line 381). A reader cannot follow the math: a receipt should read Total → Discount → Net/Payable → Paid → Due. Showing Paid before Discount makes it look like the patient paid the full pre-discount total, and Net/Payable is never shown at all even though `netAmount` is already computed (lines 63-66).
- **Fix:** Reorder to: Total Amount, Disc. Amount (when >0), Net Payable (always, using `netAmount`), Paid Amount, Due Amount (when >0). This gives a coherent top-to-bottom calculation and surfaces the net payable the customer actually owes.

### 122. 🟡 ReportViewPage redirect shows an infinite spinner with no timeout or failure recovery
**MEDIUM** · error-handling · effort S

- **Files:** `health-hub/src/pages/ReportViewPage.tsx`
- **Problem:** ReportViewPage immediately `window.location.replace(redirectUrl)` (lines 19-23) and otherwise shows a spinner with "Opening your report..." (lines 40-45). If the backend report endpoint is slow, down, or returns an error page, the only feedback the patient ever sees on this page before the redirect is a spinner; if the replace fails silently or the target errors, there is no timeout, no retry, and no way back. The missing-token branch (lines 25-38) is handled well, but the success path has no fallback.
- **Fix:** Keep the redirect, but add a fallback after a few seconds: if still on the page, show a visible "Open report" anchor link to `redirectUrl` plus a "having trouble?" message, so a stalled or blocked redirect (popup/security blockers, slow network) still gives the patient an actionable link.

### 123. 🟡 Clinic legal name is inconsistent across print and public pages
**MEDIUM** · consistency · effort S

- **Files:** `health-hub/src/components/print/BillReceipt.tsx`, `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/pages/legal/TermsOfService.tsx`, `health-hub/src/pages/Login.tsx`
- **Problem:** The same business is named differently in different surfaces: BillReceipt.tsx line 171-172 uses "Sobhana Diagnostic Centre" / "Sobhana Clinic"; Login.tsx line 90 and PrivacyPolicy.tsx line 10 use the full legal name "Sobhana Diagnostic Centre & Multi Speciality Clinic"; TermsOfService.tsx lines 10/56 abbreviate to just "Sobhana Diagnostic Centre". On legal/financial documents (a bill, a privacy policy) the registered entity name should be identical everywhere.
- **Fix:** Define a single source of truth (e.g. `CLINIC_LEGAL_NAME = 'Sobhana Diagnostic Centre & Multi Speciality Clinic'` and an optional short name) in a constants module and consume it in BillReceipt, the legal pages, and Login. The bill header and legal pages should all show the full registered name.

### 124. 🟡 Branch address is selected by fragile string-matching on branch name
**MEDIUM** · error-handling · effort M

- **Files:** `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** The printed address is chosen by lowercasing branchName and substring-matching (BillReceipt.tsx lines 211-221): `includes('kidcare') || includes('gutta')`, `includes('balanagar')`, else default to the Chintal address. If a branch is renamed, added, or its name does not contain one of these magic substrings, the bill silently prints the WRONG physical address (the Chintal default) on a financial/legal receipt. There is also a spelling mismatch: the Balanagar entry hardcodes "Shobhana Complex" (with an extra h) inside addresses for a brand spelled "Sobhana" everywhere else.
- **Fix:** Drive the printed address from branch data (return address/phone from the bills API alongside branch.name/code) instead of string-sniffing the display name. At minimum, key off `branch.code` rather than fuzzy name matching, and reconcile the "Shobhana" vs "Sobhana" spelling so it does not look like a typo on every Balanagar bill.

### 125. ⚪ Totals values prefix a literal ": " inside the right-aligned cell, breaking tabular-num alignment
**LOW** · consistency · effort S

- **Files:** `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** Each total value is rendered as `: {fmt(...)}` inside a right-aligned `flex justify-between` span with `fontVariantNumeric: 'tabular-nums'` (BillReceipt.tsx lines 362-364, 368-370, 375-377, 383-385). Because the colon-space is part of the same right-aligned, tabular-numeric span, the colons themselves get right-aligned against the number column, so the colons sit immediately left of digits of varying length and do not line up vertically; the tabular-nums benefit (clean decimal column) is partly defeated by the leading ': '. The patient-details grid uses a separate colon span pattern, so this is also inconsistent within the same document.
- **Fix:** Move the colon out of the numeric span: render the label as `<span>Total Amount :</span>` and the value as a pure numeric `<span style={{fontVariantNumeric:'tabular-nums'}}>{fmt(...)}</span>`, so only digits occupy the right column and the decimal points align.

### 126. ⚪ Print and legal pages set no document.title, so saved PDFs / browser tabs are unlabeled
**LOW** · microcopy · effort S

- **Files:** `health-hub/src/pages/BillPrintPage.tsx`, `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/pages/legal/TermsOfService.tsx`, `health-hub/src/pages/legal/DataDeletion.tsx`, `health-hub/src/pages/ReportViewPage.tsx`
- **Problem:** Grep finds no `document.title`, `<title>`, or Helmet usage in any of these pages. When a desktop user uses the browser Print dialog on BillPrintPage (window.print(), line 112), the suggested PDF filename and print header default to the app/tab title rather than something like the bill number. Likewise the legal pages and report-view tab carry the generic app title. (The mobile path does set a filename via `pdf.save(\`${billNo}.pdf\`)` at line 103, which highlights the desktop gap.)
- **Fix:** Set `document.title` per page: on BillPrintPage use the bill/visit ref (e.g. `Bill ${receiptData.billNumber}`) once data loads so the desktop Print-to-PDF filename and header are meaningful; give the legal pages titles like "Privacy Policy — Sobhana".

### 127. ⚪ Print button stays disabled while logo loads with no clear affordance
**LOW** · interaction-feedback · effort S

- **Files:** `health-hub/src/pages/BillPrintPage.tsx`, `health-hub/src/components/print/BillReceipt.tsx`
- **Problem:** BillPrintPage disables the print button until the logo loads: `disabled={!logoLoaded || generating}` with label "Preparing Print..." (lines 142-151). The logo onerror handler in BillReceipt (lines 153-156) does flip logoLoaded true on failure, so it won't hang forever — but the disabled state has no visible spinner and the button is positioned `fixed top-4 right-4` with `z-50`, where on a long bill it can overlap the receipt's top content. There is also no toast/explanation if PDF generation throws (line 104 only console.errors then silently falls back to window.print()).
- **Fix:** Add a small inline spinner to the "Preparing Print..." / "Generating PDF..." states for clearer feedback, and surface a user-visible toast on PDF-generation failure instead of a silent console error + fallback. Consider constraining the fixed button so it cannot overlap receipt content on narrow viewports.

---

## LENS: Design System & Visual Consistency

_A clean grayscale + semantic token system exists in index.css/tailwind.config.ts, but it is massively bypassed: 354 raw Tailwind palette utilities and dozens of hardcoded hex values across ~30 files reinvent status/semantic colors, page titles use four different heading recipes, and an entire parallel hardcoded-hex design system lives in the V2 dashboards. Several core semantic tokens (warning/success on white) fail WCAG contrast, a defined status token has no matching class, and the full .dark theme is dead code that is never activated._

### 128. 🔴 warning and success tokens use white foreground that fails WCAG contrast
**CRITICAL** · accessibility · effort S · verified (high)

- **Files:** `health-hub/src/index.css`, `health-hub/tailwind.config.ts`
- **Problem:** index.css line 36-37 sets `--warning: 38 92% 50%` (#f59e0b) with `--warning-foreground: 0 0% 100%` (white). White text on that amber yields a contrast ratio of only 2.14:1 — far below the 4.5:1 AA threshold for text and even below 3:1 for large text/UI. Line 33-34 `--success: 142 72% 40%` with white foreground is 2.86:1, also failing AA for text. Any `bg-warning text-warning-foreground` or `bg-success text-success-foreground` (e.g. a 'Finalized'/warning button or badge) is unreadable for low-vision users.
- **Fix:** Either darken the backgrounds (warning to ~38 92% 38%, success to ~142 72% 30% to reach 4.5:1 with white) or, better for these light hues, switch the foregrounds to near-black: `--warning-foreground: 0 0% 10%`, `--success-foreground: 0 0% 10%`. Verify each with a contrast checker; keep destructive (#dc2626, 4.5:1+ with white) as-is.

### 129. 🟠 354 raw Tailwind palette colors bypass the token system across ~30 files
**HIGH** · consistency · effort L · verified (high)

- **Files:** `health-hub/src/pages/owner/PayoutDetail.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/components/diagnostics/RichTextToolbar.tsx`, `health-hub/src/components/patient360/PatientEditDialog.tsx`, `health-hub/src/index.css`, `health-hub/tailwind.config.ts`
- **Problem:** `grep -rnE "(text|bg|border|ring)-(red|green|blue|amber|...)-[0-9]" health-hub/src` returns 354 hits. The token palette (success/warning/destructive/muted/foreground) is largely ignored: success token is used 8 times vs `text/bg-green-600/700` 29 times; warning token 10 times vs `amber/yellow-600/700` 40 times; destructive 40 vs `red-500/600` 51. The same gray scale is hand-rolled everywhere (text-gray-900 29x, text-gray-500 25x, text-gray-700 22x, slate-200 19x) instead of `text-foreground`/`text-muted-foreground`/`border-border`. PayoutDetail.tsx alone has 33 occurrences (e.g. line 234 `text-gray-500`, line 275 `text-gray-900`, line 324 `bg-blue-100`, line 341 `bg-purple-100`).
- **Fix:** Recommendation is correct and actionable. Two refinements: (1) Prioritize by semantic risk, not just raw count — the worst offenders are the GREEN and AMBER semantic states (success token used only 7x vs 31 raw greens; warning vs 41 raw amber/yellow), because these encode meaning (paid/pending/overdue) and divergent shades erode the status language. The gray scale (text-gray-900/500/700, slate-200) is high-volume but lower-risk; batch it via codemod. (2) The `bg-blue-100`/`bg-purple-100` icon-chip backgrounds in PayoutDetail (lines 324, 341) have NO token equivalent today — decide whether decorative/categorical chip colors are in-scope for the token system or explicitly allowlisted; don't force them onto semantic tokens (a Doctor chip is not "info"). For enforcement, prefer eslint no-restricted-syntax with a regex on className literals (eslint-plugin-tailwindcss does not block specific shades out of the box); run it as warn-only first to avoid blocking CI during the migration, then escalate to error once highest-count files (PayoutDetail, ManageClinicalDefinitions, ManagePanelDefinitions) are converted.

### 130. 🟠 OwnerDashboardV2 ships an entire parallel hardcoded-hex design system
**HIGH** · consistency · effort L · verified (high)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/lib/branchTheme.ts`, `health-hub/src/index.css`
- **Problem:** OwnerDashboardV2.tsx lines 117-145 define a self-contained `TOKENS` object of hardcoded hex values that duplicate and diverge from the real tokens: `healthy: '#0F6E56'`, `critical: '#A32D2D'`, `info: '#185FA5'`, `textPrimary: '#1F1F1E'`, `textSecondary: '#5F5E5A'`, `surface: '#FFFFFF'`, `page: '#FAFAF8'`, plus categorical/waterfall colors. These bypass --success/--destructive/--foreground/--background entirely, use a warm off-white page background (#FAFAF8) inconsistent with the app's `--background: 0 0% 98%`, and render the owner area visually disconnected from the rest of the product. OwnerMoneyPage.tsx also hardcodes `background: '#FFF8E1'` (lines 284, 364) for flagged rows.
- **Fix:** The deeper problem is not just the hex values but that the entire owner area is built on inline style={{}} props instead of Tailwind classes, which is what forces the parallel JS token object. Fix in two layers: (1) Promote the genuinely-new chart/categorical colors (reportable, clinic, billOnly, cash, online, gross, discount, commissionBar, net) into named CSS vars in index.css under both :root and .dark (e.g. --chart-reportable, --chart-clinic ...), so charts get dark-mode support they currently lack. (2) Replace the duplicated structural/semantic tokens with the existing vars rather than re-declaring them: page/surface -> bg-background / bg-card; textPrimary/Secondary/Tertiary -> text-foreground / text-muted-foreground; healthy -> --success, critical -> --destructive, caution -> --warning; border -> border-border. For Recharts where an inline color string is unavoidable, read the vars once via getComputedStyle(document.documentElement).getPropertyValue('--chart-...') wrapped to hsl(), so the chart palette and the rest of the UI stay in sync and respond to theme/branch changes. Also replace the literal #FFF8E1 / #FCEBEB30 flagged-row backgrounds with a token (e.g. bg-warning/10 and bg-destructive/10) so flag styling matches the app's flag tokens.

### 131. 🟠 StatusBadge component used in only 7 files; status pills are re-hardcoded everywhere
**HIGH** · redundancy · effort M · verified (high)

- **Files:** `health-hub/src/components/ui/status-badge.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/components/payouts/PayoutsTable.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`, `health-hub/src/pages/owner/PayoutRunCycle.tsx`
- **Problem:** The canonical StatusBadge is imported in only 7 files, while status/category pills are reinvented inline with raw palette classes across many: ManageClinicalDefinitions.tsx lines 108-109 (`ACTIVE: 'bg-green-100 text-green-800'`, `LOCKED: 'bg-yellow-100 text-yellow-800'`), ManageBillableProducts.tsx lines 87-94 and 555 (`isActive ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'`), PayoutsTable.tsx lines 223/231 (`bg-green-50 text-green-700 border-green-200`), ProductSelector.tsx lines 62-66, PayoutRunCycle.tsx line 608. Each invents its own green/amber shade pair, so 'active'/'paid'/'finalized' green is visually different from page to page.
- **Fix:** Recommendation is sound; tighten it as follows. Do NOT overload the existing StatusBadge (its API is status-string keyed off PaymentStatus/VisitStatus unions and wouldn't cleanly map product TYPE categories like INDIVIDUAL_TEST/PANEL_BUNDLE which are not "statuses"). Instead introduce a small token-driven primitive, e.g. SemanticBadge with a `tone` prop (success | warning | danger | neutral | info) built on shadcn Badge + cva, where each tone resolves to the CSS tokens already in index.css: success -> bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]; warning -> --warning; danger -> --destructive; neutral -> --muted/--muted-foreground. Add a couple of category tones (info/accent) if needed. Then: (1) map ACTIVE/PAID/FINALIZED -> tone="success", LOCKED/PENDING -> tone="warning", DEPRECATED/INACTIVE -> tone="neutral"/"danger" in ManageClinicalDefinitions, ManageBillableProducts (line 555), PayoutsTable (223/231), PayoutRunCycle (607-609); (2) keep the product/workflow TYPE pills (blue/purple/sky/amber categorical hues in ManageBillableProducts 86-96 and ProductSelector 60-67) as a separate categorical scale, but still funnel them through one shared map/util rather than duplicating per file. This removes the token-bypass (so dark mode + per-branch accents apply) and collapses the ~10 ad-hoc maps into one component for status + one shared map for categories.

### 132. 🟡 status-unpaid token defined but has no CSS class, and StatusBadge maps no UNPAID
**MEDIUM** · error-handling · effort S

- **Files:** `health-hub/src/index.css`, `health-hub/src/components/ui/status-badge.tsx`
- **Problem:** index.css line 57 defines `--status-unpaid: 0 72% 51%` but there is no `.status-unpaid` rule in @layer components (only .status-draft/.status-finalized/.status-pending/.status-paid exist, lines 405-423). status-badge.tsx statusStyles map (lines 9-23) has PAID/PENDING/RESULTS_PENDING/DRAFT/FINALIZED/WAITING/IN_PROGRESS/COMPLETED but no UNPAID entry. If an UNPAID payment status is ever passed, the badge falls through to `statusStyles[status]` = undefined → renders as an unstyled gray pill while the raw token sits unused.
- **Fix:** Either add `.status-unpaid { background-color: hsl(var(--status-unpaid)/0.15); color: hsl(var(--status-unpaid)); }` and an UNPAID entry in statusStyles/statusLabels, or delete the orphan --status-unpaid token if UNPAID is not a real state. Audit all PaymentStatus enum values against the map so no status renders unstyled.

### 133. 🟡 .dark theme is fully defined and scattered through dark: variants but never activated
**MEDIUM** · consistency · effort M

- **Files:** `health-hub/src/index.css`, `health-hub/tailwind.config.ts`, `health-hub/src/pages/owner/OwnerDashboard.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** index.css lines 74-117 define a complete `.dark` token set and tailwind.config.ts line 4 enables `darkMode: ["class"]`, yet there is no ThemeProvider, no theme toggle, and no code that ever adds the `dark` class to the document (grep for classList/documentElement/setTheme manipulation returns nothing). Meanwhile some files sprinkle `dark:` variants (OwnerDashboard.tsx lines 206/213/1037 `dark:border-red-900/60 dark:bg-red-950/40`, ProductSelector.tsx lines 62-66) which can never render. Only 5 of 39 page files have any dark: styling, so even if toggled the app would be broken in dark mode (hundreds of raw `text-gray-900`/`bg-blue-50` have no dark counterpart).
- **Fix:** Decide: if dark mode is not a near-term goal, delete the .dark block, set darkMode off, and strip the scattered dark: variants to remove dead/misleading code. If it is planned, add a ThemeProvider + toggle and convert raw palette colors to tokens first (depends on raw-palette-bypasses-tokens) so dark mode actually works.

### 134. 🟡 No shared PageHeader; page titles use four inconsistent type recipes
**MEDIUM** · visual-hierarchy · effort M

- **Files:** `health-hub/src/pages/owner/PayoutDetail.tsx`, `health-hub/src/pages/owner/OwnerDashboard.tsx`, `health-hub/src/pages/Login.tsx`, `health-hub/src/pages/legal/PrivacyPolicy.tsx`
- **Problem:** Page titles across pages use four different recipes: `text-2xl font-bold` (22 occurrences), `text-3xl font-bold` (8), `text-3xl font-semibold` (6), `text-2xl font-semibold` (1). Examples: PayoutDetail.tsx line 275 `text-2xl font-bold text-gray-900`, OwnerDashboard.tsx line 752 `text-3xl font-semibold tracking-tight`, Login.tsx line 94 `text-3xl font-bold text-gray-900`, legal pages `text-3xl font-bold text-gray-900`. The same hierarchy level renders at different sizes/weights/colors depending on the page, undermining a consistent type scale.
- **Fix:** Create a `<PageHeader title description actions>` component with one canonical title style (e.g. `text-2xl font-semibold tracking-tight text-foreground`, semantic `<h1>`) and adopt it across all pages. This also fixes the title color drift (gray-900 vs foreground) and gives a single slot for description + action buttons.

### 135. 🟡 CardTitle defaults to text-2xl and is overridden in ~23 call sites
**MEDIUM** · consistency · effort S

- **Files:** `health-hub/src/components/ui/card.tsx`
- **Problem:** card.tsx line 19 sets CardTitle to `text-2xl font-semibold leading-none tracking-tight` (the stock shadcn default sized for marketing cards). In a dense dashboard/forms app this is too large, so it is overridden with `text-base/text-lg/text-sm` in ~23 places, meaning the component's default is almost never the intended size and every consumer has to remember to shrink it. text-2xl is also the single most over-large heading in the app.
- **Fix:** Lower the CardTitle default to match the app's actual usage (e.g. `text-base font-semibold leading-none tracking-tight` or text-lg), so most cards need no override and visual rhythm is consistent. Then remove the now-redundant per-card size overrides.

### 136. 🟡 Brand navy/red hardcoded as hex in Login and BranchConfirmModal instead of tokens
**MEDIUM** · branding · effort M

- **Files:** `health-hub/src/pages/Login.tsx`, `health-hub/src/components/layout/BranchConfirmModal.tsx`, `health-hub/src/main.tsx`
- **Problem:** Login.tsx hardcodes the Sobhana brand colors as literal hex in 10+ spots: `bg-[#1B2B58]` (lines 41,47), `text-[#D91C2B]` (lines 76,83), `text-[#1B2B58]` (lines 70,89,104,127), `bg-[#D91C2B] hover:bg-red-700 ... shadow-red-500/30` (lines 120,143,154). BranchConfirmModal.tsx repeats it: `text-[#1B2B58]` (line 90), `bg-[#D91C2B] ... hover:bg-red-700 shadow-red-500/30` (line 140), and a JS fallback `'#1B2B58'` (line 72). main.tsx error screen hardcodes `#1f3e6e`/#64748b/#f1f5f9 (lines 32-56). These duplicate --branch-banner-bg (#1B2B58) and --branch-accent (#D91C2B) defaults; if branding changes, these screens silently drift. The mix `bg-[#D91C2B]` with `hover:bg-red-700` also pairs a custom hex with an unrelated Tailwind red on hover.
- **Fix:** Reference the brand tokens: use the `branch` color keys already in tailwind.config.ts (`bg-branch-banner`, `text-branch-accent`, `bg-branch-accent`) or, for the brand-fixed login, promote SOBHANA navy/red to named tokens (--brand-navy, --brand-red) and use them. Replace `hover:bg-red-700` with a token-derived hover (e.g. `hover:bg-branch-accent/90`).

### 137. 🟡 Per-branch accent foreground is always white with no contrast guarantee
**MEDIUM** · accessibility · effort M

- **Files:** `health-hub/src/lib/branchTheme.ts`, `health-hub/src/index.css`
- **Problem:** branchTheme.ts hardcodes `accentForeground: '#ffffff'` for every branch (lines 27,35,43,52) and .btn-branch-outline / context-banner assume white text on the accent. The JGG purple accent `#8b5cf6` (line 42) and BLN blue `#3b82f6` (line 51) are mid-tone; white text on #8b5cf6 is ~3.1:1 and on #3b82f6 ~3.3:1 — fine for large UI but failing AA for normal-size text. There is no mechanism to validate that an accent + white foreground meets contrast, so adding a future light accent would silently produce unreadable buttons/badges.
- **Fix:** Compute accentForeground per branch from the accent's luminance (return black for light accents, white for dark) instead of always '#ffffff', or constrain accents to a vetted dark-enough range. Add a unit test asserting each branch accent meets >=4.5:1 with its chosen foreground for text and >=3:1 for UI.

### 138. ⚪ Off-scale arbitrary font sizes (text-[9px]/[10px]/[11px]/[15px]) break the type scale
**LOW** · consistency · effort M

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** 50 arbitrary pixel font sizes appear: `text-[10px]` (25x), `text-[11px]` (19x), `text-[9px]` (3x), `text-[15px]` (3x). These sit between Tailwind's scale steps (text-xs=12px, text-sm=14px, text-base=16px) and are applied ad-hoc, so micro-labels render at five different sub-12px sizes across the diagnostics and owner pages. `text-[9px]`/`text-[10px]` are also below the practical legibility floor for dense lab data.
- **Fix:** Replace with scale steps: collapse [9px]/[10px]/[11px] to a single `text-xs` (or add one deliberate `text-2xs` token in tailwind.config fontSize if a sub-12px label is truly needed), and [15px]→`text-sm`/`text-base`. Avoid sub-10px sizes for any data the staff must read at speed.

---

## LENS: Information Architecture & Navigation

_The app has no unified PageHeader/breadcrumb system: every page hand-rolls an h1 (two competing typographic systems: text-2xl font-bold vs an inline 20px font-medium owner style), there is no wayfinding above the page title, and a shadcn Breadcrumb component sits unused. The route table and sidebar have drifted apart — many routes are orphaned (no nav entry), several nav labels disagree with the page titles they lead to, the subContext prop threaded through ~6 pages is silently dropped by AppLayout, and the owner vs staff IA presents the same workflows under wildly different depths and names._

### 139. 🟠 subContext (and context) props are accepted by AppLayout but never rendered — dead wayfinding
**HIGH** · navigation · effort M · verified (high)

- **Files:** `health-hub/src/components/layout/AppLayout.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`, `health-hub/src/pages/owner/PayoutsList.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** AppLayout's signature is `AppLayout({ children, context, subContext, hideContextBanner })` (AppLayout.tsx:14) but the body (lines 22-38) never reads `context` or `subContext` — only `children` and `hideContextBanner`. Yet ~6 pages pass meaningful wayfinding strings expecting them to render, e.g. `subContext="Reception"` (ClinicNewVisit.tsx:548,645; ClinicVisitQueue.tsx:215), `subContext="Global Patient Search"` (GlobalPatientSearch.tsx:88), `subContext="Patient 360"` (Patient360.tsx:411,421,442), `subContext="payouts"` (PayoutsList.tsx:403; PayoutDetail.tsx:232,242,266). All silently discarded. `context` (AppContext) is likewise passed by every page and ignored.
- **Impact:** The intended sub-location label (the only breadcrumb-like signal the design anticipated) never appears, so deep pages give the user no 'where am I' context. It also misleads developers into thinking they've labeled the page when they haven't, and `subContext` values are inconsistent ("Reception" vs "Patient 360" vs lowercase "payouts"), proving it was never visually validated.
- **Fix:** Render it, don't just delete it — these pages genuinely lack wayfinding. Add a lightweight breadcrumb/section header inside AppLayout, immediately below ContextBanner and above the children div (line 33), driven by `context` and `subContext`. Use the existing src/components/ui/breadcrumb.tsx: render Branch name (already in ContextBanner — consider consolidating to avoid duplicating the branch label) › context (map "clinic"/"owner"/etc. to a human label, since raw AppContext enum values aren't user-facing) › subContext, wrapped in `print:hidden`. CRITICAL prerequisite: before shipping, normalize all subContext values to one convention — Title Case user-facing page names ("Payouts" not "payouts"), and reconcile "Reception" (a department) vs "Patient 360"/"Global Patient Search" (page names) so the breadcrumb reads consistently. If product decides per-page h1s already cover this, then fully remove `context`/`subContext` from AppLayoutProps and strip the prop from all 6 call sites so the component API stops lying — but rendering is preferred given the wayfinding gap.

### 140. 🟠 No shared PageHeader/breadcrumb system; shadcn Breadcrumb component exists but is used nowhere
**HIGH** · information-architecture · effort L · verified (high)

- **Files:** `health-hub/src/components/ui/breadcrumb.tsx`, `health-hub/src/components/layout/AppLayout.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** A full shadcn Breadcrumb (Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage) is implemented in breadcrumb.tsx but `grep` finds zero imports/usages across src/pages and src/components/layout. There is no PageHeader primitive in AppLayout, so each page reinvents a `<div><h1/><p/></div>` block and deep pages fall back to ad-hoc `navigate(-1)` arrows (DiagnosticsResultEntry, DiagnosticsReportPreview:627, Patient360:430-451) or hardcoded 'Back to Pending Results'/'Back to Search' buttons with no trail.
- **Impact:** Users on 2nd/3rd-level pages (result entry, report preview, patient 360, payout detail) have no consistent way to see the path back to the parent section; they rely on browser back or a single hardcoded back link that breaks if entered via a different path. Inconsistent back affordances are a wayfinding tax on speed-driven front-desk staff.
- **Fix:** Promote the existing siloed OwnerPageHeader (src/pages/owner/_shared/ownerUi.tsx:372) into a shared layout primitive rather than building a new one from scratch. Concretely:

1. Create src/components/layout/PageHeader.tsx exposing `{ title, subtitle?, breadcrumb?, rightSlot? }`, reusing OwnerPageHeader's markup (h1 + tertiary subtitle + right action slot). Refactor OwnerPageHeader to re-export/wrap it so the three owner pages keep working.

2. Drive an optional breadcrumb from AppLayout's existing `context` + `subContext` props (already passed everywhere, e.g. Patient360 passes context="clinic" subContext="Patient 360"): render breadcrumb.tsx as Home/Section(context) > Page(subContext) for detail routes, with the leaf as BreadcrumbPage (non-link).

3. Replace the bespoke back buttons with breadcrumb links: Patient360.tsx:445-452, DiagnosticsResultEntry.tsx:1146, DiagnosticsReportPreview.tsx:311 and especially :627 (the `navigate(-1)` arrow — replace with an explicit BreadcrumbLink to the parent route so it no longer depends on browser history). Keep "Back to Edit" (DiagnosticsReportPreview:975) since that's an in-flow toggle, not navigation.

4. Wire the detail routes /diagnostics/results/:id, /diagnostics/preview/:id, /clinic/patient-360/:id, /owner/payouts/:id to pass a breadcrumb trail. Effort L is accurate given the refactor of OwnerPageHeader consumers.

### 141. 🟠 Two competing page-title typographies: text-2xl font-bold vs inline 20px font-medium
**HIGH** · consistency · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/_shared/ownerUi.tsx`, `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/owner/AdminConfigCenter.tsx`, `health-hub/src/pages/owner/PayoutDetail.tsx`
- **Problem:** Most pages use `<h1 className="text-2xl font-bold">` (Dashboard.tsx:139, DiagnosticsPendingResults.tsx:282, DiagnosticsFinalizedReports.tsx:195, AdminConfigCenter.tsx:41, ClinicVisitQueue.tsx:218, ClinicNewVisit.tsx:648, DoctorDashboard.tsx:66, etc.). The owner V2 area uses a totally different title style via OwnerPageHeader: `<h1 className="font-medium" style={{ fontSize: 20 }}>` (ownerUi.tsx:384). Owner legacy uses a third: `text-3xl font-semibold tracking-tight` (OwnerDashboard.tsx:752,798). PayoutDetail even mixes within one file: `text-2xl font-bold text-gray-900` (line 275) and `text-xl font-semibold` (line 310).
- **Impact:** Page titles render at three different sizes/weights depending on which area the user is in, so the visual hierarchy resets between sections — the product feels stitched together from two design eras, undermining the 'Sobhana' brand consistency owners see when moving Money → Dashboard → Admin.
- **Fix:** Drop the PayoutDetail.tsx:310 intra-file example (it's a print-only header, not a competing screen title). Standardize ALL on-screen page titles on a single shared PageHeader component exporting one token (recommend `text-2xl font-semibold tracking-tight` to match shadcn heading conventions; `font-bold` is heavier than typical shadcn). Concretely: (a) make OwnerPageHeader in ownerUi.tsx:384 use Tailwind classes and retire the inline `style={{ fontSize: 20 }}`; (b) replace the hand-rolled duplicate `<h1>` at OwnerDashboardV2.tsx:993 with the shared OwnerPageHeader/PageHeader; (c) migrate the legacy OwnerDashboard.tsx text-3xl titles (752, 798) to the same component; (d) sweep the 14+ `text-2xl font-bold` pages onto the shared component so the token lives in exactly one place. This is the only durable fix — leaving three ad-hoc h1 styles in source guarantees future drift.

### 142. 🟠 Nav labels disagree with the page titles they lead to (naming drift)
**HIGH** · microcopy · effort M · verified (high)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/AdminConfigCenter.tsx`
- **Problem:** Sidebar 'Dashboard' (Sidebar.tsx:48) → page h1 says 'Owner overview' (OwnerDashboardV2.tsx:994). Sidebar 'Doctors' (Sidebar.tsx:63) → page h1 says 'Doctors & payouts' (OwnerDoctorsPage.tsx:441). Sidebar 'Admin' (Sidebar.tsx:112,164) and staff sub-item 'Config Center' (line 169) → page h1 says 'Admin Config Center' (AdminConfigCenter.tsx:41). Owner sub-item 'New diagnostic visit' (line 82, lowercase) vs staff sub-item 'New Visit' (line 140, Title Case) vs page h1 'New Diagnostic Visit' — three spellings for one destination.
- **Impact:** When the active nav item and the page title use different words, users (especially owners switching contexts) momentarily distrust they landed in the right place. The 'Doctors' → 'Doctors & payouts' mismatch is especially confusing because Payouts is also a separate nav item (Sidebar.tsx:107).
- **Fix:** Centralize the human-readable name per route so the sidebar label, breadcrumb, and page h1 all read from one source — e.g. a routeMeta map keyed by href ({ '/diagnostics/new': { title: 'New Diagnostic Visit' } }) consumed by both the owner/staff nav arrays and each page's <PageHeader>/h1. This eliminates the dual-array divergence where owner and staff describe the same href with different casing ('New diagnostic visit' vs 'New Visit'). Adopt one casing convention (Title Case for nav labels and titles). Specifically: rename Sidebar.tsx:82 -> 'New Visit', :74 'Live queue' -> 'Live Queue', :96 already-fine; set OwnerDashboardV2.tsx:994 h1 to 'Dashboard' (or rename nav to 'Overview'); set OwnerDoctorsPage.tsx:441 title to 'Doctors' (drop '& payouts' since Payouts is its own nav item at Sidebar.tsx:106). For the 'Admin' parent that links to the same /owner/config as its 'Config Center' child, either make the parent non-clickable or rename the child to avoid the parent/child label collision.

### 143. 🟠 Owner and staff see the same workflows at radically different depths and labels
**HIGH** · information-architecture · effort L · verified (high)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** ownerNavItems and staffNavItems (Sidebar.tsx:46-173) are entirely separate trees with overlapping destinations placed differently. Patient 360 is a TOP-LEVEL item for staff (line 128) but for owners it is buried two levels deep under Operations › Workflows (lines 77-81). The diagnostics workflow is a clean 'Diagnostics' group for staff (lines 135-152: New Visit / Pending Results / Finalized Reports) but for owners those same routes are dumped flat inside the 'Operations' dropdown alongside ops items (lines 82-96). Owners get a 'My Reports' item pointing at /doctor (line 100-104, the doctor dashboard) which staff never see, despite the same route existing.
- **Impact:** An owner doing day-to-day operations must hunt for Patient 360 and diagnostic visit entry in a deep dropdown, while staff reach them in one click — the role with the LEAST hands-on time has the worst access to operational tasks. Two divergent IAs for one product also double the maintenance and onboarding cost.
- **Fix:** Define ONE nav tree as the single source of truth and derive each role's view by filtering on per-item/per-subItem `roles` (the NavItem/NavSubItem interfaces at lines 27-44 already carry a `roles` field, so the filter at lines 187-189 and 212-214 just needs to consume a unified array instead of branching on ownerNavItems vs staffNavItems). Concretely: keep top-level Diagnostics and Clinic groups for BOTH roles with identical labels (pick one casing, e.g. 'New Visit', 'Pending Results', 'Finalized Reports', 'OP / IP Queue'); make Patient 360 top-level for both; keep an owner-only Operations group containing ONLY genuine ops items (Live queue, Audit & alerts); and gate Money/Doctors/Payouts/Admin items with roles:['owner']. This removes the duplicate label drift and gives the owner one-click access to the operational tasks they actually perform, while collapsing two IAs into one.

### 144. 🟡 OwnerDashboardV2 re-implements OwnerPageHeader inline instead of reusing the shared component
**MEDIUM** · redundancy · effort S

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/_shared/ownerUi.tsx`
- **Problem:** OwnerPageHeader (ownerUi.tsx:372-394) is the canonical owner header and is used by OwnerMoneyPage:520, OwnerOperationsPage:570, OwnerDoctorsPage:440. But OwnerDashboardV2.tsx:991-1024 hand-copies the exact same markup — `<div className="mb-4 flex flex-wrap items-end justify-between gap-3">`, `<h1 className="font-medium" style={{ fontSize: 20 }}>`, the `TOKENS.textTertiary fontSize:12` subtitle, and even a copy of RefreshButton (lines 1010-1024 vs ownerUi RefreshButton:396+) — rather than calling `<OwnerPageHeader>`.
- **Impact:** The owner area's primary page diverges from its own header component; any future header change must be made in two places, guaranteeing drift. It also means the 'Owner overview' title style is locked in by copy-paste rather than a single source of truth.
- **Fix:** Replace lines 991-1024 of OwnerDashboardV2 with `<OwnerPageHeader title="Owner overview" subtitle={...} rightSlot={<><BranchFilter/><RefreshButton.../></>} />`, reusing the shared RefreshButton.

### 145. 🟡 Many real routes have no sidebar entry (orphans) — only reachable via deep links
**MEDIUM** · navigation · effort M

- **Files:** `health-hub/src/App.tsx`, `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** Mapping App.tsx routes against Sidebar.tsx nav: detail routes /diagnostics/results/:visitId (App.tsx:116), /diagnostics/preview/:visitId (121), /clinic/patient-360/:patientId (141), /owner/payouts/:id (218), /people/doctors/:id (185), and whole pages like /owner/legacy (160), /money/cash (170), /money/discounts (175), /ops/pending (195) have no nav entry. /owner/legacy (the old OwnerDashboard) is fully reachable yet invisible. The staff 'OP / IP Queue' destination /clinic/queue is present, but /clinic/patient-search appears for staff yet has no owner-equivalent top-level entry.
- **Impact:** Detail pages are expected (linked from lists), but a live but unlinked /owner/legacy is dead weight that can confuse via stale bookmarks. /money/cash and /money/discounts being separate routes that all render OwnerMoneyPage (App.tsx:165-179) but have no distinct nav implies intended sub-nav that was never built — owners can't deep-link to the Cash or Discounts view from the sidebar.
- **Fix:** Audit the route table: delete or feature-flag /owner/legacy; either add Money sub-nav (Bills/Cash/Discounts) so those routes are reachable, or collapse them to query params on one route. Document detail routes as intentionally nav-less.

### 146. 🟡 /money/bills, /money/cash, /money/discounts all render OwnerMoneyPage but the URL implies distinct sub-pages
**MEDIUM** · information-architecture · effort M

- **Files:** `health-hub/src/App.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`
- **Problem:** App.tsx:165-179 maps three different paths to the identical component with no params distinguishing them: `/money/bills`, `/money/cash`, `/money/discounts` all → `<OwnerMoneyPage />`. The page header simply says 'Money' (OwnerMoneyPage.tsx:521) regardless of which of the three URLs the user is on, and the sidebar 'Money' item only links to /money/bills (Sidebar.tsx:57) with matchPrefix '/money/'. Same pattern for /ops/queue, /ops/pending, /ops/audit → OwnerOperationsPage and /people/doctors(/:id) → OwnerDoctorsPage.
- **Impact:** The URL promises three sub-views (cash vs discounts vs bills) but delivers one undifferentiated page, so a bookmarked /money/discounts shows the same screen as /money/bills with no indication. This is broken wayfinding: the address bar is the user's location signal and it's lying.
- **Fix:** Either make these tabs within one route (e.g. /money?tab=cash, like AdminConfigCenter does) so there's one honest URL, or have OwnerMoneyPage read the path segment and switch its active tab + title accordingly. Don't keep distinct paths that render an identical, unaware page.

### 147. 🟡 'Operations' parent nav is a non-clickable label even though /ops/queue is a real landing route
**MEDIUM** · navigation · effort M

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** In Sidebar.tsx the render logic only emits a `<Link>` for items with zero visible subItems (lines 218-233); items WITH subItems render a non-interactive `<div>` group header (lines 236-247). The owner 'Operations' item has `href: '/ops/queue'` (line 72) — a real route (App.tsx:190) — but because it has subItems it becomes an unclickable `<div>`. Same for staff 'Diagnostics'/'Clinic'/'Admin' groups whose hrefs (/diagnostics, /clinic — not even real routes) are dead.
- **Impact:** Owners cannot click 'Operations' to reach its primary landing screen; they must expand and pick 'Live queue'. Users habitually click the section name to go to its overview — here that does nothing, which reads as a broken nav. The staff group hrefs /diagnostics and /clinic point at non-existent routes (no matching Route in App.tsx), so the `key`/active logic is computed on phantom paths.
- **Fix:** Render parent items that have a valid own-route as a clickable Link that also toggles/expands subItems (or a Link + chevron). For group-only labels (no landing page), drop the meaningless href and don't compute isItemActive on a non-route.

### 148. 🟡 Page h1 merely restates the nav label while the only context (ContextBanner) shows just 'Branch:'
**MEDIUM** · redundancy · effort M

- **Files:** `health-hub/src/components/layout/ContextBanner.tsx`, `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`
- **Problem:** Above the content, ContextBanner.tsx:14-16 renders only 'Branch: <name>' + a BranchSelector — no section/page context. Then each page's h1 just repeats the active nav word: 'Dashboard' (Dashboard.tsx:139), 'Pending Results' (DiagnosticsPendingResults.tsx:282), 'Visit Queue' (ClinicVisitQueue.tsx:218), 'Finalized Reports', etc. So the screen shows the page name twice in spirit (highlighted nav item + h1) yet never shows the trail Diagnostics › Pending Results.
- **Impact:** Vertical space at the top is spent on a redundant h1 that echoes the already-highlighted sidebar item, while the genuinely useful hierarchical context (which section this sub-page lives in) is absent. For owners whose workflows are nested deep, this is the difference between knowing and not knowing where they are.
- **Fix:** Replace the bare h1 with a breadcrumb-bearing PageHeader (Section › Page) so the title earns its space, and let ContextBanner focus solely on branch scope. Avoid having both the nav highlight and a plain h1 say the same single word with no added context.

### 149. ⚪ Owner nav reuses the same icons for different items (Money & Payouts share WalletCards; Doctors & My Reports share UserRound)
**LOW** · visual-hierarchy · effort S

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** In ownerNavItems: 'Money' uses icon WalletCards (Sidebar.tsx:56) and 'Payouts' ALSO uses WalletCards (line 108). 'Doctors' uses UserRound (line 63) and 'My Reports' ALSO uses UserRound (line 102). So two pairs of distinct top-level destinations are visually identical at a glance.
- **Impact:** Icons exist to give scannable, pre-attentive distinction in the sidebar. Two items sharing an icon defeats that — an owner scanning for Payouts vs Money, or My Reports vs Doctors, can't rely on the glyph and must read the label, slowing navigation.
- **Fix:** Give each top-level item a unique icon: e.g. Payouts → HandCoins/Receipt, My Reports → FileText/ClipboardList, keeping WalletCards for Money and UserRound for Doctors. Audit the lucide import set (Sidebar.tsx:4-16) for one-icon-per-destination.

### 150. ⚪ Legal/public pages render with no app shell and are unreachable from any in-app nav or footer
**LOW** · navigation · effort S

- **Files:** `health-hub/src/App.tsx`, `health-hub/src/pages/legal/PrivacyPolicy.tsx`, `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** /privacy, /terms, /data-deletion (App.tsx:228-230) render bare pages (PrivacyPolicy.tsx wraps content in a plain `<div className="min-h-screen bg-white">` with its own `text-3xl font-bold text-gray-900` h1 — yet another title style) with no AppLayout, no sidebar, no link back into the app. No nav item, footer, or login-screen link points to them (grep finds no in-app references), so an authenticated user who lands there has no way back except browser controls.
- **Impact:** These compliance pages are required to be discoverable (privacy/data-deletion especially for the Indian WhatsApp-consent flow), but they are functionally orphaned and stylistically inconsistent (gray-900 hardcoded colors, different h1 scale) from the branded app.
- **Fix:** Add footer links (Privacy / Terms / Data deletion) on the Login page and/or a minimal footer, and give the legal pages a shared lightweight public layout with a 'Back to Sobhana' link and brand-consistent typography tokens instead of hardcoded gray-900.

---

## LENS: Microcopy & Terminology

_The product has no enforced vocabulary or capitalization rule: the same diagnostic-line concept is called Test, Product, Item, and Panel — sometimes within one card — and the same money values get three different labels across the form, confirm dialog, and success screen. Navigation labels flip between Title Case and Sentence case by role, and several errors/placeholders are vague or terse to the point of blaming the user._

### 151. 🔴 Same concept called Test / Product / Item / Panel across one flow
**CRITICAL** · microcopy · effort M · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`
- **Problem:** The single concept a front-desk operator adds to a bill is referred to by four different nouns in the New Diagnostic Visit flow. The card header is `<CardTitle>Select Tests</CardTitle>` (DiagnosticsNewVisit.tsx:1654) and the validation error is `toast.error("Please select at least one test")` (line 651), but the selector that fills it has placeholder `"Type to search products (e.g., CBP, LFT, Thyroid)..."` (ProductSelector.tsx:103) and empty state `"Start typing to search and add tests, panels, or bill-only items."` (ProductSelector.tsx:438) — three nouns in one sentence. The quick-add dialog then switches to a fourth: `<DialogTitle>Quick Add Bill-Only Item</DialogTitle>` (line 2512) with button `Add Item` (line 2579) and toast `Added bill-only product ${product.name}` (line 447). The confirm dialog labels the count `Tests` (line 2454).
- **Impact:** Staff register dozens of bills per shift; an operator told to 'select a test' sees a box about 'products', a button to 'Add Item', and a toast confirming a 'product' was added. The wobble makes the core, highest-frequency task feel inconsistent and untrustworthy, and makes training/SOPs harder to write.
- **Fix:** Standardize on "test" as the patient/staff-facing umbrella noun for the diagnostics flow; keep "product"/"billable_product" confined to code, API payloads, and the owner Config Center where the catalog is managed. Concrete edits: (1) Keep DiagnosticsNewVisit.tsx:1654 "Select Tests" and :651 "Please select at least one test" and :2454 count label "Tests" — these are already correct and become the anchor. (2) ProductSelector.tsx:103 default placeholder -> "Search tests, panels or charges (e.g. CBP, LFT, Thyroid)..."; :438 empty state -> "Start typing to search and add tests, panels or charges." (collapse "bill-only items" into the single word "charges"). (3) For the quick-add path, do NOT relabel it to "test" — it specifically creates a bill-only, non-catalog line, and that distinction is operationally real. Instead make it consistent under the "charge" vocabulary: :2512 DialogTitle -> "Quick Add Charge"; :2579 button -> "Add" (loading "Adding..."); :447 toast -> `Added ${product.name}` (drop the implementation word "product" entirely). Net result: every user-facing string uses only "test", "panel", or "charge", and the word "product"/"item" never appears in staff UI.

### 152. 🟠 Bill totals get different labels on form vs confirm dialog vs success screen
**HIGH** · consistency · effort S · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The same three money values are relabeled at each step of one transaction. The billing form uses `Total bill` (line 2150), `Final total` (line 2254) and `Due balance` (line 2261). The confirm dialog for the very next click uses `Total` (line 2458), `Net payable` (line 2468) and `Due` (line 2479). The success screen uses yet a third set: `Final Total` (line 1104, Title Case this time) and `Due:` (line 1113). 'Final total', 'Net payable' and 'Final Total' are three names for the identical number.
- **Impact:** An operator collecting cash reconciles a 'Final total' on the form against a 'Net payable' in the confirm modal against a 'Final Total' on the receipt — three labels for the amount they must charge. In a money flow this erodes confidence and invites collection errors.
- **Fix:** Adopt a single canonical money vocabulary and use it verbatim on all three surfaces. Recommended set, matching the confirm dialog (which is already the most coherent): "Total" (gross, = totalAmount), "Discount", "Net payable" (amount due, = netPayable), "Paid", "Balance due" (= dueAmount). Concretely: rename "Total bill" (2150) -> "Total"; "Final total" (2254) and "Final Total:" (1104) -> "Net payable"; "Due balance" (2261), "Due" (2479) and "Due:" (1113) -> "Balance due"; and "Received" (2228) -> "Paid". Note the dialog also says "Net payable" while the form/receipt say variants of "Final Total" — pick one term; "Net payable" is the clearer accounting term and is what the input's placeholder math implies (max={netPayable}). Best implemented by extracting these label strings into a shared constants object (e.g. MONEY_LABELS) imported by both the page and the dialog so the three surfaces cannot drift again. Effort S is correct.

### 153. 🟠 Nav labels are Sentence case for owners but Title Case for staff
**HIGH** · consistency · effort S · verified (high)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`
- **Problem:** The two nav arrays use opposite capitalization conventions for the identical items. Owner nav: `'New diagnostic visit'`, `'Pending results'`, `'Finalized reports'`, `'Live queue'`, `'Audit & alerts'`, `'New clinic visit'`, `'OP / IP queue'` (Sidebar.tsx:74-96, Sentence case). Staff nav for the same routes: `'New Visit'`, `'Pending Results'`, `'Finalized Reports'`, `'OP / IP Queue'`, `'Config Center'` (Sidebar.tsx:140-169, Title Case). So `/diagnostics/pending` is 'Pending results' for an owner and 'Pending Results' for staff.
- **Impact:** Owners who also do front-desk work (common in a 3-role lab) see the same destination spelled two ways depending on which dashboard they are in. It looks like two different products bolted together and signals a lack of design system.
- **Fix:** Adopt Sentence case for ALL nav and section labels project-wide (the owner sub-array already mostly follows this). Concretely, fix the staff sub-items in Sidebar.tsx to match the casing of their owner counterparts: 'Pending Results' -> 'Pending results' (L143), 'Finalized Reports' -> 'Finalized reports' (L147), 'OP / IP Queue' -> 'OP / IP queue' (L160), 'Config Center' -> 'Config center' (L169). Leave the staff 'New Visit' (L140, L159) wording alone OR align it to the owner phrasing only if you also want wording parity — but at minimum re-case to 'New visit'; do not blindly rename to 'New diagnostic visit' since the staff Diagnostics/Clinic parent group already scopes it. Also sweep the top-level labels so the rule is truly system-wide: 'My Reports' (L100) -> 'My reports'. Keep brand/proper nouns capitalized ('Patient 360', 'SOBHANA'). Document the convention (Sentence case for nav/headings/section labels; Title Case only for proper nouns and brand) in the design-token / component guidelines so future entries stay consistent. Effort S is correct.

### 154. 🟠 Field labeled 'Diagnostic Referral' but every placeholder/error calls it a 'center'
**HIGH** · microcopy · effort S · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The billing field `<Label>Diagnostic Referral (optional)</Label>` (line 1778) is backed by a control whose placeholder is `"Search diagnostic center (Enter to skip)"` (line 1823), searchPlaceholder `"Search by center name, phone or number"` (line 1824), emptyText `"No diagnostic centers found."` (line 1825), and ariaLabel `"Diagnostic referral center..."` (line 1826). The quick-add dialog is `Add Diagnostic Center` (line 2632). Meanwhile the sibling field one block up is labeled `Referral Doctor (optional)` (line 1716) — noun-first — so the two parallel fields don't even share a naming pattern ('Referral Doctor' vs 'Diagnostic Referral').
- **Impact:** Staff cannot tell whether 'Diagnostic Referral' wants a referring center, a referral type, or something else; the label and its own placeholder disagree. The asymmetry with 'Referral Doctor' makes the pair look unrelated when they are the two referral-source fields.
- **Fix:** Rename line 1778 label to "Referral Center (optional)" so it matches its own placeholder/empty-state/dialog (all already say "center"), and keep the sibling at "Referral Doctor (optional)" for a parallel "Referral {X}" pair. This is the minimal change. Also tidy the ariaLabel at 1826 from "Diagnostic referral center" to "Referral center — Enter to skip, Space to open" to mirror the doctor field's ariaLabel pattern (1752). Note the underlying state/ids (selectedCenterId, id="diagnostic-center") are internal and need not change.

### 155. 🟡 Flow mixes Visit and Bill as if interchangeable
**MEDIUM** · microcopy · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The page title is `New Diagnostic Visit` (line 1255) and the final CTA is `Review & Generate Bill` (line 2424); the confirm dialog is titled `Confirm Bill` (line 2442) with action `Generate Bill` (line 2499), but the resulting success toast is `Visit created successfully!` (line 1027) and heading `Visit Created Successfully!` (line 1083) — while the same panel then shows `Bill #:` (line 1088). So the user clicks 'Generate Bill', confirms a 'Bill', and is told a 'Visit' was created. The 'Create Another Visit' button (line 1210) reinforces 'visit', but the success metric they see is a bill number.
- **Impact:** Two domain concepts (the visit/encounter vs the bill/receipt) are used interchangeably, so staff can't form a clear mental model of what the button produced — did it create a visit, a bill, or both? This matters when they later search 'pending results' (visit) vs reprint a 'bill'.
- **Fix:** Decide the user-facing primary object for this screen. Since it produces both, make the relationship explicit: keep 'New Diagnostic Visit' as the page, but make the CTA and success consistent — e.g. CTA 'Generate bill', success 'Visit registered — Bill #D-12345 generated'. Avoid switching the headline noun between the button ('Bill') and the result ('Visit').

### 156. 🟡 Terse imperative validation toasts ('Pick a doctor', 'Enter a valid...')
**MEDIUM** · microcopy · effort M

- **Files:** `health-hub/src/pages/owner/DerivePayoutDialog.tsx`, `health-hub/src/pages/owner/PayoutRunCycle.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** Validation messages range from curt commands to user-blaming phrasing with no consistent tone. Examples: `toast.error("Pick a doctor")` and `toast.error("Pick a date range")` (DerivePayoutDialog.tsx:85,89), `toast.error("Pick at least one doctor type")` (PayoutRunCycle.tsx:138), `toast.error("Enter a valid collection amount")` (DiagnosticsPendingResults.tsx:215), versus the wordier `toast.error("Please fill in all patient details")` and `toast.error("Please fix validation errors before submitting")` (DiagnosticsNewVisit.tsx:643,639). 'Please fix validation errors' exposes internal jargon ('validation errors') to the user.
- **Impact:** Inconsistent tone (clipped 'Pick a doctor' next to 'Please fix validation errors') reads as unpolished, and 'fix validation errors' / 'fill in all patient details' tells the user they did something wrong without saying which field. Owners and staff lose time hunting for the offending field.
- **Fix:** Adopt one error voice: state what's needed, name the field, no blame. e.g. 'Select a doctor to continue', 'Choose a date range', 'Select at least one doctor type', 'Enter the amount collected'. Replace 'Please fix validation errors before submitting' with field-specific guidance (the page already tracks per-field errors) or 'Check the highlighted fields'. Never surface the word 'validation' to users.

### 157. 🟡 Placeholders are vague, cryptic, or inconsistently formatted
**MEDIUM** · microcopy · effort M

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx`
- **Problem:** Placeholder style is all over the map. Cryptic/unexplained: Bill Number field placeholder is `"D-XXXXX"` (DiagnosticsNewVisit.tsx:1309) with no hint it's optional bill search. Search placeholders for near-identical search bars differ: `"Phone / Bill Number"` (DiagnosticsPendingResults.tsx:311) vs `"Phone / Name / Bill Number"` (DiagnosticsFinalizedReports.tsx:222). Example prefix is inconsistent: 'e.g.' (ManageDiagnosticCenters.tsx:320 `"e.g. City Diagnostics Lab"`), 'e.g.,' with comma (ManageClinicDoctors / ManageDoctorsAndReferrals `"e.g., MBBS, MD"`), 'Example:' (DiagnosticsNewVisit.tsx:2521 `"Example: ECG Review / Dressing / External Charge"`). Some placeholders restate the label instead of giving an example: `placeholder="Phone number"` (lines 2607,2650), `placeholder="Center name"` (line 2641), `placeholder="Full name"` (line 1484).
- **Impact:** Restated-label placeholders ('Phone number' under a 'Phone' label) add zero information and vanish on focus, while cryptic ones ('D-XXXXX') don't tell the user what to type. The mixed 'e.g.' / 'e.g.,' / 'Example:' looks careless across forms an owner configures daily.
- **Fix:** Standardize: (1) use placeholders only for format hints/examples, never to repeat the label; (2) pick one example prefix — recommend 'e.g. ' (no comma) — and apply everywhere; (3) make the bill-search placeholder explanatory, e.g. 'Search by phone, name or bill no.'; align the Pending and Finalized search bars to identical text. Replace 'D-XXXXX' with 'Bill no. (e.g. D-10234)'.

### 158. 🟡 No capitalization rule for buttons, card titles, and dialog titles
**MEDIUM** · consistency · effort M

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** Buttons and titles mix Title Case and Sentence case with no rule. Title Case: `Create New Patient` (DiagnosticsNewVisit.tsx:1424), `Review & Generate Bill` (2424), `Generate Bill` (2499), `Add Doctor` (2622), `View Patient 360` (GlobalPatientSearch.tsx:238), card titles `Patient Lookup`, `Select Tests`, `New Patient`. Sentence/other: button `Clear` (2764), `Back` (2492), `Cancel` (2568), and the form money labels are Sentence case ('Total bill', 'Due balance'). The login flow even disagrees with itself: toast `'Welcome back'` (Login.tsx:27) vs heading `Welcome Back` (Login.tsx:94).
- **Impact:** Within a single card the user sees Title Case actions ('Generate Bill') beside Sentence case labels ('Due balance'), which reads as visually noisy and unsystematic. The 'Welcome back' vs 'Welcome Back' mismatch on the very first screen sets a sloppy first impression.
- **Fix:** Adopt Sentence case for all UI strings except brand and proper nouns (industry-standard; matches owner nav and money labels already). Convert buttons/titles: 'Create new patient', 'Review & generate bill', 'Generate bill', 'Add doctor', 'View Patient 360' (proper noun kept), card titles 'Patient lookup', 'Select tests', 'New patient'. Align the login heading to 'Welcome back'.

### 159. 🟡 Same feature is both 'Global Patient Search' and 'Patient 360' in the nav and page
**MEDIUM** · information-architecture · effort S

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/clinic/Patient360.tsx`
- **Problem:** The nav item that opens the search screen is labeled `'Patient 360'` (Sidebar.tsx:77,128, route `/clinic/patient-search`), but the page it lands on is titled `<h1>Global Patient Search</h1>` (GlobalPatientSearch.tsx:92) and its layout subContext is `"Global Patient Search"` (line 88). The detail page is the actual 'Patient 360' (Patient360.tsx). So clicking 'Patient 360' shows a page called 'Global Patient Search', and only after clicking a result's 'View Patient 360' button (GlobalPatientSearch.tsx:238) do you reach the real Patient 360.
- **Impact:** Wayfinding breaks: the nav promises 'Patient 360' but delivers a search screen with a different name, so users can't tell if they are in the right place. Two names for what users perceive as one feature ('look up a patient').
- **Fix:** Separate the two concepts in copy. Either rename the nav item to 'Patient search' (since it lands on the search page) and keep 'Patient 360' only for the per-patient detail view, OR keep the nav as 'Patient 360' and rename the search page heading/subContext to 'Patient 360 — search' for continuity. Recommend the former: nav 'Patient search', page heading 'Patient search', detail page 'Patient 360'.

### 160. ⚪ Results meta-strip uses ALL-CAPS literals as content
**LOW** · microcopy · effort S

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** The results header renders hardcoded all-caps words as text rather than styled labels: `<span>SEARCH RESULTS</span> • <span>GLOBAL</span> • <span>READ-ONLY</span>` (GlobalPatientSearch.tsx:145-149), and the history block heading is `HISTORY SNAPSHOT` (line 202). These are literal uppercase strings, not CSS `uppercase`, so they read as shouting and are not screen-reader-friendly (read letter context as written).
- **Impact:** Reads as shouting and is internal-jargon-flavored ('GLOBAL', 'READ-ONLY' as standalone words). Inconsistent with the rest of the app's Sentence case microcopy.
- **Fix:** Write the strings in Sentence case and apply visual emphasis via Tailwind (`uppercase tracking-wide text-xs` / `font-medium`) if a caps look is desired. e.g. 'Search results · Global · Read-only' and 'History snapshot'. This keeps the visual treatment in CSS and the readable text in the DOM.

### 161. ⚪ Owner config area is called Admin, Config Center, and Config interchangeably
**LOW** · microcopy · effort S

- **Files:** `health-hub/src/components/layout/Sidebar.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The same configuration area (route `/owner/config`) is labeled `'Admin'` as the owner/staff nav group (Sidebar.tsx:112,164), `'Config Center'` as a sub-item (Sidebar.tsx:169), and is referenced in-flow as 'Config Center' in helper text: `"Saved defaults come from Config Center."` (DiagnosticsNewVisit.tsx:1859,2007) and `"Config Center: ..."` (lines 1893,2041).
- **Impact:** Staff reading 'Saved defaults come from Config Center' won't find a 'Config Center' in their nav — they see 'Admin'. Minor wayfinding friction when an operator wants to change a saved payout default.
- **Fix:** Pick one name for the destination and use it in both the nav and the references to it. Recommend 'Config Center' everywhere (it's the more descriptive, already-used-in-helper-text name): rename the nav group/sub-item to 'Config Center' so the in-flow hint points to a label users can actually see.

### 162. ⚪ WhatsApp opt-in label word order flips between new and existing patient
**LOW** · consistency · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The identical opt-in checkbox is worded two ways. New-patient form: `Send reports & bill confirmations via WhatsApp` (DiagnosticsNewVisit.tsx:1643). Existing-patient billing block: `Send bill confirmation & reports via WhatsApp` (line 2412). The two differ in order ('reports & bill confirmations' vs 'bill confirmation & reports') and number ('confirmations' vs 'confirmation').
- **Impact:** Trivial individually, but it is the same control with two strings, signalling copy is written ad hoc per location rather than from a shared source — the root cause behind most findings in this audit.
- **Fix:** Use one canonical string for the WhatsApp opt-in everywhere (extract to a shared constant): 'Send bill confirmation and reports via WhatsApp'. Audit other duplicated controls (Add Doctor / Add Center dialogs) for the same single-source treatment.

---

## LENS: Accessibility

_The app has pockets of strong a11y work (the DiagnosticsNewVisit patient listbox, searchable-select combobox, and Login form are properly labeled and keyboard-driven), but it is undermined by systemic gaps: dozens of icon-only edit/delete buttons with no accessible name, ~136 form Labels not associated with their controls, several branch accent colors that fail WCAG contrast as text and as button hover fills, status/flag badges whose color is the primary signal at sub-3:1 contrast, and a sidebar whose keyboard focus indicator is missing. These create real barriers for screen-reader and keyboard users in a clinical app handling money and lab results._

### 163. 🔴 Edit/Delete icon-only buttons across all Manage* pages have no accessible name
**CRITICAL** · accessibility · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/ManageDoctors.tsx:414`, `health-hub/src/pages/owner/ManageDoctors.tsx:417`, `health-hub/src/pages/owner/ManageClinicDoctors.tsx:438`, `health-hub/src/pages/owner/ManageClinicDoctors.tsx:441`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx:295`, `health-hub/src/pages/owner/ManageDiagnosticCenters.tsx:298`, `health-hub/src/pages/owner/ManageDepartments.tsx:356`, `health-hub/src/pages/owner/ManageDepartments.tsx:359`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx:781`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx:784`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx:958`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx:961`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx:989`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx:990`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx:1186`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx:1187`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx:1506`, `health-hub/src/pages/owner/ManageDoctorsAndReferrals.tsx:1507`
- **Problem:** Dozens of action buttons render only a lucide icon and no text or aria-label, e.g. ManageDoctorsAndReferrals.tsx:989 `<Button variant="ghost" size="icon" onClick={() => handleRefEdit(doc)}><Pencil className="h-4 w-4" /></Button>` and :990 `<Button ... onClick={() => setRefDeleteId(doc.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>`. The same uncaptioned Pencil/Trash2 pair repeats in ManageDoctors, ManageClinicDoctors, ManageDiagnosticCenters, ManageDepartments and ManageSigningDoctors. A screen reader announces these only as 'button' with no indication of which row they edit or that they delete a record.
- **Impact:** Screen-reader users (and voice-control users who target controls by name) cannot tell Edit from Delete, in tables of doctors/centers where Delete is destructive and irreversible. This is a hard WCAG 4.1.2 (Name, Role, Value) failure on a primary owner workflow.
- **Fix:** Add an accessible name to every icon-only button that includes the row entity so AT/voice-control users can target the right row, e.g. `<Button size="icon" aria-label={`Edit ${doctor.name}`}>` and `aria-label={`Delete ${doctor.name}`}` (use the appropriate field: doc.name / center.name / dept.name / li.name). For the payout buttons, upgrade the existing `title="View payouts"` to a matching `aria-label={`View payouts for ${doc.name}`}` so naming is uniform (title alone gives a name but is unreliable on touch and is being used inconsistently with aria-label elsewhere). Prevent regression with a small wrapper, e.g. `function IconButton({ label, children, ...props }: { label: string } & ButtonProps)` that spreads `aria-label={label}` onto shadcn Button and makes `label` required, then replace the raw `<Button size="icon">` instances in all six Manage* pages with it.

### 164. 🔴 ~136 form Labels lack htmlFor, so they are not programmatically tied to their inputs
**CRITICAL** · accessibility · effort L · verified (high)

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx:604`, `health-hub/src/pages/owner/ManageBillableProducts.tsx:608`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx:1445`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx:2326`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx:453`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx:465`, `health-hub/src/pages/owner/PayoutsList.tsx:466`, `health-hub/src/pages/owner/ManageSigningDoctors.tsx:1211`, `health-hub/src/components/patient360/PatientEditDialog.tsx:223`
- **Problem:** Of 206 `<Label>` usages, only 70 pass `htmlFor`; ~136 do not, and the adjacent inputs have no matching `id`. e.g. ManageBillableProducts.tsx:604-605 `<Label>Name *</Label><Input value={formName} ...>` (no htmlFor, no id) and DiagnosticsNewVisit.tsx:1445 `<Label>Title</Label>` over a Select. Because shadcn `Label` is a plain `LabelPrimitive.Root` (label.tsx:13), with no htmlFor/id pair there is no accessibility association.
- **Impact:** Screen readers do not announce the field name when the input is focused (WCAG 1.3.1 / 4.1.2), and clicking the label text does not focus/activate the control — friction for everyone, especially on the money and patient-registration forms with required fields.
- **Fix:** Give each input a stable id and point the Label at it, e.g. `<Label htmlFor="product-name">Name *</Label><Input id="product-name" ...>`. For Select/RadioGroup, associate via aria-labelledby on the trigger referencing the Label's id, or wrap each field group with FormField (shadcn form) which wires id/aria automatically.

### 165. 🟠 Icon buttons using title= as their only label are not reliably announced
**HIGH** · accessibility · effort S · verified (high)

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx:561`, `health-hub/src/pages/owner/ManageBillableProducts.tsx:564`, `health-hub/src/pages/owner/ManageBillableProducts.tsx:567`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx:845`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx:852`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx:911`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx:917`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx:273`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx:282`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx:301`
- **Problem:** A second cluster of icon-only buttons relies on the HTML `title` attribute as the accessible name, e.g. ManageBillableProducts.tsx:561 `<Button ... title="Edit" className="h-7 w-7 p-0"><Pencil/></Button>` and DiagnosticsFinalizedReports.tsx:273/282 `size="icon" ... title="View Report"` / `title="Print"`. `title` is inconsistently exposed by screen readers, never shown to keyboard-only users on focus, and unavailable on touch — so it is not a reliable accessible name.
- **Impact:** Keyboard and touch users get no label at all; some screen readers ignore title when the button has no text. The View/Print/Send-WhatsApp report actions and product Edit/Delete are effectively unlabeled.
- **Fix:** Add an explicit aria-label to every icon-only button (it becomes the computed accessible name and is independent of title's flakiness). Keep title only if you want a hover tooltip, or better, wrap in the shadcn Tooltip primitive which is keyboard/SR-accessible. Because these sit in data-table rows, make labels self-describing per action: aria-label="Edit product", "Branch pricing", "Delete product" (ManageBillableProducts); aria-label="New version", "Delete definition" (ManageClinicalDefinitions); aria-label="Edit panel", "Delete panel" (ManagePanelDefinitions); aria-label="View report", "Print report", "Send report via WhatsApp" (DiagnosticsFinalizedReports). Leave the two already-text-labeled buttons (Impact, Preview) as-is. This is an S-effort change (add one attribute per button).

### 166. 🟠 Branch accent used as text color fails WCAG contrast for Teal/Blue/Purple branches
**HIGH** · accessibility · effort M · verified (high)

- **Files:** `health-hub/src/lib/branchTheme.ts:31`, `health-hub/src/lib/branchTheme.ts:39`, `health-hub/src/lib/branchTheme.ts:47`, `health-hub/src/pages/Dashboard.tsx:294`, `health-hub/src/pages/Dashboard.tsx:312`
- **Problem:** `var(--branch-accent)` is applied as a text/foreground color on the near-white background (--background 0 0% 98% = #fafafa), e.g. Dashboard.tsx:294 `<div className="text-2xl font-bold" style={{ color: 'var(--branch-accent)' }}>` and :312 `<span style={{ color: 'var(--branch-accent)' }}>All Clear</span>`. Measured contrast on #fafafa: IDPL teal #14b8a6 = 2.38:1, BLN blue #3b82f6 = 3.52:1, JGG purple #8b5cf6 = 4.06:1 — all below the 4.5:1 normal-text threshold (only CNT red #D91C2B at 4.85:1 passes).
- **Impact:** Key dashboard numbers and status text are hard to read for low-vision users on 3 of 4 branches; teal is barely visible. WCAG 1.4.3 failure that varies invisibly by which branch the user is in.
- **Fix:** Add a per-branch --branch-accent-text token with WCAG-AA-passing values on white: CNT keep #D91C2B (or #b91c1c), IDPL teal-700 #0f766e (~4.8:1), JGG purple-700 #6d28d9 (~5.6:1), BLN blue-700 #1d4ed8 (~5.7:1) — verify each clears 4.5:1 on #ffffff (the Card bg), not #fafafa, since metric cards are pure white. Reserve the bright --branch-accent for icon/fills and ≥24px non-text. Then change Dashboard.tsx:294 and :312 to color:'var(--branch-accent-text)'; the icons on :291 and :311 can keep --branch-accent. Better still, given these are status numbers, just use the existing semantic --success token for the "finalized/all clear" positive state rather than branch accent, which sidesteps branch-by-branch contrast variance entirely.

### 167. 🟠 White text on branch accent (btn-branch-outline hover, accentForeground) fails contrast
**HIGH** · accessibility · effort M · verified (high)

- **Files:** `health-hub/src/index.css:392`, `health-hub/src/lib/branchTheme.ts:35`, `health-hub/src/pages/Dashboard.tsx:221`
- **Problem:** `.btn-branch-outline:hover` (index.css:396-399) sets `background-color: var(--branch-accent); color: white`, and branchTheme.ts hardcodes `accentForeground: '#ffffff'` for every branch. White-on-accent contrast: IDPL teal = 2.49:1, BLN blue = 3.68:1, JGG purple = 4.23:1 — all fail the 4.5:1 threshold for the button text. The four primary Dashboard quick-action buttons (Dashboard.tsx:221-239) all use `btn-branch-outline`.
- **Impact:** On hover/focus the primary CTAs on teal/blue/purple branches show low-contrast white labels, and the static accent-on-white border state is also weak (3.0:1 non-text minimum is borderline). WCAG 1.4.3 / 1.4.11 failure on the most-used buttons.
- **Fix:** Fix both states, not just hover. (1) Resting state: the accent-on-white label/border on teal and blue fails — darken the accent values used for foreground/border to reach 4.5:1 against white (teal-700 #0f766e ≈ 4.9:1, blue-700 #1d4ed8 ≈ 6.3:1, purple-700 #6d28d9 ≈ 6.7:1 all pass). Keep the brighter accent only for large decorative fills. (2) Hover state: ensure the chosen accent fill reaches 4.5:1 against white text; with the darkened accents above this is satisfied. (3) Simplest systemic fix: replace the single `accent` token with two tokens — `accentText` (AA-compliant on white, used for resting color/border) and `accentFill` (used as hover background, must pair 4.5:1 with white) — and remove the hardcoded `accentForeground: '#ffffff'` assumption by deriving foreground per fill. Verify all four branches in both states.

### 168. 🟠 Status badges use ~15% tinted background with same-hue text below 3:1 contrast
**HIGH** · accessibility · effort S · verified (high)

- **Files:** `health-hub/src/index.css:405`, `health-hub/src/index.css:410`, `health-hub/src/index.css:420`, `health-hub/src/components/ui/status-badge.tsx:38`
- **Problem:** Status badges set text in a saturated hue over the same hue at 0.15 alpha, e.g. index.css:405-408 `.status-draft { background-color: hsl(var(--status-draft) / 0.15); color: hsl(var(--status-draft)); }` (amber). Measured: draft amber text on its tint = 1.87:1, finalized/paid green text on its tint = 2.64:1 — far below the 4.5:1 text minimum. These render as small `text-xs` pills (status-badge class, index.css:401-403).
- **Impact:** Draft (amber) and Finalized/Paid (green) status pills — which carry billing and report-readiness meaning — are very low contrast for low-vision users (WCAG 1.4.3). Amber at 1.87:1 is illegible to many.
- **Fix:** For each status, decouple text color from the fill hue: keep the ~0.15 tint as the background, but set text to a darker, less-saturated shade of the same hue that clears 4.5:1 against that tint. Concretely: draft → amber-800-ish (e.g. hsl(38 92% 30%)); finalized/paid → green-800-ish (e.g. hsl(142 72% 25%)); pending → blue-800-ish (e.g. hsl(220 80% 35%)) so it isn't left at the borderline 4.3:1. Best done by adding dedicated foreground tokens (e.g. --status-draft-fg) rather than reusing the fill token, mirroring shadcn Badge's bg/fg pairing. Verify all four pills (draft/finalized/pending/paid) on BOTH --card (100%) and --background (98%) surfaces, and re-check the dark-mode --success (45% L) override at index.css:99 separately since its tint sits on the 5%/8% dark surfaces.

### 169. 🟠 Result flags and success/warning tokens rely on color and fail contrast
**HIGH** · accessibility · effort M · verified (high)

- **Files:** `health-hub/src/components/ui/flag-badge.tsx:18`, `health-hub/src/index.css:425`, `health-hub/src/index.css:33`, `health-hub/src/index.css:36`
- **Problem:** FlagBadge (flag-badge.tsx:18) renders the flag as colored text only — `flag-normal` (green #1ba853) on white = 3.10:1, below 4.5:1 for the small `text-xs` it uses; warning token (38 92% 50% ~#f5a201) on white = 2.09:1. While the badge does include the word HIGH/LOW/NORMAL (so it is not purely color), the green NORMAL and any amber/warning usage are still illegible, and the high/low distinction leans heavily on red-vs-blue color which colorblind users cannot separate from the words alone at this size.
- **Impact:** Lab result abnormality flags are clinical signals; low-contrast green/amber and red/blue-as-meaning reduce reliability for low-vision and color-blind doctors/owners reviewing reports (WCAG 1.4.1 use-of-color, 1.4.3 contrast).
- **Fix:** Two distinct fixes: (1) Contrast: darken the failing tokens so they reach >=4.5:1 on white. success/flag-normal -> ~142 72% 29% (#13853e ~ 4.6:1); warning -> ~38 92% 28% (~4.6:1). Keep destructive/flag-high (4.80) and flag-low (5.58) as-is — they already pass. Note success is shared by status-finalized/status-paid pills (15% bg), so verify those still look right after darkening, or split flag-normal into its own darker token. (2) Optional 1.4.1 hardening (low priority since the word label already disambiguates): in flag-badge.tsx add a lucide ArrowUp/Arrowdown icon for HIGH/LOW with aria-hidden plus the existing text, e.g. `<span><ArrowUp className='inline h-3 w-3'/>{flag}</span>`, so the up/down direction is conveyed non-textually for quick scanning. Do NOT bother re-coloring HIGH/LOW for contrast — they pass.

### 170. 🟠 Sidebar nav links and active group have no visible keyboard focus indicator
**HIGH** · accessibility · effort S · verified (high)

- **Files:** `health-hub/src/components/layout/Sidebar.tsx:220`, `health-hub/src/components/layout/Sidebar.tsx:262`, `health-hub/src/index.css:41`
- **Problem:** The primary nav links are bare `<Link>` elements styled only with hover/active background (Sidebar.tsx:224-228 and 265-269) and define no `focus-visible` ring. There are no focus classes anywhere in Sidebar.tsx. Even where a ring would appear, the global `--ring` is `0 0% 20%` (#333, index.css:41) — a dark ring that is nearly invisible on the dark navy/teal/purple sidebar backgrounds.
- **Impact:** A keyboard user tabbing through navigation cannot see where focus is in the sidebar (WCAG 2.4.7 Focus Visible). This is the entry point to every screen, so the whole keyboard journey starts blind.
- **Fix:** Add focus-visible styles to the Link className in BOTH branches of renderNavContent (lines 224-227 and 265-268). Use a light ring for contrast on the dark sidebar, e.g. 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80'. Drop the ring-offset suggested in the original finding: the offset color must equal the element's background, but inactive links sit on --branch-sidebar-bg while active links use --branch-sidebar-active, so a single hardcoded offset will mismatch one state. Instead use a ringless offset by relying on ring-2 alone, or use 'focus-visible:ring-inset focus-visible:ring-2 focus-visible:ring-white/80' so the ring renders inside the link bounds and stays visible regardless of active/inactive background. This is S effort.

### 171. 🟡 No skip-to-content link; keyboard users must tab through the full sidebar every page
**MEDIUM** · accessibility · effort S

- **Files:** `health-hub/src/components/layout/AppLayout.tsx:22`, `health-hub/src/components/layout/AppLayout.tsx:27`
- **Problem:** AppLayout renders the Sidebar then `<main>` (AppLayout.tsx:25-36) but provides no skip link. A grep for 'skip' / skip-link in the layout finds none. The sidebar contains ~8-12 links plus sub-items and a Sign Out button, all of which a keyboard user must tab through on every page load before reaching content.
- **Impact:** Repetitive, slow keyboard navigation on every route (WCAG 2.4.1 Bypass Blocks). Especially painful for the speed-driven front-desk staff who are heavy keyboard users.
- **Fix:** Add a visually-hidden-until-focused skip link as the first focusable element, e.g. `<a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:z-50 ...">Skip to content</a>` and give `<main id="main" tabIndex={-1}>`.

### 172. 🟡 Active-branch context banner is a presentational div, not an announced region
**MEDIUM** · accessibility · effort S

- **Files:** `health-hub/src/components/layout/ContextBanner.tsx:10`, `health-hub/src/components/layout/BranchSelector.tsx:106`
- **Problem:** ContextBanner.tsx:11 is a plain `<div className="context-banner ...">` showing the critical 'Branch: <name>' context with no landmark/role and no live-region semantics. When a staff/owner switches branch via BranchSelector (which mutates global state and changes accent theme, prices, and which patients are in scope), nothing is announced to screen-reader users.
- **Impact:** Branch is the single most important context in a multi-branch lab app (it scopes money, pricing, and patients). Screen-reader users get no confirmation that the active branch changed, risking actions against the wrong branch (WCAG 4.1.3 Status Messages).
- **Fix:** Wrap the branch text in an `aria-live="polite"` region, or fire a polite live announcement on branch change ('Active branch changed to <name>'). Optionally mark the banner with role="region" aria-label="Active branch context".

### 173. 🟡 Payout table rows are clickable but not keyboard-operable as rows
**MEDIUM** · accessibility · effort M

- **Files:** `health-hub/src/components/payouts/PayoutsTable.tsx:163`, `health-hub/src/components/payouts/PayoutsTable.tsx:170`
- **Problem:** PayoutsTable.tsx:163-179 renders `<TableRow className="cursor-pointer" onClick={...onRowClick(row)}>` with no tabIndex, role, or onKeyDown, so the row itself cannot be activated by keyboard. This is partially mitigated because each row also contains an explicit `aria-label="View details"` button (lines 246-256), but the `cursor-pointer` affordance is a mouse-only promise.
- **Impact:** Keyboard users cannot click the row (WCAG 2.1.1) and may not realize the dedicated View button is the way in; the visual cursor-pointer cue is misleading. Lower severity only because the redundant labeled button exists.
- **Fix:** Prefer keeping navigation on the explicit View button and remove row-level onClick + cursor-pointer to avoid the false affordance; or, if rows must stay clickable, add `tabIndex={0} role="button" aria-label={...}` and an onKeyDown for Enter/Space. (Contrast with DiagnosticsNewVisit.tsx:1329+ which correctly implements role=listbox/option with full keyboard handling — reuse that pattern.)

### 174. ⚪ Owner sidebar section headers (white/40) fall below text contrast
**LOW** · accessibility · effort S

- **Files:** `health-hub/src/components/layout/Sidebar.tsx:258`
- **Problem:** Sidebar.tsx:258 renders the 'Operations'/'Workflows' group headers as `text-[10px] font-semibold uppercase tracking-[0.18em] text-white/40`. Measured against the navy sidebar (#1B2B58), white at 40% opacity is ~3.48:1 — below the 4.5:1 needed for this small 10px text.
- **Impact:** The owner's navigation section dividers are hard to read for low-vision users (WCAG 1.4.3); at 10px the deficit is more pronounced.
- **Fix:** Raise to at least text-white/60 (≈5.9:1 here) for the section labels, or increase the font size. Keep /40 only for truly decorative dividers.

---

## LENS: Responsive & Mobile

_The shell (sidebar Sheet, ml-64 offset, context banner) is reasonably responsive, but the data layer is not: every owner/admin table relies on raw overflow-x-auto with no column-hiding or card fallback, and several dense forms/grids use fixed grid-cols/pixel tracks that overflow on phones. The owner dashboards are explicitly built for desktop widths (maxWidth 1440, lg:-only breakpoints) and collapse to single ugly columns on mobile. Icon-only controls and the search button are below comfortable touch-target size._

### 175. 🟠 Every data table is horizontal-scroll-only on mobile; no column hiding or card fallback anywhere
**HIGH** · responsive · effort L · verified (high)

- **Files:** `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/owner/OwnerDoctorsPage.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`, `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/components/payouts/PayoutsTable.tsx`
- **Problem:** A grep for responsive column hiding (`hidden ... table-cell` / `md:table-cell`) returns ZERO hits across the entire src tree. Every table is wrapped in a bare `<div className="overflow-x-auto">` (PayoutsTable.tsx:90, OwnerMoneyPage.tsx:395, OwnerOperationsPage.tsx:251/434/491, OwnerDashboardV2.tsx:852, ManagePanelDefinitions.tsx:873, OwnerDoctorsPage.tsx:111/339). ManagePanelDefinitions has an 8-column table (`<TableHead>Code/Name/Layout/Sample/Items/Department/Status/Actions`, lines 877-884); OwnerDoctorsPage has 7 numeric columns (Doctor/Visits/Gross/Commission/Rate/Net/Owed, lines 121-127). On a phone these become a single sideways-scrolling strip where the user cannot see Doctor + Owed at the same time, and there is no visual cue that more columns exist.
- **Impact:** Owners doing money/payout oversight on a phone (a primary stated use case) must blind-scroll a wide table to correlate a doctor's name with their commission/owed amount, the exact comparison the screen exists to support. This is friction on every data screen, not one page.
- **Fix:** The recommendation is sound. Tighten it with two specifics: (1) OwnerDoctorsPage.tsx uses a raw <table> (not shadcn <Table>) with inline styles, so the card-fallback / hidden-cell pattern must be applied to plain <td>/<th> there — easiest to first migrate it to the shared shadcn Table component so one systemic responsive pattern applies everywhere. (2) Standardize on the stacked-card approach already proven on DiagnosticsResultEntry.tsx (the md:hidden label:value pattern at lines 1570-1644) rather than inventing a new pattern — reuse that idiom for owner tables to keep consistency. For the overflow affordance, prefer a reusable wrapper component (e.g. a ScrollableTable with a right-edge mask-image/gradient that toggles via scroll position) over hand-rolling a shadow per page, since the bare overflow-x-auto div is repeated 10+ times.

### 176. 🟠 Owner dashboards are designed for desktop only (maxWidth 1440, lg:-only breakpoints) and degrade to a long single column on phones
**HIGH** · responsive · effort M · verified (medium)

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/OwnerOperationsPage.tsx`
- **Problem:** OwnerDashboardV2 wraps content in `style={{ maxWidth: 1440 }}` (line 988) and almost all KPI rows jump straight from 1 column to 5: `grid grid-cols-1 gap-4 lg:grid-cols-5` (lines 931, 1075), `lg:grid-cols-3` (611, 939). There is no `md:` or `sm:` step, so on any tablet (768-1023px) every KPI block is a full-width single column for the whole viewport, wasting space, and on a phone the dashboard becomes an extremely long scroll of stacked cards. The page also uses `hideContextBanner` (line 985), removing branch context entirely.
- **Impact:** Owners reviewing money/ops on a tablet or phone get a poorly-proportioned, very long page with no intermediate density. The lg-only jump means tablets (a common owner device) get the worst of both worlds.
- **Fix:** Scope the fix accurately. The small KPI-tile rows on Money and Operations pages already step correctly (`md:grid-cols-2 lg:grid-cols-4`), so leave those. The real gaps are the SPLIT-PANEL rows that go 1->lg with no tablet step: OwnerDashboardV2.tsx lines 611 (`lg:grid-cols-3`), 1075/1086 and OwnerMoneyPage/OperationsPage `lg:grid-cols-5`/`lg:grid-cols-2` rows. For the 3+2 panel row (line 1075), the cleaner change is to stack to 1 col below lg but ensure the two panels stack in priority order (MoneyToday first), rather than forcing a 5-up grid on tablet. For the equal `lg:grid-cols-2`/`lg:grid-cols-3` card rows, add `md:grid-cols-2`. Replace the inline `style={{ maxWidth: 1440 }}` (repeated in all three pages) with a shared Tailwind container class (e.g. `mx-auto w-full max-w-[1440px] px-4`) for consistency. Separately flag `hideContextBanner` as its own finding: removing branch context on owner pages is an IA concern, not a responsive one, so it does not belong in this responsive ticket.

### 177. 🟠 Fixed grid-cols / pixel-track grids in admin forms overflow horizontally on small screens
**HIGH** · responsive · effort M · verified (high)

- **Files:** `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/owner/OwnerDashboardV2.tsx`
- **Problem:** The reference-range editor uses non-responsive fixed tracks: `grid-cols-[120px_1fr_1fr_1fr_1fr_1fr_1fr_1fr_28px]` for both the header and every row (ManageClinicalDefinitions.tsx:1112, 1123) — 9 columns including a 120px label and a 28px delete button, with no breakpoint, so it cannot fit a phone and will overflow or crush the inputs to unusable widths. Similar unguarded fixed grids: `grid grid-cols-2 gap-4` (ManageBillableProducts.tsx:602, ManageClinicalDefinitions.tsx:943, ManagePanelDefinitions.tsx:957/1038), `grid-cols-3`/`grid-cols-5` (ManageClinicalDefinitions.tsx:1004), and a hard 3-col footer `grid grid-cols-3 gap-2` (OwnerDashboardV2.tsx:484) that squeezes three ₹ figures into a phone width.
- **Impact:** Editing test reference ranges or panel definitions is effectively impossible on a tablet/phone; inputs become too narrow to read or the form spills past the viewport. Even on desktop inside the ml-64 + 1440 cap these are tight.
- **Fix:** Primary fix (reference-range editor, the real blocker): stop using a single multi-track CSS grid for both header and rows. Collapse each range to a stacked card under md and only apply the column grid at md+. Drop the shared header row on mobile (it cannot align to stacked cards) and instead render per-field Labels inside each card. Concretely: wrap each row in a `<div className="rounded-md border p-3 space-y-2 md:border-0 md:p-0 md:space-y-0 md:grid md:gap-1 md:items-start md:grid-cols-[120px_1fr_1fr_1fr_1fr_1fr_1fr_1fr_28px]">` and hide the standalone header with `hidden md:grid`; give each field a `md:hidden` inline Label on mobile. For the form-field grids change `grid grid-cols-2` to `grid grid-cols-1 sm:grid-cols-2` (ManageBillableProducts.tsx:602, ManageClinicalDefinitions.tsx:943, ManagePanelDefinitions.tsx:957, :1038) and `grid-cols-5`/`grid-cols-3` to `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` (ManageClinicalDefinitions.tsx:1004). IMPORTANT CORRECTION to the original rec: Tailwind ships NO `xs` breakpoint by default, so the suggested `xs:grid-cols-3` on OwnerDashboardV2.tsx:484 would be a no-op unless you add `xs` to tailwind.config.ts. Use a real default breakpoint instead: `grid-cols-1 sm:grid-cols-3 gap-2` (or `flex flex-wrap gap-4` if you want the three rupee figures to flow rather than stack one-per-row). Verify there are no other consumers relying on the old single-grid markup before refactoring the range editor.

### 178. 🟡 Icon-only buttons (refresh, dialog close, filters) and some controls fall below comfortable touch-target size
**MEDIUM** · accessibility · effort S

- **Files:** `health-hub/src/pages/owner/OwnerDashboardV2.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/components/ui/button.tsx`
- **Problem:** The dashboard refresh control is a tiny custom button: `className="rounded-md border bg-white px-3 py-1.5"` wrapping a `h-3.5 w-3.5` icon (OwnerDashboardV2.tsx:1010-1023) — roughly 28px tall, below the 44px touch-target guideline, and it is the only way to refresh. The shadcn icon button variant is `icon: "h-10 w-10"` (button.tsx:23) which is 40px — acceptable but still under 44px, and the inline reference-range selects are squeezed to `h-6 ... w-[58px] px-1` (ManageClinicalDefinitions.tsx:1175), far too small to tap accurately.
- **Impact:** Owners on touch devices will mis-tap refresh and the dense inline controls. The 28px refresh button is the most-used action on the dashboard.
- **Fix:** Use `size="icon"` (or bump to `h-11 w-11` / `min-h-11 min-w-11`) for all icon-only actions including the custom refresh button, and avoid `h-6 w-[58px]` interactive controls on touch surfaces — give inline selects at least `h-9` and full width on a stacked mobile layout.

### 179. 🟡 Panel-definition Live Preview is hidden below lg with no alternative way to see it on tablet/mobile
**MEDIUM** · responsive · effort M

- **Files:** `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`
- **Problem:** The right-hand Live Preview column is `w-[360px] shrink-0 hidden lg:block` (ManagePanelDefinitions.tsx:1476). Below the lg breakpoint it is simply removed, with no toggle/drawer fallback, so on a tablet or phone the owner edits a panel definition with zero preview of what they are building.
- **Impact:** Owners configuring panels on a tablet lose the verification surface entirely and can only see results after saving — a feedback gap precisely when accuracy matters (lab panel structure).
- **Fix:** Provide the preview on small screens via a `Sheet`/`Dialog` triggered by a 'Preview' button (shown only `lg:hidden`), reusing the same preview component, instead of dropping it.

### 180. ⚪ Context banner stacks branch label above a full-width selector that already shows the branch name, doubling vertical space on mobile
**LOW** · redundancy · effort S

- **Files:** `health-hub/src/components/layout/ContextBanner.tsx`, `health-hub/src/components/layout/BranchSelector.tsx`
- **Problem:** On mobile the banner is `flex flex-col` (ContextBanner.tsx:11), rendering `Branch: <activeBranch.name>` (lines 14-15) on one row, then a full-width BranchSelector trigger that ALSO displays `{activeBranch.name}` (BranchSelector.tsx:112) on the next row. The branch name appears twice, stacked, consuming two rows of the always-present banner above every page on a small screen.
- **Impact:** Wastes scarce vertical space at the top of every screen on a phone and reads as redundant (the same branch name twice in 60px of height) right under the mobile sidebar header that may also show branch accent.
- **Fix:** On mobile, drop the standalone `Branch:` label row and rely on the selector (which already shows the name and is the tappable control), or keep the label inline and let the selector be a compact icon/chevron. e.g. hide the label span under `sm` (`hidden sm:flex`).

### 181. ⚪ Global Patient Search uses centered header + large bottom margin that wastes mobile viewport before the keyboard-first input
**LOW** · responsive · effort S

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** The header is `text-center mb-8` with an `text-2xl` title and a subtitle (GlobalPatientSearch.tsx:91-96), and the search-type tabs use long labels (`Search by Phone (recommended)`, line 109). On a phone the two tab buttons stack (`flex-col`, line 102) and the long parenthetical label may wrap, pushing the actual phone-number input far below the fold before the staff member can start typing.
- **Impact:** Front-desk staff doing speed-driven phone lookups on a phone/tablet must scroll past a decorative centered hero to reach the input, slowing the core task.
- **Fix:** Left-align and shrink the header (`text-xl`, remove `mb-8` → `mb-4`) and tighten the tab labels (`Phone` / `Name` with the icon) so the input is near the top on mobile. Consider auto-focusing the input.

### 182. ⚪ Sticky table header is applied without a constrained scroll container, so it does not help the horizontal-scroll problem and can mis-stick under the mobile top bar
**LOW** · interaction-feedback · effort M

- **Files:** `health-hub/src/components/payouts/PayoutsTable.tsx`
- **Problem:** PayoutsTable wraps the `<Table>` in `overflow-x-auto` (line 90) and marks the header `sticky top-0 bg-background z-10` (line 92). `top-0` is relative to the scroll/viewport root; with the 64px mobile top bar (`h-16` in Sidebar.tsx:287) and a non-height-constrained wrapper, the sticky header provides little benefit on mobile and the horizontal scroll (which is the real mobile issue here) leaves the row checkbox/Doctor column scrolling out of view with no frozen first column.
- **Impact:** On mobile the payouts table is hard to use: you cannot keep the Doctor name visible while scrolling right to the amount/Mark-paid action, and the sticky header does not address that.
- **Fix:** Either freeze the first column (sticky left) for the doctor name, or provide a stacked card layout under md. If keeping sticky header, give the scroll container a max-height so vertical sticky actually engages, and account for the mobile top bar offset.

---

## LENS: Interaction & Feedback States

_Feedback states are handled ad hoc and inconsistently across the app: there is no shared loading/empty/error vocabulary, so the same situation is rendered three different ways (Skeleton in Owner pages, Loader2 spinner in diagnostics/clinic pages, and nothing at all in the highest-traffic billing screen). The most serious issues are native window.confirm dialogs for a money-critical duplicate-patient decision, a never-rendered isLoading flag on New Diagnostic Visit (the form is usable before its products/doctors load), and several core data fetches that fail silently to console with no user feedback._

### 183. 🔴 Money-critical duplicate-patient decision uses native window.confirm() instead of an AlertDialog
**CRITICAL** · interaction-feedback · effort M · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/clinic/ClinicNewVisit.tsx`
- **Problem:** The duplicate-patient resolution at DiagnosticsNewVisit.tsx:735 (and the identical block at ClinicNewVisit.tsx:352) uses a native browser dialog: `const userConfirm = window.confirm("⚠️ Potential Duplicate Detected\n\n... Click OK to USE EXISTING patient ... Click Cancel to CREATE NEW patient anyway")`. This breaks the entire shadcn design language (unstyled OS chrome, no Sobhana branding), overloads OK/Cancel with non-obvious meanings ("Cancel" actually CREATES a record, the opposite of dismissing), is unthemeable, blocks the JS thread, and the \n-delimited text renders as a cramped wall. This is the one decision in the registration flow that determines whether a patient gets a fresh record or is merged into an existing one — a data-integrity and billing-attribution decision shown in the lowest-fidelity, most error-prone control available.
- **Fix:** Replace both with a shared shadcn AlertDialog (component already at components/ui/alert-dialog.tsx). Render the existing patient's number/name/age/gender/phone as structured rows (not a \n string). Use two explicit, non-OK/Cancel buttons: primary AlertDialogAction "Use existing patient" and a destructive-variant "Create new record anyway"; resolve a create-vs-merge Promise from each handler. Critically for this Enter-to-advance flow: do NOT pre-focus either button and do NOT make Esc/Enter resolve the decision implicitly — require a deliberate click so a stray keystroke cannot silently fork billing attribution. Extract into one shared component/hook (e.g. useDuplicatePatientResolver) since the block is duplicated across diagnostics and clinic, and have each caller pass its own field-mapping for the resolved patient object.

### 184. 🟠 New Diagnostic Visit declares isLoading but never renders a loading state — form is interactive before data loads
**HIGH** · interaction-feedback · effort M · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** `const [isLoading, setIsLoading] = useState(true)` (line 94) and `setIsLoading(false)` (line 220) are the ONLY references to isLoading in the entire 2675-line file — it is never read in render. The full form (phone lookup, test selector, doctor/center selectors, payment) mounts immediately while products, referralDoctors, and diagnosticCenters are still being fetched (lines 199-216). A fast front-desk operator can type a phone, select a patient, and open the test ProductSelector before products arrive, getting a silently empty list with no indication anything is still loading. On the primary revenue screen this causes confusion and mis-bills.
- **Fix:** Use isLoading rather than delete it. Two concrete changes: (1) Pass a loading prop into ProductSelector so that while isLoading the selector shows a disabled "Loading tests…" state instead of letting the user open an empty list, and crucially gate the line 371-373 "No products found" branch behind `!isLoading` so it never claims a test is missing while data is still in flight. (2) For the surrounding cards (doctor/center selectors), either disable them or render the existing Skeleton pattern used elsewhere in the app (do not introduce a new spinner) until isLoading is false; the phone-lookup field can remain enabled since it does not depend on the fetched lists. Separately, since the fetch swallows failures (lines 205-220 log only), also set an error state so a failed load shows a retryable error instead of a permanent "No products found" — otherwise using isLoading alone still leaves the failure case silently broken.

### 185. 🟠 Core data fetches fail silently to console.error with no user feedback
**HIGH** · error-handling · effort M · verified (high)

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsFinalizedReports.tsx`
- **Problem:** Multiple primary-data fetches catch errors with only `console.error(...)` and then set loading=false, leaving an empty page indistinguishable from a legitimate 'no data' result. Examples: DiagnosticsNewVisit.tsx:218 `console.error("Failed to fetch data:", error)` (products/doctors/centers — the bill cannot be created if this fails, yet no message), Dashboard.tsx:91 `console.error('Failed to fetch dashboard data:', error)`, DiagnosticsPendingResults.tsx:144, DiagnosticsFinalizedReports.tsx:102. This is inconsistent with Owner config pages which correctly toast on the same failure (e.g. ManageDiagnosticCenters.tsx:97-98 and ManageDepartments.tsx:119-120 both call `toast.error('Failed to load …')` in the catch). The doctor/lab staff on the worst-affected screens are left staring at an empty screen with no way to know to retry.
- **Fix:** Adopt the owner pages' full pattern, which the finding under-specifies. The diagnostic/dashboard fetches only setState inside `if (res.ok)` (NewVisit:205-216, Finalized:97-100, and the parallel Promise.all in PendingResults/Dashboard), so an HTTP 4xx/5xx never reaches the catch and produces a silent empty screen with NO toast. So: (1) add `else { toast.error('Failed to load …') }` on each non-ok branch AND `toast.error(...)` in every catch — mirroring ManageDiagnosticCenters/ManageDepartments exactly; (2) track a `loadError` boolean and render a distinct error EmptyState with a 'Try again' button (re-invoking the fetch) so users on these keyboard-driven screens can recover without a full reload. Note Dashboard/PendingResults use Promise.all, so wrap each response's ok-check or use Promise.allSettled to surface partial failures rather than failing the whole batch silently.

### 186. 🟠 Three competing loading patterns (Skeleton vs Loader2 spinner vs nothing) with no shared component
**HIGH** · consistency · effort L · verified (high)

- **Files:** `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsPendingResults.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`, `health-hub/src/pages/Dashboard.tsx`, `health-hub/src/pages/owner/AdminConfigCenter.tsx`
- **Problem:** Loading is rendered three incompatible ways across the app. Owner pages use Skeletons (OwnerMoneyPage.tsx:538 `{query.isLoading && <FullPageSkeleton />}`; Skeleton also in OwnerDashboard/OwnerOperations/PayoutsList/PayoutsByDoctor). Diagnostics/clinic pages use Loader2 spinners (DiagnosticsPendingResults.tsx:272 `<Loader2 className="h-8 w-8 animate-spin text-primary" />`, ClinicVisitQueue.tsx:279 `<Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />`). Several config pages use a bare text node (AdminConfigCenter.tsx:26 and ManageBillableProducts.tsx:504 `<div className="py-12 text-center text-muted-foreground">Loading...</div>`). And DiagnosticsNewVisit renders nothing. Spinner sizes (h-8 vs h-6) and colors (text-primary vs text-muted-foreground) also differ. The app feels stitched together; users get a content-shaped skeleton on one screen and a tiny spinner on the next.
- **Fix:** Standardize on two primitives in a shared module (e.g. src/components/ui/loading.tsx): (1) a content-aware <TableSkeleton>/<CardSkeleton>/<PageLoading> for full-page/list/table loads — promote the existing FullPageSkeleton out of owner/_shared/ownerUi.tsx so non-owner pages (Diagnostics, Clinic) can import it too; (2) reserve inline <Loader2 className="mr-2 h-4 w-4 animate-spin"> strictly for in-button busy states (ClinicVisitQueue.tsx:361/376/489/502 already do this correctly — keep them). Then: replace DiagnosticsPendingResults.tsx:272 and ClinicVisitQueue.tsx:279 full-region spinners with the skeleton; replace the AdminConfigCenter.tsx:25 / ManageBillableProducts.tsx:504 bare "Loading..." text nodes with the shared component; give DiagnosticsNewVisit.tsx an actual loading branch that consumes its unused isLoading state; and convert Dashboard.tsx:145 inline text spinner to either the shared PageLoading or, if a non-blocking refresh indicator is intended, a consistent small spinner token. Add an ESLint/grep guard so new `animate-spin` usages outside buttons are flagged. Note for triage: this is the right consolidation but it is genuinely effort L and touches ~10 files; do it as a single sweep, not piecemeal.

### 187. 🟡 Global Patient Search shows no loading state in the results region while fetching
**MEDIUM** · interaction-feedback · effort S

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`
- **Problem:** During a search, the only feedback is the Search button label flipping to 'Searching...' (GlobalPatientSearch.tsx:136); the results area below renders nothing new. `isSearching` is referenced only at lines 134 and 136. On a slow/3G connection the user sees the unchanged page with no spinner or skeleton in the results region, so there is no clear signal that results are coming versus that the search returned nothing — especially because the empty-state card (line 159) is gated on `hasSearched`, which only flips true after the request resolves. Cross-branch search can be slow, making this gap user-visible.
- **Fix:** Render a results-region loading state while isSearching is true (a few card skeletons matching the patient-card layout, or at minimum a centered spinner), shown before the empty-state and results blocks. Reuse the standardized loading component recommended above.

### 188. 🟡 New Diagnostic Visit shows no 'no patients found' message when a 10-digit phone has zero matches
**MEDIUM** · interaction-feedback · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The Matching Patients card renders when `(matchingPatients.length > 0 || phone.length === 10)` (line 1319), but when the phone is 10 digits and the search returns zero results the card body (lines 1366-1430) only renders the 'Create New Patient' button and the '↑↓ arrow keys' hint (line 1429) — there is no explicit 'No existing patient found for this number' message. The operator cannot tell whether the search ran and found nothing versus whether it is still searching or errored (the search catch at lines 481/501 is console-only). The arrow-key hint is also misleading when the only option is the single Create button.
- **Fix:** When `phone.length === 10 && matchingPatients.length === 0` (and not loading), render an explicit empty message like 'No patient found for this number — create a new one below.' and suppress the arrow-key navigation hint when there is only one selectable option. Also surface a search error toast in the catch blocks so a failed lookup is not mistaken for 'no results'.

### 189. 🟡 Phone-lookup search has no inline loading or error feedback
**MEDIUM** · interaction-feedback · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** Both `handleSearch` (line 465) and `handlePhoneChange` (line 486) fire patient lookups but track no loading state and only `console.error('Search failed:', error)` (lines 481, 501) on failure. The Search button (line 1296) is never disabled and shows no busy indicator while a lookup is in flight. A double-Enter or impatient re-click can fire overlapping requests, and a failed network call leaves the operator with no patients and no error — they may proceed to create a duplicate.
- **Fix:** Add an isSearching state, show a spinner/disable the Search button while in flight, and toast.error on failure. Guard against concurrent requests (ignore if already searching, or cancel the prior fetch). This matches the feedback the confirm/submit flow already provides.

### 190. 🟡 No shared EmptyState component — empty results re-implemented per page with differing icons/copy
**MEDIUM** · consistency · effort M

- **Files:** `health-hub/src/pages/clinic/GlobalPatientSearch.tsx`, `health-hub/src/pages/clinic/ClinicVisitQueue.tsx`, `health-hub/src/components/diagnostics/ProductSelector.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** Each screen hand-rolls its own empty state with inconsistent structure. GlobalPatientSearch.tsx:159-166 uses a Card with a centered User icon + two-line copy; ClinicVisitQueue.tsx:283 is a bare 'No visits found.' line inside a spinner branch; ProductSelector.tsx:436-440 is a one-liner 'Start typing to search…'; and DiagnosticsNewVisit's matching-patients zero-result case has no empty state at all (see related finding). There is no EmptyState primitive (a find for *empty* returns nothing), so icon presence, vertical padding (py-12 vs py-4), and tone vary screen to screen.
- **Fix:** Create a shared <EmptyState icon title description action> component and use it for all 'no results'/'nothing yet' cases (search, queues, selectors). Standardize padding, icon size/opacity, and a one-line-plus-hint copy pattern. This also gives a natural home for the error-empty variant from the silent-failure finding.

### 191. ⚪ Loading microcopy inconsistent: 'Loading...' (three dots) vs 'Loading…' (ellipsis char), plus mixed verbs
**LOW** · microcopy · effort S

- **Files:** `health-hub/src/pages/owner/ManageBillableProducts.tsx`, `health-hub/src/pages/owner/ManageClinicalDefinitions.tsx`, `health-hub/src/pages/owner/OwnerMoneyPage.tsx`, `health-hub/src/pages/owner/ManagePanelDefinitions.tsx`, `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The same loading message is spelled two ways: ASCII 'Loading...' (ManageBillableProducts.tsx:504, ManageClinicalDefinitions.tsx:750, ManagePanelDefinitions.tsx:869, ManageDoctorsAndReferrals.tsx:940) vs the Unicode ellipsis 'Loading…' (OwnerMoneyPage.tsx:527, OwnerDoctorsPage.tsx:447, OwnerDashboardV2.tsx:1001, OwnerOperationsPage.tsx:577, ManagePanelDefinitions.tsx:231 — the same file mixes both). Busy-button verbs also drift: 'Creating...' (DiagnosticsNewVisit.tsx:2499), 'Adding...' (DiagnosticsNewVisit.tsx:2579/2622/2665), 'Saving...', 'Searching...'. Minor, but it reads as inattention to detail on a paid product.
- **Fix:** Standardize on one ellipsis style (recommend the Unicode '…' or consistently three dots) and one verb convention for transient busy labels. Centralize common strings ('Loading…', 'Saving…') so they cannot drift.

### 192. ⚪ Quick-add dialogs busy-state is button-only; rest of dialog gives no in-flight feedback
**LOW** · interaction-feedback · effort S

- **Files:** `health-hub/src/pages/diagnostics/DiagnosticsNewVisit.tsx`
- **Problem:** The quick-add Product/Doctor/Center dialogs disable their primary button and flip its label to 'Adding...' (lines 2579, 2622, 2665) but leave all inputs enabled and the Cancel button active during the POST. A user can edit fields or hit Cancel mid-request, and there is no overlay/disabled treatment on the form body. The submit handlers create the entity and only then close — a slow request feels unresponsive beyond the small button label change.
- **Fix:** While isCreating* is true, also disable the dialog inputs and Cancel (or show a subtle inset spinner), so the whole dialog reads as busy, consistent with the confirm dialog which disables both Back and Generate Bill during submit (lines 2490, 2497).

---

