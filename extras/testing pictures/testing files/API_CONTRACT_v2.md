# Sobhana Health Hub — API Contract v2.0 (Architect-Aligned)

## Overview

This is the authoritative REST API specification for Phase-1 backend development.

**Base URL:** `http://localhost:3000/api`

**Authentication:** All endpoints (except `/auth/login`, `/auth/register`) require:
```
Authorization: Bearer {JWT_TOKEN}
Content-Type: application/json
```

---

## 🔐 AUTHENTICATION

### POST `/auth/login`
User login (staff/doctor/owner).

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
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
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
Create new user account.

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

**Backend Enforcement:**
- Role must be: staff | doctor | owner (not admin)
- Phone must be 10 digits
- Email must be unique

---

## 👥 PATIENTS (Global)

### GET `/patients/search`
Search patients globally.

**Query Params:**
- `phone` (optional) – 10-digit phone
- `email` (optional) – Email address
- `name` (optional) – Patient name (partial match)

**Response (200):**
```json
{
  "patients": [
    {
      "id": "pat-1",
      "name": "John Doe",
      "age": 45,
      "gender": "M",
      "identifiers": [
        { "type": "PHONE", "value": "9876543210", "isPrimary": true },
        { "type": "EMAIL", "value": "john@example.com", "isPrimary": false }
      ],
      "visitHistory": [
        {
          "visitId": "visit-1",
          "domain": "DIAGNOSTICS",
          "branchId": "branch-1",
          "branchName": "Madhapur",
          "billNumber": "D-MPR-10231",
          "createdAt": "2025-12-15T10:30:00Z"
        }
      ]
    }
  ]
}
```

---

### POST `/patients`
Create patient.

**Request:**
```json
{
  "name": "Jane Doe",
  "age": 38,
  "gender": "F",
  "address": "123 Main St, City",
  "identifiers": [
    { "type": "PHONE", "value": "9876543211", "isPrimary": true },
    { "type": "EMAIL", "value": "jane@example.com", "isPrimary": false }
  ]
}
```

**Response (201):**
```json
{
  "patient": {
    "id": "pat-2",
    "name": "Jane Doe",
    "age": 38,
    "gender": "F",
    "identifiers": [...]
  }
}
```

**Validation:**
- Name required
- Age ≥ 0
- Gender in: M | F | O
- At least one identifier required

---

### GET `/patients/{patientId}`
Get patient details + visit history.

**Response (200):**
```json
{
  "patient": { ... }
}
```

---

## 🏥 BRANCH MANAGEMENT

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
    }
  ]
}
```

**RBAC:** Owner | Admin only

---

### PATCH `/user/active-branch`
Switch user's active branch.

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

**RBAC:** Forbidden for doctor
**Validation:** Branch must exist and be active

---

## 📋 MASTER DATA

### GET /referral-doctors
List referral doctors (branch context).

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

**RBAC:** Staff | Owner

---

### POST /referral-doctors
Create referral doctor.

**Request:**
```json
{
  "name": "Dr. Sharma",
  "phone": "9876543211",
  "email": "sharma@clinic.com",
  "commissionPercent": 10.0
}
```

**Response (201):** Created doctor object

**Validation:**
- commissionPercent ∈ [0, 100]
- phone 10 digits (if provided)
- Name required

---

### PATCH /referral-doctors/{id}
Update referral doctor.

**Request:**
```json
{
  "commissionPercent": 12.0
}
```

**Response (200):** Updated object

**RBAC:** Staff | Owner

---

### DELETE /referral-doctors/{id}
Soft-delete (isActive = false).

**Response (204):** No content

**RBAC:** Staff | Owner

---

### Similar endpoints for Clinic Doctors and Lab Tests

All follow same pattern:
- `GET /clinic-doctors`
- `POST /clinic-doctors`
- `PATCH /clinic-doctors/{id}`
- `DELETE /clinic-doctors/{id}`
- `GET /lab-tests`
- `POST /lab-tests`
- `PATCH /lab-tests/{id}`
- `DELETE /lab-tests/{id}`

---

## 📊 DIAGNOSTICS VISITS

### POST `/visits/diagnostic`
Create diagnostic visit with tests.

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
    "status": "DRAFT",
    "totalAmountInPaise": 80000,
    "createdAt": "2025-12-20T10:00:00Z"
  },
  "testOrders": [
    {
      "id": "to-1",
      "testId": "test-1",
      "testName": "Complete Blood Count",
      "priceInPaise": 35000,
      "referralCommissionPercentage": 10.0
    }
  ],
  "bill": {
    "id": "bill-1",
    "billNumber": "D-MPR-10231",
    "totalAmountInPaise": 80000
  }
}
```

