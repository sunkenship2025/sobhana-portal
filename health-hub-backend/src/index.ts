/**
 * Sobhana Health Hub — Express API Server Entry Point
 *
 * This file is the root of the backend application. It:
 *   1. Configures global middleware (CORS, Helmet, JSON parsing, auth, branch context)
 *   2. Mounts all 24 route modules under /api/*
 *   3. Registers the public /reports/:token and /webhooks/whatsapp routes (no auth)
 *   4. Warms up the singleton Puppeteer browser on startup
 *   5. Handles graceful shutdown (SIGINT/SIGTERM) to close Puppeteer and Prisma cleanly
 *
 * Route mounting convention:
 *   - /api/auth              — no auth middleware (login is the entry point)
 *   - /api/*                 — auth + branch context middleware applied
 *   - /reports/:token        — public; token IS the access control
 *   - /webhooks/whatsapp     — public; verified by Meta's hub.verify_token
 *
 * Environment variables consumed here:
 *   PORT                — HTTP port (default: 10000, matches Render + Dockerfile EXPOSE)
 *   FRONTEND_URL        — comma-separated CORS origin whitelist
 *   JWT_SECRET          — required for authMiddleware to verify tokens
 *   PUPPETEER_*         — consumed by pdfGenerationService (see that file)
 */
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

// Initialize Sentry as early as possible so it can capture errors during
// route module loading. DSN-gated — does nothing if SENTRY_DSN isn't set.
import { initSentry, Sentry, isSentryEnabled } from './lib/sentry';
initSentry();

// Routes
import authRoutes from './routes/auth';
import branchRoutes from './routes/branches';
import patientRoutes from './routes/patients';
import referralDoctorRoutes from './routes/referralDoctors';
import clinicDoctorRoutes from './routes/clinicDoctors';
import doctorSearchRoutes from './routes/doctors';
// LEGACY — superseded by /api/billable-products pipeline
// import labTestRoutes from './routes/labTests';
import diagnosticVisitRoutes from './routes/diagnosticVisits';
import clinicVisitRoutes from './routes/clinicVisits';
import payoutRoutes from './routes/payouts';
import auditLogRoutes from './routes/auditLogs';
import reportRoutes from './routes/reports';
import reportDownloadRoutes from './routes/reportDownload';
import billRoutes from './routes/bills';
import billDownloadRoutes from './routes/billDownload';
import statementDownloadRoutes from './routes/statementDownload';
import reportGatewayRoutes from './routes/reportGateway';
import displayRoutes from './routes/display';
import displayAdminRoutes from './routes/displayAdmin';
import displayAdRoutes from './routes/displayAds';
import couponGatewayRoutes from './routes/couponGateway';
import couponRoutes from './routes/coupons';
import webhookRoutes from './routes/webhooks';
import messageRoutes from './routes/messages';
import inboxRoutes from './routes/inbox';
import departmentRoutes from './routes/departments';
import diagnosticCenterRoutes from './routes/diagnosticCenters';
import externalLabRoutes from './routes/externalLabs';
import signingDoctorRoutes from './routes/signingDoctors';
import signingRuleRoutes from './routes/signingRules';
import signingLabInchargeRoutes from './routes/signingLabIncharges';
import labInchargeRuleRoutes from './routes/labInchargeRules';
import ownerDashboardRoutes from './routes/ownerDashboard';
import userRoutes from './routes/users';
import appSettingsRoutes from './routes/appSettings';
// LEGACY — superseded by /api/clinical-panels pipeline
// import panelRoutes from './routes/panels';
import clinicalDefinitionRoutes from './routes/clinicalDefinitions';
import clinicalPanelRoutes from './routes/clinicalPanels';
import billableProductRoutes from './routes/billableProducts';
import externalUploadRoutes from './routes/externalUploads';
import testInputConfigRoutes from './routes/testInputConfigs';

// PDF Service warmup
import { warmupPdfService, closeBrowser } from './services/pdfGenerationService';
import prisma from './lib/prisma';
import { ensureRedisReady, closeRedisClient, isRedisRequired } from './lib/redis';
import { runHealthChecks } from './lib/healthChecks';
import { authMiddleware } from './middleware/auth';
import { logger } from './lib/logger';
import { requestIdMiddleware } from './middleware/requestId';
import pinoHttp from 'pino-http';

const app = express();
const PORT = process.env.PORT || 10000;
const SERVER_STARTED_AT = new Date().toISOString();

