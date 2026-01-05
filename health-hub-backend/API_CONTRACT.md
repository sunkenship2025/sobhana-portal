# Sobhana Health Hub — Backend API Contract (Phase-1)

## Overview

This document defines all REST API endpoints, request/response contracts, and backend enforcement rules for Phase-1 development.

**Base URL:** `http://localhost:3000/api`

**Authentication:** All endpoints (except `/auth/login`, `/auth/register`) require:
```
Authorization: Bearer {JWT_TOKEN}
```

**Headers Required:**
```json
{
  "Content-Type": "application/json",
  "Authorization": "Bearer {token}"
}
```

---

## 🔐 Authentication

### POST `/auth/login`
Create session for staff/doctor/owner.

**Request:**
```json
{
  "email": "staff@sobhana.com",
  "password": "secure_password"
}
```

**Response (200):**
```json
{
  "token": "eyJhbGc...",
  "user": {
    "id": "user-1",
    "email": "staff@sobhana.com",
    "name": "Rajesh Kumar",
    "role": "staff",
    "activeBranchId": "branch-1",
    "isActive": true
  }
}
```

**Errors:**
- `401 Unauthorized` – Invalid credentials
- `403 Forbidden` – User inactive

---

### POST `/auth/register` (Admin only)
Create new user (staff/doctor).

**Request:**
```json
{
  "email": "newstaff@sobhana.com",
  "password": "secure_password",
  "name": "New Staff",
  "phone": "9876543210",
  "role": "staff",
  "activeBranchId": "branch-1"
}
```

**Response (201):**
```json
{
  "user": {
    "id": "user-2",
    "email": "newstaff@sobhana.com",
    "name": "New Staff",
    "role": "staff",
    "activeBranchId": "branch-1"
  }
}
```

---

## 👥 Patients (GLOBAL)

### GET `/patients/search`
Search patients globally across all branches.

**Query Params:**
- `phone` (string, optional)
- `name` (string, optional)
- `email` (string, optional)

**Response (200):**
```json
{
  "patients": [
    {
      "id": "pat-1",
      "name": "John Doe",
      "phone": "9876543210",
      "age": 45,
      "gender": "M",
      "email": "john@example.com",
      "visitHistory": [
        {
          "visitId": "visit-1",
          "domain": "DIAGNOSTICS",
          "branchId": "branch-1",
          "branchName": "Madhapur",
          "billNumber": "D-10231",
          "createdAt": "2025-12-15T10:30:00Z"
        },
        {
          "visitId": "visit-2",
          "domain": "CLINIC",
          "branchId": "branch-2",
          "branchName": "Kukatpally",
          "billNumber": "C-20341",
          "visitType": "OP",
          "createdAt": "2025-12-10T14:15:00Z"
        }
      ]
    }
  ]
}
```

**Errors:**
- `400 Bad Request` – Invalid query parameters

---

### POST `/patients`
Create new patient (global).

**Request:**
```json
{
  "name": "Jane Doe",
  "phone": "9876543211",
  "age": 38,
  "gender": "F",
  "email": "jane@example.com",
  "address": "123 Main St, City"
}
```

**Response (201):**
```json
{
  "patient": {
    "id": "pat-2",
    "name": "Jane Doe",
    "phone": "9876543211",
    "age": 38,
    "gender": "F",
    "email": "jane@example.com",
    "address": "123 Main St, City",
    "createdAt": "2025-12-20T09:00:00Z"
  }
}
```

---

### GET `/patients/{patientId}`
Retrieve patient details + visit history.

**Response (200):**
```json
{
  "patient": {
    "id": "pat-1",
    "name": "John Doe",
    "phone": "9876543210",
    "age": 45,
    "gender": "M",
    "visitHistory": [...]
  }
}
```

---

## 🏥 Branches

### GET `/branches`
List all active branches (owner/admin only).

**Response (200):**
```json
{
  "branches": [
    {
      "id": "branch-1",
      "name": "Madhapur",
      "code": "MPR",
      "address": "123 Tech St, Madhapur",
      "phone": "9876543200",
      "isActive": true
    },
    {
      "id": "branch-2",
      "name": "Kukatpally",
      "code": "KPY",
      "address": "456 Clinic Ave, Kukatpally",
      "phone": "9876543201",
      "isActive": true
    }
  ]
}
```

---

### PATCH `/user/active-branch`
Switch user's active branch (staff/owner).

**Request:**
```json
{
  "activeBranchId": "branch-2"
}
```

