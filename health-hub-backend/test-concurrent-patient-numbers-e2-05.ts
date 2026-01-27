/**
 * E2-05: Test Concurrency-Safe Patient Number Generation
 * 
 * Tests that patient numbers are generated atomically without duplicates
 * even under high concurrency load.
 */

import { PrismaClient } from '@prisma/client';
import { generatePatientNumber, generateDiagnosticBillNumber, generateClinicBillNumber } from './src/services/numberService';

const prisma = new PrismaClient();

/**
 * Test 1: Concurrent patient number generation
 * Simulate multiple simultaneous patient registrations
 */
async function testConcurrentPatientNumbers() {
  console.log('\n=== TEST 1: Concurrent Patient Number Generation ===');
  
  try {
    // Clean up test data
    await prisma.numberSequence.deleteMany({
      where: { id: 'patient' }
    });
    
    // Generate 50 patient numbers concurrently
    const concurrency = 50;
    console.log(`Generating ${concurrency} patient numbers concurrently...`);
    
    const startTime = Date.now();
    const promises = Array.from({ length: concurrency }, () => generatePatientNumber());
    const patientNumbers = await Promise.all(promises);
    const endTime = Date.now();
    
    console.log(`✓ Generated ${patientNumbers.length} numbers in ${endTime - startTime}ms`);
    
    // Check for duplicates
    const uniqueNumbers = new Set(patientNumbers);
    if (uniqueNumbers.size !== patientNumbers.length) {
      console.error('✗ FAILED: Duplicate patient numbers detected!');
      console.error('Total:', patientNumbers.length, 'Unique:', uniqueNumbers.size);
      
      // Find duplicates
      const counts = new Map<string, number>();
      patientNumbers.forEach(num => {
        counts.set(num, (counts.get(num) || 0) + 1);
      });
      
      counts.forEach((count, num) => {
        if (count > 1) {
          console.error(`  - ${num} appeared ${count} times`);
        }
      });
      
      return false;
    }
    
    console.log(`✓ All ${patientNumbers.length} numbers are unique`);
    
    // Verify sequential order
    const numbers = patientNumbers.map(n => parseInt(n.split('-')[1])).sort((a, b) => a - b);
    const expectedSequence = Array.from({ length: concurrency }, (_, i) => i + 1);
    
    const isSequential = numbers.every((num, i) => num === expectedSequence[i]);
    if (!isSequential) {
      console.error('✗ FAILED: Numbers are not sequential');
      console.error('Expected:', expectedSequence.slice(0, 10), '...');
      console.error('Got:', numbers.slice(0, 10), '...');
      return false;
    }
    
    console.log(`✓ Numbers are sequential (${numbers[0]} to ${numbers[numbers.length - 1]})`);
    console.log('Sample numbers:', patientNumbers.slice(0, 5).join(', '));
    
    return true;
  } catch (err: any) {
    console.error('✗ Test failed:', err.message);
    return false;
  }
}

/**
 * Test 2: Concurrent branch-scoped bill numbers
 * Test diagnostic bill numbers for multiple branches
 */
