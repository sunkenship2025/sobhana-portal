# HealthFlow / Sobhana — Consolidated Remediation Backlog

**Date:** July 3, 2026. Synthesizes six audits (branding, multi-tenant isolation §17, authorization §18, appsec §19, clinical safety §20, financial correctness — *pending*) plus dependency/secrets findings. Full detail lives in `HEALTHFLOW_SELFHOST_PLAN.md`; this is the ordered worklist.

**Ordering principle (the key output of the whole audit):** the single-tenant app has live patient-safety and security defects. Fix the app first, *then* multiply it by 25. Multi-tenancy and hosting are **P1**, not P0 — because P0 bugs are already hurting Sobhana's real patients and data today.

Effort: **S** ≤half-day · **M** 1–3 days · **L** week+. Source refs point at the plan doc sections.

---

## P0 — Fix before anything else (live in Sobhana prod today; patient safety + exploitable security)

These do not depend on HealthFlow. Ship them to the current app now.

### Patient safety (§20) — highest priority
| ID | Item | Where | Effort |
|----|------|-------|--------|
| P0-1 ⤳ SUPERSEDED (user reverted display in aec6d1e — critical renders as plain High/Low; threshold DATA retained) | **Render critical/panic values distinctly** (own row/colour/"see doctor immediately"); `computeFlag` must read `criticalMin/criticalMax` and return CRITICAL_HIGH/LOW | `reportRendererService.ts:184-190`, `renderTestRow` | M |
| P0-2 ⏭️ (display in report+preview done; result-entry threading + threshold data SKIPPED, user Jul 3) | **Add a panic-value alert** on result save/finalize (WhatsApp/in-app to owner+ordering staff) — currently zero alerting exists | `diagnosticVisits.ts:~3697` | M |
| P0-3 ⤳ SUPERSEDED (see P0-1; FlagBadge maps CRITICAL→High/Low per user decision) | **`FlagBadge` CRITICAL styling** (currently renders as unstyled grey text) | `flag-badge.tsx:3-12` | S |
| P0-4 ✅ | **Stop finalized reports mutating retroactively** (lab incharge) — freeze snapshot identity + signature *bytes*, fall back to live only for null fields (old snapshots); doctor NEW path already correct, old-format doctor snapshots (Finding 13) still re-fetch live — smaller edge, tracked in P0-5 — snapshot signatory identity must use frozen values, not live DB re-hydration (lab incharge + old-format signing rules) | `reportSnapshotService.ts:1817-1838, 1810` | M |
| P0-5 ✅ | **Version or freeze legacy `LabTest` range edits** — in-place edits change historical + in-flight reports | `labTests.ts:215-218, 330-332` | M |
| P0-6 ✅ | Legacy path must evaluate critical thresholds (fallback to `TestDefinition.criticalMin/Max`) or block critical-bearing tests on legacy | `referenceRangeService.ts:160-163` | M |
| P0-7 ⏭️(skip, clinical convention is fine) | **Inclusive boundary flags** — `>=`/`<=` (value exactly at limit currently shows NORMAL); align with the interpretation engine | `reportRendererService.ts:187`, `reportSnapshotService.ts:557`, `diagnosticVisits.ts:204` | S |

