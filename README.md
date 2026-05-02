# Sobhana Health Hub

A full-stack web application for Sobhana Diagnostic Centre and associated polyclinic branches. Covers patient registration, diagnostic test ordering, lab result entry, PDF report generation, WhatsApp notifications, doctor payouts, and clinical test catalog management.

---

## Overview

Sobhana Portal is a full-stack healthcare management application designed to streamline operations for diagnostic centers and clinics. It handles the complete patient journey from registration through lab testing, report generation, and billing.

### Key Features

- **Patient Management**: Register patients with multiple identifiers (phone, email, Aadhaar)
- **Diagnostic Visits**: Create visits, order lab tests, enter results, and generate reports
- **Clinic Visits**: Manage OP (Outpatient) and IP (Inpatient) consultations
- **Lab Test Catalog**: Configure tests with prices and reference ranges
- **Report Generation**: Version-controlled, immutable finalized reports
- **Billing System**: Automatic bill generation with multiple payment types
- **Referral Management**: Track external referral doctors with commission tracking
- **Multi-Branch Support**: Branch-scoped data isolation
- **Role-Based Access**: Staff, Doctor, and Owner roles with different permissions
- **Audit Logging**: Comprehensive activity tracking

## 🏗️ Architecture

### Tech Stack

**Frontend** (`health-hub/`)
- React 18 + TypeScript
- Vite (build tool)
- TailwindCSS + shadcn/ui components
- Zustand (state management)
- React Router (navigation)
- Sonner (toast notifications)

**Backend** (`health-hub-backend/`)
- Node.js + Express
- TypeScript
- Prisma ORM
- PostgreSQL database
- JWT authentication
- Helmet + CORS security

### Project Structure

```
sobhana-portal/
├── health-hub/                 # Frontend React application
│   ├── src/
│   │   ├── components/         # Reusable UI components
│   │   │   ├── layout/         # Layout components (Sidebar, AppLayout)
│   │   │   ├── print/          # Print templates (bills, reports)
│   │   │   └── ui/             # shadcn/ui components
│   │   ├── pages/              # Route pages
│   │   │   ├── diagnostics/    # Diagnostic workflow pages
│   │   │   ├── clinic/         # Clinic workflow pages
│   │   │   ├── doctor/         # Doctor dashboard
│   │   │   └── owner/          # Admin/owner pages
│   │   ├── store/              # Zustand state stores
│   │   ├── types/              # TypeScript type definitions
│   │   └── hooks/              # Custom React hooks
│   └── public/                 # Static assets
│
├── health-hub-backend/         # Backend API server
│   ├── src/
│   │   ├── routes/             # API route handlers
│   │   ├── services/           # Business logic services
│   │   ├── middleware/         # Auth, branch context, RBAC
│   │   └── utils/              # Utility functions
│   ├── prisma/
│   │   ├── schema.prisma       # Database schema
│   │   ├── migrations/         # Database migrations
│   │   └── seed.ts             # Seed data script
│   └── docs/                   # API documentation
│
└── README.md                   # This file
```

## 🚀 Getting Started

### Prerequisites

