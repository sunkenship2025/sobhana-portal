# HealthFlow — Product, Business & Compliance Roadmap

**Date:** July 3, 2026. Companion to `HEALTHFLOW_SELFHOST_PLAN.md` (which covers infra/tenancy). This doc covers the **product, business, compliance, and scale layers** — the parts that make HealthFlow *sell and last*, not just *run*. Built from 4 design tracks + market research. Solo founder, ~25 small Indian diagnostic centres, ₹999/mo.

Effort: **S** ≤2 days · **M** ~1 week · **L** 2–4 weeks · **XL** month+. Priority: **MVP** (needed to charge the first paying client) · **Fast-follow** (first 90 days) · **Later**.

---

## 0. Competitive positioning — the wedge (read this first)

**You'll price per client (your call, per deal) — but know the market you're pricing into: it's two clear tiers, and the budget end is crowded.**

| Tier | Players | Price (market context) |
|---|---|---|
| Budget cloud | PathLIMS, Labsmart, ItHealth, Health Amaze | ₹417–999/mo |
| Premium | **CrelioHealth ₹8,000/mo + ₹10k–50k onboarding**, MocDoc, Drlogy (opaque) | ₹8k–25k+/mo |

Implications that shape everything below (independent of the exact number you set):
- **"Cheap white-label clone" is not a strategy.** Established players sit at the budget end with real features (Labsmart: NABL formats + doctor portal + WhatsApp; Flabs: ABHA + analyzer + AI interpretations). You cannot win on being cheapest — the floor is ₹417.
- **The real wedge is Crelio's underbelly.** Labs that want Crelio-grade capability — **analyzer interfacing, multi-branch, white-label** — but can't stomach ₹8k/mo + a ₹50k onboarding fee. That's "premium features at a budget price," which matches your GTM stance ("premium value, not cheapest").
- **Three concrete differentiators the research surfaced:**
  1. **Affordable analyzer interfacing** — the single feature that otherwise forces a lab up to expensive Crelio, and which cheap vendors mostly *lack* (ItHealth explicitly has none). Hardest to build, highest moat. (§1)
  2. **Transparent pricing** — most competitors (Drlogy, Flabs, Itdose, ElabAssist) are phone-gated. Public pricing is itself a trust differentiator.
  3. **A genuinely better report + WhatsApp experience** — the daily surface the lab and patients actually touch.

**Wedge (decided):** launch on transparent pricing + report/WhatsApp polish; **analyzer interfacing = the 90-day moat** — it's what lets you charge a premium-ish budget price *and* pull labs off Crelio.

---

## 1. Product & clinical features

### 1a. Analyzer / machine integration — the moat (deep-dive)

**The reality:** ~85% of India's 120,000+ labs run on paper/Excel with no LIS; manual result-typing is the norm; 7.7% of manual reports carry transcription errors. Analyzer interfacing is a *paid, rationed* feature even at market leaders (Crelio meters it: 3 interfaces on the entry plan). So it's a **differentiator to grow into, not table-stakes for launch.**

**The hard part for a *cloud* LIS:** analyzers sit on the lab's bench and speak **HL7 or ASTM over serial (RS-232) or local TCP** — they cannot reach a Germany-hosted server directly. You need a small **on-prem agent** at each lab: a lightweight app (or a cheap mini-PC / Raspberry Pi) on the lab LAN that listens to the analyzer, parses ASTM/HL7, and pushes results to `api.healthflow.in` over HTTPS, keyed to the tenant + a pending TestOrder.

