const axios = require('axios');

async function testPut() {
  try {
    // 1. First get the panel
    const res = await axios.get('http://localhost:3000/api/clinical-panels/FBSPLBS1');
    const panel = res.data;
    console.log("Before update:", panel.spacedDefinitionsGap);

    // 2. Put with spacedDefinitionsGap = 2
    const body = {
      ...panel,
      spacedDefinitionsGap: 2
    };
    
    // We might need an auth token if the route is protected
    // Let's assume we can hit it or we'll get a 401
    const putRes = await axios.put('http://localhost:3000/api/clinical-panels/' + panel.id, body);
    console.log("Put response status:", putRes.status);
    
    // 3. Get again to verify
    const verifyRes = await axios.get('http://localhost:3000/api/clinical-panels/' + panel.id);
    console.log("After update:", verifyRes.data.spacedDefinitionsGap);
    
  } catch (err) {
    console.error("Error:", err.response ? err.response.data : err.message);
  }
}

testPut();
