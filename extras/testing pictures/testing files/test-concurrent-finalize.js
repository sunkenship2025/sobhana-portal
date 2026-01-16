const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function setupTestVisit() {
  // Create a new visit for concurrency testing
  const patient = await prisma.patient.findFirst();
  const test = await prisma.labTest.findFirst();
  
  // Create visit
  const visit = await prisma.visit.create({
    data: {
      branchId: 'cmk2mcc2r00001d9esaynov48',
      patientId: patient.id,
      domain: 'DIAGNOSTICS',
      status: 'WAITING',
      billNumber: 'CONC-TEST-' + Date.now(),
      totalAmountInPaise: test.priceInPaise
    }
  });
  
  // Create bill
  await prisma.bill.create({
    data: {
      visitId: visit.id,
      billNumber: visit.billNumber,
      branchId: 'cmk2mcc2r00001d9esaynov48',
      totalAmountInPaise: test.priceInPaise,
      paymentType: 'CASH',
      paymentStatus: 'PAID'
    }
  });
  
  // Create test order
  await prisma.testOrder.create({
    data: {
      visitId: visit.id,
      testId: test.id,
      branchId: 'cmk2mcc2r00001d9esaynov48',
      priceInPaise: test.priceInPaise,
      referralCommissionPercentage: 0
    }
  });
  
  // Create report with draft version
  const report = await prisma.diagnosticReport.create({
    data: {
      visitId: visit.id,
      branchId: 'cmk2mcc2r00001d9esaynov48'
    }
  });
  
  await prisma.reportVersion.create({
    data: {
      reportId: report.id,
      versionNum: 1,
      status: 'DRAFT'
    }
  });
  
  // Create test result
  await prisma.testResult.create({
    data: {
      reportVersionId: (await prisma.reportVersion.findFirst({ where: { reportId: report.id } })).id,
      testOrderId: (await prisma.testOrder.findFirst({ where: { visitId: visit.id } })).id,
      value: 12.5,
      flag: 'NORMAL'
    }
  });
  
  return { visitId: visit.id, reportId: report.id };
}

async function simulateFinalize(visitId, label) {
  const startTime = Date.now();
  try {
    // Find the report version
    const visit = await prisma.visit.findUnique({
      where: { id: visitId },
      include: { report: { include: { versions: true } } }
    });
    
    if (!visit.report || !visit.report.versions.length) {
      return { label, success: false, error: 'No report version found' };
    }
    
    const version = visit.report.versions[0];
    
    if (version.status === 'FINALIZED') {
      return { label, success: false, error: 'Already finalized', time: Date.now() - startTime };
    }
    
    // Finalize (simulate race condition by doing update)
    await prisma.reportVersion.update({
      where: { id: version.id },
      data: { status: 'FINALIZED', finalizedAt: new Date() }
    });
    
    await prisma.visit.update({
      where: { id: visitId },
      data: { status: 'COMPLETED' }
    });
    
    return { label, success: true, time: Date.now() - startTime };
  } catch (err) {
    return { label, success: false, error: err.message.substring(0, 50), time: Date.now() - startTime };
  }
}

async function testConcurrentFinalize() {
  console.log('=== TR-05: Double Finalize Concurrency Test ===');
  
  // Setup test data
  console.log('Setting up test visit...');
  const { visitId, reportId } = await setupTestVisit();
  console.log('Test visit created:', visitId);
  
  // Launch concurrent finalize requests
  console.log('\nLaunching 5 concurrent finalize requests...');
  const promises = [
    simulateFinalize(visitId, 'Request-1'),
    simulateFinalize(visitId, 'Request-2'),
    simulateFinalize(visitId, 'Request-3'),
    simulateFinalize(visitId, 'Request-4'),
    simulateFinalize(visitId, 'Request-5')
  ];
  
  const results = await Promise.all(promises);
  
  console.log('\n=== Results ===');
  results.forEach(r => {
    console.log(`${r.label}: ${r.success ? 'SUCCESS' : 'BLOCKED'} - ${r.error || r.time + 'ms'}`);
  });
  
  const successCount = results.filter(r => r.success).length;
  console.log(`\nTotal successful: ${successCount}`);
  
  // Verify final state
  const finalVersion = await prisma.reportVersion.findFirst({
    where: { reportId },
    orderBy: { versionNum: 'desc' }
  });
  console.log('Final report status:', finalVersion.status);
  
  // Analysis
  console.log('\n=== ANALYSIS ===');
  if (successCount === 1) {
    console.log('✅ Only ONE request succeeded - proper concurrency control');
  } else if (successCount > 1) {
    console.log('⚠️ Multiple requests succeeded - race condition possible');
    console.log('Note: Without proper row-level locking, this is expected behavior');
  } else {
    console.log('❌ No requests succeeded - unexpected');
  }
  
  // Cleanup - delete test visit and related records
  console.log('\nCleaning up test data...');
  await prisma.testResult.deleteMany({ where: { reportVersion: { reportId } } });
  await prisma.reportVersion.deleteMany({ where: { reportId } });
  await prisma.diagnosticReport.delete({ where: { id: reportId } });
  await prisma.testOrder.deleteMany({ where: { visitId } });
  await prisma.bill.deleteMany({ where: { visitId } });
  await prisma.visit.delete({ where: { id: visitId } });
  console.log('Cleanup complete');
}

testConcurrentFinalize().finally(() => prisma.$disconnect());
