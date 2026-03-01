/**
 * Derived Parameter Service
 *
 * Safely evaluates derived parameters (e.g. A/G ratio)
 * from a map of test results, using the stored formula.
 *
 * Supports BOTH architectures:
 *   - Legacy: DerivedParameter (linked to LabTest via testId)
 *   - New:    DerivedParameterDef (linked by testDefinitionCode)
 *
 * Formula format:  "ALB / GLOB"  (test codes as operands)
 * dependsOnTestCodes: ["ALB", "GLOB"]
 */

import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

/**
 * A single derived-parameter evaluation result
 */
export interface DerivedResult {
  testId?: string;
  testDefinitionCode?: string;
  parameterName: string;
  formula: string;
  value: number | null; // null if evaluation failed (missing inputs)
  displayOrder: number;
}

/**
 * Evaluate derived parameters using DerivedParameterDef (new architecture).
 * Looks up DerivedParameterDef by testDefinitionCodes found in the results.
 *
 * @param testCodes - The test codes that have results
 * @param resultsByTestCode - Map of testCode → numeric value
 * @returns Array of DerivedResult
 */
export async function evaluateDerivedParameterDefs(
  testCodes: string[],
  resultsByTestCode: Map<string, number>
): Promise<DerivedResult[]> {
  if (testCodes.length === 0) return [];

  // Fetch all DerivedParameterDef whose dependsOnTestCodes overlap with available codes
  const allDerived = await prisma.derivedParameterDef.findMany({
    orderBy: { displayOrder: 'asc' },
  });

  if (allDerived.length === 0) return [];

  const codeSet = new Set(testCodes);
  const results: DerivedResult[] = [];

  for (const dp of allDerived) {
    const depCodes = dp.dependsOnTestCodes as string[];

    // Check if ALL dependencies are available in the result set
    const allPresent = depCodes.every((code) => resultsByTestCode.has(code));
    if (!allPresent) continue;

    // At least one dependency must be in our ordered test codes
    if (!depCodes.some((code) => codeSet.has(code))) continue;

    const value = safeEvaluateFormula(dp.formula, resultsByTestCode);

    results.push({
      testDefinitionCode: dp.testDefinitionCode,
      parameterName: dp.parameterName,
      formula: dp.formula,
      value,
      displayOrder: dp.displayOrder,
    });
  }

  return results;
}

/**
 * Legacy: Evaluate all derived parameters for a given list of test IDs.
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
