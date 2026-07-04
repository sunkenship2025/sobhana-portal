# HealthFlow Self-Hosting Plan — Review Document

**Date:** July 3, 2026
**Scope:** Migrate the sobhana-portal stack (Render backend + Neon Postgres + Vercel frontend) to a single Hetzner server serving up to 25 white-labeled clinic clients ("HealthFlow"), with a unified backend, unified DB server, and per-client static frontends.
**Assumed load:** ~500 patients/month per client × 25 clients ≈ 12,500 visits/month total.

**How this was produced:** three research passes — (1) an exhaustive codebase audit of every hardcoded client-specific element, (2) an infrastructure research sweep (Hetzner, Coolify, Neon, backups, DPDP), and (3) an independent fact-check of every load-bearing number against vendor primary sources. Verification status is marked throughout: ✅ verified against vendor pages, ⚠️ could not be verified (check yourself, noted in §13).

---

## 1. Decision summary

| Decision | Choice | One-line why |
|---|---|---|
| Server | **Start CX23** (2 vCPU / 4 GB, €5.49/mo) for the first few clients → **resize to CX33** (8 GB) on a memory-pressure signal | Resize is a 2–5 min reboot, reversible → **no penalty to starting small**. Dropping Coolify (plain compose) freed the ~700 MB that made 4 GB tight. CX43 (16 GB) only well past 25 clients |
| Location | **Germany (Falkenstein/Nuremberg)** to start; evaluate Singapore | FRA→India ~126 ms vs SIN→India ~62 ms; SIN costs ~20–40% more and lacks Object Storage; movable later via snapshot |
| Backend | **One unified Node process**, tenant bound at login into the JWT | Shares the single Puppeteer Chromium; 25 processes would mean 25 Chromiums |
| Database | **Self-hosted Postgres on the same box, one database per tenant** | Zero data-model changes, hard isolation for medical data, per-client dump/restore; Neon rejected (see §6) |
| Redis | One Redis container, tenant-prefixed keys | Backend requires Redis in production (rate limit, login lockout, PDF cache) |
| Deploy tooling | **docker-compose + Caddy + GitHub Actions** (full comparison §8; Coolify only if you want a web dashboard) | Unified backend = 3 containers; a PaaS adds ~700 MB + an admin attack surface on a patient-data box to manage what one compose file holds |
| URLs | Frontend `client.healthflow.in`; **one** backend `api.healthflow.in`; tenant bound at login into the JWT (§3.1) | One DNS record, one cert, no per-client backend config; tenant identity comes from auth, not spoofable headers |
| Frontend | **Cloudflare Pages, one project per client** — *not* Vercel Hobby | Vercel Hobby explicitly prohibits commercial use (§7); CF Pages is free with no such written ban and has India edge PoPs |
| Backups | Hetzner auto-backup (+20%) + nightly per-tenant `pg_dump` → Backblaze B2 (10 GB free) | Two independent recovery paths; B2 free tier covers years at this data volume |
| Node version | Bump Dockerfile from node:18 (EOL March 27, 2025) to **node:22** (Maintenance LTS) or **node:24** (Active LTS) | 18 is unsupported; do it while touching the Dockerfile anyway |

**Steady-state cost: ~€10.70/month (~₹1,050) for the entire backend + DB serving all 25 clients.** Marginal cost per additional client ≈ €0.

---

## 2. Current stack (audit findings)

- **Backend** `health-hub-backend/`: Node 18 + Express 4 + TypeScript, Prisma 5.7, Puppeteer 24 (PDF reports), pdf-lib (letterhead overlay on uploaded PDFs), ExcelJS (payout exports), ioredis, Sentry. A two-stage **Dockerfile already exists** (node:18-slim, system Chromium, `prisma migrate deploy` on boot, port 10000).
- **Frontend** `health-hub/`: React 18 + Vite 5 static SPA, shadcn/Tailwind, deployed on Vercel (`vercel.json` SPA rewrite). Only needs `VITE_API_BASE_URL` at build time.
- **Database**: 54 Prisma models. **No Neon-specific code anywhere** — no `@neondatabase/serverless`, plain `PrismaClient`; Neon-ness is confined to the connection-string shape. Migration is a dump/restore + env-var change.
- **Existing tenancy**: a `Branch` model (code, name, **address, phone**) scopes Visits/Bills/AuditLogs/etc. via `branchId`. There is **no organization/tenant level above Branch**, and no settings/branding table — all branding is hardcoded in source (§9).
- **Resource profile**: singleton Chromium kept alive (~100–200 MB idle, +80–150 MB per concurrent PDF, concurrency capped by `PDF_MAX_CONCURRENT`, default 2, max 4). No cron jobs, no image processing. Redis is mandatory in prod.

---

## 3. Target architecture

```
        Cloudflare (free) — healthflow.in zone, wildcard *.healthflow.in, proxied, edge SSL
             │
  clienta.healthflow.in   clientb.healthflow.in   demo.healthflow.in    status.healthflow.in
  (CF Pages, per-client   (CF Pages)              (permanent sales      (BetterStack status
   build-time branding)                            demo tenant)          page, free)
             │                    │                     │
             └────── all frontends call ──────► api.healthflow.in  (ONE backend URL)
                                                        │
                                     ┌──────────────────▼──────────────────┐
                                     │  Hetzner CX33 (Ubuntu 24.04)        │
                                     │   Caddy (auto-TLS, reverse proxy)   │
                                     │   health-hub-backend ×1             │
                                     │    · login binds tenant → JWT       │
                                     │    · PrismaClient-per-tenant cache  │
                                     │    · shared Chromium singleton      │
                                     │   Postgres ×1 (db_clienta, …×25)    │
                                     │   Redis ×1 (tenant-prefixed keys)   │
                                     │   — all in one docker-compose —     │
                                     └──────────┬──────────────────────────┘
                                                │ nightly pg_dump per tenant
                                                ▼
                                Backblaze B2 (offsite) + Hetzner auto-backup (whole VM, 7 slots)
```

### 3.1 Domain & URL architecture (healthflow.in — decided)

**Frontend: `client.healthflow.in`** — each CF Pages project gets its client subdomain as a custom domain. One Cloudflare Universal SSL wildcard (`*.healthflow.in`) covers every single-level subdomain for free. Client sees only their own branded domain — this is part of the white-label sell.

**Backend: one URL for everyone — `api.healthflow.in`.** Three options were considered:

| Option | How | Verdict |
|---|---|---|
| **A. Single `api.healthflow.in`** ← chosen | Tenant slug baked into each frontend build (`VITE_TENANT=clienta`), sent only on the login request; backend validates it, issues a JWT carrying `tenantId`; **every request after login derives tenant from the JWT only** | One DNS record, one cert, zero per-client backend config, tenant identity is cryptographically bound to the session instead of trusted from a header. CORS = allow `https://*.healthflow.in` |
| B. Per-client API subdomain (`clienta-api.healthflow.in`) | Host-header routing | Works and stays inside the wildcard cert, but the natural spelling `api.clienta.healthflow.in` is a **two-level** subdomain — Cloudflare's free Universal SSL does NOT cover `*.*.healthflow.in` (needs Advanced Certificate Manager, $10/mo). So you'd be stuck with ugly `clienta-api` names, 25 hostnames in monitoring/CORS/logs, for a benefit (per-client rehoming via DNS) you can add later with a Cloudflare Worker if ever needed |
| C. Path-based (`api.healthflow.in/t/clienta/...`) | Tenant in URL path | Touches every route definition and every frontend API call. Rejected |