**Response (200):**
```json
{
  "user": {
    "id": "user-1",
    "activeBranchId": "branch-2"
  }
}
```

**Backend Enforcement:**
- Only staff and owner can switch branches
- Doctor cannot switch branches
- Must be an active branch

---

## 📋 Referral Doctors (Master Data)

### GET `/referral-doctors`
List all referral doctors (staff/owner).

**Response (200):**
```json
{
  "referralDoctors": [
    {
      "id": "ref-doc-1",
      "name": "Dr. Sharma",
      "phone": "9876543211",
      "email": "sharma@clinic.com",
      "commissionPercent": 10.0,
      "isActive": true
    }
  ]
}
```

---

### POST `/referral-doctors`
Create referral doctor (staff/owner).

**Request:**
```json
{
  "name": "Dr. Sharma",
  "phone": "9876543211",
  "email": "sharma@clinic.com",
  "commissionPercent": 10.0
}
```

**Response (201):**
```json
{
  "referralDoctor": {
    "id": "ref-doc-1",
    "name": "Dr. Sharma",
    "phone": "9876543211",
    "email": "sharma@clinic.com",
    "commissionPercent": 10.0,
    "isActive": true
  }
}
```

**Backend Validation:**
- `commissionPercent` ∈ [0, 100]
- `phone` 10 digits
- Email is optional

---

### PATCH `/referral-doctors/{id}`
Update referral doctor.

**Request:**
```json
{
  "commissionPercent": 12.0,
  "isActive": true
}
```

**Response (200):** Updated doctor object

---

### DELETE `/referral-doctors/{id}`
Soft-delete (set isActive = false).

**Response (204):** No content

---

## 👨‍⚕️ Clinic Doctors (Master Data)

### GET `/clinic-doctors`
List clinic doctors (staff/owner).

**Response (200):**
```json
{
  "clinicDoctors": [
    {
      "id": "clinic-doc-1",
      "name": "Dr. Meera Sharma",
      "qualification": "MBBS, MD (Gen Med)",
      "specialty": "General Medicine",
      "registrationNumber": "TSMC/GM/2020/1234",
      "phone": "9876500001",
      "email": "meera@clinic.com",
      "letterheadNote": "Compassionate primary care",
      "isActive": true
    }
  ]
}
```

---

### POST `/clinic-doctors`
Create clinic doctor (staff/owner).

**Request:**
```json
{
  "name": "Dr. Meera Sharma",
  "qualification": "MBBS, MD (Gen Med)",
  "specialty": "General Medicine",
  "registrationNumber": "TSMC/GM/2020/1234",
  "phone": "9876500001",
  "email": "meera@clinic.com",
  "letterheadNote": "Compassionate primary care"
}
```

**Response (201):** Created clinic doctor object

**Backend Validation:**
- `phone` 10 digits (optional)
- `registrationNumber` required
- All fields except phone/email required

---

### PATCH `/clinic-doctors/{id}`
Update clinic doctor.

**Response (200):** Updated object

---

### DELETE `/clinic-doctors/{id}`
Soft-delete.

**Response (204):** No content

---

## 🔬 Lab Tests (Master Data)

### GET `/lab-tests`
List all lab tests (staff/owner).

**Response (200):**
```json
{
  "labTests": [
    {
      "id": "test-1",
      "name": "Complete Blood Count (CBC)",
      "code": "CBC",
      "priceInPaise": 35000,
      "referenceMin": 0,
      "referenceMax": 0,
      "referenceUnit": "",
      "isActive": true
    }
  ]
}
```

---

### POST `/lab-tests`
Create lab test (staff/owner).

**Request:**
```json
{
  "name": "Thyroid Stimulating Hormone",
  "code": "TSH",
  "priceInPaise": 45000,
  "referenceMin": 0.4,
  "referenceMax": 4.0,
  "referenceUnit": "mIU/L"
}
```

**Response (201):** Created test object

**Backend Validation:**
- `priceInPaise` > 0
- `code` must be unique
- `referenceMin` ≤ `referenceMax`

---

### PATCH `/lab-tests/{id}`
Update lab test.

**Response (200):** Updated object

---

### DELETE `/lab-tests/{id}`
Soft-delete.

**Response (204):** No content

---

## 📊 Diagnostics Visits

### POST `/visits/diagnostic`
Create diagnostic visit + test orders.

