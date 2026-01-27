/**
 * E2-02: Test Centralized Patient Identifier Matching
 * 
 * Tests the patient matching service across different scenarios:
 * 1. Exact phone match (primary identifier)
 * 2. Exact email match (primary identifier)
 * 3. Fuzzy name match (secondary identifier)
 * 4. Composite matching (multiple criteria)
 * 5. Duplicate detection during patient creation
 */

import { PrismaClient } from '@prisma/client';
import * as patientMatching from './src/services/patientMatchingService';
import * as patientService from './src/services/patientService';

const prisma = new PrismaClient();

async function testPhoneMatching() {
  console.log('\n=== TEST 1: Phone Matching (Primary Identifier) ===');
  
  try {
    // Test with existing patient phone
    const matches = await patientMatching.findPatientsByIdentifier(
      { phone: '9999888877' },
      { limit: 5 }
    );
    
    console.log(`✓ Found ${matches.length} match(es) by phone`);
    matches.forEach(match => {
      console.log(`  - ${match.patient.name} (${match.patient.patientNumber})`);
      console.log(`    Confidence: ${match.confidence}, Score: ${match.matchScore}`);
    });
  } catch (err: any) {
    console.error('✗ Phone matching failed:', err.message);
  }
}

async function testEmailMatching() {
  console.log('\n=== TEST 2: Email Matching (Primary Identifier) ===');
  
  try {
    const matches = await patientMatching.findPatientsByIdentifier(
      { email: 'test@example.com' },
      { limit: 5 }
    );
    
    console.log(`✓ Found ${matches.length} match(es) by email`);
    matches.forEach(match => {
      console.log(`  - ${match.patient.name} (${match.patient.patientNumber})`);
      console.log(`    Confidence: ${match.confidence}, Score: ${match.matchScore}`);
    });
  } catch (err: any) {
    console.error('✗ Email matching failed:', err.message);
  }
}

async function testNameMatching() {
  console.log('\n=== TEST 3: Name Matching (Secondary Identifier) ===');
  
  try {
    // Test exact name match
    const exactMatches = await patientMatching.findPatientsByIdentifier(
      { name: 'RAJESH KUMAR' },
      { limit: 5 }
    );
    
    console.log(`✓ Exact name: Found ${exactMatches.length} match(es)`);
    exactMatches.forEach(match => {
      console.log(`  - ${match.patient.name} (${match.patient.patientNumber})`);
      console.log(`    Confidence: ${match.confidence}, Score: ${match.matchScore}`);
    });
    
    // Test partial name match
    const partialMatches = await patientMatching.findPatientsByIdentifier(
      { name: 'KUMAR' },
      { limit: 5 }
    );
    
    console.log(`✓ Partial name: Found ${partialMatches.length} match(es)`);
    partialMatches.forEach(match => {
      console.log(`  - ${match.patient.name} (${match.patient.patientNumber})`);
      console.log(`    Confidence: ${match.confidence}, Score: ${match.matchScore}`);
    });
  } catch (err: any) {
    console.error('✗ Name matching failed:', err.message);
  }
}

async function testStrictMode() {
  console.log('\n=== TEST 4: Strict Mode (No Fuzzy Matching) ===');
  
  try {
    // Should only return exact phone/email matches, no name fuzzy matching
    const strictMatches = await patientMatching.findPatientsByIdentifier(
      { name: 'KUMAR' },
      { limit: 5, strictMode: true }
    );
    
    console.log(`✓ Strict mode: Found ${strictMatches.length} match(es) (should be 0 for name-only search)`);
  } catch (err: any) {
    console.error('✗ Strict mode test failed:', err.message);
  }
}

async function testDuplicateDetection() {
  console.log('\n=== TEST 5: Duplicate Detection ===');
  
  try {
    // Check if patient exists
    const existsCheck = await patientMatching.checkPatientExists({
      phone: '9999888877'
    });
    
    console.log(`✓ Patient exists: ${existsCheck.exists}`);
    if (existsCheck.exists) {
      console.log(`  - Matched by: ${existsCheck.matchedBy}`);
      console.log(`  - Patient: ${existsCheck.patient.name} (${existsCheck.patient.patientNumber})`);
    }
    
    // Test non-existent phone
    const newCheck = await patientMatching.checkPatientExists({
      phone: '0000000000'
    });
    
    console.log(`✓ New patient check: ${newCheck.exists} (should be false)`);
  } catch (err: any) {
    console.error('✗ Duplicate detection failed:', err.message);
  }
}

async function testIdentifierUniqueness() {
  console.log('\n=== TEST 6: Identifier Uniqueness Validation ===');
  
  try {
    // Test existing phone
    const existingPhone = await patientMatching.validateIdentifierUniqueness(
      'PHONE',
      '9999888877'
    );
    
    console.log(`✓ Phone 9999888877 unique: ${existingPhone.isUnique}`);
    if (!existingPhone.isUnique) {
      console.log(`  - Already used by patient: ${existingPhone.existingPatientId}`);
    }
    
    // Test new phone
    const newPhone = await patientMatching.validateIdentifierUniqueness(
      'PHONE',
      '0000000000'
    );
    
    console.log(`✓ Phone 0000000000 unique: ${newPhone.isUnique} (should be true)`);
  } catch (err: any) {
    console.error('✗ Uniqueness validation failed:', err.message);
  }
}

async function testInvalidInputs() {
  console.log('\n=== TEST 7: Invalid Input Validation ===');
  
  // Test invalid phone format
  try {
    await patientMatching.findPatientsByIdentifier({ phone: '123' });
    console.error('✗ Should have rejected invalid phone');
  } catch (err: any) {
    console.log('✓ Invalid phone rejected:', err.message);
  }
  
  // Test invalid email format
  try {
    await patientMatching.findPatientsByIdentifier({ email: 'notanemail' });
    console.error('✗ Should have rejected invalid email');
  } catch (err: any) {
    console.log('✓ Invalid email rejected:', err.message);
  }
  
  // Test empty criteria
  try {
    await patientMatching.findPatientsByIdentifier({});
    console.error('✗ Should have rejected empty criteria');
  } catch (err: any) {
    console.log('✓ Empty criteria rejected:', err.message);
  }
}

async function testSearchIntegration() {
  console.log('\n=== TEST 8: Integration with Patient Search API ===');
  
  try {
    // Test the updated searchPatients function
    const results = await patientService.searchPatients({
      phone: '9999888877',
      limit: 5
    });
    
    console.log(`✓ API search found ${results.length} patient(s)`);
    results.forEach(result => {
      console.log(`  - ${result.patient.name} (${result.patient.patientNumber})`);
      console.log(`    Total visits: ${result.totalVisits}`);
    });
  } catch (err: any) {
    console.error('✗ Search integration failed:', err.message);
  }
}

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   E2-02: Patient Identifier Matching Tests        ║');
  console.log('╚════════════════════════════════════════════════════╝');
  
  await testPhoneMatching();
  await testEmailMatching();
  await testNameMatching();
  await testStrictMode();
  await testDuplicateDetection();
  await testIdentifierUniqueness();
  await testInvalidInputs();
  await testSearchIntegration();
  
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║   All Tests Completed                              ║');
  console.log('╚════════════════════════════════════════════════════╝\n');
  
  await prisma.$disconnect();
}

runAllTests().catch(err => {
  console.error('Fatal error:', err);
  prisma.$disconnect();
  process.exit(1);
});
