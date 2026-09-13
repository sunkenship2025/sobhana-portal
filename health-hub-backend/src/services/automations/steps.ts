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
export function validateDefinition(def: {
  trigger?: { kind?: string };
  steps?: { kind?: string; [k: string]: unknown }[];
  goal?: { windowDays?: number };
}): DefinitionProblem[] {
  const problems: DefinitionProblem[] = [];
  const steps = def.steps ?? [];
  const known = new Set(STEP_CATALOG.map((s) => s.kind));

  if (steps.length === 0) {
    problems.push({ where: 'steps', problem: 'This journey has no steps, so it would do nothing.', blocking: true });
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
    }
  });

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

  return problems;
}
