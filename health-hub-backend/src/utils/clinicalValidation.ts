/**
 * Clinical Definitions / Panel / Product Validation Utilities
 * 
 * Covers:
 * - Interpretation rule overlap detection
 * - Circular dependency detection for derived parameters
 * - Deprecation state machine transitions
 * - Float precision handling
 * - Concurrency conflict detection
 */

import { ComparisonOperator, InterpretationRuleType, TestDefinitionStatus } from '@prisma/client';

// ============================================================================
// TYPES
// ============================================================================

export interface InterpretationRuleInput {
  ruleType: InterpretationRuleType;
  operator: ComparisonOperator;
  value1?: number | null;
  value2?: number | null;
  textMatch?: string | null;
  interpretationText: string;
  severity?: string | null;
  displayOrder?: number;
}

export interface RangeInterval {
  lower: number;      // -Infinity for unbounded
  upper: number;      // +Infinity for unbounded
  inclusive: boolean;  // Whether bounds are inclusive (for LTE/GTE/BETWEEN/EQ)
}

// ============================================================================
// FLOAT PRECISION
// ============================================================================

const EPSILON = 1e-9;

/** Compare two floats with epsilon tolerance */
export function floatEquals(a: number, b: number): boolean {
  return Math.abs(a - b) < EPSILON;
}

/** Safe float comparison: a < b */
export function floatLT(a: number, b: number): boolean {
  return a < b - EPSILON;
}

/** Safe float comparison: a <= b */
export function floatLTE(a: number, b: number): boolean {
  return a < b + EPSILON;
}

/** Safe float comparison: a > b */
export function floatGT(a: number, b: number): boolean {
  return a > b + EPSILON;
}

/** Safe float comparison: a >= b */
export function floatGTE(a: number, b: number): boolean {
  return a > b - EPSILON;
}

// ============================================================================
// INTERPRETATION RULE OVERLAP DETECTION
// ============================================================================

/**
 * Extract the numeric interval covered by a rule.
 * Returns null if the rule is not numeric (text/category match).
 */
function ruleToInterval(rule: InterpretationRuleInput): RangeInterval | null {
  if (rule.ruleType === 'TEXT_MATCH' || rule.ruleType === 'CATEGORY_MATCH') {
    return null; // Text-based rules don't have numeric ranges
  }

  switch (rule.operator) {
    case 'LT':
      return { lower: -Infinity, upper: rule.value1 ?? 0, inclusive: false };
    case 'LTE':
      return { lower: -Infinity, upper: rule.value1 ?? 0, inclusive: true };
    case 'GT':
      return { lower: rule.value1 ?? 0, upper: Infinity, inclusive: false };
    case 'GTE':
      return { lower: rule.value1 ?? 0, upper: Infinity, inclusive: true };
    case 'EQ':
      return { lower: rule.value1 ?? 0, upper: rule.value1 ?? 0, inclusive: true };
    case 'BETWEEN':
      return { lower: rule.value1 ?? 0, upper: rule.value2 ?? 0, inclusive: true };
    case 'MATCH':
      return null;
    default:
      return null;
  }
}

/**
 * Check if two numeric intervals overlap.
 */
function intervalsOverlap(a: RangeInterval, b: RangeInterval): boolean {
  // Two intervals [a.lower, a.upper] and [b.lower, b.upper] overlap if:
  // a.lower < b.upper AND b.lower < a.upper (with inclusive adjustments)
  
  const aLowerLessThanBUpper = a.inclusive && b.inclusive
    ? floatLTE(a.lower, b.upper)
    : floatLT(a.lower, b.upper);
  
  const bLowerLessThanAUpper = a.inclusive && b.inclusive
    ? floatLTE(b.lower, a.upper)
    : floatLT(b.lower, a.upper);

  return aLowerLessThanBUpper && bLowerLessThanAUpper;
}

/**
 * Check if two text-based rules overlap (same text match).
 */
