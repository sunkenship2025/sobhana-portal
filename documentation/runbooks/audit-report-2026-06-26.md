# Documentation Update Summary Report (2026-06-26)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Payouts Redesign & UX Improvements**: Comprehensive overhaul of the payouts system including wireframe fidelity updates, a new pay-run worklist, per-payee statements, status-independent totals, real print documents for statements, and WhatsApp send-statement capabilities (frontend and backend with tokenized public links).
2. **External Labs Management**: Added ExternalLab CRUD service and API routes, a new "Outsource to Lab" picker in billing, and configuration options allowing per-product overrides.
3. **Patient 360 Enhancements**: Redesigned the Patient360 detail page with smart search capabilities, inline bill previews, zooming controls for report previews, and the ability to send bills on WhatsApp. Added backend support with paginated timeline endpoints and bill lookups.
4. **Owner Dashboard Upgrades**: Refactored to include a full-width trend chart with NaN-proof rendering, audit fields, and trend deltas.
5. **Print Layout Adjustments**: Tweaked PDF printing configurations for reports and payouts, including reserving letterhead footers, expanding text size uniformly across panels, locking signatures to the bottom of the page, and increasing table row roominess.
6. **Queue Optimism**: Added optimistic UI updates for "Mark Done" / "Start" buttons in the OP/IP queues for snappier status changes.
7. **Accessibility & Shared Components**: Implemented aria-labels for icon-only buttons across owner/diagnostics pages, standardized money labels, and adopted shared 'LoadingState' and 'EmptyState' components on diagnostics and owner management lists.
8. **React Query Adoption (Continued)**: Expanded the usage of `@tanstack/react-query` for ManageDoctors and ManageClinicDoctors, introducing branch-scoped CRUD pairs and central branch-switch cache flushing.

## Which Docs Were Updated
- `ARCHITECTURE.md`: Updated to reflect the creation of new schemas (ExternalLab, LAB-payout) and further adoption of React Query.
- `CHANGELOG.md`: Documented the payouts redesign, Patient 360 enhancements, owner dashboard upgrades, and new external labs features.

## Which Docs Should Be Reviewed Manually
- `documentation/runbooks/audit-report-2026-06-26.md` (This file)

## Undocumented Architectural Decisions Discovered
- **ExternalLab Schema Integration**: The `ExternalLab` model and its relationship to the payout ledger needs to be formalized in the database schema documentation.
- **WhatsApp Public Links**: The mechanism for generating and verifying tokenized public links for payout statements via WhatsApp is a new pattern that should be documented in the API/security docs.
