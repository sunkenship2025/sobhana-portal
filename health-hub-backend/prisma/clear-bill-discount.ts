/**
 * Clear the manual discount off one bill. Dry-run unless --commit.
 *
 * There is no in-app way to take a discount back off a bill, so this exists for
 * corrections. It does NOT hand-roll money: the new paymentStatus comes from
 * computeBillFinancialsFromPersisted, the same function the API uses. Writes an
 * AuditLog row so a ₹X discount does not silently vanish off the books.
 *
 *   npx tsx prisma/clear-bill-discount.ts D-CNT-002281 [--commit]
 */
import { PrismaClient } from '@prisma/client';
import { computeBillFinancialsFromPersisted } from '../src/services/billFinancialService';

const prisma = new PrismaClient();
const billNumber = process.argv[2];
const commit = process.argv.includes('--commit');
const r = (p: number) => `₹${(p / 100).toFixed(2)}`;

(async () => {
  if (!billNumber) throw new Error('usage: clear-bill-discount.ts <billNumber> [--commit]');
  const bill = await prisma.bill.findFirst({
    where: { billNumber },
    include: { transactions: true, visit: { select: { patient: { select: { name: true } } } } },
  });
  if (!bill) throw new Error(`bill ${billNumber} not found`);

  const before = computeBillFinancialsFromPersisted(bill);
  if (bill.discountAmountInPaise === 0 && !bill.discountType) {
    console.log(`${billNumber}: no discount to clear — nothing to do.`);
    return;
  }

  const cleared = {
    discountType: null,
    discountPercentage: null,
    discountAmountInPaise: 0,
    discountReason: null,
    discountedByUserId: null,
  };
  const after = computeBillFinancialsFromPersisted({ ...bill, ...cleared });

  console.log(`${billNumber} · ${bill.visit.patient.name}`);
  console.log(`  subtotal   ${r(bill.totalAmountInPaise)}`);
  console.log(`  discount   ${r(before.discountAmountInPaise)} (${bill.discountType} ${bill.discountPercentage}%) "${bill.discountReason}"  ->  ₹0.00`);
  console.log(`  net        ${r(before.netAmountInPaise)}  ->  ${r(after.netAmountInPaise)}`);
  console.log(`  paid       ${r(before.paidAmountInPaise)}  ->  ${r(after.paidAmountInPaise)}`);
  console.log(`  due        ${r(before.dueAmountInPaise)}  ->  ${r(after.dueAmountInPaise)}`);
  console.log(`  status     ${before.paymentStatus}  ->  ${after.paymentStatus}`);

  if (!commit) {
    console.log('\nDRY RUN — re-run with --commit to write.');
    return;
  }

  await prisma.$transaction([
    prisma.bill.update({
      where: { id: bill.id },
      data: { ...cleared, paymentStatus: after.paymentStatus },
    }),
    prisma.auditLog.create({
      data: {
        branchId: bill.branchId,
        actionType: 'UPDATE',
        entityType: 'Bill',
        entityId: bill.id,
        oldValues: JSON.stringify({
          discountType: bill.discountType,
          discountPercentage: bill.discountPercentage,
          discountAmountInPaise: bill.discountAmountInPaise,
          discountReason: bill.discountReason,
          discountedByUserId: bill.discountedByUserId,
          paymentStatus: bill.paymentStatus,
        }),
        newValues: JSON.stringify({
          ...cleared,
          paymentStatus: after.paymentStatus,
          via: 'prisma/clear-bill-discount.ts',
        }),
      },
    }),
  ]);
  console.log('\nCOMMITTED.');
})().finally(() => prisma.$disconnect());
