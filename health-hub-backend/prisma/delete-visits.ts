/**
 * Targeted visit deletion by billNumber.
 *
 * Usage:
 *   Dry run (default — shows what would be deleted, makes no changes):
 *     npx ts-node prisma/delete-visits.ts D-CNT-00002 D-CNT-00003
 *
 *   Real delete (irreversible):
 *     npx ts-node prisma/delete-visits.ts D-CNT-00002 D-CNT-00003 --confirm
 *
 * Cascades per schema: Bill, TestOrder, DiagnosticReport, ReportVersion,
 * TestResult, ReferralDoctor_Visit, ClinicVisit, PaymentTransaction.
 */
import { PrismaClient } from '@prisma/client';

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const billNumbers = args.filter((a) => !a.startsWith('--'));

  if (billNumbers.length === 0) {
    console.error('Provide at least one billNumber. Example: npx ts-node prisma/delete-visits.ts D-CNT-00002');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    for (const billNumber of billNumbers) {
      const visit = await prisma.visit.findFirst({
        where: { billNumber },
        include: {
          _count: {
            select: {
              testOrders: true,
            },
          },
          bill: { select: { id: true } },
          report: { select: { id: true } },
        },
      });

      if (!visit) {
        console.log(`[skip] ${billNumber} — not found`);
        continue;
      }

      console.log(
        `[match] ${billNumber} (visitId=${visit.id}) — bill=${visit.bill ? 'yes' : 'no'} report=${visit.report ? 'yes' : 'no'} testOrders=${visit._count.testOrders}`,
      );
    }

    if (!confirm) {
      console.log('\nDry run only. Re-run with --confirm to actually delete.');
      return;
    }

    console.log('\n--confirm passed. Deleting...');
    const result = await prisma.visit.deleteMany({
      where: { billNumber: { in: billNumbers } },
    });
    console.log(`Deleted ${result.count} visit(s) (cascaded to bills, reports, results, etc.)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
