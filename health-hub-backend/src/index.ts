import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Load environment variables
dotenv.config();

// Routes
import authRoutes from './routes/auth';
import patientRoutes from './routes/patients';
import referralDoctorRoutes from './routes/referralDoctors';
import clinicDoctorRoutes from './routes/clinicDoctors';
import doctorSearchRoutes from './routes/doctors';
import labTestRoutes from './routes/labTests';
import diagnosticVisitRoutes from './routes/diagnosticVisits';
import clinicVisitRoutes from './routes/clinicVisits';
import payoutRoutes from './routes/payouts';

const app = express();
const prisma = new PrismaClient();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Health check (no auth required)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Auth routes (no branch context required)
app.use('/api/auth', authRoutes);

// Protected routes (auth + branch context required)
app.use('/api/patients', patientRoutes);
app.use('/api/doctors', doctorSearchRoutes); // Cross-search endpoint
app.use('/api/referral-doctors', referralDoctorRoutes);
app.use('/api/clinic-doctors', clinicDoctorRoutes);
app.use('/api/lab-tests', labTestRoutes);
app.use('/api/visits/diagnostic', diagnosticVisitRoutes);
app.use('/api/visits/clinic', clinicVisitRoutes);
app.use('/api/payouts', payoutRoutes);

// Global error handler
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(err.statusCode || 500).json({
    error: err.error || 'INTERNAL_ERROR',
    message: err.message || 'An unexpected error occurred'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔐 Auth endpoint: http://localhost:${PORT}/api/auth/login`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\\n🛑 Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\\n🛑 Shutting down gracefully...');
  await prisma.$disconnect();
  process.exit(0);
});
