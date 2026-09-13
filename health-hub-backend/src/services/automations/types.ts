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
  | {
      kind: 'SCHEDULE';
      everyDayAtMinutes: number;
      /**
       * How late a missed firing may still run. Belongs to the TRIGGER, not to whatever
       * the automation then does — "the box was asleep at 22:30" is a question about
       * when this was due, and the answer is the same whether it sends a day sheet or
       * anything else. It sat on the day-sheet action first, which would have meant
       * every future scheduled action re-inventing it. Absent = 8 hours.
       */
      graceHours?: number;
    };

/**
 * Who a message is addressed to.
 *
 * THE ONE CONCEPT EVERY SENDING ACTION SHARES. A patient journey addresses the run's
 * own patient; a nightly report addresses staff; a monthly statement will address a
 * referring doctor. Without this they each grow their own recipient field and the
 * engine quietly stops being generic — which is exactly what `recipientUserIds` on the
 * day-sheet step was starting to do.
 *
 * A new action picks a Recipients value and brings its own PAYLOAD. It never invents a
 * new way of saying who to send to.
 */
export type Recipients =
  /** The patient this run is about. The default for anything patient-facing. */
  | { kind: 'RUN_PATIENT' }
  /** Named people, or everyone holding a role. Staff-facing. */
  | { kind: 'USERS'; userIds?: string[]; role?: 'owner' | 'lab_incharge' | 'staff' | 'sales' };

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
      /**
       * 'STOP' ends the run, 'CONTINUE' falls through, a NUMBER jumps to that step.
       *
       * The jump is what lets one journey say two different things — "here is your code"
       * to someone who claimed it, "claim your code" to someone who did not — without
       * being two journeys that then have to be kept in step with each other.
       */
      onTrue: 'STOP' | 'CONTINUE' | number;
      onFalse?: 'STOP' | 'CONTINUE' | number;
      stopReason?: string;
    }
  | {
      kind: 'SEND';
      /** Absent = the run's own patient, which is what a journey almost always means. */
      to?: Recipients;
      template: string;
      language?: string;
      params: ParamBinding[];
      intent: Intent;
      /**
       * Issued with this message. ONE per run, not one per step: a patient who can claim
       * from either the first message or the reminder must still end up with a single
       * code, and both steps asking for one is the normal case rather than the edge.
       */
      issueOffer?: {
        campaignId: string;
        /**
         * When it dies. Anchored to the TRIGGER by default, so claiming late means less
         * time rather than a fresh window — an offer that resets every time someone taps
         * it is not an expiring offer.
         */
        expiry?: {
          anchor: 'TRIGGER' | 'ISSUE';
          days: number;
          /** End of that day in IST, so "expires Day 6" means all of Day 6. */
          endOfDayIST?: boolean;
        };
      };
    }
  | {
      /**
       * The nightly day sheet. Not a patient message: the recipient is the owner, the
       * body is a generated link, and the money in it is the whole point.
       *
       * It reuses sendDaySheet rather than reimplementing it — and it claims the SAME
       * ScheduledMessageRun key the old ticker claims, so the two systems interlock
       * instead of both sending. That is what makes a cutover safe even if both are
       * briefly live.
       */
      kind: 'DAY_SHEET';
      domain: 'DIAGNOSTICS' | 'CLINIC';
      /** Shared with every sending action. Absent = every active owner. */
      to?: Recipients;
      /** Meta template. Absent = the service default. */
      template?: string;
      /**
       * The PAYLOAD half, which is genuinely particular to this action and should not be
       * generalised: this body is computed money figures plus a tokenised link, not
       * template parameters. How long that link stays alive is part of it.
       * Absent = 72 hours.
       */
      linkExpiryHours?: number;
    }
  | {
      /**
       * Ask a question and wait for the answer.
       *
       * A MENU, NOT A CONVERSATION. Buttons carry the run id, which is the only exact
       * correlation key WhatsApp offers and the only thing that survives a phone three
       * people share. Free text that matches nothing is not a failure — it is the
       * handoff, and a person is better at it than a classifier would be.
       *
       * While this waits it holds the phone line, so no other journey may message the
       * number. Nobody answering is an outcome too: the run continues to the next step
       * when the window closes.
       */
      kind: 'ASK';
      template: string;
      language?: string;
      params: ParamBinding[];
      intent: Intent;
      /** Payload -> where to go. The payload is what the button actually carries. */
      buttons: { payload: string; label: string; goTo: number | 'STOP'; stopReason?: string }[];
      /** Best-effort fallback for people who type instead of tapping. */
      keywords?: { match: string; goTo: number | 'STOP'; stopReason?: string }[];
      /** They replied, and it matched no button and no keyword. */
      onUnmatched: 'HANDOFF' | 'STOP' | 'CONTINUE';
      /**
       * They never replied at all.
       *
       * A DIFFERENT QUESTION from onUnmatched, and conflating the two is how someone who
       * ignored an offer gets sent the code anyway: silence fell through to the next
       * step, and the next step was the one that hands out the discount. Silence usually
       * means skipping whatever the answer would have unlocked, so this points at the
       * step that comes after it. Absent = carry on to the next step.
       */
      onNoReply?: 'STOP' | 'CONTINUE' | number;
      /** How long to hold the line. Absent = 24 hours, the provider's own window. */
      waitHours?: number;
    }
  | {
      /** Give the thread to a person and end the run. */
      kind: 'HANDOFF';
      note?: string;
    }
  | { kind: 'STOP'; reason: string };

export interface AutomationDefinition {
  trigger: Trigger;
  /**
   * Consent and opt-out behaviour for this journey.
   *
   * Deliberately explicit rather than inferred: an automation that skips the marketing
   * gate is a decision someone made about what this message IS, and it should be
   * readable in the definition rather than implied by which template it happens to use.
   */
  policy?: {
    /**
     * Treat this as operational follow-up rather than marketing, so the marketing
     * opt-in gate does not apply. The per-number STOP list still does — that one is not
     * ours to waive.
     */
    skipMarketingConsent?: boolean;
    /**
     * What an inbound STOP means. 'GLOBAL' adds the number to the opt-out list and
     * silences every journey — the safe default and what a patient means by it.
     * 'THIS_JOURNEY' only ends this run.
     */
    stopScope?: 'GLOBAL' | 'THIS_JOURNEY';
  };
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
  ALREADY_SENT_BY_OLD_TICKER: 'ALREADY_SENT_BY_OLD_TICKER',
  NO_SCHEDULE_ROW: 'NO_SCHEDULE_ROW',
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
  ASKED: 'ASKED',
  NO_REPLY: 'NO_REPLY',
  REPLIED: 'REPLIED',
  HANDED_TO_STAFF: 'HANDED_TO_STAFF',
  LINE_BUSY: 'LINE_BUSY',
} as const;
export type OutcomeCode = (typeof Outcome)[keyof typeof Outcome];
