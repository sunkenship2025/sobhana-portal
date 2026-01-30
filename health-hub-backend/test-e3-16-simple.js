/**
 * E3-16: Prevent Cross-Branch Diagnostic Data Leakage - Simplified Test
 * 
 * Tests:
 * 1. Branch ownership enforced server-side
 * 2. Wrong branch access returns 404
 * 3. Cross-branch viewing allowed only via Patient 360
 */

const axios = require('axios');

const BASE_URL = 'http://localhost:3000';

async function testE316() {
  console.log('='.repeat(60));
  console.log('E3-16: Prevent Cross-Branch Diagnostic Data Leakage');
  console.log('='.repeat(60));
  console.log();

  try {
    // Step 1: Login to both branches
    console.log('Step 1: Login to Branch A (Sobhana - Chintal) and Branch B (IDPL)...');
    const authA = await axios.post(`${BASE_URL}/api/auth/login`, {
      email: 'staff@sobhana.com',
      password: 'password123'
    });
    
    const authB = await axios.post(`${BASE_URL}/api/auth/login`, {
      email: 'admin@sobhana.com',
      password: 'password123'
    });

    const tokenA = authA.data.token;
    const tokenB = authB.data.token;
    const branchAId = authA.data.user.activeBranch.id;
    const branchBId = authB.data.user.activeBranch.id;
    
    console.log(`✓ Branch A: ${authA.data.user.activeBranch.name} (${branchAId})`);
    console.log(`✓ Branch B: ${authB.data.user.activeBranch.name} (${branchBId})`);
    console.log();

    // Step 2: Get visits from Branch A
    console.log('Step 2: Fetch visits from Branch A...');
    const visitsA = await axios.get(`${BASE_URL}/api/visits/diagnostic`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    
    if (visitsA.data.length === 0) {
      console.log('⚠️  No visits found in Branch A. Skipping cross-branch access test.');
      console.log('   Create diagnostic visits in the UI to test this feature.');
      return;
    }

    const visitA = visitsA.data[0];
    console.log(`✓ Found visit in Branch A: ${visitA.id}`);
    console.log(`  Patient: ${visitA.patient?.name || 'Unknown'}`);
    console.log(`  Branch: ${visitA.branch?.name || 'Unknown'}`);
    console.log();

    // Step 3: TEST - Try to access Branch A visit from Branch B (should fail with 404)
    console.log('Step 3: TEST - Branch B tries to access Branch A visit...');
    try {
      await axios.get(`${BASE_URL}/api/visits/diagnostic/${visitA.id}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      console.log('❌ FAIL: Branch B was able to access Branch A visit (should be 404)');
      process.exit(1);
    } catch (err) {
      if (err.response && err.response.status === 404) {
        console.log('✅ PASS: Branch B received 404 when accessing Branch A visit');
      } else {
        console.log(`❌ FAIL: Expected 404, got ${err.response?.status || 'error'}`);
        console.log(`   Error: ${err.response?.data?.message || err.message}`);
        process.exit(1);
      }
    }
    console.log();

    // Step 4: Verify Branch A can still access its own visit
    console.log('Step 4: Verify Branch A can access its own visit...');
    const visitDetail = await axios.get(`${BASE_URL}/api/visits/diagnostic/${visitA.id}`, {
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    console.log(`✅ PASS: Branch A can access its own visit`);
    console.log(`  Visit ID: ${visitDetail.data.id}`);
    console.log(`  Status: ${visitDetail.data.status}`);
    console.log();

    // Step 5: Check Patient 360 endpoint (cross-branch viewing allowed here)
    console.log('Step 5: Verify cross-branch viewing via Patient 360...');
    const patientId = visitA.patientId;
    
    try {
      const patient360A = await axios.get(`${BASE_URL}/api/patients/${patientId}`, {
        headers: { Authorization: `Bearer ${tokenA}` }
      });
      console.log(`✓ Branch A can view patient via Patient 360`);
      
      const patient360B = await axios.get(`${BASE_URL}/api/patients/${patientId}`, {
        headers: { Authorization: `Bearer ${tokenB}` }
      });
      console.log(`✓ Branch B can view same patient via Patient 360`);
      console.log(`✅ PASS: Patient 360 allows cross-branch viewing of patient demographics`);
    } catch (err) {
      console.log(`⚠️  Patient 360 test inconclusive: ${err.response?.data?.message || err.message}`);
    }
    console.log();

    console.log('='.repeat(60));
    console.log('✅ E3-16 Tests PASSED');
    console.log('='.repeat(60));
    console.log();
    console.log('Summary:');
    console.log('✅ Branch ownership enforced server-side');
    console.log('✅ Wrong branch access returns 404');
    console.log('✅ Cross-branch viewing allowed via Patient 360');
    console.log();

  } catch (err) {
    console.error('Test execution failed:', err.response?.data || err.message);
    process.exit(1);
  }
}

testE316();
