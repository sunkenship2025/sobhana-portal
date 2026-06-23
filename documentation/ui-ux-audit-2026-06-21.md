# SOBHANA PORTAL — UI/UX Audit & Design Vision

**Author:** VP of Design / Head of Product Design
**Date:** 2026-06-21
**Scope:** Full app — front-desk staff, doctors, owners. React + Tailwind + shadcn/ui.
**Evidence base:** 192 verified findings (page-cluster + cross-cutting lens reviews) plus live-screenshot observations. Findings folded by root cause; every fix cites real files.

---

## 1. Executive Summary

The portal is **functionally rich but visually and conceptually ungoverned.** Under the surface it is several apps stitched together: two owner dashboards in conflicting idioms (`OwnerDashboardV2.tsx` vs `OwnerDashboard.tsx`), three loading patterns, four nouns for one billable item ("Test / Product / Item / Panel"), and ~354 raw Tailwind palette colors bypassing a perfectly good token system. The chrome that *should* orient the user — the `ContextBanner` and `AppLayout` — instead prints the active branch name twice and silently throws away every `subContext` label the pages dutifully pass it. The most consequential decision in the whole product (does this bill attach to an existing patient or fork a duplicate medical record?) is delivered through a native `window.confirm()` with inverted OK/Cancel semantics. None of this is a fundamental architecture problem — it is the predictable result of **no shared primitives and no enforced vocabulary.** The good news: a small number of foundational components and one capitalization rule would retire entire classes of these findings at once.

### Top 5 systemic themes (root causes)

