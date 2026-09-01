/**
 * One-off repair for visits stranded by the add-tests / swap-product gap:
 * a COMPLETED diagnostic visit that still carries a LIVE reportable /
 * external-upload order and has no FINALIZED report version. Such a visit
 * appears in neither Pending Results (which lists DRAFT + WAITING) nor as a
 * real finalized report — the test is billed and unenterable.
 *
 * Sends it back to DRAFT, creating the DiagnosticReport + v1 draft when the
 * visit was originally billed bill-only (no report row exists at all).
 *
 *   npx tsx prisma/reopen-stranded-visits.ts            # dry run
 *   npx tsx prisma/reopen-stranded-visits.ts --commit   # apply
 */
import { PrismaClient, DiagnosticWorkflowMode } from '@prisma/client';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL } },
});
const COMMIT = process.argv.includes('--commit');

async function main() {
  const candidates = await prisma.visit.findMany({
    where: {
      domain: 'DIAGNOSTICS',
      status: 'COMPLETED',
      testOrders: {
        some: {
          cancelledAt: null,
          noReportAt: null,
          workflowMode: { in: [DiagnosticWorkflowMode.REPORTABLE, DiagnosticWorkflowMode.EXTERNAL_UPLOAD] },
        },
      },
    },
    select: {
      id: true,
      branchId: true,
      billNumber: true,
      createdAt: true,
      patient: { select: { name: true } },
      report: { select: { id: true, versions: { select: { status: true } } } },
      testOrders: {
        where: { cancelledAt: null, noReportAt: null, workflowMode: { in: [DiagnosticWorkflowMode.REPORTABLE, DiagnosticWorkflowMode.EXTERNAL_UPLOAD] } },
        select: { testNameSnapshot: true },
      },
    },
    orderBy: { createdAt: 'desc' },
  });

  // A finalized version means the visit is legitimately done (the live order was
  // released in a partial, say) — only never-finalized ones are stranded.
  const stranded = candidates.filter(
    (v) => !v.report?.versions.some((version) => version.status === 'FINALIZED'),
  );

  for (const v of stranded) {
    console.log(
      `${v.billNumber ?? v.id}  ${v.createdAt.toISOString().slice(0, 10)}  ${v.patient?.name ?? '?'}` +
        `  [${v.testOrders.map((o) => o.testNameSnapshot).join(', ')}]` +
        `${v.report ? '' : '  (+ needs report/draft)'}`,
    );
  }
  console.log(`\n${stranded.length} stranded visit(s). ${COMMIT ? 'Applying...' : 'Dry run — pass --commit to fix.'}`);
  if (!COMMIT) return;

  for (const v of stranded) {
    await prisma.$transaction(async (tx) => {
      await tx.visit.update({ where: { id: v.id }, data: { status: 'DRAFT' } });
      if (!v.report) {
        const report = await tx.diagnosticReport.create({
          data: { visitId: v.id, branchId: v.branchId },
        });
        await tx.reportVersion.create({
          data: { reportId: report.id, versionNum: 1, status: 'DRAFT' },
        });
      }
    });
    console.log(`  reopened ${v.billNumber ?? v.id}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
