import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.auditLog.findMany({
    where: { entityType: 'VISIT', actionType: 'CREATE' },
    orderBy: { createdAt: 'desc' },
    take: 2,
    select: {
      id: true,
      userId: true,
      actionType: true,
      entityType: true,
      entityId: true,
      createdAt: true,
      newValues: true
    }
  });
  console.log(JSON.stringify(logs, null, 2));
  await prisma.$disconnect();
}
main();
