import prisma from '../src/lib/prisma';
async function main() {
  const panels = await prisma.clinicalPanel.findMany({
    where: { OR: [
      { name: { contains: 'CBP', mode: 'insensitive' } },
      { name: { contains: 'WIDAL', mode: 'insensitive' } },
      { name: { contains: 'HAEMO', mode: 'insensitive' } },
      { name: { contains: 'HEMOGRAM', mode: 'insensitive' } },
      { displayName: { contains: 'BLOOD PICTURE', mode: 'insensitive' } },
      { displayName: { contains: 'WIDAL', mode: 'insensitive' } },
    ]},
    select: { name: true, displayName: true, layoutType: true, showSubgroups: true, valueDisplayPrefix: true, showInterpretation: true },
    orderBy: { name: 'asc' },
  });
  if (!panels.length) { console.log('No CBP/Widal/Haemogram panels found by name.'); return; }
  for (const p of panels) {
    console.log(`${p.name} | "${p.displayName}"\n   layout=${p.layoutType}  showSubgroups=${p.showSubgroups}  valuePrefix=${p.valueDisplayPrefix ?? '-'}  showComments=${p.showInterpretation}`);
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
