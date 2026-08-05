import prisma from '../src/lib/prisma';

// Start of "today" in IST, expressed in UTC (DB stores UTC).
function todayStartUtc(): Date {
  const istOffsetMs = 5.5 * 3600 * 1000;
  const istNow = new Date(Date.now() + istOffsetMs);
  const istMidnight = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate(), 0, 0, 0);
  return new Date(istMidnight - istOffsetMs);
}

async function main() {
  const todayStart = todayStartUtc();
  const orders = await prisma.testOrder.findMany({
    where: { noReportAt: { not: null }, reopenedAt: null },
    orderBy: { noReportAt: 'desc' },
    take: 50,
    select: {
      id: true,
      testNameSnapshot: true,
      noReportAt: true,
      noReportByUserId: true,
      visit: {
        select: {
          id: true,
          billNumber: true,
          status: true,
          createdAt: true,
          patient: { select: { name: true } },
          branch: { select: { code: true } },
          report: {
            select: { versions: { select: { status: true } } },
          },
        },
      },
    },
  });

  const userIds = [...new Set(orders.map((o) => o.noReportByUserId).filter(Boolean))] as string[];
  const users = await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } });
  const userName = new Map(users.map((u) => [u.id, u.name]));

  console.log(`today (IST) starts at ${todayStart.toISOString()} UTC\n`);
  const todayList: typeof orders = [];
  const olderList: typeof orders = [];
  for (const o of orders) {
    if (o.visit && o.visit.createdAt >= todayStart) todayList.push(o);
    else olderList.push(o);
  }

  const fmt = (o: (typeof orders)[number]) => {
    const v = o.visit!;
    const finalized = (v.report?.versions ?? []).some((x) => x.status === 'FINALIZED');
    return `  ${v.billNumber} [${v.branch?.code}]  ${(v.patient?.name ?? '?').padEnd(20)} visitCreated=${v.createdAt.toISOString().slice(0, 16)}  visit=${v.status}${finalized ? ' *FINALIZED*' : ''}\n     test=${o.testNameSnapshot}  closedBy=${userName.get(o.noReportByUserId ?? '') ?? '?'}  visitId=${v.id} orderId=${o.id}`;
  };

  console.log(`===== CREATED TODAY (reopen targets): ${todayList.length} =====`);
  todayList.forEach((o) => console.log(fmt(o)));
  console.log(`\n===== OLDER BACKLOG (NOT reopening per your instruction): ${olderList.length} =====`);
  olderList.forEach((o) => console.log(fmt(o)));
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
