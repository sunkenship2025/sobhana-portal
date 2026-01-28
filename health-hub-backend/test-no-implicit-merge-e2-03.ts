/**
 * E2-03: Test that implicit patient merging is prevented
 * 
 * The system must NEVER auto-merge patient records based on identifier matches.
 * When a potential duplicate is detected, the system should:
 * 1. Throw a ConflictError with details of the existing patient
 * 2. Require explicit user confirmation (forceDuplicate flag) to proceed
 */

import { PrismaClient } from '@prisma/client';
import { createPatient } from './src/services/patientService';

const prisma = new PrismaClient();

async function cleanup() {
  console.log('Cleaning up test data...');
  
  const testPhones = ['6666666666', '5555555555'];
  
  for (const phone of testPhones) {
    const testPatients = await prisma.patient.findMany({
      where: {
        identifiers: {
          some: {
            type: 'PHONE',
            value: phone
          }
        }
      }
    });

    for (const patient of testPatients) {
      await prisma.auditLog.deleteMany({
        where: { entityId: patient.id }
      });
      await prisma.patient.delete({
        where: { id: patient.id }
      });
    }
  }
  
  console.log('Cleanup complete\n');
}

async function testNoDuplicateDetected() {
  console.log('=== TEST 1: No duplicate - should create successfully ===\n');
  
  const branch = await prisma.branch.findFirst();
  if (!branch) throw new Error('No branches found');

  const patient = await createPatient({
    name: 'UNIQUE TEST PATIENT',
    age: 35,
    gender: 'F',
    identifiers: [
      { type: 'PHONE', value: '6666666666', isPrimary: true }
    ],
    branchId: branch.id
  });

  console.log(`✅ Created patient: ${patient.patientNumber}`);
  console.log(`   ID: ${patient.id}\n`);
}

async function testImplicitMergePrevented() {
  console.log('=== TEST 2: Potential duplicate - should throw ConflictError (E2-03) ===\n');
  
  const branch = await prisma.branch.findFirst();
  if (!branch) throw new Error('No branches found');

  // Try to create same patient again (same phone, name, age, gender)
  try {
    await createPatient({
      name: 'UNIQUE TEST PATIENT', // Same name
      age: 35, // Same age
      gender: 'F', // Same gender
      identifiers: [
        { type: 'PHONE', value: '6666666666', isPrimary: true } // Same phone
      ],
      branchId: branch.id
    });

    console.error('❌ FAILURE: Patient was created without throwing error!');
    console.error('   System auto-merged or allowed duplicate creation.\n');
    throw new Error('E2-03 violation: Implicit merge or duplicate allowed');
    
  } catch (error: any) {
    if (error.error === 'CONFLICT' && error.message.includes('POTENTIAL_DUPLICATE')) {
      console.log('✅ SUCCESS: ConflictError thrown as expected');
      
      // Parse the error message to get existing patient details
      const errorData = JSON.parse(error.message);
      console.log('   Error code:', errorData.error);
      console.log('   Message:', errorData.message);
      console.log('   Existing patient:', errorData.existingPatient.patientNumber);
      console.log('   E2-03 compliance: ✓ No auto-merge\n');
    } else {
      console.error('❌ FAILURE: Wrong error type thrown');
      console.error(`   Expected: ConflictError with POTENTIAL_DUPLICATE`);
      console.error(`   Got: ${error.error || error.name} - ${error.message}\n`);
      throw error;
    }
  }
}

async function testForceDuplicateCreation() {
  console.log('=== TEST 3: Force duplicate with explicit confirmation ===\n');
  
  const branch = await prisma.branch.findFirst();
  if (!branch) throw new Error('No branches found');

  // Create with forceDuplicate flag (user explicitly confirmed)
  const duplicate = await createPatient({
    name: 'UNIQUE TEST PATIENT', // Same details
    age: 35,
    gender: 'F',
    identifiers: [
      { type: 'PHONE', value: '6666666666', isPrimary: true }
    ],
    branchId: branch.id,
    forceDuplicate: true // E2-03: Explicit user confirmation
  });

  console.log(`✅ Created duplicate with explicit confirmation: ${duplicate.patientNumber}`);
  console.log(`   ID: ${duplicate.id}`);
  console.log('   E2-03 compliance: ✓ User explicitly confirmed duplicate\n');

  // Verify we now have 2 patients with same phone
  const patientsWithPhone = await prisma.patient.findMany({
    where: {
      identifiers: {
        some: {
          type: 'PHONE',
          value: '6666666666'
        }
      }
    }
  });

  console.log(`Database check: ${patientsWithPhone.length} patients with phone 6666666666`);
  
  if (patientsWithPhone.length !== 2) {
    console.error('❌ FAILURE: Expected 2 patients but found', patientsWithPhone.length);
    throw new Error('Force duplicate did not work correctly');
  }
  
  console.log('✅ Verified: 2 separate patient records exist\n');
}

async function testDifferentFamilyMemberAllowed() {
  console.log('=== TEST 4: Different family member with same phone - should create ===\n');
  
  const branch = await prisma.branch.findFirst();
  if (!branch) throw new Error('No branches found');

  // Create parent
  const parent = await createPatient({
    name: 'PARENT TEST E203',
    age: 50,
    gender: 'M',
    identifiers: [
      { type: 'PHONE', value: '5555555555', isPrimary: true }
    ],
    branchId: branch.id
  });

  console.log(`Created parent: ${parent.patientNumber}`);

  // Create child with same phone but different demographics
  const child = await createPatient({
    name: 'CHILD TEST E203',
    age: 25,
    gender: 'F',
    identifiers: [
      { type: 'PHONE', value: '5555555555', isPrimary: true }
    ],
    branchId: branch.id
  });

  console.log(`Created child: ${child.patientNumber}`);

  if (parent.id === child.id) {
    console.error('❌ FAILURE: System returned same patient for different family members');
    throw new Error('Family members incorrectly merged');
  }

  console.log('✅ SUCCESS: Different family members created as separate patients');
  console.log('   E2-03 compliance: ✓ Only same-person duplicates are flagged\n');
}

async function main() {
  try {
    await cleanup();
    
    await testNoDuplicateDetected();
    await testImplicitMergePrevented();
    await testForceDuplicateCreation();
    await testDifferentFamilyMemberAllowed();
    
    console.log('=== ALL E2-03 TESTS PASSED ===');
    console.log('✓ No implicit patient merging');
    console.log('✓ ConflictError thrown for potential duplicates');
    console.log('✓ Explicit forceDuplicate flag required');
    console.log('✓ Different family members can share identifiers\n');
    
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
