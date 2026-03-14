/**
 * Reference Range Service
 *
 * Resolves the correct reference range for a test based on
 * patient age and gender.
 *
 * Supports BOTH architectures:
 *   - Legacy: LabTest.id → TestAgeRange rows
 *   - New:    TestDefinition.id → TestDefinitionRange rows
 *
 * Falls back to the default reference values if no age-specific range matches.
 */

import { PrismaClient, Gender } from '@prisma/client';
const prisma = new PrismaClient();

/**
 * Calculate patient age in days.
 * Uses dateOfBirth for precision when available, otherwise falls back to yearOfBirth (Jan 1 approximation).
 */
function calculateAgeDays(yearOfBirth: number, dateOfBirth?: Date | null): number {
  const now = new Date();
  if (dateOfBirth) {
    return Math.floor((now.getTime() - new Date(dateOfBirth).getTime()) / (1000 * 60 * 60 * 24));
  }
  return Math.floor((now.getTime() - new Date(yearOfBirth, 0, 1).getTime()) / (1000 * 60 * 60 * 24));
}

export interface ResolvedRange {
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  referenceText: string | null;
  criticalMin: number | null;
  criticalMax: number | null;
  source: 'age-range' | 'definition-range' | 'default';
}

/**
 * Resolve reference range using TestDefinitionRange (new architecture).
 * Falls back to TestDefinition default values.
 */
export async function resolveByTestDefinition(
  testDefinitionId: string,
  yearOfBirth: number,
  patientGender: Gender,
  dateOfBirth?: Date | null
): Promise<ResolvedRange> {
  const patientAgeDays = calculateAgeDays(yearOfBirth, dateOfBirth);

  // Find matching TestDefinitionRange rows
  // Order: gender-specific first (desc puts 'M'/'F' before null), then narrowest age range first
  const ranges = await prisma.testDefinitionRange.findMany({
    where: {
      testDefinitionId,
      OR: [
        { gender: patientGender },
        { gender: null },
      ],
    },
    orderBy: [
      { gender: 'desc' },
      { minAgeDays: 'desc' },
    ],
  });

  for (const range of ranges) {
    const minOk = range.minAgeDays === null || patientAgeDays >= range.minAgeDays;
    const maxOk = range.maxAgeDays === null || patientAgeDays <= range.maxAgeDays;

    if (minOk && maxOk) {
      // If the matching range doesn't have a unit, fall back to TestDefinition default
      let unit = range.referenceUnit;
      if (!unit) {
        const def = await prisma.testDefinition.findUnique({
          where: { id: testDefinitionId },
          select: { referenceUnit: true },
        });
        unit = def?.referenceUnit ?? null;
      }

      return {
        referenceMin: range.referenceMin,
        referenceMax: range.referenceMax,
        referenceUnit: unit,
        referenceText: range.referenceText,
        criticalMin: range.criticalMin,
        criticalMax: range.criticalMax,
        source: 'definition-range',
      };
    }
  }

  // Fallback: TestDefinition default values
  const def = await prisma.testDefinition.findUnique({
    where: { id: testDefinitionId },
    select: {
      referenceMin: true,
      referenceMax: true,
      referenceUnit: true,
      referenceText: true,
      criticalMin: true,
      criticalMax: true,
    },
  });

  return {
    referenceMin: def?.referenceMin ?? null,
    referenceMax: def?.referenceMax ?? null,
    referenceUnit: def?.referenceUnit ?? null,
    referenceText: def?.referenceText ?? null,
    criticalMin: def?.criticalMin ?? null,
    criticalMax: def?.criticalMax ?? null,
    source: 'default',
  };
}

/**
 * Legacy: Resolve reference range using TestAgeRange (old architecture).
 * Falls back to LabTest default values.
 */
export async function resolveReferenceRange(
  testId: string,
  yearOfBirth: number,
  patientGender: Gender,
  dateOfBirth?: Date | null
): Promise<ResolvedRange> {
  const patientAgeDays = calculateAgeDays(yearOfBirth, dateOfBirth);

  const ageRanges = await prisma.testAgeRange.findMany({
    where: {
      testId,
      OR: [
        { gender: patientGender },
        { gender: null },
      ],
    },
    orderBy: [
      { gender: 'desc' },
      { minAgeDays: 'desc' },
    ],
  });

  for (const range of ageRanges) {
    const minOk = range.minAgeDays === null || patientAgeDays >= range.minAgeDays;
    const maxOk = range.maxAgeDays === null || patientAgeDays <= range.maxAgeDays;

    if (minOk && maxOk) {
      // If the matching range doesn't have a unit, fall back to LabTest default
      let unit = range.referenceUnit;
      if (!unit) {
        const labTest = await prisma.labTest.findUnique({
          where: { id: testId },
          select: { referenceUnit: true },
        });
        unit = labTest?.referenceUnit ?? null;
      }

      return {
        referenceMin: range.referenceMin,
        referenceMax: range.referenceMax,
        referenceUnit: unit,
        referenceText: range.referenceText,
        criticalMin: null,
        criticalMax: null,
        source: 'age-range',
      };
    }
  }

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
    criticalMin: null,
    criticalMax: null,
    source: 'default',
  };
}

/**
 * Bulk resolve ranges for multiple tests at once.
 * Used by report snapshot generation.
 * Prefers TestDefinition ranges when testDefinitionId is available.
 */
export async function resolveReferenceRanges(
  testIds: string[],
  yearOfBirth: number,
  patientGender: Gender,
  testDefinitionIds?: Map<string, string>, // testId → testDefinitionId mapping
  dateOfBirth?: Date | null
): Promise<Map<string, ResolvedRange>> {
  const results = new Map<string, ResolvedRange>();

  await Promise.all(
    testIds.map(async (testId) => {
      const defId = testDefinitionIds?.get(testId);
      let range: ResolvedRange;

      if (defId) {
        // New architecture
        range = await resolveByTestDefinition(defId, yearOfBirth, patientGender, dateOfBirth);
      } else {
        // Legacy
        range = await resolveReferenceRange(testId, yearOfBirth, patientGender, dateOfBirth);
      }

      results.set(testId, range);
    })
  );

  return results;
}
