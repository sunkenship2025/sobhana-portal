/**
 * Correct referral doctors quick-added at the old 10% default to 50%:
 *  1. ReferralDoctor.commissionPercent 10 → 50 (PERCENTAGE type only)
 *  2. TestOrder.referralCommissionPercentage snapshots 10 → 50, scoped to
 *     visits referred by those doctors (payout derivation reads the snapshot,
 *     not the doctor row)
 *  3. Refresh unpaid ledger rows for those doctors via derivePayout (paid
 *     rows are immutable and are skipped; verified none exist for these
 *     doctors before running)
 */
import { PrismaClient } from '@prisma/client';
import { derivePayout } from '../src/services/payoutService';

const prisma = new PrismaClient();

async function main() {
  const doctors = await prisma.referralDoctor.findMany({
    where: { commissionType: 'PERCENTAGE', commissionPercent: 10 },
    select: { id: true, doctorNumber: true, name: true },
  });
  console.log(`Doctors at 10%: ${doctors.length}`);
  for (const d of doctors) console.log(`  ${d.doctorNumber} ${d.name}`);
  if (doctors.length === 0) return;

  const doctorIds = doctors.map((d) => d.id);

  const paidLedgers = await prisma.doctorPayoutLedger.count({
    where: {
      doctorType: 'REFERRAL',
      referralDoctorId: { in: doctorIds },
      deletedAt: null,
      paidAt: { not: null },
    },
  });
  if (paidLedgers > 0) {
    throw new Error(
      `${paidLedgers} PAID ledger row(s) exist for these doctors — aborting; resolve manually`
    );
  }

  const docResult = await prisma.referralDoctor.updateMany({
    where: { id: { in: doctorIds }, commissionType: 'PERCENTAGE', commissionPercent: 10 },
    data: { commissionPercent: 50 },
  });
  console.log(`\nUpdated ${docResult.count} doctors to 50%`);

  const orderResult = await prisma.testOrder.updateMany({
    where: {
      referralCommissionType: 'PERCENTAGE',
      referralCommissionPercentage: 10,
      visit: { referrals: { some: { referralDoctorId: { in: doctorIds } } } },
    },
    data: { referralCommissionPercentage: 50 },
  });
  console.log(`Updated ${orderResult.count} test-order commission snapshots to 50%`);

  const pendingLedgers = await prisma.doctorPayoutLedger.findMany({
    where: {
      doctorType: 'REFERRAL',
      referralDoctorId: { in: doctorIds },
      deletedAt: null,
      paidAt: null,
    },
    select: {
      id: true,
      referralDoctorId: true,
      branchId: true,
      periodStartDate: true,
      periodEndDate: true,
      derivedAmountInPaise: true,
      referralDoctor: { select: { doctorNumber: true, name: true } },
    },
  });
  console.log(`\nRefreshing ${pendingLedgers.length} unpaid ledger row(s):`);
  for (const l of pendingLedgers) {
    const { payout } = await derivePayout(
      'REFERRAL',
      l.referralDoctorId!,
      l.branchId,
      l.periodStartDate,
      l.periodEndDate
    );
    console.log(
      `  ${l.referralDoctor?.doctorNumber} ${l.referralDoctor?.name}: ` +
      `₹${(l.derivedAmountInPaise / 100).toFixed(2)} → ₹${(payout.derivedAmountInPaise / 100).toFixed(2)}`
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
