# Documentation Update Summary Report (2026-07-06)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Payouts Redesign:** Added comprehensive statement and external lab payouts capabilities. `ExternalLab` and `ExternalLabProductRule` enable tracking outsourced lab commissions. Also introduced token-gated WhatsApp delivery for statements (`StatementAccessToken`).
2. **Order Refunds:** Added schema and money math foundation for tracking money-returned vs. charge-reversed. Includes cancellation/refund endpoints and Patient 360 UI integration.
3. **Roles & Permissions:** Added `lab_incharge` and `sales` roles with per-role access control; removed unused `doctor` role and portal.
4. **Patient 360 Redesign:** Architectural split to solve N+1 queries. Added summary endpoint and paginated timeline endpoints with smart search. Inline bill previews with clean PDF viewer.
5. **Report Editor & Rendering:** Made report editor 1:1 with printed output (true WYSIWYG) and converted font-size overrides to honest sizes. Enlarged text globally on reports and implemented dynamic result column width for robust text wrapping.
6. **Cloud Sync:** Added Cloud Sync feature for narrative/text reports with per-user overrides and organizational defaults.
7. **Security & Token Gateways:** Hardened public gateways for reports, bills, and statements. Added `revokedAt` feature to access tokens that invalidate them on cancellations.
8. **Result Entry Validation:** Converted 15 X-ray products to `BILL_ONLY` format, allowing closure with "no report needed" for film-only workflows.

## Which Docs Were Updated
- `CHANGELOG.md`: Documented all significant changes under the `[Unreleased]` section.
- `ARCHITECTURE.md`: Updated the System Overview section to accurately reflect current roles (`lab_incharge`, `sales`), updated the routing access control table, and expanded the Security Model section to include `BillAccessToken`, `StatementAccessToken`, and the `revokedAt` column.

## Which Docs Should Be Reviewed Manually
None

## Undocumented Architectural Decisions Discovered
None. All architectural decisions (such as the HealthFlow repo separation plan) were well-documented in PR artifacts and plan files.