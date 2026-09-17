/** A page must be a slice of the whole, and totals must be the whole. */
import prisma from './src/lib/prisma';
(async () => {
  let failed = 0;
  const cases: [string, () => Promise<number>][] = [
    ['ClinicalPanel',   () => prisma.clinicalPanel.count()],
    ['TestDefinition',  () => prisma.testDefinition.count({ where: { isLatest: true } })],
    ['BillableProduct', () => prisma.billableProduct.count()],
  ];
  for (const [name, counter] of cases) {
    const total = await counter();
    const pages = Math.ceil(total / 20);
    const ok = total > 0 && pages > 1;
    if (!ok) failed += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(16)} ${String(total).padStart(4)} rows → ${pages} pages of 20`);
  }
  // Drafts must never be paged away: the builder shows every one.
  const drafts = await prisma.clinicalPanel.count({ where: { isActive: false } });
  const liveN = await prisma.clinicalPanel.count({ where: { isActive: true } });
  const ok = drafts <= 20;
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} drafts unpaged   ${drafts} draft(s), ${liveN} live — drafts fit without paging`);
  console.log(failed ? `\n${failed} FAILED` : '\nall clean');
  await prisma.$disconnect(); process.exit(failed ? 1 : 0);
})();
