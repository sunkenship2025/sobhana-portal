# Sobhana Health Hub — Backend Implementation Roadmap

## 📋 Overview

This document outlines the complete backend specification for the Sobhana Health Hub system. All requirements, constraints, and data models are fully defined. **The backend team now has everything needed to implement the API.**

---

## 📦 What's Provided

### 1. Complete Data Model (`prisma/schema.prisma`)
- ✅ 18 Prisma models with all relationships
- ✅ All database constraints, unique indexes
- ✅ Branch isolation enforcement
- ✅ Audit logging structure
- ✅ Payout calculation schema
- Ready for: `npm run db:migrate`

### 2. Full API Contract (`API_CONTRACT.md`)
- ✅ 30+ REST endpoints documented
- ✅ Request/response schemas with examples
- ✅ Error codes and validation rules
- ✅ Authentication & authorization details
- ✅ Data enforcement checklist

### 3. Backend Setup Guide (`BACKEND_SETUP.md`)
- ✅ Step-by-step installation (Node, Prisma, DB)
- ✅ Directory structure scaffold
- ✅ Code examples for middleware
- ✅ Payout derivation logic
- ✅ Database seeding template

### 4. System Architecture (`../SYSTEM_DESIGN_DOCUMENT.md`)
- ✅ Business workflows (diagnostics, clinic, payout)
- ✅ User roles and permissions
- ✅ Data architect rules (9 core invariants)
- ✅ Branch isolation strategy
- ✅ Doctor access control

### 5. Project Scaffold
- ✅ `package.json` (all dependencies)
- ✅ `tsconfig.json` (TypeScript config)
- ✅ `.env.example` (environment template)
- ✅ `.gitignore` (standard Node.js excludes)
- ✅ `README.md` (quick reference)

---

## 🏗️ Implementation Phases

### Phase 1: Core Infrastructure (Week 1)

**Deliverables:**
- [ ] Express.js app scaffold with Prisma
- [ ] Middleware: auth, branch context, RBAC, error handling
- [ ] PostgreSQL database migration (from schema)
- [ ] Database seeding script (branches, users, masters)
- [ ] Health check endpoint (`GET /health`)

**Files to Create:**
```
src/
├── middleware/
│   ├── auth.ts
│   ├── branch.ts
│   ├── rbac.ts
│   └── errorHandler.ts
├── types/
│   └── index.ts
├── utils/
│   ├── errors.ts
│   ├── logger.ts
│   └── validators.ts
├── index.ts
├── env.ts
└── constants.ts
```

**Validation:**
```bash
npm run dev
# Should print: "🚀 Server running on http://localhost:3000"

curl http://localhost:3000/health
# Should return: { "status": "ok" }
```

---

### Phase 2: Authentication & Masters (Week 1-2)

**Endpoints:**
1. `POST /auth/login` — User login with JWT
2. `POST /auth/register` — Create staff/doctor (admin only)
3. `GET /referral-doctors` — List referral doctors
4. `POST /referral-doctors` — Create referral doctor
5. `PATCH /referral-doctors/{id}` — Update referral doctor
6. `DELETE /referral-doctors/{id}` — Soft-delete referral doctor
7. `GET /clinic-doctors` — List clinic doctors
8. `POST /clinic-doctors` — Create clinic doctor
9. `PATCH /clinic-doctors/{id}` — Update clinic doctor
10. `DELETE /clinic-doctors/{id}` — Soft-delete clinic doctor
11. `GET /lab-tests` — List lab tests
12. `POST /lab-tests` — Create lab test
13. `PATCH /lab-tests/{id}` — Update lab test
14. `DELETE /lab-tests/{id}` — Soft-delete lab test
15. `PATCH /user/active-branch` — Switch active branch

**Files to Create:**
```
src/
├── routes/
│   ├── auth.ts
│   ├── referralDoctors.ts
│   ├── clinicDoctors.ts
│   └── labTests.ts
├── controllers/
│   ├── authController.ts
│   ├── masterController.ts
└── services/
    ├── authService.ts
    └── masterService.ts
```