**Architecture:**
```
Analyzer (ASTM/HL7 over serial/TCP) → on-prem HealthFlow Agent (parses, buffers, maps sample-ID→TestOrder)
   → HTTPS POST to api.healthflow.in/ingest → result lands as a draft on the matching order → tech reviews & finalizes
```
- Start **unidirectional** (analyzer → LIS; results flow in, tech still reviews). Bidirectional (LIS pushes the worklist to the analyzer) is a v2.
- **Don't build a full interface engine.** Use/embed **Mirth Connect (NextGen Connect)** — the open-source HL7/ASTM engine — inside the agent, or write a focused ASTM parser (the protocol is simple for the common analyzers). A full commercial interface engine is 6-figure territory and needs certified staff you don't have.
- **Effort: L–XL** for the first analyzer model; **M** per additional model (each speaks a slightly different dialect). Ship one common analyzer first (whatever your pilot lab runs — often a Mindray/Erba hematology or a common biochem unit), prove it, expand.
- **Honest take:** this is the single hardest thing on the roadmap and the biggest moat. A solo founder *can* ship unidirectional single-analyzer interfacing, but it's a 90-day project, not a launch item. Sell launch on other strengths; land analyzer as the upsell that pulls Crelio's customers.

### 1b. The rest, prioritized

