/**
 * The engine's grammar, published.
 *
 * The builder rendered five step kinds while the engine ran seven, so an `ASK` step
 * existed in the database and simply did not appear on screen — a journey an operator
 * could neither read nor edit. That is worse than a missing feature: the screen looked
 * complete and was not.
 *
 * Step kinds are the grammar rather than the vocabulary — a small, slow-moving set, not
 * a growing catalog like predicates or blueprints. So they stay explicit in the builder.
 * What this gives us is the CHECK: the UI can compare what it can render against what
 * the engine can run, and say so out loud when it falls behind instead of hiding a step.
 */
import { FIELD_CATALOG } from './fields';
import { TRIGGERS } from './triggers';
import { missingArgs } from './predicates';
import type { Condition } from './types';

export interface StepMeta {
  kind: string;
  label: string;
  /** One line an operator would recognise. */
  summary: string;
  /** Sends a message, so consent and the sending rules apply. */
  sends: boolean;
  /** Can hand control to another step by index. */
  branches: boolean;
  /** Ends the run. */
  terminal: boolean;
}

export const STEP_CATALOG: StepMeta[] = [
  { kind: 'WAIT', label: 'Wait', summary: 'Hold until a day after the trigger, or a gap after the step before',
    sends: false, branches: false, terminal: false },
  { kind: 'CHECK', label: 'Check', summary: 'Re-read the facts and stop, carry on, or jump to another step',
    sends: false, branches: true, terminal: false },
  { kind: 'SEND', label: 'Send a message', summary: 'One message, optionally issuing an offer with it',
    sends: true, branches: false, terminal: false },
  { kind: 'ASK', label: 'Ask a question', summary: 'Send buttons and hold the line for an answer',
    sends: true, branches: true, terminal: false },
  { kind: 'HANDOFF', label: 'Hand to staff', summary: 'Give the thread to a person and end the run',
    sends: false, branches: false, terminal: true },
  { kind: 'DAY_SHEET', label: 'Send the day sheet', summary: "A branch's takings to your own team",
    sends: true, branches: false, terminal: false },
  { kind: 'STOP', label: 'Stop', summary: 'End the journey',
    sends: false, branches: false, terminal: true },
];

export interface DefinitionProblem {
  where: string;
  problem: string;
  /** A definition with this is broken; without it, it is merely odd. */
  blocking: boolean;
}

/**
 * Read a definition back and say what is wrong with it.
 *
 * Branching made this necessary: a `goTo` pointing at a step that does not exist is a
 * run that stops dead in production, and there is nothing in the shape of the JSON to
 * catch it. The engine cannot refuse at runtime without stranding a patient mid-journey,
 * so it has to be refused at save.
 */
/** The earliest day after the trigger a step can run: anchored waits set it, relative ones add to it. */
function earliestDay(steps: { kind?: string; [k: string]: unknown }[], index: number): number {
  let day = 0;
  for (let i = 0; i < index; i += 1) {
    const s = steps[i] as { kind?: string; anchor?: string; days?: number };
    if (s.kind !== 'WAIT') continue;
    day = s.anchor === 'TRIGGER' ? Math.max(day, s.days ?? 0) : day + (s.days ?? 0);
  }
  return day;
}