**Testing:**
```bash
# Test auth
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"staff@sobhana.com","password":"password123"}'

# Test create referral doctor
curl -X POST http://localhost:3000/api/referral-doctors \
  -H "Authorization: Bearer {TOKEN}" \
  -d '{"name":"Dr. Sharma","commissionPercent":10}'
```

---

### Phase 3: Patient Management (Week 2)

**Endpoints:**
1. `GET /patients/search` — Search patients (phone/name/email)
2. `POST /patients` — Create patient
3. `GET /patients/{id}` — Patient details + visit history

**Files to Create:**
```
src/
├── routes/
│   └── patients.ts
├── controllers/
│   └── patientController.ts
└── services/
    └── patientService.ts
```

**Key Points:**
- Patients are GLOBAL (not branch-scoped)
- Search requires at least one criterion
- Visit history shows all visits across all branches
- No patient update/delete (immutable)

---

### Phase 4: Diagnostics Workflow (Week 2-3)

**Endpoints:**
1. `POST /visits/diagnostic` — Create diagnostic visit + test orders
2. `GET /visits/diagnostic` — List visits (branch-filtered)
3. `GET /visits/diagnostic/{id}` — Visit + tests + current results
4. `POST /visits/diagnostic/{id}/results` — Enter test results (bulk)
5. `POST /visits/diagnostic/{id}/finalize-report` — Finalize report

**Files to Create:**
```
src/
├── routes/
│   └── diagnosticVisits.ts
├── controllers/
│   └── diagnosticController.ts
└── services/
    ├── diagnosticService.ts
    ├── reportService.ts
    └── printService.ts
```

**Key Logic:**
- Auto-generate bill number per branch: `D-{BRANCH_CODE}-{SEQUENCE}`
- Per-test override: if null, use referralDoctor.commissionPercent
- Cannot enter results for non-existent test
- Cannot finalize if results incomplete
- Report becomes immutable after finalize

**Validation Rules:**
- `testIds` not empty
- `referralCommissionPercentOverride` (if provided) ∈ [0, 100]
- Test results: `value` numeric or null, `flag` ∈ {NORMAL, HIGH, LOW}

---

### Phase 5: Clinic Workflow (Week 3)

**Endpoints:**
1. `POST /visits/clinic` — Create clinic visit
2. `GET /visits/clinic/queue` — Clinic queue (filter by doctor/status)
3. `PATCH /visits/clinic/{id}/status` — Update visit status
4. `GET /visits/clinic/{id}` — Visit + patient + doctor details

**Files to Create:**
```
src/
├── routes/
│   └── clinicVisits.ts
├── controllers/
│   └── clinicController.ts
└── services/
    └── clinicService.ts
```

**Key Logic:**
- Auto-generate bill number per branch: `C-{BRANCH_CODE}-{SEQUENCE}`
- Link to clinic doctor (not referral doctor)
- Status transitions: WAITING → IN_PROGRESS → COMPLETED
- No backwards transitions allowed
- Staff/owner can create and update, doctor cannot access queue

---

### Phase 6: Payout Engine (Week 3-4)

**Endpoints:**
1. `GET /payout/doctor/{id}` — Payout history for referral doctor
2. `POST /payout/derive` — Derive payout for period (owner only)
3. `POST /payout/mark-paid` — Mark payout as paid (owner only)

**Files to Create:**
```
src/
├── routes/
│   └── payout.ts
├── controllers/
│   └── payoutController.ts
└── services/
    └── payoutService.ts
```

**Payout Derivation Logic:**
1. Get all **finalized** diagnostic visits for doctor in branch + period
2. For each visit, for each test order:
   - `commissionAmount = bill.totalAmountInPaise × testOrder.referralCommissionPercentage / 100`
3. Sum all commission amounts
4. Store as immutable `DoctorPayoutLedger` entry
5. Set `derivedAt` timestamp
6. Cannot derive twice for same period (check unique constraint)

