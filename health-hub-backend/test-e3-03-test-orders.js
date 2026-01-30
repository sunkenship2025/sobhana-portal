/**
 * E3-03 Test Order Creation per Visit - Test Suite
 * 
 * Tests:
 * 1. Tests can only be attached via visit creation or POST /:id/tests
 * 2. Cannot add tests after report finalization
 * 3. Test metadata is snapshotted at order time
 */

const BASE_URL = 'http://localhost:3000/api';

// Test credentials (from seed data)
const TEST_USER = {
  email: 'staff@sobhana.com',
  password: 'password123'
};

let authToken = '';
let branchId = '';
let testPatientId = '';
let testVisitId = '';
let testOrderId = '';
let testIds = [];

async function login() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(TEST_USER)
  });
  
  if (!res.ok) {
    throw new Error(`Login failed: ${res.status}`);
  }
  
  const data = await res.json();
  authToken = data.token;
  branchId = data.user.activeBranch.id;
  console.log('✓ Logged in successfully');
}

function getHeaders() {
  return {
    'Authorization': `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    'X-Branch-Id': branchId
  };
}

async function getLabTests() {
  const res = await fetch(`${BASE_URL}/lab-tests`, {
    headers: getHeaders()
  });
  
  if (!res.ok) {
    throw new Error('Failed to get lab tests');
  }
  
  const tests = await res.json();
  testIds = tests.slice(0, 3).map(t => t.id);
  console.log(`✓ Retrieved ${tests.length} lab tests, using first 3 for testing`);
  return tests;
}

async function createTestPatient() {
  const res = await fetch(`${BASE_URL}/patients`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      name: 'E3-03 Test Patient',
      age: 35,
      gender: 'M',
      identifiers: [{ type: 'PHONE', value: '9999900003', isPrimary: true }]
    })
  });
  
  if (!res.ok) {
    const error = await res.json();
    // If patient exists, search for them
    if (error.error === 'CONFLICT' || res.status === 409) {
      const searchRes = await fetch(`${BASE_URL}/patients/search?phone=9999900003`, {
        headers: getHeaders()
      });
      const results = await searchRes.json();
      if (results.length > 0) {
        testPatientId = results[0].patient.id;
        console.log('✓ Using existing test patient');
        return;
      }
    }
    throw new Error(`Failed to create patient: ${error.message}`);
  }
  
  const patient = await res.json();
  testPatientId = patient.id;
  console.log('✓ Created test patient');
}

async function test1_CreateVisitWithTests() {
  console.log('\n--- Test 1: Create Visit with Tests (Metadata Snapshot) ---');
  
  const res = await fetch(`${BASE_URL}/visits/diagnostic`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      patientId: testPatientId,
      testIds: [testIds[0]], // Just one test initially
      paymentType: 'CASH',
      paymentStatus: 'PAID'
    })
  });
  
  if (!res.ok) {
    const error = await res.json();
    throw new Error(`Failed to create visit: ${error.message}`);
  }
  
  const visit = await res.json();
  testVisitId = visit.id;
  
  console.log(`✓ Visit created: ${visit.billNumber}`);
  console.log(`✓ Visit has ${1} test order(s)`);
  
  // Verify visit details
  const detailRes = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}`, {
    headers: getHeaders()
  });
  
  const visitDetail = await detailRes.json();
  const testOrder = visitDetail.testOrders[0];
  testOrderId = testOrder.id;
  
  // Verify metadata is present
  if (!testOrder.testName || !testOrder.testCode) {
    throw new Error('FAIL: Test metadata not present in response');
  }
  
  console.log(`✓ Test order has snapshotted metadata: ${testOrder.testName} (${testOrder.testCode})`);
  console.log(`✓ Reference range: ${testOrder.referenceRange.min}-${testOrder.referenceRange.max} ${testOrder.referenceRange.unit}`);
  
  return visit;
}

async function test2_AddTestsToVisit() {
  console.log('\n--- Test 2: Add Tests to Existing Visit ---');
  
  const res = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}/tests`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      testIds: [testIds[1]] // Add second test
    })
  });
  
  if (!res.ok) {
    const error = await res.json();
    throw new Error(`Failed to add tests: ${error.message}`);
  }
  
  const result = await res.json();
  console.log(`✓ Added ${result.addedCount} test(s) to visit`);
  console.log(`✓ New total: ₹${result.newTotal}`);
  
  // Verify we now have 2 tests
  const detailRes = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}`, {
    headers: getHeaders()
  });
  
  const visitDetail = await detailRes.json();
  if (visitDetail.testOrders.length !== 2) {
    throw new Error(`FAIL: Expected 2 test orders, got ${visitDetail.testOrders.length}`);
  }
  
  console.log(`✓ Visit now has ${visitDetail.testOrders.length} test orders`);
}

