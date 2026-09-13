/**
 * Say what a definition actually does, in words, from the definition itself.
 *
 * WHY THIS EXISTS. Every screen that described a journey wrote its prose by hand, and
 * the hand that wrote it was thinking about clinic-to-diagnostics recovery. So a CHECK
 * on coupon state rendered as "Did this visit lead to diagnostics?", the stop line said
 * diagnostics for a journey chasing an unpaid bill, and the activation dialog — the one
 * screen where being wrong is expensive — asserted both.
 *
 * The rule this restores: anything the UI READS from the definition was correct;
 * anything it NARRATED about the definition was a fossil. So nothing narrates any more.
 *
 * The vocabulary is the catalog the backend serves, so a predicate can never be
 * described by a label the engine does not recognise.
 */
import type { Condition, PredicateMeta, Step, Jump } from './api';

const OP_WORDS: Record<string, string> = {
  gte: 'is at least', lte: 'is at most', gt: 'is more than',
  lt: 'is less than', eq: 'is', ne: 'is not', in: 'is one of',
};

function valueWords(value: unknown, meta?: PredicateMeta): string {
  if (Array.isArray(value)) return value.map((v) => String(v).toLowerCase()).join(' or ');
  if (meta?.unit === 'RUPEES') return `₹${Math.round(Number(value) / 100).toLocaleString('en-IN')}`;
  if (meta?.unit === 'DAYS') return `${value} days`;
  if (meta?.unit === 'YEARS') return `${value} years`;
  return String(value);
}

/** One condition, read back as a phrase. Never a question — callers frame it. */
export function describeCondition(c: Condition, catalog: PredicateMeta[]): string {
  if ('all' in c) return c.all.map((x) => describeCondition(x, catalog)).join(' and ');
  if ('any' in c) return c.any.map((x) => describeCondition(x, catalog)).join(' or ');
  if ('not' in c) return `not ${describeCondition(c.not, catalog)}`;

  if (c.fn === 'always') return 'everyone';
  const meta = catalog.find((p) => p.fn === c.fn);
  // Falling back to the raw function name is the honest failure: it is ugly, and it is
  // never wrong. Inventing a friendly sentence for an unknown predicate would be.
  const label = meta?.label ?? c.fn;
  const scoped = meta?.scope ? `${label} (${meta.scope})` : label;

  if (c.op === undefined) return scoped.toLowerCase();
  return `${scoped.toLowerCase()} ${OP_WORDS[c.op] ?? c.op} ${valueWords(c.value, meta)}`;
}

/** Where a branch goes, in the same words the drawer offers. */
export function describeJump(j: Jump | undefined, fallback = 'carry on'): string {
  if (j === undefined) return fallback;
  if (j === 'STOP') return 'stop';
  if (j === 'CONTINUE') return 'carry on';
  return `go to step ${j + 1}`;
}

/** What a step does, in one line. Used wherever a journey is summarised. */
export function describeStep(step: Step, catalog: PredicateMeta[]): string {
  switch (step.kind) {
    case 'WAIT':
      return step.anchor === 'TRIGGER'
        ? `Wait until day ${step.days ?? 0}`
        : `Wait ${step.days ?? 0} day${(step.days ?? 0) === 1 ? '' : 's'}`;
    case 'CHECK':
      return `Check whether ${describeCondition(step.condition, catalog)}`;
    case 'SEND':
      return `Send ${step.template}${step.issueOffer ? ' with an offer' : ''}`;
    case 'ASK':
      return `Ask, using ${step.template}`;
    case 'HANDOFF':
      return 'Hand the conversation to a person';
    case 'DAY_SHEET':
      return `Send the ${step.domain === 'CLINIC' ? 'OP' : 'diagnostic'} day sheet`;
    case 'STOP':
      return 'Stop';
    default:
      return `A "${(step as { kind: string }).kind}" step`;
  }
}

/**
 * The steps that actually put something in front of someone.
 *
 * ASK sends a message too. The activation dialog listed SEND only, so the journey whose
 * first patient contact is a question showed its follow-ups and hid its opening line.
 */
export type MessagingStep = Extract<Step, { kind: 'SEND' | 'ASK' | 'DAY_SHEET' }>;

export function messagingSteps(steps: Step[]): { step: MessagingStep; index: number }[] {
  return steps
    .map((step, index) => ({ step, index }))
    .filter((e): e is { step: MessagingStep; index: number } =>
      e.step.kind === 'SEND' || e.step.kind === 'ASK' || e.step.kind === 'DAY_SHEET');
}

/** The day a step falls on, from the nearest anchored wait above it. */
export function dayOf(steps: Step[], index: number): string {
  for (let i = index; i >= 0; i -= 1) {
    const s = steps[i];
    if (s.kind === 'WAIT' && s.anchor === 'TRIGGER') return `Day ${s.days ?? 0}`;
  }
  return 'Straight away';
}
