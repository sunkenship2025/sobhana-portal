import prisma from '../src/lib/prisma';

async function main() {
  const v = await prisma.visit.findFirst({
    where: { billNumber: 'D-CNT-000264' },
    select: {
      id: true,
      billNumber: true,
      status: true,
      report: {
        select: {
          versions: {
            orderBy: { versionNum: 'asc' },
            select: {
              versionNum: true,
              status: true,
              finalizedAt: true,
              panelsSnapshot: true,
            },
          },
        },
      },
    },
  });
  console.log('bill:', v?.billNumber, '| visit.status:', v?.status);
  for (const ver of v?.report?.versions ?? []) {
    console.log(
      `  v${ver.versionNum}: status=${ver.status} finalizedAt=${ver.finalizedAt?.toISOString() ?? 'null'} snapshot=${ver.panelsSnapshot ? 'PRESENT' : 'MISSING'}`,
    );
  }
  // Confirm SILENT: any report-ready WhatsApp logged for this visit?
  const msgs = await prisma.messageLog.findMany({
    where: { contextId: v?.id, templateName: { contains: 'report', mode: 'insensitive' as const } },
    select: { templateName: true, createdAt: true, status: true },
    orderBy: { createdAt: 'asc' },
  });
  console.log('report-related MessageLog rows for this visit:', msgs.length);
  for (const m of msgs) {
    console.log(`  ${m.templateName} | ${m.createdAt.toISOString()} | ${m.status}`);
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const newToday = msgs.filter((m) => m.createdAt >= today).length;
  console.log(`report messages created TODAY (should be 0 for silent): ${newToday}`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
