/**
 * The catalog of things an automation can BE, served like the predicate catalog.
 *
 * The frontend had this as a hardcoded array with build() functions assembling
 * definitions in React — so adding a kind meant editing TypeScript in the browser app,
 * and the shape of a definition was known in two places that could drift. The predicate
 * vocabulary was already served for exactly this reason; this is the same rule applied
 * to the thing one level up.
 *
 * A blueprint declares what to ASK and how to ASSEMBLE. The browser renders the
 * questions and posts the answers; it never constructs a definition.
 */
import type { AutomationDefinition, Step, Trigger } from './types';

export type FieldType = 'TEXT' | 'TIME' | 'NUMBER' | 'BRANCHES' | 'TEMPLATE' | 'CHOICE' | 'OFFER';

export interface BlueprintField {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  default?: string | number;
  help?: string;
  /** For CHOICE. */
  options?: { value: string; label: string }[];
  /** For TEMPLATE: only offer templates Meta currently approves. */
  approvedOnly?: boolean;
}

export interface Blueprint {
  id: string;
  title: string;
  sub: string;
  group: string;
  /** A report to the team: no audience, no holdout, nothing to convert. */
  scheduled: boolean;
  holdoutPct: number;
  fields: BlueprintField[];
}

type Values = Record<string, string | number | string[] | undefined>;

interface Recipe extends Blueprint {
  assemble: (v: Values) => AutomationDefinition;
}

const str = (v: Values, k: string, d = '') => (typeof v[k] === 'string' ? (v[k] as string) : d);
const num = (v: Values, k: string, d: number) => {
  const raw = v[k];
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : d;
};

/** "22:30" -> 1350. Minutes past midnight IST, matching how the schedule is stored. */
const minutesOf = (hhmm: string, fallback = 1350) => {
  const [h, m] = (hhmm || '').split(':').map(Number);
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : fallback;
};

