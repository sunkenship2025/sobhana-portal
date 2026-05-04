# Sobhana Health Hub

Full-stack web app for **Sobhana Diagnostic Centre** and its associated polyclinic branches. Patient registration → diagnostic visits → lab result entry → versioned PDF reports → WhatsApp delivery → billing → doctor payouts.

> **Status:** in active development. Single-tenant production deployment serving Sobhana branches. **No automated test suite yet** — see [`documentation/TESTING.md`](documentation/TESTING.md) for the strategy.

---

## Repo layout

```
sobhana-portal/
├── health-hub/                    Frontend — React 18 + TypeScript + Vite (port 8080)
├── health-hub-backend/            Backend  — Express + TypeScript + Prisma (port 10000)
├── documentation/                 Architecture, decisions, runbooks, API catalog
│   ├── ARCHITECTURE.md            System design + data flows
│   ├── CONTRIBUTING.md            How to make a change
│   ├── DECISIONS.md               Architecture Decision Records (ADRs)
│   ├── CHANGELOG.md               Notable changes per release
│   ├── API.md                     Endpoint catalog
│   ├── ONBOARDING.md              New-developer first day
│   ├── TESTING.md                 Test strategy + current gaps
│   ├── RELEASE.md                 Release / deploy procedure
│   └── runbooks/                  Operational procedures (rotate secret, restore backup, …)
├── .github/                       PR / issue templates, CODEOWNERS
├── SECURITY.md                    Vulnerability disclosure policy
└── README.md                      You are here
```

For deeper material on a topic, follow the link.

---

## Tech stack

**Frontend** ([`health-hub/`](health-hub/))
- React 18 + TypeScript, Vite build
- TailwindCSS + shadcn/ui (Radix primitives)
- Zustand (auth/branch state, localStorage-persisted)
- React Router 6
- `react-pdf` (cross-browser PDF preview), `cmdk` (combobox), `sonner` (toasts), `lucide-react` (icons)

**Backend** ([`health-hub-backend/`](health-hub-backend/))
- Node.js 20 + Express + TypeScript
- Prisma ORM → PostgreSQL (Neon, serverless)
- Pino structured logging, Sentry error tracking
- Redis (ioredis) — rate limiting, login lockout, optional cache
- Puppeteer + pdf-lib for report PDFs
- Cloudflare R2 for external upload storage
- WhatsApp Cloud API for patient notifications
- JWT auth (HS256, bearer in Authorization header)

**Infra**
- Backend: **Render** (Docker), system Chromium for Puppeteer
- Frontend: **Vercel** (or wherever the SPA is hosted — verify per environment)
- DB: **Neon** PostgreSQL
- Object storage: **Cloudflare R2**

---

## Quick start (local dev)

**Prerequisites:** Node.js 20+, npm, access to a Postgres DB (Neon dev branch or local Postgres). Redis is optional locally.

```bash
git clone <repo-url>
cd "sobhana portal"
```

### 1. Backend

```bash
cd health-hub-backend
npm install

# Set up environment — see "Environment variables" below for the full list.
# At minimum you need DATABASE_URL, DIRECT_DATABASE_URL, JWT_SECRET.
cp .env.example .env   # if .env.example exists; otherwise create .env from the list below

# Apply schema to your DB
npx prisma migrate deploy
npx prisma generate

# Seed (optional — creates demo branches/users/tests)
npm run db:seed
npm run seed:catalog

# Run the API
npm run dev            # → http://localhost:10000
```

### 2. Frontend

```bash
cd health-hub
npm install
npm run dev            # → http://localhost:8080
```

Default seed credentials (only in dev DB): see [`documentation/ONBOARDING.md`](documentation/ONBOARDING.md).

### 3. Verify

```bash
curl http://localhost:10000/health
# → {"status":"ok",...}
```

Open `http://localhost:8080`, log in, you're in.

For a complete first-day walkthrough see [`documentation/ONBOARDING.md`](documentation/ONBOARDING.md).

---

## Environment variables