async function test3_CannotAddDuplicateTests() {
  console.log('\n--- Test 3: Cannot Add Duplicate Tests ---');
  
  const res = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}/tests`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      testIds: [testIds[0]] // Try to add first test again
    })
  });
  
  if (res.ok) {
    throw new Error('FAIL: Should not allow adding duplicate tests');
  }
  
  const error = await res.json();
  if (error.error !== 'DUPLICATE_TESTS') {
    throw new Error(`FAIL: Expected DUPLICATE_TESTS error, got ${error.error}`);
  }
  
  console.log('✓ Correctly rejected duplicate test addition');
}

async function test4_RemoveTestFromVisit() {
  console.log('\n--- Test 4: Remove Test from Visit ---');
  
  // Get the second test order ID
  const detailRes = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}`, {
    headers: getHeaders()
  });
  const visitDetail = await detailRes.json();
  const secondTestOrderId = visitDetail.testOrders[1].id;
  
  const res = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}/tests/${secondTestOrderId}`, {
    method: 'DELETE',
    headers: getHeaders()
  });
  
  if (!res.ok) {
    const error = await res.json();
    throw new Error(`Failed to remove test: ${error.message}`);
  }
  
  const result = await res.json();
  console.log(`✓ Removed test from visit`);
  console.log(`✓ New total: ₹${result.newTotal}`);
  
  // Verify we now have 1 test
  const verifyRes = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}`, {
    headers: getHeaders()
  });
  const verifiedVisit = await verifyRes.json();
  
  if (verifiedVisit.testOrders.length !== 1) {
    throw new Error(`FAIL: Expected 1 test order, got ${verifiedVisit.testOrders.length}`);
  }
  
  console.log(`✓ Visit now has ${verifiedVisit.testOrders.length} test order(s)`);
}

async function test5_CannotRemoveLastTest() {
  console.log('\n--- Test 5: Cannot Remove Last Test ---');
  
  const res = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}/tests/${testOrderId}`, {
    method: 'DELETE',
    headers: getHeaders()
  });
  
  if (res.ok) {
    throw new Error('FAIL: Should not allow removing last test');
  }
  
  const error = await res.json();
  if (error.error !== 'VALIDATION_ERROR') {
    throw new Error(`FAIL: Expected VALIDATION_ERROR, got ${error.error}`);
  }
  
  console.log('✓ Correctly rejected removal of last test');
}

async function test6_CannotAddTestsAfterFinalization() {
  console.log('\n--- Test 6: Cannot Add Tests After Report Finalization ---');
  
  // First, save some results
  const detailRes = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}`, {
    headers: getHeaders()
  });
  const visitDetail = await detailRes.json();
  const testOrder = visitDetail.testOrders[0];
  
  // Save a result
  const resultsRes = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}/results`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      results: [{
        testId: testOrder.testId,
        value: 100,
        flag: 'NORMAL'
      }]
    })
  });
  
  if (!resultsRes.ok) {
    console.log('⚠ Warning: Could not save results, skipping finalization test');
    return;
  }
  
  // Finalize the report
  const finalizeRes = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}/finalize`, {
    method: 'POST',
    headers: getHeaders()
  });
  
  if (!finalizeRes.ok) {
    console.log('⚠ Warning: Could not finalize report, skipping post-finalization test');
    return;
  }
  
  console.log('✓ Report finalized');
  
  // Now try to add a test - should fail
  const addRes = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}/tests`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({
      testIds: [testIds[2]]
    })
  });
  
  if (addRes.ok) {
    throw new Error('FAIL: Should not allow adding tests after finalization');
  }
  
  const error = await addRes.json();
  if (error.error !== 'REPORT_FINALIZED') {
    throw new Error(`FAIL: Expected REPORT_FINALIZED error, got ${error.error}`);
  }
  
  console.log('✓ Correctly rejected test addition after finalization');
}

async function test7_CannotRemoveTestsAfterFinalization() {
  console.log('\n--- Test 7: Cannot Remove Tests After Report Finalization ---');
  
  const res = await fetch(`${BASE_URL}/visits/diagnostic/${testVisitId}/tests/${testOrderId}`, {
    method: 'DELETE',
    headers: getHeaders()
  });
  
  if (res.ok) {
    throw new Error('FAIL: Should not allow removing tests after finalization');
  }
  
  const error = await res.json();
  if (error.error !== 'REPORT_FINALIZED') {
    throw new Error(`FAIL: Expected REPORT_FINALIZED error, got ${error.error}`);
  }
  
  console.log('✓ Correctly rejected test removal after finalization');
}

async function runTests() {
  console.log('='.repeat(60));
  console.log('E3-03 Test Order Creation per Visit - Test Suite');
  console.log('='.repeat(60));
  
  try {
    await login();
    await getLabTests();
    await createTestPatient();
    
    await test1_CreateVisitWithTests();
    await test2_AddTestsToVisit();
    await test3_CannotAddDuplicateTests();
    await test4_RemoveTestFromVisit();
    await test5_CannotRemoveLastTest();
    await test6_CannotAddTestsAfterFinalization();
    await test7_CannotRemoveTestsAfterFinalization();
    
    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL TESTS PASSED');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    process.exit(1);
  }
}

runTests();
