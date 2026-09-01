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

import { Gender } from '@prisma/client';
import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';

/**
 * Reference-range lookups were the largest query group in production by a wide
 * margin — ~26,000 calls/day, over half of every statement the app ran, one
 * round trip per analyte per render, for catalog data that barely changes.
 *
 * Safe to cache by id with NO invalidation hook, because the rows are
 * write-once. Editing a definition or its ranges does not mutate anything:
 * clinicalDefinitionService.updateDefinition LOCKS the current row
 * (isLatest:false, status:LOCKED), creates a NEW TestDefinition id, clones the
 * ranges onto it, and re-points panel items + product pins at the new id.
 * testDefinitionRange / testAgeRange have no update or delete path anywhere in
 * the backend — only createMany onto a freshly created id. So a range edit
 * produces a DIFFERENT key (a natural miss) and a cached entry can never
 * disagree with the id it is filed under. The TTL is a backstop, not the
 * correctness mechanism.
 *
 * The legacy blob is the one exception and gets its own short TTL: it reads
 * critical thresholds through `TestDefinition WHERE code = ? AND isLatest`,
 * and isLatest MOVES to the new version on edit.
 */
const KEY_PREFIX = 'refrange:v1:';
const TTL_SECONDS = 6 * 60 * 60;
const LEGACY_TTL_SECONDS = 10 * 60;

async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T>): Promise<T> {
  const redis = getRedisClient();
  if (!redis) return load();

  try {
    const hit = await redis.get(KEY_PREFIX + key);
    if (hit) return JSON.parse(hit) as T;
  } catch (err) {
    // Never fail a report render over the cache — fall through to Postgres.
    logger.warn({ err }, 'reference-range cache read failed');
  }

  const value = await load();
  try {
    await redis.set(KEY_PREFIX + key, JSON.stringify(value), 'EX', ttlSeconds);
  } catch (err) {
    logger.warn({ err }, 'reference-range cache write failed');
  }
  return value;
}

/**
 * Every range row for a definition, plus the definition's own defaults, in one
 * blob. Gender is deliberately NOT part of the query: it would multiply the
 * cache keys, and the rows are filtered in memory below instead. The ORDER BY
 * is unchanged from the pre-cache version, and filtering an ordered array
 * preserves order, so resolution sees exactly the sequence it always did.
 */
type DefinitionRangeBlob = {
  ranges: Array<{
    minAgeDays: number | null;
    maxAgeDays: number | null;
    gender: Gender | null;
    referenceMin: number | null;
    referenceMax: number | null;
    referenceUnit: string | null;
    referenceText: string | null;
    criticalMin: number | null;
    criticalMax: number | null;
  }>;
  fallback: {
    referenceMin: number | null;
    referenceMax: number | null;
    referenceUnit: string | null;
    referenceText: string | null;
    criticalMin: number | null;
    criticalMax: number | null;
  } | null;
};

function loadDefinitionBlob(testDefinitionId: string): Promise<DefinitionRangeBlob> {
  return cached(`def:${testDefinitionId}`, TTL_SECONDS, async () => {
    const [ranges, fallback] = await Promise.all([
      prisma.testDefinitionRange.findMany({
        where: { testDefinitionId },
        select: {
          minAgeDays: true,
          maxAgeDays: true,
          gender: true,
          referenceMin: true,
          referenceMax: true,
          referenceUnit: true,
          referenceText: true,
          criticalMin: true,
          criticalMax: true,
        },
        orderBy: [{ gender: 'desc' }, { minAgeDays: 'desc' }],
      }),
      prisma.testDefinition.findUnique({
        where: { id: testDefinitionId },
        select: {
          referenceMin: true,
          referenceMax: true,
          referenceUnit: true,
          referenceText: true,
          criticalMin: true,
          criticalMax: true,
        },
      }),
    ]);
    return { ranges, fallback };
  });
}

type LegacyRangeBlob = {
  ageRanges: Array<{
    minAgeDays: number | null;
    maxAgeDays: number | null;
    gender: Gender | null;
    referenceMin: number | null;
    referenceMax: number | null;
    referenceUnit: string | null;
    referenceText: string | null;
  }>;
  test: {
    referenceMin: number | null;
    referenceMax: number | null;
    referenceUnit: string | null;
    referenceText: string | null;
  } | null;
  criticalMin: number | null;
  criticalMax: number | null;
};

