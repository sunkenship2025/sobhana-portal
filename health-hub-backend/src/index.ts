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
import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config();

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
import webhookRoutes from './routes/webhooks';
import messageRoutes from './routes/messages';
import departmentRoutes from './routes/departments';
import diagnosticCenterRoutes from './routes/diagnosticCenters';
import signingDoctorRoutes from './routes/signingDoctors';
import signingRuleRoutes from './routes/signingRules';
// LEGACY — superseded by /api/clinical-panels pipeline
// import panelRoutes from './routes/panels';
import clinicalDefinitionRoutes from './routes/clinicalDefinitions';
import clinicalPanelRoutes from './routes/clinicalPanels';
import billableProductRoutes from './routes/billableProducts';

// PDF Service warmup
import { warmupPdfService, closeBrowser } from './services/pdfGenerationService';
import prisma from './lib/prisma';

const app = express();
const PORT = process.env.PORT || 10000;

// Trust reverse proxy (Render) — ensures req.protocol returns 'https'
app.set('trust proxy', true);

// Security middleware - relaxed for development
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "unsafe-none" },
  contentSecurityPolicy: false, // Disable CSP in development
}));

// CORS - Production-safe origin whitelist
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map(s => s.trim())
  : [];

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl, server-to-server)
    if (!origin) return callback(null, true);
    // In development (no FRONTEND_URL set), allow all origins
    if (allowedOrigins.length === 0) return callback(null, true);
    // In production, check whitelist
    if (allowedOrigins.some(allowed => origin === allowed || origin.endsWith('.vercel.app'))) {
      return callback(null, true);
    }
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

// Disable ALL caching for API responses (fixes Arc, Safari, aggressive caching)
app.use((_req, res, next) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Surrogate-Control': 'no-store',
    'Vary': 'Origin, Accept-Encoding',
  });
  next();
});

app.use(express.json());

// Static files for reports (CSS, images, fonts)
app.use('/css', express.static(path.join(__dirname, '../public/css')));
app.use('/images', express.static(path.join(__dirname, '../public/images')));
app.use('/fonts', express.static(path.join(__dirname, '../public/fonts')));

// Root route — returns 200 so Render's default port-detection and health checks succeed
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'sobhana-health-hub', timestamp: new Date().toISOString() });
});

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (no branch context required)
app.use('/api/auth', authRoutes);

// Report PDF download (token-based, no auth required) - PUBLIC ROUTE
// Direct PDF download: /reports/:token
app.use('/reports', reportDownloadRoutes);

// WhatsApp webhook (public, no auth) - Meta delivery receipts
app.use('/webhooks/whatsapp', webhookRoutes);

// Legacy report API (JWT-based, for clinic/Patient360)
app.use('/api/reports', reportRoutes);

// Branches route (auth required)
app.use('/api/branches', branchRoutes);

// Protected routes (auth + branch context required)
app.use('/api/patients', patientRoutes);
app.use('/api/doctors', doctorSearchRoutes); // Cross-search endpoint
app.use('/api/referral-doctors', referralDoctorRoutes);
app.use('/api/clinic-doctors', clinicDoctorRoutes);
// LEGACY — superseded by /api/billable-products
// app.use('/api/lab-tests', labTestRoutes);
app.use('/api/visits/diagnostic', diagnosticVisitRoutes);
app.use('/api/visits/clinic', clinicVisitRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/bills', billRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/diagnostic-centers', diagnosticCenterRoutes);
app.use('/api/signing-doctors', signingDoctorRoutes);
app.use('/api/signing-rules', signingRuleRoutes);
// LEGACY — superseded by /api/clinical-panels
// app.use('/api/panels', panelRoutes);

// New architecture: Clinical Definitions, Panels, Products
app.use('/api/clinical-definitions', clinicalDefinitionRoutes);
app.use('/api/clinical-panels', clinicalPanelRoutes);
app.use('/api/billable-products', billableProductRoutes);

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(err.statusCode || 500).json({
    error: err.error || 'INTERNAL_ERROR',
    message: err.message || 'An unexpected error occurred'
  });
});

// Start server — bind to 0.0.0.0 explicitly so Render can detect the open port
app.listen(Number(PORT), '0.0.0.0', async () => {
  console.log(`Server running on http://0.0.0.0:${PORT}`);
  console.log(`Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`Auth endpoint: http://0.0.0.0:${PORT}/api/auth/login`);
  console.log(`Report download: http://0.0.0.0:${PORT}/reports/:token`);
  console.log(`WhatsApp webhook: http://0.0.0.0:${PORT}/webhooks/whatsapp`);
  
  // Warmup PDF service for faster first generation
  await warmupPdfService();
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await closeBrowser();
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await closeBrowser();
  await prisma.$disconnect();
  process.exit(0);
});