**Backend Enforcement:**
- billNumber auto-generated: `D-{BRANCH_CODE}-{SEQ}`
- totalAmountInPaise = sum of test prices
- If referralCommissionPercentOverride is null, use referralDoctor.commissionPercent
- Audit log: Visit creation
- Idempotency-Key header (optional but recommended)

---

### GET `/visits/diagnostic`
List diagnostic visits (branch-filtered).

**Query Params:**
- `status` – DRAFT | IN_PROGRESS | COMPLETED
- `referralDoctorId` – Filter by referral doctor
- `limit` – Default 50
- `offset` – Default 0

**Response (200):**
```json
{
  "visits": [
    {
      "id": "visit-1",
      "billNumber": "D-MPR-10231",
      "patientName": "John Doe",
      "status": "DRAFT",
      "totalAmountInPaise": 80000,
      "createdAt": "2025-12-20T10:00:00Z"
    }
  ],
  "total": 15
}
```

**RBAC:** Staff | Owner (doctor cannot call)

---

### GET `/visits/diagnostic/{visitId}`
Get diagnostic visit details.

**Response (200):**
```json
{
  "visit": { ... },
  "patient": { ... },
  "testOrders": [ ... ],
  "report": {
    "id": "report-1",
    "versions": [
      {
        "id": "rversion-1",
        "versionNum": 1,
        "status": "FINALIZED",
        "finalizedAt": "2025-12-20T11:00:00Z"
      }
    ]
  },
  "currentResults": [ ... ]
}
```

**RBAC:** Staff | Owner | Doctor (if referral exists)

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
    }
  ]
}
```

**Response (201):** Created test results

**Validation:**
- value must be numeric or null
- flag must be: NORMAL | HIGH | LOW | null
- Cannot update finalized report (409 Conflict)

---

### POST `/visits/diagnostic/{visitId}/finalize-report`
Finalize diagnostic report (immutable after).

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
- All test results must exist (409 if incomplete)
- Report becomes immutable
- Status = FINALIZED (enum prevents typos)
- Audit log: Report finalization
- Trigger SMS delivery (async via Gupshup)

---

## 🏥 CLINIC VISITS

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
    "status": "WAITING"
  },
  "clinicVisit": {
    "id": "clinic-visit-1",
    "doctorId": "clinic-doc-1",
    "visitType": "OP",
    "status": "WAITING"
  },
  "bill": {
    "billNumber": "C-MPR-20341"
  }
}
```

**Validation:**
- visitType: OP | IP
- If IP, hospitalWard should be populated
- doctorId must exist

---

### GET `/visits/clinic/queue`
Clinic queue (branch-scoped).

**Query Params:**
- `visitType` – OP | IP | null
- `status` – WAITING | IN_PROGRESS | COMPLETED
- `doctorId` – Filter by doctor

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
      "billNumber": "C-MPR-20341"
    }
  ]
}
```

**RBAC:** Doctor cannot call (403 Forbidden)

---

### PATCH `/visits/clinic/{visitId}/status`
Update clinic visit status.

**Request:**
```json
{
  "status": "IN_PROGRESS"
}
```

**Response (200):** Updated clinic visit

**State Transitions (Enforced):**
| From | To | Allowed |
|------|-----|---------|
| WAITING | IN_PROGRESS | ✅ |
| WAITING | CANCELLED | ✅ |
| IN_PROGRESS | COMPLETED | ✅ |
| IN_PROGRESS | CANCELLED | ✅ |
| COMPLETED | CANCELLED | ✅ |
| COMPLETED | WAITING | ❌ (no reversal) |
| COMPLETED | IN_PROGRESS | ❌ (no reversal) |

**Error on violation (409 Conflict):**
```json
{
  "error": "CONFLICT",
  "message": "Cannot transition from COMPLETED to WAITING"
}
```

---

### GET `/visits/clinic/{visitId}`
Get clinic visit details.

**Response (200):**
```json
{
  "visit": { ... },
  "patient": { ... },
  "clinicVisit": { ... },
  "clinicDoctor": { ... }
}
```

---

## 💼 BILLING & PAYOUT

### GET `/billing/bill/{billNumber}`
Retrieve bill (auto-detects branch).

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

---

### GET `/payout/doctor/{referralDoctorId}`
Payout history for referral doctor (owner only).

**Query Params:**
- `periodStartDate` – YYYY-MM-DD
- `periodEndDate` – YYYY-MM-DD
- `branchId` – Optional filter

**Response (200):**
```json
{
  "referralDoctor": { ... },
  "ledger": [
    {
      "id": "ledger-1",
      "branchId": "branch-1",
      "periodStartDate": "2025-12-01",
      "periodEndDate": "2025-12-31",
      "derivedAmountInPaise": 250000,
      "derivedAt": "2025-12-31T23:59:59Z",
      "paidAt": "2026-01-02T14:30:00Z"
    }
  ]
}
```

**RBAC:** Owner only

---

### POST `/payout/derive`
Derive payout (owner only).

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
    "derivedAmountInPaise": 250000,
    "derivedAt": "2026-01-01T10:00:00Z"
  }
}
```

