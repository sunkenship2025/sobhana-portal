# Sobhana Health Hub — Backend Service

> Multi-branch diagnostic center & polyclinic management system with integrated referral doctor payout engine.

## 📋 Documentation

This backend service is defined via:

1. **[API_CONTRACT.md](./API_CONTRACT.md)** - Complete REST API specification with all endpoints, request/response schemas, validation rules, and error codes
2. **[BACKEND_SETUP.md](./BACKEND_SETUP.md)** - Step-by-step setup instructions, directory structure, and implementation guidance
3. **[prisma/schema.prisma](./prisma/schema.prisma)** - Complete data model with all entities, relationships, constraints, and indexes
4. **[System Design Document](../SYSTEM_DESIGN_DOCUMENT.md)** - Business requirements, workflows, and data architect rules

---

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Database
Copy `.env.example` to `.env` and update PostgreSQL connection:
```bash
cp .env.example .env
```

Edit `.env`:
```
DATABASE_URL="postgresql://user:password@localhost:5432/sobhana_db"
JWT_SECRET="your-secret-key"
```

### 3. Set Up Database
```bash
# Create migrations
npm run db:migrate

# Seed initial data (branches, users, doctors, tests)
npm run db:seed

# View database in browser
npm run db:studio
```

### 4. Start Development Server
```bash
npm run dev
```

Server runs at `http://localhost:3000`

---

## 🏗️ Architecture

### Core Concepts

**Multi-Branch Isolation:**
- All branch-scoped data (visits, tests, bills) enforced at database level
- Each branch has unique bill number sequences
- Staff sees only their active branch
- Owner can switch branches

**Doctor Access Control:**
- Referral doctors access visits only via referral linkage
- Cannot traverse patients directly
- Clinic doctors limited to clinic operations
- Doctor cannot see master data (tests, referral rates)

**Immutable Medical Records:**
- Finalized diagnostic reports cannot be edited or deleted
- Test results locked once report finalized
- Audit trail preserved on all critical actions
- Soft deletes for master data (preserve history)

**Payout Engine:**
- Fully derived from finalized visits (no manual input)
- Per-test commission override support
- Immutable ledger entries (paidAt marks completion)
- Supports referral commission % override per-test

---

## 📁 Directory Structure

```
health-hub-backend/
├── src/
│   ├── middleware/
│   │   ├── auth.ts             # JWT verification
│   │   ├── branch.ts           # Branch context extraction
│   │   ├── rbac.ts             # Role-based access control
│   │   └── errorHandler.ts     # Centralized error handling
│   ├── routes/
│   │   ├── auth.ts             # POST /auth/login, /auth/register
│   │   ├── patients.ts         # GET, POST /patients
│   │   ├── referralDoctors.ts  # CRUD /referral-doctors
│   │   ├── clinicDoctors.ts    # CRUD /clinic-doctors
│   │   ├── labTests.ts         # CRUD /lab-tests
│   │   ├── diagnosticVisits.ts # Diagnostic workflow
│   │   ├── clinicVisits.ts     # Clinic workflow
│   │   ├── payout.ts           # Payout derivation & history
│   │   └── print.ts            # Bill/prescription HTML generation
│   ├── controllers/
│   │   ├── authController.ts
│   │   ├── patientController.ts
│   │   ├── visitController.ts
│   │   └── payoutController.ts
│   ├── services/
│   │   ├── authService.ts      # Login, JWT generation
│   │   ├── visitService.ts     # Visit creation & finalization
│   │   ├── payoutService.ts    # Payout calculation (core logic)
│   │   ├── printService.ts     # PDF/HTML generation
│   │   └── auditService.ts     # Audit logging
│   ├── types/
│   │   └── index.ts            # Request/response TypeScript types
│   ├── utils/
│   │   ├── errors.ts           # Custom error classes
│   │   ├── logger.ts           # Structured logging
│   │   └── validators.ts       # Input validation helpers
│   └── index.ts                # Express app entry point
├── prisma/
│   ├── schema.prisma           # ✅ Complete data model
│   └── seed.ts                 # Database seeding script
├── .env.example                # ✅ Environment template
├── package.json                # ✅ Dependencies
├── tsconfig.json               # ✅ TypeScript config
├── API_CONTRACT.md             # ✅ Full API specification
├── BACKEND_SETUP.md            # ✅ Setup guide
└── README.md                   # This file
```

