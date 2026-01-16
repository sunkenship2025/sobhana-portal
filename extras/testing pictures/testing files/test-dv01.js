// DV-01: Create Diagnostic Visit - Happy Path
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNtazJtY2M4eDAwMDcxZDlldHVsNXA2c2EiLCJlbWFpbCI6Im93bmVyQHNvYmhhbmEuY29tIiwicm9sZSI6Im93bmVyIiwiaWF0IjoxNzY3OTg1MzMyLCJleHAiOjE3NjgwNzE3MzJ9.TgQcPUFk7hg41AUYYHAEXBX_nV-i75pSeP2egik73Us";
const BRANCH_ID = "cmk2mcc2r00001d9esaynov48";
const BASE_URL = "http://localhost:3000";

async function apiCall(method, endpoint, body = null) {
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json',
    'X-Branch-Id': BRANCH_ID
  };
  
  const options = { method, headers };
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(`${BASE_URL}${endpoint}`, options);
  const text = await response.text();
  
  return {
    status: response.status,
    ok: response.ok,
    data: text ? JSON.parse(text) : null
  };
}

async function testDV01() {
  console.log('=== TEST DV-01: Create Diagnostic Visit (Happy Path) ===\n');
  
  // Step 1: Get test data (patients, tests, doctors)
  console.log('Step 1: Fetching test data...');
  
  // Try to find any patient first
  const allPatients = await apiCall('GET', '/api/patients?limit=5');
  const tests = await apiCall('GET', '/api/lab-tests');
  const doctors = await apiCall('GET', '/api/referral-doctors');
  
  console.log('  - Total patients in DB:', allPatients.data?.length || 0);
  if (allPatients.data && allPatients.data.length > 0) {
    console.log('  - Sample patient:', allPatients.data[0]);
  }
  console.log('  - Lab tests available:', tests.data?.length || 0);
  console.log('  - Referral doctors:', doctors.data?.length || 0);
  
  if (!tests.ok || !doctors.ok) {
    console.error('  ❌ Failed to fetch test data');
    console.error('  - Tests:', tests);
    console.error('  - Doctors:', doctors);
    return;
  }
  
  // Step 2: Use existing patient or create new one
  let patientId;
  if (!allPatients.ok || allPatients.data.length === 0) {
    console.log('\nStep 2: Creating new patient...');
    const newPatient = await apiCall('POST', '/api/patients', {
      phone: '+919876543210',
      email: 'test.patient@example.com',
      name: 'Test Patient DV-01',
      age: 35,
      gender: 'male'
    });
    
    if (!newPatient.ok) {
      console.error('  ❌ Failed to create patient:', newPatient);
      return;
    }
    
    patientId = newPatient.data.id;
    console.log('  ✅ Patient created:', patientId);
  } else {
    patientId = allPatients.data[0].id;
    console.log('\nStep 2: Using existing patient:', patientId, allPatients.data[0].name);
  }
  
  // Step 3: Create diagnostic visit
  console.log('\nStep 3: Creating diagnostic visit...');
  const visitData = {
    patientId: patientId,
    tests: [
      {
        testId: tests.data[0].id,
        quantity: 1
      }
    ],
    referralDoctorId: doctors.data[0].id
  };
  
  console.log('  Request data:', JSON.stringify(visitData, null, 2));
  
  const visit = await apiCall('POST', '/api/visits/diagnostic', visitData);
  
  console.log('\n📊 RESULT:');
  console.log('  Status:', visit.status);
  console.log('  Success:', visit.ok);
  
  if (visit.ok) {
    console.log('  ✅ Visit created successfully!');
    console.log('  - Visit ID:', visit.data.id);
    console.log('  - Bill Number:', visit.data.billNumber);
    console.log('  - Status:', visit.data.status);
    console.log('  - Total Amount:', visit.data.totalAmountInPaise / 100, 'INR');
    
    // Return visit ID for further tests
    return visit.data.id;
  } else {
    console.log('  ❌ Visit creation failed');
    console.log('  Error:', visit.data);
  }
  
  console.log('\n=== TEST DV-01 COMPLETE ===');
  return visit.data?.id;
}

testDV01().then(visitId => {
  if (visitId) {
    console.log('\n🎯 Visit ID for next tests:', visitId);
  }
}).catch(console.error);
