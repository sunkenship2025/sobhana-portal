import prisma from '../src/lib/prisma';

async function main() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const logs = await prisma.auditLog.findMany({
    where: { actionType: 'FINALIZE', entityType: 'Report', createdAt: { gte: start } },
    orderBy: { createdAt: 'asc' },
    select: { entityId: true, userId: true, newValues: true, createdAt: true },
  });

  // Resolve visit bill numbers
  const visitIds = [
    ...new Set(logs.map((l) => (l.newValues as any)?.visitId).filter(Boolean)),
  ] as string[];
  const visits = await prisma.visit.findMany({
    where: { id: { in: visitIds } },
    select: { id: true, billNumber: true, branch: { select: { code: true } } },
  });
  const billOf = new Map(visits.map((v) => [v.id, `${v.billNumber} [${v.branch?.code}]`]));

  let byScript = 0;
  let byUser = 0;
  console.log(`Today's FINALIZE actions: ${logs.length}\n`);
  for (const l of logs) {
    const nv = l.newValues as any;
    const via = nv?.via ?? '(endpoint / user)';
    const isScript = via === 'finalize-chintal-backlog script';
    if (isScript) byScript++;
    else byUser++;
    console.log(
      `${l.createdAt.toISOString()}  ${billOf.get(nv?.visitId) ?? nv?.visitId}  user=${l.userId ?? 'null'}  via=${via}`,
    );
  }
  console.log(`\n>>> by my script: ${byScript}   |   by endpoint/user: ${byUser}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
