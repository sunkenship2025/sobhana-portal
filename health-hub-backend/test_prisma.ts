import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
async function run() {
  const panel = await prisma.clinicalPanel.findFirst({
    where: { name: 'FBSPLBS1' }
  });
  console.log("Found panel:", panel?.name, "gap:", panel?.spacedDefinitionsGap);
  
  if (panel) {
    const updated = await prisma.clinicalPanel.update({
      where: { id: panel.id },
      data: { spacedDefinitionsGap: 1 }
    });
    console.log("Updated gap:", updated.spacedDefinitionsGap);
  }
}
run();
