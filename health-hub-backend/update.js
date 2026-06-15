const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const updates = [
    { old: 'CXRPA', new: 'XRAYCP' },
    { old: 'CXAP', new: 'XRAYCA' }
  ];

  for (const { old: oldCode, new: newCode } of updates) {
    const panel = await prisma.panelDefinition.updateMany({
      where: { code: oldCode },
      data: { code: newCode }
    });
    console.log(`PanelDefinition updated (${oldCode}->${newCode}):`, panel);
    
    const test = await prisma.testDefinition.updateMany({
      where: { code: oldCode },
      data: { code: newCode }
    });
    console.log(`TestDefinition updated (${oldCode}->${newCode}):`, test);
    
    const product = await prisma.billableProduct.updateMany({
      where: { code: oldCode },
      data: { code: newCode }
    });
    console.log(`BillableProduct updated (${oldCode}->${newCode}):`, product);
  }
}
run().catch(console.error).finally(() => prisma.$disconnect());