Backend (`health-hub-backend/.env`). Never commit this file — see [`SECURITY.md`](SECURITY.md).

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | Pooled Postgres connection (Neon pooler URL). Used by app at runtime. |
| `DIRECT_DATABASE_URL` | yes | Direct (non-pooled) Postgres URL. Used by Prisma migrations. |
| `JWT_SECRET` | yes | HMAC key for signing JWTs. Min 32 chars; rotation forces all users to log in again. |
| `PORT` | no (default `10000`) | HTTP port. |
| `NODE_ENV` | no | `development` / `production`. |
| `FRONTEND_URL` | prod only | Comma-separated allowed CORS origins. Empty/unset → allow all (dev only). |
| `REDIS_URL` | optional in dev, required in prod | Redis connection for rate-limit / lockout / cache. |
| `SENTRY_DSN` | optional | Backend Sentry. |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_PUBLIC_BASE_URL` | for external uploads | Cloudflare R2 storage of PDF uploads. |
| `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` | for messaging | Meta Cloud API credentials. |
| `PUBLIC_REPORT_BASE_URL` | yes | Base URL for patient-facing report links sent via WhatsApp. |
| `BUSINESS_TIME_ZONE` | no (default `Asia/Kolkata`) | All time formatting on reports/bills. |
| `PUPPETEER_EXECUTABLE_PATH` | yes in Docker | Path to Chromium (`/usr/bin/chromium` in the Docker image). |
| `PUPPETEER_SKIP_CHROMIUM_DOWNLOAD` | yes in Docker | `true` so npm install doesn't re-download Chromium. |

Frontend (`health-hub/.env.local`) — only one variable typically:

| Variable | Purpose |
|---|---|
| `VITE_API_BASE_URL` | Backend URL. Default falls back to `http://localhost:3000`; set to `http://localhost:10000` for local dev or your production URL. |

A complete `.env.example` should live in [`health-hub-backend/.env.example`](health-hub-backend/.env.example) — populate it with **only key names**, never real values.

---

## Common dev tasks

```bash
# Backend
npm run dev              # nodemon + ts-node, hot reload
npm run type-check       # tsc --noEmit, no output
npm run build            # tsc → dist/
npm run lint             # eslint src
npm run db:migrate       # prisma migrate dev (interactive — use only on dev DB)
npm run db:migrate:prod  # prisma migrate deploy (non-interactive — use this for any non-dev DB)
npm run db:studio        # Prisma Studio at http://localhost:5555

# Frontend
npm run dev              # Vite dev server with HMR
npm run build            # Production bundle in dist/
npm run lint             # ESLint
```

Both packages run their typecheck via `tsc`. Neither has a test runner installed yet ([`documentation/TESTING.md`](documentation/TESTING.md)).

---

## Production deployment

| Service | Platform | Trigger | Notes |
|---|---|---|---|
| Backend API | Render (Docker) | push to `main` | `Dockerfile` builds, runs `npx prisma migrate deploy` then `node dist/index.js` |
| Frontend SPA | Vercel | push to `main` | `vercel.json` SPA rewrite required so React Router handles deep links |
| Database | Neon | manual via Prisma migrations | Schema changes ship via `migrate deploy` step in container start |
| R2 | Cloudflare | n/a | Bucket + lifecycle policy provisioned manually |

For the release procedure (cutting a version, applying migrations, rolling back), see [`documentation/RELEASE.md`](documentation/RELEASE.md). For incident response, see [`documentation/runbooks/incident-response.md`](documentation/runbooks/incident-response.md).

---

## How to find your way around

| You want to … | Read … |
|---|---|
| Understand the system end-to-end | [`documentation/ARCHITECTURE.md`](documentation/ARCHITECTURE.md) |
| Make your first change | [`documentation/CONTRIBUTING.md`](documentation/CONTRIBUTING.md) |
| Know why something is the way it is | [`documentation/DECISIONS.md`](documentation/DECISIONS.md) |
| See every API endpoint | [`documentation/API.md`](documentation/API.md) |
| Get a new dev productive | [`documentation/ONBOARDING.md`](documentation/ONBOARDING.md) |
| Rotate a secret, restore a backup, debug a slow request | [`documentation/runbooks/`](documentation/runbooks/) |
| Report a security issue | [`SECURITY.md`](SECURITY.md) |
| Ship a release | [`documentation/RELEASE.md`](documentation/RELEASE.md) |

---

## License

Proprietary. All rights reserved by Sobhana Diagnostic Centre.

## Maintainers

- Lead: Pranav Reddy

For issues: open one in this repo using the templates in [`.github/ISSUE_TEMPLATE/`](.github/ISSUE_TEMPLATE/).
