const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function createTestData() {
  console.log('Creating test data for report testing...\n');

  try {
    // Get John Smith patient (first patient created)
    const patient = await prisma.patient.findFirst({
      where: { name: 'John Smith' }
    });

    if (!patient) {
      console.error('Patient not found');
      return;
    }

    // Get branches
    const madhapur = await prisma.branch.findFirst({ where: { code: 'MPR' } });
    const kukatpally = await prisma.branch.findFirst({ where: { code: 'KPY' } });

    // Get a test
    const cbcTest = await prisma.labTest.findFirst({ where: { code: 'CBC' } });

    if (!cbcTest) {
      console.error('CBC test not found');
      return;
    }

    // Create a diagnostic visit with RESULTS_PENDING status
    console.log('1. Creating visit with RESULTS_PENDING status...');
    const billNumber = `D-${madhapur.code}-TEST-01`;
    
    const pendingVisit = await prisma.visit.create({
      data: {
        branchId: madhapur.id,
        patientId: patient.id,
        domain: 'DIAGNOSTICS',
        status: 'RESULTS_PENDING',
        billNumber,
        totalAmountInPaise: cbcTest.priceInPaise,
      },
    });

    await prisma.bill.create({
      data: {
        visitId: pendingVisit.id,
        billNumber,
        branchId: madhapur.id,
        totalAmountInPaise: cbcTest.priceInPaise,
        paymentType: 'CASH',
        paymentStatus: 'PAID',
      },
    });

    const testOrder = await prisma.testOrder.create({
      data: {
        visitId: pendingVisit.id,
        testId: cbcTest.id,
        branchId: madhapur.id,
        priceInPaise: cbcTest.priceInPaise,
        referralCommissionPercentage: 10,
      },
    });

    const report = await prisma.diagnosticReport.create({
      data: {
        visitId: pendingVisit.id,
        branchId: madhapur.id,
      },
    });

    await prisma.reportVersion.create({
      data: {
        reportId: report.id,
        versionNum: 1,
        status: 'DRAFT',
      },
    });

    console.log(`✓ Created visit ${billNumber} with RESULTS_PENDING status`);
    console.log(`  Visit ID: ${pendingVisit.id}`);
    console.log(`  Test Order ID: ${testOrder.id}\n`);

    // Create another visit with draft results
    console.log('2. Creating visit with draft test results...');
    const billNumber2 = `D-${kukatpally.code}-TEST-02`;
    
    const draftVisit = await prisma.visit.create({
      data: {
        branchId: kukatpally.id,
        patientId: patient.id,
        domain: 'DIAGNOSTICS',
        status: 'RESULTS_PENDING',
        billNumber: billNumber2,
        totalAmountInPaise: cbcTest.priceInPaise,
      },
    });

    await prisma.bill.create({
      data: {
        visitId: draftVisit.id,
        billNumber: billNumber2,
        branchId: kukatpally.id,
        totalAmountInPaise: cbcTest.priceInPaise,
        paymentType: 'CASH',
        paymentStatus: 'PAID',
      },
    });

    const testOrder2 = await prisma.testOrder.create({
      data: {
        visitId: draftVisit.id,
        testId: cbcTest.id,
        branchId: kukatpally.id,
        priceInPaise: cbcTest.priceInPaise,
        referralCommissionPercentage: 10,
      },
    });

    const report2 = await prisma.diagnosticReport.create({
      data: {
        visitId: draftVisit.id,
        branchId: kukatpally.id,
      },
    });

    const version2 = await prisma.reportVersion.create({
      data: {
        reportId: report2.id,
        versionNum: 1,
        status: 'DRAFT',
      },
    });

    // Add draft test results
    await prisma.testResult.create({
      data: {
        testOrderId: testOrder2.id,
        reportVersionId: version2.id,
        parameterName: 'Hemoglobin',
        value: '14.5',
        unit: 'g/dL',
        referenceRange: '13.0-17.0',
        status: 'NORMAL',
      },
    });

    await prisma.testResult.create({
      data: {
        testOrderId: testOrder2.id,
        reportVersionId: version2.id,
        parameterName: 'WBC Count',
        value: '8500',
        unit: 'cells/μL',
        referenceRange: '4000-11000',
        status: 'NORMAL',
      },
    });

    console.log(`✓ Created visit ${billNumber2} with draft results`);
    console.log(`  Visit ID: ${draftVisit.id}`);
    console.log(`  Report ID: ${report2.id}\n`);

    // Create a finalized visit
    console.log('3. Creating finalized visit...');
    const billNumber3 = `D-${madhapur.code}-TEST-03`;
    
    const finalizedVisit = await prisma.visit.create({
      data: {
        branchId: madhapur.id,
        patientId: patient.id,
        domain: 'DIAGNOSTICS',
        status: 'COMPLETED',
        billNumber: billNumber3,
        totalAmountInPaise: cbcTest.priceInPaise,
      },
    });

    await prisma.bill.create({
      data: {
        visitId: finalizedVisit.id,
        billNumber: billNumber3,
        branchId: madhapur.id,
        totalAmountInPaise: cbcTest.priceInPaise,
        paymentType: 'CASH',
        paymentStatus: 'PAID',
      },
    });

    const testOrder3 = await prisma.testOrder.create({
      data: {
        visitId: finalizedVisit.id,
        testId: cbcTest.id,
        branchId: madhapur.id,
        priceInPaise: cbcTest.priceInPaise,
        referralCommissionPercentage: 10,
      },
    });

    const report3 = await prisma.diagnosticReport.create({
      data: {
        visitId: finalizedVisit.id,
        branchId: madhapur.id,
      },
    });

    const version3 = await prisma.reportVersion.create({
      data: {
        reportId: report3.id,
        versionNum: 1,
        status: 'FINALIZED',
        finalizedAt: new Date(),
      },
    });

    await prisma.testResult.createMany({
      data: [
        {
          testOrderId: testOrder3.id,
          reportVersionId: version3.id,
          parameterName: 'Hemoglobin',
          value: '15.2',
          unit: 'g/dL',
          referenceRange: '13.0-17.0',
          status: 'NORMAL',
        },
        {
          testOrderId: testOrder3.id,
          reportVersionId: version3.id,
          parameterName: 'WBC Count',
          value: '7800',
          unit: 'cells/μL',
          referenceRange: '4000-11000',
          status: 'NORMAL',
        },
        {
          testOrderId: testOrder3.id,
          reportVersionId: version3.id,
          parameterName: 'RBC Count',
          value: '5.1',
          unit: 'million/μL',
          referenceRange: '4.5-5.9',
          status: 'NORMAL',
        },
      ],
    });

    console.log(`✓ Created finalized visit ${billNumber3}`);
    console.log(`  Visit ID: ${finalizedVisit.id}`);
    console.log(`  Report ID: ${report3.id}\n`);

    console.log('✅ Test data created successfully!\n');
    console.log('Summary:');
    console.log(`- ${billNumber}: RESULTS_PENDING (no results yet)`);
    console.log(`- ${billNumber2}: RESULTS_PENDING (draft results)`);
    console.log(`- ${billNumber3}: COMPLETED (finalized report)`);

  } catch (error) {
    console.error('Error creating test data:', error);
  } finally {
    await prisma.$disconnect();
  }
}

createTestData();