**Request:**
```json
{
  "patientId": "pat-1",
  "referralDoctorId": "ref-doc-1",
  "testIds": [
    {
      "testId": "test-1",
      "referralCommissionPercentOverride": null
    },
    {
      "testId": "test-2",
      "referralCommissionPercentOverride": 12.0
    }
  ],
  "paymentType": "CASH",
  "paymentStatus": "PAID"
}
```

**Response (201):**
```json
{
  "visit": {
    "id": "visit-1",
    "branchId": "branch-1",
    "billNumber": "D-MPR-10231",
    "domain": "DIAGNOSTICS",
    "totalAmountInPaise": 80000,
    "paymentType": "CASH",
    "paymentStatus": "PAID",
    "referralDoctorId": "ref-doc-1",
    "createdAt": "2025-12-20T10:00:00Z"
  },
  "testOrders": [
    {
      "id": "to-1",
      "visitId": "visit-1",
      "testId": "test-1",
      "testName": "Complete Blood Count",
      "priceInPaise": 35000,
      "referralCommissionPercentage": 10.0
    },
    {
      "id": "to-2",
      "visitId": "visit-1",
      "testId": "test-2",
      "testName": "TSH",
      "priceInPaise": 45000,
      "referralCommissionPercentage": 12.0
    }
  ],
  "bill": {
    "id": "bill-1",
    "billNumber": "D-MPR-10231",
    "totalAmountInPaise": 80000,
    "paymentStatus": "PAID"
  }
}
```

**Backend Enforcement:**
- `branchId` from active branch (staff context)
- `billNumber` auto-generated per branch
- `totalAmountInPaise` sum of test prices
- If referralCommissionPercentOverride is null, use referralDoctor.commissionPercent
- referralCommissionPercentOverride must be ∈ [0, 100] if provided
- Audit log: Visit creation

---

### GET `/visits/diagnostic`
List diagnostic visits in active branch.

**Query Params:**
- `status` (DRAFT | RESULTS_PENDING | FINALIZED)
- `referralDoctorId` (optional filter)
- `limit` (default 50)
- `offset` (default 0)

**Response (200):**
```json
{
  "visits": [
    {
      "id": "visit-1",
      "billNumber": "D-MPR-10231",
      "patientName": "John Doe",
      "totalAmountInPaise": 80000,
      "status": "RESULTS_PENDING",
      "createdAt": "2025-12-20T10:00:00Z"
    }
  ],
  "total": 15
}
```

**Backend Enforcement:**
- Filter by active branch only
- Doctor cannot access this list

---

### GET `/visits/diagnostic/{visitId}`
Get diagnostic visit + test orders + report.

**Response (200):**
```json
{
  "visit": { ... },
  "patient": { ... },
  "testOrders": [ ... ],
  "report": {
    "id": "report-1",
    "currentVersionId": "rversion-1",
    "versions": [
      {
        "id": "rversion-1",
        "versionNum": 1,
        "status": "FINALIZED",
        "finalizedAt": "2025-12-20T11:00:00Z"
      }
    ]
  },
  "currentResults": [
    {
      "testOrderId": "to-1",
      "testName": "CBC",
      "value": 8.5,
      "referenceMin": 4.5,
      "referenceMax": 11,
      "flag": "NORMAL"
    }
  ]
}
```

---

### POST `/visits/diagnostic/{visitId}/results`
Enter test results (bulk).

**Request:**
```json
{
  "results": [
    {
      "testOrderId": "to-1",
      "value": 8.5,
      "flag": "NORMAL"
    },
    {
      "testOrderId": "to-2",
      "value": 2.1,
      "flag": "NORMAL"
    }
  ]
}
```

**Response (201):**
```json
{
  "testResults": [ ... ]
}
```

**Backend Enforcement:**
- Cannot update finalized results
- Value must be numeric or null
- Flag must be NORMAL | HIGH | LOW | null

---

### POST `/visits/diagnostic/{visitId}/finalize-report`
Finalize report (immutable after this).

**Request:**
```json
{
  "reason": "All tests completed and reviewed"
}
```

**Response (200):**
```json
{
  "report": {
    "id": "report-1",
    "status": "FINALIZED",
    "finalizedAt": "2025-12-20T11:30:00Z"
  }
}
```

**Backend Enforcement:**
- All test results must exist
- Report becomes immutable
- Audit log: Report finalization
- Trigger PDF generation + WhatsApp send

---

## 🏥 Clinic Visits

### POST `/visits/clinic`
Create clinic visit.

