import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();

async function main() {
  // Get CBP panel items with test details
  const cbp = await p.panelDefinition.findUnique({ 
    where: { name: 'CBP' },
    include: { testItems: { include: { test: { select: { id: true, code: true, name: true } } }, orderBy: { displayOrder: 'asc' } } }
  });
  console.log('=== CBP Panel Test Items ===');
  cbp?.testItems.forEach(ti => console.log(`  ${String(ti.displayOrder).padStart(2)} ${ti.test.code.padEnd(10)} ${ti.test.name.padEnd(35)} testId=${ti.test.id}`));
  
  // Check what tests are in our finalized report
  const rv = await p.reportVersion.findUnique({
    where: { id: 'cml9rhzu0000gsu6elf6ynor4' },
    include: { testResults: { include: { test: { select: { id: true, code: true, name: true } }, testOrder: { select: { testId: true } } } } }
  });
  console.log('\n=== Test Results in Finalized Report ===');
  rv?.testResults.forEach(tr => console.log(`  ${tr.test.code.padEnd(10)} ${tr.test.name.padEnd(35)} testId=${tr.test.id} value=${tr.value} flag=${tr.flag}`));
  
  // Check if the test IDs from results match the PanelTestItems
  const panelTestIds = new Set(cbp?.testItems.map(ti => ti.test.id));
  const resultTestIds = rv?.testResults.map(tr => tr.test.id) || [];
  console.log('\n=== Match Check ===');
  resultTestIds.forEach(id => {
    const test = rv?.testResults.find(tr => tr.test.id === id)?.test;
    console.log(`  ${test?.code?.padEnd(10)} ${id}: ${panelTestIds.has(id) ? '✅ IN PANEL' : '❌ NOT IN PANEL'}`);
  });
}

main().catch(console.error).finally(() => p.$disconnect());
