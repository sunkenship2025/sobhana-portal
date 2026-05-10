# File: src/middleware/auth.ts (+ branch.ts, rbac.ts, requestId.ts) and route mounting

## Purpose
Three middleware layers + a route-mounting structure govern access to the API:
1. `requestIdMiddleware` — request-id propagation (first in chain).
2. `authMiddleware` — JWT verification (Bearer token or httpOnly cookie).
3. `branchContextMiddleware` — resolves and attaches `req.branchId`.
4. `requireRole(...roles)` — inline RBAC helper invoked per route.

## Token Validation (`authMiddleware`)

### Token resolution order (verbatim source comment)

```
1. req.cookies.jwt — set by the login route as an httpOnly cookie. This is the
   preferred source: the token is not exposed to JavaScript on the frontend, so
   XSS cannot exfiltrate it.
2. Authorization: Bearer <token> — kept for backward compatibility with callers
   that still attach the token from in-memory authStore state.
```

```ts
let token: string | undefined = (req as any).cookies?.jwt;
if (!token) {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }
}
if (!token) {
  res.status(401).json({ error: 'UNAUTHORIZED', message: 'No token provided' });
  return;
}
const decoded = jwt.verify(token, process.env.JWT_SECRET!) as AuthUser;
req.user = decoded;
```

### JWT shape (`AuthUser`)

```ts
export interface AuthUser {
  id: string;     // The User.id (UUID) from the database
  email: string;
  role: string;   // 'staff' | 'doctor' | 'owner' (per source comment)
}
```

> Schema actually defines `UserRole` enum as `staff | doctor | owner | admin`, but the auth comment lists three. The `role` claim is whatever was put on the JWT at signing time.

### Error mapping

| Condition | Status | Body |
| --- | --- | --- |
| no token | 401 | `{ error: 'UNAUTHORIZED', message: 'No token provided' }` |
| invalid JWT (`JsonWebTokenError`) | 401 | `{ error: 'UNAUTHORIZED', message: 'Invalid token' }` |
| expired (`TokenExpiredError`) | 401 | `{ error: 'UNAUTHORIZED', message: 'Token expired' }` |
| anything else | 500 | `{ error: 'INTERNAL_ERROR', message: 'Authentication failed' }` |

## X-Branch-Id Enforcement (`branchContextMiddleware`)

### Priority order (verbatim source comment)

```
1. X-Branch-Id request header — allows staff to operate on a specific branch
   (used when the user has access to multiple branches, e.g. owner).
2. user.activeBranchId from the database — the user's default branch.
```

The middleware:
1. Requires `req.user` (else 401).
2. Loads the `User` row from DB (`select: { id, email, role, activeBranchId, isActive }`); 403 if missing or `!isActive`.
3. Reads `x-branch-id` header. If present, looks up the branch and 400s if missing or `!isActive`.
4. Else uses `user.activeBranchId`.
5. Sets `req.branchId` and `req.user.role` (live role from DB, overriding the JWT claim).

### Error mapping

| Condition | Status | Body |
| --- | --- | --- |
| no `req.user` | 401 | `UNAUTHORIZED` |
| user not found | 403 | `FORBIDDEN — User not found` |
| user disabled | 403 | `FORBIDDEN — User account is disabled` |
| invalid branch | 400 | `INVALID_BRANCH — Requested branch not found or inactive` |
| any other error | 500 | `INTERNAL_ERROR — Failed to load branch context` |

## Role Checking (`rbac.ts`)

### `requireRole(...roles)` factory

```ts
export const requireRole = (...allowedRoles: string[]) => (req, res, next) => {
  if (!req.user) return 401 UNAUTHORIZED;
  if (!allowedRoles.includes(req.user.role)) return 403 FORBIDDEN;
  next();
};
```

Usage example from source:
```ts
router.delete('/:id', requireRole('owner'), handler);
router.post('/', requireRole('staff', 'owner'), handler);
```

### `checkDoctorAccess(prisma, referralDoctorId, visitId)`

> "Used to guard doctor-facing report access: a doctor should only see reports for visits where they are listed as the referring doctor."

Returns `true` if `ReferralDoctor_Visit` row exists for the pair.

## Permission Enforcement (factual)

- **Per-route RBAC**: only enforced where `requireRole(...)` is added inline. The `diagnosticVisits.ts` router does NOT mount `requireRole`; any authenticated user with branch context may use those endpoints.
- **Doctor-visit access** is checked imperatively via `checkDoctorAccess()` where doctor-specific endpoints exist (e.g., doctor-side report views).
- **Branch isolation** is enforced by application code: any Prisma query that should be branch-scoped must include `branchId: req.branchId`. Per source comment: "All downstream services rely on `req.branchId` being set correctly. Any Prisma query that should be branch-scoped MUST include `branchId: req.branchId` in its `where` clause." There is no DB-level row-level security policy.

## Request ID Middleware