- **Node.js**: v20.x or higher ([Download](https://nodejs.org/))
- **PostgreSQL**: v14 or higher ([Download](https://www.postgresql.org/download/))
- **npm** or **bun**: Package manager (bun recommended for frontend)

### Initial Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/sunkenship2025/sobhana-portal.git
   cd sobhana-portal
   ```

2. **Set up PostgreSQL database**
   ```bash
   # Create database
   createdb sobhana_db
   
   # Or using psql
   psql -U postgres
   CREATE DATABASE sobhana_db;
   \q
   ```

### Backend Setup

1. **Navigate to backend directory**
   ```bash
   cd health-hub-backend
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   
   Create `.env` file in `health-hub-backend/`:
   ```env
   # Database
   DATABASE_URL="postgresql://username:password@localhost:5432/sobhana_db"
   
   # JWT Authentication
   JWT_SECRET="your-super-secret-jwt-key-min-32-chars"
   
   # Server
   PORT=3000
   NODE_ENV=development
   ```

4. **Run database migrations**
   ```bash
   npx prisma migrate deploy
   ```

5. **Seed initial data**
   ```bash
   npx prisma db seed
   ```
   

6. **Start the backend server**
   ```bash
   npm run dev
   ```
   
   Server runs at: `http://localhost:3000`
   
   Test health endpoint:
   ```bash
   curl http://localhost:3000/health
   ```

### Frontend Setup

1. **Navigate to frontend directory**
   ```bash
   cd health-hub
   ```

2. **Install dependencies**
   ```bash
   # Using npm
   npm install
   
   # Or using bun (recommended)
   bun install
   ```

3. **Start the development server**
   ```bash
   # Using npm
   npm run dev
   
   # Or using bun
   bun run dev
   ```
   
   Frontend runs at: `http://localhost:8080`

4. **Login with default credentials**
   - Email: `owner@sobhana.com`
   - Password: `password123`

## 🔧 Configuration



**Frontend** (no `.env` needed for development)
- API URL is hardcoded to `http://localhost:3000` for development
- For production, update API URLs in the source code

### Database Schema

The Prisma schema defines:
- **User**: System users with roles (staff, doctor, owner)
- **Branch**: Multiple branch locations
- **Patient**: Patient records with identifiers
- **Visit**: Diagnostic and clinic visits
- **TestOrder**: Lab tests ordered for diagnostic visits
- **Bill**: Billing and payment information
- **Report**: Diagnostic reports with versioning
- **ReferralDoctor**: External referring doctors with commissions
- **ClinicDoctor**: Internal consulting doctors
- **AuditLog**: System activity logging

View schema: `health-hub-backend/prisma/schema.prisma`

## 📖 API Documentation

### Authentication

**Login**
```bash
POST /api/auth/login
Content-Type: 
}

Response: { "token": "jwt-token", "user": {...} }
```

**All other endpoints require:**
- `Authorization: Bearer <token>` header
- `X-Branch-Id: <branch-id>` header (auto-injected from user's active branch)

### Key Endpoints

- **Patients**: `/api/patients`
  - `POST /` - Create patient
  - `GET /search?phone=XXX` - Search by phone
  - `GET /:id` - Get patient details

- **Diagnostic Visits**: `/api/visits/diagnostic`
  - `GET /` - List visits
  - `POST /` - Create visit
  - `POST /:id/results` - Enter test results
  - `POST /:id/finalize` - Finalize report

- **Clinic Visits**: `/api/visits/clinic`
  - `GET /` - List visits
  - `POST /` - Create visit
  - `PATCH /:id` - Update visit

- **Lab Tests**: `/api/lab-tests`
- **Referral Doctors**: `/api/referral-doctors`
- **Clinic Doctors**: `/api/clinic-doctors`

See `health-hub-backend/API_CONTRACT_v2.md` for detailed API documentation.

## 🎯 Common Workflows

### Creating a Diagnostic Visit

1. Navigate to **Diagnostics → New Visit**
2. Enter patient phone number and search
3. Create new patient or select existing
4. Select lab tests to order
5. Choose payment type (CASH/CARD/UPI)
6. Submit to generate bill and visit

### Entering Test Results

1. Navigate to **Diagnostics → Pending Results**
2. Select a visit
3. Enter values for each test
4. Flag abnormal results (HIGH/LOW)
5. Save results (keeps report as DRAFT)
6. Finalize report when ready (creates immutable version)

### Creating a Clinic Visit

1. Navigate to **Clinic → New Visit**
2. Select visit type (OP or IP)
3. Search/create patient
4. Select consulting doctor
5. Enter consultation fee
6. Submit to create visit

## 🧪 Testing

### Backend Tests
```bash
cd health-hub-backend
npm test
```

### Frontend Tests
```bash
cd health-hub
npm test
```

### E2E Testing (Chrome DevTools MCP)
- The project includes Chrome DevTools MCP integration for automated browser testing
- See test guides in root directory

## 🤝 Contributing

### Getting Started

1. **Fork the repository**
2. **Create a feature branch**
   ```bash
   git checkout -b feature/your-feature-name
   ```

3. **Make your changes**
   - Follow existing code style and patterns
   - Add comments for complex logic
   - Update TypeScript types as needed

4. **Test your changes**
   - Test backend endpoints with Postman or curl
   - Test frontend flows in the browser
   - Ensure no compilation errors

5. **Commit with clear messages**
   ```bash
   git commit -m "Add feature: description of what you did"
   ```

6. **Push and create pull request**
   ```bash
   git push origin feature/your-feature-name
   ```

### Code Style

- **TypeScript**: Strict mode enabled
- **Formatting**: Use Prettier (automatic on save)
- **Linting**: ESLint rules enforced
- **Naming**:
  - Components: PascalCase (`PatientCard.tsx`)
  - Functions: camelCase (`createPatient()`)
  - Constants: UPPER_SNAKE_CASE (`MAX_PATIENTS`)
  - Files: kebab-case or PascalCase

### Branch Protection

- `main` branch requires pull request reviews
- All tests must pass before merging
- Keep commits atomic and well-described

## 📝 Development Tips

### Database Changes

After modifying `prisma/schema.prisma`:
```bash
# Create migration
npx prisma migrate dev --name description-of-change

# Apply migrations
npx prisma migrate deploy

# Regenerate Prisma Client
npx prisma generate
```

### Viewing Database

```bash
# Open Prisma Studio
npx prisma studio
```
Runs at `http://localhost:5555`

### Debugging

**Backend:**
- Logs are printed to console
- Use `console.error()` for errors
- Check terminal running `npm run dev`

**Frontend:**
- Use React DevTools browser extension
- Check browser console (F12)
- Network tab shows API calls

### Hot Reload

Both frontend and backend have hot reload:
- **Frontend**: Vite HMR (instant)
- **Backend**: Nodemon (restarts on file change)

## 🐛 Troubleshooting

### Database Connection Failed
```bash
# Check PostgreSQL is running
brew services list  # macOS
sudo service postgresql status  # Linux

# Test connection
psql -U postgres -d sobhana_db
```

### Port Already in Use
```bash
# Kill process on port 3000
lsof -ti:3000 | xargs kill -9

# Kill process on port 8080
lsof -ti:8080 | xargs kill -9
```

### Prisma Errors
```bash
# Reset database (WARNING: deletes all data)
npx prisma migrate reset

# Force regenerate client
npx prisma generate --force
```

### TypeScript Errors
```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install
```

## 🔐 Security Notes

- **JWT Secret**: Use a strong, random secret (min 32 characters)
- **Database Credentials**: Never commit `.env` files
- **Password Hashing**: bcrypt with 10 salt rounds
- **SQL Injection**: Protected by Prisma parameterized queries
- **CORS**: Configured in backend for allowed origins
- **XSS**: React sanitizes inputs by default

## 📄 License

This project is proprietary software for Sobhana Diagnostic Centers.

## 👥 Team

- **Lead Developer**: Pranav Reddy
- **Contributors**: [Your friend's name here]

## 📞 Support

For questions or issues:
- Create an issue on GitHub
- Contact: pranav@sobhana.com

---

**Happy Coding! 🚀**

Last updated: January 5, 2026
