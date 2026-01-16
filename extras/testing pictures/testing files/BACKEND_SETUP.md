# Sobhana Health Hub — Backend Setup Guide

**Status**: ✅ **PHASE-1 ARCHITECTURE FROZEN — GREEN LIGHT FOR IMPLEMENTATION**

---

## 🚀 EXECUTION INSTRUCTIONS (ENGINEERING)

**Implementation Order** (Follow this sequence exactly):

### 1️⃣ Prisma Schema
- Apply migrations: `npx prisma migrate dev --name init`
- Lock constraints (compound indexes, unique constraints)
- Generate client: `npx prisma generate`
- Verify all enums compile correctly

### 2️⃣ Auth + Branch Context Middleware
- JWT validation (verify token signature)
- Active branch injection (from user.activeBranchId)
- Role extraction (UserRole enum)

### 3️⃣ Core Visit Flows
- Diagnostics visit creation (POST /visits/diagnostic)
- Clinic visit creation (POST /visits/clinic)
- Bill generation (auto-generate billNumber)

### 4️⃣ Report Lifecycle
- Result entry (POST /results)
- Finalization (POST /finalize-report)
- Immutability enforcement (check ReportStatus before update)

### 5️⃣ RBAC & Referral Gates
- Doctor access checks (verify ReferralDoctor_Visit exists)
- Owner overrides (explicit only, documented endpoints)

### 6️⃣ Payout Derivation
- Per-test calculation (loop test orders, apply commission %)
- Immutable ledger (DoctorPayoutLedger insert only)

### 7️⃣ SMS Delivery (Async)
- Gupshup integration (POST /delivery/send-sms-report)
- Retry + audit (cron job for failed SMS)

---

## Quick Start

### Prerequisites
- Node.js 18+ (LTS recommended)
- PostgreSQL 14+
- npm or yarn

### 1. Initialize Node Project

```bash
cd health-hub-backend
npm init -y
npm install express prisma @prisma/client dotenv cors helmet jsonwebtoken bcryptjs axios
npm install -D typescript @types/express @types/node ts-node nodemon
```

### 2. Set Up TypeScript

Create `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "moduleResolution": "node"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

### 3. Set Up Prisma

```bash
npx prisma init
```

Update `.env`:
```
DATABASE_URL="postgresql://user:password@localhost:5432/sobhana_db"
JWT_SECRET="your-super-secret-key-change-in-production"
WHATSAPP_API_KEY="optional-for-phase-1"
NODE_ENV="development"
```

### 4. Generate Database

```bash
# Create migration from existing schema.prisma
npx prisma migrate dev --name init

# Generate Prisma client
npx prisma generate
```

### 5. Directory Structure

```
health-hub-backend/
├── src/
│   ├── middleware/
│   │   ├── auth.ts           # JWT verification
│   │   ├── branch.ts         # Branch context extraction
│   │   └── rbac.ts           # Role-based access control
│   ├── routes/
│   │   ├── auth.ts
│   │   ├── patients.ts
│   │   ├── referralDoctors.ts
│   │   ├── clinicDoctors.ts
│   │   ├── labTests.ts
│   │   ├── diagnosticVisits.ts
│   │   ├── clinicVisits.ts
│   │   ├── payout.ts
│   │   └── print.ts
│   ├── controllers/
│   │   ├── authController.ts
│   │   ├── patientController.ts
│   │   ├── visitController.ts
│   │   └── payoutController.ts
│   ├── services/
│   │   ├── authService.ts
│   │   ├── visitService.ts
│   │   ├── payoutService.ts    # Payout calculation logic
│   │   └── printService.ts     # PDF/HTML generation
│   ├── types/
│   │   └── index.ts            # TypeScript interfaces
│   ├── utils/
│   │   ├── errors.ts           # Custom error classes
│   │   └── logger.ts           # Structured logging
│   ├── seed.ts                 # Database seeding
│   └── index.ts                # Main entry point
├── prisma/
│   ├── schema.prisma           # ✅ Already created
│   └── seed.ts
├── .env
├── package.json
├── tsconfig.json
└── API_CONTRACT.md             # ✅ Already created
```

### 6. Create Main Entry Point

Create `src/index.ts`:
```typescript
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';