```ts
export function requestIdMiddleware(req, res, next): void {
  const incoming = req.header('x-request-id');
  const id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
```

- Validates incoming `X-Request-Id` against `^[\w.-]{1,64}$` (alphanumerics, underscore, hyphen, dot, max 64 chars). Rejects/replaces malformed IDs.
- Mounted as the very first middleware in `index.ts` so it precedes `pino-http` (`genReqId: (req) => req.requestId`).
- Echoed back in `X-Request-Id` response header. Frontend surfaces it in error toasts (per source comment).

## Route Mounting Structure (from `src/index.ts`)

### Middleware order (request lifecycle)

```ts
app.set('trust proxy', true);                 // Render reverse proxy
app.use(requestIdMiddleware);                 // 1. request id
app.use(pinoHttp({ ... }));                   // 2. structured logging
app.use(helmet({ ... }));                     // 3. security headers (+ CSP in prod)
app.use(cors(corsOptions));                   // 4. CORS allowlist (FRONTEND_URL env)
app.options('*', cors(corsOptions));
app.use(no-store cache headers for /api, /reports, /webhooks);
app.use(express.json());                      // 5. body parsing
app.use(cookieParser());                      // 6. cookies (for httpOnly JWT)
app.use('/css'|'/images'|'/fonts', static);   // 7. static assets for report HTML
```

### Public routes (NO authMiddleware)

| Path | Notes |
| --- | --- |
| `GET /` | Returns `{ status: 'ok' }` for Render port-detection |
| `GET /health`, `GET /healthz` | Probes Postgres (critical), Redis/R2/Puppeteer (degraded if down). 503 only when Postgres is down. |
| `POST /api/auth/login` | Public login (auth-emit) |
| `GET /reports/:token` | Token-based public access. **Token IS the access control.** |
| `POST /webhooks/whatsapp` | Public Meta webhook; verified via `hub.verify_token`. |

### Auth-required (no branch context)

| Path | Middleware |
| --- | --- |
| `/api/auth/*` | None (login is the entry point) |
| `/api/system/status` | `authMiddleware` only |
| `/api/branches` | `authMiddleware` only (per `routes/branches.ts`) |
| `/api/reports` | `authMiddleware` (per `routes/reports.ts`) |

### Auth + branch context

Per source comment: "Protected routes (auth + branch context required)" — each route module mounts its own `authMiddleware` and `branchContextMiddleware` at the top of its `Router()`:

| Mount path | Module |
| --- | --- |
| `/api/patients` | patients.ts |
| `/api/doctors` | doctors.ts |
| `/api/referral-doctors` | referralDoctors.ts |
| `/api/clinic-doctors` | clinicDoctors.ts |
| `/api/visits/diagnostic` | diagnosticVisits.ts |
| `/api/visits/clinic` | clinicVisits.ts |
| `/api/payouts` | payouts.ts |
| `/api/audit-logs` | auditLogs.ts |
| `/api/bills` | bills.ts |
| `/api/messages` | messages.ts |
| `/api/departments` | departments.ts |
| `/api/diagnostic-centers` | diagnosticCenters.ts |
| `/api/signing-doctors` | signingDoctors.ts |
| `/api/signing-rules` | signingRules.ts |
| `/api/owner` | ownerDashboard.ts |
| `/api/clinical-definitions` | clinicalDefinitions.ts |
| `/api/clinical-panels` | clinicalPanels.ts |
| `/api/billable-products` | billableProducts.ts |
| `/api/external-uploads` | externalUploads.ts |
| `/api/test-input-configs` | testInputConfigs.ts |

### Legacy (commented-out)

```ts
// LEGACY — superseded by /api/billable-products
// import labTestRoutes from './routes/labTests';
// app.use('/api/lab-tests', labTestRoutes);

// LEGACY — superseded by /api/clinical-panels
// import panelRoutes from './routes/panels';
// app.use('/api/panels', panelRoutes);
```

These imports and mounts remain commented out in `index.ts`.

## CORS Configuration (factual)

- `origin`: exact-match against `FRONTEND_URL` (comma-separated env var). Same-origin / non-browser callers (no `Origin` header) are allowed.
- Dev fallback: when `!isProduction && allowedOrigins.length === 0`, all origins allowed.
- `credentials: true` — required for cookie-based auth.
- `allowedHeaders`: includes `Authorization`, `X-Branch-Id`, `If-Match`, etc.
- `exposedHeaders`: `Content-Length`, `X-Request-Id`, `Date`.
- `maxAge: 0` — preflights never cached.
- Production startup throws if `FRONTEND_URL` is empty:
  > "FRONTEND_URL must be set in production — refusing to start with an empty CORS allowlist."
- Production startup throws if `JWT_SECRET` is empty.

## Auth Assumptions (verbatim from source)

- "Roles available in this system: 'staff' (lab technicians, front desk), 'doctor' (reviewing/signing doctors), 'owner' (admin; can do everything staff and doctor can do)."
- "Token resolution order... cookie XSS-safe, Authorization Bearer kept for backward compatibility."
- "Any Prisma query that should be branch-scoped MUST include branchId: req.branchId in its where clause."

