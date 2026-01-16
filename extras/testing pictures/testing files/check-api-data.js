// Test data verification script
const TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNtazJtY2M4djAwMDUxZDllcjBhaXA5cTEiLCJlbWFpbCI6InN0YWZmQHNvYmhhbmEuY29tIiwicm9sZSI6InN0YWZmIiwiaWF0IjoxNzY3OTgyMzIyLCJleHAiOjE3NjgwNjg3MjJ9.P1YiRue6onhYuFwnKSk8aGcQTZbEKPewC4Ai9h9BSag";
const BASE_URL = "http://localhost:3000";

async function fetchData(endpoint, branchId = null) {
  const headers = {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  };
  
  if (branchId) {
    headers['X-Branch-Id'] = branchId;
  }
  
  const response = await fetch(`${BASE_URL}${endpoint}`, { headers });
  if (!response.ok) {
    return { error: response.status, message: await response.text() };
  }
  return await response.json();
}

async function checkTestData() {
  console.log('=== CHECKING TEST DATA ===\n');
  
  // Check patients
  console.log('1. PATIENTS:');
  const patientsSearch = await fetchData('/api/patients/search?phone=');
  console.log('  - Search endpoint status:', patientsSearch.error || 'OK');
  
  // Check referral doctors
  console.log('\n2. REFERRAL DOCTORS:');
  const doctors = await fetchData('/api/referral-doctors');
  if (doctors.error) {
    console.log('  - Error:', doctors.message);
  } else {
    console.log('  - Count:', doctors.length || 0);
    if (doctors.length > 0) {
      console.log('  - Sample:', doctors[0]);
    }
  }
  
  // Check lab tests
  console.log('\n3. LAB TESTS:');
  const tests = await fetchData('/api/lab-tests');
  if (tests.error) {
    console.log('  - Error:', tests.message);
  } else {
    console.log('  - Count:', tests.length || 0);
    if (tests.length > 0) {
      console.log('  - Sample:', tests[0]);
    }
  }
  
  console.log('\n=== TEST DATA CHECK COMPLETE ===');
}

checkTestData().catch(console.error);
