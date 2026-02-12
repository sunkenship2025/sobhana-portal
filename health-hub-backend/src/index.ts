import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import path from 'path';
import { PrismaClient } from '@prisma/client';

// Load environment variables
dotenv.config();

// Routes
import authRoutes from './routes/auth';
import branchRoutes from './routes/branches';
import patientRoutes from './routes/patients';
import referralDoctorRoutes from './routes/referralDoctors';
import clinicDoctorRoutes from './routes/clinicDoctors';
import doctorSearchRoutes from './routes/doctors';
import labTestRoutes from './routes/labTests';
import diagnosticVisitRoutes from './routes/diagnosticVisits';
import clinicVisitRoutes from './routes/clinicVisits';
import payoutRoutes from './routes/payouts';
import auditLogRoutes from './routes/auditLogs';
import reportRoutes from './routes/reports';
import reportAccessRoutes from './routes/reportAccess';
import billRoutes from './routes/bills';

// PDF Service warmup
import { warmupPdfService, closeBrowser } from './services/pdfGenerationService';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

// Security middleware - relaxed for development
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "unsafe-none" },
  contentSecurityPolicy: false, // Disable CSP in development
}));

// CORS - Universal browser support (Chrome, Arc, Safari, Firefox, Edge)
const corsOptions: cors.CorsOptions = {
  origin: (_origin, callback) => {
    // Allow requests with no origin (mobile apps, Postman, curl)
    // Allow all localhost variants and any origin in development
    callback(null, true);
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

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (no branch context required)
app.use('/api/auth', authRoutes);

// Report viewing routes (token-based, no auth required) - PUBLIC ROUTE
// Short URL: /r/:token for easy sharing
app.use('/r', reportAccessRoutes);

// Report viewing routes (token-based, no auth required)
app.use('/api/reports', reportRoutes);

// Branches route (auth required)
app.use('/api/branches', branchRoutes);

// Protected routes (auth + branch context required)
app.use('/api/patients', patientRoutes);
app.use('/api/doctors', doctorSearchRoutes); // Cross-search endpoint
app.use('/api/referral-doctors', referralDoctorRoutes);
app.use('/api/clinic-doctors', clinicDoctorRoutes);
app.use('/api/lab-tests', labTestRoutes);
app.use('/api/visits/diagnostic', diagnosticVisitRoutes);
app.use('/api/visits/clinic', clinicVisitRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/audit-logs', auditLogRoutes);
app.use('/api/bills', billRoutes);

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(err.statusCode || 500).json({
    error: err.error || 'INTERNAL_ERROR',
    message: err.message || 'An unexpected error occurred'
  });
});

// Start server
app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 Auth endpoint: http://localhost:${PORT}/api/auth/login`);
  console.log(`📄 Report access: http://localhost:${PORT}/r/:token`);
  
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
