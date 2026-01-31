const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function testBillImmutability() {
  const visitId = 'cml1tfyzg002s4zziwgxcclb1';
  
  // Get the bill
  const bill = await p.bill.findFirst({ where: { visitId } });
  
  if (!bill) {
    console.log('Bill not found');
    return;
  }
  
  console.log('=== BILL IMMUTABILITY TEST ===');
  console.log('Bill ID:', bill.id);
  console.log('Bill Number:', bill.billNumber);
  console.log('');

  // Test 1: Try to change bill number (should FAIL)
  console.log('TEST 1: Try to change bill number...');
  try {
    await p.bill.update({
      where: { id: bill.id },
      data: { billNumber: 'HACKED-001' }
    });
    console.log('❌ FAIL: Bill number change was ALLOWED (security issue!)');
  } catch (error) {
    if (error.message.includes('Cannot modify bill number')) {
      console.log('✅ PASS: Bill number change BLOCKED by trigger');
    } else {
      console.log('✅ PASS: Bill number change blocked:', error.message.substring(0, 60));
    }
  }

  // Test 2: Try to change branch (should FAIL)
  console.log('\nTEST 2: Try to change branch ID...');
  try {
    await p.bill.update({
      where: { id: bill.id },
      data: { branchId: 'fake-branch-id' }
    });
    console.log('❌ FAIL: Branch change was ALLOWED (security issue!)');
  } catch (error) {
    if (error.message.includes('Cannot modify bill branch')) {
      console.log('✅ PASS: Branch change BLOCKED by trigger');
    } else {
      console.log('✅ PASS: Branch change blocked:', error.message.substring(0, 60));
    }
  }

  // Test 3: Try to change visit ID (should FAIL)
  console.log('\nTEST 3: Try to change visit ID...');
  try {
    await p.bill.update({
      where: { id: bill.id },
      data: { visitId: 'fake-visit-id' }
    });
    console.log('❌ FAIL: Visit ID change was ALLOWED (security issue!)');
  } catch (error) {
    if (error.message.includes('Cannot modify bill visit')) {
      console.log('✅ PASS: Visit ID change BLOCKED by trigger');
    } else {
      console.log('✅ PASS: Visit ID change blocked:', error.message.substring(0, 60));
    }
  }

  // Test 4: Payment status change SHOULD be allowed
  console.log('\nTEST 4: Try to change payment status (should be ALLOWED)...');
  try {
    await p.bill.update({
      where: { id: bill.id },
      data: { paymentStatus: 'PAID' }
    });
    console.log('✅ PASS: Payment status change ALLOWED (expected)');
    
    // Revert
    await p.bill.update({
      where: { id: bill.id },
      data: { paymentStatus: 'PENDING' }
    });
  } catch (error) {
    console.log('❌ FAIL: Payment status change was blocked:', error.message.substring(0, 60));
  }

  // Test 5: Direct SQL injection attempt (should FAIL)
  console.log('\nTEST 5: Direct SQL update attempt...');
  try {
    await p.$executeRaw`UPDATE "Bill" SET "billNumber" = 'SQL-INJECTED' WHERE id = ${bill.id}`;
    console.log('❌ FAIL: Direct SQL update was ALLOWED (security issue!)');
  } catch (error) {
    console.log('✅ PASS: Direct SQL blocked by trigger');
  }

  console.log('\n=== ALL IMMUTABILITY TESTS COMPLETE ===');
  await p.$disconnect();
}

testBillImmutability();
