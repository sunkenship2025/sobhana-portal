# Sobhana Health Hub Backend — Getting Started

**Status**: ✅ Phase 1 Implementation Started (Auth + Branch Context Complete)

## 🚀 Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. Setup Database
Make sure PostgreSQL is running, then update `.env` with your database URL:
```
DATABASE_URL="postgresql://user:password@localhost:5432/sobhana_db"
```

### 3. Run Prisma Migrations
```bash
npx prisma migrate dev --name init
npx prisma generate
```

### 4. Seed Database
```bash
npm run db:seed
```

This creates:
- 2 branches (Madhapur, Kukatpally)
- 3 users (admin, staff, owner) - password: `password123`
- 2 referral doctors
- 2 clinic doctors
- 3 lab tests

### 5. Start Development Server
```bash
npm run dev
```

Server will start on `http://localhost:3000`

## 📋 Implementation Progress

### ✅ Phase 1: Foundation (COMPLETE)
- [x] Prisma schema frozen
- [x] Project structure created
- [x] Dependencies configured

### ✅ Phase 2: Auth + Branch Context (COMPLETE)
- [x] JWT authentication middleware
- [x] Branch context injection
- [x] RBAC middleware
- [x] Auth routes (login, register)
- [x] Error handling utilities
- [x] Audit logging service

### 🚧 Phase 3: Core Visit Flows (IN PROGRESS)
- [ ] Patient routes (search, create with PatientIdentifier)
- [ ] Diagnostic visit creation
- [ ] Clinic visit creation
- [ ] Bill generation

### ⏳ Phase 4: Report Lifecycle (TODO)
- [ ] Test result entry
- [ ] Report finalization
- [ ] Immutability enforcement

### ⏳ Phase 5: RBAC & Referral Gates (TODO)
- [ ] Doctor access checks
- [ ] Owner overrides

### ⏳ Phase 6: Payout Derivation (TODO)
- [ ] Per-test calculation
- [ ] Immutable ledger

### ⏳ Phase 7: SMS Delivery (TODO)
- [ ] Gupshup integration
- [ ] Retry logic

## 🔐 Testing Auth

### Login
```bash
curl -X POST http://localhost:3000/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{
    "email": "staff@sobhana.com",
    "password": "password123"
  }'
```

Response:
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "id": "...",
    "email": "staff@sobhana.com",
    "name": "Rajesh Kumar",
    "role": "staff",
    "activeBranch": {
      "id": "...",
      "name": "Sobhana - Madhapur",
      "code": "MPR"
    }
  }
}
```

### Health Check
```bash
curl http://localhost:3000/health
```

## 📚 Next Steps

1. Install Node.js 18+ if not already installed
2. Run the commands above to start the server
3. Continue with Phase 3: Patient and Visit routes

## 🔧 Development Tools

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build for production
- `npm run db:studio` - Open Prisma Studio (database GUI)
- `npm run db:migrate` - Create new migration

## 📖 Documentation

- [API_CONTRACT_v2.md](./API_CONTRACT_v2.md) - Full API specification
- [BACKEND_SETUP.md](./BACKEND_SETUP.md) - Implementation guide
- [prisma/schema.prisma](./prisma/schema.prisma) - Database schema
