const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testTransactionRollback() {
  console.log('=== DV-02: Transaction Rollback Test ===');
  
  // Get counts before
  const beforeCounts = {
    visits: await prisma.visit.count(),
    bills: await prisma.bill.count(),
    testOrders: await prisma.testOrder.count(),
    diagnosticReports: await prisma.diagnosticReport.count()
  };
  console.log('Before counts:', JSON.stringify(beforeCounts));
  
  // Attempt to create a visit with invalid data that should fail mid-transaction
  console.log('\nAttempting transaction with invalid test ID...');
  
  try {
    await prisma.$transaction(async (tx) => {
      // Create visit
      const visit = await tx.visit.create({
        data: {
          branchId: 'cmk2mcc2r00001d9esaynov48',
          patientId: 'cmk79q7z8000211vezksl99u9',
          domain: 'DIAGNOSTICS',
          status: 'DRAFT',
          billNumber: 'TEST-ROLLBACK-001',
          totalAmountInPaise: 10000
        }
      });
      console.log('Visit created (in transaction):', visit.id);
      
      // Create bill
      await tx.bill.create({
        data: {
          visitId: visit.id,
          billNumber: 'TEST-ROLLBACK-001',
          branchId: 'cmk2mcc2r00001d9esaynov48',
          totalAmountInPaise: 10000,
          paymentType: 'CASH',
          paymentStatus: 'PENDING'
        }
      });
      console.log('Bill created (in transaction)');
      
      // Force error by referencing invalid test ID
      await tx.testOrder.create({
        data: {
          visitId: visit.id,
          testId: 'INVALID_TEST_ID_DOES_NOT_EXIST',
          branchId: 'cmk2mcc2r00001d9esaynov48',
          priceInPaise: 10000,
          referralCommissionPercentage: 0
        }
      });
      console.log('TestOrder created (should not reach here)');
    });
    console.log('Transaction succeeded (unexpected!)');
  } catch (err) {
    console.log('Transaction FAILED (expected):', err.code || err.message.substring(0, 100));
  }
  
  // Get counts after
  const afterCounts = {
    visits: await prisma.visit.count(),
    bills: await prisma.bill.count(),
    testOrders: await prisma.testOrder.count(),
    diagnosticReports: await prisma.diagnosticReport.count()
  };
  console.log('\nAfter counts:', JSON.stringify(afterCounts));
  
  // Verify rollback
  const rollbackSuccess = 
    beforeCounts.visits === afterCounts.visits &&
    beforeCounts.bills === afterCounts.bills &&
    beforeCounts.testOrders === afterCounts.testOrders;
  
  console.log('\n=== RESULT ===');
  console.log('Rollback successful:', rollbackSuccess);
  if (!rollbackSuccess) {
    console.log('ORPHAN RECORDS DETECTED!');
  }
}

testTransactionRollback().finally(() => prisma.$disconnect());
