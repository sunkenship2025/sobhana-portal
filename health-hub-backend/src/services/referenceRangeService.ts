/**
 * Reference Range Service (Step 28)
 *
 * Resolves the correct reference range for a lab test based on
 * patient age (from yearOfBirth) and gender, using TestAgeRange rows.
 * Falls back to the default LabTest.referenceMin / referenceMax if
 * no age-specific range matches.
 */

import { PrismaClient, Gender } from '@prisma/client';
const prisma = new PrismaClient();

export interface ResolvedRange {
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  referenceText: string | null;
  source: 'age-range' | 'default'; // how the range was resolved
}

/**
 * Resolve the reference range for a test, considering patient demographics.
 *
 * Match logic (TestAgeRange):
 *   - minAgeYears <= patientAge <= maxAgeYears  (null bounds = open-ended)
 *   - gender matches OR TestAgeRange.gender is null (gender-neutral)
 *
 * Falls back to LabTest.referenceMin/Max/Unit/Text if no range matches.
 *
 * @param testId        - The LabTest.id
 * @param yearOfBirth   - Patient.yearOfBirth (always present)
 * @param patientGender - Patient.gender (M | F | O)
 */
export async function resolveReferenceRange(
  testId: string,
  yearOfBirth: number,
  patientGender: Gender
): Promise<ResolvedRange> {
  const currentYear = new Date().getFullYear();
  const patientAge = currentYear - yearOfBirth;

  // Find matching age-range rows (most specific first)
  const ageRanges = await prisma.testAgeRange.findMany({
    where: {
      testId,
      OR: [
        { gender: patientGender },
        { gender: null }, // gender-neutral ranges
      ],
    },
    orderBy: [
      { gender: 'asc' }, // gender-specific rows first (M/F before null)
      { minAgeYears: 'asc' },
    ],
  });

  // Find first matching range
  for (const range of ageRanges) {
    const minOk = range.minAgeYears === null || patientAge >= range.minAgeYears;
    const maxOk = range.maxAgeYears === null || patientAge <= range.maxAgeYears;

    if (minOk && maxOk) {
      // Prefer gender-specific over gender-neutral
      return {
        referenceMin: range.referenceMin,
        referenceMax: range.referenceMax,
        referenceUnit: range.referenceUnit,
        referenceText: range.referenceText,
        source: 'age-range',
      };
    }
  }

  // Fallback: use LabTest default reference values
  const test = await prisma.labTest.findUnique({
    where: { id: testId },
    select: {
      referenceMin: true,
      referenceMax: true,
      referenceUnit: true,
      referenceText: true,
    },
  });

  return {
    referenceMin: test?.referenceMin ?? null,
    referenceMax: test?.referenceMax ?? null,
    referenceUnit: test?.referenceUnit ?? null,
    referenceText: test?.referenceText ?? null,
    source: 'default',
  };
}

/**
 * Bulk resolve ranges for multiple tests at once.
 * Used by report snapshot generation.
 */
export async function resolveReferenceRanges(
  testIds: string[],
  yearOfBirth: number,
  patientGender: Gender
): Promise<Map<string, ResolvedRange>> {
  const results = new Map<string, ResolvedRange>();

  // Run in parallel for speed
  await Promise.all(
    testIds.map(async (testId) => {
      const range = await resolveReferenceRange(testId, yearOfBirth, patientGender);
      results.set(testId, range);
    })
  );

  return results;
}