// Trust reverse proxy. `true` trusted the WHOLE X-Forwarded-For chain, so a
// client could spoof its IP (leftmost XFF) and bypass every per-IP rate limit.
// Trust exactly the real proxy-hop count instead (Render's edge = 1), so req.ip
// is the un-spoofable IP the trusted proxy observed. X-Forwarded-Proto is still
// read from the trusted hop, so req.protocol stays 'https'. Env-overridable in
// case the hop count changes (e.g. Cloudflare added in front) without a deploy.
const trustProxyHops = Number(process.env.TRUST_PROXY_HOPS);
app.set('trust proxy', Number.isFinite(trustProxyHops) && trustProxyHops > 0 ? trustProxyHops : 1);

// Request ID first — must run before pino-http so the auto-attached request
// logger is tagged with the same id we expose in the response header.
app.use(requestIdMiddleware);

// Auto-log every request: method, path, status, duration, requestId.
// Skip /health and /healthz to avoid drowning the log stream in Render's
// frequent health probes.
app.use(
  pinoHttp({
    logger,
    genReqId: (req) => (req as any).requestId,
    autoLogging: {
      ignore: (req) => req.url === '/health' || req.url === '/healthz',
    },
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req) => ({
        id: req.id,
        method: req.method,
        url: req.url,
        userId: (req.raw as any)?.user?.id,
        branchId: (req.raw as any)?.branchId,
      }),
    },
  }),
);

// Security middleware. CSP stays on in production; turn it off in dev so the
// report HTML preview tooling and Vite's HMR don't fight it.
const isProduction = process.env.NODE_ENV === 'production';
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "unsafe-none" },
  contentSecurityPolicy: isProduction
    ? {
        useDefaults: true,
        directives: {
          // Reports embed CSS and the logo as data: URIs, then make XHR back to /api/*.
          // 'unsafe-inline' on style-src is required for shadcn + tailwind-merge
          // (they emit inline <style> blocks at runtime).
          "default-src": ["'self'"],
          "img-src": ["'self'", "data:", "blob:"],
          "script-src": ["'self'"],
          "style-src": ["'self'", "'unsafe-inline'"],
          "connect-src": ["'self'"],
          "frame-ancestors": ["'none'"],
          "object-src": ["'none'"],
        },
      }
    : false,
}));

// CORS — exact-match allowlist. The previous `*.vercel.app` substring let any
// attacker-deployed Vercel preview issue credentialed requests with the user's
// auth cookie attached.
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(s => s.trim()).filter(Boolean)
  : [];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Same-origin / non-browser callers (Postman, server-to-server, Puppeteer)
    // omit Origin entirely; allow them. Browsers always send Origin for cross-
    // origin credentialed requests, so the cookie auth path is still gated below.
    if (!origin) return callback(null, true);
    // In dev (no FRONTEND_URL set on a non-prod box) allow any origin so
    // localhost ports can iterate. Prod is guarded by a startup check.
    if (!isProduction && allowedOrigins.length === 0) return callback(null, true);
    if (allowedOrigins.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
  allowedHeaders: [
    'Content-Type',
    'Authorization', 
    'X-Branch-Id',
    'X-Requested-With',
    'Accept',
    'Origin',
    'Cache-Control',
    'Pragma',
    'If-Match',
  ],
  exposedHeaders: ['Content-Length', 'X-Request-Id', 'Date'],
  maxAge: 0, // Don't cache preflight requests
  preflightContinue: false,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));

// Handle preflight for all routes explicitly
app.options('*', cors(corsOptions));

// Disable caching for API + token-gated routes only. Static `/css`, `/images`,
// `/fonts` mounted below are immutable assets used in report HTML — letting
// browsers + the Puppeteer pool cache them is a real perf win.
app.use((req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/reports') || req.path.startsWith('/webhooks') || req.path.startsWith('/r/')) {
    res.set({
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
      'Pragma': 'no-cache',
      'Expires': '0',
      'Surrogate-Control': 'no-store',
      'Vary': 'Origin, Accept-Encoding',
    });
  }
  next();
});

// WhatsApp webhook — MUST be mounted BEFORE express.json so the route's own
// express.raw captures the exact request bytes for HMAC signature verification.
// Otherwise express.json consumes the body first -> empty buffer -> 401 on every webhook.
app.use('/webhooks/whatsapp', webhookRoutes);

app.use(express.json());

// Parse Set-Cookie / Cookie headers — required for httpOnly JWT auth.
// Mounted after express.json() and CORS; cookies arrive as req.cookies.
app.use(cookieParser());