export function validateDefinition(def: {
  trigger?: { kind?: string };
  steps?: { kind?: string; [k: string]: unknown }[];
  goal?: { windowDays?: number; condition?: Condition };
  audience?: Condition;
  reentry?: { mode?: string; days?: number; concurrency?: string };
  past?: { from?: string; to?: string };
  dailyLimit?: number;
}, knownCampaignIds?: Set<string> | Map<string, number>): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const steps = def.steps ?? [];
  const known = new Set(STEP_CATALOG.map((s) => s.kind));
  const journeyIssuesOffer = steps.some((st) => !!(st as { issueOffer?: unknown }).issueOffer);

  // An empty draft may be SAVED — someone starting from scratch sets the trigger before
  // the first step. It cannot be ACTIVATED; the activate route refuses it.
  if (steps.length === 0) {
    problems.push({ where: 'steps', problem: 'This journey has no steps yet, so it would do nothing.', blocking: false });
  }

  const kind = def.trigger?.kind;
  if (kind && kind !== 'SCHEDULE' && !TRIGGERS[kind]) {
    problems.push({ where: 'trigger', problem: `"${kind}" is not something the engine can start a journey from.`, blocking: true });
  }

  // Past ones: a range of whole days that has already ended, for something that happens.
  if (def.past) {
    const { from = '', to = '' } = def.past;
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    const day = /^\d{4}-\d{2}-\d{2}$/;
    const problem = kind === 'SCHEDULE' || (kind && TRIGGERS[kind]?.period)
      ? 'Past ones can only be read for something that happens, like a visit — a regular check already looks at everyone.'
      : !day.test(from) || !day.test(to) ? 'Past ones need a first and a last day.'
        : from > to ? 'The first day is after the last day.'
          : to >= today ? 'The last day has to be before today — anything from today on is a new one, not a past one.'
            : null;
    if (problem) problems.push({ where: 'Which ones', problem, blocking: true });
  }
  if (def.dailyLimit !== undefined && !(Number.isInteger(def.dailyLimit) && def.dailyLimit >= 1)) {
    problems.push({ where: 'Start at most', problem: 'The daily limit has to be a whole number, 1 or more.', blocking: true });
  }

  steps.forEach((step, i) => {
    if (!step.kind || !known.has(step.kind)) {
      problems.push({
        where: `step ${i + 1}`,
        problem: `"${step.kind ?? 'missing'}" is not something the engine can run.`,
        blocking: true,
      });
      return;
    }

    const jumps: unknown[] = [];
    if (step.kind === 'CHECK') jumps.push(step.onTrue, step.onFalse);
    if (step.kind === 'ASK') {
      for (const b of (step.buttons as { goTo?: unknown }[] | undefined) ?? []) jumps.push(b.goTo);
      for (const k of (step.keywords as { goTo?: unknown }[] | undefined) ?? []) jumps.push(k.goTo);
      jumps.push(step.onNoReply);
    }
    for (const j of jumps) {
      if (typeof j !== 'number') continue;
      if (j < 0 || j >= steps.length) {
        problems.push({
          where: `step ${i + 1}`,
          problem: `Sends the journey to step ${j + 1}, which does not exist.`,
          blocking: true,
        });
      }
    }

    // An offer the engine cannot find is not a save-time inconvenience: issuing is
    // refused at runtime and the message goes out ANYWAY, with an empty code in it.
    // The campaign id is the one field an operator cannot sanity-check by eye.
    if (step.kind === 'SEND' || step.kind === 'ASK') {
      const offer = step.issueOffer as { campaignId?: unknown } | undefined;
      if (offer !== undefined) {
        const id = offer.campaignId;
        if (typeof id !== 'string' || id.trim() === '') {
          problems.push({
            where: `step ${i + 1}`,
            problem: 'This step issues an offer but no offer is chosen.',
            blocking: true,
          });
        } else if (knownCampaignIds && !knownCampaignIds.has(id)) {
          problems.push({
            where: `step ${i + 1}`,
            problem: `No offer with id "${id}" exists. The message would still be sent, with no code in it.`,
            blocking: true,
          });
        }
        // Anchored to the trigger, the code's last day is fixed. Sent after it, the code
        // arrives already expired — a 90-day retest reminder with a day-6 expiry did.
        const expiry = (offer as { expiry?: { anchor?: string; days?: number } }).expiry;
        const sendDay = earliestDay(steps, i);
        if (expiry?.anchor === 'TRIGGER' && typeof expiry.days === 'number' && expiry.days < sendDay) {
          problems.push({
            where: `step ${i + 1}`,
            problem: `The code expires at the end of day ${expiry.days}, but this message goes out on day ${sendDay} — it would arrive already expired.`,
            blocking: true,
          });
        }

        // One live code per patient. If the code can outlast the gap before the same
        // patient can start this journey again, they can hold two at once — two family
        // codes, six uses, where one was meant. The gap is "How often", or the journey's
        // own length when only one can run per patient at a time.
        const validity = typeof id === 'string' && knownCampaignIds instanceof Map ? knownCampaignIds.get(id) : undefined;
        const lastDay = expiry?.anchor === 'TRIGGER' && typeof expiry.days === 'number' ? expiry.days
          : expiry?.anchor === 'ISSUE' && typeof expiry.days === 'number' ? sendDay + expiry.days
          : validity !== undefined ? sendDay + validity : null;
        const r = def.reentry;
        if (lastDay !== null && r && r.mode !== 'ONCE') {
          const gap = Math.max(
            r.mode === 'EVERY_N_DAYS' ? r.days ?? 0 : 0,
            r.concurrency === 'ONE_ACTIVE_PER_PATIENT' ? earliestDay(steps, steps.length) : 0,
          );
          if (lastDay > gap) {
            problems.push({
              where: `step ${i + 1}`,
              problem: `The code can be used until day ${lastDay}, but the same patient can start this again ${gap === 0 ? 'on their next visit' : `after ${gap} days`}, so they could hold two codes at once. Set "How often" to at most once every ${lastDay} days, or let the code expire by day ${gap}.`,
              blocking: false,
            });
          }
        }
      }
    }

    // Every blank must name a field the engine can fill. An offer field in a journey that
    // never issues an offer can only ever resolve to nothing, so the message would never
    // send — refuse that here, where it is a sentence, not a silent skip in production.
    const params = (step.params as { from?: string; value?: string }[] | undefined) ?? [];
    params.forEach((b, n) => {
      const meta = FIELD_CATALOG.find((f) => f.from === b.from);
      if (!meta) {
        problems.push({ where: `step ${i + 1}`, problem: `Blank ${n + 1} is filled from "${b.from ?? 'nothing'}", which is not a field the engine knows.`, blocking: true });
      } else if (meta.from === 'LITERAL' && !(b.value ?? '').trim()) {
        problems.push({ where: `step ${i + 1}`, problem: `Blank ${n + 1} is set to fixed text but the text is empty.`, blocking: true });
      } else if (meta.needsOffer && !journeyIssuesOffer) {
        problems.push({ where: `step ${i + 1}`, problem: `Blank ${n + 1} shows the ${meta.label.toLowerCase()}, but nothing in this journey issues an offer.`, blocking: true });
      }
    });

    if (step.kind === 'ASK') {
      const buttons = (step.buttons as unknown[] | undefined) ?? [];
      if (buttons.length === 0) {
        problems.push({
          where: `step ${i + 1}`,
          problem: 'A question with no buttons can only ever be answered by free text.',
          blocking: false,
        });
      }
      if (buttons.length > 3) {
        problems.push({
          where: `step ${i + 1}`,
          problem: 'WhatsApp shows at most three quick-reply buttons.',
          blocking: true,
        });
      }
      // A blank answer or typed word can never be matched, so its branch is unreachable.
      (buttons as { label?: string }[]).forEach((b, n) => {
        if (!(b.label ?? '').trim()) problems.push({ where: `step ${i + 1}`, problem: `Answer ${n + 1} has no words, so no reply can ever match it.`, blocking: true });
      });
      ((step.keywords as { match?: string }[] | undefined) ?? []).forEach((k, n) => {
        if (!(k.match ?? '').trim()) problems.push({ where: `step ${i + 1}`, problem: `Typed word ${n + 1} is empty.`, blocking: true });
      });
    }
  });

  // Waits and a day-counted code expiry that count Sundays differently end on different
  // days, and the reminder that says "expires tomorrow" is then a day out.
  const waitsSkip = steps.filter((st) => st.kind === 'WAIT' && st.anchor === 'TRIGGER').map((st) => !!st.skipSundays);
  const expirySkip = steps.map((st) => (st as { issueOffer?: { expiry?: { anchor?: string; skipSundays?: boolean } } }).issueOffer?.expiry)
    .filter((e) => e?.anchor === 'TRIGGER').map((e) => !!e!.skipSundays);
  if (new Set([...waitsSkip, ...expirySkip]).size > 1) {
    problems.push({
      where: 'Sundays',
      problem: 'Some days in this journey skip Sundays and some do not, so a message can land a day away from when the code really ends. Tick "Don\'t count Sundays" on every wait and on the code\'s expiry, or on none.',
      blocking: false,
    });
  }

  // A journey whose last step is not terminal simply stops after it, which is fine —
  // but a journey that can never reach an end is worth pointing at.
  const last = steps[steps.length - 1];
  if (last && last.kind === 'WAIT') {
    problems.push({
      where: `step ${steps.length}`,
      problem: 'The journey ends on a wait, so nothing happens after it. Add what should follow, or a stop.',
      blocking: false,
    });
  }

  // A condition missing its test reads "" and never matches — silently false forever.
  const conditions: [string, Condition | undefined][] = [
    ['Who qualifies', def.audience],
    ['When it stops', def.goal?.condition],
    ...steps.map((s, i): [string, Condition | undefined] =>
      [`step ${i + 1}`, s.kind === 'CHECK' ? (s as { condition?: Condition }).condition : undefined]),
  ];
  for (const [where, c] of conditions) {
    if (c) for (const problem of missingArgs(c)) problems.push({ where, problem, blocking: true });
  }

  return problems;
}
