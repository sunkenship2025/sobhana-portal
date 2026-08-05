import prisma from '../src/lib/prisma';

async function main() {
  const rows = await prisma.$queryRawUnsafe<Array<{ column_name: string }>>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'ClinicalPanel' AND column_name IN ('comments','interpretation')
     ORDER BY column_name`,
  );
  const found = rows.map((r) => r.column_name);
  console.log('ClinicalPanel new columns present on PROD:', found.length ? found.join(', ') : 'NONE');
  console.log(found.length === 2 ? '✅ migrated — safe to finalize' : '⛔ NOT migrated yet — do NOT run finalize');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
