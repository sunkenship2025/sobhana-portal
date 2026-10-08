/**
 * Formula evaluation utilities for derived test values.
 * Mirrors backend logic from derivedParameterService.ts
 */

/**
 * Interface for a derived test with its formula info
 */
export interface DerivedTestInfo {
  testId: string;
  code: string;
  formulaExpression: string;
  dependsOnCodes: string[];
}

/**
 * Safely evaluate a formula by replacing test codes with values.
 * Returns null on error, division by zero, or missing values.
 *
 * @param formula - Formula expression like "ALB / GLOB" or "TBIL - DBIL"
 * @param valuesByCode - Map of test code to numeric value
 * @returns Calculated value rounded to 2 decimals, or null
 */
export function safeEvaluateFormula(
  formula: string,
  valuesByCode: Map<string, number>
): number | null {
  try {
    let expression = formula;

    // Sort codes by length descending to avoid partial replacements
    // e.g., "TBIL" should be replaced before "BIL"
    const codes = Array.from(valuesByCode.keys()).sort(
      (a, b) => b.length - a.length
    );

    for (const code of codes) {
      const val = valuesByCode.get(code);
      if (val === undefined) continue;
      // Replace all occurrences of the code with its numeric value
      expression = expression.split(code).join(String(val));
    }

    // Validate: only allow digits, decimal points, operators, parens, spaces
    if (!/^[\d\s.+\-*/()]+$/.test(expression)) {
      return null;
    }

    // Use Function constructor for safe math evaluation
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${expression})`)();

    // Check for valid finite number
    if (typeof result !== 'number' || !isFinite(result)) {
      return null; // Handles division by zero (Infinity) and NaN
    }

    // Every derived quantity (differential remainder, globulin, indirect bilirubin, LDL,
    // UIBC, ratios) is non-negative: below 0 means the inputs disagree (a differential
    // adding up to 101, DBIL above TBIL), so leave it blank, never print a negative.
    if (result < 0) return null;

    // Round to 2 decimal places
    return Math.round(result * 100) / 100;
  } catch {
    return null;
  }
}

/**
 * Topologically sort derived tests to ensure dependencies are calculated first.
 * Handles cascading dependencies like: TP/ALB -> GLOB -> AGR
 *
 * @param derivedTests - Array of derived test info
 * @returns Sorted array where dependencies come before dependents
 */
export function topologicalSortDerivedTests(
  derivedTests: DerivedTestInfo[]
): DerivedTestInfo[] {
  const result: DerivedTestInfo[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>(); // For cycle detection

  // Keyed by testId (the per-order result key), not the code: a derived test billed twice
  // (a package's CBC plus an extra CBC) has two rows with one code, and both need a value.
  const codeToTests = new Map<string, DerivedTestInfo[]>();
  for (const test of derivedTests) {
    codeToTests.set(test.code, [...(codeToTests.get(test.code) ?? []), test]);
  }

  function visit(test: DerivedTestInfo): void {
    if (visited.has(test.testId)) return;
    if (visiting.has(test.testId)) {
      // Circular dependency detected - break cycle
      return;
    }

    visiting.add(test.testId);

    // Visit dependencies first (if they are also derived tests)
    for (const depCode of test.dependsOnCodes) {
      for (const depTest of codeToTests.get(depCode) ?? []) {
        visit(depTest);
      }
    }

    visiting.delete(test.testId);
    visited.add(test.testId);
    result.push(test);
  }

  for (const test of derivedTests) {
    visit(test);
  }

  return result;
}

/**
 * Build a reverse dependency map: code -> tests that depend on it
 */
export function buildReverseDependencyMap(
  derivedTests: DerivedTestInfo[]
): Map<string, DerivedTestInfo[]> {
  const reverseMap = new Map<string, DerivedTestInfo[]>();

  for (const test of derivedTests) {
    for (const depCode of test.dependsOnCodes) {
      const existing = reverseMap.get(depCode) || [];
      existing.push(test);
      reverseMap.set(depCode, existing);
    }
  }

  return reverseMap;
}
