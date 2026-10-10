# Documentation Update Summary Report (2026-07-08)

## What Changed
Since the last documentation audit run, the following significant changes were integrated into the main branch:
1. **Events & Coupons Module:** Added a reusable configuration-driven system for event participation. It features a new `EVENT` diagnostic workflow mode, `CouponCampaign` configuration, `Coupon` generation, and token-gated branded pages (`/c/:token`) sent via WhatsApp.
2. **Order Refunds Feature:** Added schema and money math foundation for partial and full per-order refunds (`OrderRefund` model). Updates to `PaymentTransaction` support the new REFUND logic.
3. **External Lab Payouts:** Introduced external lab modeling (`ExternalLab`, `ExternalLabProductRule`) and integrated it into the `DoctorPayoutLedger` via the `LAB` doctorType. Payout statement WhatsApp links are now token-gated.
4. **Statement/Bill Access Tokens:** Introduced `StatementAccessToken` to manage token-gated public access to payout statements.
5. **UI & UX:** Cloud sync toggles were added for narrative/text reports with per-user overrides. Pending results and payout features received multiple usability passes.
6. **Authentication & Authorization:** Added `Lab Incharge` and `Sales` roles with per-role access control mechanisms.

## Which Docs Were Updated
- `ARCHITECTURE.md`: Added details for the new schema components `ExternalLab`, `StatementAccessToken`, and `OrderRefund`. Integrated Events & Coupons description into the architecture documentation.
- `CHANGELOG.md`: Added an `[Unreleased]` section containing all recent feature additions, schema changes, and UI/UX improvements.

## Which Docs Should Be Reviewed Manually
- `EVENTS_AND_COUPONS.md`

## Undocumented Architectural Decisions Discovered
None in this cycle.
