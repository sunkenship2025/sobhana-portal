/**
 * E3-04 Test: Draft Result Entry - Audit Logging & Concurrent Edit Protection
 * 
 * Tests:
 * 1. Verify results editable only in DRAFT
 * 2. Verify draft replacement (not versioning)
 * 3. Detect missing audit logging
 * 4. Test concurrent edit scenario (expected to fail without protection)
 */

const axios = require('axios');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BASE_URL = 'http://localhost:3000';

let staffToken, branchId, patientId, testId, visitId;

async function login() {
  const response = await axios.post(`${BASE_URL}/api/auth/login`, {
    email: 'staff@sobhana.com',
    password: 'password123'
  });
  return response.data.token;
}

async function setupTestData() {
  console.log('\n=== SETUP: Creating test data ===');
  
  const branch = await prisma.branch.findFirst({ where: { code: 'CNT' } });
  branchId = branch.id;
  console.log(`✓ Using branch: ${branch.name}`);
  
  const patient = await prisma.patient.create({
    data: {
      patientNumber: 'E304-' + Date.now(),
      name: 'E3-04 Test Patient',
      yearOfBirth: 1985,
      gender: 'M',
    }
  });
  patientId = patient.id;
  console.log(`✓ Created patient: ${patient.name}`);
  
  const test = await prisma.labTest.findFirst();
  testId = test.id;
  console.log(`✓ Using test: ${test.name}`);
}

