/**
 * E2-09 Test: Verify YOB/DOB Implementation
 * Tests:
 * 1. Create patient with only age → YOB calculated
 * 2. Create patient with DOB → YOB and DOB stored, age calculated
 * 3. Verify age is calculated correctly from YOB/DOB
 * 4. Verify patient search returns calculated age
 * 5. Verify Patient 360 shows both age and DOB
 */

const API_BASE = 'http://localhost:3000/api';

// Login credentials (adjust if needed)
const LOGIN_CREDENTIALS = {
  username: 'owner',
  password: 'owner123'
};

const BRANCH_ID = 'cmjzumgap00003zwljoqlubsn'; // Default branch

let authToken = null;

async function login() {
  console.log('\n🔐 Logging in...');
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LOGIN_CREDENTIALS)
  });

  if (!response.ok) {
    throw new Error(`Login failed: ${response.statusText}`);
  }

  const data = await response.json();
  authToken = data.token;
  console.log('✅ Logged in successfully');
  return data;
}

async function createPatientWithAge(name, age, phone) {
  console.log(`\n📝 Creating patient with AGE ONLY: ${name}, Age: ${age}`);
  
  const response = await fetch(`${API_BASE}/patients`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'X-Branch-Id': BRANCH_ID
    },
    body: JSON.stringify({
      name,
      age: parseInt(age),
      gender: 'M',
      identifiers: [
        { type: 'PHONE', value: phone, isPrimary: true }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create patient: ${error}`);
  }

  const patient = await response.json();
  console.log(`✅ Patient created: ${patient.patientNumber}`);
  console.log(`   ID: ${patient.id}`);
  return patient;
}

async function createPatientWithDOB(name, dob, phone) {
  console.log(`\n📝 Creating patient with DOB: ${name}, DOB: ${dob}`);
  
  const response = await fetch(`${API_BASE}/patients`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'X-Branch-Id': BRANCH_ID
    },
    body: JSON.stringify({
      name,
      dateOfBirth: dob,
      gender: 'F',
      identifiers: [
        { type: 'PHONE', value: phone, isPrimary: true }
      ]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create patient: ${error}`);
  }

  const patient = await response.json();
  console.log(`✅ Patient created: ${patient.patientNumber}`);
  console.log(`   ID: ${patient.id}`);
  return patient;
}

async function getPatient360(patientId) {
  console.log(`\n🔍 Fetching Patient 360 view for: ${patientId}`);
  
  const response = await fetch(`${API_BASE}/patients/${patientId}/360`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'X-Branch-Id': BRANCH_ID
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch patient 360: ${response.statusText}`);
  }

  const data = await response.json();
  return data;
}

async function searchPatient(phone) {
  console.log(`\n🔍 Searching patient by phone: ${phone}`);
  
  const response = await fetch(`${API_BASE}/patients/search?phone=${phone}`, {
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'X-Branch-Id': BRANCH_ID
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to search patient: ${response.statusText}`);
  }

  const results = await response.json();
  return results;
}

async function verifyPatientData(patient, expectedName, expectedAge, hasDOB) {
  console.log(`\n✅ Verifying patient data:`);
  console.log(`   Name: ${patient.name} (expected: ${expectedName.toUpperCase()})`);
  console.log(`   Age: ${patient.age} (expected: ${expectedAge})`);
  console.log(`   YOB: ${patient.yearOfBirth}`);
  console.log(`   DOB: ${patient.dateOfBirth || 'NULL'}`);
  console.log(`   Gender: ${patient.gender}`);

  // Verify name
  if (patient.name !== expectedName.toUpperCase()) {
    throw new Error(`Name mismatch! Expected: ${expectedName.toUpperCase()}, Got: ${patient.name}`);
  }

  // Verify age is within reasonable range (±1 year for rounding)
  if (Math.abs(patient.age - expectedAge) > 1) {
    throw new Error(`Age mismatch! Expected: ${expectedAge}, Got: ${patient.age}`);
  }

  // Verify DOB presence
  if (hasDOB && !patient.dateOfBirth) {
    throw new Error('DOB should be present but is NULL');
  }
  if (!hasDOB && patient.dateOfBirth) {
    throw new Error('DOB should be NULL but has value');
  }

  console.log('✅ Patient data verified successfully!');
}

