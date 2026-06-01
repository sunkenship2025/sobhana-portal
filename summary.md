# Documentation Update Report

## What Changed in Code
- **Lab Incharge Signing**: Branch-wise rules for Lab Incharge signing were added (`SigningLabIncharge`, `LabInchargeRule`), updating digital and print report rendering with signatures.
- **Bill Discounts & Partial Payments**: Supported discounts (flat/percentage) and partial payments via `PaymentTransaction` with multiple types (cash/online/cheque). Blocked report finalization if balance due exists.
- **Rich Text Editor**: Added rich text narrative capabilities for imaging and radiology reports.
- **Referral Creation on the Go**: Allowed on-the-fly creation of referral doctors and diagnostic centers from the billing view.
- **Quick Bill-only items**: Required codes for quick bill-only products and allowed mixing them transparently with clinical panels in packages.
- **Owner Dashboard Refactor**: Owner dashboard reorganized, updating metrics and tracking.
- **Title Updates**: Restored the 'Master' title and normalized title/salutation handling across API and layout.

## Which Docs Were Updated
- `documentation/CHANGELOG.md`: Added entries for Lab Incharge Signing, Bill Discounts & Partial Payments, Rich Text Editor, Referral Creation, Bill-only items, Owner Dashboard, and Title updates under the `[Unreleased]` section.
- `documentation/ARCHITECTURE.md`: Added `SigningLabIncharge`, `LabInchargeRule`, and `PaymentTransaction` models to the respective architecture schemas.

## Which Docs Should Be Reviewed Manually
- `documentation/TESTING.md`: Might need new test coverage policies for partial payments, payment transaction updates, and lab incharge rules, since significant new financial workflows and roles have been added.
- `documentation/runbooks/database-migrations.md`: Review whether down-migrations or backfill strategies need to be detailed for partial payments or soft-delete ledgers introduced recently.

## Undocumented Architectural Decisions Discovered
- `DoctorPayoutLedger` soft-delete: Replaced raw uniqueness constraint with a partial index in migration due to Prisma's limitations regarding partial constraints on `deletedAt`. A raw SQL index `DoctorPayoutLedger_lookup_idx` was added and documented in comments, but might warrant an ADR since it works around Prisma capabilities.
