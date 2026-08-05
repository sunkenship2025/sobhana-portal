import prisma from '../src/lib/prisma';

const VISIT_IDS = [
  'cmr8vh706054z6scltvp7fto6', // D-CNT-000379 AMBATI SONIKA (ECG)
  'cmrhigj54021o73ymvopve6om', // D-CNT-000588 Y. JAYANTHI (Urine C&S)
  'cmr3l2v8t04yex4sv5jaaoyld', // D-CNT-000517 MADHU PRIYA (Thyroid)
  'cmrbpygyd074nsjey4t5uzfq0', // D-BLN-000642 MEGHANA (USG Abdomen + Thyroid)
];

async function main() {
  for (const id of VISIT_IDS) {
    const v = await prisma.visit.findUnique({
      where: { id },
      select: {
        billNumber: true,
        status: true,
        branchId: true,
        report: {
          select: {
            id: true,
            versions: {
              orderBy: { versionNum: 'desc' },
              select: { id: true, versionNum: true, status: true },
            },
          },
        },
        testOrders: {
          select: {
            id: true,
            testNameSnapshot: true,
            workflowMode: true,
            noReportAt: true,
            cancelledAt: true,
          },
        },
      },
    });
    const vers = v?.report?.versions ?? [];
    console.log(`\n${v?.billNumber}  visit=${v?.status}  reportId=${v?.report?.id}`);
    console.log(`  versions: ${vers.map((x) => `v${x.versionNum}:${x.status}`).join(', ')}`);
    console.log(`  hasOpenDraft=${vers.some((x) => x.status === 'DRAFT')}  latestFinalized=${vers.find((x) => x.status === 'FINALIZED')?.versionNum ?? 'none'}`);
    console.log('  test orders:');
    for (const o of v?.testOrders ?? []) {
      console.log(`    ${o.testNameSnapshot}  mode=${o.workflowMode}  noReportAt=${o.noReportAt ? 'SET' : 'null'}  cancelled=${o.cancelledAt ? 'yes' : 'no'}  id=${o.id}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
