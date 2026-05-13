/**
 * One-time: set sampleType = 'N/A' on every ClinicalPanel under the RADIOLOGY
 * department. Radiology / imaging studies have no biological sample, so the
 * patient-info block should print "N/A" instead of "—" on the report.
 *
 * Idempotent: rows already set to 'N/A' are skipped.
 *
 * Run:
 *   npx tsx scripts/setRadiologySampleTypeNA.ts                # dry run
 *   npx tsx scripts/setRadiologySampleTypeNA.ts --apply        # commit
 */

import prisma from '../src/lib/prisma';

const APPLY = process.argv.includes('--apply');

async function main() {
  const panels = await prisma.clinicalPanel.findMany({
    where: { department: { name: 'RADIOLOGY' } },
    select: { id: true, name: true, displayName: true, sampleType: true },
  });

  console.log(`Mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no DB writes)'}`);
  console.log(`Inspecting ${panels.length} radiology panels.\n`);

  const toUpdate = panels.filter(p => p.sampleType !== 'N/A');

  if (toUpdate.length === 0) {
    console.log('All radiology panels already have sampleType = "N/A". Nothing to do.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Would update ${toUpdate.length} panel(s):\n`);
  for (const p of toUpdate) {
    console.log(`  • ${p.name} (${p.displayName}) — current: ${p.sampleType ?? 'null'}`);
  }

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to commit.');
    await prisma.$disconnect();
    return;
  }

  console.log('\nApplying...');
  const result = await prisma.clinicalPanel.updateMany({
    where: {
      id: { in: toUpdate.map(p => p.id) },
    },
    data: { sampleType: 'N/A' },
  });
  console.log(`Done. Updated ${result.count} panel(s).`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
