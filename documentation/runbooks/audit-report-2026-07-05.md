# Documentation Audit Report - 2026-07-05

## What changed
- Added `/api/external-labs` endpoints for managing outside labs and their payout configurations.
- Added `/api/payouts/:id/send-statement` endpoint for sending payout statements via WhatsApp.
- Added `/api/visits/diagnostic/:id/refund` and `/api/visits/diagnostic/:id/swap-product` endpoints for order refunds and typo fixes respectively.
- Added `/api/users/:id/role` for globally scoped user role management.
- Updated RBAC roles: `doctor` role was removed, and `lab_incharge` and `sales` roles were added to support lab operations and sales operations.

## Which docs were updated
- `documentation/API.md`: Documented new endpoints for external labs, users, order refunds, product swaps, and payout statements.
- `documentation/ARCHITECTURE.md`: Updated the `Roles` section and routing roles to reflect the removal of `doctor` and addition of `lab_incharge` and `sales`.

## Which docs should be reviewed manually
- Additional architectural documents, such as `DECISIONS.md`, may need a review if the removal of the `doctor` role or the introduction of the new `HealthFlow` taxonomy (module feature toggles) constitutes a significant architectural shift that requires a new ADR.
- Frontend role-gated routes and UI might need an audit to confirm they perfectly align with the new `lab_incharge` and `sales` RBAC capabilities.

## Undocumented architectural decisions discovered
- Extracting `HealthFlow` into a separate repository (Sobhana untouched), as noted in recent commits, appears to be a significant repository strategy decision that may warrant an ADR in the future.
- The use of token-gated public endpoints for statement viewing (`/statements/view/:token`) and the QR code for bill printing were partially documented but represent an architectural pattern for external facing resources.
- `AuditLog` retention policy (keep-forever) and legal record erasure-exemption might need formal documentation.
