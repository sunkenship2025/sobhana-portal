const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testTrigger() {
  try {
    const result = await prisma.reportVersion.update({
      where: { id: 'cmk752gja000jjx99gj8r7jax' },
      data: { versionNum: 999 }
    });
    console.log('❌ FAILED: Update succeeded! Trigger did not block mutation.');
    process.exit(1);
  } catch (error) {
    // Check for trigger error (ERRCODE 23505 or message contains our text)
    const errorStr = error.toString();
    if (errorStr.includes('Cannot modify FINALIZED report') || 
        errorStr.includes('Unique constraint') ||
        error.code === 'P2002') {
      console.log('✅ PASSED: Trigger successfully blocked FINALIZED report mutation!');
      console.log('Full error:', errorStr);
      process.exit(0);
    } else {
      console.log('❌ FAILED: Unexpected error');
      console.log('Full error:', errorStr);
      process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

testTrigger();
