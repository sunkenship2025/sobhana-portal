# Documentation Update Summary Report (2026-07-03)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Payouts Redesign:** Completely overhauled the payouts feature with new UX, per-product centre-defined categories, and 'outsource to lab' functionalities via a new `ExternalLab` model and `/api/external-labs` service endpoints. Added a real print document for statements, worklist redesign, and WhatsApp statement delivery via backend HTML.
2. **Order Refunds:** Added a schema foundation and endpoints for order refund handling, properly splitting money-returned from charge-reversed, and endpoints/Patient360 UI for cancel/refund actions.
3. **Patient 360 Enhancements:** Implemented backend summary + paginated timeline split endpoints for performance (`/360/summary` and `/360/timeline`), added Exact Due calculation, and ability to send bills on WhatsApp. The frontend added crisp zoom controls for report previews and inline bill previews.
4. **New Roles:** Added `lab_incharge` and `sales` roles with per-role access control.
5. **Print Formatting Enhancements:** Updated print styling with larger rows (11pt), centered logo, and tighter top margins. Reorganized physical margins, locking signature/QR block to the bottom of the page and reserving a physical footer.
6. **Pending Results and Billing Views:** Upgraded "reports overdue" logic, dropped 'Finalize' terminology for non-finalizers, and improved empty states.
7. **Security Fixes:** Removed the unused `doctor` role and portal, removed boot-time DB mutations, and blocked signature path traversal, improving report immutability.

## Which Docs Were Updated
- `CHANGELOG.md`: Documented the major feature updates including the Payouts Redesign, Order Refunds, Patient 360 Enhancements, New Roles, Print Enhancements, and Security fixes under the `[Unreleased]` section.
- `API.md`: Documented the new `/api/external-labs` routes, `/api/bills/:id/refund` route, `/api/payouts/whatsapp` route, and updated `/api/patients/:id/360` endpoints.
- `ARCHITECTURE.md`: Documented the new `lab_incharge` and `sales` roles, added `ExternalLab` to the schema manifest, and added a specific section for Architectural Patterns documenting the Patient 360 Split Query, External Lab Payout tracking, and Fire-and-forget Side Effects.

## Which Docs Should Be Reviewed Manually
- The new `ExternalLab` integrations and exact `DoctorPayoutLedger` structure should be reviewed in the frontend vs backend types if external labs have additional product override rules needed in the documentation.
- The `Order Refund` mathematical basis documentation (money returned vs charge reversed) could be explored further and given a dedicated section in `DECISIONS.md`.

## Undocumented Architectural Decisions Discovered
- **Patient 360 Split Architecture:** Discovered an architectural decision to avoid N+1 queries in the Patient 360 component by separating the response into a glance summary and a paginated timeline. This has now been added to `ARCHITECTURE.md`.
- **External Lab Ledger Strategy:** Using the `LAB` `doctorType` on the `DoctorPayoutLedger` was a key architectural pattern for outsource commission payouts that had not been documented yet. Added to `ARCHITECTURE.md`.
