# Backlog — postponed / later work

Running list of work that's been **deliberately deferred** — started-but-paused, skipped, or "good idea, not now." This is the single place to look for "what did we say we'd come back to?"

**Convention (keep this current):** whenever work is skipped, postponed, or parked for later — or whenever something surfaces that clearly belongs here rather than being done now — add or update an entry below. Each entry: a date, current status, what's left, and where to resume. When an item is picked back up and finished, move it out (delete it, or note it as done in its source doc) so this list stays "open work only."

---

## React Query migration (remaining) — paused 2026-06-23

**Status:** tiers 1–4 done & deployed (~4 of 31 page files). Paused by choice; resume any time.
**Full plan & conventions:** [`react-query-migration-playbook.md`](./react-query-migration-playbook.md) (see its Status block for exactly what's done).

**Remaining, in order:**
- **Tier 5 — payouts family** (4 files together, `['payouts']` namespace). *Resume here.*
- **Tier 6 — heavy `Manage*`**, one at a time: BillableProducts → ClinicalDefinitions → PanelDefinitions → DoctorsAndReferrals → **SigningDoctors last** (multipart + sequenced chains).
- **Tier 7 — shared singletons:** Dashboard, BillPrintPage, PatientEditDialog, TestInputConfigEditor.
- **Tier 8 — visits/clinical last** (GETs first): ClinicVisitQueue, FinalizedReports, PendingResults, Patient360, ReportPreview, the two NewVisit pages, **ResultEntry dead last**.

**Notes for whoever resumes:** follow the playbook's query-key rule (branchId in key iff branch-scoped), preserve the documented header inconsistencies, and keep the "stays raw fetch" list (blobs/multipart/keepalive) on raw `fetch`. The migration is purely incremental — each page is independent, nothing is half-migrated.

---

## Test harness (none in repo) — noted 2026-06-23

The frontend (`health-hub`) has **no test runner** — zero tests, no vitest/jest in `package.json`. Tier-4 logic was verified with a throwaway `vitest` run (installed `--no-save`, deleted after). If we want standing tests, the proven setup was: `vitest` + `happy-dom` + `@testing-library/react`, `@` alias → `src`. Low priority unless test coverage becomes a goal.

---

## UI/UX audit — remaining items — updated 2026-06-23

**Master list:** [`ui-ux-issues-deduped-2026-06-21.md`](./ui-ux-issues-deduped-2026-06-21.md) (124 distinct issues) + strategy in [`ui-ux-audit-2026-06-21.md`](./ui-ux-audit-2026-06-21.md). Many quick wins are **done & deployed** (branch-banner double, Patient 360 naming, dead controls, `window.confirm`→dialog, rule-delete guards, Dashboard error state, `LoadingState`/`EmptyState`, `PageHeader` on main pages, B1 color tokens, B2 `PayoutsTable` responsive, payout status pills, 404 rebrand). Open / deliberately deferred work below.

**Deliberately deferred (with the why):**
- **B3 breadcrumbs** — skipped; nav is shallow and the sidebar already shows the section. If revisited, add **only on deep detail pages** (payout detail, result entry) and build a real route→IA map (note `context="clinic"` does *not* match where Patient 360 lives in the nav).
- **B3 owner page headers** — owner pages still use the bespoke `OwnerPageHeader` in `pages/owner/_shared/ownerUi.tsx`. Clean follow-up: make it delegate to the shared `components/ui/page-header.tsx`.
- **B1 colors (remaining)** — categorical badge palettes (product types, sample-type dots, workflow modes) and saturated green/amber/blue **text** colors were left raw **on purpose**: tokenizing categoricals destroys intended hue distinction, and the success/warning tokens are too light as text-on-white (contrast regression). Only grays, reds, and badge **tints** were tokenized. No `--info` token exists for blue — add one if blue ever needs theming.
- **B2 tables** — full generic `DataTable` skipped for pragmatic column-hiding; only `PayoutsTable` done. Owner money/ops tables are compact (4–5 cols) and left as-is.
- **Loading/Empty states** — ✅ `EmptyState` on config + all owner `Manage*` lists; `LoadingState` on config + diagnostics list pages (2026-06-23). Remaining: context-specific spinners (print pages, dialogs, button-level) — not a clean blanket swap. ✅ Money labels unified to Total / Discount / Net payable / Paid / Balance due across bill + visit screens.
- **Status badge system** — ✅ pending hue settled (amber, 2026-06-23): `--status-pending` is now amber, so `StatusBadge` (pending/waiting/results-pending) matches the tokenized payout pills app-wide. Remaining (low priority): a few genuinely-status hardcoded pills could route through `StatusBadge`, but most green/amber pills are *categorical* (workflow modes, product types) and stay. `.status-unpaid` token exists but its class is unused (no real gap).
- **Bulk payout delete of PAID records** — `PayoutDeleteDialog` confirms generically but doesn't warn/block when the selection includes already-PAID payouts. Needs a payout-lifecycle decision.
- **Nav IA** — `/money/*` and `/ops/*` render the same page without reflecting the sub-route (needs tabs/query params); legal pages are reachable only by typing the URL (add footer links).
- **Accessibility pass** — ✅ icon-only button `aria-label`s done (2026-06-23). Remaining: ~136 inputs without associated `<Label htmlFor>`, contrast on branch accents + status badges, sidebar `focus-visible` ring, skip-to-content link.
- **Print/bill branding** — clinic name omitted on bills, branch addresses chosen by fuzzy name-match (with a "Shobhana" typo), legal entity name spelled three ways.
- **Terminology** — Test / Product / Item left as "tests" per owner decision; not unified.