### Security exploitable now (§18, §19)
| ID | Item | Where | Effort |
|----|------|-------|--------|
| P0-8 ✅ | **Path-traversal arbitrary file read** — bound `inlineSignatureImage` to `PUBLIC_DIR` + role-gate the signing-doctor PATCH (currently reads `../../.env` = live creds into a PDF) | `reportRendererService.ts:60-74`, `signingDoctors.ts:217` | S |
| P0-9 ⏭️(by design; tenant-scoped at P1) | **`X-Branch-Id` trusted with no membership check** — any user acts as any branch (cross-branch IDOR now; the tenant selector later) | `middleware/branch.ts:77-94` | M |
| P0-10 ⏭️(by design; open intra-org) | **`GET /api/bills/:domain/:visitId` fully unscoped** — any authed user reads any visit's financials + PII by id | `bills.ts:11,25` | S |
| P0-11 ⏭️(by design; open intra-org) | **Patient read/edit/search unscoped** — any authed user reads/edits/searches any patient globally | `patientService.ts:316,1126`, `patients.ts:57` | M |
| P0-12 ✅ | **`doctor` role can do financial/clinical writes** — refunds, self-referral re-attribution, price edits, finalize. Gate to staff/owner; make doctor read-mostly | `diagnosticVisits.ts:2601,2870`, `billableProducts.ts:733` | M |
| P0-13 ✅ | **Delete the boot-time "TEMPORARY DB UPDATE SCRIPT"** — runs `updateMany` on every process start | `index.ts:385-399` | S |
| P0-14 ⏭️(later, user) | **Fix broken user creation** — `register` gated on `admin` (never issued); move to `owner`; **reconcile the seed** to create bootstrap user as `owner` | `auth.ts:152`, `prisma/seed-tenant.ts` | S |

### Money corruption live now (§21 financial) — ✅ ALL FOUR FIXED (typecheck clean; uncommitted; not yet runtime-tested)
| ID | Item | Where | Effort |
|----|------|-------|--------|
| P0-19 ✅ | **Refunds counted as positive income** — `recomputeBillFinancialsForSubtotal` sums transactions without checking `transactionType`, so adding/removing a test on any previously-refunded bill permanently corrupts `paidAmountInPaise` (and blocks test removal). Fires on a single normal request. Mirror the REFUND-subtract logic already in `computeBillFinancialsFromPersisted:100-107` | `billFinancialService.ts:247-250` | S |
| P0-20 ✅ | **Concurrent-refund double-payment** — refund reads/validates outside the `$transaction` and there's no UNIQUE on `OrderRefund(testOrderId)`; a double-tap issues 2× refunds + 2× payout reversals. Add unique constraint + re-validate inside the txn (or optimistic lock) | `diagnosticVisits.ts:2601-2745`, migration | S/M |
| P0-21 ✅ | **Clinic payout writes full consultation fee, not commission** — COMPLETED transition sets `derivedAmountInPaise = consultationFee` (ignores `clinicCommissionPercent`); doctor overpaid every visit. Apply the percent like `deriveClinicPayout` does | `clinicVisits.ts:827-863` | S |
| P0-22 ✅ | **Refunded bills show phantom dues** — outstanding = `total − discount − paid` never subtracts `reversedChargeInPaise`; every refund permanently inflates owner-dashboard receivables | `ownerMoneyService.ts:422-460`, `ownerMetricsService.ts` | S |

### Secrets hygiene (Phase 0)
| ID | Item | Where | Effort |
|----|------|-------|--------|
| P0-15 ✅(tracking; history+rotate = you) | **Delete live prod DB dump from repo** (real patient audit logs/IPs/emails); purge from git history if pushed | `extras/pre-onboarding-backup-2026-05-04.sql` | S |
| P0-16 ✅(tracking; rotate key = you) | **Remove `go-proxy.js` + rotate** its live opencode key | repo root | S |
| P0-17 | **Rotate live Neon + WhatsApp creds** sitting in on-disk `.env` (compounded by P0-8) | `health-hub-backend/.env` | S |
| P0-18 | Keep real doctor **signature PNGs out of any shipped image** | `public/images/signatures/*` | S |

---

## P1 — Fix before multi-tenant launch (isolation blockers; each becomes a cross-tenant leak at 25×)

