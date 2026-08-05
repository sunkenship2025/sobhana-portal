import prisma from '../src/lib/prisma';

const MATCH = ['UIBC', 'IRON', 'TRANSFERRIN', 'SATURATION', 'TIBC'];
const orName = MATCH.map((m) => ({ name: { contains: m, mode: 'insensitive' as const } }));

async function main() {
  const defs = await prisma.testDefinition.findMany({
    where: { OR: orName },
    select: { code: true, name: true, version: true, status: true, formulaExpression: true, dependsOnCodes: true },
    orderBy: [{ name: 'asc' }, { version: 'asc' }],
  });
  console.log('=== TestDefinition (new architecture) ===');
  for (const d of defs) {
    console.log(`${d.code}  v${d.version} ${d.status}  |  ${d.name}\n     formula=${d.formulaExpression ?? 'NULL'}   deps=${JSON.stringify(d.dependsOnCodes)}`);
  }

  const labtests = await prisma.labTest.findMany({
    where: { OR: orName },
    select: {
      code: true, name: true,
      derivedParameter: { select: { formula: true, dependsOnTestCodes: true, parameterName: true } },
    },
  });
  console.log('\n=== LabTest (legacy) + DerivedParameter ===');
  for (const t of labtests) {
    const dp = t.derivedParameter;
    console.log(`${t.code}  |  ${t.name}\n     derived=${dp ? `"${dp.formula}"  deps=${JSON.stringify(dp.dependsOnTestCodes)}` : 'NONE'}`);
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
