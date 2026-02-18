/**
 * Derived Parameter Service (Step 28)
 *
 * Safely evaluates derived parameters (e.g. A/G ratio)
 * from a map of test results, using the stored formula.
 *
 * Formula format:  "T001 / T002"  (test codes as operands)
 * dependsOnTestCodes: ["T001", "T002"]
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

/**
 * A single derived-parameter evaluation result
 */
export interface DerivedResult {
  testId: string;
  parameterName: string;
  formula: string;
  value: number | null; // null if evaluation failed (missing inputs)
  displayOrder: number;
}

/**
 * Evaluate all derived parameters for a given list of test IDs.
 *
 * @param testIds - The lab-test IDs that were ordered (to look up DerivedParameter)
 * @param resultsByTestCode - Map of testCode → numeric value (from entered results)
 * @returns Array of DerivedResult
 */
export async function evaluateDerivedParameters(
  testIds: string[],
  resultsByTestCode: Map<string, number>
): Promise<DerivedResult[]> {
  if (testIds.length === 0) return [];

  // Fetch all DerivedParameter rows whose testId is in the ordered set
  const derivedParams = await prisma.derivedParameter.findMany({
    where: { testId: { in: testIds } },
    orderBy: { displayOrder: 'asc' },
  });

  if (derivedParams.length === 0) return [];

  const results: DerivedResult[] = [];

  for (const dp of derivedParams) {
    const depCodes = dp.dependsOnTestCodes as string[];

    // Check all dependency values are available
    const allPresent = depCodes.every((code) => resultsByTestCode.has(code));

    let value: number | null = null;
    if (allPresent) {
      value = safeEvaluateFormula(dp.formula, resultsByTestCode);
    }

    results.push({
      testId: dp.testId,
      parameterName: dp.parameterName,
      formula: dp.formula,
      value,
      displayOrder: dp.displayOrder,
    });
  }

  return results;
}

/**
 * Safe formula evaluator.
 * Only allows: test-code tokens, numbers, +, -, *, /, (, ), spaces.
 * Replaces test codes with their numeric values, then evaluates.
 *
 * Returns null on any error (division by zero, parse failure, etc.)
 */
function safeEvaluateFormula(
  formula: string,
  values: Map<string, number>
): number | null {
  try {
    let expression = formula;

    // Sort codes by length descending so longer codes get replaced first
    const codes = Array.from(values.keys()).sort((a, b) => b.length - a.length);
    for (const code of codes) {
      // Replace all occurrences of the code with its numeric value
      const val = values.get(code)!;
      expression = expression.split(code).join(String(val));
    }

    // Validate: only allow digits, decimal points, operators, parens, spaces
    if (!/^[\d\s.+\-*/()]+$/.test(expression)) {
      console.warn('[DerivedParam] Invalid characters in formula:', expression);
      return null;
    }

    // Use Function constructor for safe math evaluation (no access to global scope)
    // eslint-disable-next-line no-new-func
    const result = new Function(`"use strict"; return (${expression})`)();

    if (typeof result !== 'number' || !isFinite(result)) {
      return null;
    }

    // Round to 2 decimal places
    return Math.round(result * 100) / 100;
  } catch (err) {
    console.error('[DerivedParam] Formula evaluation error:', err);
    return null;
  }
}
