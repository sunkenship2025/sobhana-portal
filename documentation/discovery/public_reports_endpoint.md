# File: src/routes/reportDownload.ts (+ services/reportAccessService.ts)

## Purpose
Public, token-based access to finalized diagnostic reports. Mounted at `/reports` in `index.ts` (no auth middleware applied — the token IS the access control). This is the URL embedded in WhatsApp report-ready messages.

## Mount Point

From `src/index.ts`:
```ts
// Report PDF download (token-based, no auth required) - PUBLIC ROUTE
// Direct PDF download: /reports/:token
app.use('/reports', reportDownloadRoutes);
```

## Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/reports/:token` | Inline PDF (digital mode) for in-app browsers |
| GET | `/reports/:token/pdf` | PDF download; supports `?mode=physical` for letterhead |
| GET | `/reports/:token/view` | HTML view; supports `?print=true` for print-on-load |

## Token Generation (`reportAccessService.createAccessToken`)

```ts
function generateToken(): string {
  const bytes = crypto.randomBytes(32);              // 32 bytes of entropy
  return bytes.toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 12);                                // 12 alphanumeric chars
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}
```

- Raw token: 12 alphanumeric characters derived from 32 bytes of `crypto.randomBytes`.
- Stored as **SHA-256 hash** in `ReportAccessToken.token` (the column has `@unique`).
- Database row contains the hash; the raw token is only returned once at generation time.
- Up to 10 retries on `P2002` (unique-constraint collision) before throwing `'Failed to generate unique token'`.
- Pre-condition: `ReportVersion.status === 'FINALIZED'` (else throws "Cannot create access token for non-finalized report").

## Expiry Handling (factual)

```prisma
model ReportAccessToken {
  expiresAt DateTime?  // NULL = never expires
  ...
}
```

```ts
if (accessToken.expiresAt && accessToken.expiresAt < new Date()) {
  return null; // validateToken returns null → caller treats as REPORT_NOT_FOUND
}
```

- `expiresAt` is **optional**. Per source comment: "null = never expires (legacy default)".
- `createAccessToken(reportVersionId, expiresAt?)` accepts an optional expiry but is called from notification flows **without** an expiry value, so issued tokens never expire by default.

## Authorization Logic

There is **no user authentication** on these endpoints. The flow is:
1. Token from URL → `validateToken(token)` → looks up the SHA-256 hash.
2. If absent or expired → return `null` (caller responds 404).
3. If present → return `reportVersionId`.
4. Caller fetches the persisted snapshot via `reportSnapshotService.getReportSnapshot(reportVersionId)`.
5. If snapshot missing → return 403 `REPORT_NOT_AVAILABLE` ("This report has not been finalized yet").

### Legacy plaintext token compatibility (factual)

`findTokenRecord` first tries the SHA-256 hash. If absent, it falls back to looking up by raw token. If the legacy plaintext row exists, it is **migrated in place** to the hashed form:

```ts
await prisma.reportAccessToken.update({
  where: { id: legacyRecord.id },
  data: { token: tokenHash },
});
```

This silently upgrades old plaintext-stored tokens on first access.

## Rate Limiting (factual)

Two rate limiters wrap each public endpoint (Redis-backed via `createRateLimiter`):

| Limiter | Namespace | Window | Max | Key |
| --- | --- | --- | --- | --- |
| `publicReportLandingIpRateLimit` | `public-report-ip` | 60 s | 30 | `[clientIp]` |
| `publicReportLandingTokenRateLimit` | `public-report-token` | 60 s | 10 | `[clientIp, token]` |

The other endpoints (`/pdf`, `/view`) reuse middleware named `publicReportIpRateLimit` and `publicReportTokenRateLimit` from `middleware/rateLimit.ts`.

On limit hit: `Retry-After` header set, response is `429` with no body, `Cache-Control: no-store`.

## Report Retrieval Flow

```
GET /reports/:token
  ↓
publicReportLandingIpRateLimit + publicReportLandingTokenRateLimit
  ↓
loadReportForToken(token)
  → validateToken(token) → reportVersionId or null
  → getReportSnapshot(reportVersionId) → snapshot or null
  ↓
QRCode.toDataURL(reportUrl, { width: 100, margin: 1, ... })
  ↓
generateMergedReportPdf(snapshot, { mode: 'digital', baseUrl, qrDataUrl, cache: true })
  ↓
recordAccess(token, 'VIEW', req.ip, req.headers['user-agent'])
  ↓
res.setHeader('Content-Type', 'application/pdf');
res.setHeader('Content-Disposition', `inline; filename="Report-${billNumber}.pdf"`);
res.setHeader('Cache-Control', 'no-store');
res.send(pdfBuffer);
```

