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

  // ── Counts and sums ───────────────────────────────────────────────────────
  // "Three or more visits", "spent over ₹25,000", "nothing in 180 days" are the same
  // question with different arguments. One predicate each rather than one per campaign.

  async visitCount(ctx, subject, args) {
    if (!subject.patientId) return null;
    return ctx.aggregate({
      patientId: subject.patientId,
      of: 'VISITS',
      domain: args.domain as 'CLINIC' | 'DIAGNOSTICS' | undefined,
      withinDays: args.withinDays ? Number(args.withinDays) : undefined,
    });
  },

  async spendInPaise(ctx, subject, args) {
    if (!subject.patientId) return null;
    return ctx.aggregate({
      patientId: subject.patientId,
      of: 'SPEND',
      domain: args.domain as 'CLINIC' | 'DIAGNOSTICS' | undefined,
      withinDays: args.withinDays ? Number(args.withinDays) : undefined,
    });
  },

  /** Distinguishes "never been" from "not been lately" — different campaigns entirely. */
  async hasEverDoneDiagnostics(ctx, subject) {
    if (!subject.patientId) return false;
    const n = await ctx.aggregate({ patientId: subject.patientId, of: 'VISITS', domain: 'DIAGNOSTICS' });
    return n > 0;
  },

  async daysSinceLastDiagnostics(ctx, subject) {
    if (!subject.patientId) return null;
    const all = await ctx.diagnosticsAfter(subject.patientId, new Date(0));
    if (all.length === 0) return null;
    const latest = all[all.length - 1];
    return Math.floor((ctx.now.getTime() - latest.createdAt.getTime()) / DAY_MS);
  },

  // ── Result history ────────────────────────────────────────────────────────

  /** The value before the current one, for "worse than last time" questions. */
  async previousResultValue(ctx, subject, args) {
    if (!subject.patientId) return null;
    const history = await ctx.resultHistory(subject.patientId, String(args.testCode ?? ''), 2);
    if (history.length < 2) return null;
    if (args.unit && history[1].referenceUnit !== args.unit) {
      throw new UnitMismatch(String(args.unit), history[1].referenceUnit);
    }
    return history[1].value;
  },

  /** Percent change against the previous result. Positive means it went up. */
  async resultChangePct(ctx, subject, args) {
    if (!subject.patientId) return null;
    const history = await ctx.resultHistory(subject.patientId, String(args.testCode ?? ''), 2);
    if (history.length < 2) return null;
    const [now_, before] = history;
    if (args.unit && (now_.referenceUnit !== args.unit || before.referenceUnit !== args.unit)) {
      throw new UnitMismatch(String(args.unit), now_.referenceUnit);
    }
    if (now_.value === null || before.value === null || before.value === 0) return null;
    return ((now_.value - before.value) / Math.abs(before.value)) * 100;
  },

  /** How many of the most recent results in a row were flagged abnormal. */
  async consecutiveAbnormal(ctx, subject, args) {
    if (!subject.patientId) return null;
    const history = await ctx.resultHistory(
      subject.patientId, String(args.testCode ?? ''), Number(args.limit ?? 5),
    );
    let run = 0;
    for (const r of history) {
      if (r.flag && r.flag !== 'NORMAL') run += 1;
      else break;
    }
    return run;
  },

  /**
   * A result with no reference range is one nobody can call abnormal. Used to refuse a
   * clinical decision rather than guess at one.
   */
  async resultHasReferenceRange(ctx, subject, args) {
    const r = await ctx.resultOf(String(args.testOrderId ?? subject.id), String(args.testCode ?? ''));
    return !!r && r.referenceUnit !== null;
  },

  /** "Done this test three times" and "never done it at all" are the same question. */
  async testCodeCount(ctx, subject, args) {
    if (!subject.patientId) return null;
    return ctx.testCodeCount(
      subject.patientId, String(args.testCode ?? ''),
      args.withinDays ? Number(args.withinDays) : undefined,
    );
  },

  /**
   * Diagnostics AT A PARTICULAR BRANCH after this visit.
   *
   * The default conversion question is patient-level and any-branch, by decision D3 —
   * revenue is revenue. This exists for the narrower question a branch manager asks,
   * and it is a separate predicate rather than an argument on the first so that nobody
   * silently changes what "converted" means for everyone.
   */
  async testDoneSinceThisVisitAtBranch(ctx, subject, args) {
    if (subject.type !== 'VISIT' || !subject.patientId) return false;
    const visit = await ctx.visit(subject.id);
    if (!visit) return false;
    const branchId = String(args.branchId ?? visit.branchId);
    const after = await ctx.diagnosticsAfter(subject.patientId, visit.createdAt);
    return after.some((v) => v.branchId === branchId);
  },

  // ── Offers ────────────────────────────────────────────────────────────────

  /** ISSUED | REDEEMED | EXPIRED | VOID | PENDING | null, for this run's own coupon. */
  async couponState(ctx, subject, args) {
    const runId = String(args.runId ?? subject.id);
    return ctx.couponState(runId);
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

/**
 * What the condition builder is allowed to offer, in the words an operator uses.
 *
 * Served to the UI rather than hardcoded there, so a predicate added here appears in
 * the builder without anyone remembering to edit a TypeScript array in the frontend —
 * and one that does NOT exist can never be offered.
 *
 * `scope` is the half that matters: "since this visit" and "ever" are different
 * business rules, and which one a condition means is the difference between chasing a
 * patient who never went and one who went last year.
 */
export interface PredicateMeta {
  fn: string;
  label: string;
  group: 'Diagnostics' | 'Visit' | 'Patient' | 'Money';
  /** BOOLEAN takes no operator; the others are compared. */
  returns: 'BOOLEAN' | 'NUMBER' | 'TEXT';
  scope?: string;
  unit?: 'RUPEES' | 'DAYS' | 'YEARS';
  help?: string;
}

export const PREDICATE_CATALOG: PredicateMeta[] = [
  { fn: 'visitCount', label: 'Number of visits', group: 'Visit', returns: 'NUMBER',
    scope: 'ever, or within a window',
    help: 'Add domain (CLINIC or DIAGNOSTICS) and withinDays to narrow it.' },
  { fn: 'spendInPaise', label: 'Amount spent', group: 'Money', returns: 'NUMBER', unit: 'RUPEES',
    scope: 'ever, or within a window' },
  { fn: 'hasEverDoneDiagnostics', label: 'Has ever done tests', group: 'Diagnostics', returns: 'BOOLEAN',
    help: 'Never been is a different campaign from not been lately.' },
  { fn: 'daysSinceLastDiagnostics', label: 'Days since their last test', group: 'Diagnostics', returns: 'NUMBER', unit: 'DAYS' },
  { fn: 'previousResultValue', label: 'Previous result value', group: 'Diagnostics', returns: 'NUMBER' },
  { fn: 'resultChangePct', label: 'Change since the previous result', group: 'Diagnostics', returns: 'NUMBER',
    help: 'Percent. Positive means it went up.' },
  { fn: 'consecutiveAbnormal', label: 'Abnormal results in a row', group: 'Diagnostics', returns: 'NUMBER' },
  { fn: 'resultHasReferenceRange', label: 'Result has a reference range', group: 'Diagnostics', returns: 'BOOLEAN',
    help: 'A result with no range is one nobody can call abnormal.' },
  { fn: 'testCodeCount', label: 'Times a particular test was done', group: 'Diagnostics', returns: 'NUMBER',
    help: 'Give it a testCode. Zero means never — a different campaign from "not lately".' },
  { fn: 'testDoneSinceThisVisitAtBranch', label: 'Tests done at this branch', group: 'Diagnostics',
    returns: 'BOOLEAN', scope: 'since this visit, same branch',
    help: 'The default conversion question counts any branch, because revenue is revenue. This is the narrower one.' },
  { fn: 'couponState', label: 'State of the offer this journey issued', group: 'Money', returns: 'TEXT',
    help: 'ISSUED, REDEEMED, EXPIRED or VOID.' },
  { fn: 'testDoneSinceThisVisit', label: 'Tests done', group: 'Diagnostics', returns: 'BOOLEAN',
    scope: 'since this visit',
    help: 'Any diagnostics after the triggering visit, including a walk-in we did not cause. Generous on purpose — being wrong here costs one unsent message.' },
  { fn: 'testAttributedToThisVisit', label: 'Tests done and linked to this visit', group: 'Diagnostics',
    returns: 'BOOLEAN', scope: 'linked at the front desk',
    help: 'Only diagnostics the front desk connected back to this consultation. Strict on purpose — used for counting what we caused.' },
  { fn: 'daysSinceLastTest', label: 'Days since their last test', group: 'Diagnostics', returns: 'NUMBER', unit: 'DAYS' },
  { fn: 'reportOpened', label: 'Report was opened', group: 'Diagnostics', returns: 'BOOLEAN', scope: 'this visit' },
  { fn: 'visitValueInPaise', label: 'Visit value', group: 'Visit', returns: 'NUMBER', unit: 'RUPEES', scope: 'this visit' },
  { fn: 'daysSinceLastVisit', label: 'Days since their last visit', group: 'Visit', returns: 'NUMBER', unit: 'DAYS' },
  { fn: 'patientAgeYears', label: 'Age', group: 'Patient', returns: 'NUMBER', unit: 'YEARS' },
  { fn: 'patientGender', label: 'Gender', group: 'Patient', returns: 'TEXT' },
  { fn: 'agreedToOffers', label: 'Agreed to offers', group: 'Patient', returns: 'BOOLEAN',
    help: 'Consent is also enforced at send time, so a journey cannot message someone who has not agreed even if this is left out.' },
  { fn: 'outstandingDueInPaise', label: 'Amount still due', group: 'Money', returns: 'NUMBER', unit: 'RUPEES', scope: 'this visit' },
];
