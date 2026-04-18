let STAFF_CREDS = {
  email: 'staff@sobhana.com',
  password: 'password123',
};

try {
  const authConfig = require('./authTestConfig');
  if (authConfig?.STAFF_CREDS?.email && authConfig?.STAFF_CREDS?.password) {
    STAFF_CREDS = authConfig.STAFF_CREDS;
  }
} catch (_) {
  // Fall back to the seeded local dev credentials above.
}

const BASE_URL = process.env.TEST_API_BASE_URL || 'http://localhost:3000/api';

let authToken = '';
let branchId = '';
const createdProductIds = [];

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function headers() {
  return {
    Authorization: `Bearer ${authToken}`,
    'Content-Type': 'application/json',
    'X-Branch-Id': branchId,
  };
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      ...headers(),
      ...(options.headers || {}),
    },
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch (_) {
    payload = null;
  }

  return { response, payload };
}

async function login() {
  const response = await fetch(`${BASE_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(STAFF_CREDS),
  });

  if (!response.ok) {
    throw new Error(`Login failed with status ${response.status}`);
  }

  const data = await response.json();
  authToken = data.token;
  branchId = data.user.activeBranch.id;

  console.log(`✓ Logged in to branch ${branchId}`);
}

async function createTestPatient(label) {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const { response, payload } = await api('/patients', {
    method: 'POST',
    body: JSON.stringify({
      name: `Diagnostics Bill Only ${label}`,
      age: 32,
      ageUnit: 'YEARS',
      gender: 'M',
      identifiers: [
        {
          type: 'PHONE',
          value: `9${stamp.slice(-9)}`,
          isPrimary: true,
        },
      ],
      whatsappOptIn: false,
    }),
  });

  assert(response.ok, `Failed to create test patient: ${payload?.message}`);
  return payload;
}

async function createBillOnlyProductViaConfig() {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const { response, payload } = await api('/billable-products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Bill Only Config Test',
      code: `BOCFG_${stamp.slice(-8)}`,
      productType: 'INDIVIDUAL_TEST',
      workflowMode: 'BILL_ONLY',
      basePrice: 275,
      panels: [],
    }),
  });

  assert(response.ok, `Failed to create config-center bill-only product: ${payload?.message}`);
  assert(payload.workflowMode === 'BILL_ONLY', 'Config product should persist BILL_ONLY workflow');
  createdProductIds.push(payload.id);
  return payload;
}

async function quickCreateBillOnlyProduct() {
  const { response, payload } = await api('/billable-products/quick-create-bill-only', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Quick Bill Only Test',
      basePrice: 125,
      description: 'Quick inline product for diagnostics flow test',
    }),
  });

  assert(response.ok, `Failed to quick-create bill-only product: ${payload?.message}`);
  assert(payload.workflowMode === 'BILL_ONLY', 'Quick-create should return BILL_ONLY workflow');
  assert(payload.code, 'Quick-created product should have generated code');
  createdProductIds.push(payload.id);
  return payload;
}

async function findOrCreateReportableProduct() {
  const listedProducts = await api('/billable-products?workflowMode=REPORTABLE');
  assert(listedProducts.response.ok, `Failed to list reportable products: ${listedProducts.payload?.message}`);

  for (const product of listedProducts.payload || []) {
    const detail = await api(`/billable-products/${product.id}`);
    if (
      detail.response.ok &&
      Array.isArray(detail.payload?.panels) &&
      detail.payload.panels.some((panelLink) => (panelLink.panel?.items?.length ?? 0) > 0)
    ) {
      return detail.payload;
    }
  }

  const clinicalPanels = await api('/clinical-panels');
  assert(clinicalPanels.response.ok, `Failed to list clinical panels: ${clinicalPanels.payload?.message}`);
  const panel = (clinicalPanels.payload || []).find((candidate) => (candidate.itemCount ?? 0) > 0);

  assert(panel, 'No clinical panel with items found to build a reportable product');

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const { response, payload } = await api('/billable-products', {
    method: 'POST',
    body: JSON.stringify({
      name: 'Reportable Product Test',
      code: `RPT_${stamp.slice(-8)}`,
      productType: 'INDIVIDUAL_TEST',
      workflowMode: 'REPORTABLE',
      basePrice: 450,
      panels: [{ panelId: panel.id, displayOrder: 0 }],
    }),
  });

  assert(response.ok, `Failed to create reportable product: ${payload?.message}`);
  createdProductIds.push(payload.id);
  return payload;
}

async function deactivateCreatedProducts() {
  if (!authToken || createdProductIds.length === 0) {
    return;
  }

  await Promise.all(
    createdProductIds.map(async (productId) => {
      const { response } = await api(`/billable-products/${productId}`, {
        method: 'PATCH',
        body: JSON.stringify({ isActive: false }),
      });

      if (!response.ok) {
        console.warn(`Failed to deactivate temporary product ${productId}`);
      }
    })
  );
}

async function createDiagnosticVisit(patientId, productIds) {
  return api('/visits/diagnostic', {
    method: 'POST',
    body: JSON.stringify({
      patientId,
      productIds,
      paymentType: 'CASH',
      paymentStatus: 'PAID',
      sendWhatsApp: false,
    }),
  });
}

async function getVisit(visitId) {
  return api(`/visits/diagnostic/${visitId}`);
}

async function saveDraftResults(visit) {
  const reportableOrders = (visit.testOrders || []).filter((order) => order.workflowMode !== 'BILL_ONLY');
  const results = [];

  for (const order of reportableOrders) {
    const isTextLayout =
      order.panel?.layoutType === 'TEXT_ONLY' ||
      order.panel?.layoutType === 'IMAGING_NARRATIVE';

    if (order.isPanel && Array.isArray(order.childTests) && order.childTests.length > 0) {
      for (const child of order.childTests) {
        if (child.isDerived) continue;
        results.push({
          testId: child.id,
          value: isTextLayout ? null : (child.referenceRange?.min || 1),
          textValue: isTextLayout ? 'Normal' : null,
          flag: isTextLayout ? null : 'NORMAL',
          notes: null,
          manualOverride: false,
        });
      }
      continue;
    }

    if (order.isDerived) continue;

    results.push({
      testId: order.testId,
      value: isTextLayout ? null : (order.referenceRange?.min || 1),
      textValue: isTextLayout ? 'Normal' : null,
      flag: isTextLayout ? null : 'NORMAL',
      notes: null,
      manualOverride: false,
    });
  }

  assert(results.length > 0, 'Expected at least one concrete reportable test to save');

  const { response, payload } = await api(`/visits/diagnostic/${visit.id}/results`, {
    method: 'POST',
    body: JSON.stringify({ results }),
  });

  assert(response.ok, `Failed to save draft results: ${payload?.message}`);
}

async function finalizeVisit(visitId) {
  const { response, payload } = await api(`/visits/diagnostic/${visitId}/finalize`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  assert(response.ok, `Failed to finalize reportable visit: ${payload?.message}`);
}

async function confirmBillOnlyVisit(visitId) {
  const { response, payload } = await api(`/visits/diagnostic/${visitId}/confirm-ready`, {
    method: 'POST',
    body: JSON.stringify({}),
  });

  assert(response.ok, `Failed to confirm bill-only visit: ${payload?.message}`);
  assert(payload.status === 'COMPLETED', 'Confirm-ready should complete the bill-only visit');
}

async function verifyBillOnlyConfigFlow() {
  console.log('\n1. Config-center BILL_ONLY product creates WAITING visit with confirm-ready action');

  const patient = await createTestPatient('ConfigFlow');
  const product = await createBillOnlyProductViaConfig();
  console.log('  - creating pure bill-only visit');
  const { response, payload } = await createDiagnosticVisit(patient.id, [product.id]);

  assert(response.ok, `Failed to create pure bill-only visit: ${payload?.message}`);
  assert(payload.status === 'WAITING', 'Pure bill-only visit should start in WAITING');
  assert(payload.hasBillOnlyOrders === true, 'Pure bill-only visit should expose hasBillOnlyOrders');
  assert(payload.hasReportableOrders === false, 'Pure bill-only visit should not expose reportable orders');
  assert(payload.nextAction === 'CONFIRM_READY', 'Pure bill-only visit should expose CONFIRM_READY');

  console.log('  - loading pure bill-only detail');
  const detail = await getVisit(payload.id);
  assert(detail.response.ok, 'Expected detail fetch for pure bill-only visit to succeed');
  assert(detail.payload.nextAction === 'CONFIRM_READY', 'Visit detail should expose CONFIRM_READY');
  assert(Array.isArray(detail.payload.billItems) && detail.payload.billItems.length === 1, 'Bill-only visit should expose grouped bill items');
  assert(detail.payload.report === null, 'Pure bill-only visit should not create a report payload');
  assert(
    detail.payload.testOrders.every((order) => order.workflowMode === 'BILL_ONLY'),
    'Pure bill-only visit detail should expose BILL_ONLY workflow on each order'
  );

  console.log('  - confirming pure bill-only ready state');
  await confirmBillOnlyVisit(payload.id);

  console.log('  - loading completed pure bill-only detail');
  const completedDetail = await getVisit(payload.id);
  assert(completedDetail.response.ok, 'Expected completed bill-only visit detail to load');
  assert(completedDetail.payload.status === 'COMPLETED', 'Bill-only detail should show COMPLETED after confirm-ready');
  assert(completedDetail.payload.hasFinalizedReport === false, 'Bill-only completion must not create a finalized report');
  assert(completedDetail.payload.report === null, 'Completed pure bill-only visit must remain reportless');

  const completedVisits = await api('/visits/diagnostic?status=COMPLETED');
  assert(completedVisits.response.ok, 'Completed diagnostics list should load');
  const completedListEntry = completedVisits.payload.find((visit) => visit.id === payload.id);
  assert(completedListEntry?.hasFinalizedReport === false, 'Completed pure bill-only visit must stay reportless in listings');

  console.log(`✓ ${product.code} billed without panels`);
  console.log('✓ pure bill-only visits stay in WAITING and move to COMPLETED via confirm-ready');
}

async function verifyQuickCreateAndMixedFlow() {
  console.log('\n2. Quick-create BILL_ONLY product persists and mixed visit stays on reportable flow');

  const patient = await createTestPatient('MixedFlow');
  const quickProduct = await quickCreateBillOnlyProduct();
  const quickProductDetail = await api(`/billable-products/${quickProduct.id}`);
  assert(quickProductDetail.response.ok, 'Quick-created bill-only product should persist in catalog');

  const reportableProduct = await findOrCreateReportableProduct();
  console.log('  - creating mixed visit');
  const mixedVisitCreate = await createDiagnosticVisit(patient.id, [reportableProduct.id, quickProduct.id]);

  assert(mixedVisitCreate.response.ok, `Failed to create mixed visit: ${mixedVisitCreate.payload?.message}`);
  assert(mixedVisitCreate.payload.status === 'DRAFT', 'Mixed visit should stay on DRAFT reportable lifecycle');
  assert(mixedVisitCreate.payload.hasReportableOrders === true, 'Mixed visit should expose reportable orders');
  assert(mixedVisitCreate.payload.hasBillOnlyOrders === true, 'Mixed visit should expose bill-only orders');
  assert(mixedVisitCreate.payload.nextAction === 'ENTER_RESULTS', 'Mixed visit should continue with ENTER_RESULTS');

  console.log('  - loading mixed visit detail');
  const mixedVisitDetail = await getVisit(mixedVisitCreate.payload.id);
  assert(mixedVisitDetail.response.ok, 'Mixed visit detail should load');
  console.log('  - saving mixed visit draft results');
  await saveDraftResults(mixedVisitDetail.payload);
  console.log('  - finalizing mixed visit');
  await finalizeVisit(mixedVisitCreate.payload.id);

  console.log('  - loading finalized mixed visit detail');
  const finalizedDetail = await getVisit(mixedVisitCreate.payload.id);
  assert(finalizedDetail.response.ok, 'Finalized mixed visit detail should load');
  assert(finalizedDetail.payload.hasFinalizedReport === true, 'Mixed visit should expose finalized report after finalize');
  assert(finalizedDetail.payload.nextAction === 'NONE', 'Finalized mixed visit should have no next action');

  const completedVisits = await api('/visits/diagnostic?status=COMPLETED');
  assert(completedVisits.response.ok, 'Completed visit listing should succeed');

  const pureBillOnlyCompleted = completedVisits.payload.find((visit) => visit.id === mixedVisitCreate.payload.id);
  assert(pureBillOnlyCompleted?.hasFinalizedReport === true, 'Completed mixed visit should remain report-backed');

  console.log('✓ quick-create bill-only product becomes reusable catalog data');
  console.log('✓ mixed visits keep result entry + finalize flow while retaining bill-only items on the bill');
}

async function main() {
  try {
    await login();
    await verifyBillOnlyConfigFlow();
    await verifyQuickCreateAndMixedFlow();
    console.log('\nDiagnostics BILL_ONLY workflow checks passed');
  } catch (error) {
    console.error('\nDiagnostics BILL_ONLY workflow checks failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await deactivateCreatedProducts();
  }
}

main();