// Static files for reports (CSS, images, fonts)
app.use('/css', express.static(path.join(__dirname, '../public/css')));
app.use('/images', express.static(path.join(__dirname, '../public/images')));
app.use('/fonts', express.static(path.join(__dirname, '../public/fonts')));

// Root route — returns 200 so Render's default port-detection and health checks succeed
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'sobhana-health-hub', timestamp: new Date().toISOString() });
});

// Liveness check (no auth required) — process-only by design.
// Render and uptime monitors can hit this frequently without waking Neon.
function handleHealth(_req: express.Request, res: express.Response) {
  res.setHeader('Cache-Control', 'no-store');
  // Surface process memory so OOM pressure is observable/alertable without
  // opening the Render dashboard. Node-process RSS only (Chromium children are
  // separate processes) — still a useful trend line for the heap side.
  const mem = process.memoryUsage();
  const toMB = (n: number) => Math.round(n / 1024 / 1024);
  res.json({
    status: 'ok',
    service: 'sobhana-health-hub',
    timestamp: new Date().toISOString(),
    uptimeSeconds: Math.floor(process.uptime()),
    memory: {
      rssMB: toMB(mem.rss),
      heapUsedMB: toMB(mem.heapUsed),
      heapTotalMB: toMB(mem.heapTotal),
      externalMB: toMB(mem.external),
    },
  });
}
app.get('/health', handleHealth);
app.get('/healthz', handleHealth);

// Readiness/dependency check (no auth required) — probes Postgres/Redis/R2/Puppeteer.
// Use this for manual deploy verification, not high-frequency uptime polling.
// Returns 503 only when Postgres is down (the one critical dep). Non-critical
// deps mark the overall status as 'degraded' but still return 200, so a transient
// R2 / Redis blip doesn't trigger Render restart loops.
async function handleReady(_req: express.Request, res: express.Response) {
  try {
    const report = await runHealthChecks();
    res.setHeader('Cache-Control', 'no-store');
    res.status(report.status === 'unhealthy' ? 503 : 200).json(report);
  } catch (err: any) {
    res.status(500).json({ status: 'unhealthy', error: err?.message || 'health-check failed' });
  }
}
app.get('/ready', handleReady);
app.get('/readyz', handleReady);

// Auth routes (no branch context required)
app.use('/api/auth', authRoutes);

// System status — auth-required, more detail than the public /health probe.
// Includes build version + Node memory so ops can correlate "this bug appeared
// at 14:23" with "deployed at 14:21" and spot memory leaks.
app.get('/api/system/status', authMiddleware, async (_req, res) => {
  try {
    const report = await runHealthChecks({ skipCache: true });
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...report,
      build: {
        version: process.env.GIT_SHA || process.env.RENDER_GIT_COMMIT || 'unknown',
        nodeEnv: process.env.NODE_ENV || 'development',
        startedAt: SERVER_STARTED_AT,
      },
      runtime: {
        uptimeSeconds: Math.floor(process.uptime()),
        memory: process.memoryUsage(),
      },
    });
  } catch (err: any) {
    res.status(500).json({ status: 'unhealthy', error: err?.message || 'status check failed' });
  }
});

// Report PDF download (token-based, no auth required) - PUBLIC ROUTE
// Direct PDF download: /reports/:token
app.use('/reports', reportDownloadRoutes);

// Bill PDF download (token-based, no auth required) - PUBLIC ROUTE
// Patient-facing bill PDF for WhatsApp links: /bills/view/:token
app.use('/bills/view', billDownloadRoutes);
// Report gateway (token-based, no auth) — QR on the bill lands here and resolves
// to the finalized report / partial interstitial / "being processed" page: /r/:token
app.use('/r', reportGatewayRoutes);
// Coupon gateway (token-based, no auth) — the WhatsApp coupon link lands here: /c/:token
app.use('/c', couponGatewayRoutes);
// Payee-facing payout statement (JSON) for WhatsApp links: /statements/view/:token
app.use('/statements/view', statementDownloadRoutes);

// Legacy report API (JWT-based, for clinic/Patient360)
app.use('/api/reports', reportRoutes);

// Branches route (auth required)
app.use('/api/branches', branchRoutes);

