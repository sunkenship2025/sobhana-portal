/**
 * E2-08: Test Shared Phone Number Handling
 * 
 * Acceptance Criteria:
 * AC1: Same phone → multiple patients allowed (family members)
 * AC2: UI forces explicit patient selection (verified via API returning array)
 */

const fetch = require('node-fetch');
const { ADMIN_CREDS } = require('./authTestConfig');

const API_BASE = 'http://localhost:3000/api';
let authToken = '';
let branchId = '';

async function login() {
  console.log('🔐 Logging in...');
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: ADMIN_CREDS.email,
      password: ADMIN_CREDS.password
    })
  });
  
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Login failed: ${JSON.stringify(data)}`);
  }
  
  authToken = data.token;
  branchId = data.user.activeBranch.id;
  console.log('✅ Login successful');
  console.log(`   Branch: ${data.user.activeBranch.name} (${branchId})\n`);
}

async function createPatient(patientData) {
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
  if (!response.ok) {
    console.log(`   Error: ${JSON.stringify(data)}`);
  }
  return { status: response.status, data };
}

async function searchPatientsByPhone(phone) {
  const response = await fetch(`${API_BASE}/patients/search?phone=${phone}`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'X-Branch-Id': branchId
    }
  });
  
  const data = await response.json();
  return { status: response.status, data };
}

async function runTests() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('E2-08: SHARED PHONE NUMBER HANDLING TEST');
  console.log('═══════════════════════════════════════════════════════════════\n');

  try {
    await login();
    
    const testPhone = `9${Math.floor(100000000 + Math.random() * 900000000)}`;
    console.log(`📱 Test phone number: ${testPhone}\n`);
    
    // TEST 1: Create first patient (head of family)
    console.log('TEST 1: Create first patient');
    console.log('════════════════════════════════════');
    const patient1Data = {
      name: 'Test Father E208',
      age: 45,
      gender: 'M',
      identifiers: [
        { type: 'PHONE', value: testPhone, isPrimary: true }
      ]
    };
    
    const result1 = await createPatient(patient1Data);
    console.log(`Status: ${result1.status}`);
    console.log(`Patient Number: ${result1.data.patientNumber}`);
    console.log(`Patient ID: ${result1.data.id}`);
    console.log(`Name: ${result1.data.name}\n`);
    
    const patient1Id = result1.data.id;
    
    // TEST 2: Create family member with SAME phone (different name) - should create new
    console.log('TEST 2: Create family member with SAME phone (different name)');
    console.log('═══════════════════════════════════════════════════════════════');
    const patient2Data = {
      name: 'Test Mother E208', // Different name (wife)
      age: 42,
      gender: 'F', // Different gender
      identifiers: [
        { type: 'PHONE', value: testPhone, isPrimary: true }
      ]
    };
    
    const result2 = await createPatient(patient2Data);
    console.log(`Status: ${result2.status}`);
    console.log(`Patient Number: ${result2.data.patientNumber}`);
    console.log(`Patient ID: ${result2.data.id}`);
    console.log(`Name: ${result2.data.name}`);
    
    const patient2Id = result2.data.id;
    
    if (patient2Id !== patient1Id) {
      console.log('✅ AC1 PASS: Created new patient (family member) with same phone\n');
    } else {
      console.log('❌ AC1 FAIL: Should have created new patient for family member!\n');
    }
    
    // TEST 3: Create another family member with SAME phone
    console.log('TEST 3: Create another family member (child)');
    console.log('═══════════════════════════════════════════════════════════════');
    const patient3Data = {
      name: 'Test Child E208',
      age: 15,
      gender: 'M',
      identifiers: [
        { type: 'PHONE', value: testPhone, isPrimary: true }
      ]
    };
    
    const result3 = await createPatient(patient3Data);
    console.log(`Status: ${result3.status}`);
    console.log(`Patient Number: ${result3.data.patientNumber}`);
    console.log(`Patient ID: ${result3.data.id}`);
    console.log(`Name: ${result3.data.name}`);
    
    const patient3Id = result3.data.id;
    
    if (patient3Id !== patient1Id && patient3Id !== patient2Id) {
      console.log('✅ PASS: Created new patient (child) with same phone\n');
    } else {
      console.log('❌ FAIL: Should have created new patient for child!\n');
    }
    
    // TEST 4: Search by phone - should return ALL patients (AC2 requirement)
    console.log('TEST 4: Search by phone (CRITICAL - AC2 verification)');
    console.log('═══════════════════════════════════════════════════════════════');
    const searchResult = await searchPatientsByPhone(testPhone);
    console.log(`Status: ${searchResult.status}`);
    console.log(`Found ${searchResult.data.length} patients with same phone:\n`);
    
    searchResult.data.forEach((result, index) => {
      console.log(`  ${index + 1}. ${result.patient.name} (${result.patient.patientNumber})`);
      console.log(`     Age: ${result.patient.age}, Gender: ${result.patient.gender}`);
    });
    console.log('');
    
    if (searchResult.data.length >= 3) {
      console.log('✅ AC2 PASS: Search returns ALL patients sharing same phone');
      console.log('   (UI can display list and force explicit selection via radio buttons)\n');
    } else {
      console.log('❌ AC2 FAIL: Search should return all family members!\n');
    }
    
    // SUMMARY
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('TEST SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════');
    
    const ac1Pass = patient2Id !== patient1Id && patient3Id !== patient1Id;
    const ac2Pass = searchResult.data.length >= 3;
    
    console.log(`AC1: Same phone → multiple patients allowed: ${ac1Pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log(`AC2: Search returns all patients (for UI selection): ${ac2Pass ? '✅ PASS' : '❌ FAIL'}`);
    console.log('');
    
    if (ac1Pass && ac2Pass) {
      console.log('🎉 E2-08: ALL ACCEPTANCE CRITERIA PASSED!');
    } else {
      console.log('⚠️ E2-08: Some acceptance criteria failed');
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error(error.stack);
  }
}

// Run tests
runTests();
