# Documentation Update Summary Report (2026-07-08)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Events & Coupons Module:** Introduced a config-driven module for event-participation products. This includes a new `EVENT` `DiagnosticWorkflowMode` for products that mint one-time campaign coupons and send WhatsApp templates upon billing instead of a standard bill/report.
2. **Coupon Data Models:** Added `CouponCampaign` (to define events, discount rules, validity, and themes) and `Coupon` (for one-time-use redemption codes tied to campaigns) to the database schema.
3. **Public Token-Gated Gateway for Coupons:** Added a new public route (`/c/:token`) to serve a branded, campaign-themed page for patients to view their coupon code via WhatsApp links.
4. **Operations Access Changes:** Granted `lab_incharge` access to the operations dashboard (`/api/owner/operations` and frontend ops routes), splitting role-based access previously limited to owners.
5. **Reopen Trace & Immutability Improvements:** Recorded `reopenedByUserId` and `reopenedAt` in `TestOrder`. Reopening after a finalized report is now allowed and properly transitions a test back to Pending Results. Appended trace history to the Patient 360 timeline.
6. **Billing & No-Report Workflows:** Improved the 'no report needed' workflow by allowing films-only visits to finalize without patient messages. Waived tests are now properly excluded from partial-vs-final validation counts.
7. **Cloud Sync Improvements:** Added toggle preferences for strict manual sync control and elegant switch UI over narrative/text reports.

## Which Docs Were Updated
- `documentation/API.md`: Added the new public `/c/:token` route to the "Public routes (no auth)" table and adjusted the auth conventions paragraph.
- `documentation/ARCHITECTURE.md`: Added `Coupon` and `CouponCampaign` entities to the Core entities section, noted the `EVENT` workflow mode on `BillableProduct`, and updated the tokens section to include `Coupon.token`.

## Which Docs Should Be Reviewed Manually
- `EVENTS_AND_COUPONS.md`: Newly added architecture and workflow specification for the Events & Coupons module. Provides detail on data modeling, WhatsApp templates, and public pages for campaigns.
- `documentation/ARCHITECTURE.md` (Roles & Audit section): Might need review on exact audit severity retuning that occurred matching risk rather than time for specific deletions and edits.

## Undocumented Architectural Decisions Discovered
None. Architectural changes related to the Events & Coupons module were well-documented natively in `EVENTS_AND_COUPONS.md`, and relevant API boundaries and entities were successfully surfaced to `API.md` and `ARCHITECTURE.md`.
