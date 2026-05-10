# File: src/services/referenceRangeService.ts

## Purpose
Resolve the correct reference range (and critical thresholds) for a test based on **patient age + gender**. Supports both the legacy schema (`LabTest` + `TestAgeRange`) and the new schema (`TestDefinition` + `TestDefinitionRange`). Falls back to default values when no age-specific range matches.

Per source comment:
> Supports BOTH architectures:
>   - Legacy: LabTest.id → TestAgeRange rows
>   - New:    TestDefinition.id → TestDefinitionRange rows
> Falls back to the default reference values if no age-specific range matches.

## Dependencies / Imports

```ts
import { Gender } from '@prisma/client';
import prisma from '../lib/prisma';
```

## Exported API

```ts
export interface ResolvedRange {
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  referenceText: string | null;
  criticalMin: number | null;
  criticalMax: number | null;
  source: 'age-range' | 'definition-range' | 'default';
}

export async function resolveByTestDefinition(testDefinitionId, yearOfBirth, patientGender, dateOfBirth?): Promise<ResolvedRange>
export async function resolveReferenceRange(testId, yearOfBirth, patientGender, dateOfBirth?): Promise<ResolvedRange>
export async function resolveReferenceRanges(testIds, yearOfBirth, patientGender, testDefinitionIds?, dateOfBirth?): Promise<Map<string, ResolvedRange>>
```

## HIGH/LOW/CRITICAL Logic

This service **does not classify a test result** as `HIGH/LOW/CRITICAL_HIGH/CRITICAL_LOW`. It only **resolves the thresholds** (`referenceMin`, `referenceMax`, `criticalMin`, `criticalMax`). The classification (`TestResultFlag` enum) is computed by the caller — see `determineResultFlag()` in `diagnosticVisits.ts`:

```ts
function determineResultFlag(numValue, range) {
  if (range.criticalMax !== null && numValue > range.criticalMax) return 'CRITICAL_HIGH';
  if (range.criticalMin !== null && numValue < range.criticalMin) return 'CRITICAL_LOW';
  if (range.referenceMax !== null && numValue > range.referenceMax) return 'HIGH';
  if (range.referenceMin !== null && numValue < range.referenceMin) return 'LOW';
  if (range.referenceMin !== null || range.referenceMax !== null) return 'NORMAL';
  return null;
}
```

### Critical thresholds availability
- `TestDefinitionRange` carries `criticalMin` / `criticalMax`. `TestDefinition` itself also carries `criticalMin` / `criticalMax` (used in fallback path).
- Legacy `TestAgeRange` and `LabTest` do **NOT** carry critical fields. The legacy branch (`resolveReferenceRange`) hardcodes `criticalMin: null, criticalMax: null` in both the matched-range path and the fallback path.

> Implication: critical-flag detection only works for tests resolved via the new `TestDefinition` architecture.

## Threshold Evaluation

`patientAgeDays = calculateAgeDays(yearOfBirth, dateOfBirth)`:
```ts
if (dateOfBirth) {
  return Math.floor((now - new Date(dateOfBirth)) / (1000 * 60 * 60 * 24));
}
return Math.floor((now - new Date(yearOfBirth, 0, 1)) / (1000 * 60 * 60 * 24));
```

When `dateOfBirth` is missing, age is computed from **January 1 of `yearOfBirth`** (per source comment: "Jan 1 approximation").

## Age / Sex Conditional Logic

### `resolveByTestDefinition` (new arch)
1. Query `prisma.testDefinitionRange` where `testDefinitionId = X` AND `(gender = patientGender OR gender = null)`.
2. Order rows: `gender DESC, minAgeDays DESC`. (Comment: "gender-specific first (desc puts 'M'/'F' before null), then narrowest age range first.")
3. Iterate; first row where `minAgeDays === null || patientAgeDays >= minAgeDays` AND `maxAgeDays === null || patientAgeDays <= maxAgeDays` wins.
4. If matched range has no `referenceUnit`, fallback to `TestDefinition.referenceUnit`.
5. Return `{ ..., source: 'definition-range' }`.
6. If no row matches → fall back to `TestDefinition` default fields (`source: 'default'`).

### `resolveReferenceRange` (legacy)
Same iteration logic against `prisma.testAgeRange`. Returns `source: 'age-range'` on match, `source: 'default'` on fallback.

### Bulk `resolveReferenceRanges`
- Accepts `testIds: string[]` and an optional `testDefinitionIds: Map<testId, testDefinitionId>`.
- Per `testId`: if `testDefinitionIds.get(testId)` is set, route to `resolveByTestDefinition`; else route to legacy `resolveReferenceRange`.
- All resolutions executed concurrently via `Promise.all`.
- Returns `Map<testId, ResolvedRange>` (keyed by `testId`, NOT by `testDefinitionId`).

## Formatting Logic

This service does **not** format ranges as strings. It returns raw numeric/text fields:

| Field | Type | Source |
| --- | --- | --- |
| `referenceMin` | `number \| null` | matching range row, fallback to def/test |
| `referenceMax` | `number \| null` | matching range row, fallback to def/test |
| `referenceUnit` | `string \| null` | matching range row's `referenceUnit`, fallback to definition's unit |
| `referenceText` | `string \| null` | matching range row's `referenceText` (used for non-numeric tests like "Negative") |
| `criticalMin` / `criticalMax` | `number \| null` | new arch only; legacy returns `null` |
| `source` | `'age-range' \| 'definition-range' \| 'default'` | which path produced the result |

UI rendering of the resolved range is the caller's responsibility (see `reportRendererService` and `diagnosticVisits.ts` `buildRange()` helper).

## Architectural Observations (factual)

- `gender DESC` ordering takes advantage of Postgres collation: `'M'` and `'F'` sort before `null` when descending. The intent is that gender-specific rows are tried before gender-neutral rows.
- The unit fallback is performed via a second DB call (`findUnique`) per test when the matched range has no unit — this means N+1 queries are possible for large bulk resolutions where many ranges lack a unit.
- The bulk resolver does not de-duplicate across tests — if the same `testDefinitionId` appears for multiple `testId`s, it is queried multiple times.
- No caching layer (Redis or in-memory). Each resolution hits the DB.
- `dateOfBirth` precision: when present, ages account for full days; when absent, all patients with the same `yearOfBirth` share the same `patientAgeDays` (Jan 1 baseline).
- The service does not check whether the resolved range row is "active." There is no `isActive` column on `TestDefinitionRange` or `TestAgeRange` in the schema.

## Raw Source

```ts
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
```

## Notes

- Critical thresholds are exclusively a new-arch concept. Legacy paths cannot raise `CRITICAL_HIGH` / `CRITICAL_LOW` flags.
- The classification of a result into `TestResultFlag` happens at the caller (`determineResultFlag` in `diagnosticVisits.ts`).
- The Jan-1 approximation for missing `dateOfBirth` may misclassify pediatric reference ranges by up to ~12 months.
