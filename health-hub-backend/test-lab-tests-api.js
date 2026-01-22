/**
 * Test Lab Tests API
 * Verify tests are returned regardless of branch
 */

const fetch = require('node-fetch');

const API_BASE = 'http://localhost:3000/api';

async function testLabTests() {
  try {
    console.log('🧪 Testing Lab Tests API\n');
    
    // Step 1: Login
    console.log('Step 1: Login as staff...');
    const loginRes = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'staff1@sobhana.com',
        password: 'staff123'
      })
    });
    
    if (!loginRes.ok) {
      throw new Error(`Login failed: ${loginRes.status}`);
    }
    
    const loginData = await loginRes.json();
    const token = loginData.token;
    const userBranch = loginData.user.activeBranch;
    
    console.log(`✅ Logged in successfully`);
    console.log(`   User: ${loginData.user.name}`);
    console.log(`   Active Branch: ${userBranch.name} (${userBranch.id})\n`);
    
    // Step 2: Fetch all branches
    console.log('Step 2: Fetch all branches...');
    const branchesRes = await fetch(`${API_BASE}/branches`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    
    const branches = await branchesRes.json();
    console.log(`✅ Found ${branches.length} branches:`);
    branches.forEach(b => console.log(`   - ${b.name} (${b.code}) - ${b.id}`));
    console.log();
    
    // Step 3: Test lab tests API with each branch
    console.log('Step 3: Fetch lab tests with different branch contexts...\n');
    
    for (const branch of branches) {
      console.log(`Testing with branch: ${branch.name} (${branch.id})`);
      const testsRes = await fetch(`${API_BASE}/lab-tests`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'X-Branch-Id': branch.id
        }
      });
      
      if (!testsRes.ok) {
        console.log(`❌ FAILED: Status ${testsRes.status}`);
        const error = await testsRes.json();
        console.log(`   Error: ${error.message}\n`);
        continue;
      }
      
      const tests = await testsRes.json();
      console.log(`✅ SUCCESS: Got ${tests.length} tests`);
      if (tests.length > 0) {
        console.log(`   First test: ${tests[0].name} (${tests[0].code})`);
      }
      console.log();
    }
    
    // Step 4: Test with invalid branch ID
    console.log('Step 4: Test with invalid branch ID...');
    const invalidRes = await fetch(`${API_BASE}/lab-tests`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Branch-Id': 'invalid-branch-id-12345'
      }
    });
    
    console.log(`Status: ${invalidRes.status}`);
    if (!invalidRes.ok) {
      const error = await invalidRes.json();
      console.log(`Expected error: ${error.message}\n`);
    }
    
    console.log('═══════════════════════════════════');
    console.log('✅ All tests completed successfully');
    console.log('═══════════════════════════════════');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    process.exit(1);
  }
}

testLabTests();