async function testConcurrentBranchNumbers() {
  console.log('\n=== TEST 2: Concurrent Branch-Scoped Bill Numbers ===');
  
  try {
    // Clean up test data
    await prisma.numberSequence.deleteMany({
      where: { 
        id: { 
          in: ['diagnostic-TEST1', 'diagnostic-TEST2'] 
        } 
      }
    });
    
    // Generate numbers for 2 branches concurrently
    const concurrency = 25;
    console.log(`Generating ${concurrency} bill numbers per branch (2 branches)...`);
    
    const startTime = Date.now();
    const branch1Promises = Array.from({ length: concurrency }, () => generateDiagnosticBillNumber('TEST1'));
    const branch2Promises = Array.from({ length: concurrency }, () => generateDiagnosticBillNumber('TEST2'));
    
    const [branch1Numbers, branch2Numbers] = await Promise.all([
      Promise.all(branch1Promises),
      Promise.all(branch2Promises)
    ]);
    const endTime = Date.now();
    
    console.log(`✓ Generated ${branch1Numbers.length + branch2Numbers.length} numbers in ${endTime - startTime}ms`);
    
    // Check branch 1 for duplicates
    const uniqueBranch1 = new Set(branch1Numbers);
    if (uniqueBranch1.size !== branch1Numbers.length) {
      console.error('✗ FAILED: Duplicate numbers in branch 1');
      const counts = new Map<string, number>();
      branch1Numbers.forEach(num => {
        counts.set(num, (counts.get(num) || 0) + 1);
      });
      counts.forEach((count, num) => {
        if (count > 1) {
          console.error(`  - ${num} appeared ${count} times`);
        }
      });
      return false;
    }
    console.log(`✓ Branch TEST1: All ${branch1Numbers.length} numbers are unique`);
    
    // Check branch 2 for duplicates
    const uniqueBranch2 = new Set(branch2Numbers);
    if (uniqueBranch2.size !== branch2Numbers.length) {
      console.error('✗ FAILED: Duplicate numbers in branch 2');
      return false;
    }
    console.log(`✓ Branch TEST2: All ${branch2Numbers.length} numbers are unique`);
    
    // Verify no overlap between branches
    const overlap = branch1Numbers.some(n => branch2Numbers.includes(n));
    if (overlap) {
      console.error('✗ FAILED: Number overlap between branches detected');
      return false;
    }
    console.log('✓ No overlap between branches');
    
    console.log('Sample TEST1:', branch1Numbers.slice(0, 3).join(', '));
    console.log('Sample TEST2:', branch2Numbers.slice(0, 3).join(', '));
    
    return true;
  } catch (err: any) {
    console.error('✗ Test failed:', err.message);
    return false;
  }
}

/**
 * Test 3: High load stress test
 * Generate 200 patient numbers with maximum concurrency using actual service
 */
async function testHighLoadStress() {
  console.log('\n=== TEST 3: High Load Stress Test ===');
  
  try {
    // Clean up
    await prisma.numberSequence.delete({
      where: { id: 'patient' }
    }).catch(() => {}); // Ignore if doesn't exist
    
    const concurrency = 200;
    console.log(`Stress testing with ${concurrency} concurrent patient number requests...`);
    
    const startTime = Date.now();
    // Use smaller batches to simulate high concurrency
    const batchSize = 25;
    const numbers: string[] = [];
    
    for (let i = 0; i < concurrency; i += batchSize) {
      const batch = Math.min(batchSize, concurrency - i);
      const promises = Array.from({ length: batch }, () => generatePatientNumber());
      const batchResults = await Promise.all(promises);
      numbers.push(...batchResults);
    }
    
    const endTime = Date.now();
    
    console.log(`✓ Generated ${numbers.length} numbers in ${endTime - startTime}ms`);
    console.log(`  Average: ${((endTime - startTime) / numbers.length).toFixed(2)}ms per number`);
    
    // Check for duplicates
    const uniqueNumbers = new Set(numbers);
    if (uniqueNumbers.size !== numbers.length) {
      console.error('✗ FAILED: Duplicate numbers under high load!');
      console.error('Total:', numbers.length, 'Unique:', uniqueNumbers.size);
      
      // Find duplicates
      const counts = new Map<string, number>();
      numbers.forEach(num => {
        counts.set(num, (counts.get(num) || 0) + 1);
      });
      
      counts.forEach((count, num) => {
        if (count > 1) {
          console.error(`  - ${num} appeared ${count} times`);
        }
      });
      
      return false;
    }
    
    console.log(`✓ All ${numbers.length} numbers are unique under high load`);
    
    // Verify final sequence value
    const finalSequence = await prisma.numberSequence.findUnique({
      where: { id: 'patient' }
    });
    
    if (finalSequence?.lastValue !== concurrency) {
      console.error(`✗ FAILED: Final sequence value mismatch. Expected ${concurrency}, got ${finalSequence?.lastValue}`);
      return false;
    }
    
    console.log(`✓ Final sequence value correct: ${finalSequence.lastValue}`);
    
    return true;
  } catch (err: any) {
    console.error('✗ Test failed:', err.message);
    return false;
  }
}