async function testDraftOnlyEditing() {
  console.log('\n=== TEST 1: Results Editable Only in DRAFT ===');
  
  try {
    // Create visit
    console.log('\n1. Creating diagnostic visit...');
    const createResponse = await axios.post(
      `${BASE_URL}/api/visits/diagnostic`,
      { patientId, testIds: [testId], paymentType: 'CASH' },
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    visitId = createResponse.data.id;
    console.log(`✓ Created visit: ${visitId}`);
    
    // Save results (should work - still DRAFT)
    console.log('\n2. Saving results to DRAFT report...');
    const saveResponse = await axios.post(
      `${BASE_URL}/api/visits/diagnostic/${visitId}/results`,
      { results: [{ testId, value: 12.5, flag: 'NORMAL', notes: 'Initial' }] },
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    console.log(`✓ Results saved: ${JSON.stringify(saveResponse.data)}`);
    
    // Finalize report
    console.log('\n3. Finalizing report...');
    await axios.post(
      `${BASE_URL}/api/visits/diagnostic/${visitId}/finalize`,
      {},
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    console.log('✓ Report finalized');
    
    // Try to edit after finalization (should fail)
    console.log('\n4. Attempting to edit finalized report...');
    try {
      await axios.post(
        `${BASE_URL}/api/visits/diagnostic/${visitId}/results`,
        { results: [{ testId, value: 99.9, flag: 'ABNORMAL', notes: 'Hacked!' }] },
        { headers: { Authorization: `Bearer ${staffToken}` } }
      );
      console.log('✗ TEST 1 FAILED: Edit after finalize should be blocked!');
      return false;
    } catch (err) {
      if (err.response?.status === 400 && err.response?.data?.message?.includes('No draft')) {
        console.log('✓ Edit blocked: "No draft report version found"');
        console.log('✅ TEST 1 PASSED: Results editable only in DRAFT');
        return true;
      } else {
        console.log(`✗ Unexpected error: ${err.response?.data?.message}`);
        return false;
      }
    }
  } catch (err) {
    console.error('✗ TEST 1 FAILED:', err.response?.data || err.message);
    return false;
  }
}

async function testDraftReplacement() {
  console.log('\n=== TEST 2: Draft Replacement (Not Versioning) ===');
  
  try {
    // Create new visit
    console.log('\n1. Creating new visit for draft replacement test...');
    const createResponse = await axios.post(
      `${BASE_URL}/api/visits/diagnostic`,
      { patientId, testIds: [testId], paymentType: 'CASH' },
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    const newVisitId = createResponse.data.id;
    console.log(`✓ Created visit: ${newVisitId}`);
    
    // Get initial version count
    const reportBefore = await prisma.diagnosticReport.findFirst({
      where: { visitId: newVisitId },
      include: { versions: true }
    });
    const versionCountBefore = reportBefore.versions.length;
    console.log(`✓ Initial ReportVersion count: ${versionCountBefore}`);
    
    // Save first draft
    console.log('\n2. Saving first draft (value=10.0)...');
    await axios.post(
      `${BASE_URL}/api/visits/diagnostic/${newVisitId}/results`,
      { results: [{ testId, value: 10.0, flag: 'NORMAL' }] },
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    
    const resultAfterFirst = await prisma.testResult.findFirst({
      where: { reportVersionId: reportBefore.versions[0].id }
    });
    console.log(`✓ First draft saved: value=${resultAfterFirst.value}`);
    
    // Update draft (should replace, not create new version)
    console.log('\n3. Updating draft (value=15.0)...');
    await axios.post(
      `${BASE_URL}/api/visits/diagnostic/${newVisitId}/results`,
      { results: [{ testId, value: 15.0, flag: 'ABNORMAL' }] },
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    
    const reportAfter = await prisma.diagnosticReport.findFirst({
      where: { visitId: newVisitId },
      include: { versions: true }
    });
    const versionCountAfter = reportAfter.versions.length;
    
    const resultAfterSecond = await prisma.testResult.findFirst({
      where: { reportVersionId: reportBefore.versions[0].id }
    });
    
    console.log(`✓ Updated draft: value=${resultAfterSecond.value}`);
    console.log(`✓ Version count after update: ${versionCountAfter}`);
    
    if (versionCountBefore === versionCountAfter && resultAfterSecond.value === 15.0) {
      console.log('✅ TEST 2 PASSED: Draft replaced (not versioned)');
      return true;
    } else {
      console.log(`✗ TEST 2 FAILED: Expected ${versionCountBefore} versions, got ${versionCountAfter}`);
      return false;
    }
  } catch (err) {
    console.error('✗ TEST 2 FAILED:', err.response?.data || err.message);
    return false;
  }
}

async function testAuditLogging() {
  console.log('\n=== TEST 3: Audit Logging on Result Save ===');
  
  try {
    // Create new visit
    console.log('\n1. Creating visit for audit test...');
    const createResponse = await axios.post(
      `${BASE_URL}/api/visits/diagnostic`,
      { patientId, testIds: [testId], paymentType: 'CASH' },
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    const auditVisitId = createResponse.data.id;
    console.log(`✓ Created visit: ${auditVisitId}`);
    
    // Count audit logs before
    const auditCountBefore = await prisma.auditLog.count({
      where: { entityId: auditVisitId, actionType: 'UPDATE' }
    });
    console.log(`✓ Audit logs before: ${auditCountBefore}`);
    
    // Save results
    console.log('\n2. Saving results...');
    await axios.post(
      `${BASE_URL}/api/visits/diagnostic/${auditVisitId}/results`,
      { results: [{ testId, value: 20.0, flag: 'NORMAL' }] },
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    console.log('✓ Results saved');
    
    // Check audit logs after
    const auditCountAfter = await prisma.auditLog.count({
      where: { entityId: auditVisitId, actionType: 'UPDATE' }
    });
    console.log(`✓ Audit logs after: ${auditCountAfter}`);
    
    if (auditCountAfter > auditCountBefore) {
      console.log('✅ TEST 3 PASSED: Audit logging exists');
      
      const auditLog = await prisma.auditLog.findFirst({
        where: { entityId: auditVisitId, actionType: 'UPDATE' },
        orderBy: { createdAt: 'desc' }
      });
      
      console.log('\nAudit Log Details:');
      console.log(`  - User ID: ${auditLog.userId}`);
      console.log(`  - User Role: ${auditLog.userRole}`);
      console.log(`  - Action: ${auditLog.actionType}`);
      console.log(`  - Entity: ${auditLog.entityType}`);
      console.log(`  - Old Values: ${auditLog.oldValues}`);
      console.log(`  - New Values: ${auditLog.newValues}`);
      
      return true;
    } else {
      console.log('❌ TEST 3 FAILED: NO AUDIT LOGGING DETECTED');
      console.log('   Expected audit log count to increase, but it did not.');
      console.log('   This violates E3-04 acceptance criteria #4');
      return false;
    }
  } catch (err) {
    console.error('✗ TEST 3 FAILED:', err.response?.data || err.message);
    return false;
  }
}

async function testConcurrentEditProtection() {
  console.log('\n=== TEST 4: Concurrent Edit Protection ===');
  
  try {
    // Create new visit
    console.log('\n1. Creating visit for concurrency test...');
    const createResponse = await axios.post(
      `${BASE_URL}/api/visits/diagnostic`,
      { patientId, testIds: [testId], paymentType: 'CASH' },
      { headers: { Authorization: `Bearer ${staffToken}` } }
    );
    const concurrentVisitId = createResponse.data.id;
    console.log(`✓ Created visit: ${concurrentVisitId}`);
    
    // Simulate two users editing simultaneously
    console.log('\n2. Simulating concurrent edits...');
    console.log('   User A: Saving value=30.0');
    console.log('   User B: Saving value=40.0 (at same time)');
    
    const [resultA, resultB] = await Promise.all([
      axios.post(
        `${BASE_URL}/api/visits/diagnostic/${concurrentVisitId}/results`,
        { results: [{ testId, value: 30.0, flag: 'NORMAL' }] },
        { headers: { Authorization: `Bearer ${staffToken}` } }
      ),
      axios.post(
        `${BASE_URL}/api/visits/diagnostic/${concurrentVisitId}/results`,
        { results: [{ testId, value: 40.0, flag: 'ABNORMAL' }] },
        { headers: { Authorization: `Bearer ${staffToken}` } }
      )
    ]);
    
    console.log(`   User A result: ${resultA.status}`);
    console.log(`   User B result: ${resultB.status}`);
    
    // Check final value
    const report = await prisma.diagnosticReport.findFirst({
      where: { visitId: concurrentVisitId },
      include: { versions: { include: { testResults: true } } }
    });
    const finalValue = report.versions[0].testResults[0].value;
    
    console.log(`\n3. Final value in database: ${finalValue}`);
    
    if (resultA.status === 200 && resultB.status === 200) {
      console.log('❌ TEST 4 FAILED: Both concurrent edits succeeded (no protection)');
      console.log('   Expected: One request should fail with 409 Conflict');
      console.log('   Actual: Both returned 200 OK');
      console.log(`   Result: Last-write-wins (value=${finalValue}), data loss possible`);
      return false;
    } else {
      console.log('✅ TEST 4 PASSED: Concurrent edit protection works');
      return true;
    }
  } catch (err) {
    console.error('✗ TEST 4 FAILED:', err.response?.data || err.message);
    return false;
  }
}

async function main() {
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║       E3-04 Draft Result Entry - Comprehensive Test       ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');
  
  try {
    staffToken = await login();
    console.log('✓ Authenticated as staff');
    
    await setupTestData();
    
    const test1 = await testDraftOnlyEditing();
    const test2 = await testDraftReplacement();
    const test3 = await testAuditLogging();
    const test4 = await testConcurrentEditProtection();
    
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║                      TEST SUMMARY                         ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
    
    console.log(`Test 1 (Draft-only editing):        ${test1 ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Test 2 (Draft replacement):          ${test2 ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Test 3 (Audit logging):              ${test3 ? '✅ PASSED' : '❌ FAILED'}`);
    console.log(`Test 4 (Concurrent edit protection): ${test4 ? '✅ PASSED' : '❌ FAILED'}`);
    
    const passCount = [test1, test2, test3, test4].filter(Boolean).length;
    console.log(`\n${passCount}/4 tests passed`);
    
    if (!test3) {
      console.log('\n🔴 CRITICAL: Audit logging is MISSING');
      console.log('   This violates E3-04 acceptance criteria #4');
      console.log('   Medical records MUST be audited');
    }
    
    if (!test4) {
      console.log('\n⚠️  WARNING: Concurrent edit protection is MISSING');
      console.log('   This violates E3-04 acceptance criteria #3');
      console.log('   Multiple users can overwrite each other\'s changes');
    }
    
    if (passCount < 4) {
      console.log('\n❌ SOME TESTS FAILED - see details above');
      process.exit(1);
    } else {
      console.log('\n✅ ALL TESTS PASSED');
    }
  } catch (err) {
    console.error('\n💥 Test execution error:', err.message);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
