const http = require('http');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6ImNtazJtY2M4eDAwMDcxZDlldHVsNXA2c2EiLCJlbWFpbCI6Im93bmVyQHNvYmhhbmEuY29tIiwicm9sZSI6Im93bmVyIiwiaWF0IjoxNzY3OTg3OTAzLCJleHAiOjE3NjgwNzQzMDN9.ZKGF0AkKBsxNjZSkIxQbngsUORTqEe_4vOqU2v_C9eo';
const visitId = 'cmk79q85q000911ve2r3ch3x7';

function fetchVisit() {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3000,
      path: `/api/visits/diagnostic/${visitId}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'X-Branch-Id': 'cmk2mcc2r00001d9esaynov48'
      }
    };
    
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(data) }));
    });
    
    req.on('error', reject);
    req.end();
  });
}

async function testReprintIdempotence() {
  console.log('=== RP-03: Reprint Idempotence Test ===');
  console.log('Fetching finalized visit 10 times concurrently...\n');
  
  const promises = [];
  for (let i = 0; i < 10; i++) {
    promises.push(fetchVisit().then(r => ({ index: i, ...r })));
  }
  
  const results = await Promise.all(promises);
  
  // Check all responses are identical
  const statuses = new Set(results.map(r => r.status));
  const billNumbers = new Set(results.map(r => r.data.billNumber));
  const reportStatuses = new Set(results.map(r => r.data.report?.currentVersion?.status));
  
  console.log('=== Results ===');
  console.log(`All responses: ${results.length}`);
  console.log(`Unique status codes: ${statuses.size} - ${[...statuses]}`);
  console.log(`Unique bill numbers: ${billNumbers.size} - ${[...billNumbers]}`);
  console.log(`Unique report statuses: ${reportStatuses.size} - ${[...reportStatuses]}`);
  
  console.log('\n=== ANALYSIS ===');
  if (statuses.size === 1 && statuses.has(200) && billNumbers.size === 1 && reportStatuses.size === 1) {
    console.log('✅ All responses identical - GET endpoint is idempotent');
    console.log('Print data would be consistent across multiple print requests');
  } else {
    console.log('❌ Responses differ - potential inconsistency');
  }
}

testReprintIdempotence();