**Request:**
```json
{
  "patientId": "pat-1",
  "doctorId": "clinic-doc-1",
  "visitType": "OP",
  "hospitalWard": null,
  "consultationFeeInPaise": 50000,
  "paymentType": "CASH",
  "paymentStatus": "PAID"
}
```

**Response (201):**
```json
{
  "visit": {
    "id": "visit-3",
    "branchId": "branch-1",
    "billNumber": "C-MPR-20341",
    "domain": "CLINIC",
    "totalAmountInPaise": 50000,
    "paymentType": "CASH",
    "status": "WAITING"
  },
  "clinicVisit": {
    "id": "clinic-visit-1",
    "doctorId": "clinic-doc-1",
    "visitType": "OP",
    "consultationFeeInPaise": 50000,
    "status": "WAITING"
  },
  "bill": {
    "id": "bill-2",
    "billNumber": "C-MPR-20341",
    "totalAmountInPaise": 50000
  }
}
```

**Backend Enforcement:**
- `doctorId` must exist and be active
- `branchId` from staff's active branch
- `visitType` OP | IP required
- If IP, `hospitalWard` should be populated
- `billNumber` auto-generated
- Audit log: Visit creation

---

### GET `/visits/clinic/queue`
Clinic queue (branch-scoped).

**Query Params:**
- `visitType` (OP | IP | null for all)
- `status` (WAITING | IN_PROGRESS | COMPLETED | null)
- `doctorId` (optional)

**Response (200):**
```json
{
  "queue": [
    {
      "visitId": "visit-3",
      "patientName": "John Doe",
      "visitType": "OP",
      "doctorId": "clinic-doc-1",
      "doctorName": "Dr. Meera Sharma",
      "status": "WAITING",
      "billNumber": "C-MPR-20341",
      "createdAt": "2025-12-20T10:00:00Z"
    }
  ]
}
```

**Backend Enforcement:**
- Only show clinic visits for active branch
- Doctor cannot see queue

---

### PATCH `/visits/clinic/{visitId}/status`
Update visit status.

**Request:**
```json
{
  "status": "IN_PROGRESS"
}
```

**Response (200):**
```json
{
  "clinicVisit": { ... }
}
```

**Allowed Transitions:**
- WAITING → IN_PROGRESS
- IN_PROGRESS → COMPLETED
- Any → (no reversal)

---

### GET `/visits/clinic/{visitId}`
Retrieve clinic visit + patient + doctor details.

**Response (200):**
```json
{
  "visit": { ... },
  "patient": { ... },
  "clinicVisit": {
    "id": "clinic-visit-1",
    "doctorId": "clinic-doc-1",
    "visitType": "OP",
    "consultationFeeInPaise": 50000,
    "status": "IN_PROGRESS"
  },
  "clinicDoctor": {
    "id": "clinic-doc-1",
    "name": "Dr. Meera Sharma",
    "qualification": "MBBS, MD (Gen Med)",
    "specialty": "General Medicine",
    "registrationNumber": "TSMC/GM/2020/1234",
    "letterheadNote": "Compassionate primary care"
  }
}
```

---

## 💼 Billing & Payout

### GET `/billing/bill/{billNumber}`
Retrieve bill (auto-detects branch).

**Query Params:**
- `billNumber` (e.g., "D-MPR-10231" or "C-KPY-20342")

**Response (200):**
```json
{
  "bill": {
    "id": "bill-1",
    "billNumber": "D-MPR-10231",
    "branchId": "branch-1",
    "branchName": "Madhapur",
    "totalAmountInPaise": 80000,
    "paymentStatus": "PAID",
    "domain": "DIAGNOSTICS"
  }
}
```

**Backend Enforcement:**
- Searches globally for bill
- Auto-switches user to owning branch (owner only)

---

### GET `/payout/doctor/{referralDoctorId}`
Get payout history for referral doctor (owner only).

**Query Params:**
- `periodStartDate` (YYYY-MM-DD)
- `periodEndDate` (YYYY-MM-DD)
- `branchId` (optional)

**Response (200):**
```json
{
  "referralDoctor": {
    "id": "ref-doc-1",
    "name": "Dr. Sharma"
  },
  "ledger": [
    {
      "id": "ledger-1",
      "branchId": "branch-1",
      "periodStartDate": "2025-12-01",
      "periodEndDate": "2025-12-31",
      "derivedAmountInPaise": 250000,
      "derivedAt": "2025-12-31T23:59:59Z",
      "reviewedAt": "2026-01-01T10:00:00Z",
      "paidAt": "2026-01-02T14:30:00Z",
      "paymentReferenceId": "CHQ-12345"
    }
  ]
}
```

