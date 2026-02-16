const { PrismaClient } = require('@prisma/client');

async function test() {
  const prisma = new PrismaClient();
  
  console.log('Testing Prisma models...');
  console.log('reportAccessToken exists:', !!prisma.reportAccessToken);
  console.log('signingRule exists:', !!prisma.signingRule);
  console.log('panelDefinition exists:', !!prisma.panelDefinition);
  console.log('department exists:', !!prisma.department);
  
  await prisma.$disconnect();
}

test().catch(console.error);
