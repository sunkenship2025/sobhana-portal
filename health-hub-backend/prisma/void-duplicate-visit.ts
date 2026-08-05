/**
 * Void one side of a double-submit duplicate registration.
 * Mirrors the app's cancel semantics (the D-BLN-000867 precedent):
 *   TestOrder.cancelledAt + cancelReason + reversedChargeInPaise
 *   OrderRefund kind=CANCEL with chargeReversedInPaise
 *   Visit.status = CANCELLED
 * Money: treats the duplicate PAYMENT as never-collected (one payment recorded
 * twice), so the phantom PaymentTransaction is removed and paid drops to 0.
 * NO refund transaction is written — no cash left the till.
 * Dry-run unless APPLY=1.
 */
import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const APPLY = process.env.APPLY === '1';
const VOID_BILL = process.env.VOID_BILL!;
const KEEP_BILL = process.env.KEEP_BILL!;

(async () => {
  const visit = await p.visit.findFirst({
    where: { billNumber: VOID_BILL },
    include: { bill: { include: { transactions: true } }, testOrders: true, patient: true },
  });
  if (!visit || !visit.bill) throw new Error(`not found: ${VOID_BILL}`);
  if (visit.status === 'CANCELLED') { console.log('already cancelled'); return; }

  const reason = `Duplicate registration (double-submit) — duplicate of ${KEEP_BILL}`;
  const live = visit.testOrders.filter(o => !o.cancelledAt);
  const payments = visit.bill.transactions.filter(t => t.transactionType === 'PAYMENT');
  const actor = payments[0]?.collectedByUserId ?? null;

  console.log(`\n${APPLY ? '=== APPLYING ===' : '=== DRY RUN ==='}`);
  console.log(`visit ${VOID_BILL} (${visit.id})  patient=${visit.patient.name} status=${visit.status}`);
  console.log(`  -> Visit.status = CANCELLED`);
  for (const o of live) {
    console.log(`  -> TestOrder ${o.testNameSnapshot}: cancelledAt=now, reversedCharge=₹${o.priceInPaise/100}`);
    console.log(`     + OrderRefund kind=CANCEL chargeReversed=₹${o.priceInPaise/100} amount=₹0`);
  }
  for (const t of payments) {
    console.log(`  -> DELETE phantom PaymentTransaction ₹${t.amountInPaise/100} ${t.paymentType} (never collected)`);
  }
  console.log(`  -> Bill.paidAmountInPaise ₹${visit.bill.paidAmountInPaise/100} -> ₹0`);
  console.log(`  reason: ${reason}`);

  if (!APPLY) { console.log('\nno writes performed. re-run with APPLY=1\n'); return; }

  await p.$transaction(async (tx) => {
    for (const o of live) {
      await tx.testOrder.update({
        where: { id: o.id },
        data: { cancelledAt: new Date(), cancelReason: reason, reversedChargeInPaise: o.priceInPaise },
      });
      await tx.orderRefund.create({
        data: {
          billId: visit.bill!.id, visitId: visit.id, testOrderId: o.id, branchId: visit.branchId,
          kind: 'CANCEL', amountInPaise: 0, reason, chargeReversedInPaise: o.priceInPaise,
          createdByUserId: actor!,
        },
      });
    }
    for (const t of payments) await tx.paymentTransaction.delete({ where: { id: t.id } });
    await tx.bill.update({ where: { id: visit.bill!.id }, data: { paidAmountInPaise: 0 } });
    await tx.visit.update({ where: { id: visit.id }, data: { status: 'CANCELLED' } });
  });
  console.log('\napplied.\n');
  await p.$disconnect();
})().finally(() => p.$disconnect());
