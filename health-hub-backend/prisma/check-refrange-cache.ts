/**
 * Verifies the reference-range cache did not change a single resolved range.
 *
 * The cache moved the gender filter out of SQL and into JS, and replaced the
 * per-hit unit/default lookups with one cached blob. That is exactly the kind
 * of refactor that silently shifts a boundary (NULLS FIRST vs LAST, a missing
 * unit fallback) and puts a wrong normal range on a patient report. So: run
 * the ORIGINAL queries directly, run the new resolver, assert equality across
 * every definition that actually has ranges, for both genders and a spread of
 * ages.
 *
 *   npx tsx prisma/check-refrange-cache.ts
 */
import { PrismaClient, Gender } from '@prisma/client';
import { resolveByTestDefinition } from '../src/services/referenceRangeService';

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_DATABASE_URL || process.env.DATABASE_URL } },
});

// The pre-cache implementation, verbatim, as the oracle.
async function original(testDefinitionId: string, ageDays: number, patientGender: Gender) {
  const ranges = await prisma.testDefinitionRange.findMany({
    where: { testDefinitionId, OR: [{ gender: patientGender }, { gender: null }] },
    orderBy: [{ gender: 'desc' }, { minAgeDays: 'desc' }],
  });
  for (const range of ranges) {
    const minOk = range.minAgeDays === null || ageDays >= range.minAgeDays;
    const maxOk = range.maxAgeDays === null || ageDays <= range.maxAgeDays;
    if (minOk && maxOk) {
      let unit = range.referenceUnit;
      if (!unit) {
        const d = await prisma.testDefinition.findUnique({
          where: { id: testDefinitionId }, select: { referenceUnit: true },
        });
        unit = d?.referenceUnit ?? null;
      }
      return {
        referenceMin: range.referenceMin, referenceMax: range.referenceMax,
        referenceUnit: unit, referenceText: range.referenceText,
        criticalMin: range.criticalMin, criticalMax: range.criticalMax,
        source: 'definition-range',
      };
    }
  }
  const def = await prisma.testDefinition.findUnique({
    where: { id: testDefinitionId },
    select: {
      referenceMin: true, referenceMax: true, referenceUnit: true,
      referenceText: true, criticalMin: true, criticalMax: true,
    },
  });
  return {
    referenceMin: def?.referenceMin ?? null, referenceMax: def?.referenceMax ?? null,
    referenceUnit: def?.referenceUnit ?? null, referenceText: def?.referenceText ?? null,
    criticalMin: def?.criticalMin ?? null, criticalMax: def?.criticalMax ?? null,
    source: 'default',
  };
}

const AGES: Array<[string, number]> = [
  ['newborn', 2], ['infant', 200], ['child', 8], ['teen', 15],
  ['adult', 34], ['elderly', 72],
];

async function main() {
  const withRanges = await prisma.testDefinitionRange.findMany({
    distinct: ['testDefinitionId'],
    select: { testDefinitionId: true },
  });
  console.log(`${withRanges.length} definitions carry ranges; ${withRanges.length * AGES.length * 2} combos to check.\n`);

  let checked = 0;
  const failures: string[] = [];
  for (const { testDefinitionId } of withRanges) {
    for (const [label, years] of AGES) {
      for (const gender of [Gender.M, Gender.F]) {
        const yearOfBirth = new Date().getFullYear() - (label === 'newborn' || label === 'infant' ? 0 : years);
        const dob = label === 'newborn' ? new Date(Date.now() - 2 * 86400_000)
          : label === 'infant' ? new Date(Date.now() - 200 * 86400_000)
          : null;
        const ageDays = dob
          ? Math.floor((Date.now() - dob.getTime()) / 86400_000)
          : Math.floor((Date.now() - new Date(yearOfBirth, 0, 1).getTime()) / 86400_000);

        const [expected, actual] = await Promise.all([
          original(testDefinitionId, ageDays, gender),
          resolveByTestDefinition(testDefinitionId, yearOfBirth, gender, dob),
        ]);
        checked++;
        if (JSON.stringify(expected) !== JSON.stringify(actual)) {
          failures.push(
            `${testDefinitionId} ${label}/${gender}\n    old ${JSON.stringify(expected)}\n    new ${JSON.stringify(actual)}`,
          );
        }
      }
    }
  }

  console.log(`checked ${checked} combos`);
  if (failures.length) {
    console.error(`\nMISMATCH on ${failures.length}:\n  ${failures.slice(0, 10).join('\n  ')}`);
    process.exit(1);
  }
  console.log('all identical — cache is behaviour-preserving');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