// Routes
import authRoutes from './routes/auth';
import patientRoutes from './routes/patients';
import referralDoctorRoutes from './routes/referralDoctors';
import clinicDoctorRoutes from './routes/clinicDoctors';
import labTestRoutes from './routes/labTests';
import diagnosticVisitRoutes from './routes/diagnosticVisits';
import clinicVisitRoutes from './routes/clinicVisits';
import payoutRoutes from './routes/payout';
import printRoutes from './routes/print';

// Middleware
import { authMiddleware } from './middleware/auth';
import { branchContextMiddleware } from './middleware/branch';

dotenv.config();

const app = express();
const prisma = new PrismaClient();

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes (no auth required)
app.use('/api/auth', authRoutes);

// Routes (auth required, branch context injected)
app.use(authMiddleware);
app.use(branchContextMiddleware);

app.use('/api/patients', patientRoutes);
app.use('/api/referral-doctors', referralDoctorRoutes);
app.use('/api/clinic-doctors', clinicDoctorRoutes);
app.use('/api/lab-tests', labTestRoutes);
app.use('/api/visits/diagnostic', diagnosticVisitRoutes);
app.use('/api/visits/clinic', clinicVisitRoutes);
app.use('/api/payout', payoutRoutes);
app.use('/api/print', printRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
```

### 7. Add NPM Scripts

Update `package.json`:
```json
{
  "scripts": {
    "dev": "nodemon --exec ts-node src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "db:push": "prisma db push",
    "db:migrate": "prisma migrate dev",
    "db:seed": "ts-node prisma/seed.ts",
    "db:studio": "prisma studio"
  }
}
```

### 8. Run Development Server

```bash
npm run dev
```

Expected output:
```
🚀 Server running on http://localhost:3000
```

---

## Key Implementation Notes

### Authentication Middleware

```typescript
// src/middleware/auth.ts
export const authMiddleware = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  
  if (!token) {
    return res.status(401).json({ error: 'UNAUTHORIZED', message: 'No token provided' });
  }
  
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!);
    req.user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: 'UNAUTHORIZED', message: 'Invalid token' });
  }
};
```

### Branch Context Middleware

```typescript
// src/middleware/branch.ts
export const branchContextMiddleware = async (req, res, next) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id }
  });
  
  if (!user) {
    return res.status(403).json({ error: 'FORBIDDEN', message: 'User not found' });
  }
  
  req.branchId = user.activeBranchId;
  req.user.role = user.role;
  next();
};
```

### RBAC Middleware Example

```typescript
// src/middleware/rbac.ts
export const requireRole = (...roles: string[]) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: `This action requires one of: ${roles.join(', ')}`
      });
    }
    next();
  };
};
```

### Immutability Enforcement (CRITICAL)

**RULE**: Once `ReportVersion.status = FINALIZED`, that report version MUST NOT be updated.

```typescript
// src/services/reportService.ts
export async function updateReportVersion(reportVersionId: string, updates: any) {
  // 1. Check status BEFORE allowing update
  const reportVersion = await prisma.reportVersion.findUnique({
    where: { id: reportVersionId }
  });
  
  if (reportVersion.status === 'FINALIZED') {
    throw new Error('IMMUTABLE_REPORT: Cannot modify finalized report');
  }
  
  // 2. Only proceed if status is DRAFT
  return prisma.reportVersion.update({
    where: { id: reportVersionId },
    data: updates
  });
}
```

**RULE**: AuditLog is insert-only. NEVER update or delete.

```typescript
// src/services/auditService.ts
export async function logAction(data: AuditLogInput) {
  // ✅ ONLY .create() allowed
  return prisma.auditLog.create({ data });
  
  // ❌ NEVER use .update() or .delete()
}
```

### Doctor Access Control (CRITICAL: Explicit Referral Gate)

**RULE**: Doctor can ONLY access visits where explicit referral link exists.

```typescript
// src/middleware/doctorAccess.ts
export async function checkDoctorAccess(
  referralDoctorId: string,
  visitId: string
): Promise<boolean> {
  // Doctor access = EXISTS in ReferralDoctor_Visit table
  const referral = await prisma.referralDoctor_Visit.findFirst({
    where: {
      visitId,
      referralDoctorId
    }
  });
  
  return !!referral; // true if referral exists, false otherwise
}