## Raw Source: middleware/auth.ts

```ts
/**
 * JWT Authentication Middleware
 *
 * Verifies the `Authorization: Bearer <token>` header on every
 * protected request. On success, attaches decoded token data to
 * `req.user` so downstream route handlers and services can identify
 * the caller without re-querying the database.
 *
 * This middleware is mounted globally in `index.ts` but skipped on:
 *   - POST /api/auth/login  (public)
 *   - GET  /reports/:token  (public, token-based)
 *   - POST /webhooks/whatsapp  (Meta signature verification instead)
 */
import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { logger as rootLogger } from '../lib/logger';

/**
 * The decoded payload of a Sobhana Health Hub JWT.
 * This shape is defined when signing in `authService.login()`.
 */
export interface AuthUser {
  /** The User.id (UUID) from the database */
  id: string;
  email: string;
  /** One of: 'staff' | 'doctor' | 'owner' */
  role: string;
}

/**
 * Extends Express's Request type to carry auth and branch context
 * injected by the auth and branch middleware.
 */
export interface AuthRequest extends Request {
  /** Set by `authMiddleware` after JWT verification */
  user?: AuthUser;
  /** Set by `branchContextMiddleware` from X-Branch-Id header or user.activeBranchId */
  branchId?: string;
}

export const authMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    // Prefer the httpOnly cookie (XSS-safe) over the Authorization header.
    let token: string | undefined = (req as any).cookies?.jwt;

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
      }
    }

    if (!token) {
      res.status(401).json({
        error: 'UNAUTHORIZED',
        message: 'No token provided'
      });
      return;
    }

    // Verify JWT
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as AuthUser;

    // Attach user to request
    req.user = decoded;
    next();
  } catch (err: any) {
    const log = (req as any).log || rootLogger;
    if (err.name === 'JsonWebTokenError') {
      log.warn({ ip: req.ip }, 'auth rejected: invalid JWT');
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid token' });
    } else if (err.name === 'TokenExpiredError') {
      log.info({ ip: req.ip }, 'auth rejected: expired JWT');
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Token expired' });
    } else {
      log.error({ err, ip: req.ip }, 'auth middleware crashed');
      res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Authentication failed' });
    }
  }
};
```

## Raw Source: middleware/branch.ts

```ts
import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import prisma from '../lib/prisma';

export const branchContextMiddleware = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'User not authenticated' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        role: true,
        activeBranchId: true,
        isActive: true
      }
    });

    if (!user) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'User not found' });
      return;
    }

    if (!user.isActive) {
      res.status(403).json({ error: 'FORBIDDEN', message: 'User account is disabled' });
      return;
    }

    const requestedBranchId = req.headers['x-branch-id'] as string;
    if (requestedBranchId) {
      const branch = await prisma.branch.findUnique({
        where: { id: requestedBranchId },
        select: { id: true, isActive: true }
      });

      if (!branch || !branch.isActive) {
        res.status(400).json({ error: 'INVALID_BRANCH', message: 'Requested branch not found or inactive' });
        return;
      }

      req.branchId = requestedBranchId;
    } else {
      req.branchId = user.activeBranchId;
    }

    req.user.role = user.role;

    next();
  } catch (err: any) {
    console.error('Branch context middleware error:', err);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to load branch context' });
  }
};
```

## Raw Source: middleware/rbac.ts

```ts
import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';

export const requireRole = (...allowedRoles: string[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: 'UNAUTHORIZED', message: 'Authentication required' });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        error: 'FORBIDDEN',
        message: `This action requires one of the following roles: ${allowedRoles.join(', ')}`
      });
      return;
    }

    next();
  };
};

export const checkDoctorAccess = async (
  prisma: any,
  referralDoctorId: string,
  visitId: string
): Promise<boolean> => {
  const referral = await prisma.referralDoctor_Visit.findFirst({
    where: { visitId, referralDoctorId }
  });

  return !!referral;
};
```

## Raw Source: middleware/requestId.ts

```ts
import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';

const HEADER = 'x-request-id';

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(HEADER);
  const id = incoming && /^[\w.-]{1,64}$/.test(incoming) ? incoming : randomUUID();
  req.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
```

## Notes

- JWT secret comes from `JWT_SECRET` env var; production startup throws if missing.
- Cookie name is `jwt`, set as httpOnly by `routes/auth.ts` login flow.
- The `role` claim is read from the DB on each request (overwriting JWT claim) by `branchContextMiddleware` — so a role change in DB takes effect on the next request.
- `branchContextMiddleware` performs **two DB queries per request** (user + optional branch verify) on every protected route. No caching in middleware.
- There is no rate limiting at the auth layer in this file — see `src/middleware/rateLimit.ts` for Redis-backed rate limits applied selectively.
