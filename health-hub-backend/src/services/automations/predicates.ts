/**
 * The predicate library, and the condition evaluator over it.
 *
 * Every predicate is a NAMED, individually testable function of
 * (context, subject, args) — never an ad-hoc query inside a JSON blob. Without this
 * the same question gets three implementations and the code that decides whether to
 * message two thousand people has no test.
 *
 * SCOPE IS EXPLICIT, ALWAYS. `testDoneSinceThisVisit` and `daysSinceLastTest` are
 * different questions and the difference is the whole product: one chases a patient
 * who never went, the other chases one who went last year.
 */
import type { AutomationContext } from './context';
import type { Condition, Fact, Op } from './types';
import { Outcome } from './types';

export interface Subject {
  type: string;
  id: string;
  patientId: string | null;
  branchId: string | null;
  /** The instant the trigger fired. Windows and anchors measure from here. */
  triggeredAt: Date;
}

export type Predicate = (
  ctx: AutomationContext,
  subject: Subject,
  args: Record<string, any>,
) => Promise<Fact>;

/** Thrown when a numeric clinical fact comes back in a unit the author never saw. */
export class UnitMismatch extends Error {
  constructor(readonly expected: string, readonly actual: string | null) {
    super(`unit mismatch: condition written for "${expected}", result is "${actual ?? 'none'}"`);
  }
}

const DAY_MS = 24 * 60 * 60 * 1000;

export const predicates: Record<string, Predicate> = {
  /**
   * SUPPRESSION question — generous on purpose. Any diagnostics visit for this patient
   * after the triggering visit counts, including a walk-in we did not cause. Being wrong
   * here costs one unsent message; being wrong the other way chases someone who came.
   */
  async testDoneSinceThisVisit(ctx, subject) {
    if (subject.type !== 'VISIT' || !subject.patientId) return false;
    const visit = await ctx.visit(subject.id);
    if (!visit) return false;
    const after = await ctx.diagnosticsAfter(subject.patientId, visit.createdAt);
    return after.length > 0;
  },

  /**
   * ATTRIBUTION question — strict on purpose. Only diagnostics the front desk linked
   * back to this consultation count. Used for the goal and for conversion, never for
   * suppression: one condition cannot serve two precisions that want opposite answers.
   */
  async testAttributedToThisVisit(ctx, subject) {
    if (subject.type !== 'VISIT') return false;
    const linked = await ctx.diagnosticsAttributedTo(subject.id);
    return linked.length > 0;
  },

  async daysSinceLastTest(ctx, subject) {
    if (!subject.patientId) return null;
    const all = await ctx.diagnosticsAfter(subject.patientId, new Date(0));
    if (all.length === 0) return null;
    const latest = all[all.length - 1];
    return Math.floor((ctx.now.getTime() - latest.createdAt.getTime()) / DAY_MS);
  },

  async daysSinceLastVisit(ctx, subject) {
    if (!subject.patientId) return null;
    return ctx.daysSinceLastVisit(subject.patientId);
  },

  async visitValueInPaise(ctx, subject) {
    if (subject.type !== 'VISIT') return null;
    const v = await ctx.visit(subject.id);
    return v?.totalAmountInPaise ?? null;
  },

  async outstandingDueInPaise(ctx, subject) {
    if (subject.type !== 'VISIT') return 0;
    return ctx.outstandingDueInPaise(subject.id);
  },

  async reportOpened(ctx, subject) {
    if (subject.type !== 'VISIT') return false;
    return ctx.reportOpened(subject.id);
  },

  async patientAgeYears(ctx, subject) {
    if (!subject.patientId) return null;
    const p = await ctx.patient(subject.patientId);
    if (!p) return null;
    return ctx.now.getUTCFullYear() - p.yearOfBirth;
  },

  async patientGender(ctx, subject) {
    if (!subject.patientId) return null;
    const p = await ctx.patient(subject.patientId);
    return p?.gender ?? null;
  },

  async agreedToOffers(ctx, subject) {
    if (!subject.patientId) return false;
    const p = await ctx.patient(subject.patientId);
    return !!p?.marketingOptIn;
  },

  /**
   * The one clinical thing the engine does: compare a number to a number. What
   * "abnormal" means stays in Clinical Definitions, where the clinicians set it.
   * Throws rather than compares when the unit has moved under the condition.
   */
  async resultValue(ctx, subject, args) {
    const testOrderId = String(args.testOrderId ?? subject.id);
    const testCode = String(args.testCode ?? '');
    const r = await ctx.resultOf(testOrderId, testCode);
    if (!r) return null;
    if (args.unit && r.referenceUnit !== args.unit) {
      throw new UnitMismatch(String(args.unit), r.referenceUnit);
    }
    return r.value;
  },

  async resultFlag(ctx, subject, args) {
    const testOrderId = String(args.testOrderId ?? subject.id);
    const testCode = String(args.testCode ?? '');
    const r = await ctx.resultOf(testOrderId, testCode);
    return r?.flag ?? null;
  },

  /** Always false is not an option: an unknown flag must never read as "safe". */
  async resultIsCritical(ctx, subject, args) {
    const flag = await predicates.resultFlag(ctx, subject, args);
    return flag === 'CRITICAL_HIGH' || flag === 'CRITICAL_LOW';
  },

  async always() {
    return true;
  },
};