/** Wait → check → send, stopping the moment the thing being chased happens. */
function chase(opts: {
  domain: 'CLINIC' | 'DIAGNOSTICS';
  predicate: string;
  days: number;
  template: string;
  windowDays: number;
  extraAudience?: AutomationDefinition['audience'][];
}): AutomationDefinition {
  const goal = { fn: opts.predicate } as const;
  const trigger: Trigger = { kind: 'VISIT_COMPLETED', domain: opts.domain };
  const steps: Step[] = [
    { kind: 'WAIT', anchor: 'TRIGGER', days: opts.days },
    { kind: 'CHECK', condition: goal, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
    { kind: 'SEND', template: opts.template, intent: 'PROACTIVE', params: [{ from: 'PATIENT_FIRST_NAME' }] },
    { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
  ];
  return {
    trigger,
    reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
    audience: { all: [{ fn: 'patientAgeYears', op: 'gte', value: 18 }, ...(opts.extraAudience ?? [])] },
    goal: { condition: goal, windowDays: opts.windowDays, stopReason: 'STOPPED_GOAL_MET' },
    steps,
  };
}

const TEMPLATE_FIELD: BlueprintField = {
  key: 'template', label: 'Message', type: 'TEMPLATE', approvedOnly: true, required: true,
  help: 'Only templates Meta currently approves can be sent.',
};

const RECIPES: Recipe[] = [
  {
    id: 'CLINIC_TO_DX_RECOVERY',
    title: "Follow up when something hasn't happened",
    sub: 'They consulted but never did the tests',
    group: 'Patient journeys',
    scheduled: false,
    holdoutPct: 10,
    fields: [
      { key: 'days', label: 'Wait this many days first', type: 'NUMBER', default: 2,
        help: 'Long enough that someone walking straight to the lab is not chased.' },
      TEMPLATE_FIELD,
      { key: 'windowDays', label: 'Counts as converted within', type: 'NUMBER', default: 14,
        help: 'Days after the visit. Measured from the visit, not from the message.' },
    ],
    assemble: (v) => chase({
      domain: 'CLINIC', predicate: 'testDoneSinceThisVisit',
      days: num(v, 'days', 2), template: str(v, 'template'),
      windowDays: num(v, 'windowDays', 14),
    }),
  },
  {
    id: 'BILL_OUTSTANDING',
    title: 'Remind them about something due',
    sub: 'A bill still outstanding',
    group: 'Patient journeys',
    scheduled: false,
    holdoutPct: 10,
    fields: [
      { key: 'days', label: 'Wait this many days first', type: 'NUMBER', default: 7 },
      TEMPLATE_FIELD,
    ],
    assemble: (v) => ({
      trigger: { kind: 'VISIT_COMPLETED', domain: 'DIAGNOSTICS' },
      reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
      audience: { all: [{ fn: 'outstandingDueInPaise', op: 'gt', value: 0 }] },
      goal: { condition: { fn: 'outstandingDueInPaise', op: 'lte', value: 0 }, windowDays: 30 },
      steps: [
        { kind: 'WAIT', anchor: 'TRIGGER', days: num(v, 'days', 7) },
        { kind: 'CHECK', condition: { fn: 'outstandingDueInPaise', op: 'lte', value: 0 },
          onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
        { kind: 'SEND', template: str(v, 'template'), intent: 'PROACTIVE', params: [{ from: 'PATIENT_FIRST_NAME' }] },
        { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
      ],
    }),
  },
  {
    id: 'REPORT_UNOPENED',
    title: 'Nudge a report nobody opened',
    sub: 'The link was sent and never touched',
    group: 'Patient journeys',
    scheduled: false,
    holdoutPct: 10,
    fields: [
      { key: 'days', label: 'Wait this many days first', type: 'NUMBER', default: 2 },
      TEMPLATE_FIELD,
    ],
    assemble: (v) => chase({
      domain: 'DIAGNOSTICS', predicate: 'reportOpened',
      days: num(v, 'days', 2), template: str(v, 'template'), windowDays: 14,
    }),
  },
  {
    id: 'OP_DIAGNOSTIC_RECOVERY',
    title: 'Win back a consultation that led to no tests',
    sub: 'Offer a discount, let them claim it, remind them once before it expires',
    group: 'Patient journeys',
    scheduled: false,
    // No control group in v1, by decision.
    holdoutPct: 0,
    fields: [
      { key: 'offerDay', label: 'Send the offer on day', type: 'NUMBER', default: 2, required: true,
        help: 'Counted from the consultation. Day 2 leaves room for someone who walked straight to the lab.' },
      { key: 'remindDay', label: 'Remind them on day', type: 'NUMBER', default: 5, required: true },
      { key: 'expiryDay', label: 'Offer expires end of day', type: 'NUMBER', default: 6, required: true,
        help: 'Measured from the consultation, so claiming late means less time rather than a fresh window.' },
      { key: 'campaignId', label: 'Which offer', type: 'OFFER', required: true,
        help: 'The discount this journey hands out.' },
      { key: 'offerTemplate', label: 'The offer message', type: 'TEMPLATE', approvedOnly: true, required: true,
        help: 'Needs a "Get my code" button. It carries no code — the patient claims it.' },
      { key: 'codeTemplate', label: 'The message carrying the code', type: 'TEMPLATE', approvedOnly: true, required: true },
      { key: 'remindWithCodeTemplate', label: 'Reminder for someone holding a code', type: 'TEMPLATE', approvedOnly: true, required: true },
      { key: 'remindToClaimTemplate', label: 'Reminder for someone who never claimed', type: 'TEMPLATE', approvedOnly: true, required: true,
        help: 'Also needs a "Get my code" button. Same day, two different truths.' },
    ],
    assemble: (v) => {
      const offerDay = num(v, 'offerDay', 2);
      const remindDay = num(v, 'remindDay', 5);
      const expiryDay = num(v, 'expiryDay', 6);
      const campaignId = str(v, 'campaignId');
      const recovered = { fn: 'testDoneSinceThisVisit' } as const;
      const expiry = { anchor: 'TRIGGER' as const, days: expiryDay, endOfDayIST: true };

      return {
        trigger: { kind: 'VISIT_COMPLETED', domain: 'CLINIC' },
        // One live journey per patient. A second qualifying visit meanwhile is recorded
        // as suppressed and never reconsidered — skipped, not queued.
        reentry: { mode: 'PER_EVENT', concurrency: 'ONE_ACTIVE_PER_PATIENT' },
        policy: { skipMarketingConsent: true, stopScope: 'THIS_JOURNEY' },
        audience: { fn: 'always' },
        goal: { condition: recovered, windowDays: expiryDay, stopReason: 'STOPPED_GOAL_MET' },
        steps: [
          { kind: 'WAIT', anchor: 'TRIGGER', days: offerDay },
          { kind: 'CHECK', condition: recovered, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
          {
            kind: 'ASK', template: str(v, 'offerTemplate'), intent: 'PROACTIVE',
            params: [{ from: 'PATIENT_FIRST_NAME' }],
            buttons: [{ payload: 'GET_CODE', label: 'Get my code', goTo: 3 }],
            keywords: [{ match: 'code', goTo: 3 }],
            onUnmatched: 'HANDOFF',
            waitHours: Math.max(24, (remindDay - offerDay) * 24),
          },
          {
            kind: 'SEND', template: str(v, 'codeTemplate'), intent: 'PROACTIVE',
            params: [{ from: 'COUPON_CODE' }],
            issueOffer: { campaignId, expiry },
          },
          { kind: 'WAIT', anchor: 'TRIGGER', days: remindDay },
          { kind: 'CHECK', condition: recovered, onTrue: 'STOP', stopReason: 'STOPPED_GOAL_MET' },
          // One journey, two things to say.
          {
            kind: 'CHECK',
            condition: { fn: 'couponState', op: 'in', value: ['ISSUED', 'PENDING'] },
            onTrue: 7, onFalse: 8,
          },
          {
            kind: 'SEND', template: str(v, 'remindWithCodeTemplate'), intent: 'PROACTIVE',
            params: [{ from: 'COUPON_CODE' }],
          },
          {
            kind: 'ASK', template: str(v, 'remindToClaimTemplate'), intent: 'PROACTIVE',
            params: [{ from: 'PATIENT_FIRST_NAME' }],
            buttons: [{ payload: 'GET_CODE', label: 'Get my code', goTo: 9 }],
            keywords: [{ match: 'code', goTo: 9 }],
            onUnmatched: 'HANDOFF',
            waitHours: Math.max(6, (expiryDay - remindDay) * 24),
          },
          // A late claim gets the SAME expiry — less time, not a fresh window.
          {
            kind: 'SEND', template: str(v, 'codeTemplate'), intent: 'PROACTIVE',
            params: [{ from: 'COUPON_CODE' }],
            issueOffer: { campaignId, expiry },
          },
          { kind: 'WAIT', anchor: 'TRIGGER', days: expiryDay },
          { kind: 'STOP', reason: 'STOPPED_BY_STEP' },
        ],
      };
    },
  },
  {
    id: 'TEAM_DAY_SHEET',
    title: 'Send your team a regular report',
    sub: "The day's collections, every night",
    group: 'Reports to your team',
    scheduled: true,
    // Nobody to hold back from a message to your own team.
    holdoutPct: 0,
    fields: [
      { key: 'domain', label: 'Which takings', type: 'CHOICE', required: true, default: 'DIAGNOSTICS',
        options: [
          { value: 'DIAGNOSTICS', label: 'Diagnostic takings' },
          { value: 'CLINIC', label: 'OP takings' },
        ] },
      { key: 'sendAt', label: 'Every day at', type: 'TIME', required: true, default: '22:30' },
      { key: 'branchIds', label: 'Which branches', type: 'BRANCHES', required: true,
        help: 'One message per branch, each with its own link.' },
      { key: 'template', label: 'Template', type: 'TEMPLATE',
        help: 'Leave blank for the one these reports have always used.' },
      { key: 'graceHours', label: 'Still send up to this many hours late', type: 'NUMBER', default: 8,
        help: 'If the server was asleep at the send time, it still goes out inside this window.' },
      { key: 'linkExpiryHours', label: 'Link works for this many hours', type: 'NUMBER', default: 72,
        help: "A day's takings should stop being reachable at some point." },
    ],
    assemble: (v) => ({
      trigger: {
        kind: 'SCHEDULE',
        everyDayAtMinutes: minutesOf(str(v, 'sendAt', '22:30')),
        graceHours: num(v, 'graceHours', 8),
      },
      reentry: { mode: 'PER_EVENT', concurrency: 'ALLOW_PARALLEL' },
      audience: { fn: 'always' },
      goal: { condition: { fn: 'always' }, windowDays: 1 },
      steps: [{
        kind: 'DAY_SHEET',
        domain: str(v, 'domain', 'DIAGNOSTICS') === 'CLINIC' ? 'CLINIC' : 'DIAGNOSTICS',
        ...(str(v, 'template') ? { template: str(v, 'template') } : {}),
        linkExpiryHours: num(v, 'linkExpiryHours', 72),
      }],
    }),
  },
];

/** What the browser renders. `assemble` never crosses the wire. */
export function listBlueprints(): Blueprint[] {
  return RECIPES.map(({ assemble, ...b }) => b);
}

export function buildFromBlueprint(id: string, values: Values):
  { definition: AutomationDefinition; blueprint: Blueprint } | null {
  const recipe = RECIPES.find((r) => r.id === id);
  if (!recipe) return null;
  const { assemble, ...blueprint } = recipe;
  return { definition: assemble(values), blueprint };
}
