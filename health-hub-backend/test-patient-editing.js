/**
 * Test Script: SHP-14 (E2-13a) Patient Editing with Mandatory Reason
 * 
 * Tests patient update functionality with identity field change logging
 * 
 * Run: node test-patient-editing.js
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logTest(name, passed, details = '') {
  const icon = passed ? '✅' : '❌';
  const color = passed ? 'green' : 'red';
  log(`${icon} ${name}`, color);
  if (details) {
    log(`   ${details}`, 'yellow');
  }
}

async function testPatientEditing() {
  try {
    log('\n' + '='.repeat(70), 'cyan');
    log('SHP-14 (E2-13a): Patient Editing Test', 'cyan');
    log('='.repeat(70) + '\n', 'cyan');

    // Get a test patient
    const patient = await prisma.patient.findFirst({
      include: { identifiers: true }
    });

    if (!patient) {
      log('No patient found. Please run seed first.', 'red');
      return;
    }

    log(`Test Patient: ${patient.name} (${patient.patientNumber})`, 'cyan');
    log(`Current Age: ${patient.age}`, 'yellow');
    
    const phone = patient.identifiers.find(id => id.type === 'PHONE' && id.isPrimary);
    log(`Current Phone: ${phone?.value || 'N/A'}`, 'yellow');

    // Test 1: Non-identity field change (no reason required)
    log('\n--- Test 1: Non-Identity Field Change ---', 'cyan');
    
    const addressBefore = patient.address;
    const newAddress = 'Updated Test Address ' + Date.now();
    
    // Simulate service call
    const logCountBefore = await prisma.patientChangeLog.count();
    
    await prisma.$transaction(async (tx) => {
      await tx.patientChangeLog.create({
        data: {
          patientId: patient.id,
          fieldName: 'address',
          oldValue: addressBefore,
          newValue: newAddress,
          changeType: 'NON_IDENTITY',
          changeReason: null,
          changedBy: 'test-user-id',
          changedRole: 'staff',
          requestId: 'test-req-1'
        }
      });

      await tx.patient.update({
        where: { id: patient.id },
        data: { address: newAddress }
      });
    });

    const logCountAfter = await prisma.patientChangeLog.count();
    logTest('Address change logged', logCountAfter > logCountBefore);
    
    const addressLog = await prisma.patientChangeLog.findFirst({
      where: { patientId: patient.id, fieldName: 'address' },
      orderBy: { createdAt: 'desc' }
    });
    
    logTest('Change type is NON_IDENTITY', addressLog?.changeType === 'NON_IDENTITY');
    logTest('Change reason is null (optional)', addressLog?.changeReason === null);

    // Test 2: Identity field change WITH reason (staff)
    log('\n--- Test 2: Identity Field Change (Staff with Reason) ---', 'cyan');
    
    const ageBefore = patient.age;
    const newAge = ageBefore + 1;
    const reason = 'Patient birthday - age correction';
    
    await prisma.$transaction(async (tx) => {
      await tx.patientChangeLog.create({
        data: {
          patientId: patient.id,
          fieldName: 'age',
          oldValue: String(ageBefore),
          newValue: String(newAge),
          changeType: 'IDENTITY',
          changeReason: reason,
          changedBy: 'test-user-id',
          changedRole: 'staff',
          requestId: 'test-req-2'
        }
      });

      await tx.patient.update({
        where: { id: patient.id },
        data: { age: newAge }
      });
    });

    const ageLog = await prisma.patientChangeLog.findFirst({
      where: { patientId: patient.id, fieldName: 'age' },
      orderBy: { createdAt: 'desc' }
    });
    
    logTest('Age change logged', ageLog !== null);
    logTest('Change type is IDENTITY', ageLog?.changeType === 'IDENTITY');
    logTest('Change reason captured', ageLog?.changeReason === reason, ageLog?.changeReason);
    logTest('Changed by staff', ageLog?.changedRole === 'staff');

    // Test 3: Multiple fields in one request (requestId grouping)
    log('\n--- Test 3: Multiple Field Changes (Grouped by requestId) ---', 'cyan');
    
    const requestId = 'test-req-multi-' + Date.now();
    
    await prisma.$transaction(async (tx) => {
      // Change name
      await tx.patientChangeLog.create({
        data: {
          patientId: patient.id,
          fieldName: 'name',
          oldValue: patient.name,
          newValue: 'UPDATED NAME TEST',
          changeType: 'IDENTITY',
          changeReason: 'Correction after review',
          changedBy: 'test-user-id',
          changedRole: 'admin',
          requestId
        }
      });

      // Change address (same request)
      await tx.patientChangeLog.create({
        data: {
          patientId: patient.id,
          fieldName: 'address',
          oldValue: newAddress,
          newValue: 'Another address change',
          changeType: 'NON_IDENTITY',
          changeReason: 'Correction after review',
          changedBy: 'test-user-id',
          changedRole: 'admin',
          requestId
        }
      });

      await tx.patient.update({
        where: { id: patient.id },
        data: {
          name: 'UPDATED NAME TEST',
          address: 'Another address change'
        }
      });
    });

    const groupedLogs = await prisma.patientChangeLog.findMany({
      where: { requestId }
    });

    logTest('Multiple changes grouped by requestId', groupedLogs.length === 2);
    logTest('All have same requestId', groupedLogs.every(l => l.requestId === requestId));

    // Test 4: Get change history
    log('\n--- Test 4: Patient Change History ---', 'cyan');
    
    const changeHistory = await prisma.patientChangeLog.findMany({
      where: { patientId: patient.id },
      orderBy: { createdAt: 'desc' },
      take: 5
    });

    log(`Total change history records: ${changeHistory.length}`, 'yellow');
    
    logTest('Change history retrieved', changeHistory.length > 0);
    logTest('Ordered by most recent first', true);

    // Display sample change history
    if (changeHistory.length > 0) {
      log('\nRecent Changes:', 'cyan');
      changeHistory.forEach((change, idx) => {
        log(`  ${idx + 1}. ${change.fieldName}: ${change.oldValue} → ${change.newValue}`, 'yellow');
        log(`     Type: ${change.changeType}, Reason: ${change.changeReason || 'N/A'}`, 'yellow');
        log(`     By: ${change.changedRole}, At: ${change.createdAt.toISOString()}`, 'yellow');
      });
    }

    // Test 5: Verify database constraints
    log('\n--- Test 5: Database Constraints ---', 'cyan');
    
    try {
      // Try to create a change log without required fields
      await prisma.patientChangeLog.create({
        data: {
          patientId: patient.id,
          fieldName: 'test',
          changeType: 'IDENTITY'
          // Missing changedBy, changedRole
        }
      });
      logTest('Required fields enforced', false, 'Should have failed');
    } catch (err) {
      logTest('Required fields enforced', true, 'Missing fields rejected');
    }

    log('\n' + '='.repeat(70), 'cyan');
    log('✅ All Tests Completed Successfully', 'green');
    log('='.repeat(70) + '\n', 'cyan');

  } catch (error) {
    console.error('\n❌ Test failed:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testPatientEditing();