// ────────────────────────────────────────────────────────────────────────────

function compare(fact: Fact, op: Op, value: Fact | Fact[]): boolean {
  if (op === 'in') return Array.isArray(value) && value.some((v) => v === fact);
  if (fact === null) return false; // unknown never satisfies a comparison
  const a = fact as number | string;
  const b = value as number | string;
  switch (op) {
    case 'eq': return a === b;
    case 'ne': return a !== b;
    case 'gt': return a > b;
    case 'gte': return a >= b;
    case 'lt': return a < b;
    case 'lte': return a <= b;
    default: return false;
  }
}

export interface EvalTrace {
  fn: string;
  fact: Fact;
  op?: Op;
  value?: Fact | Fact[];
  passed: boolean;
}

/**
 * Evaluate a condition. `trace` collects every leaf that was read, with the value it
 * had at the moment it was read — that is what "why she entered" prints, and why the
 * answer survives the data changing later.
 */
export async function evaluate(
  condition: Condition,
  ctx: AutomationContext,
  subject: Subject,
  trace: EvalTrace[] = [],
): Promise<boolean> {
  if ('all' in condition) {
    let ok = true;
    for (const c of condition.all) {
      // Every branch is evaluated even once the answer is known, because the trace is
      // the product: a half-filled explanation is the one staff do not trust.
      const r = await evaluate(c, ctx, subject, trace);
      ok = ok && r;
    }
    return ok;
  }
  if ('any' in condition) {
    let ok = false;
    for (const c of condition.any) {
      const r = await evaluate(c, ctx, subject, trace);
      ok = ok || r;
    }
    return ok;
  }
  if ('not' in condition) {
    return !(await evaluate(condition.not, ctx, subject, trace));
  }

  const fn = predicates[condition.fn];
  if (!fn) throw new Error(`unknown predicate "${condition.fn}"`);

  const args = { ...(condition.args ?? {}) };
  if (condition.unit) args.unit = condition.unit;

  const fact = await fn(ctx, subject, args);
  const passed =
    condition.op === undefined ? fact === true : compare(fact, condition.op, condition.value ?? null);

  trace.push({ fn: condition.fn, fact, op: condition.op, value: condition.value, passed });
  return passed;
}

/** Names used by a definition that do not exist. Checked when an automation is saved. */
export function unknownPredicates(condition: Condition, found: string[] = []): string[] {
  if ('all' in condition) condition.all.forEach((c) => unknownPredicates(c, found));
  else if ('any' in condition) condition.any.forEach((c) => unknownPredicates(c, found));
  else if ('not' in condition) unknownPredicates(condition.not, found);
  else if (!predicates[condition.fn]) found.push(condition.fn);
  return found;
}

export const UNIT_MISMATCH_OUTCOME = Outcome.UNIT_MISMATCH;