1. **No shared chrome owns "where am I."** There is no `PageHeader`, breadcrumbs are imported nowhere despite `breadcrumb.tsx` existing, and `AppLayout` accepts `context`/`subContext` it never renders. Every page hand-rolls its own `<h1>` in 4+ type recipes → naming drift, redundant titles, the branch "double."
2. **Tokens exist but are ignored.** `index.css` defines success/warning/destructive/status/branch tokens; pages hardcode `#0F6E56`, `bg-green-100`, `text-blue-600`, and a parallel JS `TOKENS` object (duplicated *twice*). Result: two greens, two reds, dead dark mode, and broken per-branch theming.
3. **No single vocabulary.** Sentence case for owners, Title Case for staff; "Patient 360" in nav → "Global Patient Search" on screen; Test/Product/Item/Panel; Final total / Net payable / Final Total for one number.
4. **Low-fidelity controls at high-stakes moments.** `window.confirm()` for duplicate patients, unconfirmed signing-rule deletes, dead controls (Bill Number search, doctor Date filter, "Pay N pending" that doesn't pay).
5. **Accessibility & responsiveness are systemic gaps, not page bugs.** ~136 unassociated `<Label>`s, dozens of unnamed icon buttons, white-on-accent contrast failures across 3 of 4 branches, and *zero* responsive column handling in any table.

---

## 2. North-Star Vision

For the **speed-driven front-desk operator**, the portal should feel like a *keyboard instrument*: land on home, type a name, hit Enter, and be registering — never hunting for the create action, never reading a celebratory full-screen interstitial between patients, never decoding which of three identically-labeled buttons goes to the queue. For the **glance-and-go owner**, it should feel like a *cockpit*: one consistent dashboard where green always means the same green, every number is readable, every drill-down lands somewhere real, and the active branch is stated once, calmly, at the top.

Design principles:
- **One vocabulary.** A concept has exactly one user-facing name (a "test," a "Net payable," a "Patient 360"), defined in a shared constants module so it cannot drift.
- **The chrome states context once.** Branch and section live in `AppShell`; pages never re-print where they are.
- **Speed is a feature.** Primary actions are first, keyboard-first, and free of friction (no interstitials, no dead fields).
- **Tokens, never hex.** Color carries semantics through tokens; raw palette values are a lint error.
- **Honest controls.** Every visible control does what it says; destructive actions are confirmed and clearly the non-default.

---

## 3. The Flaws You Flagged, Fixed

### A. The ContextBanner "double" *(`ContextBanner.tsx`, `BranchSelector.tsx`)*

The earlier "Context: Diagnostics" line is already gone — good. But the **name still appears twice**: a static `Branch: Sobhana – Kukatpally` span sits immediately left of a `BranchSelector` whose trigger *also* renders `Sobhana – Kukatpally` with a `Building2` icon and chevron.

**Before**
```
Branch: Sobhana – Kukatpally        [🏢 Sobhana – Kukatpally ▾]
└── static span (redundant)         └── selector already shows the name
```
**After** — selector is the sole branch affordance; the `Building2` icon already signals "branch." The reclaimed row carries wayfinding:
```
Diagnostics / New Visit                         [🏢 Sobhana – Kukatpally ▾]
```
Delete the static `Branch:` + name block in `ContextBanner.tsx`; feed `context`/`subContext` (below) into the now-empty left side.

### B. The New Diagnostic Visit redundant header *(`DiagnosticsNewVisit.tsx:1255`)*

The sidebar highlights "New diagnostic visit," the (future) breadcrumb says "Diagnostics / New Visit," and then the page repeats `<h1 class="text-2xl font-bold">New Diagnostic Visit</h1>` with the subtitle "Register a patient…" — the page name said three times. Same triple-stacking afflicts Pending/Finalized (h1 *and* a CardTitle repeating the title).

**After:** the `PageHeader` (owned by `AppShell`) renders the title + breadcrumb once; the page body opens directly on the Patient Lookup card. The card keeps only its functional CardTitle ("Patient lookup"), not a second copy of the page name.

### C. Patient 360 / Global Patient Search naming + heading mess *(`Sidebar.tsx:77/128`, `GlobalPatientSearch.tsx:88-92`, `Patient360.tsx:28`)*

Sidebar item **"Patient 360"** → lands on a page titled **"Global Patient Search"**, *centered* (`text-center mb-8`) while every sibling clinic page left-aligns — it reads like a different app. The doc comment in `Patient360.tsx:28` even mislabels the entry point.

**Before → After**
| Surface | Before | After |
|---|---|---|
| Sidebar | Patient 360 | Patient 360 |
| Page h1 | `Global Patient Search` (centered) | `Patient 360` (left-aligned via `PageHeader`) |
| Breadcrumb/subContext | `Global Patient Search` (discarded) | `Patient 360 / Search` (rendered) |
| Detail page | Patient 360 | Patient 360 |

One feature, one name, one alignment. Drop `text-center` and route through the shared header.

---

## 4. Systemic Findings by Theme

### Navigation & Wayfinding

**Problem:** Owner and staff have entirely separate nav trees with the same destinations at different depths — Patient 360 is top-level for staff but buried under Operations › Workflows for owners; diagnostics routes are a clean group for staff but dumped flat into the owner "Operations" dropdown. Section parents (`Operations`, `Diagnostics`, `Clinic`) render as non-clickable `<div>`s even when they point at real routes, and group hrefs `/diagnostics` and `/clinic` aren't even routes. Dead-ends abound: branch rows link to `/branches/:id` (no such route → 404), `/money/bills|cash|discounts` all render the same unaware `OwnerMoneyPage`, `/ops/queue|pending|audit` all render the same `OwnerOperationsPage`, `/owner/legacy` is live but unlinked, and legal pages are reachable only by typing the URL.
**Files:** `Sidebar.tsx`, `App.tsx`, `OwnerMoneyPage.tsx`, `OwnerOperationsPage.tsx`, `OwnerDashboardV2.tsx:883`.
**Fix:** Collapse to **one nav tree** filtered by the existing `roles` field (data refactor, not render rewrite). Make parent items with a real route clickable Links; drop phantom hrefs. Repoint branch rows to `/owner?branch=${id}` (the working data path). Make `/money/*` and `/ops/*` honest with shadcn `Tabs` driven by `useLocation().pathname` that also consume the query params drill-downs already emit. Redirect `/owner/legacy` to `/owner`. Add footer links to `/privacy`, `/terms`, `/data-deletion`.

### The Page-Header & Breadcrumb System

**Problem:** No `PageHeader` primitive; nine+ pages hand-roll `<h1>` in four recipes (`text-2xl font-bold`, `text-3xl font-semibold`, inline `fontSize: 20`, `text-gray-900` literals). `breadcrumb.tsx` exists and is used **nowhere**. Deep pages fall back to ad-hoc `navigate(-1)` arrows and hardcoded "Back to X" buttons that break on alternate entry paths.
**Files:** `breadcrumb.tsx`, `AppLayout.tsx`, `_shared/ownerUi.tsx:372`, `Dashboard.tsx`, `Patient360.tsx`, `DiagnosticsResultEntry.tsx`, `PayoutDetail.tsx`.
**Fix:** One `<PageHeader title subtitle breadcrumbs actions />` (`text-2xl font-semibold tracking-tight text-foreground`), rendered by `AppLayout` and fed by `context`/`subContext` (or a structured `breadcrumbs` prop). Refactor `OwnerPageHeader` to delegate to it; delete all nine ad-hoc `<h1>` blocks; wire `breadcrumb.tsx` for detail routes (`/diagnostics/results/:id`, `/clinic/patient-360/:id`, `/owner/payouts/:id`).

### Visual / Color System & Tokens

**Problem:** ~354 raw palette utilities bypass tokens (`text-green-600` 29× vs success token 8×; amber/yellow 40× vs warning 10×). `OwnerDashboardV2.tsx` ships a **parallel hardcoded-hex design system** (`TOKENS = { healthy:'#0F6E56', page:'#FAFAF8'… }`) duplicated *verbatim* in `_shared/ownerUi.tsx` — guaranteeing the greens and reds drift apart. A complete `.dark` theme is defined but never activated, with scattered `dark:` variants that can never render. `CardTitle` defaults to `text-2xl` and is overridden in ~23 places.
**Files:** `OwnerDashboardV2.tsx:119-143`, `_shared/ownerUi.tsx:18-40`, `index.css`, `tailwind.config.ts`, `card.tsx:19`, `Login.tsx`, `BranchConfirmModal.tsx`.
**Fix:** Delete **both** `TOKENS` copies; map to `text-foreground` / `bg-card` / `text-success` / `text-destructive` / `text-warning`. Promote categorical/waterfall chart colors to `--chart-*` CSS vars in `:root` and `.dark`. Promote brand navy/red to `brand-navy`/`brand-red` tokens and replace the ~20 `bg-[#1B2B58]`/`text-[#D91C2B]` literals in Login/BranchConfirmModal. Lower `CardTitle` default to `text-base`. Decide dark mode in or out — if out, delete `.dark` and the dead variants; if in, codemod the grays first.

### Redundancy & Altitude

**Problem:** Same action appears multiple times under different names. Dashboard: "Enter Results" as both a card button and a Quick Action tile; the clinic queue linked three times as "View Queue" / "View Admissions" / "Visit Queue" — all to `/clinic/queue`. "Read-Only" stamped 5+ times across Patient 360 (and partly *inaccurate* — the Identity card is editable). PayoutDetail repeats doctor name + period in the subtitle *and* as two summary cards. Dead code: `TestSelector.tsx` (unused duplicate of `ProductSelector`), `NavLink.tsx`, three legacy Manage* pages with stray `console.log`, orphaned `ReportPrint.tsx` carrying fictitious "123 Medical Street" branding.
**Files:** `Dashboard.tsx`, `Patient360.tsx`, `PayoutDetail.tsx`, `TestSelector.tsx`, `NavLink.tsx`, `ManageDoctors.tsx`, `ReportPrint.tsx`.
**Fix:** One control per destination, label matching the route. State "read-only" once, authoritatively, and reword so "history is read-only but you can still print/share." Delete all confirmed dead code (zero-risk; grep-verified unreferenced).

### Forms & Operator Speed

**Problem:** Primary create actions sit *4th* on the Dashboard behind three KPI cards; Patient search — the highest-frequency front-desk task — isn't on the Dashboard at all. `New Diagnostic Visit` is a long single-column `max-w-3xl` form with a wide empty canvas and the running bill total buried at the bottom. Dead/inert controls: the Bill Number search field (`billSearch` written, never read), the doctor Date filter (rendered, never applied), and the Run Cycle "Pay N pending" button (navigates, never pays). Hand-rolled comboboxes (`ProductSelector`, `TestSelector`) reimplement keyboard nav with a 200ms blur-timeout while `TestValueCombobox` already does it correctly with shadcn `Command`.
**Files:** `Dashboard.tsx`, `DiagnosticsNewVisit.tsx`, `DoctorDashboard.tsx`, `PayoutRunCycle.tsx`, `ProductSelector.tsx`.
**Fix:** Put an autofocused patient-search field + the two unique create buttons directly under the Dashboard header, above KPIs. Two-column New Visit on lg+ with a sticky bill-summary panel. Remove or implement the three dead controls. Rebuild selectors on shadcn `Command`/`Popover`.

### Feedback & States

**Problem:** Three competing loading patterns (Skeleton on owner pages, `Loader2` on diagnostics, bare "Loading..." text on config) and no shared `EmptyState`. Worse, **silent failures masquerade as success**: a failed Dashboard fetch renders zeros and a confident green "All Clear"; core New Visit fetches `console.error` and leave an empty product list mid-bill. The duplicate-patient decision uses `window.confirm()` (verified at `DiagnosticsNewVisit.tsx:735` and `ClinicNewVisit.tsx:352`). Signing-rule and lab-incharge deletes fire with no confirmation while every other delete is gated. Bulk payout delete destroys PAID records with no guard.
**Files:** `Dashboard.tsx`, `DiagnosticsNewVisit.tsx`, `ManageSigningDoctors.tsx`, `PayoutsList.tsx`, `*NewVisit.tsx`.
**Fix:** A shared loading kit (`FullPageSkeleton` + `TableSkeleton` + `CardGridSkeleton`) and a shared `<EmptyState>`. Gate "All Clear" behind a confirmed success flag — make "loading," "load failed," and "zero work" three distinct states with a destructive `Alert` + Retry on failure. Replace both `window.confirm` calls with an `AlertDialog` where the **safe** action ("Use existing patient") is the default and the fork is the destructive non-default. Confirm every destructive delete; block bulk-deleting paid payouts.

### Accessibility

**Problem:** Three *critical*-rated, systemic gaps. (1) **Contrast:** `--warning-foreground`/`--success-foreground` are white on amber/green = 2.14:1 / 2.86:1 (fail); branch accent as text fails 4.5:1 on 3 of 4 branches (teal 2.38:1, blue 3.52:1, purple 4.06:1); white-on-accent buttons fail too; status badges (same-hue text on 15% tint) measure 1.87:1. (2) **Naming:** dozens of icon-only Edit/Delete buttons announce only "button"; ~136 of 206 `<Label>`s have no `htmlFor`. (3) **Focus & semantics:** sidebar nav links have no `focus-visible` ring on the dark sidebar; no skip-to-content; branch change isn't announced.
**Files:** `index.css:33-37`, `branchTheme.ts`, `status-badge.tsx`, `Manage*.tsx`, `Sidebar.tsx`, `AppLayout.tsx`.
**Fix:** Set `--warning-foreground`/`--success-foreground` to `0 0% 10%` (root + `.dark`). Darken branch accents to 600-shades (verify rest + hover). Add darkened `-fg` tokens for status badges. Ship an `IconButton` requiring a `label` prop; adopt shadcn `Form` or manual `id`/`aria-labelledby` for inputs. Add a light `focus-visible` ring to sidebar Links, a skip link, and `aria-live` on the branch banner. Back all with `jsx-a11y` lint rules.

### Responsive / Mobile

**Problem:** **Zero** responsive column handling anywhere (`grep` for `md:table-cell` returns nothing) — every table is a bare `overflow-x-auto` strip, so on a phone an owner can't see Doctor + Owed together. Owner dashboards jump straight `grid-cols-1` → `lg:grid-cols-5` (no md/sm step), so tablets get a full-width single column. Admin forms use fixed pixel-track grids (`grid-cols-[120px_1fr...28px]`, `grid-cols-2`) that overflow phones. Panel "Live Preview" is `hidden lg:block` with no drawer fallback. The context banner stacks the branch name twice on mobile.
**Files:** `PayoutsTable.tsx`, `OwnerMoneyPage.tsx`, `OwnerDashboardV2.tsx`, `ManageClinicalDefinitions.tsx`, `ManagePanelDefinitions.tsx`.
**Fix:** A `DataTable` primitive with per-column priority (`hidden md:table-cell`) and a stacked-card fallback under `md`. Add `sm:`/`md:` steps to owner grids; stack admin form grids (`grid-cols-1 sm:grid-cols-2`); put the panel preview behind a `Sheet` on small screens.

### Branding

**Problem:** Login builds its logo from Material Symbols glyphs (`biotech`+`medical_services`) while the shell uses the lucide `Microscope` — two marks for one brand, one of them dependent on an external webfont. The login hero is hotlinked to an ephemeral Google `aida-public` URL (breaks offline, leaks a pre-auth third-party request). Login still presents **self-selectable role radio cards** — a trust/security smell; roles must derive from the account. The 404 is off-brand with a raw `<a>` that full-reloads to the wrong role home. Printed bills omit the clinic name; branch addresses are chosen by fuzzy string-matching on the branch name (with a "Shobhana" typo); the legal entity name is spelled three ways.
**Files:** `Login.tsx`, `Sidebar.tsx`, `NotFound.tsx`, `BillReceipt.tsx`, legal pages.
**Fix:** One `<BrandLogo>` (self-hosted SVG) everywhere; self-host the hero. Derive role from the authenticated account — remove the radio selector. Brand the 404 inside the shell with a role-aware `<Link>`. Render `clinicLabel` on bills; drive addresses from branch data keyed by `branch.code`; centralize `CLINIC_LEGAL_NAME`.

### Microcopy & Terminology

**Problem:** *Critical* vocabulary split: one billable concept is **Test / Product / Item / Panel** within a single flow ("Select Tests" card, "products" placeholder, "Add Item" button, "product" toast). Money labels shift across one transaction: **Final total → Net payable → Final Total** for the identical number. Nav is Sentence case for owners, Title Case for staff ("Pending results" vs "Pending Results"). "New Visit" labels *two different* destinations. Field labeled "Diagnostic Referral" but every placeholder calls it a "center." Doctor dashboard says "finalized reports" but lists DRAFT reports with no distinction (a clinical safety issue). Raw enums leak ("DIAGNOSTIC_CENTER," "ONLINE"). ALL-CAPS "SEARCH RESULTS • GLOBAL • READ-ONLY" reads as a debug string.
**Files:** `DiagnosticsNewVisit.tsx`, `ProductSelector.tsx`, `Sidebar.tsx`, `DoctorDashboard.tsx`, `GlobalPatientSearch.tsx`, `PayoutDetail.tsx`.
**Fix:** A shared strings/constants module. Standardize on **"test"** (staff-facing) / "product" (code only); one money vocabulary (`Total`, `Discount`, `Net payable`, `Paid`, `Balance due`); **Sentence case everywhere** except brand and proper nouns ("Patient 360"); disambiguate "New diagnostic visit" / "New clinic visit"; per-row status badges (Draft vs Final) on the doctor dashboard; humanize enums via existing `formatDoctorTypeLabel`.

---

## 5. Foundational Components to Introduce

| Component | What it replaces / eliminates |
|---|---|
| **`<AppShell>`** that owns context | The branch "double," discarded `subContext`, and per-page context guesswork. Renders branch (once) + `PageHeader` + breadcrumbs from route config. |
| **`<PageHeader title subtitle icon breadcrumbs actions />`** | All nine+ hand-rolled `<h1>` recipes, the centered-vs-left drift, redundant page titles, and absent back-navigation. Wires `breadcrumb.tsx` (already in the repo). |
| **`<DataTable>`** with column priority + card fallback | ~8 copies of inline `<thead>/<tbody>` styling and the zero-responsive `overflow-x-auto` strips. One place for sticky headers, `tabular-nums`, sort. |
| **`<EmptyState icon title description action />`** | Per-page empty states with mismatched icons/padding/copy; gives a home for the error-empty variant. |
| **Loading kit** (`FullPageSkeleton`, `TableSkeleton`, `CardGridSkeleton`, `<Spinner>`) | Three competing loading patterns and bare "Loading..." text; promoted out of `_shared/ownerUi.tsx` to `components/ui`. |
| **`<IconButton label>`** (required `label`) | Dozens of unnamed/`title`-only Edit/Delete icon buttons; flows to `aria-label` + tooltip; lintable. |
| **`AlertDialog`-based `<ConfirmDialog>` / `useConfirm`** | Both `window.confirm()` calls and the unconfirmed signing-rule/payout deletes. Safe action defaults; destructive action clearly non-default. |
| **`<BrandLogo>`** (self-hosted SVG) | The two divergent logo marks (Material Symbols vs lucide) and the webfont dependency. |
| **`<StatusBadge>` / `<SemanticBadge tone>`** (extended) | ~10 ad-hoc `bg-x-100 text-x-800` color maps; one token-backed source of "active/paid/finalized." |
| **`<MetricCard>` / `<StatBadge>`** (tokenized) | Owner KPI cards' hex chips, huge empty space, and muted hero numbers; enforces `text-foreground` for live counts. |
| **`formatRupees(paise, 'exact'\|'compact')` + `MONEY_LABELS` / strings module** | Duplicated formatters, the short-vs-full currency split, and the Test/Product/Net-payable vocabulary drift. |

---

## 6. Prioritized Roadmap

### P0 — Quick Wins (high impact / low effort)

| Change | Why it matters | Files | Effort |
|---|---|---|---|
| Remove the branch "double" | The #1 visible redundancy on every page | `ContextBanner.tsx`, `BranchSelector.tsx` | S |
| Render `subContext` (or delete the prop) | Restores wayfinding the pages already pass | `AppLayout.tsx`, `ContextBanner.tsx` | S |
| Patient 360 / Global Search naming + left-align | Nav promises one thing, delivers another | `Sidebar.tsx`, `GlobalPatientSearch.tsx` | S |
| Fix branch-row 404 → `/owner?branch=` | Owner's primary drill-down dead-ends | `OwnerDashboardV2.tsx:883` | S |
| Remove/implement dead controls (Bill# search, doctor Date filter, "Pay N pending") | Inert controls erode trust at the bill/money | `DiagnosticsNewVisit.tsx`, `DoctorDashboard.tsx`, `PayoutRunCycle.tsx` | S–M |
| Brand split: one `<BrandLogo>`, remove role radios, self-host hero | First impression contradicts the product; security smell | `Login.tsx`, `Sidebar.tsx` | S–M |
| Fix `--warning-foreground`/`--success-foreground` to near-black | Critical contrast fail on solid badges/buttons | `index.css` | S |
| Sentence-case nav + disambiguate "New Visit" | One product, one voice | `Sidebar.tsx` | S |
| Delete confirmed dead code (`TestSelector`, `NavLink`, legacy Manage*, `ReportPrint`) | Removes drift traps + legal landmine | listed files | S |

### P1 — Structural (high impact / medium effort)

| Change | Why it matters | Files | Effort |
|---|---|---|---|
| Introduce `AppShell` + `PageHeader` + breadcrumbs; delete ad-hoc `<h1>`s | Retires header drift, redundant titles, back-nav | `AppLayout.tsx`, new `PageHeader`, `breadcrumb.tsx`, 9 pages | L |
| Replace both `window.confirm` with `ConfirmDialog`; gate all destructive deletes | Patient-record + financial data integrity | `DiagnosticsNewVisit.tsx`, `ClinicNewVisit.tsx`, `ManageSigningDoctors.tsx`, `PayoutsList.tsx` | M |
| Gate "All Clear" / surface fetch errors with Retry | False reassurance on a clinical dashboard | `Dashboard.tsx`, `DiagnosticsNewVisit.tsx`, others | M |
| Collapse to one owner dashboard + one nav tree | Two design eras; deep owner access to daily tasks | `OwnerDashboardV2.tsx`, `App.tsx`, `Sidebar.tsx` | L |
| Delete both `TOKENS`, map to design tokens, codemod grays | Two greens/two reds, dead dark mode, no theming | `OwnerDashboardV2.tsx`, `_shared/ownerUi.tsx`, `index.css` | L |
| `IconButton` + input-label association sweep | WCAG 4.1.2 / 1.3.1 across owner + registration | `Manage*.tsx`, `label.tsx`, forms | L |
| `DataTable` with responsive columns + card fallback | Mobile money/payout oversight is a stated use case | `PayoutsTable.tsx`, owner pages | L |
| Standardize loading kit + `EmptyState` | Stitched-together feel; error-empty home | cross-cutting | L |
| Make `/money/*` and `/ops/*` honest (tabs + query params) | Address bar is lying about location | `App.tsx`, `OwnerMoneyPage.tsx`, `OwnerOperationsPage.tsx` | L |

### P2 — Polish (medium/low impact)

| Change | Why it matters | Files | Effort |
|---|---|---|---|
| One money vocabulary + `formatRupees` mode | Reconciliation confidence | `DiagnosticsNewVisit.tsx`, `payoutFormatters.ts` | M |
| Standardize Test/Product noun + placeholders/error voice | Trains-and-trusts the core flow | `DiagnosticsNewVisit.tsx`, `ProductSelector.tsx` | M |
| Doctor dashboard Draft vs Final badges + wire Date filter | Clinical safety + dead filter | `DoctorDashboard.tsx` | S–M |
| Recharts for owner trend (axes/tooltip/a11y) | Owners can't read rupee figures off the SVG | `OwnerDashboardV2.tsx` | M |
| Brand legal pages + footer links; centralize legal name | Meta/WhatsApp compliance discoverability | legal pages, `App.tsx`, `BillReceipt.tsx` | M |
| Compact New-Visit success + two-column sticky bill | Per-bill friction for high-frequency staff | `DiagnosticsNewVisit.tsx` | M–L |
| Bill totals order + clinic name on receipt | Coherent arithmetic on a legal doc | `BillReceipt.tsx` | S |
| Off-scale font sizes → type scale; lower `CardTitle` default | Type rhythm | `card.tsx`, scattered | M |

---

## 7. Closing — The Three Things to Do First This Week

1. **Kill the "double" and turn on wayfinding.** Delete the static branch name in `ContextBanner.tsx` and render `subContext` through `AppLayout` — this single change fixes the user's #1 complaint and immediately gives every page a "where am I" crumb. (P0, hours.)
2. **Ship `PageHeader` and standardize the names.** Land the one canonical header, route the New Visit and Patient 360 pages through it, fix "Global Patient Search" → "Patient 360," and apply Sentence case across the nav. This is the wedge that retires the entire header/naming theme.
3. **Replace `window.confirm` with a proper `ConfirmDialog`.** The duplicate-patient decision is the highest-stakes, lowest-fidelity control in the product. Make the safe action the default and the fork clearly destructive — a data-integrity fix that also signals the new design bar to the whole team.

These three set the pattern (shared chrome, one vocabulary, honest controls) that every subsequent P1/P2 item simply follows.