**Backend Logic (PER-TEST DERIVATION):**
```
For each finalized diagnostic visit in branch + period where doctor referred:
  For each test order in visit:
    commission = testOrder.priceInPaise * testOrder.referralCommissionPercentage / 100
  Sum all test commissions
Store as immutable ledger entry
```

**Validation:**
- Cannot derive twice for same period (unique constraint)
- All tests must have results (409 if incomplete)

---

### POST `/payout/mark-paid`
Mark payout as paid (owner only).

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
    "paidAt": "2026-01-02T14:30:00Z"
  }
}
```

**Immutability:** Once paidAt set, cannot update

---

## 📄 PRINTING & SMS DELIVERY

### GET `/print/diagnostic-bill/{visitId}`
Generate diagnostic bill HTML.

**Response (200):**
```json
{
  "html": "<div>...HTML bill...</div>",
  "pageTitle": "Diagnostic Bill - D-MPR-10231"
}
```

---

### GET `/print/clinic-prescription/{visitId}`
Generate clinic prescription + OP bill HTML (with letterhead).

**Response (200):**
```json
{
  "html": "<div>...HTML prescription...</div>",
  "pageTitle": "Prescription - C-MPR-20341"
}
```

---

### POST `/delivery/send-sms-report`
Send finalized diagnostic report via Gupshup SMS (async).

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
  "message": "SMS delivery queued",
  "deliveryId": "sms-abc123"
}
```

**Backend:**
- Async job (don't wait for response)
- Calls Gupshup API
- Stores status in SMSDelivery table
- Supports retries on failure

---

## ❌ ERROR RESPONSES

### 400 Bad Request
```json
{
  "error": "INVALID_REQUEST",
  "message": "Field 'commissionPercent' must be between 0 and 100",
  "details": { "field": "commissionPercent", "reason": "out_of_range" }
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
  "message": "Doctors cannot access this endpoint"
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
  "message": "Cannot transition from COMPLETED to WAITING",
  "reason": "invalid_state_transition"
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

## 🔒 RBAC ENFORCEMENT MATRIX

| Endpoint | Staff | Doctor | Owner | Admin |
|----------|-------|--------|-------|-------|
| GET /branches | ❌ | ❌ | ✅ | ✅ |
| PATCH /user/active-branch | ✅ | ❌ | ✅ | ✅ |
| GET /referral-doctors | ✅ | ❌ | ✅ | ✅ |
| POST /referral-doctors | ✅ | ❌ | ✅ | ✅ |
| GET /visits/diagnostic | ✅ | ❌ | ✅ | ✅ |
| GET /visits/diagnostic/{id} | ✅ | ✅* | ✅ | ✅ |
| GET /visits/clinic/queue | ✅ | ❌ | ✅ | ✅ |
| POST /payout/derive | ❌ | ❌ | ✅ | ✅ |
| POST /payout/mark-paid | ❌ | ❌ | ✅ | ✅ |

*Doctor can see only if referred to visit

---

## 🔐 DATA ENFORCEMENT CHECKLIST

Backend MUST enforce:

- [ ] All queries branch-filtered (branchId from context middleware)
- [ ] Doctor access only via referral (EXISTS check in queries)
- [ ] Visit required before test/report creation
- [ ] Finalized report immutable (ReportStatus.FINALIZED check)
- [ ] Payout fully derived (finalized visit filter)
- [ ] Bill lookup auto-detects branch
- [ ] Audit logs on all critical actions (CREATE, UPDATE, DELETE, FINALIZE, PAYOUT_*)
- [ ] Referral commission % validated 0–100
- [ ] Phone validated 10 digits
- [ ] Price > 0
- [ ] State transitions guarded (409 Conflict on violation)
- [ ] Doctor cannot access master data / queues
- [ ] Cross-branch access rejected
- [ ] SMS delivery async (202 Accepted)

---

**Version:** 2.0 (Architect-Aligned)  
**Last Updated:** January 4, 2026  
**Status:** READY FOR IMPLEMENTATION ✅
