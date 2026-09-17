/** Prefix prefetch must narrow to exactly what the exact lookup returns. */
import { searchPatients } from './src/services/patientService';
import prisma from './src/lib/prisma';
(async () => {
  const rows: { value: string }[] = await prisma.$queryRawUnsafe(
    `SELECT value FROM "PatientIdentifier" WHERE type='PHONE' AND length(value)=10 ORDER BY random() LIMIT 8`);
  let bad = 0;
  for (const { value } of rows) {
    const pre: any = await searchPatients({ phonePrefix: value.slice(0, 7) });
    const exact: any = await searchPatients({ phone: value });
    const narrowed = pre.length >= 25 ? null : pre.filter((p: any) =>
      (p.patient?.identifiers ?? []).some((i: any) => i.type === 'PHONE' && i.value === value));
    const ok = narrowed === null || narrowed.length === exact.length;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${value}  prefix ${pre.length} → narrowed ${narrowed?.length ?? 'fallback'}  exact ${exact.length}`);
  }
  console.log(bad ? `\n${bad} FAILED` : '\nall clean');
  await prisma.$disconnect(); process.exit(bad ? 1 : 0);
})();
