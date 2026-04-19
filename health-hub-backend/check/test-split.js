const STAFF_CREDS = {
  email: 'staff@sobhana.com',
  password: 'password123',
};

const BASE_URL = process.env.TEST_API_BASE_URL || 'http://localhost:3000/api';
let authToken = '';
let branchId = '';
let doctorId = '';
let patientId = '';

async function login() {
  const res = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(STAFF_CREDS),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("Login failed");
  authToken = data.token;
  branchId = data.user.branchId || (data.user.branches && data.user.branches[0]?.branchId) || data.branchId;
  if (!branchId) {
    const bRes = await fetch(`${BASE_URL}/branches`, { headers: { 'Authorization': `Bearer ${authToken}` } });
    const bData = await bRes.json();
    branchId = bData[0].id;
  }
}

async function prepareData() {
  let res = await fetch(`${BASE_URL}/patients?domain=CLINIC`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`, 'X-Branch-Id': branchId },
    body: JSON.stringify({
      name: "Split Test Patient", age: 30, gender: "M", identifiers: [{ type: "PHONE", value: "9999999999" }]
    })
  });
  let data = await res.json();
  if (!res.ok) {
     res = await fetch(`${BASE_URL}/patients/search?query=9999999999&domain=CLINIC`, { headers: { 'Authorization': `Bearer ${authToken}`, 'X-Branch-Id': branchId } });
     let sdata = await res.json();
     patientId = sdata.data[0].id;
  } else {
     patientId = data.id;
  }
  
  res = await fetch(`${BASE_URL}/clinic-doctors`, { headers: { 'Authorization': `Bearer ${authToken}`, 'X-Branch-Id': branchId } });
  data = await res.json();
  doctorId = data[0].id;
}

async function testClinicSplit() {
  const res = await fetch(`${BASE_URL}/visits/clinic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`, 'X-Branch-Id': branchId },
    body: JSON.stringify({
      patientId,
      doctorId,
      visitType: 'OP',
      paymentMode: 'SPLIT',
      payments: [{ type: "CASH", amount: 30 }, { type: "ONLINE", amount: 20 }],
      paidAmount: 50,
      revisitDecision: "VISIT",
      consultationFee: 50
    })
  });
  const data = await res.json();
  console.log("Clinic Visit:", data.error ? data : (data.paymentType + " -> " + JSON.stringify(data)));
  if (data.billNumber) {
    let getBill = await fetch(`${BASE_URL}/bills/CLINIC/${data.visitId || data.id}`, { headers: { 'Authorization': `Bearer ${authToken}`, 'X-Branch-Id': branchId } });
    if(getBill.ok) {
       console.log("Clinic Bill Endpoint:", JSON.stringify((await getBill.json()).payment));
    }
  }
}

async function testDiagnosticSplit() {
  let pRes = await fetch(`${BASE_URL}/billable-products`, { headers: { 'Authorization': `Bearer ${authToken}`, 'X-Branch-Id': branchId } });
  let pData = await pRes.json();
  let productId = pData.items ? pData.items[0]?.id : pData[0]?.id;
  
  if (!productId) {
    console.log("No billable products. Skipping diagnostic test.");
    return;
  }
  
  const res = await fetch(`${BASE_URL}/visits/diagnostic`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}`, 'X-Branch-Id': branchId },
    body: JSON.stringify({
      patientId,
      productIds: [productId],
      payments: [{ type: "CASH", amount: 50 }, { type: "ONLINE", amount: 50 }],
      paidAmount: 100,
      paymentMode: "SPLIT"
    })
  });
  const data = await res.json();
  console.log("Diagnostic Visit:", data.error ? data : (data.paymentType + " -> " + JSON.stringify(data)));
  
  if (data.id) {
    let getBill = await fetch(`${BASE_URL}/bills/DIAGNOSTICS/${data.id}`, { headers: { 'Authorization': `Bearer ${authToken}`, 'X-Branch-Id': branchId } });
    if(getBill.ok) {
       console.log("Diagnostics Bill Endpoint Data:", JSON.stringify((await getBill.json()).payment));
    }
  }
}

async function run() {
  console.log("Starting backend split payment flows test...");
  await login();
  await prepareData();
  await testClinicSplit();
  await testDiagnosticSplit();
}
run();
