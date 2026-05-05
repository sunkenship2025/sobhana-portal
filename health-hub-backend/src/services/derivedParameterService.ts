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

import prisma from '../lib/prisma';

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

export interface DerivedFormulaTarget {
  testId: string;
  code: string;
  parameterName: string;
  formula: string;
  dependsOnCodes: string[];
  displayOrder: number;
  testDefinitionId?: string | null;
}

export interface EvaluatedDerivedFormula extends DerivedFormulaTarget {
  value: number | null;
}

export function normalizeDependencyCodes(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((value) => String(value).trim())
      .filter(Boolean);
  }

  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return [];
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
  const targets = allDerived
    .map((dp) => ({
      testId: dp.testDefinitionCode,
      code: dp.testDefinitionCode,
      parameterName: dp.parameterName,
      formula: dp.formula,
      dependsOnCodes: normalizeDependencyCodes(dp.dependsOnTestCodes),
      displayOrder: dp.displayOrder,
      testDefinitionId: null,
    }))
    .filter((target) =>
      target.dependsOnCodes.some((code) => codeSet.has(code))
    );

  return evaluateDerivedTargets(targets, resultsByTestCode).map((result) => ({
    testDefinitionCode: result.code,
    parameterName: result.parameterName,
    formula: result.formula,
    value: result.value,
    displayOrder: result.displayOrder,
  }));
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
    include: {
      test: {
        select: {
          code: true,
        },
      },
    },
  });

  if (derivedParams.length === 0) return [];

  return evaluateDerivedTargets(
    derivedParams.map((dp) => ({
      testId: dp.testId,
      code: dp.test.code,
      parameterName: dp.parameterName,
      formula: dp.formula,
      dependsOnCodes: normalizeDependencyCodes(dp.dependsOnTestCodes),
      displayOrder: dp.displayOrder,
      testDefinitionId: null,
    })),
    resultsByTestCode
  ).map((result) => ({
    testId: result.testId,
    parameterName: result.parameterName,
    formula: result.formula,
    value: result.value,
    displayOrder: result.displayOrder,
  }));
}

export function evaluateDerivedTargets(
  targets: DerivedFormulaTarget[],
  resultsByTestCode: Map<string, number>
): EvaluatedDerivedFormula[] {
  if (targets.length === 0) return [];

  const orderedTargets = topologicalSortDerivedTargets(targets);
  const workingValues = new Map(resultsByTestCode);
  const results: EvaluatedDerivedFormula[] = [];

  for (const target of orderedTargets) {
    const value = safeEvaluateFormula(target.formula, workingValues);

    if (value !== null) {
      workingValues.set(target.code, value);
    } else {
      workingValues.delete(target.code);
    }

    results.push({
      ...target,
      value,
    });
  }

  return results;
}

function topologicalSortDerivedTargets(
  targets: DerivedFormulaTarget[]
): DerivedFormulaTarget[] {
  const result: DerivedFormulaTarget[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const codeToTarget = new Map<string, DerivedFormulaTarget>();

  for (const target of targets) {
    codeToTarget.set(target.code, target);
  }

  function visit(target: DerivedFormulaTarget): void {
    if (visited.has(target.code)) return;
    if (visiting.has(target.code)) return;

    visiting.add(target.code);

    for (const depCode of target.dependsOnCodes) {
      const dependency = codeToTarget.get(depCode);
      if (dependency) {
        visit(dependency);
      }
    }

    visiting.delete(target.code);
    visited.add(target.code);
    result.push(target);
  }

  for (const target of targets) {
    visit(target);
  }

  return result;
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