function textRulesOverlap(a: InterpretationRuleInput, b: InterpretationRuleInput): boolean {
  if (a.ruleType !== b.ruleType) return false;
  if (a.ruleType === 'NUMERIC_RANGE') return false;
  
  // For text/category rules, overlap if they match the same text
  const aText = (a.textMatch ?? '').trim().toLowerCase();
  const bText = (b.textMatch ?? '').trim().toLowerCase();
  return aText === bText;
}

/**
 * Validate a set of interpretation rules for overlaps.
 * Returns an array of overlap error messages (empty = no overlaps).
 */
export function detectInterpretationOverlaps(rules: InterpretationRuleInput[]): string[] {
  const errors: string[] = [];

  for (let i = 0; i < rules.length; i++) {
    for (let j = i + 1; j < rules.length; j++) {
      const a = rules[i];
      const b = rules[j];

      // Check numeric overlap
      const intervalA = ruleToInterval(a);
      const intervalB = ruleToInterval(b);
      
      if (intervalA && intervalB && intervalsOverlap(intervalA, intervalB)) {
        errors.push(
          `Rule ${i + 1} (${a.operator} ${a.value1 ?? ''}${a.value2 ? `-${a.value2}` : ''}) ` +
          `overlaps with Rule ${j + 1} (${b.operator} ${b.value1 ?? ''}${b.value2 ? `-${b.value2}` : ''})`
        );
      }

      // Check text overlap
      if (textRulesOverlap(a, b)) {
        errors.push(
          `Rule ${i + 1} (${a.ruleType}: "${a.textMatch}") ` +
          `overlaps with Rule ${j + 1} (${b.ruleType}: "${b.textMatch}")`
        );
      }
    }
  }

  return errors;
}

// ============================================================================
// DEPRECATION STATE MACHINE
// ============================================================================

/**
 * Valid state transitions for TestDefinitionStatus:
 *   ACTIVE -> LOCKED (being edited, new version in progress)
 *   ACTIVE -> DEPRECATED (no longer recommended)
 *   LOCKED -> ACTIVE (edit cancelled, unlocked)
 *   DEPRECATED -> ARCHIVED (fully retired)
 *   DEPRECATED -> ACTIVE (re-activated)
 */
const VALID_TRANSITIONS: Record<TestDefinitionStatus, TestDefinitionStatus[]> = {
  ACTIVE: ['LOCKED', 'DEPRECATED'],
  LOCKED: ['ACTIVE'],
  DEPRECATED: ['ARCHIVED', 'ACTIVE'],
  ARCHIVED: [],  // Terminal state — no transitions out
};

/**
 * Check if a status transition is valid.
 */