For `/pdf` mode is read from `?mode=physical` (else `digital`); `Content-Disposition` is `attachment`.

For `/view` the rendered HTML is served (Puppeteer is **not** invoked); when `?print=true`, a small inline script is injected to call `window.print()` 600 ms after page load.

## Download Security Model (factual)

- **No JWT, no session, no signature.** The token is the bearer credential.
- Bearer tokens are 12-char alphanumeric (~71.5 bits effective entropy after charset filter; 62^12 ≈ 3.2×10^21 combinations).
- Tokens stored as SHA-256 hash; raw token never persisted to DB.
- Rate limited per-IP (30 req/min) and per (IP, token) (10 req/min).
- All responses set `Cache-Control: no-store` so intermediate caches can't replay the PDF.
- `recordAccess()` writes `ReportAccessLog` with `accessType ∈ {VIEW, DOWNLOAD, PRINT}` and `accessedVia: 'TOKEN'` (or `'STAFF_PORTAL'` if a `userId` is provided), plus `ipAddress`, `userAgent`. `accessCount`/`lastAccessedAt`/`lastAccessedIp` increment on `ReportAccessToken`.

### Known limitations (factual)

- Token has no expiry by default — once issued, it remains valid for the life of the `ReportVersion`.
- No revocation API in this code path. Token can only become invalid by setting `expiresAt` directly in the DB or deleting the row.
- The legacy plaintext-token migration silently rewrites the DB row, mixing pre-hash and post-hash entries.

## Companion: Staff-side `recordAccessByReportVersionId`

Used by staff-portal code paths (e.g., `diagnosticVisits.ts` `GET /:id/finalized-report`) to log access without a token. Always tags the log with `accessedVia: 'STAFF_PORTAL'`.

## Dead Legacy Module: `tokenService.ts`

Per source: **"DEAD LEGACY MODULE — This JWT-based report token flow is retired and should not be used for any new work. The old `/api/reports/*` endpoints now return 410, public patient links go through `/reports/:token`, and staff access goes through the authenticated diagnostic visit report endpoints."**

The module exports `generateReportToken()` and `verifyReportToken()` using JWT with 1-hour expiry; both are flagged dead.

## Raw Source: routes/reportDownload.ts

```ts
/**
 * Report Download Route
 *
 * Public report access is split into:
 * - GET /reports/:token       → Direct PDF download for patient / WhatsApp browsers
 * - GET /reports/:token/pdf   → Explicit PDF download alias
 * - GET /reports/:token/view  → Rendered HTML view for staff preview / print
 */

import { Router, Request, Response } from 'express';
import QRCode from 'qrcode';
import {
  createRateLimiter,
  getClientIp,
  publicReportIpRateLimit,
  publicReportTokenRateLimit,
} from '../middleware/rateLimit';
import { validateToken, recordAccess } from '../services/reportAccessService';
import { getReportSnapshot } from '../services/reportSnapshotService';
import { renderReportHtml } from '../services/reportRendererService';
import { generateMergedReportPdf } from '../services/mergedReportPdfService';

const router = Router();

const publicReportLandingIpRateLimit = createRateLimiter({
  namespace: 'public-report-ip',
  windowMs: 60_000,
  maxRequests: 30,
  keyGenerator: (req) => [getClientIp(req)],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

const publicReportLandingTokenRateLimit = createRateLimiter({
  namespace: 'public-report-token',
  windowMs: 60_000,
  maxRequests: 10,
  keyGenerator: (req) => [getClientIp(req), String(req.params.token || '')],
  onLimit: (_req, res, retryAfterSeconds) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).end();
  },
});

type ReportLoadSuccess = { ok: true; snapshot: any };
type ReportLoadFailure = { ok: false; status: number; error: string; message: string };
type ReportLoadResult = ReportLoadSuccess | ReportLoadFailure;

async function loadReportForToken(token: string): Promise<ReportLoadResult> {
  const reportVersionId = await validateToken(token);

  if (!reportVersionId) {
    return {
      ok: false,
      status: 404,
      error: 'REPORT_NOT_FOUND',
      message: 'This report link is invalid or has expired.',
    };
  }

  const snapshot = await getReportSnapshot(reportVersionId);

  if (!snapshot) {
    return {
      ok: false,
      status: 403,
      error: 'REPORT_NOT_AVAILABLE',
      message: 'This report has not been finalized yet.',
    };
  }

  return { ok: true, snapshot };
}

async function buildPdfBuffer(
  req: Request,
  token: string,
  mode: 'physical' | 'digital',
): Promise<ReportLoadFailure | { ok: true; snapshot: any; pdfBuffer: Buffer }> {
  const loaded = await loadReportForToken(token);

  if (!loaded.ok) {
    return loaded;
  }

  const baseUrl = `${req.protocol}://${req.get('host')}`;
  const reportUrl = `${baseUrl}/reports/${token}`;
  const qrDataUrl = await QRCode.toDataURL(reportUrl, {
    width: 100,
    margin: 1,
    color: { dark: '#000000', light: '#ffffff' },
  });

  const pdfBuffer = await generateMergedReportPdf(loaded.snapshot, {
    mode,
    baseUrl,
    qrDataUrl,
    // Public token-gated path serves only finalized snapshots, so caching is
    // safe here. Staff/preview callers leave this off to avoid serving stale
    // bytes for a draft.
    cache: true,
  });

  return {
    ok: true,
    snapshot: loaded.snapshot,
    pdfBuffer,
  };
}

