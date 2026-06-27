# Documentation Audit Report - 2026-06-27

## What Changed
- **Payouts Redesign Phase A-G:** Introduced `ExternalLab` management for outsourced tests, categorizations per product rather than just by department, and the ability to send payout statements securely via WhatsApp using `StatementAccessToken`. Added status-independent worklist totals and legacy print layouts.
- **Patient 360 Redesign:** Created new patient search UI with improved cross-links, inline preview for bills and reports, zoom controls, and a feature to send bills via WhatsApp tokenized links.
- **Owner Dashboard V2:** Improved Owner dashboard charting with a full-width trend chart, NaN-proof rendering, and trend deltas. Parallelized straggler queries to fix refetch flickers.
- **Diagnostics/Clinic Visits UI & Print Improvements:** Widen result columns, adjust test row sizing (11pt), and properly lock signature/QR blocks to the bottom of physical prints. Optimistic state updates on OP/IP queues for better UX.

## Updated Documents
- `documentation/CHANGELOG.md` updated with the latest [Unreleased] feature additions, changes, and database migrations (`ExternalLab`, statement access tokens, payout category, etc.).
- `documentation/ARCHITECTURE.md` updated with the new operational models `ExternalLab` and `ExternalLabProductRule`, and public token security details for `StatementAccessToken`.
- `documentation/API.md` updated to include new endpoint families `/api/external-labs` and `/statements/view/:token`.

## Documents Needing Manual Review
- `documentation/patient360-redesign/*` — New design documentation files added during the recent redesign. Needs review to ensure alignment with final implemented state.
- `documentation/ui-ux-audit-2026-06-21.md` and related UI/UX documents might need cross-referencing with newly shipped UI improvements (e.g. print layout updates).

## Discovered Undocumented Architectural Decisions
- **Statement Access Tokens:** Implemented a new token system `StatementAccessToken` mirroring the bill access pattern to allow doctors and lab vendors to securely access their statements over WhatsApp without logging in.
- **External Lab Costs:** Shifted from strict internal doctor commission tracking (`SPL`, internal center) to a new vendor management approach where external labs have their costs tracked as `rateType`/`rateAmount` against `TestOrder` and `DoctorPayoutLedger`.
