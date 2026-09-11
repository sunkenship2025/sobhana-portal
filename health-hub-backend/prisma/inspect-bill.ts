import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();
const NO = process.argv[2];
(async () => {
  const visit = await prisma.visit.findFirst({
    where: { billNumber: NO },
    include: {
      bill: true,
      patient: { select: { name: true } },
      testOrders: { include: { test: { select: { name: true } } }, orderBy: { displayOrder: 'asc' } },
      report: { select: { id: true, versions: { select: { id: true, versionNum: true, status: true, finalizedAt: true } } } },
    },
  });
  if (!visit) { console.log('NOT FOUND', NO); return; }
  const b = visit.bill!;
  console.log(JSON.stringify({
    visitId: visit.id, status: visit.status, patient: visit.patient?.name, billNumber: visit.billNumber,
    bill: {
      id: b.id, total: b.totalAmountInPaise, discountType: b.discountType, discountPct: b.discountPercentage,
      discountAmt: b.discountAmountInPaise, discountReason: b.discountReason, discountedBy: b.discountedByUserId,
      coupon: b.couponCode, couponAmt: b.couponDiscountInPaise,
      paid: b.paidAmountInPaise, status: b.paymentStatus,
      refunded: b.refundedAmountInPaise, reversedCharge: b.reversedChargeInPaise,
    },
    orders: visit.testOrders.map(o => ({ id: o.id, test: o.test.name, testId: o.testId, price: o.priceInPaise, mode: o.workflowMode, cancelledAt: o.cancelledAt, reversed: o.reversedChargeInPaise, order: o.displayOrder })),
    report: visit.report,
    txns: await prisma.paymentTransaction.findMany({ where: { billId: b.id } }),
    orderRefunds: await prisma.orderRefund.findMany({ where: { billId: b.id } }),

  }, null, 2));
})().finally(() => prisma.$disconnect());
