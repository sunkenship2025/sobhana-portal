const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function testPriceSnapshot() {
  const visitId = 'cml1tfyzg002s4zziwgxcclb1';
  
  // Get test order 
  const testOrder = await p.testOrder.findFirst({ 
    where: { visitId },
    include: { test: true }
  });

  if (!testOrder) {
    console.log('Test order not found');
    return;
  }
  
  console.log('=== BEFORE PRICE CHANGE ===');
  console.log('Test Order Price (snapshotted):', testOrder.priceInPaise / 100);
  console.log('Current Catalog Price:', testOrder.test.priceInPaise / 100);
  
  // Change the catalog price
  const originalPrice = testOrder.test.priceInPaise;
  const newPrice = originalPrice * 10;
  
  await p.labTest.update({
    where: { id: testOrder.testId },
    data: { priceInPaise: newPrice }
  });
  
  // Re-fetch to verify snapshot is unchanged
  const testOrderAfter = await p.testOrder.findFirst({ 
    where: { visitId },
    include: { test: true }
  });
  
  console.log('\n=== AFTER PRICE CHANGE ===');
  console.log('Test Order Price (snapshotted):', testOrderAfter.priceInPaise / 100);
  console.log('New Catalog Price:', testOrderAfter.test.priceInPaise / 100);
  console.log('\nPRICE SNAPSHOT WORKS:', testOrderAfter.priceInPaise === originalPrice ? 'YES ✅' : 'NO ❌');
  
  // Revert the price
  await p.labTest.update({
    where: { id: testOrder.testId },
    data: { priceInPaise: originalPrice }
  });
  
  console.log('\n(Catalog price reverted)');
  await p.$disconnect();
}

testPriceSnapshot();
