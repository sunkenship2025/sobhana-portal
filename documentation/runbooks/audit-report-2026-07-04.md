# Documentation Update Summary Report (2026-07-04)

## What Changed
Since the last documentation audit run on 2026-06-22, the following significant changes were integrated into the main branch:
1. **Payouts Redesign & External Labs:** Implemented a comprehensive redesign of the payouts system. Added the `ExternalLab` and `ExternalLabProductRule` schema entities to handle tracking and overriding rates for outsourced vendor labs. Updated the terminology from "payment" to "settlement" and mapped external lab payouts to the `DoctorPayoutLedger` with a `LAB` doctor type. Added functionality to generate and send token-gated payout statements via WhatsApp.
2. **Token Gateway Security Hardening:** Hardened security on public token-gated links (reports, bills, and statements) by adding `StatementAccessToken` and `revokedAt` tracking to prevent access once underlying documents are voided.
3. **Roles and Access Control:** Introduced new `Lab Incharge` and `Sales` system roles with specific per-role access controls.
4. **HealthFlow Module:** Added the initial taxonomy and module structure for a new `HealthFlow` feature set. Architectural decision made to maintain this in a separate, isolated repository.
5. **Patient 360 & Money Dashboard Improvements:** Enhanced the Patient 360 inspector to handle cancel/refund flows properly and tightened delivery statuses. Money dashboard was upgraded with cash/online splits, period Due KPIs, and cancellation/refund surfacing.
6. **React Query Migration Progress:** Migrated `ManageClinicDoctors` and `ManageDoctors` pages to use `@tanstack/react-query`, along with establishing a shared migration layer.
7. **Diagnostics & Pending Workflow:** Upgraded the pending workflow to support a "no report needed" (films only) state specifically for X-ray/EXTERNAL_UPLOAD items, ensuring pending queues are kept clean.

## Which Docs Were Updated
- `CHANGELOG.md`: Added entries for Payouts Redesign, Token Security Hardening, new Roles, HealthFlow module, Patient 360 improvements, and React Query migration under the `[Unreleased]` section.
- `ARCHITECTURE.md`: Documented the new token gateway security flow, the HealthFlow split-repository strategy, and the External Lab payout approach.
- `API.md`: Documented new token-gated gateways and external lab payout endpoints.

## Which Docs Should Be Reviewed Manually
- `documentation/patient360-redesign/*` (Multiple design documents regarding the patient 360 interface redesign)
- `documentation/react-query-migration-playbook.md` (Update the playbook with recent migration findings)

## Undocumented Architectural Decisions Discovered
None. All major architectural decisions (such as the token gateways and HealthFlow separation) were either documented via the PRs or have now been incorporated into `ARCHITECTURE.md`.