---

### POST `/payout/derive`
(Owner only) Derive payout for period + doctor.

**Request:**
```json
{
  "referralDoctorId": "ref-doc-1",
  "branchId": "branch-1",
  "periodStartDate": "2025-12-01",
  "periodEndDate": "2025-12-31"
}
```

**Response (201):**
```json
{
  "ledgerEntry": {
    "id": "ledger-1",
    "referralDoctorId": "ref-doc-1",
    "branchId": "branch-1",
    "derivedAmountInPaise": 250000,
    "derivedAt": "2026-01-01T10:00:00Z"
  }
}
```

**Backend Logic:**
- Query all finalized diagnostic visits + clinic visits for doctor in branch + period
- Sum (bill amount × referral commission %) for each test order
- For clinic visits: sum consultation fees
- Store as ledger entry (immutable)
- Audit log: Payout derivation

---

### POST `/payout/mark-paid`
(Owner only) Mark payout ledger as paid.

**Request:**
```json
{
  "ledgerId": "ledger-1",
  "paymentReferenceId": "CHQ-12345",
  "notes": "Cheque deposited successfully"
}
```

**Response (200):**
```json
{
  "ledgerEntry": {
    "id": "ledger-1",
    "paidAt": "2026-01-02T14:30:00Z",
    "paymentReferenceId": "CHQ-12345"
  }
}
```

**Backend Enforcement:**
- Once marked paid, cannot edit
- Audit log: Payout payment

---

## 📄 Printing / Delivery

### GET `/print/diagnostic-bill/{visitId}`
Generate diagnostic bill (ready for print).

**Response (200):**
```json
{
  "html": "<div>...HTML bill content...</div>",
  "pageTitle": "Diagnostic Bill - D-MPR-10231"
}
```

---

### GET `/print/clinic-prescription/{visitId}`
Generate clinic prescription + OP bill (letterhead).

**Response (200):**
```json
{
  "html": "<div>...HTML prescription + bill...</div>",
  "pageTitle": "Prescription - C-MPR-20341"
}
```

---

### POST `/delivery/send-report-whatsapp`
(Async) Send finalized diagnostic report via WhatsApp.

**Request:**
```json
{
  "reportVersionId": "rversion-1",
  "patientPhone": "9876543210"
}
```

**Response (202 Accepted):**
```json
{
  "message": "Report delivery queued",
  "jobId": "job-abc123"
}
```

---

## ❌ Common Error Responses

### 400 Bad Request
```json
{
  "error": "INVALID_REQUEST",
  "message": "Field 'commissionPercent' must be between 0 and 100",
  "details": {
    "field": "commissionPercent",
    "reason": "out_of_range"
  }
}
```

### 401 Unauthorized
```json
{
  "error": "UNAUTHORIZED",
  "message": "Token expired or invalid"
}
```

### 403 Forbidden
```json
{
  "error": "FORBIDDEN",
  "message": "Staff cannot access payout data"
}
```

### 404 Not Found
```json
{
  "error": "NOT_FOUND",
  "message": "Clinic doctor not found"
}
```

### 409 Conflict
```json
{
  "error": "CONFLICT",
  "message": "Cannot finalize report: test results incomplete"
}
```

### 500 Internal Server Error
```json
{
  "error": "INTERNAL_ERROR",
  "message": "An unexpected error occurred"
}
```

---

## 🔒 Backend Enforcement Checklist

Before declaring API ready, ensure:

- [ ] All queries branch-filtered in middleware
- [ ] Doctor access only via referral linkage
- [ ] Visit required before test/report creation
- [ ] Finalized report immutable
- [ ] Payout fully derived (never manual input)
- [ ] Bill lookup auto-switches branch
- [ ] Audit logs on all critical actions
- [ ] Referral commission % validated 0–100
- [ ] Phone validated 10 digits
- [ ] Price > 0
- [ ] Staff cannot access owner/payout screens
- [ ] Doctor cannot access queues/master data
- [ ] Cross-branch access rejected

---

## 📚 Next Steps for Backend Team

1. Set up Prisma with PostgreSQL
2. Generate client from schema
3. Build middleware: auth, branch context, RBAC
4. Implement each endpoint per contract
5. Add payout derivation logic
6. Integrate WhatsApp Business API for report delivery
7. Add audit logging on all critical writes
8. Test cross-branch isolation
9. Test doctor access restrictions
10. Deploy and provide frontend team with live API URL
