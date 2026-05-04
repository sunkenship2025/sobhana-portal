# Security Policy

## Reporting a vulnerability

If you've found a security issue in Sobhana Portal — a way to access patient data without authorization, leak credentials, bypass authentication, escalate privileges, or otherwise compromise the system — please report it privately.

**Do not** open a public GitHub issue or pull request for a security concern.

**Email:** `pranav@sobhana.com` (replace with the real maintainer address)
**Subject line:** `[SECURITY] <short description>`

In your report include:
- A description of the issue and what you can do with it
- The steps to reproduce (URLs, payloads, accounts used if any)
- The environment (production / staging / local)
- Your name and how you'd like to be credited (or stay anonymous)

We aim to acknowledge a report within **72 hours** and produce a status update within **7 days**.

---

## Scope

In scope:
- The deployed Sobhana Portal application (frontend + backend)
- Authentication, authorization, session handling
- Public report-access tokens
- API endpoints under `/api/*` and the public `/reports/:token` route
- Payment-related endpoints
- WhatsApp webhook (`/webhooks/whatsapp`)

Out of scope:
- Issues in third-party services (Neon, Render, Cloudflare R2, Meta Cloud API, Sentry) — report those upstream
- Social engineering of staff
- DDoS / volumetric attacks
- Best-practice findings without an exploit (e.g., "you don't have CSP" — known; tracked in [`DECISIONS.md`](documentation/DECISIONS.md) ADR-015)
- Self-XSS

---

## Disclosure

We'll work with you on a coordinated disclosure timeline:

1. We acknowledge the report
2. We confirm reproduction and triage severity
3. We develop and test a fix
4. We deploy the fix and verify in production
5. We rotate any compromised credentials
6. We disclose publicly after a reasonable embargo (typically 30 days post-fix)

If you'd like to be credited in the disclosure, let us know in your report.

---

## What we won't do

- We will not pursue legal action against good-faith researchers acting within the scope above.
- We will not require a non-disclosure agreement to receive your report.
- We will not pay a bounty (this isn't a paid bug-bounty program — small project).

---

## What we ask of you

- Stop testing and report immediately if you stumble on real patient data. Do not download, copy, store, or share it.
- Use a test account for any active probing. Don't probe other users' accounts.
- Don't social-engineer staff or do phishing tests without explicit written permission.
- Give us a reasonable window to fix before any public disclosure.

---

## Security posture (current state)

For full transparency, here's where the codebase stands today. New contributors should know what's solid, what's known-weak, and what's being worked on.

### What's in place

- HTTPS in production (Render terminates TLS).
- Helmet for security headers (note: CSP currently disabled — see below).
- Strict CORS allowlist via `FRONTEND_URL` in production.
- JWT bearer auth (HS256) + bcrypt password hashing.
- Login rate-limiting and per-account lockout via Redis.
- Append-only `AuditLog` for sensitive actions.
- All Prisma queries are parameterized — no string-interpolated SQL.
- Public report tokens are 12-char base64url (~72 bits entropy), stored as SHA-256 hashes — bearer never persisted.
- Every public report access is logged in `ReportAccessLog` with IP/UA.
- Sentry error tracking on backend; Pino structured logs.
- Branch isolation enforced at the application layer on every Prisma query.

### Known weaknesses (tracked, not yet fixed)

These are documented openly so they're not surprises. See [`DECISIONS.md`](documentation/DECISIONS.md) ADR-015.

- **JWT stored in localStorage** — XSS-vulnerable. No refresh token; no MFA. Session revocation is via JWT expiry only (7 days).
- **CSP is disabled** in Helmet config (`contentSecurityPolicy: false`). XSS surface is unrestricted.
- **No automated security tests** in CI. No CI at all yet.
- **Dependency vulnerabilities** — `npm audit` shows several. Renovate / Dependabot not yet configured.
- **PHI in logs is not redacted** — Pino has a `redact` config that should be enabled.
- **No documented data-retention policy** — patients have a request page (`/legal/data-deletion`) but no automated purge.
- **Branch-isolation discipline is application-only** — no Postgres Row Level Security. One missed `branchId: req.branchId` filter in a future query is a cross-branch data leak.
- **No backup/restore drill** has been run. Neon has automatic backups; we've never tested a restore.
- **`.env` was historically committed** — anything in it must be considered compromised. Rotate all credentials per the [secret-rotation runbook](documentation/runbooks/rotate-secrets.md) before relying on this protocol.

### Active hardening work

- Enable Pino redaction for PHI fields (in progress).
- Re-enable CSP with a tested policy.
- Move JWT to httpOnly + Secure + SameSite=Strict cookie; add CSRF token.
- Add MFA for owner accounts.
- Add automated dependency scanning to CI (when CI exists).
- Add a backup-restore drill to the runbooks and run it quarterly.

If you find anything that's not on this list, please report it.

---

## Compliance

The Sobhana Portal handles **personal health information**. The Indian context applies the **Digital Personal Data Protection Act, 2023 (DPDP Act)**.

- A privacy policy and data-deletion request page are available at `/legal/privacy-policy` and `/legal/data-deletion`.
- Encryption at rest is enabled by default by Neon (Postgres) and Cloudflare (R2). HTTPS in transit.
- Audit log retention is currently indefinite (no automated purge).
- Patient consent for WhatsApp delivery is captured at registration (`Patient.whatsappOptIn`).

If you're an auditor or regulator: contact the maintainer at the address above.
