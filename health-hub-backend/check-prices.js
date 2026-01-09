const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('=== LabTest Prices (master catalog) ===');
  const labTests = await prisma.labTest.findMany();
  labTests.forEach(t => console.log(`${t.code}: ${t.priceInPaise} paise`));
  
  console.log('\n=== TestOrder Prices (snapshot at order time) ===');
  const testOrders = await prisma.testOrder.findMany({
    include: { test: true }
  });
  testOrders.forEach(o => console.log(`${o.test.code} (order ${o.id.slice(-8)}): ${o.priceInPaise} paise`));
}

main()
  .finally(() => prisma.$disconnect());
