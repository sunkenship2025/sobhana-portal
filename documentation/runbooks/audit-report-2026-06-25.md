# Documentation Update Summary Report (2026-06-25)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Patient 360 Redesign:** A complete overhaul of the Patient 360 interface, including a new smart search with chronological visit grouping, a redesigned patient detail page with timeline filtering, and inline bill/report previews with zoom controls.
2. **Backend Patient Search Enhancements:** Introduced new endpoints for paginated timeline tracking, due calculation, and advanced search and bill lookups.
3. **WhatsApp Bill Delivery:** Added support for sending bills via WhatsApp directly from the Patient 360 view, mirroring the existing report action.
4. **Owner Account Enhancements:** A decision-grade redesign of the owner dashboard featuring full-width trend charts, NaN-proof rendering, audit fields, and trend deltas.
5. **Print Layout Improvements:** Enhanced print views for finalized reports with adjusted table font sizes (10pt rows, 10.5pt subgroup headings), wider result columns for better readability, and dynamic column widths. Shifted patient-info right column and locked the signature/QR block to the bottom of the physical report page.
6. **Queue & Status Updates:** Implemented optimistic 'Mark Done / Start' for snappy status changes in the OP/IP queue and unified money labels across the app (Total, Discount, Net payable, Paid, Balance due).
7. **React Query Migration Progress:** Continued migration to React Query with branch-scoped CRUD pairs and central branch-switch cache flushing, tracking progress in documentation.

## Which Docs Were Updated
- `CHANGELOG.md`: Documented the Patient 360 redesign, backend enhancements, WhatsApp bill delivery, owner account improvements, print layout adjustments, and React Query migration progress.
- `ARCHITECTURE.md`: Updated to reflect the adoption of React Query and architectural decisions regarding the Patient 360 redesign.


## Which Docs Should Be Reviewed Manually
- `documentation/patient360-redesign/*` (A series of markdown documents outlining the requirements, lenses, decisions, and plans for the redesign)
- `documentation/react-query-migration-playbook.md`
- `documentation/ui-ux-audit-2026-06-21.md`
- `documentation/ui-ux-findings-register-2026-06-21.md`
- `documentation/ui-ux-issues-deduped-2026-06-21.md`

## Undocumented Architectural Decisions Discovered
None discovered. The extensive additions to the `documentation/patient360-redesign/` and `documentation/ui-ux-audit-2026-06-21.md` suggest significant architectural and UI/UX changes were planned and documented explicitly.
