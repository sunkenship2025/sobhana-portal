import prisma from '../src/lib/prisma';

async function main() {
  const visit = await prisma.visit.findFirst({
    where: { billNumber: 'D-JGG-000026' },
    select: {
      id: true, billNumber: true,
      report: {
        select: {
          versions: {
            orderBy: { versionNum: 'desc' },
            take: 1,
            select: {
              versionNum: true, status: true,
              testResults: {
                select: {
                  value: true, textValue: true,
                  testDefinition: { select: { code: true, name: true, formulaExpression: true } },
                },
              },
            },
          },
        },
      },
    },
  });
  const v = visit?.report?.versions[0];
  console.log(`${visit?.billNumber}  latest v${v?.versionNum} ${v?.status}`);
  for (const r of v?.testResults ?? []) {
    const d = r.testDefinition;
    console.log(`  ${d?.code ?? '?'} ${d?.name}  value=${r.value ?? r.textValue ?? 'NULL'}  ${d?.formulaExpression ? `[derived: ${d.formulaExpression}]` : ''}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