router.get('/:token', publicReportLandingIpRateLimit, publicReportLandingTokenRateLimit, async (req, res) => {
  const { token } = req.params;
  try {
    const result = await buildPdfBuffer(req, token, 'digital');
    if (!result.ok) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(result.status).end();
    }
    await recordAccess(token, 'VIEW', req.ip, req.headers['user-agent']);
    const billNumber = result.snapshot.visit?.billNumber || 'unknown';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="Report-${billNumber}.pdf"`);
    res.setHeader('Content-Length', result.pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(result.pdfBuffer);
  } catch (error) {
    console.error('Error generating report PDF:', error);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).end();
  }
});

router.get('/:token/pdf', publicReportIpRateLimit, publicReportTokenRateLimit, async (req, res) => {
  const { token } = req.params;
  const mode = req.query.mode === 'physical' ? 'physical' : 'digital';
  try {
    const result = await buildPdfBuffer(req, token, mode);
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, message: result.message });
    }
    await recordAccess(token, mode === 'physical' ? 'PRINT' : 'DOWNLOAD', req.ip, req.headers['user-agent']);
    const billNumber = result.snapshot.visit?.billNumber || 'unknown';
    const filename = mode === 'physical' ? `Report-${billNumber}-print.pdf` : `Report-${billNumber}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', result.pdfBuffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(result.pdfBuffer);
  } catch (error) {
    console.error('Error generating report PDF:', error);
    return res.status(500).json({ error: 'GENERATION_FAILED', message: 'Failed to generate report PDF. Please try again.' });
  }
});

router.get('/:token/view', publicReportIpRateLimit, publicReportTokenRateLimit, async (req, res) => {
  const { token } = req.params;
  try {
    const loaded = await loadReportForToken(token);
    if (!loaded.ok) {
      return res.status(loaded.status).json({ error: loaded.error, message: loaded.message });
    }
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const reportUrl = `${baseUrl}/reports/${token}`;
    const qrDataUrl = await QRCode.toDataURL(reportUrl, { width: 100, margin: 1, color: { dark: '#000000', light: '#ffffff' } });
    const autoPrint = req.query.print === 'true';
    const html = renderReportHtml(loaded.snapshot, {
      profile: autoPrint ? 'pdf-physical' : 'screen',
      baseUrl,
      qrDataUrl,
    });
    const finalHtml = autoPrint
      ? html.replace('</body>', '<script>window.onload=function(){setTimeout(function(){window.print()},600)}</script></body>')
      : html;
    await recordAccess(token, autoPrint ? 'PRINT' : 'VIEW', req.ip, req.headers['user-agent']);
    res.setHeader('Content-Type', 'text/html');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(finalHtml);
  } catch (error) {
    console.error('Error generating report HTML view:', error);
    return res.status(500).json({ error: 'GENERATION_FAILED', message: 'Failed to generate report view.' });
  }
});

export default router;
```

## Raw Source: services/reportAccessService.ts

```ts
import crypto from 'crypto';
import prisma from '../lib/prisma';