---

## 🔑 Key Features

### Authentication (Phase 1)
- JWT-based login for staff/doctor/owner
- Role-based access control (RBAC)
- Active branch context per user

### Masters (Phase 1)
- Referral doctors (commissionPercent, contact info)
- Clinic doctors (qualification, specialty, registration, letterhead)
- Lab tests (code, price, reference ranges)
- Branches (isolated scope)

### Diagnostics Workflow (Phase 1)
- Create visit with referral doctor
- Add multiple tests (per-visit commission override)
- Enter test results
- Finalize report (immutable after)
- Generate diagnostic bill
- Support WhatsApp report delivery (async)

### Clinic Workflow (Phase 1)
- Create visit with clinic doctor
- Track visit status (WAITING → IN_PROGRESS → COMPLETED)
- Generate letterhead prescription + OP bill
- Support clinic queue filtering

### Payout Engine (Phase 1)
- Derive payout from finalized visits (owner only)
- Per-test commission tracking
- Immutable ledger entries
- Mark paid with payment reference
- Audit trail on all payout actions

---

## 🔒 Data Enforcement Rules

All these rules **must be enforced at the service/controller layer**:

| Rule | Check | Action |
|------|-------|--------|
| Branch Isolation | Staff query includes `branchId` filter | Reject if missing |
| Doctor Access | Doctor cannot access master data | Return 403 Forbidden |
| Referral Link | Doctor sees visit only if `referralDoctorId` matches | Filter at query |
| Immutable Reports | Report status = FINALIZED | Reject update, return 409 Conflict |
| Payout Derived | Payout must include finalized visit filter | Calculate or return 409 |
| Audit Trail | All critical writes | Log to AuditLog table |
| Phone Format | POST patient/doctor | Validate 10 digits |
| Commission % | 0-100 range | Validate and return 400 |
| Bill Auto-Gen | Visit creation | Generate next bill number per branch |
| Soft Deletes | Master data deletion | Set isActive = false |

---

## 📡 API Endpoints (Summary)

### Public
- `POST /api/auth/login` - User login
- `POST /api/auth/register` - Create user (admin only)

### Patients (Global)
- `GET /api/patients/search` - Search patients
- `POST /api/patients` - Create patient
- `GET /api/patients/{id}` - Patient details + history

### Masters (Branch context)
- `GET/POST/PATCH/DELETE /api/referral-doctors`
- `GET/POST/PATCH/DELETE /api/clinic-doctors`
- `GET/POST/PATCH/DELETE /api/lab-tests`
- `PATCH /api/user/active-branch` - Switch branch

### Diagnostics
- `POST /api/visits/diagnostic` - Create diagnostic visit
- `GET /api/visits/diagnostic` - List visits
- `GET /api/visits/diagnostic/{id}` - Visit details
- `POST /api/visits/diagnostic/{id}/results` - Enter results
- `POST /api/visits/diagnostic/{id}/finalize-report` - Finalize report

### Clinic
- `POST /api/visits/clinic` - Create clinic visit
- `GET /api/visits/clinic/queue` - Queue view
- `PATCH /api/visits/clinic/{id}/status` - Update status
- `GET /api/visits/clinic/{id}` - Visit details

### Payout
- `GET /api/payout/doctor/{id}` - Payout history
- `POST /api/payout/derive` - Derive payout (owner only)
- `POST /api/payout/mark-paid` - Mark paid (owner only)

### Print
- `GET /api/print/diagnostic-bill/{visitId}` - HTML bill
- `GET /api/print/clinic-prescription/{visitId}` - HTML prescription

Full specification: See [API_CONTRACT.md](./API_CONTRACT.md)

---

## 🛠️ Development Workflow

### Add New Endpoint

1. **Define in API_CONTRACT.md** (request/response schemas)
2. **Add route** in `src/routes/{domain}.ts`
3. **Create controller** in `src/controllers/{domain}Controller.ts`
4. **Implement service logic** in `src/services/{domain}Service.ts`
5. **Add tests** (future phase)
6. **Document enforcement rules** in README

### Update Database Schema

