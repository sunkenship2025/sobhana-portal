// TR-06: Test DB-level immutability of FINALIZED reports
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function testFinalizedImmutability() {
  try {
    console.log('TR-06: Testing FINALIZED report immutability...\n');
    
    // Find a FINALIZED report
    const finalizedReport = await prisma.reportVersion.findFirst({
      where: { status: 'FINALIZED' },
      select: { id: true, notes: true, status: true }
    });
    
    if (!finalizedReport) {
      console.log('❌ No FINALIZED reports found in database');
      return;
    }
    
    console.log('Found FINALIZED report:', finalizedReport.id);
    console.log('Current notes:', finalizedReport.notes || '(empty)');
    console.log('\nAttempting to UPDATE notes on FINALIZED report...\n');
    
    // Attempt to update
    try {
      const updated = await prisma.reportVersion.update({
        where: { id: finalizedReport.id },
        data: { notes: 'TAMPERED BY TEST - Should be blocked!' }
      });
      
      console.log('⚠️  UPDATE SUCCEEDED - No DB constraint exists!');
      console.log('Updated notes:', updated.notes);
      console.log('\n🔴 CRITICAL: Database allows mutation of FINALIZED reports!');
      console.log('Recommendation: Add DB trigger to prevent updates on FINALIZED status\n');
      
      // Rollback the test change
      await prisma.reportVersion.update({
        where: { id: finalizedReport.id },
        data: { notes: finalizedReport.notes }
      });
      console.log('✅ Rolled back test mutation');
      
    } catch (error) {
      console.log('✅ UPDATE BLOCKED:', error.message);
      console.log('\n🟢 PASS: Database constraint prevents FINALIZED mutation');
    }
    
  } catch (error) {
    console.error('Test error:', error);
  } finally {
    await prisma.$disconnect();
  }
}

testFinalizedImmutability();