function generateToken(): string {
  const bytes = crypto.randomBytes(32);
  return bytes
    .toString('base64url')
    .replace(/[^a-zA-Z0-9]/g, '')
    .substring(0, 12);
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

type TokenLookup = {
  id: string;
  reportVersionId: string;
  expiresAt: Date | null;
};

async function findTokenRecord(rawToken: string): Promise<TokenLookup | null> {
  const tokenHash = hashToken(rawToken);

  const hashedRecord = await prisma.reportAccessToken.findUnique({
    where: { token: tokenHash },
    select: { id: true, reportVersionId: true, expiresAt: true },
  });

  if (hashedRecord) {
    return hashedRecord;
  }

  const legacyRecord = await prisma.reportAccessToken.findUnique({
    where: { token: rawToken },
    select: { id: true, reportVersionId: true, expiresAt: true },
  });

  if (!legacyRecord) {
    return null;
  }

  try {
    await prisma.reportAccessToken.update({
      where: { id: legacyRecord.id },
      data: { token: tokenHash },
    });
  } catch (error) {
    console.error('[ReportAccess] Failed to migrate legacy plaintext token:', error);
  }

  return legacyRecord;
}

async function appendAccessLog(
  reportVersionId: string,
  accessType: 'VIEW' | 'DOWNLOAD' | 'PRINT',
  accessedVia: 'TOKEN' | 'STAFF_PORTAL',
  ipAddress?: string,
  userAgent?: string,
  userId?: string
): Promise<void> {
  await prisma.reportAccessLog.create({
    data: { reportVersionId, accessType, accessedVia, ipAddress, userAgent, userId },
  });
}

export async function createAccessToken(
  reportVersionId: string,
  expiresAt?: Date
): Promise<string> {
  const reportVersion = await prisma.reportVersion.findUnique({
    where: { id: reportVersionId },
    select: { status: true },
  });

  if (!reportVersion) {
    throw new Error(`ReportVersion ${reportVersionId} not found`);
  }

  if (reportVersion.status !== 'FINALIZED') {
    throw new Error('Cannot create access token for non-finalized report');
  }

  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const token = generateToken();
    const tokenHash = hashToken(token);
    try {
      await prisma.reportAccessToken.create({
        data: {
          token: tokenHash,
          reportVersionId,
          expiresAt: expiresAt || null,
        },
      });
      return token;
    } catch (err: any) {
      if (err?.code === 'P2002') continue;
      throw err;
    }
  }

  throw new Error('Failed to generate unique token');
}

export async function validateToken(token: string): Promise<string | null> {
  const accessToken = await findTokenRecord(token);
  if (!accessToken) return null;
  if (accessToken.expiresAt && accessToken.expiresAt < new Date()) return null;
  return accessToken.reportVersionId;
}

export async function recordAccess(
  token: string,
  accessType: 'VIEW' | 'DOWNLOAD' | 'PRINT',
  ipAddress?: string,
  userAgent?: string,
  userId?: string
): Promise<void> {
  const accessToken = await findTokenRecord(token);
  if (!accessToken) return;

  await prisma.reportAccessToken.update({
    where: { id: accessToken.id },
    data: {
      accessCount: { increment: 1 },
      lastAccessedAt: new Date(),
      lastAccessedIp: ipAddress,
    },
  });

  await appendAccessLog(
    accessToken.reportVersionId,
    accessType,
    userId ? 'STAFF_PORTAL' : 'TOKEN',
    ipAddress,
    userAgent,
    userId
  );
}

export async function recordAccessByReportVersionId(
  reportVersionId: string,
  accessType: 'VIEW' | 'DOWNLOAD' | 'PRINT',
  ipAddress?: string,
  userAgent?: string,
  userId?: string
): Promise<void> {
  await appendAccessLog(reportVersionId, accessType, 'STAFF_PORTAL', ipAddress, userAgent, userId);
}

export async function getAccessStats(reportVersionId: string): Promise<{
  totalViews: number;
  lastAccessed: Date | null;
  accessHistory: { type: string; via: string; at: Date; ip: string | null; }[];
}> {
  const totalViews = await prisma.reportAccessLog.count({ where: { reportVersionId } });

  const logs = await prisma.reportAccessLog.findMany({
    where: { reportVersionId },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { accessType: true, accessedVia: true, createdAt: true, ipAddress: true },
  });

  return {
    totalViews,
    lastAccessed: logs[0]?.createdAt || null,
    accessHistory: logs.map(l => ({
      type: l.accessType,
      via: l.accessedVia,
      at: l.createdAt,
      ip: l.ipAddress,
    })),
  };
}
```

## Notes

- `routes/reports.ts` (legacy, JWT-based) is mounted at `/api/reports` but per source comment for the `tokenService.ts` legacy module: "the old `/api/reports/*` endpoints now return 410." (Verifying that statement requires reading `routes/reports.ts`, which is 15 LOC.)
- The PDF rendering path uses `generateMergedReportPdf` (from `mergedReportPdfService`) which composes the rendered HTML through Puppeteer plus any `EXTERNAL_UPLOAD` PDFs from R2.