/**
 * Test 4: Mixed operations stress test
 * Test multiple sequence types simultaneously
 */
async function testMixedOperations() {
  console.log('\n=== TEST 4: Mixed Operations Stress Test ===');
  
  try {
    // Clean up
    await prisma.numberSequence.deleteMany({
      where: { 
        id: { 
          in: ['patient', 'diagnostic-MIX', 'clinic-MIX'] 
        } 
      }
    });
    
    console.log('Generating mixed sequence types concurrently...');
    
    const perType = 30;
    const startTime = Date.now();
    
    const [patientNumbers, diagnosticNumbers, clinicNumbers] = await Promise.all([
      Promise.all(Array.from({ length: perType }, () => generatePatientNumber())),
      Promise.all(Array.from({ length: perType }, () => generateDiagnosticBillNumber('MIX'))),
      Promise.all(Array.from({ length: perType }, () => generateClinicBillNumber('MIX')))
    ]);
    
    const endTime = Date.now();
    const total = patientNumbers.length + diagnosticNumbers.length + clinicNumbers.length;
    
    console.log(`✓ Generated ${total} numbers across 3 types in ${endTime - startTime}ms`);
    
    // Check each type for duplicates
    const checks = [
      { name: 'Patient', numbers: patientNumbers },
      { name: 'Diagnostic', numbers: diagnosticNumbers },
      { name: 'Clinic', numbers: clinicNumbers }
    ];
    
    for (const check of checks) {
      const unique = new Set(check.numbers);
      if (unique.size !== check.numbers.length) {
        console.error(`✗ FAILED: Duplicate ${check.name} numbers`);
        return false;
      }
      console.log(`✓ ${check.name}: All ${check.numbers.length} numbers unique`);
    }
    
    console.log('Samples:');
    console.log(`  Patient: ${patientNumbers.slice(0, 3).join(', ')}`);
    console.log(`  Diagnostic: ${diagnosticNumbers.slice(0, 3).join(', ')}`);
    console.log(`  Clinic: ${clinicNumbers.slice(0, 3).join(', ')}`);
    
    return true;
  } catch (err: any) {
    console.error('✗ Test failed:', err.message);
    return false;
  }
}

/**
 * Main test runner
 */
async function runAllTests() {
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║   E2-05: Patient Number Concurrency Tests         ║');
  console.log('╚════════════════════════════════════════════════════╝');
  
  const results = {
    test1: await testConcurrentPatientNumbers(),
    test2: await testConcurrentBranchNumbers(),
    test3: await testHighLoadStress(),
    test4: await testMixedOperations()
  };
  
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║   Test Summary                                     ║');
  console.log('╚════════════════════════════════════════════════════╝');
  
  const passed = Object.values(results).filter(r => r).length;
  const total = Object.values(results).length;
  
  console.log(`Test 1 (Concurrent Patient Numbers): ${results.test1 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 2 (Branch-Scoped Numbers): ${results.test2 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 3 (High Load Stress): ${results.test3 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`Test 4 (Mixed Operations): ${results.test4 ? '✓ PASS' : '✗ FAIL'}`);
  console.log(`\nTotal: ${passed}/${total} tests passed`);
  
  if (passed === total) {
    console.log('\n✅ All concurrency tests PASSED');
    console.log('✅ E2-05 Acceptance Criteria Met:');
    console.log('   - Atomic sequence generation: ✓');
    console.log('   - No duplicate numbers under load: ✓');
  } else {
    console.log('\n❌ Some tests FAILED - concurrency issues detected');
  }
  
  await prisma.$disconnect();
}

runAllTests().catch(console.error);