### Foundational tenancy (§17)
| ID | Item | Where | Effort |
|----|------|-------|--------|
| P1-1 | **Per-tenant `PrismaClient` cache** replacing the single global (48 importers; `tenantId` resolved before any service call) — everything else depends on this | `lib/prisma.ts` + 48 sites | L |
| P1-2 | **JWT tenant binding** — per-tenant secret (or mandatory `tenantId` claim checked vs resolved tenant); a token must not verify cross-tenant | `authService.ts:181`, `auth.ts:79` | M |
| P1-3 | **ownerMetrics cache tenant prefix** — active cross-tenant financial-metrics leak the moment two tenants hit the dashboard | `ownerMetricsService.ts:23` | S |
| P1-4 | **Tenant-prefix ALL Redis keys** + separate security counters from evictable PDF cache (LRU can currently evict lockout keys) | `loginLockout.ts`, `rateLimit.ts`, `mergedReportPdfCache.ts`, owner caches | M |
| P1-5 | **Real client IP behind Cloudflare** — trust CF ranges + `CF-Connecting-IP` (current `trust proxy:true` is spoofable) | `index.ts:89`, `rateLimit.ts:85` | S |
| P1-6 | **Tenant-scope login lockout key** (`support@healthflow.in` exists in every tenant → one lock hits all 25) | `loginLockout.ts:27-28` | S |
| P1-7 | **WhatsApp per-tenant** — `phone_number_id→app_secret` lookup before HMAC verify; per-tenant outbound number/token (DB-stored, not env) | `routes/webhooks.ts`, `whatsappCloudService.ts` | M |
| P1-8 | **`/ready` checks shared infra only** — not a tenant DB (else one down tenant 503s the whole origin, or masks a real outage) | `healthChecks.ts:74` | S |
| P1-9 | **Branding globals → per-request/per-tenant** (logo, CSS, timezone, formatters frozen at boot today) | `reportRendererService.ts:32-36`, `mergedReportPdfService.ts:78`, `billPdfService.ts:33` | M |
| P1-10 | **Per-request tenant-tagged logging** (`logger.child({tenantId})`) — 25 tenants interleaved is undebuggable otherwise | `logger.ts`, pino-http | S |
| P1-11 | **Four hardcoded `IST_OFFSET_MS`** → shared `getTodayBoundary(tz)` on tenant timezone | owner services | S |
| P1-12 | **R2 per-tenant key prefix** (+ consider per-tenant bucket) | `r2StorageService.ts:113` | S |

### Provisioning + release (§A1, A7)
| ID | Item | Where | Effort |
|----|------|-------|--------|
| P1-13 | **Fix the migration baseline** — squash a clean `0000_init` from `schema.prisma` (none of 54 migrations create the new-arch tables → `migrate deploy` fails on fresh DB) | `prisma/migrations` | M |
| P1-14 | **De-hardcode branding** into `LabProfile` + `Branch` cols (~20 files: PDF services, CSS, Login/Sidebar, legal pages, WA templates) — ship to Sobhana as a no-op first | Appendix A4/A5, §9 | L |
| P1-15 | **Retire `seed.ts`/`seed-full-catalog.ts`**; wire `seed-tenant.ts` + `LabProfile` into `new-tenant.sh` | `prisma/` | S |
| P1-16 | **Tokened links expire** (90d default) + revocation path; stop trimming token to 12 chars | `*AccessService.ts`, `notificationService.ts` | S |
| P1-17 | Result-entry auto-flag must use the **correct range path** for new-arch tests (passes `undefined` today → wrong flags at entry) | `diagnosticVisits.ts:3663` | M |
| P1-18 | Client-submitted flag must not persist when auto-flag throws | `diagnosticVisits.ts:3596,3701` | S |
| P1-19 | Snapshot-creation failure after finalize must not leave report permanently 404 (retry/alert/transactional) | `diagnosticVisits.ts:4661` | M |

---

## P2 — Fix before scale / production hardening

