const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testAdminMutation() {
  console.log('=== TR-06: Admin Mutation Test ===');
  console.log('Attempting direct DB update on FINALIZED report...');
  
  try {
    // First check current status
    const before = await prisma.reportVersion.findUnique({
      where: { id: 'cmk79q870000j11ve8fvbcqtf' }
    });
    console.log('Before status:', before?.status);
    
    // Try to update a finalized report version
    const result = await prisma.reportVersion.update({
      where: { id: 'cmk79q870000j11ve8fvbcqtf' },
      data: { status: 'DRAFT' }
    });
    console.log('WARNING: DB update succeeded - no constraint!');
    console.log('New status:', result.status);
    
    // Revert the change
    await prisma.reportVersion.update({
      where: { id: 'cmk79q870000j11ve8fvbcqtf' },
      data: { status: 'FINALIZED' }
    });
    console.log('Reverted back to FINALIZED');
    
  } catch (err) {
    console.log('DB update blocked:', err.message);
  }
}

testAdminMutation().finally(() => prisma.$disconnect());