function loadLegacyBlob(testId: string): Promise<LegacyRangeBlob> {
  return cached(`lab:${testId}`, LEGACY_TTL_SECONDS, async () => {
    const [test, ageRanges] = await Promise.all([
      prisma.labTest.findUnique({
        where: { id: testId },
        select: {
          code: true,
          referenceMin: true,
          referenceMax: true,
          referenceUnit: true,
          referenceText: true,
        },
      }),
      prisma.testAgeRange.findMany({
        where: { testId },
        select: {
          minAgeDays: true,
          maxAgeDays: true,
          gender: true,
          referenceMin: true,
          referenceMax: true,
          referenceUnit: true,
          referenceText: true,
        },
        orderBy: [{ gender: 'desc' }, { minAgeDays: 'desc' }],
      }),
    ]);

    // Legacy LabTest/TestAgeRange have no critical columns — borrow the panic
    // thresholds from the matching new-architecture TestDefinition (same code).
    let criticalMin: number | null = null;
    let criticalMax: number | null = null;
    if (test?.code) {
      const td = await prisma.testDefinition.findFirst({
        where: { code: test.code, isLatest: true },
        select: { criticalMin: true, criticalMax: true },
      });
      criticalMin = td?.criticalMin ?? null;
      criticalMax = td?.criticalMax ?? null;
    }

    const { code: _code, ...defaults } = test ?? {};
    return {
      ageRanges,
      test: test ? (defaults as LegacyRangeBlob['test']) : null,
      criticalMin,
      criticalMax,
    };
  });
}

/** Same predicate the SQL used: the patient's gender, or a gender-neutral row. */
function matchesGender(rowGender: Gender | null, patientGender: Gender): boolean {
  return rowGender === patientGender || rowGender === null;
}

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

  // Gender-specific rows first, then narrowest age range — the blob preserves
  // that ORDER BY, and filtering an ordered array keeps it.
  const { ranges: allRanges, fallback } = await loadDefinitionBlob(testDefinitionId);
  const ranges = allRanges.filter((r) => matchesGender(r.gender, patientGender));

  for (const range of ranges) {
    const minOk = range.minAgeDays === null || patientAgeDays >= range.minAgeDays;
    const maxOk = range.maxAgeDays === null || patientAgeDays <= range.maxAgeDays;

    if (minOk && maxOk) {
      // If the matching range doesn't have a unit, fall back to TestDefinition
      // default. `||` not `??`: the pre-cache code guarded with `if (!unit)`, so
      // an EMPTY STRING falls back too. The inner `??` is deliberate — a blank
      // default resolved to "" before, not null.
      const unit = range.referenceUnit || (fallback?.referenceUnit ?? null);

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
  return {
    referenceMin: fallback?.referenceMin ?? null,
    referenceMax: fallback?.referenceMax ?? null,
    referenceUnit: fallback?.referenceUnit ?? null,
    referenceText: fallback?.referenceText ?? null,
    criticalMin: fallback?.criticalMin ?? null,
    criticalMax: fallback?.criticalMax ?? null,
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

  const { ageRanges: allAgeRanges, test, criticalMin, criticalMax } =
    await loadLegacyBlob(testId);
  const ageRanges = allAgeRanges.filter((r) => matchesGender(r.gender, patientGender));

  for (const range of ageRanges) {
    const minOk = range.minAgeDays === null || patientAgeDays >= range.minAgeDays;
    const maxOk = range.maxAgeDays === null || patientAgeDays <= range.maxAgeDays;

    if (minOk && maxOk) {
      // If the matching range doesn't have a unit, fall back to LabTest default.
      // `||` not `??` — see resolveByTestDefinition above.
      const unit = range.referenceUnit || (test?.referenceUnit ?? null);

      return {
        referenceMin: range.referenceMin,
        referenceMax: range.referenceMax,
        referenceUnit: unit,
        referenceText: range.referenceText,
        criticalMin,
        criticalMax,
        source: 'age-range',
      };
    }
  }

  return {
    referenceMin: test?.referenceMin ?? null,
    referenceMax: test?.referenceMax ?? null,
    referenceUnit: test?.referenceUnit ?? null,
    referenceText: test?.referenceText ?? null,
    criticalMin,
    criticalMax,
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
