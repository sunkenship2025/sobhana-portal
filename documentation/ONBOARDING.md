# New developer onboarding

Goal: from `git clone` to running app + first PR merged in under one working day.

If anything in this doc is wrong or missing, that's a bug — fix it as part of your first PR.

---

## Day 0 — accounts and access

You need:

- [ ] **GitHub** access to this repo — push + PR create
- [ ] **Render** dashboard access (read at minimum) — to view logs, env vars, restart deploys
- [ ] **Vercel** dashboard access — to view frontend deploys, env vars
- [ ] **Neon** dashboard access — to manage Postgres (preferably read-only branch + your own dev branch)
- [ ] **Cloudflare** — R2 bucket access if you'll touch external uploads
- [ ] **Sentry** — to triage backend errors
- [ ] **WhatsApp Business / Meta** — only if you'll touch notifications

Ask the maintainer to invite you to each. Don't share credentials over chat.

---

## Day 1 — get it running

### 1. Tooling

```bash
# macOS / Linux assumed. Windows via WSL.
node --version              # should be 20.x or higher
npm --version               # 10.x or higher
git --version
```

If `node` isn't installed: use [nvm](https://github.com/nvm-sh/nvm) and `nvm install 20`.

### 2. Clone

```bash
git clone <repo-url>
cd "sobhana portal"
ls
# health-hub  health-hub-backend  documentation  README.md  …
```

### 3. Backend env

Copy `.env.example` to `.env` if one exists, otherwise create `health-hub-backend/.env` from the env-var table in [`README.md`](../README.md). For local dev you need at minimum:

```env
DATABASE_URL="postgresql://..."          # your Neon dev branch URL (pooled)
DIRECT_DATABASE_URL="postgresql://..."   # your Neon dev branch URL (direct)
JWT_SECRET="anything-32-or-more-chars-for-local-dev"
PORT=10000
NODE_ENV=development
```

Optional in dev (skip them and the app falls back to in-memory or no-op):

```env
REDIS_URL=                # rate-limit / lockout uses in-memory fallback
SENTRY_DSN=               # leave empty to skip Sentry init
PUBLIC_REPORT_BASE_URL=http://localhost:10000/reports
BUSINESS_TIME_ZONE=Asia/Kolkata
```

R2 + WhatsApp env vars are only required if you're working on those features. Without them the relevant endpoints will return errors but the rest of the app runs fine.

**Get a Neon dev branch.** Don't run migrations against production. Either use Neon's branching feature to create a dev branch, or run a local Postgres in Docker:

```bash
docker run --name sobhana-pg -e POSTGRES_PASSWORD=devpass -p 5432:5432 -d postgres:16
```

Then `DATABASE_URL=postgresql://postgres:devpass@localhost:5432/postgres` and same for `DIRECT_DATABASE_URL`.

### 4. Backend install + migrate + seed

```bash
cd health-hub-backend
npm install
npx prisma migrate deploy        # applies all migrations
npx prisma generate              # generates Prisma client
npm run db:seed                  # creates demo branch + owner + staff users
npm run seed:catalog             # populates test catalog (panels, products, tests)
```

If `seed:catalog` fails or you want to skip, the app still runs — you just won't have any tests/products to order.

### 5. Backend run

```bash
npm run dev
# → http://localhost:10000
# Watch the console — should see: Pino logs, Puppeteer warmup, "Server listening on 10000"
```

Verify:

```bash
curl http://localhost:10000/health
# {"status":"ok","checks":{"postgres":"ok","redis":"degraded",...}}
```

A `degraded` Redis is fine in dev. A `503` means Postgres is unhealthy — check your `DATABASE_URL`.

### 6. Frontend env + run

```bash
cd ../health-hub
npm install
echo "VITE_API_BASE_URL=http://localhost:10000" > .env.local
npm run dev
# → http://localhost:8080
```

Open `http://localhost:8080`. You should see a login page.

### 7. Log in

Default seeded credentials are in [`prisma/seed.ts`](../health-hub-backend/prisma/seed.ts) (search for `passwordHash`). The standard pattern is:

```
email:    owner@sobhana.dev
password: <set in seed.ts — search there>
```

If the seed-set password is unclear, run `npm run db:seed` again and watch the console — it logs the credentials it created. Or open Prisma Studio and reset:

```bash
npx prisma studio  # http://localhost:5555 — find your User row
```

You can hash a new password with bcrypt and paste the hash into the User row directly.

### 8. Click around

In order:

1. Switch active branch (top-left dropdown)
2. **Patients** → search by phone → register a new one
3. **Diagnostics → New Visit** → select a product → save
4. **Diagnostics → Pending Results** → enter values for the test you ordered
5. Save → finalize → preview the PDF
6. Open the staff finalized-report URL — confirm the PDF renders

