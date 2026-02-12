/**
 * E3-10: Test Report Rendering System
 * 
 * Creates a test visit with lab tests and finalized report,
 * then attempts to render it via the report access routes.
 */

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const BASE_URL = 'http://localhost:3000';
const BRANCH_ID = process.argv[2] || 'clxxx'; // Pass branch ID as argument

async function main() {
  console.log('\n🧪 E3-10: Testing Report Rendering System\n');

  // 1. Find or create test patient
  console.log('1️⃣ Finding test patient...');
  let patient = await prisma.patient.findFirst({
    where: { branchId: BRANCH_ID },
    select: { id: true, name: true, patientNumber: true },
  });

  if (!patient) {
    console.log('   ❌ No patient found. Creating test patient...');
    patient = await prisma.patient.create({
      data: {
        branchId: BRANCH_ID,
        patientNumber: 'TEST-E310-001',
        name: 'Test Patient for Reports',
        phone: '9876543210',
        gender: 'M',
        age: 35,
      },
      select: { id: true, name: true, patientNumber: true },
    });
    console.log(`   ✅ Created patient: ${patient.patientNumber}`);
  } else {
    console.log(`   ✅ Using patient: ${patient.name} (${patient.patientNumber})`);
  }

  // 2. Find lab tests to include
  console.log('\n2️⃣ Finding lab tests...');
  const labTests = await prisma.labTest.findMany({
    where: { branchId: BRANCH_ID, isActive: true },
    take: 5,
    select: { id: true, testName: true, code: true, price: true },
  });

  if (labTests.length === 0) {
    console.log('   ❌ No lab tests found. Please seed lab tests first.');
    return;
  }

  console.log(`   ✅ Found ${labTests.length} lab tests:`, labTests.map(t => t.code).join(', '));

  // 3. Create diagnostic visit
  console.log('\n3️⃣ Creating diagnostic visit...');
  const visitNumber = `VD-TEST-${Date.now()}`;
  
  const visit = await prisma.visit.create({
    data: {
      branchId: BRANCH_ID,
      domain: 'DIAGNOSTICS',
      visitNumber,
      status: 'IN_PROGRESS',
      patientId: patient.id,
      orderedTests: {
        create: labTests.map(t => ({
          labTestId: t.id,
          price: t.price || 100,
          status: 'PENDING',
        })),
      },
      report: {
        create: {
          branchId: BRANCH_ID,
          versions: {
            create: {
              versionNum: 1,
              status: 'DRAFT',
              results: {
                create: labTests.map((t, index) => ({
                  labTestId: t.id,
                  value: (index + 1) * 10.5, // Sample values
                  notes: null,
                })),
              },
            },
          },
        },
      },
    },
    include: {
      report: {
        include: {
          versions: true,
        },
      },
    },
  });

  console.log(`   ✅ Created visit: ${visitNumber}`);
  console.log(`   📋 Report version ID: ${visit.report?.versions[0]?.id}`);

  // 4. Finalize the report (this should create snapshot + token)
  console.log('\n4️⃣ Finalizing report...');
  const reportVersionId = visit.report?.versions[0]?.id;

  if (!reportVersionId) {
    console.log('   ❌ No report version found');
    return;
  }

  // Simulate finalization
  await prisma.reportVersion.update({
    where: { id: reportVersionId },
    data: {
      status: 'FINALIZED',
      finalizedAt: new Date(),
    },
  });

  // Create snapshot (simplified for test)
  const snapshotData = {
    patient: {
      name: patient.name,
      patientNumber: patient.patientNumber,
      age: 35,
      gender: 'M',
    },
    visit: {
      visitNumber,
      billNumber: visitNumber,
      branchName: 'Test Branch',
      createdAt: new Date().toISOString(),
    },
    departments: [
      {
        departmentName: 'BIOCHEMISTRY',
        departmentHeaderText: 'BIOCHEMISTRY DEPARTMENT',
        panels: [
          {
            panelName: 'TEST-PANEL',
            displayName: 'Test Results',
            layoutType: 'STANDARD_TABLE',
            tests: labTests.map((t, i) => ({
              testCode: t.code,
              testName: t.testName,
              value: (i + 1) * 10.5,
              referenceUnit: 'mg/dL',
              referenceMin: 5,
              referenceMax: 100,
              flag: (i + 1) * 10.5 > 100 ? 'HIGH' : null,
            })),
          },
        ],
      },
    ],
    signatures: [
      {
        doctorName: 'Dr. Test Doctor',
        degrees: 'MD, DMLT',
        designation: 'Pathologist',
        signatureImagePath: '/images/signatures/test.png',
        registrationNumber: 'TEST-123',
        showLabInchargeNote: true,
      },
    ],
  };

  // Save snapshot
  await prisma.reportVersion.update({
    where: { id: reportVersionId },
    data: {
      panelsSnapshot: snapshotData.departments,
      signaturesSnapshot: snapshotData.signatures,
      patientSnapshot: snapshotData.patient,
      visitSnapshot: snapshotData.visit,
    },
  });

  // Create access token
  const token = generateToken();
  await prisma.reportAccessToken.create({
    data: {
      token,
      reportVersionId,
      expiresAt: null, // Never expires
    },
  });

  console.log(`   ✅ Report finalized`);
  console.log(`   🔑 Access token: ${token}`);

  // 5. Print test URLs
  console.log('\n5️⃣ Test URLs:');
  console.log(`   📄 View Report:     ${BASE_URL}/r/${token}`);
  console.log(`   📥 Download PDF:    ${BASE_URL}/r/${token}/pdf`);
  console.log(`   🖨️ Physical Print:  ${BASE_URL}/r/${token}/pdf/physical`);

  // 6. Cleanup
  console.log('\n✅ Test setup complete!');
  console.log('   Start the server and visit the URLs above to test.\n');
}

function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 12; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
