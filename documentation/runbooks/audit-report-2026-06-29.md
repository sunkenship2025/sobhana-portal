# Documentation Update Summary Report (2026-06-29)

## What Changed
Since the last documentation audit run on 2026-06-22, the following significant changes were integrated into the main branch:
1. **Payouts Redesign:** Added external lab management (`ExternalLab` and `ExternalLabProductRule`) with per-product rate overrides. Owner dashboard UI revamped to focus on a "who I owe" view. Payout statements have been redesigned with category-banded views and can now be shared via WhatsApp token-gated links using the new `StatementAccessToken` model.
2. **Patient 360 Rewrite:** To fix heavy N+1 database queries, the Patient 360 endpoints were split into a glance summary endpoint (`/360/summary`) and a cursor-paginated timeline endpoint (`/360/timeline`). A unified smart-search for patient ID and bill lookup was also integrated.
3. **Owner Audit Fields:** Added tracking for `discountedByUserId`, `refundReason`, and `refundedAt` on Bills. Additionally, `MessageLog` now tracks `branchId` (and its `patientId` is now nullable to support B2B statements like payouts).
4. **React Query Partial Adoption:** Incremental migration is underway for `@tanstack/react-query`, including the setup of shared infrastructure (`useApiQuery`, `useApiMutation`, `queryClient` singleton) that supports branch-scoped cache flushing.

## Which Docs Were Updated
- `ARCHITECTURE.md`: Added the new `ExternalLab`, `ExternalLabProductRule`, and `StatementAccessToken` models to the 'Operational' schema table. Clarified the `MessageLog` nullability for `patientId`. Updated the known architectural debt section regarding the ongoing `@tanstack/react-query` migration.
- `CHANGELOG.md`: Documented the Payouts Redesign, Patient 360 Rewrite, and Owner Audit Fields under the `[Unreleased]` section.

## Which Docs Should Be Reviewed Manually
- `documentation/react-query-migration-playbook.md` (To track ongoing migration progress)
- `documentation/patient360-redesign/04-decisions.md` (and other redesign plans in the `patient360-redesign` folder for completeness).

## Undocumented Architectural Decisions Discovered
None. All major architectural changes, such as the Payouts redesign database schema and Patient 360 backend refactor, were well-documented via pull requests and specific plan markdown files within the repository.
