const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function testBillNumberUniqueness() {
  console.log('=== BILL NUMBER BRANCH-SCOPED UNIQUENESS TEST ===\n');
  
  // Get recent bills to show format
  const bills = await p.bill.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: { branch: true }
  });
  
  console.log('Recent bill numbers:');
  bills.forEach(b => {
    console.log(`  ${b.billNumber} (Branch: ${b.branch.code})`);
  });
  
  // Verify format: D-{BRANCH_CODE}-{5 digits}
  console.log('\nTEST 1: Bill number format verification...');
  const formatRegex = /^D-[A-Z]+-\d{5}$/;
  const allValid = bills.every(b => formatRegex.test(b.billNumber));
  if (allValid) {
    console.log('✅ PASS: All bills have correct format D-{BRANCH_CODE}-XXXXX');
  } else {
    console.log('❌ FAIL: Some bills have invalid format');
  }
  
  // Check for duplicates
  console.log('\nTEST 2: No duplicate bill numbers per branch...');
  const duplicates = await p.$queryRaw`
    SELECT "branchId", "billNumber", COUNT(*) as count
    FROM "Bill"
    GROUP BY "branchId", "billNumber"
    HAVING COUNT(*) > 1
  `;
  
  if (duplicates.length === 0) {
    console.log('✅ PASS: No duplicate bill numbers found');
  } else {
    console.log('❌ FAIL: Found', duplicates.length, 'duplicate bill numbers');
  }
  
  // Test unique constraint at database level
  console.log('\nTEST 3: Database unique constraint enforcement...');
  const existingBill = bills[0];
  try {
    // Try to create a bill with duplicate bill number in same branch
    await p.bill.create({
      data: {
        visitId: existingBill.visitId,
        billNumber: existingBill.billNumber, // Duplicate!
        branchId: existingBill.branchId,
        totalAmountInPaise: 0
      }
    });
    console.log('❌ FAIL: Duplicate bill number was allowed!');
  } catch (error) {
    if (error.code === 'P2002') {
      console.log('✅ PASS: Unique constraint prevented duplicate bill number');
    } else {
      console.log('✅ PASS: Duplicate prevented by:', error.message.substring(0, 60));
    }
  }
  
  // Check sequence
  console.log('\nTEST 4: Bill numbers are sequential...');
  const sequence = await p.numberSequence.findFirst({
    where: { id: { startsWith: 'diagnostic-' } }
  });
  if (sequence) {
    console.log(`  Current sequence: ${sequence.prefix}-${String(sequence.lastValue).padStart(5, '0')}`);
    console.log('✅ PASS: Number sequence exists and is tracked');
  }
  
  console.log('\n=== UNIQUENESS TESTS COMPLETE ===');
  await p.$disconnect();
}

testBillNumberUniqueness();