**Immutability:**
- Once `paidAt` is set, cannot update ledger entry
- Audit log all payout operations

---

### Phase 7: Printing & Delivery (Week 4)

**Endpoints:**
1. `GET /print/diagnostic-bill/{visitId}` — HTML diagnostic bill
2. `GET /print/clinic-prescription/{visitId}` — HTML prescription + bill
3. `POST /delivery/send-report-whatsapp` — Send report via WhatsApp (async)

**Files to Create:**
```
src/
├── routes/
│   └── print.ts
├── services/
│   ├── printService.ts
│   └── deliveryService.ts
└── templates/
    ├── diagnosticBill.html
    └── clinicPrescription.html
```

**Key Points:**
- Render as HTML (frontend prints via browser)
- Include all necessary details (patient, tests, prices, doctor, letterhead)
- WhatsApp delivery is async (return 202 Accepted with job ID)
- Use WhatsApp Business API (configure API key in .env)

---

### Phase 8: Audit Logging & Deployment (Week 4)

**Implementation:**
- [ ] Audit logging on all critical writes (visit, result, finalize, payout)
- [ ] Audit queries: `GET /audit-logs` (owner only)
- [ ] Structured logging (JSON format)
- [ ] Error monitoring (Sentry integration, optional)
- [ ] Rate limiting configuration
- [ ] Performance optimization (indexes verified)
- [ ] Security audit
- [ ] Production `.env` setup

---

## 🔄 Data Enforcement Rules

**These must be enforced in the service/controller layer:**

### Branch Isolation
```typescript
// ✅ DO: Filter by active branch
const visits = await prisma.visit.findMany({
  where: {
    branchId: req.branchId,  // From middleware
    domain: 'DIAGNOSTICS'
  }
});

// ❌ DON'T: Query without branch filter
const visits = await prisma.visit.findMany({
  where: { domain: 'DIAGNOSTICS' }
});
```

### Doctor Access
```typescript
// ✅ DO: Doctor sees only referral visits
const visits = await prisma.visit.findMany({
  where: {
    referralDoctorId: req.user.id,
    // ... other filters
  }
});

// ❌ DON'T: Doctor accesses all patients/masters
const allPatients = await prisma.patient.findMany();
```

### Immutable Reports
```typescript
// ✅ DO: Check report status before update
const report = await prisma.report.findUnique({ where: { id } });
if (report.status === 'FINALIZED') {
  throw new Error('Cannot update finalized report');
}

// ❌ DON'T: Update without checking
await prisma.testResult.update({ where: { id }, data: newData });
```

### Per-Test Commission Override
```typescript
// ✅ DO: Validate override range
if (override !== null && (override < 0 || override > 100)) {
  throw new Error('Commission % must be 0-100');
}

// ✅ DO: Default to doctor's commission
const commission = override ?? referralDoctor.commissionPercent;

// ❌ DON'T: Skip validation or default
```

### Payout Derivation
```typescript
// ✅ DO: Derive from finalized visits only
const visits = await prisma.visit.findMany({
  where: {
    referralDoctorId,
    branchId,
    report: {
      versions: {
        some: {
          status: 'FINALIZED'  // Critical filter
        }
      }
    }
  }
});

// ❌ DON'T: Include non-finalized visits
const visits = await prisma.visit.findMany({
  where: { referralDoctorId, branchId }
});
```

---

## 📊 Testing Strategy

### Unit Tests (Services)
- Payout calculation logic
- Commission override defaults
- Bill number generation per branch
- Status transition validation

### Integration Tests
- Full diagnostic workflow (create → result → finalize)
- Full clinic workflow (create → status updates)
- Payout derivation end-to-end
- Cross-branch isolation
- Doctor access restrictions

### E2E Tests
- Frontend API integration
- Real database operations
- Full user workflows
- Error scenarios

---

## 🔐 Security Checklist

Before production deployment:

