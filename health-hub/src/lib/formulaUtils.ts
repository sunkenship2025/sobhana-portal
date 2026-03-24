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

  // Build a map of code -> derived test for quick lookup
  const codeToTest = new Map<string, DerivedTestInfo>();
  for (const test of derivedTests) {
    codeToTest.set(test.code, test);
  }

  function visit(test: DerivedTestInfo): void {
    if (visited.has(test.code)) return;
    if (visiting.has(test.code)) {
      // Circular dependency detected - break cycle
      return;
    }

    visiting.add(test.code);

    // Visit dependencies first (if they are also derived tests)
    for (const depCode of test.dependsOnCodes) {
      const depTest = codeToTest.get(depCode);
      if (depTest) {
        visit(depTest);
      }
    }

    visiting.delete(test.code);
    visited.add(test.code);
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