| Feature | Value | Effort | Priority |
|---|---|---|---|
| **Patient report portal** — WhatsApp "report ready" nudge → **OTP-gated PWA** (not native app, not inline PDF — inline sits in a DPDP/Meta gray zone) | Table-stakes UX; compliant delivery | M | **MVP** (you have tokenized links; add OTP gate + PWA shell) |
| **Analyzer interfacing** (§1a) | The moat vs Crelio | L–XL | Fast-follow (90-day) |
| **Result-based reminders / recall** (repeat-test nudges) | Repeat revenue for the lab. NOTE: a 2024 Punjab RCT shows WhatsApp reminders *don't reliably change* follow-up behavior — **market on convenience, not clinical adherence** | S–M | Fast-follow |
| **Referring-doctor portal** (doctors see their patients' reports + commissions) | Sticky for the lab's referral network; you already have referral/payout data | M | Fast-follow |
| **Home sample collection** (booking + phlebotomist assignment + doorstep barcode/UPI/**digital consent**) | Patient expectation; small labs can't staff it and lose walk-ins to aggregators. Per-visit *barely breaks even* (₹130–230 cost vs ₹100–200 charge) → only viable above a min test-basket. **Build booking/assignment/consent in-house; INTEGRATE routing (Dista/Locus/Google Route Optimization) — don't build a VRP solver.** Digital consent + clean UPI flow are where existing apps are weak = the differentiation | L | Later (Axora-toggleable module) |
| **WhatsApp/SMS marketing campaigns** to a lab's patients | Upsell; but marketing templates cost 7.5× utility templates — keep separate | M | Later |
| **Reagent / inventory management** | Nice-to-have for bigger labs; not why a small lab buys | M | Later |
| **NABL/accreditation reporting** (IQC, Levey-Jennings) | Only for NABL-seeking labs (a minority of your base) | L | Later / on-demand |

**Do NOT build (solo, at 25 labs):** a universal data migrator, native mobile apps, a full interface engine, inventory/NABL before there's demand.

---

## 2. SaaS business layer (currently doesn't exist)

**The keystone: a central Control DB.** Add one Postgres DB (separate from tenant data) — a `tenants` registry: `tenant_id, subdomain, db_name, display_name, gstin, plan, status (trialing|active|past_due|suspended|canceled), trial_ends_at, next_billing_date, gateway_customer_id, gateway_subscription_id, last_payment_at, last_login_at`. **Billing, dunning, suspend, admin console, and provisioning all key off this one table.** Half a day of schema; organizes the entire business layer. **MVP.**

| Capability | Decision | Effort | Priority |
|---|---|---|---|
| **Recurring billing** | **Razorpay Subscriptions + UPI Autopay** (Stripe India is invite-only — out). **Price is per-client — you set each client's amount + interval at deal time** (no fixed plan). Store `plan_amount` + `plan_interval` (monthly/yearly) on their Control-DB row; create the Razorpay plan/subscription from those. Support **monthly and yearly** intervals (yearly cuts churn AND cuts auto-debit-failure exposure from 12 charges/yr to 1). Wire `subscription.charged/halted`, `payment.failed` webhooks → Control DB | M | **MVP** |
| **Autopay vs manual + pre-due reminder** | Client either sets up a **UPI Autopay mandate** (auto-debits on due date) or pays **manually**. For **non-autopay clients, send a WhatsApp reminder 3 days before the due date** with a pay link; autopay clients get at most a light "will be debited on {date}" heads-up. Track `autopay_enabled` + `next_billing_date` per client; a daily cron messages non-autopay tenants due in 3 days. **Autopay friction threshold (know this when you set a client's price):** UPI Autopay is PIN-free only for mandates **≤ ₹2,000/debit**; above that each debit needs a PIN (AFA), which breaks true auto-pay — so for a higher monthly price prefer a **yearly** mandate or a card e-mandate | S | **MVP** |
| **Dunning** | **Auto-debit success is only 30–50%** — dunning IS revenue infra, not optional. WhatsApp-first (98% open vs 20% email) + UPI link. Sequence: D-3 reminder → D0 fail → D+1/D+3 nudge → D+5 email → D+7 suspend | S | **MVP** |
| **Auto-suspend** | **`status` flag checked in middleware → HTTP 402**, NOT Postgres role revocation. Two-phase: grace (banner) → read-only (GET works, writes 402). Never delete. JWT stays valid; the middleware DB/cache check is the gate | S–M | **MVP** |
| **Reactivation** | Gateway webhook `subscription.charged` → `status='active'`; next request passes middleware | S | **MVP** |
| **Invoicing / GST** | SaaS = 18% GST, SAC 9983. Mandatory reg only >₹20L/yr (~167 clients) — but **register voluntarily early** (clients want a GST invoice for input credit). Razorpay Invoices or a PDF from Control DB | S | MVP (basic) |
| **Free trial** | 14-day, **clock starts at go-live** (not signup), WhatsApp follow-up D7/D13 | S | MVP |
| **Onboarding** | **White-glove for all 25** (high-touch migrations). Kick off WABA on **day 0** (the 3–5 day long pole). Async owner config (photo the letterhead, bulk-import catalog, recorded training). Target: first real report in 48h, live in 7 days. Full checklist in the business track | L (time) | **MVP** |
| **WABA / BSP** | **AiSensy** (₹999–2,199/mo, Embedded Signup ~48h). **Classify report + payment messages as UTILITY templates (~₹0.115) not MARKETING (~₹0.86)** — 7.5× cost error if wrong | S | **MVP** |
| **Per-client WhatsApp message rate limit / quota** | **DECIDED: HealthFlow pays for WhatsApp** (messaging rides a shared BSP credit) — so a **per-client cap on outbound messages is essential cost-protection**, not just a feature limit: a buggy or heavy client can otherwise run up *your* Meta bill. Configurable per client (N/month + optional burst rate/min). Reuses the tenant-prefixed Redis counters (P1-4/6): before each send, increment `msgcount:{tenant}:{yyyymm}`; if over the client's limit → **block the send + alert the client and you**. Also doubles as **plan tiering** (bundle "up to N messages" into the client's price, meter overage). Limit stored per client | S–M | **MVP** (basic monthly cap) |
| **Patient data import** | Ship a **demographics CSV importer** (BullMQ + fast-csv, dedup on phone+name, keep `legacy_id`); **catalogs white-glove**; **historical results deferred**. #1 adoption blocker — be honest it's mostly hands-on | M | MVP (demographics); catalog later |
| **Support & SLA** | Publicly promise **"within 1 business day."** WhatsApp fast-lane + **Crisp free** (system of record) + the built-in per-tenant support-account impersonation | S | **MVP** |
| **Status page** | **Uptime Kuma self-hosted** on the Hetzner box → `status.healthflow.in` | S | MVP |
| **Cross-tenant admin console** | **Retool free** over the Control DB now (provision/suspend buttons, health table) → tiny Express `/admin` later. First 3 metrics: last-login, 30-day report count, subscription status (catch ~80% of churn) | S | **MVP** |

---

## 3. Compliance & trust (you're the Processor; each clinic is the Controller)

**Legal ground state (Jul 2026):** DPDP Act + Rules notified Nov 2025; substantive obligations enforceable **May 13, 2027** (~10-month runway). **German hosting is defensible today** — Section 16 negative-list is empty, Germany not restricted. But **DPAs and per-tenant legal pages are needed from day one** (they're B2B contract requirements, not just regulation).

| Item | Launch-blocker? | Effort | Notes |
|---|---|---|---|
| **DPA per clinic** (processor/controller, sub-processor schedule: Hetzner/Cloudflare/Backblaze/Meta, 4-hour processor→clinic breach clause, cross-border ack) | **YES** | Low (paperwork + e-sign via Digio) | **Get an Indian data-protection lawyer to review before the first clinic** |
| **LabProfile legal fields** (legalName, registeredAddress, grievanceOfficer, retentionPolicyDays default 2555=7yr) | **YES** | Low | Schema + UI |
| **Per-tenant Privacy Policy + ToS** (parameterized from LabProfile, served at `/[slug]/privacy`; tokenized report links footer to the *right* tenant's policy) | **YES** | M | Template-render, don't store full text |
| **Affirmative WhatsApp delivery consent** at registration (already have `whatsappOptIn`) + **separate `whatsappMarketingOptIn`** (Act bans bundled purposes) + a `ConsentLog` table | **YES** | Low | Core LIS processing itself likely covered by the clinical-establishment exemption — reduces consent burden |
| **Breach runbook** + processor→clinic 4-hour alert mechanism | **YES** | Low | Alert on unusual export volume / failed-login spikes |
| **AuditLog hardening** — add enum actions (CONSENT_CHANGE/EXPORT/ERASURE/RIGHTS_REQUEST), **revoke UPDATE/DELETE on the table from the app role** (make it truly append-only), add `actorType` | No (do now) | Low | |
| **AuditLog retention & erasure — RESOLVED (user Jul 4):** (1) **keep forever** (no prune/TTL — medico-legal trail; growth is ~2.5 MB/tenant/yr, negligible on-box); (2) **audit logs are EXEMPT from DPDP erasure as a "legal record"** — patient PII in `oldValues`/`newValues` diffs stays; erasure scrubs the live tables, not the audit trail. Zero code change; **document both in the DPA + privacy policy** so the exemption is disclosed | No (paperwork) | Low | DPA/privacy-policy clause, not code. Scale/isolation already handled free by DB-per-tenant |
| **Per-branch backup files** (not monolithic dumps) | No (do now) | M | Prerequisite for surgical erasure |
| **Data export + right-to-erasure workflows** | No (pre-2027) | M each | **DB-per-tenant makes erasure ~3 commands (drop DB + rm objects + flush Redis) — a strong compliance argument for that migration** |
| **HFR registration** per tenant (free NHA facility ID) | No (but do it) | Low | Visible credibility signal to owners |
| **Full ABDM/ABHA HIP integration** | **NO — DEFER** | XL | Optional (no mandate), heavy (FHIR R4 + LOINC/SNOMED mapping + gateway + mandatory security audit), ~35% patient awareness. **Conflicts with German hosting** (ABDM wants India-localized data). Do only post-PMF, and migrate to Hetzner Helsinki / AWS Mumbai first. Collect optional ABHA ID field now to build the data asset |

**Lawyer-review list (don't self-serve):** the DPA template, SDF-threshold assessment (health data is a risk factor), clinical-establishment exemption scope for WhatsApp delivery, exact retention period (Clinical Establishments Act + NABL), erasure-vs-retention conflict, CERT-In 6-hour/India-log applicability to a Germany-hosted vendor, liability-cap enforceability.

---

## 4. Scale, reliability & white-label depth

**The key insight: tenant count is nearly free; concurrent PDF renders are the cliff.** An idle tenant DB is ~8 MB and Postgres `shared_buffers` is global, so 25 (or 50) tenant DBs cost almost nothing. The box dies on **RAM — one pathological Chromium render can consume 10 GB+ and OOM-kill everything** (it's a cliff, not a slope). So reliability reduces to **four cheap disciplines before launch**, and everything else is signal-driven:
1. **Bounded Puppeteer pool** (max ~4–6 concurrent pages, hard per-job memory cap, recycle the browser every N jobs) + **cgroup-isolate Chromium** so a render storm can't starve Postgres. *This is the single most important control — it turns a potential OOM into a few seconds of queue latency.*
2. **PgBouncer** (transaction mode) in front of the tenant DBs — each raw PG connection is 5–10 MB; without pooling, 25 tenants' connection storms are the second failure mode.
3. **Nightly encrypted per-tenant `pg_dump` → restic → Backblaze B2** (restic is AES-256 by default — you can't forget to encrypt; avoid GPG/pgBackRest-passphrase footguns). Cost is trivial: ~$2/mo at 10 clinics, ~$13 at 25. **Verify every dump** (`pg_restore --list` + sha256) and **run a monthly restore drill** on a rotating 10–20% sample (untested backup = hope).
4. **One off-box uptime pinger (UptimeRobot free)** — the only page-me-now channel, lives off the box so it fires when the box is dead — **plus one on-box monitor (Beszel, <10 MB)**. Alert loudly on: API down, memory-pressure `avg10 >20%`/OOM rising, and **backup-failure** (silent backup failure is the real killer). One page channel, 15-min sustain windows, everything else to a daily digest.

**Growth path:** vertical first (CX33→CX43→**CX53 (16/32 GB, ~€22)**, a snapshot+reboot — a CX53 alone likely carries you well past 25 clinics), then **"cells"** (a full self-contained box per N tenants, `tenant_id→cell` claim in the JWT, no cross-cell traffic → one box dying hits only 1/N) for blast-radius containment at ~40–60+ clinics. Read replica: **probably never** (a LIS reads its own writes, no read-scaling problem). True HA isn't economically justified at ₹999 — sell "hourly/nightly backups, restorable in minutes," not "99.99% uptime."

| Capability | Decision | When |
|---|---|---|
| **Single-box SPOF** | One CX33 = single point of failure for all 25. Acceptable-risk for a ₹999 product IF backups are tested and a rebuild runbook exists. **Signals to split:** sustained CPU >70%, RAM headroom <1.5GB, or Chromium PDF queue backing up. **Growth path = "cells":** N tenants per box + a tenant→box route in the Control DB (you already resolve tenant centrally, so routing to a box is a small addition). Vertical bump (bigger Hetzner) buys time first | Design the cell-routing seam now; execute at strain |
| **Disaster recovery** | RPO ≤24h (nightly per-tenant dump) / RTO target few hours. **Run a real restore drill before onboarding client #1** (untested backup = hope). Encrypted, offsite (Backblaze B2). Written recovery runbook | **Before launch** |
| **Monitoring (solo)** | BetterStack (uptime + `/health`) + Uptime Kuma (status page) + Beszel (~10MB host metrics) + cert-expiry + nightly backup-success check. Per-request **tenant-tagged logging** (from the isolation work). Route alerts to one channel (WhatsApp/Telegram), tuned to avoid fatigue | **Before launch** |
| **White-label depth** | Launch: `client.healthflow.in` + branded reports/WhatsApp. **Custom domain** (`labname.com`): **Caddy On-Demand TLS** auto-issues a cert per domain on first handshake — but **gate it with the `ask` endpoint** (Caddy calls your API to confirm the domain belongs to a tenant, else anyone burns your Let's Encrypt rate limit). Per-tenant cert, not wildcard (clinics use their own apex domains). **Branded email**: Resend/Postmark, per-tenant verified domain + SPF/DKIM/DMARC (the friction is the clinic's DNS). **Branded WhatsApp**: Meta Embedded Signup → one shared backend, many per-tenant WABAs (Meta's supported model). All three = paid upsells, onboarded clinic-by-clinic | Later / upsell |
| **Axora modules** | Per-tenant `modules` flags on LabProfile (Diagnostics on; OP/IP later). In a unified codebase "module isolation" = route/UI gating by the flag, not separate services. **Build the toggle as convention now (a `modules` JSON + guards), a framework only when the 2nd module ships.** Don't over-engineer | Convention now; framework at OP/IP |

---

## 5. The phased roadmap (what actually ships when)

**Phase A — Foundation (before charging anyone).** The infra/tenancy work from the self-host plan (migration baseline fix, per-tenant PrismaClient, JWT tenant binding, Redis prefixing, de-hardcode→LabProfile) **+** the Control DB **+** Razorpay billing + dunning + suspend **+** WABA/AiSensy **+** white-glove onboarding checklist **+** demographics CSV import **+** DPA + per-tenant legal pages + consent + breach runbook **+** Retool admin console. **Plus the reliability non-negotiables:** bounded Puppeteer pool + Chromium cgroup isolation, PgBouncer, nightly encrypted per-tenant dumps→B2 with a *tested* restore, UptimeRobot + Beszel + backup-failure alert, pino tenant-tagged logging, and a `modules` JSONB field + module-folder structure (Axora-ready). *This is the true "MVP to charge a client" — it's bigger than the app itself.*

**Phase B — Fast-follow (first 90 days, land 3–5 pilots).** **Analyzer interfacing (one common analyzer)** — the moat. Patient PWA portal polish. Result reminders. Referring-doctor portal. HFR registration per client. Per-branch backups + export/erasure workflows.

**Phase B.5 — At ~5–10 clients (deferred, decided Jul 4).** **Location/access lock** — stop a client running multiple physical locations on a single-location plan (license enforcement, IP-based). Deferred; decide the mechanism details when we get there. Not needed at 3 clients.

**Phase C — Later (post-PMF / on-demand).** Home collection module. Marketing campaigns. Custom domains + branded email. More analyzer models. Inventory/NABL on-demand. ABDM (only after India-hosting migration). Axora OP/IP modules.

**The honest headline:** the launch bottleneck is **not the LIS** (that exists) — it's the **business + compliance + tenancy plumbing in Phase A**, which is weeks of solo work. The differentiator that justifies ₹999 over Labsmart's ₹417 is **Phase B's analyzer interfacing + report/WhatsApp polish** — so Phase A has to be lean enough to *get to* Phase B.

---

## Strategic decisions — RESOLVED (user, Jul 3)
1. **Lead wedge:** ✅ **Launch on transparent pricing + report/WhatsApp polish; analyzer interfacing = the 90-day moat.** Strategy: **advertise the full vision on the website, build features on-demand ("build-for-one")** — don't build analyzer/home-collection/etc. speculatively; build the first instance when a paying client needs it, then it's available to all. Two caveats: (a) **frame unbuilt features honestly** on the site ("available on request / we set it up for you", NOT implied-live) — overpromising to healthcare buyers erodes trust fast; (b) **build-for-one does NOT apply to Phase A** — the foundation (tenancy, billing, backups, DPA/consent, monitoring) is the *platform*, not a per-feature build, and must exist before client #1.
2. **Onboarding model:** ✅ **White-glove for all 25.**
3. **Home collection:** ✅ **Build it, but AFTER the first 25 clients** (post-25 module, differentiated on digital consent + clean UPI; integrate routing).
4. **ABDM:** ✅ **Ignore** (no integration; don't even collect ABHA IDs for now).
5. **Custom domains:** ✅ **Offer as a paid upsell** (Caddy On-Demand TLS + `ask`-endpoint gate).
