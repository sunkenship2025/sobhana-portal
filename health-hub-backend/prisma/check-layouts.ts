import prisma from '../src/lib/prisma';

async function main() {
  const enums = await prisma.$queryRawUnsafe<Array<{ enumlabel: string }>>(
    `SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON e.enumtypid = t.oid
     WHERE t.typname = 'PanelLayoutType' ORDER BY e.enumsortorder`,
  );
  console.log('PROD PanelLayoutType enum values:', enums.map((e) => e.enumlabel).join(', '));

  const dist = await prisma.$queryRawUnsafe<Array<{ lt: string; n: number }>>(
    `SELECT "layoutType"::text AS lt, count(*)::int AS n FROM "ClinicalPanel" GROUP BY 1 ORDER BY 2 DESC`,
  );
  console.log('\nClinicalPanel layoutType distribution:');
  for (const r of dist) console.log(`  ${r.lt}: ${r.n}`);

  // Any FINALIZED snapshot that froze a CBP/WIDAL layoutType? (would hit the legacy renderers)
  const snap = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
    `SELECT count(*)::int AS n FROM "ReportVersion"
     WHERE status = 'FINALIZED' AND "panelsSnapshot"::text ~ '"layoutType"\\s*:\\s*"(CBP|WIDAL)"'`,
  );
  console.log(`\nFinalized snapshots with a CBP/WIDAL layoutType: ${snap[0]?.n ?? 0}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