If any step blows up: check the browser console + the backend's Pino log. The `X-Request-Id` in the response headers connects them.

---

## Day 2 — orient yourself in the code

Read these in order:

1. [`README.md`](../README.md) — the 5-minute overview
2. [`documentation/ARCHITECTURE.md`](ARCHITECTURE.md) §1–§4 — system design, backend, frontend
3. [`documentation/CONTRIBUTING.md`](CONTRIBUTING.md) — conventions, common pitfalls
4. [`documentation/DECISIONS.md`](DECISIONS.md) — ADRs. Skim all of them. The "why" is here.
5. [`prisma/schema.prisma`](../health-hub-backend/prisma/schema.prisma) — read the comment block at top, then skim model names

Then read one full request lifecycle end-to-end:

- Frontend: [`pages/diagnostics/DiagnosticsResultEntry.tsx`](../health-hub/src/pages/diagnostics/DiagnosticsResultEntry.tsx) — see how the page fetches and saves
- Backend route: [`routes/diagnosticVisits.ts`](../health-hub-backend/src/routes/diagnosticVisits.ts) — find the GET `/:id` handler
- Backend services it calls: `referenceRangeService`, `derivedParameterService`, `productOrderService`

You'll get the feel.

---

## Day 3 — your first PR

Find an "introductory" issue (label: `good first issue` if we have any; otherwise ask the maintainer). The shape we'd like for first PRs:

- Touches one file or a small set
- No schema change
- Has a clear, manual verification path
- Touches at least one of: a service, a route, a frontend component (so you exercise the stack)

Follow [`CONTRIBUTING.md`](CONTRIBUTING.md) §4 (the end-to-end walkthrough). Use the [PR template](../.github/pull_request_template.md).

Post your PR for review. Iterate.

---

## Mental model — what to internalize

- **`Visit` is the anchor.** Every piece of medical/financial data hangs off a Visit. Patient is global; everything else is branch-scoped.
- **Snapshots are sacred.** Once a `ReportVersion.status = FINALIZED`, the snapshot JSON never changes. Editing a patient's name later does not change a finalized report.
- **Test definitions clone on edit.** Editing creates a new version; old versions are locked. Historical results always reference the version that was active when entered.
- **Branch isolation is application-only.** Every Prisma query you write must filter by `branchId`. If you forget, you leak data between branches.
- **Money is integer paise.** Never float.
- **Notifications are fire-and-forget.** WhatsApp / payout / audit log writes never block the response. Failures land in `MessageLog` / `AuditLog` / Sentry.

---

## Where to find help

- Architecture / design questions → [`ARCHITECTURE.md`](ARCHITECTURE.md), then ask the maintainer
- "Why is it like this?" → [`DECISIONS.md`](DECISIONS.md)
- "How do I X?" — operationally → [`runbooks/`](runbooks/)
- "What does this endpoint do?" → [`API.md`](API.md), then read the route file
- Stuck on a Prisma issue → check the schema comment block; then [the Prisma docs](https://www.prisma.io/docs)
- Stuck on a Puppeteer / PDF rendering issue → [`DECISIONS.md`](DECISIONS.md) ADR-007, then [`runbooks/regenerate-failed-report.md`](runbooks/regenerate-failed-report.md)

---

## Common day-1 issues

### Backend won't start: "DATABASE_URL not set"
You're missing `health-hub-backend/.env`, or the file isn't being loaded. Check it's at `health-hub-backend/.env` (not in the workspace root or in `src/`).

### Prisma migrate fails on Neon shadow DB
Known issue. Use `npx prisma migrate deploy` with hand-written migration SQL — see [`runbooks/database-migrations.md`](runbooks/database-migrations.md).

### Frontend says "Failed to fetch" on login
- Backend not running? `curl http://localhost:10000/health`
- `VITE_API_BASE_URL` mismatched? Check `health-hub/.env.local`
- CORS — but in dev, `FRONTEND_URL` empty → backend allows all origins, so this shouldn't happen

### Login works but everything else 401s
You probably aren't sending `Authorization: Bearer <token>` (frontend should auto-include it via `authStore`) or the token has expired. Log out and log back in.

### "X-Branch-Id required" on every request
You logged in but never selected a branch. Use the top-left switcher.

### Reports preview shows pink stripes
You're looking at an old build. The fix is in [DECISIONS ADR-014](DECISIONS.md). Pull latest, rebuild.

### `npm test` does nothing
We don't have a test suite yet. See [`TESTING.md`](TESTING.md).