**Non-browser entry points under option A** (these can't rely on a frontend-injected slug):
- **Public tokenized links** (WhatsApp report/bill/statement URLs): the token is already looked up in the DB — the lookup happens in a small control table that maps token → tenant → tenant DB. No URL change needed.
- **WhatsApp webhook** (one URL for all clients): map incoming `phone_number_id` → tenant registry.
- **Health checks / monitoring**: tenant-agnostic, hit `/health` directly.

**Reserved subdomains to set up day one:** `api`, `demo` (sales demo tenant — doubles as the live demo for the outreach campaign), `status` (BetterStack public status page — cheap trust signal when selling ₹999/mo to skeptical lab owners), `staging` (internal test tenant that receives every deploy first).

---

## 4. Server sizing — why CX33, not CX23 or CX43

⚠️ **Naming correction:** Hetzner renamed the CX family. The current plans are **CX23 / CX33 / CX43** (not CX22/CX32/CX42 as on older blog posts). Specs are identical to what you quoted; prices rose ~30% on **June 15, 2026** (✅ verified against Hetzner's own price-adjustment doc):

| Plan | Specs | €/mo (excl. VAT, excl. IPv4) | Old price |
|---|---|---|---|
| CX23 | 2 vCPU / 4 GB / 40 GB | €5.49 | €3.99 |
| **CX33** ← pick | **4 vCPU / 8 GB / 80 GB** | **€8.49** | €6.49 |
| CX43 | 8 vCPU / 16 GB / 160 GB | €15.99 | €11.99 |

ARM (CAX) plans are no longer cheaper per GB of RAM after the price change — no reason to pick them.

**RAM budget (no Coolify — plain compose):**

| Component | Estimate |
|---|---|
| OS + Docker daemon | 300–500 MB |
| Reverse proxy (Caddy) | 50–100 MB |
| Backend Node process | 200–400 MB |
| Chromium (idle → 2 concurrent PDFs) | 200–500 MB |
| Postgres (small DBs, `shared_buffers` scaled to box) | 300–600 MB |
| Redis | 50–100 MB |
| **Total** | **~1.1–2.2 GB** |

**Start CX23 (2 vCPU / 4 GB, €5.49):** dropping Coolify freed the ~700 MB that made 4 GB tight, so at a few clients this leaves ~2 GB headroom — comfortable. **Resize to CX33 (8 GB) on the memory-pressure signals** (§17 / the scale table) as you approach ~8–10 clients — a 2–5 min reboot, reversible, so no penalty to starting small. Not CX43 (16 GB) until well past 25 clients.

**Guardrails regardless of size:** set `--memory` limits on every container (Node 20+ sizes its heap off the cgroup limit; without one it targets 50% of *host* RAM), add a 4 GB swapfile with `vm.swappiness=10` as an OOM guard, and **never build Docker images on the box** — build in GitHub Actions, push to GHCR, deploy the image.

Hetzner supports live rescale (CPU/RAM-only rescale is reversible), so upgrading later is a reboot, not a migration.

---

## 5. Location: Germany vs Singapore

⚠️ **Latency correction from fact-check:** Singapore→Mumbai is **~62 ms** RTT (AWS inter-region data), not the 30–50 ms sometimes claimed. Frankfurt→Mumbai is **~126 ms** (✅ verified directionally).

- Your users are clinic receptionists doing rapid CRUD all day. A screen making 3–4 serial API calls costs ~380–500 ms of pure network from Germany vs ~190–250 ms from Singapore. Noticeable, not fatal.
- Mitigations that work from Germany: Cloudflare proxy (static assets and the SPA itself come from India edge PoPs), TanStack Query caching (already in the app), batching serial calls.
- Singapore trade-offs: ~20–40% price premium (⚠️ exact % unverified — check console), much pricier traffic overage (~€7.40/TB vs €1/TB EU — irrelevant for JSON), **no Hetzner Object Storage in SIN** (EU-only — backups to B2 unaffected), and ⚠️ **it is unconfirmed whether x86 CX plans are even orderable in Singapore** (possibly only CPX/CAX there — check console).

**Recommendation: start in Germany.** It's cheaper, everything is available there, and if latency complaints materialize you can snapshot-migrate to Singapore in an afternoon. Decide with data, not upfront.

---

## 6. Database: self-hosted, database-per-tenant

### Why not stay on Neon
All figures ✅ verified against neon.com/pricing:
- **Free plan:** 100 projects/org (so 25 clinics fit), but **0.5 GB storage per project** — diagnostic report history will hit that — and **forced scale-to-zero after 5 min**, meaning every clinic's first request each morning eats a multi-second cold start. Bad UX for a reception desk.
- **Launch plan:** pure usage — $0.106/CU-hour + $0.35/GB-mo. 25 computes kept warm through business hours lands anywhere from ~$30–80/mo (light) to $200+/mo (10 active h/day). Self-hosted costs €0 marginal on a box you already pay for.

### Why database-per-tenant (not one DB with tenantId, not schemas)
1. **One shared database + `tenantId` column** would require adding an organization FK to ~54 models and auditing every query. One missed `where` clause = Clinic A sees Clinic B's patients. In healthcare, that's the disqualifying failure mode. Rejected.
2. **Schema-per-tenant** — light, but schemas alone are not a security boundary (needs per-tenant roles/RLS done correctly), and Prisma's schema-switching story is awkward. Rejected.
3. **Database-per-tenant** ← chosen. Each tenant DB is byte-identical in shape to today's Sobhana DB → **zero data-model changes**. Hard isolation. Per-client `pg_dump -Fc` backup/restore. Offboarding = `DROP DATABASE`. Overhead per extra DB is a few MB — trivial at 25.

### Implementation notes
- **Connection pools:** PrismaClient's default pool is ~`num_cpus × 2 + 1` per client. 25 tenants × 9 = 225 connections > Postgres's default 100. Set `?connection_limit=2` (or 3) in each tenant's DATABASE_URL → ~50–75 connections, each ~5 MB. No PgBouncer needed at this scale.
- **PrismaClient cache:** lazy-instantiate per tenant on first request, keep in a Map. 25 clients is well within comfort.
- **Migrations:** ⚠️ first fix the broken history (A1 blocker) — squash a clean `0000_init` baseline from `schema.prisma` so `migrate deploy` works from zero. Then replace the Dockerfile's single `prisma migrate deploy` with a loop over all tenant DBs (or a deploy script that runs before container swap). A new migration applies to all tenants; test on the `staging` tenant DB first. (Until the baseline exists, schema build for new tenants is `prisma db push`.)
- **Postgres version:** match your current Neon project's major (`SELECT version();` — Neon defaults new projects to 17/18) to make dump/restore frictionless.

### Backups (two independent layers)
1. **Hetzner automated backups**: +20% of server price (= €1.70/mo on CX33), 7 rotating whole-VM slots (✅ verified). Protects against "the box died."
2. **Nightly per-tenant `pg_dump -Fc` → Backblaze B2** via a small cron/backup container (loop tenants → dump → rclone to B2). B2: first 10 GB free, free egress up to 3× monthly storage (✅ verified). Protects against "a bad migration corrupted one tenant" — restore just that client. Alternative target: Hetzner Object Storage (1 TB included, EU-only ✅; base price ~€4.99/mo ⚠️ unverified) — overkill until data outgrows B2's free tier.
3. Optional later: WAL-G for point-in-time recovery. Skip pgBackRest (maintenance scare in April 2026, overkill here).

### Legal note (not legal advice)
India's DPDP Act 2023 has **no data-localization mandate** — §16 uses a negative-list model and the blacklist is empty as of July 2026; the Act also abolished the "sensitive personal data" category, so health data is ordinary personal data. Hosting in Germany is legal today. **Watch items:** DPDP Rules enforcement ramps ~May 2027; if you ever integrate ABDM/ABHA, the draft Health Data Management Policy contained an India-only storage clause — the mechanical fallback is migrating to an Indian provider or mirroring, which the database-per-tenant design makes easy.

---

## 7. Frontend hosting: Cloudflare Pages, not Vercel Hobby

⚠️→✅ **This is the one place your stated plan had a compliance problem.** Vercel's fair-use guidelines (updated June 16, 2026, verified verbatim):

> "Hobby teams are restricted to non-commercial personal use only. All commercial usage of the platform requires either a Pro or Enterprise plan." Commercial usage is "any Deployment that is used for the purpose of financial gain of anyone involved in any part of the production of the project."

25 white-label client sites at ₹999/mo each is unambiguously commercial. Options:
- **Cloudflare Pages (recommended):** 500 builds/month (✅), 100 custom domains per project (✅), no request/bandwidth cap on static assets (✅), free SSL, India edge PoPs. No written commercial prohibition (the plan page says "personal or hobby projects" but unlike Vercel there is no ban clause; commercial use on the free tier is standard practice). Note: Cloudflare is converging Pages into **Workers (static assets)** — for a static React SPA both work identically today (Workers free: 100k requests/day, 20k files, 25 MiB/file); existing Pages projects are unaffected. Prefer creating new projects as Workers-with-assets if the dashboard nudges that way.
- Vercel Pro: $20/mo — fine, but it's pure cost vs Pages.
- Serve SPAs from the Hetzner box via Caddy: free, but puts client traffic on your origin and loses the India CDN. Keep as fallback only.

**Per-client project pattern:** same repo, per-project build-time env (`VITE_API_BASE_URL=https://api.healthflow.in`, `VITE_TENANT=<slug>`, `VITE_APP_NAME`, logo, colors), custom domain `<slug>.healthflow.in` attached to each Pages project (auto-CNAME since the zone is already on Cloudflare, covered by the free wildcard cert). Provisioning and deploys are scriptable with `wrangler pages project create` / `wrangler pages deploy` — fold into `new-tenant.sh` and a GitHub Actions matrix so a shared frontend change fans out to all clients in one workflow run. At 25 clients even a rebuild-everyone push is 25 of the 500 monthly builds — fine.

---

## 8. Deployment & orchestration — options compared

**Framing:** the original reason to want a PaaS was "manage 25 app instances." The unified-backend decision collapsed the fleet to **3 containers + a proxy** (backend, Postgres, Redis, Caddy). That changes the answer: a PaaS managing 3 containers is overhead without leverage. What actually matters for a solo founder running clinics' patient data:

- **Deploys must be boring and reversible** — a clinic at 9 AM rush cannot eat a botched deploy.
- **Backups must be automatic and restore-tested.**
- **When something breaks, diagnosis must be fast** — fewer layers between you and the container, the better.
- **Minimal attack surface** — this box holds medical records; every admin panel on it is a target.
- **Low cognitive load after 6 months away** — will you still understand the setup?

### The field

| Option | RAM overhead | Deploy UX | Backups | Failure/attack surface | Verdict |
|---|---|---|---|---|---|
| **docker-compose + Caddy + GitHub Actions** | ~50–100 MB (Caddy only) | `git push` → Actions builds image → GHCR → SSH step: `docker compose pull && docker rollout backend`. Rollback = redeploy previous image tag | One cron container (`pg_dump` per tenant + rclone → B2). ~30 lines you own and understand | Only your own code + Caddy + Docker. Nothing else to CVE-patch, no upgrade can break routing | ✅ **Recommended** |
| **Kamal 2** (37signals) | ~0 on server (kamal-proxy only) | `kamal deploy` from laptop/CI; built-in zero-downtime proxy swap; secrets per destination | BYO cron (same as compose) | Minimal; tooling lives in CI, not on the box | Solid alternative — pick if you prefer a CLI tool over a compose file. ⚠️ 2026 state not re-verified |
| **Coolify v4** (✅ v4.0.0 stable Apr 2026, v4.1.2 current) | 500–770 MB (its own Laravel app + internal PG + Redis + realtime) | Push-to-deploy UI, env-var editor, browser logs, rolling updates (Dockerfile-type apps only) | Built-in scheduled `pg_dump`→S3 with UI (tick "Backup All Databases") | **11 critical CVEs Jan 2026 (3× CVSS 10, incl. RCE)** — patched, but it's an admin-RCE panel on a medical-data box; documented history of proxy-label bugs where a Coolify *update* breaks routing for everything it manages | Only if you genuinely want a web dashboard; firewall it to Tailscale |
| **Dokploy** | ~465–950 MB (has had memory regressions) | Similar to Coolify, younger | Similar | Smaller track record either way | No reason to prefer over Coolify |
| **CapRover** | ~300 MB | Scriptable | BYO | Effectively single-maintainer, feature-frozen | Reject |
| **k3s / Kubernetes** | 1–2 GB+ | Massive machinery for one node | — | Large | Reject — nothing here needs orchestration |
| **Stay managed (Render + Neon, or Railway/Fly.io)** | n/a | Zero ops | Managed | Vendor risk only | ~$37–200+/mo at 25 tenants vs ~€11. Rejected on cost, but it IS the fallback if self-hosting ever stops being worth your time — the Dockerfile ports anywhere |

### Why compose wins here (the company argument)

1. **The fleet is tiny and static.** One compose file (~80 lines) fully describes production. Coolify's entire value-add — UI for many apps, preview deploys, service catalog — targets a problem you no longer have.
2. **RAM is margin.** ~700 MB saved is your PDF-burst headroom, or the difference that would someday let a CX23 clone serve as a cheap staging/DR box.
3. **Blast radius.** With Coolify, a bad *Coolify upgrade* (not even your code) has historically broken Traefik routing for every managed app — that's a 25-clinic outage caused by a tool you didn't strictly need. With compose, only your own deploy can break you, and the fix is `docker compose up` with the previous tag.
4. **Security posture sells.** "The server runs our application, a database, and nothing else — no admin panels" is a sentence you can say to a hospital IT auditor later.
5. **What you give up is smaller than it looks:**
   - *Browser log viewer* → run **Dozzle** (~10 MB, read-only log web UI) bound to Tailscale, or just `docker compose logs -f`.
   - *Env-var UI* → a `.env` file on the box, edited over SSH; it changes maybe monthly.
   - *One-click rollback* → `DEPLOY_TAG=<previous-sha> docker compose up -d backend` — make it a 5-line script.
   - *Zero-downtime* → [docker-rollout](https://github.com/wowu/docker-rollout) (start new container → health check → swap → kill old), same mechanism Coolify uses. And realistically: deploy at night IST (Germany box = evening CET) and even a 10-second swap matters to nobody.

### The deploy pipeline (concrete)

```
git push origin main
  → GitHub Actions:
      1. build backend image (Dockerfile, node:22)  — never on the box
      2. push ghcr.io/you/healthflow-backend:<sha> + :latest
      3. SSH to server:
           a. run migration loop against all tenant DBs (new image, one-off container)
           b. docker rollout backend   (pull :<sha>, health-check, swap)
      4. on failure: job stops before swap; previous container still serving
```

Frontends: a second Actions workflow with a 25-entry matrix (or `wrangler pages deploy` per client) — only triggered when `health-hub/` changes; per-client env injected at build. 25 builds ≈ 25 of CF Pages' 500/month.

**Escape hatch, both directions:** everything is a standard Docker image + standard Postgres. Migrating *to* Coolify later (if the fleet ever grows genuinely multi-app — e.g. Axora spawns separate services) is an afternoon; migrating *back to* managed (Render/Fly) is the same Dockerfile. The compose choice locks in nothing.

---

## 9. Code refactor inventory (the actual work)

The audit found **no branding in DB or env — everything is hardcoded in source.** This is the real project; the server is a weekend. This section holds the major items; **Appendix A is the complete leak inventory** (deep 3-lens sweep: seeds/scripts, sample data, locale/currency, comments, docs, security items) — Phase 1 works from §9 + Appendix A together.

### 9a. New config surface
Create a per-tenant **`LabProfile`** table (in each tenant DB, so clients' branding travels with their data): `labName`, `logoKey` (R2), `primaryColor`, `accentColor`, `contactEmail`, `timezone`, `printMarginTopMm`, `printMarginBottomMm`, plus WhatsApp fields (below). Plus a server-side **tenant registry** (control table or config file): slug → DB URL, WABA credentials, R2 prefix, allowed origins.

### 9a-bis. Report rendering: one service, per-tenant templates as data

**Question this answers:** each client has their own report template/letterhead — does that mean separate rendering services? **No.** The rendering pipeline stays one shared service (one `reportRendererService` + one Puppeteer Chromium + one `mergedReportPdfService`); per-client differences live in three layers of data:

**Layer 1 — already per-tenant, free, no code change.** The report's *content structure* is DB-driven, and with database-per-tenant each client gets their own copy of all of it: `PanelDefinition`/`PanelTestItem` (which tests appear, grouping, order), `Department` (section headers), `TestDefinition`/`ClinicalPanel` (names, units, reference ranges), `SigningDoctor` + `SigningRule` (who signs what, signature images stored in-DB as base64), `LabInchargeRule`, **and `ClinicalPanel.narrativeTemplateHtml` — the radiology/imaging "dummy template" pre-filled in Pending Results is stored per panel in the DB, not in code**. Sobhana's templates saying "Sobhana …" is just content in Sobhana's rows; a fresh tenant DB never contains it. Two clients already produce structurally different report *content* from the same renderer today — that's just their data. (Product nicety: ship neutral starter narrative templates for common studies — USG abdomen, X-ray chest, etc. — in the new-tenant seed so radiology isn't blank on day one.)

**Layer 2 — branding chrome, via LabProfile (the §9b de-hardcode).** Logo, lab name, address/phone footer lines, accent color (`#cc2222` stripe), fonts if wanted, Excel `creator` metadata. The renderer reads these per-tenant instead of constants. Includes a **`letterheadMode`** field:
- `preprinted` (Sobhana today): client prints on physical letterhead paper → renderer leaves calibrated margins (`printMarginTopMm`/`printMarginBottomMm` per tenant, measured at onboarding) and renders no header.
- `rendered`: renderer draws the full header (logo + name + address) into the PDF → client prints on blank paper. Cheaper for clients, no calibration needed — offer it as the default for new HealthFlow clients; pre-printed becomes the premium/legacy path.
Same switch applies to `mergedReportPdfService` (the pdf-lib overlay on uploaded external PDFs): overlay coordinates and assets come from LabProfile.

**Layer 3 — structural layout variants, only if a client ever demands one.** If someone wants a genuinely different arrangement (two-column header, different table style), add a `templateKey` on LabProfile selecting from a small registry of named HTML/CSS template partials inside the same renderer. Still one service, one Chromium, one deploy. Do NOT build this until the first client actually asks — Layers 1+2 cover every independent diagnostic centre's real ask (their logo, their address, their colors, their panels).

**Capacity check:** 25 clients × 500 patients/mo ≈ 12,500 reports/mo ≈ ~600/working day ≈ single-digit PDFs/minute at peak. The existing queue (`PDF_MAX_CONCURRENT=2-4`, queue depth 50) handles this with one Chromium. **Escape hatch if PDF volume ever 10×es:** split rendering into a dedicated container (the code boundary already exists — `pdfGenerationService` is the only Chromium consumer; point it at a browserless/chrome sidecar container). A compose-file change, not a redesign — and another reason the per-client-container idea was never needed.

### 9a-ter. The full customization matrix (tenant × branch)

Two levels of variation exist, and the app already proves it: Sobhana themes **per branch** today (`branchTheme.ts` gives its 4 branches different sidebar/accent palettes). HealthFlow clients get the same: tenant-level identity + branch-level variation within a client. The complete surface, where each piece lives, and *when* it resolves:

| # | Element | Varies at | Resolved | Source of truth |
|---|---|---|---|---|
| 1 | App name, `index.html` title/meta/OG | tenant | build time | Pages env (`VITE_APP_NAME`) |
| 2 | Favicon / PWA icons (`health-hub/public/`) | tenant | build time | per-client asset swap in the frontend build step (add to `new-tenant.sh`) |
| 3 | **Login page** — logo, lab name, colors, support contact | tenant | **build time** — login renders pre-auth, so no API/JWT exists yet; each client's Pages build bakes its own login branding via VITE vars. (Alternative — a public `/branding?tenant=slug` endpoint — adds a request + flash-of-default; unnecessary since builds are per-client anyway) | Pages env |
| 4 | **Post-login theme** — sidebar/banner/accent colors, **per branch** | tenant × branch | runtime, on login + branch switch | NEW `Branch.theme` (JSON column or 3 color columns) served by a bootstrap endpoint; `branchTheme.ts`'s hardcoded map becomes a fetch. The CSS-var mechanism (`--branch-sidebar-bg` etc.) already exists — only the data source changes. Tenant default = LabProfile colors when a branch has no override |
| 5 | Report content structure — panels, departments, units, reference ranges, signing doctors + signature images, signing rules | tenant (branch-aware via rules) | runtime | tenant DB — **already free** (§9a-bis Layer 1) |
| 6 | Report chrome — logo, letterhead mode, print margins, accent stripe | tenant | render time | LabProfile (§9a-bis Layer 2) |
| 7 | Report/bill footer address + phone | **branch** | render time | `Branch.address`/`Branch.phone` (columns exist, currently bypassed by string matching — §9b) |
| 8 | Bill/receipt layout + logo | tenant (addresses per branch) | render time | LabProfile + Branch |
| 9 | Payout prints, WhatsApp payout statement, Excel `creator` | tenant | render time | LabProfile |
| 10 | Bill/report number sequences | branch | runtime | `NumberSequence` (already per domain+branch) — **free** |
| 11 | Test/product pricing | branch | runtime | `ProductBranchPricing` — **free** |
| 12 | WhatsApp sender number, WABA creds, approved template names, message copy | tenant | runtime | tenant registry (creds) + LabProfile (template names); webhook maps `phone_number_id`→tenant |
| 13 | Legal pages (lab name, contact email) | tenant | build time | VITE vars into parameterized components |
| 14 | Timezone | tenant | runtime | LabProfile (`BUSINESS_TIME_ZONE` pattern, made per-tenant) |
| 15 | Currency/locale | tenant | **deferred** | ₹ formatting is almost certainly hardcoded across the frontend — irrelevant for Indian clients, becomes real if the Vietnam expansion happens. Add `LabProfile.currency` then; just don't *add new* hardcoded ₹ meanwhile |
| 16 | Domain | tenant | provisioning | `<slug>.healthflow.in` Pages custom domain |

**Rule of thumb that falls out:** *identity* (who this lab is) resolves at build time in the frontend; *behavior and money* (themes per branch, addresses, pricing, sequences, templates) resolves at runtime from the tenant DB. Rows 5, 10, 11 cost nothing — database-per-tenant already isolates them. The only genuinely new backend schema is `LabProfile` + a `Branch.theme` column.

### 9b. Backend de-hardcode (file-by-file)
| File | What's hardcoded | Fix |
|---|---|---|
| `src/services/reportRendererService.ts` | Logo filename (L54, 787), `alt="Sobhana Diagnostic Centre"` (L792), footer address+phone (L990–991) | LabProfile + Branch |
| `src/services/pdfGenerationService.ts` | Same footer address+phone in Puppeteer footer template (L187–188) | LabProfile + Branch |
| `src/services/mergedReportPdfService.ts` | `FOOTER_ADDRESS_LINE`, `FOOTER_PHONE_LINE`, `LOGO_PATH` constants (L73–77) | LabProfile |
| `src/services/billPdfService.ts` | 3 logo fallback paths (L41–43); **branch addresses/phones selected by `branchName.includes("balanagar")` string matching (L73–88)** — even though `Branch.address` and `Branch.phone` columns exist and are populated-able | **Highest-leverage fix: read from the Branch table.** Kills most address hardcodes in one move |
| `src/services/payoutExportService.ts` | `wb.creator = 'Sobhana Diagnostics'` (L43, 108) | LabProfile |
| `src/routes/statementDownload.ts` | Logo img + "Sobhana Diagnostics · …" footer (L224, 234) | LabProfile |
| `src/index.ts`, `src/lib/logger.ts` | `service: 'sobhana-health-hub'` | Rename once to `healthflow-backend` |
| `public/css/report-screen.css` | `--color-red: #cc2222` + footer stripe | Inject per-tenant CSS vars at render time |
| `public/css/report-print.css` | **Print margins calibrated to Sobhana's physical pre-printed letterhead (32 mm top / 22 mm bottom)** | Per-tenant margins from LabProfile — every client's letterhead must be measured at onboarding |
| `public/images/` | 3 Sobhana logo files | Per-tenant logo in R2, keyed by LabProfile |
| Timezone | Raw `Asia/Kolkata` in `statementDownload.ts:60`, `notificationService.ts:598`, `billPdfService.ts:272,278`, `ownerDashboardV2Service` | `reportRendererService.ts` already env-gates it via `BUSINESS_TIME_ZONE` — replicate, then make it per-tenant |

### 9c. Tenant plumbing (new code)
- **Tenant binding at login** (§3.1): login request carries the tenant slug from the frontend build; backend validates it against the tenant registry and embeds `tenantId` in the JWT. All authenticated requests resolve tenant from the JWT only. Public tokenized routes (report/bill/statement links) resolve tenant via the token → control-table lookup; WhatsApp webhook via `phone_number_id`.
- PrismaClient-per-tenant cache (with `connection_limit=2-3` per URL).
- Tenant-prefix Redis keys (PDF cache is keyed by report ID — cuid collisions across tenants are unlikely but prefix anyway; rate-limit/lockout keys likewise).
- Migration loop across tenant DBs at deploy time.
- `new-tenant.sh`: `CREATE DATABASE` → **schema build** (`prisma db push`, or a squashed baseline migration — NOT the current `migrate deploy`, which is broken on fresh DBs; see A1 blocker) → **`seed-tenant.ts`** (built & verified, A7: catalog snapshot + 1 Branch + 1 admin User + disabled support account, params via env) → register in tenant registry → create the CF Pages project (`wrangler`) → print remaining manual steps (WABA, letterhead). **Target: onboarding client #26 in 10 minutes.**

### 9d. Frontend de-hardcode
| File | What | Fix |
|---|---|---|
| `index.html` | Title/meta/OG all "Sobhana" | Vite `define`/html-plugin from `VITE_APP_NAME` |
| `src/pages/Login.tsx` | "SOBHANA" heading + raw `#D91C2B`/`#1B2B58` (bypasses the existing CSS-var theme system) | Env/theme vars |
| `src/components/layout/Sidebar.tsx` | `<span>SOBHANA</span>` ×3 (L306, 328, 360) | `VITE_APP_NAME` |
| `src/lib/branchTheme.ts` + `src/index.css` | Sobhana branch codes/palettes; navy/red CSS-var defaults | Theme from build env or LabProfile API |
| `src/components/print/BillReceipt.tsx` | Logo URL, clinic labels, 3 branch addresses, phone matching by branch name (L186–242) | Branch table via API |
| `src/pages/owner/PayoutsList.tsx`, `PayoutStatement.tsx` | Logo URLs, "· Sobhana Diagnostics" footer | LabProfile |
| `src/components/diagnostics/ReportFramedNarrativeEditor.tsx` (L141–142) | The radiology narrative editor's **letterhead preview frame** hardcodes `/sobhana-logo-cropped.png` + alt text (the template *content* it wraps is DB data — see §9a-bis Layer 1) | Logo/name from LabProfile via bootstrap endpoint |
| `src/pages/NotFound.tsx`, `GlobalPatientSearch.tsx` (L99), `DiagnosticsReportPreview.tsx` (L731), `ManageBillableProducts.tsx` (L678) | "SOBHANA"/"Sobhana" UI strings | `VITE_APP_NAME` |
| `src/pages/legal/*` (PrivacyPolicy, TermsOfService, DataDeletion) | Fully Sobhana-branded incl. `sobhanadiagnostics@gmail.com` | Parameterize name + contact email from LabProfile |

### 9e. WhatsApp (per-client external dependency — start early)
- Template names (`lab_report_ready`, `lab_report_partial_ready`, `bill_receipt`, `payout_statement`) are registered in Meta's WhatsApp Business Manager **per WABA**. Each client needs their own WABA + phone number + **template approval (takes days per client)**.
- Move `WHATSAPP_PHONE_NUMBER_ID` / `ACCESS_TOKEN` / `VERIFY_TOKEN` from env into the tenant registry.
- The webhook endpoint must map incoming `phone_number_id` → tenant.
- (Gupshup env vars in `.env` are dead — never read by source. Ignore.)

### 9f. Housekeeping while in there
- Dockerfile: node:18-slim → **node:22-slim** (18 hit EOL March 27, 2025 ✅; Node 24 is Active LTS if you prefer the newer line).
- R2: per-tenant key prefix (or bucket) for uploaded external reports.
- Sentry: keep one DSN, tag events with tenant slug.

---

## 10. Server setup runbook (phase 2)

1. CX33, Ubuntu 24.04 LTS, Falkenstein or Nuremberg. Enable Hetzner automated backups (+€1.70/mo).
2. Base hardening: SSH keys only + disable password auth; `ufw` (22, 80, 443); **fail2ban** (sshd jail: maxretry 3, bantime 1h); **unattended-upgrades** with `docker-ce`/`containerd.io` blocklisted (an auto-update must never restart the Docker daemon under all tenants).
3. 4 GB swapfile, `vm.swappiness=10`.
4. Install Docker + docker-compose plugin; Tailscale for admin access (SSH + internal UIs never public).
5. One `docker-compose.yml`: Caddy (auto-TLS), backend (from GHCR, `--memory` limit), Postgres (major matched to Neon's, named volume), Redis, backup cron container, optional Dozzle log viewer (bound to Tailscale IP only). Compose file lives in the repo — the server config is version-controlled.
6. Cloudflare: `healthflow.in` zone, `api` A record → server IP, proxied (orange cloud); per-client subdomains are CNAMEs added by CF Pages custom domains. Origin TLS: simplest is a **Cloudflare Origin CA cert** (15-yr, valid only behind Cloudflare — fine since all traffic rides it); alternative is Caddy DNS-01 wildcard Let's Encrypt with a Cloudflare API token.
7. GitHub Actions deploy pipeline (§8): build → GHCR → SSH → migration loop → `docker rollout backend`. Keep a `rollback.sh` that redeploys any previous image tag.
8. Backups: nightly `pg_dump -Fc` per tenant → rclone → Backblaze B2 (cron container from step 5) + Hetzner auto-backup enabled. **Do a test restore now, and calendar a restore drill quarterly** — an untested backup is a hope, not a backup.
9. Monitoring: BetterStack free (10 monitors @ 3-min) on `api.healthflow.in/health` + 1–2 canary tenant frontends, public status page on `status.healthflow.in`. (UptimeRobot free is non-commercial-only since Oct 2024.) Optional on-box metrics: Beszel (~10 MB) over Netdata (200–500 MB).
10. Create the `staging` and `demo` tenants first — every future deploy hits `staging` before clients; `demo` is the permanent sales-demo instance for the outreach campaign.

---

## 11. Migration sequence

**Phase 0 — Security hygiene (do this week, independent of HealthFlow):**
1. Delete `extras/pre-onboarding-backup-2026-05-04.sql` from the repo — it's a **full pg_dump of live Sobhana production** (real emails, IPs, audit logs). If it was ever pushed, purge it from git history (`git filter-repo`), not just HEAD.
2. Remove `go-proxy.js` from the repo root — it contains a live opencode.ai API key. Rotate the key.
3. Rotate the live credentials sitting in `health-hub-backend/.env` (Neon connection strings, WhatsApp access token). The file is confirmed untracked/gitignored, but it's on disk — rotate before anyone else gets filesystem or repo access.
4. `public/images/signatures/*.png` are real doctor signatures — ensure they're excluded from any future tenant container image (move to R2/DB-only; `SigningDoctor.signatureImageBase64` already exists in-DB).

**Phase 1 — De-hardcode, shipped to Sobhana as a no-op.** Do all of §9b/9d with defaults equal to current Sobhana values (seeded LabProfile + Branch rows). Sobhana becomes white-label client #0 running in production — the refactor is de-risked against a live lab before any infra changes.

**Phase 2 — Server setup** (§10). No traffic yet.

**Phase 3 — Tenant plumbing** (§9c) + `new-tenant.sh`. Stand up a `demo` tenant end-to-end: Pages frontend → Hetzner API → demo DB → PDF with demo branding → WhatsApp from a test WABA.

**Phase 4 — Pilot client #1.** Real clinic on the new stack. Start their WABA/template approval on day one (it's the long pole). Measure the letterhead. Watch latency and RAM for two weeks.

**Phase 5 — Move Sobhana itself (optional, recommended last). ✅ CONFIRMED via Neon MCP (Jul 4):** project `sobhanaportal` (`purple-resonance-68736036`), **Postgres 17**, **~90 MB** logical size (dump/restore is seconds-to-minutes), region **aws-us-west-2** (so the Germany move *improves* India latency), and **only the `plpgsql` extension** — i.e. **nothing to install or drop; the dump is fully portable to vanilla PG17.**
- Dump from Neon's **unpooled** endpoint: `pg_dump -Fc -d "<direct URL>"` (`pg_dumpall` and `--create` are unsupported on Neon).
- Restore with `pg_restore -O --no-owner` (the `neon_superuser` role breaks ownership) into a **Postgres 17** container.
- No extension cleanup needed (confirmed: only `plpgsql`).
- Rehearse restore days ahead → brief maintenance window (~1–2 min) → final dump/restore → flip `DATABASE_URL` + deploy → done. Rollback = flip the env var back.
- Keep Render ($7/mo Starter) + Neon (free) alive for 1–2 weeks as instant rollback, then decommission.

**Phase 6 — Scale to 25.** Onboarding = run `new-tenant.sh`, create the Pages project, WABA templates, measure letterhead. Everything else is shared.

---

## 12. Cost model

| Item | €/mo |
|---|---|
| Hetzner CX33 (Germany) | 8.49 |
| Automated backups (+20%) | 1.70 |
| Primary IPv4 | ~0.50 ⚠️ (figure unverified; confirm in console) |
| Cloudflare (DNS, proxy, Pages ×25) | 0 |
| Backblaze B2 (under 10 GB) | 0 |
| BetterStack monitoring | 0 |
| **Total** | **~€10.70/mo (~₹1,050)** |

Compare: 25 clients on Render ($7/service if split, or one service + Neon Launch at $30–200+/mo). At ₹999/client/mo revenue × 25 = ~₹25,000/mo against ~₹1,050 infra — **infra is ~4% of revenue at full scale**.

Not in the table: Vercel Pro if you insist on Vercel ($20/mo), Singapore premium (~20–40% on the server if you move), Meta WhatsApp conversation fees (per-message, passes through regardless of host), your time.

---

## 13. Open items to verify yourself (5 minutes in consoles)

1. **Hetzner console:** is CX33 (x86) orderable in Singapore, and at what price? (Unconfirmed — SIN may be CPX/CAX-only.)
2. **Hetzner console:** current primary IPv4 price (~€0.50/mo claimed, page 404'd during verification) and current snapshot €/GB.
3. **Hetzner Object Storage** base price (€4.99/mo claimed, page is JS-rendered) — only matters if you outgrow B2 free.
4. **Neon dashboard:** your project's Postgres major version (`SELECT version();`) — pick the same for the self-hosted container.
5. **Render dashboard:** confirm the current service's plan/billing before relying on it as the $7 fallback.

## 14. Known risks

| Risk | Mitigation |
|---|---|
| Unified process = shared blast radius (one bad deploy downs all 25) | Rolling deploys w/ health check via docker-rollout; every deploy hits the `staging` tenant first; deploy outside clinic hours (night IST = evening CET); Render fallback during early phases; revisit per-tenant containers only if a client demands version pinning |
| Solo-operator bus factor: no PaaS UI means the setup lives in your head | Mitigated by design: compose file + Caddyfile + deploy workflow all version-controlled in the repo; §10 runbook in this doc; Dozzle for logs without SSH |
| Prisma connection-pool blowout at 25 tenants | `connection_limit=2-3` per tenant URL from day one |
| A migration that fails on tenant #14 of 25 | Migration loop stops on first failure; test on staging tenant; per-tenant dumps allow single-tenant restore |
| WABA approval delays blocking client onboarding | Start Meta process at contract signing, not go-live |
| Letterhead print calibration per client | Make margins LabProfile fields; onboarding checklist includes measuring the physical letterhead |
| Germany latency feels sluggish to a fast receptionist | Cloudflare proxy + query caching first; snapshot-migrate to Singapore if complaints persist |
| DPDP rules tighten / ABDM integration mandates India storage | DB-per-tenant makes relocating to an Indian provider mechanical |

## 15. Fit with Axora direction

This design is a step toward Axora, not a detour: the tenant registry + LabProfile table is exactly where per-tenant module toggles (Diagnostics/OP/IP) will live; `new-tenant.sh` becomes Axora's provisioning API; and database-per-tenant means module-specific migrations can roll out per tenant later. No throwaway work.

---

## 16. Audit register (IT-team view)

Turning a single-tenant clinic app into a 25-tenant healthcare SaaS is not one audit. Standing register of every dimension a platform/security/SRE team owns before real patient data goes on a shared box. Status: ✅ done · 🔄 running · ⚠️ partial · ❌ not started · 📐 designed only.

| # | Audit | Status | Launch-blocker? |
|---|---|---|---|
| Branding / PII string leak | ✅ (Appendix A) | — |
| Multi-tenancy runtime isolation | ✅ (§17) | **YES** |
| Authorization: IDOR / object & function-level | ✅ (§18) — CRITICAL findings incl. X-Branch-Id spoof, unscoped bills/patients | **YES** |
| AppSec (stored-XSS→PDF, upload, CSRF, CORS/CSP, SSRF) | ✅ (§19) — path-traversal file read (exploitable), mXSS→RCE amplifier, PDF DoS; CSRF/SQLi/cookies clean | **YES** |
| Dependency / CVE | ⚠️ backend 24 vulns (2 crit/8 high), frontend 15 (9 high), Node 18 EOL | **YES** |
| Secrets management & rotation | ❌ (findings only: live creds/dump/key on disk, Phase 0) | **YES** |
| Encryption at rest & in transit (disk LUKS, Redis AUTH+TLS, DB TLS, encrypted backups) | ❌ | YES |
| Financial correctness (bills/refunds/payouts/commissions, atomicity, idempotency, races) | ✅ (§21) — 2 CRITICAL money bugs live (refund accounting, concurrent-refund double-pay); core otherwise sound | **YES** |
| Clinical / patient-safety (ranges, abnormal/critical flags, report immutability, formula eval) | ✅ (§20) — CRITICAL: panic values un-alerted/invisible, reports mutate retroactively; **live in prod now** | **YES — top priority** |
| Pre-launch pen-test / threat model | ❌ | YES |
| Backup & DR — RPO/RTO, tested restores, per-tenant restore, encrypted offsite | ⚠️ designed | YES |
| Single-box SPOF for 25 tenants (HA vs rebuild runbook) | ❌ | soon |
| Monitoring / alerting / tenant-tagged logs / paging / synthetics | ⚠️ | soon |
| Capacity & load test (1 box @ 25-tenant peak; DB N+1; Chromium; pool exhaustion; leaks) | ❌ | soon |
| Release safety (migrate across 25 DBs, rollback, zero-downtime; broken-baseline blocker) | ⚠️ (A1) | soon |
| Data-migration correctness (Neon→Hetzner row/FK integrity) | ❌ | at cutover |
| Tenant lifecycle: provisioning | ⚠️ (seed built A7, migration blocker A1) | YES |
| Tenant lifecycle: offboarding / right-to-erasure (DB+R2+Redis+backups+logs) | ❌ | YES (DPDP) |
| Tenant lifecycle: suspension on non-payment | ❌ | later |
| Your subscription billing / dunning for the 25 clinics | ❌ | revenue |
| Per-tenant module toggles (Axora) | 📐 | later |
| DPDP obligations (consent, DSR, retention, breach-notify, processor/controller DPA per clinic) | ❌ | YES |
| Audit-trail completeness & tamper-evidence | ❌ | YES |
| Licensing for commercial resale (deps, Pngtree image, PDF font embedding) | ⚠️ | before sell |
| ToS / Privacy / DPA per tenant | ❌ (hardcoded legal pages) | before sell |
| i18n / currency / locale | ⚠️ (found: en-IN/₹) | Vietnam only |
| Accessibility (WCAG) | ❌ | later |

## 17. Multi-tenancy runtime isolation — findings (audit complete)

The unified-backend design shares process state across all 25 tenants. Verified findings, worst first:

**CRITICAL — cross-tenant data leak / foundational:**
- **`lib/prisma.ts:8` — single global `PrismaClient`, 48 importers.** One DB for everyone; this is the core refactor — must become a per-tenant client cache (`getPrismaClient(tenantId)`), and every one of the 48 import sites needs `tenantId` resolved before any service call. Everything else depends on this.
- **`services/ownerMetricsService.ts:23` — owner metrics Redis cache key `owner-metrics:v1:${window}` has NO tenant prefix.** The moment two tenants hit the owner dashboard, tenant B is served tenant A's revenue, visit counts, top tests, top referrers from cache (5-min TTL). Active leak. Fix: tenant-prefix. Same structural gap (mitigated only by UUID branchIds) in `ownerDashboardV2Service.ts:32`, `ownerMoneyService.ts:24`, `ownerDoctorsService.ts:21`, `ownerOperationsService.ts:22`.
- **JWT has no tenant claim + one shared `JWT_SECRET`** (`authService.ts:181-188`, `auth.ts:79`). A token minted for tenant A is cryptographically valid against every tenant; isolation rests only on user-id lookups failing in the wrong DB. `middleware/branch.ts:77` trusts an `X-Branch-Id` header without checking the user owns that branch. Fix: per-tenant JWT secret (or mandatory `tenantId` claim checked against the resolved tenant).

**HIGH:**
- **`index.ts:385-399` — a "TEMPORARY DB UPDATE SCRIPT" runs `updateMany` (renames product/panel/test codes CXRPA→XRAYCP etc.) on EVERY process boot.** Should have been deleted after the one-off. In multi-tenant it would fire against whatever DB is wired, mutating tenant catalogs indiscriminately. **Delete now** (also affects single-tenant Sobhana today).
- **WhatsApp webhook** (`routes/webhooks.ts:31`) uses one global `WHATSAPP_APP_SECRET`; per-WABA tenants need `phone_number_id → app_secret` lookup before HMAC verify (chicken-and-egg, solvable). Outbound (`whatsappCloudService.ts`) uses one phone number/token for all — Meta ToS violation + patients get messages from an unknown number. Creds must be per-tenant (DB-stored).
- **Redis cache keys lack tenant prefix** and the merged-PDF cache + security counters share one instance under `allkeys-lru` (flooding cache can evict lockout keys — see §6 Redis writeup).

**MEDIUM:**
- **Report/bill/PDF branding baked in at boot** as module globals: `reportRendererService.ts:32-36` (`LOGO_DATA_URI`, CSS, `BUSINESS_TIME_ZONE`, date formatter all frozen at startup), `mergedReportPdfService.ts:78` (`cachedLogoBytes`), `billPdfService.ts:33` (`_logoDataUri`) — every tenant gets Sobhana's logo/timezone until these become per-tenant/per-request.
- **Chromium/PDF queue** (`pdfGenerationService.ts`): global `PDF_MAX_CONCURRENT=2` + FIFO `pendingPdfJobs`. One tenant's 50-report batch queues everyone else behind it (up to 40 min / 503s). No per-tenant fairness.
- **`healthChecks.ts:74` `/ready` checks one DB** → either misses a down tenant DB (false green) or a single down tenant DB 503s the origin for all 25. Must check shared infra only; per-tenant DB health is a separate operator concern.
- **Four copies of `IST_OFFSET_MS = 5.5h`** (owner services) hardcode India day-boundaries; wrong "today/7d/30d" windows for any non-IST tenant.
- **`authService.ts:72,111` `prisma.branch.findFirst()`** for audit-log branch — wrong/again in multi-tenant.
- **`rateLimit.ts:18` in-memory fallback Map** is process-global (cross-tenant on Redis-down).

**LOW:** `logger.ts` has no `tenantId` in log lines (25 tenants interleaved, undebuggable); `tokenService.ts:13` dead module with `'dev-secret-key-change-in-production'` fallback (delete); Sentry one project, `beforeSend` doesn't strip patient data from bodies/params.

**Fix order:** (1) per-tenant PrismaClient, (2) JWT tenant claim/secret, (3) ownerMetrics cache prefix [active leak], (4) all Redis keys tenant-prefixed + eviction split, (5) delete the boot mutation script, (6) webhook per-tenant secret + outbound per-tenant creds, (7) `/ready` decouple, (8) branding globals → per-request, (9) PDF queue fairness, (10) tenant-tagged logging.

## 18. Authorization — findings (audit complete)

Several are exploitable in the **current single-tenant app today** (cross-branch), and worsen in multi-tenant. No mass-assignment found (routes destructure named fields — good).

**CRITICAL (exploitable now):**
- **`middleware/branch.ts:77-94` — `X-Branch-Id` header trusted with no membership check.** Any authenticated user (even `doctor`) sends `X-Branch-Id: <any-branch-uuid>` and every branch-scoped query serves that branch. Today = cross-branch IDOR; in SaaS this header is the tenant selector, so it's the single most dangerous pre-launch issue. Fix: verify `user.activeBranchId === requested || role==='owner'` (and a real `UserBranch` membership table for SaaS).
- **`bills.ts:11,25` — `GET /api/bills/:domain/:visitId` has no branch scoping at all** (only `authMiddleware`, `findFirst({where:{id,domain}})`). Any authenticated user reads any visit's full financials (payment transactions, referral commission %, PII) by guessing a visitId.

**HIGH:**
- **Patient endpoints unscoped**: `GET/PATCH /api/patients/:id` and `/search` (`patientService.ts:316,1126`) do `findUnique({where:{id}})` with no branch/tenant filter — any authenticated user reads/edits/searches **any** patient's PII globally. (360 view is intentionally global — becomes cross-tenant in SaaS.)
- **`doctor` role can perform financial/clinical writes** — refunds (`diagnosticVisits.ts:2601`), correct-referral (`:2870`, lets a doctor alter their **own** payout attribution), finalize reports, delete test orders, and **set arbitrary prices** (`billableProducts.ts:733`, no role gate → a doctor can raise their own test prices). Only payouts/owner-dashboard/audit-logs are role-gated. Fix: gate destructive/financial ops to `staff`/`owner`, make `doctor` read-mostly.
- **`POST /api/auth/register` is dead** — gated `requireRole('admin')` but the app only issues `staff`/`doctor`/`owner`, so user creation via API is impossible (DB insert only). Remediation: change gate to `owner`. **⚠️ interacts with the seed (A7):** `seed-tenant.ts` currently creates the bootstrap + support users as `role:'admin'` — which can pass the register gate but **cannot** access `requireRole('owner')` routes (the owner dashboard). Reconcile: seed the bootstrap user as `owner` and move the register gate to `owner`, so the first user can both run the lab and create staff. Fix this in `seed-tenant.ts` alongside the authz remediation.

**MEDIUM:**
- **Public tokened links (report/bill/statement) NEVER expire.** `expiresAt` defaults null and every caller omits it, so every WhatsApp report/bill link is valid forever with no revocation. Token entropy is ~71 effective bits (256-bit `randomBytes` trimmed to 12 chars) — OK behind rate-limiting but needlessly weakened. Fix: default 90-day expiry + a revocation path; stop trimming the token. Tokens are SHA-256-hashed at rest and non-escalatable (a token maps to exactly one resource) — those parts are correct.
- Test catalog / departments / referral-doctor mutations are `auth`-only (any role can edit the catalog or commission rates).

**Tenant-resolution surface** (for the isolation refactor): authed routes (JWT needs `tenantId`), the spoofable `X-Branch-Id`, the three token endpoints (token→tenant lookup needed, else you'd scan all tenant DBs), the WhatsApp webhook (phone→tenant), and `/api/system/status` (should be `owner`-gated). Health probes need no tenant.

## 19. Application security — findings (audit complete)

Confirmed clean: no SQL injection (0 raw-SQL), CSRF mitigated (SameSite=lax + prod CORS allowlist, no state-changing GETs), cookie hardening correct (httpOnly/secure/lax), webhook HMAC uses `timingSafeEqual`, Sentry `beforeSend` strips auth headers + `sendDefaultPii:false`, external-upload magic-byte + `PDFDocument.load()` validation.

**HIGH / exploitable now:**
- **Arbitrary file read via signature path traversal** (`reportRendererService.ts:60-74` + `signingDoctors.ts:217`). `inlineSignatureImage` does `path.join(PUBLIC_DIR, signatureImagePath)` with no boundary check; the signing-doctor PATCH accepts `signatureImagePath` from the body **with no role gate**. Set it to `../../.env`, assign the doctor to a department, render any report in that department → the file is base64-embedded in the PDF. Given `.env` holds the live Neon creds + WhatsApp token, this is a secret-exfiltration path. Fix: assert `fullPath.startsWith(PUBLIC_DIR + sep)` + `requireRole('owner')` on the route. (Reinforces Phase 0: rotate those creds.)
- **mXSS → RCE amplifier.** Stored narrative HTML (`narrativeTemplateHtml`, result `textValue`) is sanitized only **on read** (`reportRendererService.ts:139-174`, `sanitize-html`/htmlparser2), never on write (`clinicalPanels.ts`, `diagnosticVisits.ts:3582`). Chromium's parser differs from htmlparser2 (mutation-XSS class), and Puppeteer runs `--no-sandbox` (`pdfGenerationService.ts:119`) — so any payload that survives sanitization and mutates in Chromium executes with **no renderer sandbox between JS and the host OS**. Theoretical with the current allowlist, but the blast radius is RCE on the one shared PDF process. Fix: sanitize on write too; isolate Chromium (separate no-network container or restore the sandbox).
- **No rate-limit on authenticated PDF endpoints** (`diagnosticVisits.ts:4154,4289`). One staff account firing 52+ parallel renders fills the global queue (cap 50) → `503 PDF_SERVICE_OVERLOADED` for everyone, including patients on public token links. Authenticated DoS; multiplies across tenants. Fix: per-user rate limiter (the helper already supports user-id keys).

**MEDIUM / LOW:**
- **`/ready` (unauthenticated) leaks infra detail** — dependency errors include internal IPs/ports/connection strings (`healthChecks.ts`). Return only `ok|degraded|unhealthy` publicly; keep detail on the auth-gated `/api/system/status`.
- **No JWT revocation** — logout only clears the cookie; a stolen 24h token stays valid (in-memory bearer). Add a Redis `jti` blocklist on logout.
- **CORS allows all origins when `NODE_ENV!=='production'`** with `credentials:true` (`index.ts:162`) — an internet-exposed staging box is credential-CORS-open. Require an explicit allowlist in staging too.
- **Prisma error `.message` returned to clients** (multiple routes) — leaks table/constraint names. Map error codes to generic messages in prod.
- **External PDFs served `inline`** — polyglot `%PDF`+HTML risk; ensure `X-Content-Type-Options: nosniff` isn't overridden, consider `attachment`.

(The agent also independently re-derived the no-tenant-isolation/global-schema issue — same as §17/§18.)

## 20. Clinical / patient-safety — findings (audit complete)

**These are live in Sobhana's production today and affect real patients — the highest-priority findings in the whole audit, above any HealthFlow work.** The reference ranges the catalog seed (A7) ships to 25 labs flow through this same flag logic, so fixing it is a prerequisite to the catalog being safe.

**CRITICAL (patient safety):**
- **Panic/critical values are invisible and un-alerted.** `computeFlag` (`reportRendererService.ts:184-190`) ignores `criticalMin/criticalMax` — a potassium of 8.0 (life-threatening) renders identically to 5.5: same bold "H", no panic row, no colour, no "see doctor immediately". There is **no alerting hook anywhere** (no SMS/WhatsApp/in-app) on a critical result at entry or finalization. `FlagBadge` (`flag-badge.tsx`) has no CRITICAL style → `CRITICAL_HIGH` renders as unstyled grey text. Violates NABL/ISO 15189 panic-value policy.
- **Legacy tests never evaluate critical thresholds** — `resolveReferenceRange` (`referenceRangeService.ts:160`) hardcodes `criticalMin/Max: null`, so any not-yet-migrated test can never produce a critical flag even if thresholds are set.
- **Finalized reports mutate retroactively** (report immutability broken — the thing I flagged as scariest, confirmed): lab-incharge name/designation is **unconditionally re-hydrated from the live DB** (`reportSnapshotService.ts:1817-1838`) — editing a lab incharge silently rewrites the signatory on every historical report (a legal medical document changing after the fact). Same for signing rules on old-format snapshots (`:1810`), and legacy `LabTest` ranges are editable **in-place with no versioning** (`labTests.ts:215`), so a range edit changes how past + in-flight reports render.

**HIGH / MEDIUM-HIGH:**
- **Boundary-exact values flagged NORMAL** — strict `>`/`<` (`reportRendererService.ts:187`, `reportSnapshotService.ts:557`, `diagnosticVisits.ts:204`) means HB exactly at referenceMin shows NORMAL; inconsistent with the interpretation engine which is inclusive. A false-normal on a boundary value.
- **Result-entry auto-flag uses the legacy range path for ALL tests** (`diagnosticVisits.ts:3663`, passes `undefined` for the def-map) → new-architecture tests get wrong/absent flags on the technician's screen (the rendered report resolves correctly, but point-of-entry review is degraded).
- **Client-submitted flag persists if auto-flag computation throws** (swallowed try/catch, `diagnosticVisits.ts:3701`) — a tampered/buggy client can write NORMAL over a critical value and it survives.
- **Snapshot creation failure is non-fatal** (`diagnosticVisits.ts:4661`) — report is already FINALIZED in the transaction, so a snapshot error leaves it permanently finalized with `panelsSnapshot=null` → 404 for patient and staff, recoverable only by a maintenance script.

**MEDIUM:**
- **No server-side unit validation** — creatinine entered in µmol/L (80) against a mg/dL range (0.6–1.2) flags CRITICAL_HIGH with no guard; units are cosmetic at compare time.
- **`yearOfBirth`-only age is off by up to 364 days** (`referenceRangeService.ts:26`, computes from Jan 1) → wrong neonate/infant range selection (recall the migration backfilled missing years to 1990).
- **Gender-range selection sort gap** (`referenceRangeService.ts:61`) can pick the gender-neutral fallback over the correct gender-specific infant range.
- **Snapshot uses latest-version formula, not order-time** (`reportSnapshotService.ts:799`) — a Friedewald/eGFR formula edit changes an in-flight report's computed value.
- **Notes-only result passes the finalization completeness check** (`diagnosticVisits.ts:219`) — a row with no value but a note finalizes as '—'.
- `collectedAt` hardcoded to registration time (`reportSnapshotService.ts:1524`) → wrong "Collected On" + TAT on reports.

Formula eval (`new Function()`, `derivedParameterService.ts:246`) is guarded by a numeric regex + parseFloat — no injection path found (adequately mitigated).

**Remediation priority:** (1) render + alert critical values [before next deploy], (2) stop re-hydrating snapshot signatory identity from live DB, (3) legacy critical thresholds + range versioning, (4) correct range path at result entry, (5) inclusive boundary + unit validation.

## 21. Financial correctness — findings (audit complete)

The financial core is **mostly sound** (confirmed correct: all money is integer paise, no float money math; rounding conserved via largest-remainder allocation; bill creation wrapped in `$transaction`; number sequences use `SELECT FOR UPDATE NOWAIT`; mark-payout-paid is an atomic conditional `updateMany`; commission/discount/price inputs validated). The bugs are specific and live in prod:

**CRITICAL:**
- **Refunds counted as positive income** (`billFinancialService.ts:247-250`). `recomputeBillFinancialsForSubtotal` sums `PaymentTransaction` rows without checking `transactionType`, so a REFUND is added instead of subtracted. Adding or removing a test on **any previously-refunded bill** permanently writes a corrupted `paidAmountInPaise` (e.g. ₹600 actually paid recorded as ₹1,400), poisoning every downstream calc (dashboards, payouts, dues) — and blocks test removal on refunded bills. Fires on a **single normal request**; the correct REFUND-subtract logic already exists in `computeBillFinancialsFromPersisted:100-107`.
- **Concurrent-refund double-payment** (`diagnosticVisits.ts:2601-2745`). Refund reads + validates the `cancelledAt` guard **outside** the `$transaction`, and there is **no UNIQUE on `OrderRefund(testOrderId)`**. A double-tapped "Refund" issues 2× bank refunds + 2× payout-commission reversals (negative balances), no recovery.

**HIGH:**
- **Phantom dues on refunded bills** (`ownerMoneyService.ts:422-460`, `ownerMetricsService.ts`). Outstanding = `total − discount − paid` never subtracts `reversedChargeInPaise`, so every refund permanently inflates the branch's receivables metric.
- **Clinic payout writes the full consultation fee, not the commission** (`clinicVisits.ts:827-863`). The COMPLETED transition sets `derivedAmountInPaise = consultationFeeInPaise` and never applies `clinicCommissionPercent` — a ₹500 fee at 60% pays the doctor ₹500 instead of ₹300, frozen once `paidAt` is set. (The standalone `deriveClinicPayout` does it right; this path doesn't use it.)

**MEDIUM/LOW:** `PATCH paidAmount` can set the cache below the actual transaction sum (no `>= sum(transactions)` check); split `payments[]` aren't validated to equal the declared `paidAmount` (silent cash-vs-system mismatch); CHEQUE is silently recorded as CASH in collect-due.

## 22. Signature storage & report immutability (decided Jul 3)

Report **signatory identity** (name/designation) is frozen in the slim snapshot (fixed in P0-4). The remaining piece is the signature **image**: it must be immutable per report *without* storing image bytes per report (that per-report base64 duplication was the old ~10x snapshot bloat, already slimmed away — bytes now live once per signer and are re-hydrated live at render, which is why editing a signature currently changes old reports).

Chosen design — **append-only image files on persistent storage**, not per-report base64:

- **STEP 1 — DONE (this session).** Signature upload is now append-only: the old file is no longer deleted, and each upload already gets a unique filename (`sig-<ts>-<rand>`), so a re-upload lands at a new path and old paths survive. `signingLabIncharges.ts`, `signingDoctors.ts`. Harmless today, prerequisite for step 2.
- **STEP 2 — do at the Hetzner/R2 migration (Phase 5).** (a) Move signature files to **persistent storage** (Hetzner disk or R2, unique keys = append-only). (b) Switch the renderer to load the image from the **frozen snapshot path** (`inlineSignatureImage`) instead of re-hydrating live base64. (c) **Drop the `signatureImageBase64` column** → removes the DB copy and delivers true image immutability: *new upload → new path for upcoming reports; old reports keep their old path → old signature.* Blocked until then because **Render wipes the local disk each deploy** — the sole reason the base64-in-DB copy exists today.

Ties to: §9f (R2 per-tenant prefix), the Phase 5 cutover, and right-to-erasure (offboarding a tenant must also purge its signature assets, not just DB rows).

## 23. Control-plane: per-tenant billing, WhatsApp & message limits

The tenancy model (DB/frontend/branding/JWT) is covered above; this section adds the **control-plane** — the pieces that manage each tenant's *lifecycle and messaging*. (Product/business rationale lives in `HEALTHFLOW_PRODUCT_ROADMAP.md`; this is the technical shape for the deploy.)

**Control DB (new, central — separate from tenant DBs).** One Postgres DB on the box holding the `tenants` registry — the source of truth every request, cron, and the admin console keys off:
```
tenant_id, subdomain, db_name, status,          -- status: trialing|active|past_due|suspended|canceled
plan_amount, plan_interval,                      -- PER-CLIENT price (set at deal time; monthly|yearly)
autopay_enabled, next_billing_date,
razorpay_customer_id, razorpay_subscription_id, last_payment_at, last_login_at,
wa_phone_number_id, wa_access_token, wa_app_secret, wa_verify_token, wa_templates,  -- per-tenant WABA
msg_monthly_limit,                              -- per-client WhatsApp cap
last_login_at
```

**Billing (Razorpay, per-client price).** Price is **per-client — set at deal time, no fixed plan** (`plan_amount`+`plan_interval` on the row → create the Razorpay plan/subscription from those). Monthly + yearly. UPI Autopay mandate (PIN-free ≤ ₹2,000/debit; above that use yearly or card e-mandate). Non-autopay clients get a WhatsApp reminder 3 days before `next_billing_date` (daily cron). Auto-debit succeeds only ~30–50% → dunning (WhatsApp-first + pay link) is core, not optional; `subscription.charged/halted`/`payment.failed` webhooks drive `status`.

**Suspend/reactivate.** `status` checked in API middleware → **HTTP 402** if suspended (two-phase: overdue banner → read-only; JWT stays valid, the middleware DB/cache check is the gate). Reactivate on the `subscription.charged` webhook. **Never delete data.**

**Per-tenant WhatsApp (WABA) — DIRECT Meta Cloud API (decided Jul 4; no BSP).** Each tenant's WABA credentials live in the registry, **not env** (P1-7 fix): `wa_phone_number_id`, `wa_access_token`, `wa_app_secret`, `wa_verify_token`. Outbound sends select the tenant's creds by tenantId and call `graph.facebook.com/{phone_number_id}/messages` directly. Inbound: single `/webhooks/whatsapp` URL → read `phone_number_id` from the raw body → map to tenant → **verify HMAC with that tenant's `app_secret`**.
- **⚠️ Token longevity (the operational sharp edge of going direct):** Meta *user* access tokens expire (~60 days). Use a **long-lived System User token per WABA** (non-expiring) — otherwise sends silently start failing weeks in. Store encrypted; **alert on token age + send-failure spikes** so an expiring token surfaces before it breaks delivery.
- **Templates:** keep the **same standardized names** across all tenants (`lab_report_ready` / `lab_report_partial_ready` / `bill_receipt` / `payout_statement` — the existing code constants). Each tenant **registers + gets those approved under their own WABA** at onboarding (Meta reviews each — the slow bit). Classify **UTILITY** (not marketing). Content branded per-tenant (lab name baked into their approved template or passed as a param). Optional `wa_templates` map in the registry (logical name → tenant's approved name) for flexibility.
- **Onboarding:** direct means either register HealthFlow as a **Meta Tech Provider** to use Embedded Signup, or add each client's WABA to HealthFlow's Business Manager manually. One shared backend, many per-tenant WABAs.
- **Billing:** HealthFlow's payment method sits on the WABAs → **HealthFlow pays Meta directly** for all tenants' messages (no BSP fee) → the per-tenant message cap (below) is cost-protection.

**Per-tenant WhatsApp message limit (cost-protection — HealthFlow pays for messages).** HealthFlow's Meta Cloud API billing covers all tenants' WABAs (we pay Meta directly), so a **per-client monthly cap is essential** — a buggy or heavy tenant would otherwise run up *our* Meta bill. Enforced with the tenant-prefixed Redis counters (same infra as P1-4/6): before each send, `INCR msgcount:{tenant}:{yyyymm}`; if over `msg_monthly_limit` → block the send + alert the client and us.
- **Relation to Razorpay = DECOUPLED.** Razorpay only handles the recurring *charge* (per-client price); it never sees message counts. The message allowance is a separate `msg_monthly_limit` column on the same Control-DB row — you set price and allowance together at deal time, but they're mechanically independent.
- **Reset the counter on `next_billing_date`** (when Razorpay charges) so included messages refresh exactly when the client pays.
- **At the limit — MVP policy = hard block + upsell** (block sends until next cycle or you raise `msg_monthly_limit`; no surprise bills, caps our cost). **Metered overage billing (Razorpay add-on charge) is deferred** — more plumbing than the first clients justify.

**PDF concurrency (per-box).** `PDF_MAX_CONCURRENT` is the RAM/CPU-bound lever (each render ~250–500 MB): **Render stays 2, CX33 = 4** (raise the code ceiling so the env var actually takes effect above 2). The **queue is cheap** (queued jobs are tiny waiting closures — only the 4 *active* renders use RAM), so `PDF_MAX_QUEUE` can stay ~50+ generously — it trades rejection for a 1–2 min burst wait, with the 60 s per-job timeout guarding hangs. Caveat: the queue is **global** across tenants; add **per-tenant slot fairness (P2-6)** as tenants grow so one clinic's batch can't starve others.

---

## 25. Confirmed prod facts (via MCP — Jul 4)

Live reads from the connected MCPs, replacing earlier "unverified" flags.

**Neon** (`sobhanaportal` / `purple-resonance-68736036`) — fully read:
- **Engine:** Postgres **17**; single `read_write` compute autoscaling **0.25–2 CU**; transaction pooler; **aws-us-west-2**; no read replicas. Extensions: **only `plpgsql`** → dump is fully portable to vanilla PG17, nothing to install/drop.
- **Size & volume:** ~90 MB total, 55 tables. Biggest: **AuditLog 4,401 rows** (append-only — the growth table to watch), TestResult 1,567, TestOrder 1,172, MessageLog 1,034. Business data: **760 patients, 195 visits, 189 finalized reports**. Catalog cross-checks the seed *exactly* (TestDefinition 232, ClinicalPanel 69, BillableProduct 231, ClinicalPanelItem 172, BillableProductPanel 104 = `catalog-seed.json`).
- **Sizing implication (reassuring):** a per-tenant DB ≈ this size → **25 tenants ≈ ~2 GB of data** (with WAL/indexes call it <10 GB) — trivial on CX23's 40 GB disk. The constraint is Postgres connections/`shared_buffers` and Chromium RAM, **not disk**. Per-tenant `pg_dump`/restore is **seconds**.
- **Migration blocker (P1-13) CONFIRMED with prod evidence:** `_prisma_migrations` = **62 applied, 0 failed** (latest `20260705000000_referral_visit_soft_delete`), yet all **5 new-arch tables exist**. History claims "all applied" while the schema was built out-of-band → `migrate deploy` from empty fails → **squash a clean `0000_init` baseline before provisioning tenant #1.**
- **Endpoints for the cutover:** pooled `ep-sparkling-shape-akguwfol-pooler.c-3.us-west-2.aws.neon.tech` (app `DATABASE_URL`); direct `ep-sparkling-shape-akguwfol.c-3.us-west-2.aws.neon.tech` (use for `pg_dump` / `DIRECT_DATABASE_URL`).

**Render** (read via MCP): prod service `sobhana-portal` (main branch, repo `sunkenship2025/sobhana-portal`, rootDir `health-hub-backend`, Docker, Oregon, port 10000, `/health`) is on the **Starter plan = 512 MB RAM** — which is exactly why PDF concurrency is pinned at 2; **CX23 (4 GB) is 8× that headroom.** **No Render Key Value and no Render Postgres exist** → Postgres is Neon (confirmed) and **Redis is external — not Render-managed** (and no Upstash reference in the repo, so the exact provider lives only in the prod `REDIS_URL`, which the Render MCP doesn't expose for reading; grab it from the dashboard if it matters). Two suspended free `-dev` services (ignore).

**Vercel** (read via MCP): project `sobhana-portal` — **Vite, Node 24**, custom domain **`sobhanaportal.com`** (+ www), latest prod deploy READY. (`get_project` doesn't return env vars; `VITE_API_BASE_URL` is known from the repo = `reports.sobhanaportal.com`.) → per-tenant CF Pages build reproduces this cleanly (Vite build + one API-base env + custom domain).

**Live 7-day metrics & logs (read via MCP — Jul 4, replaces all sizing assumptions):**
- **Memory: avg 275 MB / peak 378 MB of the 512 limit (74% peak).** Thin headroom — one extra concurrent Chromium (~150–250 MB) would OOM. This *empirically* validates PDF concurrency=2. On CX23's 4 GB the constraint vanishes.
- **CPU: avg 0.003 cores / peak 0.011 of 0.5 (≈2% peak). CPU is idle — never the bottleneck.** 25 tenants at this profile ≈ ~0.28 cores peak.
- **Traffic: 29,410 req / 7 days ≈ 4,200/day, peak 634/hr (0.18 req/s).** 25 tenants ≈ ~1.5 req/s peak — trivial. HTTP p95 latency not emitted on this plan.
- **Health: zero `error`-level logs, zero OOM, zero crashes, instance count steady at 1** over the window. The app is healthy.
- **DB actual size: 28 MB** (94.5 MB synthetic incl. WAL/history) — confirms the <10 GB / 25-tenant disk math with margin.
- **New findings that became decisions (see §26):** (a) **no staging gate** — every push auto-deploys to prod (13 deploys in one Jul-3 evening, `migrate deploy` on each); (b) **bots already probe the API** (`/wp-admin/setup-config.php`) → rate-limit/fail2ban needed once 25 tenants share one host; (c) **Node drift** — Docker build runs Node **18.20.8** while deps need ≥20 (pin 22 LTS in self-host image); (d) **`pg_stat_statements` NOT installed** on Neon → zero slow-query observability today; (e) Neon **compute never suspends** (`suspend_timeout=0`, always-on billing) and **DB is publicly reachable** (no IP allowlist) — both fixed for free by on-box Postgres bound to localhost.

---

## 26. Decisions surfaced by the live-metrics pass (Jul 4)

The metrics *confirmed* sizing (CX23 start, on-box Postgres) and surfaced four genuinely new hardening decisions to land during migration:

1. **Staging gate + manual promote (NEW).** Auto-deploy-to-prod is fine for one client; with 25 tenants behind one process + one migration run, a bad deploy is a fleet-wide outage. Add a staging env; GHA builds → deploys staging → manual promote to prod. *(Rec: adopt.)*
2. **Observability floor (NEW).** Install `pg_stat_statements`; add a log drain + one uptime/error alert. Currently blind to slow queries and crashes beyond Render defaults. *(Rec: adopt, lightweight.)*
3. **Pin Node 22 LTS in the self-host Dockerfile (NEW).** Ends the 18-vs-≥20 drift. *(Rec: adopt during migration.)*
4. **API abuse hardening (NEW, sharpens §19).** Per-IP + per-tenant rate-limiting at the Caddy/app layer + fail2ban; bots are already probing. *(Rec: adopt.)*

Reaffirmed by data (no longer assumptions): **CX23 start** (2% CPU, 74% of a 512 MB plan) and **DB-per-tenant Postgres on-box bound to localhost** (28 MB of idle data doesn't justify managed always-on compute, and it closes the public-exposure + always-on-billing findings at once).

---

## 24. Access model / roles (decided Jul 4)

Vendor controls the clinical template; the client runs the lab.

- **`super`** (NEW role — vendor/platform): the vendor's per-tenant account (the seeded `support@healthflow.in` account, role `super`, **disabled by default — client enables on request**). Full access to everything, **including the config a client must NOT touch: clinical definitions, panel definitions, departments, and signing doctors / signatories** (the Config Center's clinical sections).
- **`owner`** (client): runs the lab — money, operations, reports — and **manages their own users/roles** (staff / lab_incharge / sales). The clinical-config sections are **hidden/blocked** for owner.
- **`staff` / `lab_incharge` / `sales`**: below owner, as-is (`lab_incharge` can finalize reports).
- **Enforcement:** backend `requireRole('super')` on the catalog/config routes (`/clinical-definitions`, `/clinical-panels`, `/departments`, `/signing-doctors`) — this also **fixes the authz-audit gap** (those routes are currently ungated, any authed user can edit). Frontend hides the clinical Config-Center sections for non-super.
- **Catalog is per-DB-per-client:** seeded at onboarding from `catalog-seed.json`, then each client's copy is **independent** — a later vendor fix (e.g. a reference-range correction) is per-client or a scripted loop across tenant DBs (the per-DB tradeoff).
- **Seed reconcile (Phase A):** `seed-tenant.ts` currently creates role `admin` (stale). Fix: create the vendor account as `super` (disabled) and the client bootstrap user as `owner`.

---

## Appendix A — Complete leak inventory (deep sweep)

> **⚠️ THIS INVENTORY IS A POINT-IN-TIME SNAPSHOT (early Jul 2026) — the codebase keeps moving.** Concurrent sessions ship features weekly, and each can add new hardcoding. **Re-run a fresh sweep immediately before executing the Phase-1 de-hardcode, do not trust this list as complete.** Known additions since the snapshot (from the Jul-4 feature burst): **`reportGateway.ts`** (new QR report-gateway landing page — hardcodes `sobhana-logo-cropped.png` + brand colours like `#1c5a94`; a whole new public branded surface → per-tenant theming); **`moneyDaySheetExportService.ts`** (new export, likely a hardcoded "Sobhana" creator); **`create-mallikarjun-staff.ts`** (new Sobhana-specific staff-creation ops script → add to A3, must not ship to tenants). The QR *URL* itself is fine — built dynamically from `req.get('host')`, so multi-tenant-safe.


Three exhaustive follow-up sweeps (frontend, backend, data/content layer) beyond the first audit. Together with §9b/§9d this is the **authoritative checklist for Phase 1** — every known Sobhana/India-specific item, including the small ones.

### A1. Structural findings that de-risk the whole plan

- **⚠️ BLOCKER — the migration chain cannot build a fresh DB (verified Jul 3).** `prisma migrate deploy` against an empty database FAILS: `relation "TestDefinition" does not exist`. None of the 54 migrations create the new-architecture tables (`TestDefinition`, `ClinicalPanel`, `BillableProduct`, `ClinicalPanelItem`, `TestDefinitionRange`, `BillableProductPanel`) — the entire live schema layer was applied to prod out-of-band via `prisma db push`/manual SQL (the root `fix_migrate.sql`/`fix_migrate2.sql`/`migrate.sql` files are the evidence). Prod schema and migration history have diverged. **Consequence for provisioning:** a new tenant CANNOT be created with `migrate deploy`. Two fixes: (a) **squash a clean baseline** — `prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` → one `0000_init` migration, mark it `--applied` on prod via `migrate resolve`; or (b) **provision with `prisma db push`** from `schema.prisma`, which deterministically materializes the correct schema (this is what the verified seed test used — `db push` built the full schema in 233 ms). Recommendation: do (a) so tenants share a real migration history, but (b) is the immediate unblock. This must be resolved before Phase 3.
- **Migrations carry zero data.** No `INSERT` in any migration SQL; the two `UPDATE`s are empty-table backfills. A correctly-built fresh tenant DB gets pure schema — no Sobhana rows leak through schema creation.
- **Bill/report numbering is already tenant-safe.** `numberService.ts` builds prefixes dynamically (`D-{branch.code}`, `C-{branch.code}`, `P-`, `RD-`, `CD-`); `NumberSequence` rows auto-create on first use (`ON CONFLICT DO NOTHING`). A client's own branch codes become their bill numbers with zero work.
- **Minimum viable tenant seed = 1 Branch + 1 admin User.** Everything else degrades gracefully (reports render placeholder signer blocks without SigningRules; lab-incharge block simply omits) or is admin-configurable via UI (departments, panels, products). `POST /api/auth/register` requires an existing `admin` caller, hence the bootstrap user.
- **No vendor backdoor / no cross-tenant auth.** JWTs carry `{id, email, role}` against the tenant's own DB; there is no super-admin tier. **Policy decision for `new-tenant.sh`:** deliberately create a vendor support account per tenant (visible to the client) or don't — currently the only vendor access path is DB-level.
- **Confirmed clean categories** (searched, nothing found): WhatsApp message body copy (all params dynamic), R2 key prefixes, JWT issuer/cookie names, `if (branchCode === 'CNT')`-style logic outside `billPdfService`, email senders (none exist), localStorage keys, `wa.me` links, runtime `document.title`, schema enums, Dockerfile.

### A2. Security actions (Phase 0 — see §11)

| Item | Where | Action |
|---|---|---|
| Full **live production pg_dump** in repo (real emails, IPs, audit logs) | `extras/pre-onboarding-backup-2026-05-04.sql` | Delete; purge from git history if ever pushed |
| Live opencode.ai API key | `go-proxy.js` (repo root) | Remove file, rotate key |
| Live Neon URLs + WhatsApp access token on disk | `health-hub-backend/.env` (untracked, but present) | Rotate credentials |
| Real doctor signature images | `public/images/signatures/*.png` | Never ship in tenant images; in-DB base64 already exists |

### A3. Seed & operational scripts — none may ship to tenants as-is

| File | Problem | Action |
|---|---|---|
| `prisma/seed.ts` (+`seed.js`) | Creates 4 Sobhana branches (CNT/IDPL/JGG/BLN + Hyderabad addresses), `@sobhana.com` users with `password123` (printed to console!), TSMC-numbered doctors, Chintal-specific pricing; seeds only 8 toy tests | **DONE — replaced by `seed-tenant.ts` (see A7).** Retire this file |
| `prisma/seed-full-catalog.ts` | Hand-written ~100-test catalog seeded into the **legacy** `labTest`/`panelDefinition` tables — which prod no longer uses (`panelDefinition` count = 0 in prod) | **Superseded by A7.** Retire — it seeds dead tables |
| `prisma/harden-accounts.ts` | Sobhana owner/staff/cto accounts, real names | Sobhana-only ops script — move out of the shared codebase |
| `prisma/onboarding-reset.ts` | 11 real Sobhana staff, hardcoded sequence IDs `diagnostic-CNT/BLN/IDPL/JGG` | Same — Sobhana-only; if generalized, derive sequences from `Branch.findMany()` |
| `prisma/seed-full-catalog.ts` | "Sobhana Diagnostics" labels + seeds a real signing doctor (`Dr. Aruna`, KMC reg, signature path) | Keep the test/panel taxonomy (it's the valuable catalog!), strip the doctor identity + brand strings — this becomes HealthFlow's default catalog seed |
| `prisma/delete-visits.ts`, `clear_table.js`, `health-hub-backend/scripts/*` (6 ops scripts), `check/*` test files (12 files with `@sobhana.com` creds), `check/authTestConfig.js` | Sobhana bill numbers/emails/branch names in examples & configs | Internal tooling — exclude from tenant delivery; point test creds at env vars |
| Root: `bill-preview.html`, `plan-integration.txt`, stray `backend.log`/`backend.pid` | Sobhana artifacts | Clean up / gitignore |

### A4. Frontend — net-new de-hardcode items (adds to §9d)

| File | Issue | Fix |
|---|---|---|
| `src/store/appStore.ts` L24–120 | **Sample data served on a live route**: fake doctors (Dr. Meera Sharma, TSMC regs), fake patients (John Doe, Rahul Kumar), fake visits with `D-MPR`/`D-KPY` bill prefixes — consumed by `DoctorDashboard.tsx` mounted in `App.tsx` L149 | Delete or gate behind `import.meta.env.DEV`; wire to API |
| `src/components/print/ReportPrint.tsx` | Dead component with placeholder letterhead ("DIAGNOSTIC CENTER, 123 Medical Street") — unrouted, unimported | Delete |
| `src/components/layout/BranchConfirmModal.tsx` L72/90/140 | Raw `#1B2B58`/`#D91C2B` outside the theme system | CSS vars |
| `src/pages/Login.tsx` — 11 lines (L41–154) | Same raw hexes throughout the login panel (beyond the heading already known) | CSS vars from build-time theme |
| `public/sobhana-logo-cropped.png`, `sobhana-whitebg.png`, `sobhana-blackbg.png` | Brand logos in frontend public root (two unreferenced) | Per-client asset swap in build; delete unreferenced |
| `public/pngtree-flat-microscope-image_1174913.jpg` | Watermark-named stock image of dubious licensing | Replace with licensed asset |
| `index.html` L10/11/15 | `description`, `author`, `og:description` metas (beyond title/og:title already known) | `VITE_APP_NAME`/tagline |
| `.env.example` L3 | Default = **live Sobhana prod URL** — a client who forgets to override points at Sobhana's API | Neutral placeholder |
| `src/lib/api.ts` L5, `src/lib/reportAccess.ts` L60/104–107, `src/types/index.ts` L8/12 | "Sobhana" in comments | Cleanup pass |
| `OutsideLabs.tsx` L334, `ManageClinicDoctors.tsx` L258, `ManageDoctorsAndReferrals.tsx` L1047/1059/1238, `ManageSigningDoctors.tsx` L1135, `ManageDiagnosticCenters.tsx` L258 | Placeholders naming Thyrocare (Mumbai) and TSMC (Telangana medical council) registration formats | Generic placeholders (reg-number format hint could come from LabProfile) |
| `OwnerMoneyPage.tsx` L322/384/455/500 | Business-rule thresholds hardcoded: ₹1,000 discount warning, >30% discount tint, 70%/80% cash tints | LabProfile config fields |
| `package.json` L2 | `vite_react_shadcn_ts` scaffold name | Rename `healthflow-portal` |
| ~25 files | `en-IN` locale + `₹` symbols pervasive (patient360/*, payout formatters, selectors, owner pages) | One shared `formatCurrency`/`formatDate` util reading locale/currency from config — do the *centralization* in Phase 1 even though the *value* stays ₹/en-IN until Vietnam |

### A5. Backend — net-new de-hardcode items (adds to §9b)

| File | Issue | Fix |
|---|---|---|
| `ownerOperationsService.ts` L25, `ownerDoctorsService.ts` L24, `ownerMoneyService.ts` L27 | `IST_OFFSET_MS = 5.5h` manual UTC→IST day-boundary math (3 more files beyond the known one) | One shared `getTodayBoundary(tz)` util on `BUSINESS_TIME_ZONE` |
| `billPdfService.ts` L64/271/277, `notificationService.ts` L407/521, `payoutService.ts` L582, `payoutExportService.ts` L17/36/38 (incl. `RUPEE_FMT` lakh/crore Excel format), `reportRendererService.ts` L36, `statementDownload.ts` L56/59, `ownerOperationsService.ts` L769/776 | `en-IN`/₹ formatting in PDFs, WhatsApp amount params, Excel exports | Same shared locale/currency util, per-tenant |
| `prisma/schema.prisma` L318/L369 | `ReferralDoctor.commissionPercent @default(50)`, `ClinicDoctor.commissionPercent @default(100)` — Sobhana's commission policy as schema defaults | Make per-tenant LabProfile defaults applied at row-creation; schema default becomes neutral |
| `.env` L8 | `GUPSHUP_SENDER_ID="SOBHANA"` (dead code path, but the pattern: SMS sender ID is per-tenant) | Tenant registry when/if Gupshup is implemented |
| `.env.example` L28 | `api.sobhana.in` example URL | Genericize |
| `package.json` L4/L27, `README.md` L1/31/382–390 (incl. your local machine path), `IMPLEMENTATION_SUMMARY.md` L288 | Brand + `sobhana-backend` image names + `/Users/pranavreddy/...` path in docs | Rename/rewrite |
| `authService.ts` L44, `middleware/auth.ts` L19, `mergedReportPdfService.ts` L6, `diagnosticVisits.ts` L4225 | "Sobhana" in comments/JSDoc | Cleanup pass |
| `reportRendererService.ts` L35 | `BUSINESS_TIME_ZONE || 'Asia/Kolkata'` fallback default | Require explicit value at tenant provisioning (fail fast if unset) |

### A7. Default catalog seed — BUILT & VERIFIED (Jul 3)

The hand-written seeds were inadequate (toy data / dead tables). The real catalog lives in prod, so the default HealthFlow catalog is now **extracted from the live DB and sanitized**, not hand-authored. Two new files:

- **`prisma/extract-catalog.ts`** — connects to a source DB (`DATABASE_URL`), pulls ONLY the new-architecture taxonomy (`Department → TestDefinition → ClinicalPanel → BillableProduct` + ranges/rules/items/lines), and writes `prisma/catalog-seed.json`. Sanitization: never queries identity tables (signing doctors, branches, users, patients, pricing overrides, referral/clinic doctors, external labs); ignores legacy tables; collapses TestDefinition clone-on-edit history to a clean v1 baseline (`version=1, isLatest=true, rootDefinitionId=self`); **rounds product prices to neutral bands** (≤₹500→₹50, ≤₹2000→₹100, else ₹250 steps; 0 preserved) so the repo never carries Sobhana's exact rate card; drops referential-integrity orphans.
- **`prisma/catalog-seed.json`** — the committed snapshot. Extracted counts: **7 departments, 158 test definitions, 26 reference ranges, 69 clinical panels, 168 panel items, 173 billable products, 104 product lines.** Brand-clean (0 "obhana" occurrences in any text field; the 4 radiology narrative templates are clean). Re-run the extractor to refresh when Sobhana's catalog materially changes.
- **`prisma/seed-tenant.ts`** — canonical fresh-tenant bootstrap. Loads the snapshot, inserts the catalog in FK order, then creates one Branch + one admin User (params from env: `TENANT_LAB_NAME`, `TENANT_BRANCH_*`, `TENANT_ADMIN_*`) + a **disabled vendor support account** (`support@healthflow.in`, `isActive=false`, client enables on demand). Guards against non-empty DBs. Creates no patient/visit/billing data and no signing doctors.

**Verified end-to-end** against a throwaway local Postgres 17 cluster (schema via `db push`, never prod): counts round-trip exactly; `signingDoctor/patient/visit = 0` (no PII); all 173 prices on-band; all test defs v1/self-root; 2 users (admin active, support disabled); 0 brand leakage. Provisioning integration: `new-tenant.sh` runs schema build (`db push` or squashed baseline — see A1 blocker) then `seed-tenant.ts` with the client's params.

Still to do: retire `seed.ts`/`seed-full-catalog.ts`; resolve the A1 migration-baseline blocker; wire LabProfile row creation into `seed-tenant.ts` once that table exists (§9a).

### A9. Theming / brand colours — GOOD-NEWS STRUCTURE (analysed Jul 4)

Colours *look* everywhere but are driven by a **small source**, so this is a ~2-hour theming task, not a sprawling find-replace:
- **Source of truth = 5 CSS vars in `index.css` (46-50):** `--branch-sidebar-bg/#1B2B58`, `--branch-sidebar-active`, `--branch-banner-bg`, `--branch-accent/#D91C2B`, `--branch-accent-fg`. Swapped per-branch by `branchTheme.ts`. Tailwind wires `primary`/`sidebar` to `hsl(var(--…))`, so **semantic tokens (`bg-primary` etc., ~40 files) re-theme for free** when the source vars change — they're not hardcoded.
- **Fix = drive those 5 vars (+ `branchTheme`) from `LabProfile`** per tenant → the whole UI re-themes.
- **Then fix the ~4 files that bypass the theme with raw hex:** `Login.tsx` (11 hits), `BranchConfirmModal.tsx` (3), the new `reportGateway.ts` (3, the QR landing page), and `#cc2222` in `report-screen.css`/print. (~28 direct brand-hex hits total across ~8 files; inline `[#…]` Tailwind hardcoding is in only 2 files.)

### A6. Sweep coverage

Searched dimensions: brand strings (sobhana/SDC/sobhanaportal + branch names + pincodes + phone numbers + staff names), logos/assets/favicons/manifest, raw brand hex colors, currency/locale/timezone (₹, en-IN, IST offsets, Excel formats), placeholders/sample data, seed & ops scripts, migration SQL data, schema defaults/enums, number-sequence prefixes, WhatsApp copy, R2 keys, JWT/cookies, URLs/domains, package metadata/docs, branch-code conditionals, email senders, localStorage, vendor-access paths. Residual risk: strings assembled dynamically at runtime and the *live DB content* itself (Sobhana's narrative templates, branch rows — but DB-per-tenant makes that moot for new clients).
