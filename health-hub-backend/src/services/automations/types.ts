/**
 * The shape of an automation definition.
 *
 * WHY JSON AND NOT TABLES: a definition is edited as a whole, read as a whole and
 * frozen onto the run as a whole. Splitting it into Step / Condition / Goal tables
 * buys joins and a lifecycle, and costs the one property that matters — that a run
 * carries its own copy and can never be silently moved onto new rules.
 *
 * Steps are an ARRAY with stepIndex on the run. No DAG, no branch nodes: a branch is
 * a second automation with an inverted condition until there are three of them.
 */

export type SubjectType = 'PATIENT' | 'VISIT' | 'TEST_ORDER' | 'REPORT_VERSION' | 'COUPON';

/** What a predicate hands back. Comparison happens in the condition, never inside it. */
export type Fact = boolean | number | string | null;

export type Op = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in';

export type Condition =
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }
  | {
      /** Name in the predicate registry. Unknown names fail loudly at validate time. */
      fn: string;
      args?: Record<string, unknown>;
      /** Omitted = the fact is used as a boolean. */
      op?: Op;
      value?: Fact | Fact[];
      /**
       * The unit this condition was AUTHORED against, for numeric clinical facts.
       * A resolved unit that differs stops the run instead of comparing the wrong
       * number: 7 is diabetic in % and meaningless in mmol/mol, and nothing in the
       * number says which.
       */
      unit?: string;
    };

export type Trigger =
  | { kind: 'VISIT_COMPLETED'; domain: 'CLINIC' | 'DIAGNOSTICS' }
  | { kind: 'REPORT_FINALIZED' }
  | { kind: 'SCHEDULE'; everyDayAtMinutes: number };

/** How a message is classified for contention — NOT Meta's billing category. */
export type Intent =
  /** The patient did something and this is the answer. Never capped, never deferred. */
  | 'REACTIVE'
  /** We initiated. Contends with every other proactive journey for one person's attention. */
  | 'PROACTIVE';

export type ParamBinding =
  | { from: 'PATIENT_FIRST_NAME' }
  | { from: 'BRANCH_NAME' }
  | { from: 'COUPON_CODE' }
  | { from: 'LITERAL'; value: string };

export type Step =
  | {
      kind: 'WAIT';
      /**
       * TRIGGER anchors to run.triggeredAt — Day 10 is Day 10 whatever happened before
       * it. PREVIOUS chains to the last step and therefore ACCUMULATES DRIFT: a ten-hour
       * quiet-hours delay on Day 2 pushes every later relative wait with it.
       */
      anchor: 'TRIGGER' | 'PREVIOUS';
      days?: number;
      hours?: number;
    }
  | {
      kind: 'CHECK';
      condition: Condition;
      onTrue: 'STOP' | 'CONTINUE';
      stopReason?: string;
    }
  | {
      kind: 'SEND';
      template: string;
      language?: string;
      params: ParamBinding[];
      intent: Intent;
      /** Issued in the SAME step, under the same idempotency key as the send. */
      issueOffer?: { campaignId: string };
    }
  | { kind: 'STOP'; reason: string };

export interface AutomationDefinition {
  trigger: Trigger;
  reentry: {
    /** May they enrol again? */
    mode: 'PER_EVENT' | 'ONCE' | 'EVERY_N_DAYS';
    days?: number;
    /** May two runs be live at once? Orthogonal to mode, and not expressible by it. */
    concurrency: 'ALLOW_PARALLEL' | 'ONE_ACTIVE_PER_PATIENT';
  };
  /** Evaluated once, at enrolment. */
  audience: Condition;
  /**
   * Declared ONCE and read twice: the stop condition is "goal met", and a conversion is
   * "goal met within windowDays of triggeredAt". Two subsystems guarantee they drift.
   */
  goal: { condition: Condition; windowDays: number; stopReason?: string };
  steps: Step[];
}

/** Reason codes. Every decision writes one; an empty outcome is a bug, never a default. */
export const Outcome = {
  ENROLLED: 'ENROLLED',
  WAITING: 'WAITING',
  CHECK_TRUE: 'CHECK_TRUE',
  CHECK_FALSE: 'CHECK_FALSE',
  SENT: 'SENT',
  ALREADY_SENT: 'ALREADY_SENT',
  COUPON_ISSUED: 'COUPON_ISSUED',
  STOPPED_GOAL_MET: 'STOPPED_GOAL_MET',
  STOPPED_BY_STEP: 'STOPPED_BY_STEP',
  STOPPED_BY_STAFF: 'STOPPED_BY_STAFF',
  STOPPED_AUTOMATION_STOPPED: 'STOPPED_AUTOMATION_STOPPED',
  CONVERSION_REVERSED: 'CONVERSION_REVERSED',
  MISSED_WINDOW: 'MISSED_WINDOW',
  HELD_OUT: 'HELD_OUT',
  DECEASED: 'DECEASED',
  NO_PHONE: 'NO_PHONE',
  PHONE_OPTED_OUT: 'PHONE_OPTED_OUT',
  NOT_OPTED_IN_MARKETING: 'NOT_OPTED_IN_MARKETING',
  LINK_DISABLED: 'LINK_DISABLED',
  CRITICAL_VALUE: 'CRITICAL_VALUE',
  HUMAN_HOLDS_THREAD: 'HUMAN_HOLDS_THREAD',
  LINE_HELD_BY_ANOTHER_RUN: 'LINE_HELD_BY_ANOTHER_RUN',
  TEMPLATE_PAUSED: 'TEMPLATE_PAUSED',
  OFFER_EXHAUSTED: 'OFFER_EXHAUSTED',
  FREQUENCY_CAP: 'FREQUENCY_CAP',
  QUIET_HOURS: 'QUIET_HOURS',
  WAITING_ANOTHER_AUTOMATION: 'WAITING_ANOTHER_AUTOMATION',
  UNIT_MISMATCH: 'UNIT_MISMATCH',
  SEND_FAILED: 'SEND_FAILED',
} as const;
export type OutcomeCode = (typeof Outcome)[keyof typeof Outcome];
