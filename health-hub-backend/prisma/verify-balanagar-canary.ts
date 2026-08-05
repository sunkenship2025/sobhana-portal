import prisma from '../src/lib/prisma';

const BILLS = ['D-BLN-000594'];

async function main() {
  const visits = await prisma.visit.findMany({
    where: { billNumber: { in: BILLS } },
    select: {
      id: true,
      patientId: true,
      billNumber: true,
      status: true,
      report: {
        select: {
          versions: {
            orderBy: { versionNum: 'desc' },
            select: { versionNum: true, status: true, finalizedAt: true, panelsSnapshot: true },
          },
        },
      },
    },
    orderBy: { billNumber: 'asc' },
  });

  let completed = 0;
  let stillOpen = 0;
  for (const v of visits) {
    const latest = v.report?.versions[0];
    const hasSnap = latest?.panelsSnapshot != null;
    if (v.status === 'COMPLETED') completed++;
    else stillOpen++;
    console.log(
      `${v.billNumber} | visit=${(v.status ?? '?').padEnd(9)} | latestV${latest?.versionNum ?? '-'}=${(latest?.status ?? 'none').padEnd(9)} | fin=${latest?.finalizedAt?.toISOString().slice(0, 16) ?? '-'} | snap=${hasSnap ? 'yes' : 'no '}`,
    );
  }

  const visitIds = visits.map((v) => v.id);
  const patientIds = visits.map((v) => v.patientId).filter(Boolean) as string[];
  const today = new Date('2026-07-17T00:00:00Z');
  const msgsToday = await prisma.messageLog.findMany({
    where: {
      createdAt: { gte: today },
      OR: [{ contextId: { in: visitIds } }, { patientId: { in: patientIds } }],
    },
    select: { contextType: true, contextId: true, templateName: true, status: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  });

  console.log('\n====================================================================');
  console.log(`Visits: ${visits.length}  |  COMPLETED: ${completed}  |  still open: ${stillOpen}`);
  console.log(`MessageLog rows created TODAY (2026-07-17) for these patients/visits: ${msgsToday.length}`);
  for (const m of msgsToday) {
    console.log(`  ${m.contextType}:${m.contextId} | ${m.templateName} | ${m.status} | ${m.createdAt.toISOString()}`);
  }
  console.log(msgsToday.length === 0 ? '>>> SILENT CONFIRMED: no patient messages sent.' : '>>> WARNING: messages found today!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
