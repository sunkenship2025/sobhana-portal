const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  await prisma.billAccessToken.deleteMany({});
  console.log('Cleared BillAccessToken');
}
main().catch(console.error).finally(() => prisma.$disconnect());
