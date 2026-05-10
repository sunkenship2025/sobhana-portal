# Tier 2 — Operational Discovery Answers

Concise, factual answers grounded in the current codebase. UNKNOWN = not derivable from the source tree; likely owner identified.

---

## 1. Current customer-facing website state

**NOT FOUND** in this repository.

- The repo contains exactly one frontend (`health-hub/`), which is the staff portal (Vite + React + shadcn + Zustand). Pages enumerated under `health-hub/src/pages/`: `Dashboard`, `Login`, `BillPrintPage`, `ReportViewPage`, `NotFound`, plus folders `clinic/`, `diagnostics/`, `doctor/`, `legal/`, `owner/`. None are customer/storefront pages.
- No mention of a customer-storefront URL, repository, or routing in `index.ts`. There is no `/customer`, `/book`, or `/storefront` route.
- The only public web surface is the token-based PDF link at `/reports/:token`.

Likely owner: Marketing/Product team or a separate frontend repo not co-located here.

---

## 2. Existence of phlebotomist roster system

**NOT FOUND.**

- `grep` for `phlebotom`, `roster`, `home-collection`, `home_collect`, `sample_collect` produced no matches in `health-hub-backend/src/`.
- The only "sample collection" code path is `POST /api/visits/diagnostic/:id/collect-sample` in [diagnosticVisits.ts:3094](../../health-hub-backend/src/routes/diagnosticVisits.ts#L3094), which records a state transition for a specific visit — it does not assign or schedule a phlebotomist.
- `User.role` enum = `staff | doctor | owner | admin`. No phlebotomist role.

Nearest matching implementation: `collect-sample` route. Likely owner: Operations team — no system of record exists.

---

## 3. Branch service-area mapping

**NOT FOUND.**

- `grep` for `serviceArea`, `service-area`, `pincode` returned nothing in backend `src/`.
- `Branch` model fields: `id, name, code, address (free-text), phone, isActive`. No geometry, pincode list, or service polygon.

Likely owner: Operations / data team — would need a new schema (e.g. `BranchServiceArea` keyed by pincode) before customer storefront can route bookings.

---

## 4. Current home-collection workflow

**NOT FOUND** (no end-to-end workflow exists).

- No phlebotomist assignment, no scheduling, no transit tracking.
- The schema has no `pickup`, `homeCollection`, or `route` model.
- `Visit` is created with the full diagnostic flow already at branch — there is no "collected at home, brought to branch" state.

Likely owner: Operations.

---

## 5. Mobile-readiness of staff portal pages

**Partial.**

- Frontend uses Tailwind + shadcn-ui (`components/ui/sidebar.tsx` includes a mobile sheet variant; `hooks/use-mobile.tsx` exists; `health-hub/src/components/layout/Sidebar.tsx` references `useIsMobile`).
- No PWA manifest (`grep "manifest"` not surfaced; `vite.config.ts` does not register any PWA plugin in dependencies).
- No dedicated mobile routes; pages share a single set of routes with responsive Tailwind classes (`md:hidden`, `lg:hidden` patterns appear in the sidebar component).
- No native mobile app in this repo.

Practical readiness depends on individual page layouts; the framework supports responsive rendering, but no per-page audit is in source.

UNKNOWN: which exact pages have been QA'd on mobile. Likely owner: Frontend team.

---

## 6. Background job runner architecture

**No dedicated job runner is configured in this repo.**

- `package.json` of `health-hub-backend` lists `ioredis` (used for rate limiting + cache) but **does not** include `bullmq`, `node-cron`, `cron`, `agenda`, `kue`, or `bee-queue`.
- `grep "cron|setInterval|scheduledJob"` returned no scheduler in `src/`.
- The single deferred-execution pattern in code is **fire-and-forget dynamic `import()` for notifications** (e.g., `notificationService.sendReportReady`) — these run inside the originating request's process, not on a worker.
- Only Express-side concurrent work: `warmupPdfService()` (Puppeteer browser pool) called once at server start.
- Webhook handler ACKs 200 immediately and processes inline — no queue.

Notable consequences:
- WhatsApp send retries: none.
- Payout sync: lazy, runs synchronously inside `listPayouts(branchId)` calls.
- Stale data: `MessageLog` rows can stay `PENDING` indefinitely if a process crashes mid-send.

Likely owner: Backend team — no scheduled cron or queue exists today.

---

## 7. WhatsApp BSP details

**Provider: Meta Cloud API (direct, not via a BSP).**

- `whatsappCloudService.ts` posts to `https://graph.facebook.com/v21.0/{phoneNumberId}/messages` with `Authorization: Bearer ${WHATSAPP_ACCESS_TOKEN}`.
- Env vars consumed:
  - `WHATSAPP_PHONE_NUMBER_ID` — Meta-issued phone number ID.
  - `WHATSAPP_ACCESS_TOKEN` — Bearer token (System User token, in Meta parlance).
  - `WHATSAPP_ENABLED` — `'true'` to enable; otherwise everything no-ops.
  - `WHATSAPP_VERIFY_TOKEN` — for inbound webhook GET challenge.
  - `WHATSAPP_APP_SECRET` — for HMAC-SHA256 signature verification of inbound POSTs.
- API is template-only (`type: 'template'`); language hard-coded to `'en'`.
- Templates registered in code: `bill_receipt`, `lab_report_ready`, `lab_report_partial_ready`.
- No third-party BSP SDKs (Twilio, Gupshup, Wati, Karix, MessageBird) are in `package.json`.

Account approval status, pricing tier, and approved template details: UNKNOWN (Meta Business Manager). Likely owner: Marketing / Operations.

---

## 8. Branch list

From `prisma/seed.ts` (the seed defines four branches; production set may differ):

| Code | Name | Address | Phone |
| --- | --- | --- | --- |
| `CNT` | Sobhana - Chintal | Chintal, Hyderabad | 9876543200 |
| `IDPL` | IDPL (Kidcare) | IDPL, Hyderabad | 9876543201 |
| `JGG` | Jagathgiri Gutta (Kidcare) | Jagathgiri Gutta, Hyderabad | 9876543202 |
| `BLN` | Sobhana - Balanagar | Balanagar, Hyderabad | 9876543203 |

`Branch.code` is referenced in the bill numbering scheme (`D-{BRANCH_CODE}-{SEQ}` and `C-{BRANCH_CODE}-{SEQ}`).

Live production branches may differ. Likely owner: Operations / Owner role users; query `prisma.branch.findMany({ where: { isActive: true } })`.

---

## 9. Frontend dependency confirmation

**Single staff frontend** at `health-hub/`:
- Vite + React + TypeScript.
- UI: shadcn-ui (`components.json`) + Radix primitives + Tailwind CSS.
- State: Zustand stores (`authStore`, `branchStore`).
- Data fetching: `@tanstack/react-query`.
- Error tracking: `@sentry/react`.
- Date util: `date-fns`.
- Form/validation: `@hookform/resolvers` + `react-hook-form` (declared in package.json; not verified by grep here).
- Lockfile present for both `bun` (`bun.lockb`) and `npm` (`package-lock.json`).
- Build target: `vercel.json` exists → deployed on Vercel.

No second customer-facing frontend in this repo (see Question 1).

---

## 10. JWT-in-localStorage confirmation

**JWT is NOT stored in localStorage.** Per `health-hub/src/store/authStore.ts` docstring (verbatim):

```
Persistence model (changed in v1.10):
- `user` and `isAuthenticated` are persisted to localStorage so we know on
  refresh that there *was* a session (avoids a login redirect flicker).
- `token` is NOT persisted. It lives in memory only. The persistent layer
  is now an httpOnly cookie set by the backend at login. On page refresh,
  memory is wiped but the cookie survives; we call /api/auth/me to
  re-hydrate the in-memory token from the still-valid cookie.

Why the change: storing the JWT in localStorage made it readable by any
JS on the page — i.e. an XSS payload could exfiltrate it and reuse it for
7 days. With the token never touching localStorage, an XSS attack now
has at most the lifetime of the active page session.
```

Backend confirms: `authMiddleware` reads `req.cookies.jwt` first, `Authorization: Bearer` second (legacy fallback).

User profile (`user`, `isAuthenticated` flag) is persisted in localStorage via Zustand `persist`, but the bearer token is not.

---

## Summary table

| # | Question | Status |
| - | --- | --- |
| 1 | Customer-facing website | NOT FOUND in repo |
| 2 | Phlebotomist roster | NOT FOUND |
| 3 | Branch service-area mapping | NOT FOUND |
| 4 | Home-collection workflow | NOT FOUND |
| 5 | Mobile-readiness | PARTIAL (responsive Tailwind, no PWA, no per-page audit) |
| 6 | Background job runner | NONE configured |
| 7 | WhatsApp BSP | Direct Meta Cloud API |
| 8 | Branch list | 4 branches in seed (CNT, IDPL, JGG, BLN) — verify against production |
| 9 | Frontend dependencies | Single staff Vite+React+shadcn frontend |
| 10 | JWT in localStorage | NO — httpOnly cookie + in-memory token |
