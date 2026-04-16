const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const BASE_URL = 'http://localhost:3000/api';
const TEST_USER = {
  email: 'staff@sobhana.com',
  password: 'password123',
};

let authToken = '';
let branchId = '';
let doctorId = '';

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
    body: JSON.stringify(TEST_USER),
  });

  if (!response.ok) {
    throw new Error(`Login failed with status ${response.status}`);
  }

  const data = await response.json();
  authToken = data.token;
  branchId = data.user.activeBranch.id;

  const doctor = await prisma.clinicDoctor.findFirst({
    where: { isActive: true },
    orderBy: { createdAt: 'asc' },
  });

  assert(doctor, 'No active clinic doctor found for revisit testing');
  doctorId = doctor.id;

  console.log(`✓ Logged in to branch ${branchId}`);
  console.log(`✓ Using clinic doctor ${doctor.name} (${doctor.id})`);
}

async function createTestPatient(label) {
  const timestamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  return prisma.patient.create({
    data: {
      patientNumber: `RV-${timestamp}`,
      name: `Clinic Revisit ${label} ${timestamp}`,
      yearOfBirth: 1993,
      ageUnit: 'YEARS',
      gender: 'F',
      identifiers: {
        create: [
          {
            type: 'PHONE',
            value: `9${timestamp.slice(-9)}`,
            isPrimary: true,
          },
        ],
      },
    },
    include: {
      identifiers: true,
    },
  });
}

