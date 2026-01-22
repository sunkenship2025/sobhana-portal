/**
 * SHP-1: Test Global Patient Uniqueness
 * 
 * Validates:
 * 1. Same phone + name + gender → returns existing patient
 * 2. Same phone + different name → creates new patient (family member)
 * 3. Works across different branches
 */

const fetch = require('node-fetch');

const API_BASE = 'http://localhost:3000/api';
let authToken = '';

// Test data
const BRANCH_A_ID = ''; // Will be populated
const BRANCH_B_ID = ''; // Will be populated

async function login() {
  console.log('🔐 Logging in...');
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'admin',
      password: 'admin123' // Update with actual credentials
    })
  });
  
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Login failed: ${JSON.stringify(data)}`);
  }
  
  authToken = data.token;
  console.log('✅ Login successful\n');
}

async function getBranches() {
  console.log('🏢 Fetching branches...');
  const response = await fetch(`${API_BASE}/branches`, {
    headers: { 'Authorization': `Bearer ${authToken}` }
  });
  
  const branches = await response.json();
  if (branches.length < 1) {
    throw new Error('Need at least one branch to test');
  }
  
  console.log(`✅ Found ${branches.length} branches`);
  console.log(`   Branch A: ${branches[0].name} (${branches[0].id})`);
  if (branches.length > 1) {
    console.log(`   Branch B: ${branches[1].name} (${branches[1].id})\n`);
  } else {
    console.log(`   (Only one branch available - will test same branch)\n`);
  }
  
  return branches;
}

async function createPatient(branchId, patientData) {
  const response = await fetch(`${API_BASE}/patients`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'X-Branch-Id': branchId
    },
    body: JSON.stringify(patientData)
  });
  
  const data = await response.json();
  return { status: response.status, data };
}

async function runTests() {
  try {
    await login();
    const branches = await getBranches();
    const branchA = branches[0];
    const branchB = branches.length > 1 ? branches[1] : branches[0];
    
    const testPhone = `9${Math.floor(100000000 + Math.random() * 900000000)}`;
    console.log(`📱 Test phone number: ${testPhone}\n`);
    
    // TEST 1: Create patient in Branch A
    console.log('TEST 1: Create patient in Branch A');
    console.log('=====================================');
    const patient1Data = {
      name: 'Rajesh Kumar',
      age: 35,
      gender: 'M',
      address: '123 Test Street, Chennai',
      identifiers: [
        { type: 'PHONE', value: testPhone, isPrimary: true }
      ]
    };
    
    const result1 = await createPatient(branchA.id, patient1Data);
    console.log(`Status: ${result1.status}`);
    console.log(`Patient Number: ${result1.data.patientNumber}`);
    console.log(`Patient ID: ${result1.data.id}`);
    console.log(`Name: ${result1.data.name}\n`);
    
    const originalPatientId = result1.data.id;
    
    // TEST 2: Try creating same patient in Branch B (should return existing)
    console.log(`TEST 2: Try same patient in Branch ${branchB === branchA ? 'A again' : 'B'}`);
    console.log('=====================================');
    const patient2Data = {
      name: 'Rajesh Kumar', // Same name
      age: 35, // Same age
      gender: 'M', // Same gender
      address: '456 Different Street, Mumbai', // Different address
      identifiers: [
        { type: 'PHONE', value: testPhone, isPrimary: true }
      ]
    };
    
    const result2 = await createPatient(branchB.id, patient2Data);
    console.log(`Status: ${result2.status}`);
    console.log(`Patient Number: ${result2.data.patientNumber}`);
    console.log(`Patient ID: ${result2.data.id}`);
    console.log(`Name: ${result2.data.name}`);
    
    if (result2.data.id === originalPatientId) {
      console.log('✅ SUCCESS: Returned existing patient (no duplicate created)\n');
    } else {
      console.log('❌ FAIL: Created duplicate patient!\n');
    }
    
    // TEST 3: Create different family member with same phone
    console.log('TEST 3: Create family member (different name, same phone)');
    console.log('=========================================================');
    const patient3Data = {
      name: 'Priya Kumar', // Different name (wife)
      age: 32, // Different age
      gender: 'F', // Different gender
      address: '123 Test Street, Chennai',
      identifiers: [
        { type: 'PHONE', value: testPhone, isPrimary: true }
      ]
    };
    
    const result3 = await createPatient(branchA.id, patient3Data);
    console.log(`Status: ${result3.status}`);
    console.log(`Patient Number: ${result3.data.patientNumber}`);
    console.log(`Patient ID: ${result3.data.id}`);
    console.log(`Name: ${result3.data.name}`);
    
    if (result3.data.id !== originalPatientId) {
      console.log('✅ SUCCESS: Created new patient (family member)\n');
    } else {
      console.log('❌ FAIL: Should have created new patient for family member!\n');
    }
    
    // TEST 4: Try same name with slight age difference (within ±1 year)
    console.log('TEST 4: Same person with age difference (birthday scenario)');
    console.log('===========================================================');
    const patient4Data = {
      name: 'Rajesh Kumar',
      age: 36, // Age difference of 1 year
      gender: 'M',
      address: 'Yet another address',
      identifiers: [
        { type: 'PHONE', value: testPhone, isPrimary: true }
      ]
    };
    
    const result4 = await createPatient(branchA.id, patient4Data);
    console.log(`Status: ${result4.status}`);
    console.log(`Patient ID: ${result4.data.id}`);
    
    if (result4.data.id === originalPatientId) {
      console.log('✅ SUCCESS: Returned existing patient (age tolerance working)\n');
    } else {
      console.log('❌ FAIL: Created duplicate when age was within tolerance!\n');
    }
    
    console.log('═══════════════════════════════════════');
    console.log('TEST SUMMARY');
    console.log('═══════════════════════════════════════');
    console.log(`Original Patient: ${originalPatientId} (${result1.data.patientNumber})`);
    console.log(`Test 2 (Same patient, diff branch): ${result2.data.id === originalPatientId ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Test 3 (Family member): ${result3.data.id !== originalPatientId ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`Test 4 (Age tolerance): ${result4.data.id === originalPatientId ? '✅ PASS' : '❌ FAIL'}`);
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  }
}

// Run tests
runTests();
