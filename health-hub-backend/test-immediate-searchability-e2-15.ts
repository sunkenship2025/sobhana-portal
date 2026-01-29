/**
 * E2-15: Test immediate patient searchability after creation
 * 
 * Ensures:
 * 1. No stale reads from database
 * 2. Patient is searchable immediately after creation
 * 3. No race conditions between create and search
 */

import { PrismaClient } from '@prisma/client';
import { createPatient, searchPatients } from './src/services/patientService';

const prisma = new PrismaClient();

async function cleanup() {
  console.log('Cleaning up test data...');
  
  const testPhone = '4444444444';
  const testPatients = await prisma.patient.findMany({
    where: {
      identifiers: {
        some: {
          type: 'PHONE',
          value: testPhone
        }
      }
    }
  });

  for (const patient of testPatients) {
    await prisma.auditLog.deleteMany({ where: { entityId: patient.id } });
    await prisma.patient.delete({ where: { id: patient.id } });
  }
  
  console.log(`Cleaned up ${testPatients.length} test patient(s)\n`);
}

async function testImmediateSearchability() {
  console.log('=== TEST: Immediate Patient Searchability (E2-15) ===\n');
  
  const branch = await prisma.branch.findFirst();
  if (!branch) throw new Error('No branches found');

  const testPhone = '4444444444';
  const testData = {
    name: 'IMMEDIATE SEARCH TEST',
    age: 35,
    gender: 'F' as const,
    identifiers: [{ type: 'PHONE' as const, value: testPhone, isPrimary: true }],
    branchId: branch.id
  };

  console.log('Creating patient...');
  const startCreate = Date.now();
  const createdPatient = await createPatient(testData);
  const createDuration = Date.now() - startCreate;
  
  console.log(`✓ Patient created: ${createdPatient.patientNumber} (${createDuration}ms)`);
  console.log(`  ID: ${createdPatient.id}`);

  // CRITICAL: Search IMMEDIATELY after creation - no delay
  console.log('\nSearching by phone IMMEDIATELY (no delay)...');
  const startSearch = Date.now();
  const searchResults = await searchPatients({ phone: testPhone });
  const searchDuration = Date.now() - startSearch;
  
  console.log(`Search completed in ${searchDuration}ms`);
  console.log(`Found ${searchResults.length} patient(s)`);

  if (searchResults.length === 0) {
    console.error('\n❌ FAILURE: Patient NOT found in immediate search!');
    console.error('   This indicates a stale read or visibility issue.');
    throw new Error('E2-15 violation: Patient not immediately searchable');
  }

  const foundPatient = searchResults[0].patient;
  
  if (foundPatient.id !== createdPatient.id) {
    console.error('\n❌ FAILURE: Found different patient!');
    console.error(`   Expected: ${createdPatient.id}`);
    console.error(`   Got: ${foundPatient.id}`);
    throw new Error('E2-15 violation: Wrong patient returned');
  }

  console.log(`\n✅ SUCCESS: Patient immediately searchable!`);
  console.log(`   Created: ${createdPatient.patientNumber}`);
  console.log(`   Found: ${foundPatient.patientNumber}`);
  console.log(`   Total latency: ${createDuration + searchDuration}ms`);
  console.log(`   E2-15 compliance: ✓ No stale reads, immediate visibility\n`);
}

async function testConcurrentCreateAndSearch() {
  console.log('=== TEST: Concurrent Create+Search (Race Condition) ===\n');
  
  const branch = await prisma.branch.findFirst();
  if (!branch) throw new Error('No branches found');

  const testPhone = '4444444444';
  
  console.log('Starting concurrent create+search operations...');
  
  const createPromise = createPatient({
    name: 'CONCURRENT TEST',
    age: 40,
    gender: 'M',
    identifiers: [{ type: 'PHONE', value: testPhone, isPrimary: true }],
    branchId: branch.id,
    forceDuplicate: true
  });

  // Start search very shortly after create starts (simulating rapid frontend requests)
  await new Promise(resolve => setTimeout(resolve, 5)); // 5ms delay
  const searchPromise = searchPatients({ phone: testPhone });

  const [createdPatient, searchResults] = await Promise.all([createPromise, searchPromise]);

  console.log(`Created: ${createdPatient.patientNumber}`);
  console.log(`Search returned: ${searchResults.length} result(s)`);

  // Search should find AT LEAST the newly created patient (or existing ones)
  const foundNew = searchResults.some(r => r.patient.id === createdPatient.id);
  
  if (!foundNew) {
    console.log('⚠️  WARNING: Concurrent search did not find newly created patient');
    console.log('   This is expected if search started before create committed');
    console.log('   But subsequent searches should find it...\n');
    
    // Verify it's searchable now
    const retrySearch = await searchPatients({ phone: testPhone });
    const foundInRetry = retrySearch.some(r => r.patient.id === createdPatient.id);
    
    if (!foundInRetry) {
      console.error('❌ FAILURE: Patient still not found in retry search!');
      throw new Error('E2-15 violation: Patient not searchable even after delay');
    }
    
    console.log('✅ Patient found in retry search - eventual consistency OK\n');
  } else {
    console.log('✅ Patient found in concurrent search - excellent consistency!\n');
  }
}

async function testSearchByName() {
  console.log('=== TEST: Immediate searchability by name ===\n');
  
  const branch = await prisma.branch.findFirst();
  if (!branch) throw new Error('No branches found');

  const testPatient = await createPatient({
    name: 'UNIQUE NAME SEARCHABILITY TEST',
    age: 28,
    gender: 'O',
    identifiers: [{ type: 'PHONE', value: '4444444444', isPrimary: true }],
    branchId: branch.id,
    forceDuplicate: true
  });

  console.log(`Created: ${testPatient.patientNumber}`);

  // Search by name immediately
  const nameSearchResults = await searchPatients({ name: 'UNIQUE NAME SEARCHABILITY' });
  
  console.log(`Name search found ${nameSearchResults.length} result(s)`);
  
  const foundByName = nameSearchResults.some(r => r.patient.id === testPatient.id);
  
  if (!foundByName) {
    console.error('❌ FAILURE: Patient not found by name search immediately!');
    throw new Error('E2-15 violation: Name search not immediate');
  }
  
  console.log('✅ Patient searchable by name immediately\n');
}

async function main() {
  try {
    await cleanup();
    
    await testImmediateSearchability();
    await testConcurrentCreateAndSearch();
    await testSearchByName();
    
    console.log('=== ALL E2-15 TESTS PASSED ===');
    console.log('✓ No stale reads');
    console.log('✓ Immediate visibility');
    console.log('✓ Phone search immediate');
    console.log('✓ Name search immediate');
    console.log('✓ Concurrent operations handled correctly\n');
    
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