1. Edit `prisma/schema.prisma`
2. Run `npm run db:migrate -- --name {description}`
3. Review generated migration in `prisma/migrations/{timestamp}/migration.sql`
4. Test locally: `npm run db:push`
5. Document relationship & constraints

### Debugging

```bash
# View database in browser
npm run db:studio

# Check pending migrations
npx prisma migrate status

# Reset database (dev only)
npx prisma migrate reset

# View logs
tail -f logs/app.log
```

---

## 🧪 Testing

*(To be implemented in Phase 2)*

```bash
npm run test
npm run test:watch
npm run test:coverage
```

---

## 📊 Performance & Optimization

### Database Indexes
✅ All critical queries indexed:
- `visitId` (visits anchor)
- `branchId` + entity ID (branch scope)
- `referralDoctorId` + `status` (doctor access)
- `finalized_at` (payout derivation)
- `createdAt` (time range queries)

### Caching (Future)
- Patient lookup cache (5 min TTL)
- Master data cache (invalidate on update)
- JWT token refresh optimization

### Rate Limiting
- Enabled by default (100 req/15 min per IP)
- Whitelist critical endpoints (health, login)

---

## 🔐 Security

### Checklist
- ✅ JWT authentication on protected routes
- ✅ Role-based access control (RBAC)
- ✅ Branch isolation at DB/query level
- ✅ Password hashing (bcryptjs)
- ✅ CORS configured
- ✅ Helmet security headers
- ✅ Input validation
- ✅ SQL injection prevention (Prisma parameterized queries)
- ✅ Audit logging on critical actions

### TODO (Production)
- [ ] Rate limiting refinement
- [ ] API key rotation
- [ ] Secrets rotation (JWT_SECRET)
- [ ] Encryption for sensitive fields
- [ ] HTTPS enforcement
- [ ] Security headers audit
- [ ] Penetration testing

---

## 📝 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | - | PostgreSQL connection string (required) |
| `JWT_SECRET` | - | Secret for JWT signing (required, min 32 chars) |
| `JWT_EXPIRES_IN` | `7d` | Token expiration duration |
| `NODE_ENV` | `development` | Environment mode |
| `PORT` | `3000` | Server port |
| `CORS_ORIGIN` | `http://localhost:5173` | Frontend origin |
| `WHATSAPP_API_KEY` | - | WhatsApp Business API key (optional) |
| `AUDIT_LOG_ENABLED` | `true` | Enable audit logging |
| `RATE_LIMIT_ENABLED` | `true` | Enable rate limiting |

---

## 🚢 Deployment

### Production Checklist
- [ ] `.env` configured with production values
- [ ] `JWT_SECRET` rotated (32+ char random)
- [ ] Database backups enabled
- [ ] All migrations applied
- [ ] Rate limiting tuned
- [ ] Audit logging enabled
- [ ] Error monitoring (Sentry) configured
- [ ] Logging aggregation set up
- [ ] CORS whitelist configured
- [ ] Security headers verified
- [ ] Database performance optimized
- [ ] Load testing completed

### Docker (Optional)

```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY dist ./dist
COPY prisma ./prisma

EXPOSE 3000

CMD ["node", "dist/index.js"]
```

Build:
```bash
npm run build
docker build -t sobhana-backend .
docker run -p 3000:3000 --env-file .env sobhana-backend
```

---

## 📚 References

- **Frontend**: `/Users/pranavreddy/Desktop/sobhana\ portal/health-hub/`
- **System Design**: `../SYSTEM_DESIGN_DOCUMENT.md`
- **Data Model**: `prisma/schema.prisma`
- **API Contract**: `API_CONTRACT.md`
- **Setup Guide**: `BACKEND_SETUP.md`

---

## 🤝 Contributing

When implementing features:

1. Follow the API contract exactly
2. Enforce all data architect rules
3. Add audit logs for critical actions
4. Test cross-branch isolation
5. Document edge cases
6. Add TypeScript types for all inputs
7. Use structured logging

---

## 📞 Support

For questions about:
- **Frontend integration**: Contact frontend team
- **Database schema**: See `prisma/schema.prisma`
- **API details**: See `API_CONTRACT.md`
- **Business rules**: See `SYSTEM_DESIGN_DOCUMENT.md`

---

**Last Updated:** December 2025  
**Version:** 1.0.0-beta  
**Status:** Ready for implementation