// Usage in route:
router.get('/visits/:visitId', async (req, res) => {
  const { visitId } = req.params;
  const doctorId = req.user.id; // From JWT
  
  // If user is doctor, enforce access check
  if (req.user.role === 'doctor') {
    const hasAccess = await checkDoctorAccess(doctorId, visitId);
    if (!hasAccess) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'Doctor does not have referral access to this visit'
      });
    }
  }
  
  // Proceed with fetching visit...
});
```

### Payout Derivation Logic (CRITICAL: Per-Test Calculation)

```typescript
// src/services/payoutService.ts
export async function derivePayoutForDoctor(
  referralDoctorId: string,
  branchId: string,
  periodStartDate: Date,
  periodEndDate: Date
) {
  // 1. Get all visits where doctor has explicit referral link (via ReferralDoctor_Visit)
  const referrals = await prisma.referralDoctor_Visit.findMany({
    where: {
      referralDoctorId,
      branchId,
      visit: {
        domain: 'DIAGNOSTICS',
        createdAt: {
          gte: periodStartDate,
          lte: periodEndDate
        },
        report: {
          versions: {
            some: {
              status: 'FINALIZED' // Only finalized reports
            }
          }
        }
      }
    },
    include: {
      visit: {
        include: {
          testOrders: true // Get all test orders for commission calculation
        }
      }
    }
  });

  // 2. CRITICAL: Calculate commission PER TEST ORDER (not per visit total)
  let totalCommissionInPaise = 0;
  
  for (const referral of referrals) {
    for (const testOrder of referral.visit.testOrders) {
      // Use per-test commission % (may be overridden per test)
      const commissionPercent = testOrder.referralCommissionPercentage;
      const testPriceInPaise = testOrder.priceInPaise;
      
      // Commission = test price × commission %
      const testCommissionInPaise = Math.round((testPriceInPaise * commissionPercent) / 100);
      totalCommissionInPaise += testCommissionInPaise;
    }
  }

  // 3. Store immutable ledger entry (NEVER update after creation)
  const ledgerEntry = await prisma.doctorPayoutLedger.create({
    data: {
      referralDoctorId,
      branchId,
      periodStartDate,
      periodEndDate,
      derivedAmountInPaise: totalCommissionInPaise,
      derivedAt: new Date()
    }
  });

  return ledgerEntry;
}
```

---

## Data Seeding

Create `prisma/seed.ts`:
```typescript
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  // Create branch
  const branch = await prisma.branch.create({
    data: {
      name: 'Madhapur',
      code: 'MPR',
      address: '123 Tech St, Madhapur',
      phone: '9876543200',
      isActive: true
    }
  });

  // Create user (staff)
  const hashedPassword = await bcrypt.hash('password123', 10);
  const user = await prisma.user.create({
    data: {
      email: 'staff@sobhana.com',
      passwordHash: hashedPassword,
      name: 'Rajesh Kumar',
      phone: '9876543210',
      role: 'staff',
      activeBranchId: branch.id,
      isActive: true
    }
  });

  // Create referral doctors
  const refDoctor = await prisma.referralDoctor.create({
    data: {
      name: 'Dr. Sharma',
      phone: '9876543211',
      email: 'sharma@clinic.com',
      commissionPercent: 10.0,
      isActive: true
    }
  });

  // Create clinic doctors
  const clinicDoctor = await prisma.clinicDoctor.create({
    data: {
      name: 'Dr. Meera Sharma',
      qualification: 'MBBS, MD (Gen Med)',
      specialty: 'General Medicine',
      registrationNumber: 'TSMC/GM/2020/1234',
      phone: '9876500001',
      email: 'meera@clinic.com',
      letterheadNote: 'Compassionate primary care',
      isActive: true
    }
  });

  // Create lab tests
  const labTest = await prisma.labTest.create({
    data: {
      name: 'Complete Blood Count',
      code: 'CBC',
      priceInPaise: 35000,
      referenceMin: 0,
      referenceMax: 0,
      referenceUnit: '',
      isActive: true
    }
  });

  console.log('✅ Seed complete');
  console.log(`Branch: ${branch.id}`);
  console.log(`User: ${user.id} (email: ${user.email})`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
```

Run seeding:
```bash
npm run db:seed
```

---

## Frontend Integration

Once API is ready, frontend should:

1. Replace all Zustand stores with HTTP client calls
2. Update base URL in `.env`:
   ```
   VITE_API_URL=http://localhost:3000/api
   ```
3. Create API client wrapper:
   ```typescript
   // src/lib/api.ts
   const API = axios.create({
     baseURL: import.meta.env.VITE_API_URL
   });
   
   API.interceptors.request.use((config) => {
     const token = localStorage.getItem('token');
     if (token) {
       config.headers.Authorization = `Bearer ${token}`;
     }
     return config;
   });
   ```
4. Update all pages to call API endpoints
5. Test end-to-end with real backend

---

## Deployment Checklist

- [ ] `.env` configured for production
- [ ] Database migrations applied
- [ ] CORS whitelist set to frontend domain
- [ ] JWT_SECRET rotated in production
- [ ] Audit logging enabled
- [ ] Error monitoring (Sentry) integrated
- [ ] Rate limiting added
- [ ] API documentation generated (Swagger/OpenAPI)
- [ ] Performance optimized (indexes, caching)
- [ ] Security audit completed

---

## Support

For questions on the Prisma schema or API contracts, refer to:
- `prisma/schema.prisma` - Entity definitions (✅ FROZEN)
- `API_CONTRACT_v2.md` - Full endpoint documentation (✅ FROZEN)
- `GUPSHUP_SMS_INTEGRATION.md` - SMS delivery implementation guide

---

## 🎯 PHASE-1 IMPLEMENTATION CHECKLIST

### Week 1: Foundation
- [ ] Prisma migrations applied (`npx prisma migrate dev --name init`)
- [ ] Prisma client generated (`npx prisma generate`)
- [ ] Database seeded with sample data
- [ ] JWT authentication working
- [ ] Branch context middleware working
- [ ] RBAC middleware working

### Week 2: Masters & Patients
- [ ] POST /auth/login (JWT issue)
- [ ] POST /auth/register (admin only)
- [ ] CRUD /referral-doctors
- [ ] CRUD /clinic-doctors
- [ ] CRUD /lab-tests
- [ ] POST /patients (with PatientIdentifier)
- [ ] GET /patients/search

### Week 3: Core Workflows
- [ ] POST /visits/diagnostic (with explicit referral creation)
- [ ] GET /visits/diagnostic (with doctor access filtering)
- [ ] POST /visits/clinic
- [ ] GET /visits/clinic/queue
- [ ] POST /results (test result entry)
- [ ] POST /finalize-report (immutability enforcement)

### Week 4: Payout & Delivery
- [ ] GET /payout/doctor/:id (per-test calculation)
- [ ] POST /payout/derive (owner only)
- [ ] POST /payout/mark-paid (owner only, immutable ledger)
- [ ] POST /delivery/send-sms-report (async, Gupshup)
- [ ] Retry logic for failed SMS

### Week 5: Polish & Deploy
- [ ] GET /print/diagnostic-bill/:visitId
- [ ] GET /print/clinic-prescription/:visitId
- [ ] Error monitoring (Sentry)
- [ ] Rate limiting
- [ ] API documentation (Swagger)
- [ ] Production deployment

---

## ✅ FINAL ARCHITECT CERTIFICATION

**Status**: 🟢 **PHASE-1 ARCHITECTURE FROZEN — BACKEND IMPLEMENTATION APPROVED**

All artifacts frozen and ready:
- ✅ Prisma Schema (532 lines, zero duplicates, enum-only)
- ✅ API Contract v2.0 (30+ endpoints, RBAC matrix)
- ✅ Gupshup SMS Integration (async, auditable)
- ✅ TypeScript Domain Types (aligned with backend)

**Execution Order Locked**:
1. Prisma → 2. Auth/Branch → 3. Core Visits → 4. Reports → 5. RBAC → 6. Payout → 7. SMS

**Backend Team**: Proceed with confidence. Schema will NOT change during Phase-1 implementation.

Questions? Refer to frozen documentation in this directory.
