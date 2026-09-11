# Documentation Update Summary Report (2026-06-28)

## What Changed
Since the last documentation audit run on 2026-06-22, the following significant changes were integrated into the main branch:
1. **Payouts Redesign (Phase A-G):**
   - **External Labs:** Introduced `ExternalLab` and `ExternalLabProductRule` schema entities to handle outside lab payouts. Added CRUD routes under `/api/external-labs` and a frontend configuration page.
   - **Payout Statement:** Added public tokenized payout statement links (`GET /statements/view/:token`) secured by a new `StatementAccessToken` table, enabling secure WhatsApp delivery to payees.
   - **Worklist:** Redesigned the Pay-Run worklist page with non-netting hero totals (commissions vs. lab payables) and updated categorization logic based on a new `payoutCategory` field in `BillableProduct`.
2. **Patient 360 Redesign:** Overhauled the patient detail page with a new summary and paginated timeline backend endpoints, inline bill previews, and WhatsApp bill delivery functionality mirroring report delivery.
3. **Owner Dashboard Update:** Upgraded the Owner Account dashboard with a full-width trend chart, audit fields, trend deltas, and parallelized backend queries for improved performance.
4. **Visit Queue & Entry Improvements:** Added optimistic state updates (Mark Done / Start) for snappy OP/IP queue status changes and redesigned visit entry forms with progress strips, improved keyboard navigation, and optional email collection.
5. **Database Schema Changes:** Added `ExternalLab`, `ExternalLabProductRule`, and `StatementAccessToken` tables. Modified `TestOrder` and `DoctorPayoutLedger` to include `externalLabId`. Relaxed `MessageLog` schema constraints by making `patientId` nullable (to support sending messages to labs/doctors) and adding `branchId`.

## Which Docs Were Updated
- `CHANGELOG.md`: Added entries for the Payouts redesign, External Lab management, tokenized public statement links, Patient 360 redesign, and Owner Dashboard enhancements under the `[Unreleased]` section.
- `API.md`: Documented the new `/api/external-labs` endpoints, updated `/api/payouts` to reflect worklist and statement fetching routes, added the public `GET /statements/view/:token` route, and updated `/api/patients` to include the new summary and timeline endpoints.
- `ARCHITECTURE.md`: Incorporated mentions of the new `ExternalLab` entity, detailed the WhatsApp delivery mechanism for payout statements using `StatementAccessToken`, and noted the generalization of `MessageLog` for non-patient recipients.

## Which Docs Should Be Reviewed Manually
- None.

## Undocumented Architectural Decisions Discovered
None. All architectural enhancements (such as the tokenized public link mechanism and the external lab payout flows) were integrated clearly and aligned well with existing patterns (e.g., matching the `BillAccessToken` pattern).