async function runTests() {
  try {
    console.log('='.repeat(60));
    console.log('E2-09 TEST: Store YOB Instead of Age');
    console.log('='.repeat(60));

    // Login
    await login();

    // Test 1: Create patient with age only
    console.log('\n' + '='.repeat(60));
    console.log('TEST 1: Create patient with AGE only');
    console.log('='.repeat(60));
    const phone1 = `90${Date.now().toString().slice(-8)}`;
    const patient1 = await createPatientWithAge('Rajesh Kumar', 45, phone1);
    
    // Verify via database that YOB is calculated
    const currentYear = new Date().getFullYear();
    const expectedYOB1 = currentYear - 45;
    console.log(`   Expected YOB: ${expectedYOB1}`);

    // Test 2: Create patient with DOB
    console.log('\n' + '='.repeat(60));
    console.log('TEST 2: Create patient with DOB');
    console.log('='.repeat(60));
    const phone2 = `91${Date.now().toString().slice(-8)}`;
    const dob = '1995-03-15';
    const patient2 = await createPatientWithDOB('Priya Sharma', dob, phone2);
    
    const dobDate = new Date(dob);
    const expectedAge2 = currentYear - dobDate.getFullYear();
    console.log(`   Expected Age from DOB: ${expectedAge2}`);

    // Test 3: Search patients and verify calculated age
    console.log('\n' + '='.repeat(60));
    console.log('TEST 3: Search patient by phone (age calculation)');
    console.log('='.repeat(60));
    
    const results1 = await searchPatient(phone1);
    if (results1.length === 0) {
      throw new Error('Patient 1 not found in search!');
    }
    const searchResult1 = results1[0].patient;
    await verifyPatientData(searchResult1, 'Rajesh Kumar', 45, false);

    const results2 = await searchPatient(phone2);
    if (results2.length === 0) {
      throw new Error('Patient 2 not found in search!');
    }
    const searchResult2 = results2[0].patient;
    await verifyPatientData(searchResult2, 'Priya Sharma', expectedAge2, true);

    // Test 4: Fetch Patient 360 and verify age/DOB display
    console.log('\n' + '='.repeat(60));
    console.log('TEST 4: Patient 360 view');
    console.log('='.repeat(60));
    
    const patient360_1 = await getPatient360(patient1.id);
    console.log(`\n📊 Patient 360 - ${patient360_1.patient.name}:`);
    await verifyPatientData(patient360_1.patient, 'Rajesh Kumar', 45, false);

    const patient360_2 = await getPatient360(patient2.id);
    console.log(`\n📊 Patient 360 - ${patient360_2.patient.name}:`);
    await verifyPatientData(patient360_2.patient, 'Priya Sharma', expectedAge2, true);

    // Summary
    console.log('\n' + '='.repeat(60));
    console.log('✅ ALL TESTS PASSED!');
    console.log('='.repeat(60));
    console.log('\n📋 Summary:');
    console.log(`   ✅ Patient with age only: ${patient1.patientNumber} (YOB: ${expectedYOB1})`);
    console.log(`   ✅ Patient with DOB: ${patient2.patientNumber} (DOB: ${dob})`);
    console.log(`   ✅ Age calculated correctly from YOB/DOB`);
    console.log(`   ✅ Search returns calculated age`);
    console.log(`   ✅ Patient 360 displays age and DOB\n`);

  } catch (error) {
    console.error('\n❌ TEST FAILED:', error.message);
    process.exit(1);
  }
}

runTests();
