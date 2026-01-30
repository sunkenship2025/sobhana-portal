# E3-03 Manual Testing Guide
## Test Order Creation per Visit

**Date:** January 30, 2026  
**Feature:** Attach ordered lab tests to diagnostic visit  
**Server URL:** http://localhost:3000

---

## Prerequisites

✅ Backend server is running (`npm start` or `npx ts-node src/index.ts`)  
✅ Database is seeded with test data  
✅ You have these credentials ready:
- **Email:** staff@sobhana.com
- **Password:** password123

---

## Test Case 1: Tests Attached Only Via Visit

**Objective:** Verify that tests can ONLY be attached through visit endpoints, not directly

### Steps:

1. **Login to the system**
   - Open your API client (Postman/Insomnia/Thunder Client)
   - POST to `http://localhost:3000/api/auth/login`
   - Body:
     ```json
     {
       "email": "staff@sobhana.com",
       "password": "password123"
     }
     ```
   - **Expected Result:** 
     - Status: `200 OK`
     - Response contains `token` and `user` object
     - Copy the `token` for next requests
     - Note the `user.activeBranch.id` (you'll need this for X-Branch-Id header)

2. **Get available lab tests**
   - GET to `http://localhost:3000/api/lab-tests`
   - Headers:
     ```
     Authorization: Bearer {your-token}
     X-Branch-Id: {branch-id-from-login}
     ```
   - **Expected Result:**
     - Status: `200 OK`
     - List of lab tests with `id`, `name`, `code`, `priceInPaise`
     - Note down 2-3 test IDs for creating visits

3. **Create a patient (or use existing)**
   - POST to `http://localhost:3000/api/patients`
   - Headers: Authorization + X-Branch-Id
   - Body:
     ```json
     {
       "name": "Test Patient E3-03",
       "age": 35,
       "gender": "M",
       "identifiers": [
         {
           "type": "PHONE",
           "value": "9999988888",
           "isPrimary": true
         }
       ]
     }
     ```
   - **Expected Result:**
     - Status: `201 Created`
     - Response contains patient `id` and `patientNumber`
     - Note the patient `id`

4. **Create a diagnostic visit WITH tests**
   - POST to `http://localhost:3000/api/visits/diagnostic`
   - Headers: Authorization + X-Branch-Id
   - Body:
     ```json
     {
       "patientId": "{patient-id-from-step-3}",
       "testIds": ["{test-id-1}"],
       "paymentType": "CASH",
       "paymentStatus": "PAID"
     }
     ```
   - **Expected Result:**
     - Status: `201 Created`
     - Response contains visit `id`, `billNumber`, `totalAmount`
     - Note the visit `id`

5. **Verify test is attached to visit**
   - GET to `http://localhost:3000/api/visits/diagnostic/{visit-id}`
   - Headers: Authorization + X-Branch-Id
   - **Expected Result:**
     - Status: `200 OK`
     - Response has `testOrders` array with 1 test
     - Each test order has: `testName`, `testCode`, `price`, `referenceRange`

6. **Add MORE tests to existing visit**
   - POST to `http://localhost:3000/api/visits/diagnostic/{visit-id}/tests`
   - Headers: Authorization + X-Branch-Id
   - Body:
     ```json
     {
       "testIds": ["{test-id-2}"]
     }
     ```
   - **Expected Result:**
     - Status: `201 Created`
     - Response shows `addedCount: 1`
     - `newTotal` reflects updated bill amount
     - `testOrders` array shows newly added test(s)

7. **Verify updated visit has 2 tests**
   - GET to `http://localhost:3000/api/visits/diagnostic/{visit-id}`
   - **Expected Result:**
     - `testOrders` array now has 2 tests
     - `totalAmount` is sum of both test prices

8. **❌ Try to add duplicate test (SHOULD FAIL)**
   - POST to `http://localhost:3000/api/visits/diagnostic/{visit-id}/tests`
   - Body:
     ```json
     {
       "testIds": ["{test-id-1}"]
     }
     ```
   - **Expected Result:**
     - Status: `400 Bad Request`
     - Error code: `DUPLICATE_TESTS`
     - Message: "Some tests are already ordered for this visit"
     - Response includes `duplicateTestIds` array

✅ **Test Case 1 PASS Criteria:** 
- Tests can only be created via visit endpoints
- No direct TestOrder creation API exists
- Adding tests updates bill total correctly

---

## Test Case 2: Cannot Add Tests After Report Finalization

**Objective:** Verify that once a report is finalized, no tests can be added or removed

### Steps:

1. **Get the visit from Test Case 1**
   - GET to `http://localhost:3000/api/visits/diagnostic/{visit-id}`
   - Verify it has 2 test orders

2. **Save test results for all tests**
   - POST to `http://localhost:3000/api/visits/diagnostic/{visit-id}/results`
   - Headers: Authorization + X-Branch-Id
   - Body:
     ```json
     {
       "results": [
         {
           "testId": "{test-id-1}",
           "value": 100,
           "flag": "NORMAL"
         },
         {
           "testId": "{test-id-2}",
           "value": 85,
           "flag": "NORMAL"
         }
       ]
     }
     ```
   - **Expected Result:**
     - Status: `200 OK` or `201 Created`
     - Results saved successfully

3. **Finalize the report**
   - POST to `http://localhost:3000/api/visits/diagnostic/{visit-id}/finalize`
   - Headers: Authorization + X-Branch-Id
   - **Expected Result:**
     - Status: `200 OK`
     - Report status changes to `FINALIZED`
     - `finalizedAt` timestamp is set

4. **❌ Try to ADD test after finalization (SHOULD FAIL)**
   - POST to `http://localhost:3000/api/visits/diagnostic/{visit-id}/tests`
   - Body:
     ```json
     {
       "testIds": ["{test-id-3}"]
     }
     ```
   - **Expected Result:**
     - Status: `400 Bad Request`
     - Error code: `REPORT_FINALIZED`
     - Message: "Cannot add tests after report has been finalized"

5. **❌ Try to REMOVE test after finalization (SHOULD FAIL)**
   - First, get a test order ID from the visit
   - DELETE to `http://localhost:3000/api/visits/diagnostic/{visit-id}/tests/{test-order-id}`
   - Headers: Authorization + X-Branch-Id
   - **Expected Result:**
     - Status: `400 Bad Request`
     - Error code: `REPORT_FINALIZED`
     - Message: "Cannot remove tests after report has been finalized"

6. **Verify visit remains unchanged**
   - GET to `http://localhost:3000/api/visits/diagnostic/{visit-id}`
   - **Expected Result:**
     - Still has 2 test orders (no changes)
     - Total amount unchanged
     - Report status is `FINALIZED`

✅ **Test Case 2 PASS Criteria:**
- Cannot add tests after report is finalized
- Cannot remove tests after report is finalized
- Visit data remains immutable after finalization

---

## Test Case 3: Test Metadata Snapshotted

**Objective:** Verify that test metadata (name, code, price, reference range) is captured at order time

### Steps:

1. **Create a NEW diagnostic visit**
   - POST to `http://localhost:3000/api/visits/diagnostic`
   - Body:
     ```json
     {
       "patientId": "{patient-id}",
       "testIds": ["{test-id-1}"],
       "paymentType": "CASH",
       "paymentStatus": "PAID"
     }
     ```
   - Note the new visit `id`

2. **Get the visit details**
   - GET to `http://localhost:3000/api/visits/diagnostic/{new-visit-id}`
   - **Expected Result:**
     - Status: `200 OK`
     - Response has `testOrders` array

3. **Inspect test order metadata**
   - Check each test order in `testOrders` array
   - **Expected Fields:**
     ```json
     {
       "id": "...",
       "visitId": "...",
       "testId": "...",
       "testName": "Complete Blood Count",    // ✓ Snapshotted
       "testCode": "CBC",                     // ✓ Snapshotted
       "price": 500,                          // ✓ Snapshotted (in rupees)
       "referenceRange": {                    // ✓ Snapshotted
         "min": 4.5,
         "max": 11.0,
         "unit": "cells/mcL"
       }
     }
     ```

4. **Verify snapshot vs live data (Database Check)**
   - Open your database client (pgAdmin/DBeaver/Prisma Studio)
   - Run this query:
     ```sql
     SELECT 
       id, 
       "visitId",
       "testId",
       "testNameSnapshot",
       "testCodeSnapshot",
       "priceInPaise",
       "referenceMinSnapshot",
       "referenceMaxSnapshot",
       "referenceUnitSnapshot"
     FROM "TestOrder"
     WHERE "visitId" = '{your-visit-id}'
     ORDER BY "createdAt" DESC
     LIMIT 5;
     ```
   - **Expected Result:**
     - All snapshot columns are populated (NOT NULL for required fields)
     - `testNameSnapshot` matches test name at creation time
     - `testCodeSnapshot` matches test code at creation time
     - `priceInPaise` is stored in paise (multiply price by 100)
     - Reference range fields are populated

5. **Add another test to the visit**
   - POST to `http://localhost:3000/api/visits/diagnostic/{new-visit-id}/tests`
   - Body:
     ```json
     {
       "testIds": ["{test-id-2}"]
     }
     ```

6. **Verify BOTH test orders have snapshots**
   - GET to `http://localhost:3000/api/visits/diagnostic/{new-visit-id}`
   - **Expected Result:**
     - Both test orders in response have complete metadata
     - All fields are present: `testName`, `testCode`, `price`, `referenceRange`

7. **Simulate metadata change (Optional - Advanced)**
   - Update a lab test in the database:
     ```sql
     UPDATE "LabTest"
     SET "name" = 'Updated Test Name',
         "priceInPaise" = 99900
     WHERE id = '{test-id-1}';
     ```
   - GET the visit again
   - **Expected Result:**
     - Visit test order STILL shows original name and price
     - Snapshot is independent of master catalog
     - Visit data is immutable

✅ **Test Case 3 PASS Criteria:**
- Test name is snapshotted at order time
- Test code is snapshotted at order time
- Test price is snapshotted at order time
- Reference range (min, max, unit) is snapshotted at order time
- Changes to master LabTest catalog don't affect existing orders

---

## Additional Edge Case Tests

### Edge Test 1: Cannot Remove Last Test

1. **Create a visit with only ONE test**
   - POST to `http://localhost:3000/api/visits/diagnostic`
   - Include only 1 test in `testIds`

2. **Try to remove that test**
   - DELETE to `http://localhost:3000/api/visits/diagnostic/{visit-id}/tests/{test-order-id}`
   - **Expected Result:**
     - Status: `400 Bad Request`
     - Error: `VALIDATION_ERROR`
     - Message: "Cannot remove the last test from a visit"

### Edge Test 2: Empty Test IDs

1. **Try to create visit with empty testIds**
   - POST to `http://localhost:3000/api/visits/diagnostic`
   - Body has `testIds: []`
   - **Expected Result:**
     - Status: `400 Bad Request`
     - Error: `VALIDATION_ERROR`

2. **Try to add empty testIds to existing visit**
   - POST to `http://localhost:3000/api/visits/diagnostic/{visit-id}/tests`
   - Body: `{"testIds": []}`
   - **Expected Result:**
     - Status: `400 Bad Request`
     - Error: `VALIDATION_ERROR`
     - Message: "At least one test ID is required"

### Edge Test 3: Invalid Test IDs

1. **Try to add non-existent test**
   - POST to `http://localhost:3000/api/visits/diagnostic/{visit-id}/tests`
   - Body:
     ```json
     {
       "testIds": ["invalid-test-id-12345"]
     }
     ```
   - **Expected Result:**
     - Status: `400 Bad Request`
     - Error: `VALIDATION_ERROR`
     - Message: "One or more tests not found or inactive"

### Edge Test 4: Bill Total Synchronization

1. **Create visit with 1 test (₹500)**
   - Note the `totalAmount`

2. **Add another test (₹450)**
   - POST to add test
   - **Expected Result:**
     - Response shows `newTotal: 950` (₹950)

3. **Verify in database**
   - Check both `Visit.totalAmountInPaise` and `Bill.totalAmountInPaise`
   - Both should be `95000` (950 × 100)

4. **Remove the second test**
   - DELETE the test order
   - **Expected Result:**
     - Response shows `newTotal: 500`
     - Database values back to `50000`

---

## Summary Checklist

Use this checklist to track your manual testing:

### Acceptance Criteria

- [ ] **AC1:** Tests attached only via visit
  - [ ] Can create visit with tests
  - [ ] Can add tests via POST /:id/tests
  - [ ] Cannot add duplicate tests
  - [ ] No direct TestOrder creation API exists

- [ ] **AC2:** Cannot add tests after report finalization
  - [ ] Can finalize report with results
  - [ ] Cannot add tests after finalization
  - [ ] Cannot remove tests after finalization
  - [ ] Error messages are clear

- [ ] **AC3:** Test metadata snapshotted
  - [ ] testName is captured
  - [ ] testCode is captured
  - [ ] price is captured
  - [ ] referenceRange (min, max, unit) is captured
  - [ ] Snapshot is independent of master catalog

### Edge Cases

- [ ] Cannot remove last test from visit
- [ ] Empty testIds array rejected
- [ ] Invalid test IDs rejected
- [ ] Bill total updates correctly on add
- [ ] Bill total updates correctly on remove

---

## Troubleshooting

**Issue:** 401 Unauthorized  
**Solution:** Check your Authorization header has correct token format: `Bearer {token}`

**Issue:** 403 Forbidden  
**Solution:** Ensure X-Branch-Id header is set with correct branch ID

**Issue:** Cannot find visit  
**Solution:** Verify you're using the correct visit ID and the visit belongs to your active branch

**Issue:** Tests show null metadata  
**Solution:** This indicates old data before migration. Create a new visit to see snapshots.

---

## Database Verification Queries

### Check Test Order Snapshots
```sql
SELECT 
  to.id,
  to."visitId",
  v."billNumber",
  to."testNameSnapshot",
  to."testCodeSnapshot",
  to."priceInPaise",
  to."referenceMinSnapshot",
  to."referenceMaxSnapshot",
  to."referenceUnitSnapshot",
  lt.name AS "currentTestName",
  lt.code AS "currentTestCode",
  lt."priceInPaise" AS "currentPrice"
FROM "TestOrder" to
JOIN "Visit" v ON to."visitId" = v.id
JOIN "LabTest" lt ON to."testId" = lt.id
WHERE v."billNumber" = 'D-MPR-XXXXX'  -- Replace with your bill number
ORDER BY to."createdAt";
```

### Check Finalized Reports
```sql
SELECT 
  v."billNumber",
  rv.status,
  rv."finalizedAt",
  COUNT(to.id) AS "testCount"
FROM "Visit" v
JOIN "DiagnosticReport" dr ON v.id = dr."visitId"
JOIN "ReportVersion" rv ON dr.id = rv."reportId"
LEFT JOIN "TestOrder" to ON v.id = to."visitId"
WHERE rv.status = 'FINALIZED'
GROUP BY v."billNumber", rv.status, rv."finalizedAt"
ORDER BY rv."finalizedAt" DESC
LIMIT 10;
```

---

**Good luck with your testing!** 🧪

If all tests pass, the implementation is production-ready. 🚀