// Protected routes (auth + branch context required)
app.use('/api/patients', patientRoutes);
app.use('/api/doctors', doctorSearchRoutes); // Cross-search endpoint
app.use('/api/referral-doctors', referralDoctorRoutes);
app.use('/api/clinic-doctors', clinicDoctorRoutes);
app.use('/api/users', userRoutes); // Owner-only team/role management
app.use('/api/app-settings', appSettingsRoutes); // Org-wide settings (report cloud-sync default)
// LEGACY — superseded by /api/billable-products
// app.use('/api/lab-tests', labTestRoutes);
app.use('/api/visits/diagnostic', diagnosticVisitRoutes);
app.use('/api/visits/clinic', clinicVisitRoutes);
app.use('/api/display', displayRoutes); // PUBLIC — kiosk queue state, no user auth
app.use('/api/display-screens', displayAdminRoutes); // owner: pair/manage TVs
app.use('/api/display-ads', displayAdRoutes); // owner: ad creatives (photo/video/slideshow)
app.use('/api/payouts', payoutRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/bills', billRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/inbox', inboxRoutes); // Patient Messages inbox (WhatsApp two-way)
app.use('/api/coupons', couponRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/diagnostic-centers', diagnosticCenterRoutes);
app.use('/api/external-labs', externalLabRoutes);
app.use('/api/signing-doctors', signingDoctorRoutes);
app.use('/api/signing-rules', signingRuleRoutes);
app.use('/api/signing-lab-incharges', signingLabInchargeRoutes);
app.use('/api/lab-incharge-rules', labInchargeRuleRoutes);
app.use('/api/owner', ownerDashboardRoutes);
// LEGACY — superseded by /api/clinical-panels
// app.use('/api/panels', panelRoutes);

// New architecture: Clinical Definitions, Panels, Products
app.use('/api/clinical-definitions', clinicalDefinitionRoutes);
app.use('/api/clinical-panels', clinicalPanelRoutes);
app.use('/api/billable-products', billableProductRoutes);
app.use('/api/external-uploads', externalUploadRoutes);
app.use('/api/test-input-configs', testInputConfigRoutes);

// Sentry's Express error handler must be registered AFTER all routes but
// BEFORE the global error handler. It only captures unhandled errors (5xx);
// 4xx client errors are filtered out by default. Inert if Sentry is disabled.
if (isSentryEnabled()) {
  Sentry.setupExpressErrorHandler(app);
}

// Global error handler — structured log + requestId in response so the user
// can copy a single ID from the toast and we can find every related log line.
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Tag the Sentry event with the request ID so a triage from Sentry → logs is one query.
  if (isSentryEnabled() && req.requestId) {
    Sentry.getCurrentScope().setTag('request_id', req.requestId);
    if ((req as any).user?.id) {
      Sentry.getCurrentScope().setUser({ id: (req as any).user.id });
    }
  }
  (req.log || logger).error(
    {
      err,
      statusCode: err.statusCode || 500,
      route: req.path,
      method: req.method,
    },
    'Unhandled error in request',
  );
  res.status(err.statusCode || 500).json({
    error: err.error || 'INTERNAL_ERROR',
    message: err.message || 'An unexpected error occurred',
    requestId: req.requestId,
  });
});

async function shutdown(): Promise<void> {
  console.log('\n🛑 Shutting down gracefully...');
  await closeBrowser();
  await closeRedisClient();
  await prisma.$disconnect();
}

async function startServer(): Promise<void> {
  if (isProduction && allowedOrigins.length === 0) {
    throw new Error(
      'FRONTEND_URL must be set in production — refusing to start with an empty CORS allowlist.',
    );
  }
  if (isProduction && !process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET must be set in production.');
  }

  if (isRedisRequired()) {
    await ensureRedisReady();
    console.log('Redis connection verified for production startup.');
  }

  app.listen(Number(PORT), '0.0.0.0', async () => {
    console.log(`Server running on http://0.0.0.0:${PORT}`);
    console.log(`Health check: http://0.0.0.0:${PORT}/health`);
    console.log(`Readiness check: http://0.0.0.0:${PORT}/ready`);
    console.log(`Auth endpoint: http://0.0.0.0:${PORT}/api/auth/login`);
    console.log(`Report download: http://0.0.0.0:${PORT}/reports/:token`);
    console.log(`WhatsApp webhook: http://0.0.0.0:${PORT}/webhooks/whatsapp`);

    // Warmup PDF service for faster first generation
    await warmupPdfService();
  });
}

startServer().catch(async (error) => {
  console.error('Failed to start server:', error);
  await shutdown();
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  await shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await shutdown();
  process.exit(0);
});
