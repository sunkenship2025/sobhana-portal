/**
 * Adding, removing and moving a step — and repointing every branch that referred to it.
 *
 * THE WHOLE DIFFICULTY IS THE INDICES. A branch is a number: `onTrue: 7`, `goTo: 3`,
 * `onNoReply: 4`. Insert a step above them and every one of those numbers now names the
 * wrong step — silently, because the journey is still structurally valid and the engine
 * will happily run it. That is the failure mode this file exists to prevent: not a
 * crash, a journey that quietly does something else.
 *
 * Deleting is the case with no perfect answer. A branch pointing AT the deleted step is
 * repointed to CONTINUE rather than to whatever slid into its place — falling through is
 * always valid, whereas inheriting the position means a jump that used to mean "go issue
 * the code" can come to mean "go send the reminder" without anyone touching it.
 *
 * The backend refuses a dangling jump at save, so a mistake here surfaces as a blocked
 * save rather than a bad send. This is the belt; that is the braces.
 */
import type { Step, Jump } from './api';

/** Apply an index remapping to every branch target in a step. */
function remap(step: Step, move: (i: number) => Jump): Step {
  const j = (v: Jump | undefined): Jump | undefined =>
    typeof v === 'number' ? move(v) : v;

  if (step.kind === 'CHECK') {
    return { ...step, onTrue: j(step.onTrue) as Jump, onFalse: j(step.onFalse) };
  }
  if (step.kind === 'ASK') {
    return {
      ...step,
      buttons: step.buttons.map((b) => ({ ...b, goTo: (j(b.goTo) ?? 'STOP') as number | 'STOP' })),
      keywords: step.keywords?.map((k) => ({ ...k, goTo: (j(k.goTo) ?? 'STOP') as number | 'STOP' })),
      onNoReply: j(step.onNoReply),
    };
  }
  return step;
}

/** Insert `step` at `at`. Everything at or after `at` shifts down, and jumps follow it. */
export function insertStep(steps: Step[], at: number, step: Step): Step[] {
  const next = [...steps.slice(0, at), step, ...steps.slice(at)];
  return next.map((s, i) => (i === at ? s : remap(s, (t) => (t >= at ? t + 1 : t))));
}

/** Remove the step at `at`. Anything that pointed AT it falls through instead. */
export function deleteStep(steps: Step[], at: number): Step[] {
  return steps
    .filter((_, i) => i !== at)
    .map((s) => remap(s, (t) => (t === at ? 'CONTINUE' : t > at ? t - 1 : t)));
}

/** Move the step at `from` to `to`, carrying every reference to it along. */
export function moveStep(steps: Step[], from: number, to: number): Step[] {
  if (from === to || to < 0 || to >= steps.length) return steps;
  const moved = [...steps];
  const [taken] = moved.splice(from, 1);
  moved.splice(to, 0, taken);

  // Where each OLD index ended up.
  const where = new Map<number, number>();
  steps.forEach((_, old) => {
    if (old === from) { where.set(old, to); return; }
    const shifted = old < from ? old : old - 1;
    where.set(old, shifted >= to ? shifted + 1 : shifted);
  });

  return moved.map((s) => remap(s, (t) => where.get(t) ?? t));
}

/** A usable blank of each kind, so a new step is never invalid on arrival. */
export function blankStep(kind: string): Step {
  switch (kind) {
    case 'WAIT': return { kind: 'WAIT', anchor: 'TRIGGER', days: 1 };
    case 'CHECK': return { kind: 'CHECK', condition: { fn: 'testDoneSinceThisVisit' }, onTrue: 'STOP', onFalse: 'CONTINUE' };
    case 'SEND': return { kind: 'SEND', template: '', intent: 'PROACTIVE', params: [{ from: 'PATIENT_FIRST_NAME' }] };
    case 'ASK': return {
      kind: 'ASK', template: '', intent: 'PROACTIVE', params: [{ from: 'PATIENT_FIRST_NAME' }],
      buttons: [{ payload: 'YES', label: 'Yes', goTo: 'STOP' }],
      onUnmatched: 'HANDOFF',
    };
    case 'HANDOFF': return { kind: 'HANDOFF' };
    case 'DAY_SHEET': return { kind: 'DAY_SHEET', domain: 'DIAGNOSTICS' };
    default: return { kind: 'STOP', reason: 'STOPPED_BY_STEP' };
  }
}
