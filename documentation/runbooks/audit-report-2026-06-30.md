# Documentation Update Summary Report (2026-06-30)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Payouts System Redesign:** Complete architectural overhaul of the payouts system to support outside-lab vendor payouts. This included the addition of `ExternalLab` and `ExternalLabProductRule` models, a `LAB` type in `PayoutDoctorType`, and linking `TestOrder` to an external lab. It also introduces WhatsApp payout statement delivery secured by the new `StatementAccessToken` model.
2. **Owner Dashboard Overhaul:** Deployed `OwnerDashboardV2` featuring decision-grade UI, full-width trend charts, NaN-proof rendering, and URL query parameter (`?branch=...`) support for branch selection instead of local state, enabling easily shareable links.
3. **Patient360 Redesign:** Rewrote Patient360 to a Canonical Patient View. This splits the original monolithic endpoint into `/summary` and cursor-paginated `/timeline` endpoints. It introduces a live due-balance calculation over real bills, a global smart search page, inline PDF report/bill preview pane, and migrates to React Query.
4. **Database Schema:** Added new tables (`ExternalLab`, `ExternalLabProductRule`, `StatementAccessToken`), columns (`externalLabId` on `TestOrder`, `payoutCategory` on `BillableProduct`), and indexes to support the payout and Patient360 redesigns.
5. **New Visit Flow UI/UX:** Unified and redesigned the diagnostics and clinic new visit pages. Added comprehensive keyboard shortcuts to the diagnostics form, allowing navigation entirely via keyboard (Enter, Arrows, Shift+Arrows) to accelerate billing.

## Which Docs Were Updated
- `CHANGELOG.md`: Added entries covering the Payouts System Redesign, Owner Dashboard Overhaul, Patient360 Redesign, and Schema updates to the `[Unreleased]` section.
- `ARCHITECTURE.md`: Added the new `ExternalLab`, `ExternalLabProductRule`, and `StatementAccessToken` data models to section 5. Updated section 7 (Security model) to note that payout statements use the same token-gated WhatsApp access mechanics as bills and reports. Updated the Known Architectural Debts section to reflect that the React Query migration playbook is currently paused after tier 4.

## Which Docs Should Be Reviewed Manually
- `documentation/patient360-redesign/` (The entire folder containing requirements, wireframes, decisions, and build plans for the Canonical Patient View; these serve as historical design records and could eventually be archived if deemed no longer necessary for daily reference).
- `documentation/react-query-migration-playbook.md` (As the migration is paused at tier 4, this should be reviewed before any further React Query adoption begins).

## Undocumented Architectural Decisions Discovered
None discovered. All major changes, such as the Payouts redesign, Owner Dashboard overhaul, and Patient360 Canonical View, were heavily documented through PR artifacts or dedicated decision logs (like `04-decisions.md` in the `patient360-redesign` folder) that were committed alongside the code.