export function isValidStatusTransition(
  from: TestDefinitionStatus,
  to: TestDefinitionStatus
): boolean {
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Get allowed transitions from a given status.
 */
export function getAllowedTransitions(status: TestDefinitionStatus): TestDefinitionStatus[] {
  return VALID_TRANSITIONS[status] ?? [];
}

// ============================================================================
// CIRCULAR DEPENDENCY DETECTION (for derived parameters)
// ============================================================================

/**
 * Detect circular dependencies in derived parameter formulas.
 * 
 * @param testCode - The code of the test being checked
 * @param dependsOnCodes - The codes this test depends on
 * @param allDependencies - Map of testCode -> dependsOnCodes for all definitions
 * @returns Array of error messages (empty = no cycles)
 */
export function detectCircularDependencies(
  testCode: string,
  dependsOnCodes: string[],
  allDependencies: Map<string, string[]>
): string[] {
  const errors: string[] = [];
  const visited = new Set<string>();
  const path: string[] = [];

  function dfs(code: string): boolean {
    if (code === testCode && path.length > 0) {
      errors.push(`Circular dependency detected: ${[...path, code].join(' -> ')}`);
      return true;
    }
    
    if (visited.has(code)) return false;
    visited.add(code);
    path.push(code);

    const deps = code === testCode ? dependsOnCodes : (allDependencies.get(code) ?? []);
    for (const dep of deps) {
      if (dfs(dep)) return true;
    }

    path.pop();
    return false;
  }

  // Start from each dependency and check if we can reach back to testCode
  for (const dep of dependsOnCodes) {
    visited.clear();
    path.length = 0;
    path.push(testCode);
    dfs(dep);
  }

  return errors;
}

// ============================================================================
// CONCURRENCY CONTROL
// ============================================================================

/**
 * Check if the provided ETag (updatedAt timestamp) matches the current entity.
 * Used with If-Match header for optimistic concurrency.
 * 
 * @param ifMatchHeader - The If-Match header value (ISO timestamp string)
 * @param entityUpdatedAt - The entity's current updatedAt value
 * @returns true if they match (safe to proceed), false if stale
 */
export function checkConcurrency(
  ifMatchHeader: string | undefined,
  entityUpdatedAt: Date
): boolean {
  if (!ifMatchHeader) return true; // No header = skip check (backwards compat)
  
  const headerDate = new Date(ifMatchHeader);
  if (isNaN(headerDate.getTime())) return true; // Invalid date = skip
  
  return headerDate.getTime() === entityUpdatedAt.getTime();
}

// ============================================================================
// BUNDLE VALIDATION (no recursive bundles)
// ============================================================================

/**
 * Validate that a bundle product doesn't contain other bundles.
 * A bundle can only contain single-test products or panels, not other bundles.
 */
export function validateNoBundleNesting(
  componentProductIsBundle: boolean[]
): string[] {
  const errors: string[] = [];
  componentProductIsBundle.forEach((isBundle, i) => {
    if (isBundle) {
      errors.push(`Component ${i + 1} is a bundle. Bundles cannot contain other bundles.`);
    }
  });
  return errors;
}

// ============================================================================
// INTERPRETATION EVALUATION
// ============================================================================

/**
 * Evaluate a test value against a set of interpretation rules.
 * Returns the matching interpretation text (first match by displayOrder).
 * 
 * Handles:
 * - Null values (returns null — no interpretation for missing data)
 * - Float precision via epsilon comparison
 * - Text/category matching (case-insensitive)
 */
export function evaluateInterpretation(
  value: number | string | null | undefined,
  rules: InterpretationRuleInput[]
): { text: string; severity: string | null } | null {
  if (value === null || value === undefined) return null;

  // Sort by displayOrder
  const sorted = [...rules]
    .filter(r => r.displayOrder !== undefined)
    .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0));

  for (const rule of sorted) {
    if (!rule.interpretationText) continue;

    // Numeric evaluation
    if (rule.ruleType === 'NUMERIC_RANGE' && typeof value === 'number') {
      const matches = evaluateNumericRule(value, rule.operator, rule.value1, rule.value2);
      if (matches) {
        return { text: rule.interpretationText, severity: rule.severity ?? null };
      }
    }

    // Text/Category evaluation
    if ((rule.ruleType === 'TEXT_MATCH' || rule.ruleType === 'CATEGORY_MATCH') && typeof value === 'string') {
      const textVal = value.trim().toLowerCase();
      const matchVal = (rule.textMatch ?? '').trim().toLowerCase();
      if (textVal === matchVal) {
        return { text: rule.interpretationText, severity: rule.severity ?? null };
      }
    }
  }

  return null;
}

/**
 * Evaluate a numeric value against a rule operator and bounds.
 */
function evaluateNumericRule(
  value: number,
  operator: ComparisonOperator,
  value1: number | null | undefined,
  value2: number | null | undefined
): boolean {
  const v1 = value1 ?? 0;
  const v2 = value2 ?? 0;

  switch (operator) {
    case 'LT':
      return floatLT(value, v1);
    case 'LTE':
      return floatLTE(value, v1);
    case 'GT':
      return floatGT(value, v1);
    case 'GTE':
      return floatGTE(value, v1);
    case 'EQ':
      return floatEquals(value, v1);
    case 'BETWEEN':
      return floatGTE(value, v1) && floatLTE(value, v2);
    case 'MATCH':
      return false; // MATCH is for text, not numeric
    default:
      return false;
  }
}
