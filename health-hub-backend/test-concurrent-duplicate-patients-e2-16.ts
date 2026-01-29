/**
 * E2-16: Test concurrent patient creation race condition prevention
 * 
 * Tests that advisory lock prevents duplicate patient records when
 * multiple concurrent requests try to create the same patient.
 */

import { PrismaClient } from '@prisma/client';
import { createPatient } from './src/services/patientService';

const prisma = new PrismaClient();

async function cleanup() {
  console.log('Cleaning up test data...');
  
  // Delete test patients by phone number
  const testPhone = '7777777777';
  const testPatients = await prisma.patient.findMany({
    where: {
      identifiers: {
        some: {
          type: 'PHONE',
          value: testPhone
        }
      }
    },
    include: {
      identifiers: true
    }
  });

  for (const patient of testPatients) {
    // Delete identifiers first (cascade should handle this, but being explicit)
    await prisma.patientIdentifier.deleteMany({
      where: { patientId: patient.id }
    });
    
    // Delete audit logs
    await prisma.auditLog.deleteMany({
      where: { entityId: patient.id }
    });
    
    // Delete patient
    await prisma.patient.delete({
      where: { id: patient.id }
    });
  }
  
  console.log(`Cleaned up ${testPatients.length} test patient(s)\n`);
}

async function testConcurrentDuplicatePrevention() {
  console.log('=== TEST: Concurrent Duplicate Patient Prevention (E2-16) ===\n');
  
  // Get a test branch for audit logs
  const branch = await prisma.branch.findFirst();
  if (!branch) {
    throw new Error('No branches found in database');
  }

  // Test data - all 10 requests trying to create same patient
  const testPatientData = {
    name: 'CONCURRENT TEST PATIENT',
    age: 45,
    gender: 'M' as const,
    address: '123 Race Condition St',
    identifiers: [
      {
        type: 'PHONE' as const,
        value: '7777777777',
        isPrimary: true
      }
    ],
    branchId: branch.id,
    userId: 'test-user-e2-16'
  };

  console.log('Starting 10 concurrent patient creation requests...');
  console.log('Patient details:', {
    name: testPatientData.name,
    phone: testPatientData.identifiers[0].value,
    age: testPatientData.age,
    gender: testPatientData.gender
  });
  console.log('\nExpected behavior: All 10 requests should return the SAME patient ID');
  console.log('(Only 1 patient created, 9 requests return existing)\n');

  const startTime = Date.now();

  // Launch 10 concurrent creation requests
  const promises = Array.from({ length: 10 }, (_, i) =>
    createPatient(testPatientData)
      .then(patient => {
        console.log(`Request ${i + 1}: Returned patient ${patient.patientNumber} (ID: ${patient.id})`);
        return patient;
      })
      .catch(error => {
        console.error(`Request ${i + 1}: ERROR - ${error.message}`);
        throw error;
      })
  );

  const results = await Promise.all(promises);
  const duration = Date.now() - startTime;

  console.log(`\nAll requests completed in ${duration}ms\n`);

  // Verify all returned the same patient ID
  const uniquePatientIds = new Set(results.map(p => p.id));
  const uniquePatientNumbers = new Set(results.map(p => p.patientNumber));

  console.log('=== RESULTS ===');
  console.log(`Unique Patient IDs: ${uniquePatientIds.size}`);
  console.log(`Unique Patient Numbers: ${uniquePatientNumbers.size}`);
  console.log(`Patient IDs: ${Array.from(uniquePatientIds).join(', ')}`);
  console.log(`Patient Numbers: ${Array.from(uniquePatientNumbers).join(', ')}`);

  if (uniquePatientIds.size === 1) {
    console.log('\n✅ SUCCESS: Advisory lock prevented duplicate creation!');
    console.log('   All 10 concurrent requests returned the same patient.');
  } else {
    console.error(`\n❌ FAILURE: Created ${uniquePatientIds.size} patients instead of 1!`);
    console.error('   Race condition still exists - advisory lock not working.');
    throw new Error('Duplicate patients created');
  }

  // Verify database state
  const dbPatients = await prisma.patient.findMany({
    where: {
      identifiers: {
        some: {
          type: 'PHONE',
          value: '7777777777'
        }
      }
    },
    include: {
      identifiers: true
    }
  });

  console.log(`\nDatabase verification: Found ${dbPatients.length} patient(s) with phone 7777777777`);
  
  if (dbPatients.length !== 1) {
    console.error('❌ Database has duplicate patients!');
    throw new Error('Database integrity check failed');
  }
  
  console.log('✅ Database integrity confirmed: Only 1 patient exists\n');
}

async function testDifferentPatientsSamePhone() {
  console.log('=== TEST: Different Family Members with Same Phone ===\n');
  
  const branch = await prisma.branch.findFirst();
  if (!branch) {
    throw new Error('No branches found');
  }

  const sharedPhone = '8888888888';

  // Create first family member
  const parent = await createPatient({
    name: 'PARENT TEST',
    age: 50,
    gender: 'F',
    identifiers: [{ type: 'PHONE', value: sharedPhone, isPrimary: true }],
    branchId: branch.id
  });

  console.log(`Created parent: ${parent.patientNumber}`);

  // Create second family member with same phone but different demographics
  const child = await createPatient({
    name: 'CHILD TEST',
    age: 20,
    gender: 'M',
    identifiers: [{ type: 'PHONE', value: sharedPhone, isPrimary: true }],
    branchId: branch.id
  });

  console.log(`Created child: ${child.patientNumber}`);

  if (parent.id === child.id) {
    console.error('❌ FAILURE: Same patient returned for different family members!');
    throw new Error('Should create separate patients for different people');
  }

  console.log('\n✅ SUCCESS: Different patients created for family members with same phone\n');

  // Cleanup
  await prisma.patient.delete({ where: { id: parent.id } });
  await prisma.patient.delete({ where: { id: child.id } });
}

async function main() {
  try {
    await cleanup();
    await testConcurrentDuplicatePrevention();
    await testDifferentPatientsSamePhone();
    
    console.log('=== ALL TESTS PASSED ===\n');
  } catch (error: any) {
    console.error('\n=== TEST FAILED ===');
    console.error(error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main();
