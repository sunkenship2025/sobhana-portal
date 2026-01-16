const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function getBranches() {
  try {
    const branches = await prisma.branch.findMany();
    console.log('Branches:', JSON.stringify(branches, null, 2));
    
    const users = await prisma.user.findMany({
      include: {
        activeBranch: true
      }
    });
    console.log('\nUsers with branches:', JSON.stringify(users, null, 2));
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

getBranches();
