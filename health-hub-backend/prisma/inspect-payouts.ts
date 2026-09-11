import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
(async () => {
  const g = await p.doctorPayoutLedger.groupBy({
    by: ['doctorType'],
    where: { deletedAt: null },
    _count: { _all: true },
    _sum: { derivedAmountInPaise: true },
  });
  const [total, reviewed, paid, open] = await Promise.all([
    p.doctorPayoutLedger.count({ where: { deletedAt: null } }),
    p.doctorPayoutLedger.count({ where: { deletedAt: null, reviewedAt: { not: null } } }),
    p.doctorPayoutLedger.count({ where: { deletedAt: null, paidAt: { not: null } } }),
    p.doctorPayoutLedger.aggregate({ where: { deletedAt: null, paidAt: null }, _sum: { derivedAmountInPaise: true } }),
  ]);
  const latest = await p.doctorPayoutLedger.findMany({
    where: { deletedAt: null }, orderBy: { derivedAt: 'desc' }, take: 5,
    select: { doctorType: true, periodStartDate: true, periodEndDate: true, derivedAmountInPaise: true, reviewedAt: true, paidAt: true },
  });
  console.log(JSON.stringify({ rows: total, withReviewedAt: reviewed, withPaidAt: paid, openSumPaise: open._sum.derivedAmountInPaise, byType: g, latest }, null, 2));
})().finally(() => p.$disconnect());