- [ ] JWT tokens only work with valid signature
- [ ] Passwords hashed (bcryptjs)
- [ ] Branch context from DB (not user-submitted)
- [ ] Role checks on all protected routes
- [ ] Doctor cannot access queue/masters
- [ ] All queries parameterized (Prisma handles this)
- [ ] Rate limiting enabled
- [ ] CORS configured to frontend only
- [ ] Audit logs stored
- [ ] Sensitive fields not logged
- [ ] Error messages don't leak data

---

## 🚀 Launch Checklist

### Pre-Launch
- [ ] All 30+ endpoints implemented
- [ ] Database migrations applied
- [ ] Seed data in place
- [ ] JWT_SECRET configured (32+ chars)
- [ ] CORS_ORIGIN set to frontend domain
- [ ] WhatsApp API key (if enabled)
- [ ] Email/SMS credentials (if enabled)
- [ ] Logging aggregation working
- [ ] Error monitoring configured
- [ ] Performance tested (load test 1000 concurrent users)
- [ ] Security audit completed
- [ ] Frontend team has API URL

### Post-Launch
- [ ] Monitor error rates
- [ ] Monitor API latency (p95 < 200ms)
- [ ] Monitor database query times
- [ ] Collect user feedback
- [ ] Plan Phase 2 features

---

## 📞 Implementation Support

### For Questions About:
- **Data model**: Review `prisma/schema.prisma` + Prisma docs
- **API contract**: See `API_CONTRACT.md` (exact request/response)
- **Business rules**: See `SYSTEM_DESIGN_DOCUMENT.md` (data architect notes)
- **Setup**: See `BACKEND_SETUP.md` (step-by-step)
- **Enforcement rules**: See this document (🔐 section above)

### Common Implementation Questions

**Q: How do I know if user is staff or owner?**
A: Check `req.user.role` from JWT token (middleware sets this)

**Q: How do I filter by active branch?**
A: Use `req.branchId` from branch context middleware

**Q: How do I check if report is finalized?**
A: Query `report.versions` and check if any has `status: 'FINALIZED'`

**Q: How do I calculate referral commission for a test?**
A: `testOrder.referralCommissionPercentage` already has it (defaulted at visit creation)

**Q: Can doctor update their own master info?**
A: No, doctor cannot access any master data. Use update endpoint if needed.

---

## 📚 References

- **Frontend Codebase**: `/Users/pranavreddy/Desktop/sobhana\ portal/health-hub/`
- **System Design**: `../SYSTEM_DESIGN_DOCUMENT.md`
- **Prisma Schema**: `prisma/schema.prisma`
- **API Contract**: `API_CONTRACT.md`
- **Setup Guide**: `BACKEND_SETUP.md`
- **Main README**: `README.md`

---

## ✅ Success Criteria

The backend is **production-ready** when:

1. ✅ All 30+ endpoints in API_CONTRACT.md implemented
2. ✅ All requests/responses match exact schema
3. ✅ All 9 data architect invariants enforced
4. ✅ Database migrations applied successfully
5. ✅ Seed data loads without errors
6. ✅ JWT authentication working
7. ✅ Branch isolation tested (staff cannot see other branches)
8. ✅ Doctor access restricted (cannot access masters or queues)
9. ✅ Payout derivation calculates correctly
10. ✅ Audit logs recorded for critical actions
11. ✅ Error responses match API_CONTRACT.md
12. ✅ CORS allows frontend domain
13. ✅ Rate limiting prevents abuse
14. ✅ Performance: p95 latency < 200ms
15. ✅ Frontend successfully integrates (API calls working)

---

## 🎯 Next Steps

1. **Fork/clone** this repository
2. **Read** `BACKEND_SETUP.md` (do this first!)
3. **Initialize** Node.js + Prisma + Database
4. **Implement** endpoints in order: Auth → Masters → Patients → Diagnostics → Clinic → Payout
5. **Test** each endpoint with Postman/curl
6. **Verify** data enforcement rules
7. **Share** API URL with frontend team
8. **Integrate** with frontend

---

**Version:** 1.0.0-beta  
**Status:** Ready for implementation  
**Last Updated:** December 2025

Good luck! 🚀