| ID | Item | Where / note | Effort |
|----|------|------|--------|
| P2-1 | **Dependency CVE upgrades** — backend 24 (2 crit/8 high), frontend 15; bump Node 18 (EOL)→22/24 | both `package.json`, Dockerfile | M |
| P2-2 | **Encryption at rest & in transit** — Hetzner disk LUKS, Redis AUTH+TLS, DB TLS, encrypted backups | infra | M |
| P2-3 | **Tested DR** — per-tenant `pg_dump`→B2, Hetzner auto-backup, and a *rehearsed* restore (untested backup = hope) | infra §10 | M |
| P2-4 | **Monitoring/alerting** — BetterStack + status page + tenant-tagged errors; paging | §10 | M |
| P2-5 | **Capacity/load test** — one box at 25-tenant peak; N+1 sweep of the 5,000-line `diagnosticVisits.ts`; Chromium under load; pool exhaustion; leaks | — | L |
| P2-6 | **PDF queue fairness** — per-tenant slot budget (one tenant's batch starves all) + rate-limit authed PDF endpoints (auth DoS) | `pdfGenerationService.ts`, `diagnosticVisits.ts:4154,4289` | M |
| P2-7 | **Server-side unit validation** on result entry (wrong-unit → false critical/normal) | result save path | M |
| P2-8 | **Age from true DOB** not `yearOfBirth` Jan-1 (±364d → wrong infant ranges) | `referenceRangeService.ts:26` | S |
| P2-9 | Order-time (not latest) formula in snapshots; gender-range sort gap; notes-only finalization; `collectedAt` real time | §20 mediums | M |
| P2-13 | Financial mediums — `PATCH paidAmount` can set cache below actual txn sum; split `payments[]` not validated to equal declared `paidAmount`; CHEQUE silently recorded as CASH | §21: `diagnosticVisits.ts:2397,1985,2548` | M |
| P2-10 | **JWT revocation on logout** (Redis `jti` blocklist); `/ready` stop leaking infra detail; non-prod CORS allowlist; generic Prisma errors in prod | §19 | M |
| P2-11 | **Single-box SPOF** decision — accept + fast-rebuild runbook, or HA | infra §14 | M |
| P2-12 | **mXSS hardening** — sanitize narrative HTML on write; isolate Chromium (no-network container / restore sandbox) | `clinicalPanels.ts`, `pdfGenerationService.ts:119` | M |

---

## P3 — Before selling / commercial + compliance

| ID | Item | Effort |
|----|------|--------|
| P3-1 | **DPDP compliance** — consent, data-subject rights, retention, breach-notify; **processor/controller DPA per clinic** | L |
| P3-2 | **Right-to-erasure** across tenant DB + R2 + Redis + backups + logs (tenant offboarding) | M |
| P3-3 | **Per-tenant ToS / Privacy / Data-deletion** pages (currently hardcoded to Sobhana) | S |
| P3-4 | **Licensing** — replace the unlicensed Pngtree image; verify PDF font-embedding + dependency licenses for resale | S |
| P3-5 | **Audit-trail completeness & tamper-evidence** review (`AuditLog` coverage) | M |
| P3-6 | **Your subscription billing / dunning / suspension** for the 25 clinics (revenue) | M |
| P3-7 | **i18n/currency** centralization (₹/en-IN pervasive) — only when Vietnam/non-INR lands | M |
| P3-8 | **Pre-launch pen-test / threat model** by a third party | — |

---

## All six audits complete
Branding · isolation (§17) · authz (§18) · appsec (§19) · clinical (§20) · financial (§21). Financial core is mostly sound (integer paise, conserved rounding, atomic bill creation, `SELECT FOR UPDATE NOWAIT` sequences, guarded double-pay) — the bugs are specific: refund accounting (P0-19), concurrent-refund race (P0-20), clinic commission (P0-21), phantom dues (P0-22).

## Suggested sequencing
1. **P0 patient-safety (P0-1..7)** — this week, to the live app. Nothing about HealthFlow should jump ahead of a mis-rendered panic value.
2. **P0 security + secrets (P0-8..18)** — same window; several are one-liners.
3. Then **P1** as the actual HealthFlow build (tenancy refactor is the spine: P1-1 → P1-2 → the rest).
4. **P2** hardening in parallel with piloting client #1.
5. **P3** before signing paying clients.
