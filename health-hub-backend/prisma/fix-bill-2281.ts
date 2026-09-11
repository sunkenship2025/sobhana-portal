/**
 * One-shot correction for D-CNT-002281 (SRIDEVI):
 *   1. cancel the duplicate BILL_ONLY line "FBS AND PLBS - 2" (₹100)
 *   2. record the remaining ₹100 as PAID in CASH
 *
 * Mirrors POST /visits/diagnostic/:id/refund + the collect-due path in
 * routes/diagnosticVisits.ts — same writes, same order, and the money comes
 * from the same allocateBillDiscountAcrossOrders / computeBillFinancials /
 * collectBillDue helpers rather than being re-derived here.
 *
 * Skipped vs the endpoint: reevaluateVisitCompletion (private to the route) —
 * a no-op here, it returns early while any reportable order is live, and FBS +
 * PLBS both stay live. Refund rows too: nothing was paid, so refund = ₹0.
 *
 *   npx tsx prisma/fix-bill-2281.ts [--commit]
 */
import { PrismaClient } from '@prisma/client';
import {
  allocateBillDiscountAcrossOrders,
  collectBillDue,
  computeBillFinancialsFromPersisted,
} from '../src/services/billFinancialService';

const prisma = new PrismaClient();
const commit = process.argv.includes('--commit');
const BILL = 'D-CNT-002281';
// Identify by shape, not label: the duplicate is the lone BILL_ONLY placeholder
// (the two real tests are REPORTABLE). Its product was renamed "FBS AND PLBS - 2"
// -> "Fbpl" after billing, so the printed label is not a stable handle.
const REASON = 'Billing error';
const NOTE = 'Duplicate bill-only line removed; ₹100 collected in cash.';
const r = (p: number) => `₹${(p / 100).toFixed(2)}`;

(async () => {
  const visit = await prisma.visit.findFirst({
    where: { billNumber: BILL },
    include: { bill: { include: { transactions: true } }, testOrders: true, patient: { select: { name: true } } },
  });
  if (!visit?.bill) throw new Error(`${BILL} not found`);
  const bill = visit.bill;

  const billOnly = visit.testOrders.filter((o) => o.workflowMode === 'BILL_ONLY' && !o.cancelledAt);
  if (billOnly.length !== 1) throw new Error(`expected exactly 1 live BILL_ONLY line, found ${billOnly.length} — check by hand`);
  const target = billOnly[0];
  if (target.priceInPaise !== 10000) throw new Error(`BILL_ONLY line is ${r(target.priceInPaise)}, expected ₹100.00 — aborting`);

  const actor = await prisma.user.findFirst({ where: { role: 'owner' }, select: { id: true, name: true } });
  if (!actor) throw new Error('no owner user to attribute this to');

  // --- money, straight from the endpoint's helpers ---------------------------
  const current = computeBillFinancialsFromPersisted(bill);
  const alloc = allocateBillDiscountAcrossOrders(visit.testOrders, current.discountAmountInPaise);
  const reversalInPaise = Math.max(
    0,
    target.priceInPaise - (alloc.get(target.id) ?? 0) - target.reversedChargeInPaise,
  );
  if (reversalInPaise <= 0) throw new Error('nothing left to cancel on that line (is a discount still on the bill?)');

  const nextReversedChargeInPaise = Math.max(0, bill.reversedChargeInPaise ?? 0) + reversalInPaise;
  const reversedBill = { ...bill, reversedChargeInPaise: nextReversedChargeInPaise };
  const afterReversal = computeBillFinancialsFromPersisted(reversedBill);
  const refundInPaise = Math.max(0, current.paidAmountInPaise - afterReversal.netAmountInPaise);
  if (refundInPaise > 0) throw new Error(`unexpected refund of ${r(refundInPaise)} — money was already paid; do this in the app`);

  // Then collect what is left, in cash.
  const afterCash = collectBillDue(reversedBill, afterReversal.dueAmountInPaise / 100);
  const cashInPaise = afterCash.paidAmountInPaise - afterReversal.paidAmountInPaise;

  console.log(`${BILL} · ${visit.patient.name}   (actor: ${actor.name})`);
  console.log(`  cancel     "${target.testNameSnapshot}" (${target.workflowMode}, ${target.id})  reversing ${r(reversalInPaise)}`);
  console.log(`  net        ${r(current.netAmountInPaise)}  ->  ${r(afterReversal.netAmountInPaise)}`);
  console.log(`  cash in    ${r(cashInPaise)}`);
  console.log(`  paid       ${r(current.paidAmountInPaise)}  ->  ${r(afterCash.paidAmountInPaise)}`);
  console.log(`  due        ${r(current.dueAmountInPaise)}  ->  ${r(afterCash.dueAmountInPaise)}`);
  console.log(`  status     ${bill.paymentStatus}  ->  ${afterCash.paymentStatus}`);
  console.log(`  remaining  ${visit.testOrders.filter((o) => !o.cancelledAt && o.id !== target.id).map((o) => `${o.testNameSnapshot} ${r(o.priceInPaise)}`).join(', ')}`);

  if (!commit) return console.log('\nDRY RUN — re-run with --commit to write.');

  const now = new Date();
  await prisma.$transaction(async (tx) => {
    // Atomic claim, exactly as the endpoint does: only cancel if still uncancelled.
    const claimed = await tx.testOrder.updateMany({
      where: { id: target.id, cancelledAt: null },
      data: {
        reversedChargeInPaise: target.reversedChargeInPaise + reversalInPaise,
        cancelledAt: now,
        cancelReason: REASON,
      },
    });
    if (claimed.count !== 1) throw new Error('order was cancelled concurrently — aborted');

    await tx.orderRefund.create({
      data: {
        billId: bill.id,
        visitId: visit.id,
        testOrderId: target.id,
        branchId: visit.branchId,
        kind: 'CANCEL',
        amountInPaise: 0,
        chargeReversedInPaise: reversalInPaise,
        reason: REASON,
        note: NOTE,
        createdByUserId: actor.id,
      },
    });

    await tx.bill.update({
      where: { id: bill.id },
      data: {
        reversedChargeInPaise: nextReversedChargeInPaise,
        paidAmountInPaise: afterCash.paidAmountInPaise,
        paymentStatus: afterCash.paymentStatus,
        transactions: {
          create: { amountInPaise: cashInPaise, paymentType: 'CASH', collectedByUserId: actor.id },
        },
      },
    });

    await tx.auditLog.create({
      data: {
        branchId: visit.branchId,
        actionType: 'UPDATE',
        entityType: 'Bill',
        entityId: bill.id,
        userId: actor.id,
        oldValues: JSON.stringify({
          reversedChargeInPaise: bill.reversedChargeInPaise,
          paidAmountInPaise: bill.paidAmountInPaise,
          paymentStatus: bill.paymentStatus,
        }),
        newValues: JSON.stringify({
          action: 'ORDER_CANCEL',
          billNumber: visit.billNumber,
          patientId: visit.patientId,
          patientName: visit.patient?.name,
          testOrderIds: [target.id],
          chargeReversedInPaise: reversalInPaise,
          refundedInPaise: 0,
          collectedInPaise: cashInPaise,
          paymentType: 'CASH',
          reason: REASON,
          note: NOTE,
          via: 'prisma/fix-bill-2281.ts',
        }),
      },
    });
  });
  console.log('\nCOMMITTED.');
})().finally(() => prisma.$disconnect());