async function createClinicVisit({
  patientId,
  consultationFee = 500,
  revisitDecision = 'AUTO',
  paymentType,
  paymentStatus,
}) {
  const body = {
    patientId,
    doctorId,
    visitType: 'OP',
    consultationFee,
    revisitDecision,
  };

  if (paymentType) body.paymentType = paymentType;
  if (paymentStatus) body.paymentStatus = paymentStatus;

  return api('/visits/clinic', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

async function completeClinicVisit(visitId) {
  return api(`/visits/clinic/${visitId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status: 'COMPLETED' }),
  });
}

async function cancelClinicVisit(visitId) {
  return api(`/visits/clinic/${visitId}`, {
    method: 'DELETE',
  });
}

async function getRevisitContext(patientId) {
  return api(`/visits/clinic/revisit-context?patientId=${patientId}&doctorId=${doctorId}`);
}

async function verifyReachableRouteAndEmptyState() {
  console.log('\n1. Route reachable and empty context');

  const patient = await createTestPatient('Route');
  const { response, payload } = await getRevisitContext(patient.id);

  assert(response.ok, 'Expected revisit-context route to be reachable');
  assert(payload.defaultMode === 'VISIT', 'Expected first-time patient default mode to be VISIT');
  assert(payload.anchorVisit === null, 'Expected no anchor visit for first-time patient');

  console.log('✓ revisit-context route is reachable');
  console.log('✓ first-time patient returns VISIT with no anchor');
}

async function verifyEligibleAnchorAndAutoRevisit() {
  console.log('\n2. Eligible anchor and AUTO revisit with no bill');

  const patient = await createTestPatient('Eligible');

  const anchorCreate = await createClinicVisit({
    patientId: patient.id,
    consultationFee: 500,
    paymentType: 'CASH',
    paymentStatus: 'PAID',
  });

  assert(anchorCreate.response.ok, `Failed to create anchor visit: ${anchorCreate.payload?.message}`);
  assert(anchorCreate.payload.hasBill === true, 'Anchor visit should create a bill');
  assert(anchorCreate.payload.billNumber, 'Anchor visit should expose a bill number');

  const anchorVisitId = anchorCreate.payload.id;

  const anchorComplete = await completeClinicVisit(anchorVisitId);
  assert(anchorComplete.response.ok, `Failed to complete anchor visit: ${anchorComplete.payload?.message}`);

  const eligibleContext = await getRevisitContext(patient.id);
  assert(eligibleContext.response.ok, 'Expected revisit-context after anchor to succeed');
  assert(eligibleContext.payload.eligible === true, 'Expected anchor to qualify inside revisit window');
  assert(eligibleContext.payload.defaultMode === 'REVISIT', 'Expected default mode REVISIT inside window');
  assert(
    eligibleContext.payload.anchorVisit?.id === anchorVisitId,
    'Expected anchorVisit to point to the completed paid consultation',
  );

  const autoRevisit = await createClinicVisit({
    patientId: patient.id,
    consultationFee: 500,
    revisitDecision: 'AUTO',
  });

  assert(autoRevisit.response.ok, `AUTO revisit failed: ${autoRevisit.payload?.message}`);
  assert(autoRevisit.payload.isRevisit === true, 'AUTO should create a revisit when eligible');
  assert(autoRevisit.payload.hasBill === false, 'AUTO revisit should not create a bill');
  assert(autoRevisit.payload.billNumber === null, 'Revisit response should not expose a new bill number');
  assert(autoRevisit.payload.originalVisitId === anchorVisitId, 'Revisit should link back to original visit');

  const revisitBill = await prisma.bill.findFirst({
    where: { visitId: autoRevisit.payload.id },
  });
  assert(!revisitBill, 'Revisit visit should have no Bill row');

  const revisitComplete = await completeClinicVisit(autoRevisit.payload.id);
  assert(revisitComplete.response.ok, `Failed to complete revisit: ${revisitComplete.payload?.message}`);

  const contextAfterCompletedRevisit = await getRevisitContext(patient.id);
  assert(contextAfterCompletedRevisit.response.ok, 'Expected revisit-context after revisit to succeed');
  assert(
    contextAfterCompletedRevisit.payload.anchorVisit?.id === anchorVisitId,
    'Completed revisit must not become the new revisit anchor',
  );

  console.log(`✓ paid completed visit ${anchorCreate.payload.visitRef} is the anchor`);
  console.log('✓ AUTO creates a revisit with no bill row');
  console.log('✓ completed revisit is excluded from future anchor selection');

  return { patientId: patient.id, anchorVisitId };
}

async function verifyForceNormalInsideWindow(patientId) {
  console.log('\n3. FORCE_NORMAL inside window keeps a billed visit');

  const forcedNormal = await createClinicVisit({
    patientId,
    consultationFee: 650,
    revisitDecision: 'FORCE_NORMAL',
    paymentType: 'ONLINE',
    paymentStatus: 'PAID',
  });

  assert(forcedNormal.response.ok, `FORCE_NORMAL failed: ${forcedNormal.payload?.message}`);
  assert(forcedNormal.payload.isRevisit === false, 'FORCE_NORMAL should create a normal visit');
  assert(forcedNormal.payload.hasBill === true, 'FORCE_NORMAL should still create a bill');
  assert(forcedNormal.payload.billNumber, 'FORCE_NORMAL response should include a bill number');

  console.log(`✓ FORCE_NORMAL created billed visit ${forcedNormal.payload.billNumber}`);
}

async function verifyInvalidCandidatesDoNotQualify() {
  console.log('\n4. Unpaid, open, and cancelled visits do not qualify');

  const patient = await createTestPatient('InvalidStates');

  const unpaid = await createClinicVisit({
    patientId: patient.id,
    consultationFee: 400,
    paymentType: 'CASH',
    paymentStatus: 'PENDING',
  });
  assert(unpaid.response.ok, `Unpaid visit creation failed: ${unpaid.payload?.message}`);
  const unpaidComplete = await completeClinicVisit(unpaid.payload.id);
  assert(unpaidComplete.response.ok, `Completing unpaid visit failed: ${unpaidComplete.payload?.message}`);

  const waitingPaid = await createClinicVisit({
    patientId: patient.id,
    consultationFee: 420,
    paymentType: 'ONLINE',
    paymentStatus: 'PAID',
  });
  assert(waitingPaid.response.ok, `Waiting paid visit failed: ${waitingPaid.payload?.message}`);

  const cancelledPaid = await createClinicVisit({
    patientId: patient.id,
    consultationFee: 430,
    paymentType: 'CASH',
    paymentStatus: 'PAID',
  });
  assert(cancelledPaid.response.ok, `Cancelled visit creation failed: ${cancelledPaid.payload?.message}`);
  const cancelRes = await cancelClinicVisit(cancelledPaid.payload.id);
  assert(cancelRes.response.ok, `Cancelling visit failed: ${cancelRes.payload?.message}`);

  const context = await getRevisitContext(patient.id);
  assert(context.response.ok, 'Expected revisit-context for invalid candidates to succeed');
  assert(context.payload.defaultMode === 'VISIT', 'Invalid candidates must not unlock revisit');
  assert(context.payload.anchorVisit === null, 'Invalid candidates must not create an anchor');

  console.log('✓ unpaid completed visit ignored');
  console.log('✓ waiting paid visit ignored');
  console.log('✓ cancelled visit ignored');
}

async function verifyForceRevisitOutsideWindow(patientId, anchorVisitId) {
  console.log('\n5. FORCE_REVISIT works outside the window when an anchor exists');

  const pastDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await prisma.visit.update({
    where: { id: anchorVisitId },
    data: { createdAt: pastDate },
  });
  await prisma.bill.update({
    where: { visitId: anchorVisitId },
    data: { billedAt: pastDate },
  });

  const expiredContext = await getRevisitContext(patientId);
  assert(expiredContext.response.ok, 'Expired revisit-context lookup failed');
  assert(expiredContext.payload.eligible === false, 'Anchor should be outside the revisit window now');
  assert(expiredContext.payload.defaultMode === 'VISIT', 'Expired anchor should default back to VISIT');
  assert(expiredContext.payload.canForceRevisit === true, 'Existing anchor should still allow FORCE_REVISIT');

  const forcedRevisit = await createClinicVisit({
    patientId,
    consultationFee: 500,
    revisitDecision: 'FORCE_REVISIT',
  });

  assert(forcedRevisit.response.ok, `FORCE_REVISIT failed: ${forcedRevisit.payload?.message}`);
  assert(forcedRevisit.payload.isRevisit === true, 'FORCE_REVISIT should create a revisit');
  assert(forcedRevisit.payload.hasBill === false, 'FORCE_REVISIT should not create a bill');

  console.log('✓ expired anchor defaults to VISIT but still allows manual revisit');
  console.log('✓ FORCE_REVISIT created a no-bill revisit outside the default window');
}

async function verifyFirstVisitCannotForceRevisit() {
  console.log('\n6. First visit cannot be forced into revisit');

  const patient = await createTestPatient('FirstVisit');

  const forcedRevisit = await createClinicVisit({
    patientId: patient.id,
    consultationFee: 500,
    revisitDecision: 'FORCE_REVISIT',
  });

  assert(
    forcedRevisit.response.status === 400,
    `Expected FORCE_REVISIT on first visit to fail with 400, got ${forcedRevisit.response.status}`,
  );
  assert(
    String(forcedRevisit.payload?.message || '').includes('prior paid clinic consultation'),
    'Expected first-visit FORCE_REVISIT error to mention prior paid consultation',
  );

  console.log('✓ first visit cannot be forced into revisit mode');
}

async function main() {
  try {
    console.log('=== CLINIC REVISIT FLOW REGRESSION TEST ===');
    await login();
    await verifyReachableRouteAndEmptyState();
    const eligibleScenario = await verifyEligibleAnchorAndAutoRevisit();
    await verifyForceNormalInsideWindow(eligibleScenario.patientId);
    await verifyInvalidCandidatesDoNotQualify();
    await verifyForceRevisitOutsideWindow(
      eligibleScenario.patientId,
      eligibleScenario.anchorVisitId,
    );
    await verifyFirstVisitCannotForceRevisit();
    console.log('\n✅ All clinic revisit flow checks passed');
  } catch (error) {
    console.error('\n❌ Clinic revisit flow regression failed');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main();
