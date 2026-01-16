import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const visit = await prisma.visit.findUnique({
    where: { id: 'cmk5szk6h0003fkulifpv3d4a' },
    include: {
      testOrders: true,
      diagnosticReport: true
    }
  });
  console.log(JSON.stringify(visit, null, 2));
  await prisma.$disconnect();
}
main();
