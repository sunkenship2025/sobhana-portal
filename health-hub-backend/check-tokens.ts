import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const tokens = await prisma.reportAccessToken.findMany();
  console.log('Existing tokens:', JSON.stringify(tokens, null, 2));
  
  const versions = await prisma.reportVersion.findMany({
    where: { status: 'FINALIZED' },
    select: { id: true, status: true, versionNum: true }
  });
  console.log('Finalized versions:', JSON.stringify(versions, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
