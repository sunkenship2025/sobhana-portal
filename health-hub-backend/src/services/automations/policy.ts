/**
 * One gate every send passes through, wherever it came from.
 *
 * THREE OUTCOMES, NOT TWO. A suppressed message used to simply vanish; DEFER is what
 * lets quiet hours and the frequency cap hold a message rather than lose it, and it is
 * what makes "waiting its turn" a true statement on the Activity screen.
 *
 * The order below is TOTAL and deterministic. "The more important one goes first" is
 * ambiguous the moment three journeys compete, and two runs must never both win.
 */
import type { AutomationContext } from './context';
import { Outcome, type Intent, type OutcomeCode } from './types';

export type PolicyDecision =
  | { kind: 'SEND' }
  | { kind: 'DEFER'; until: Date; reason: OutcomeCode }
  | { kind: 'DROP'; reason: OutcomeCode };

export interface PolicyInput {
  patientId: string | null;
  phone: string | null;
  intent: Intent;
  runId: string;
  /** Set when the message belongs to a visit whose online access was killed. */
  visitId?: string | null;
  /** This automation's importance, 1-5. Only consulted for proactive messages. */
  priority?: number;
}

/** IST is UTC+5:30 with no DST, so a fixed offset is exact — no tz library. */
const IST_OFFSET_MIN = 330;
const QUIET_START_MIN = 8 * 60;  // 08:00 IST
const QUIET_END_MIN = 21 * 60;   // 21:00 IST
const FREQUENCY_CAP_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function istMinutes(now: Date): number {
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
}

/** The next 08:00 IST at or after `now`. */
function nextQuietWindowOpen(now: Date): Date {
  const mins = istMinutes(now);
  const ist = new Date(now.getTime() + IST_OFFSET_MIN * 60_000);
  const dayStart = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  const addDays = mins >= QUIET_END_MIN ? 1 : 0;
  const openIst = dayStart + addDays * DAY_MS + QUIET_START_MIN * 60_000;
  return new Date(openIst - IST_OFFSET_MIN * 60_000);
}

export async function communicationPolicy(
  ctx: AutomationContext,
  input: PolicyInput,
): Promise<PolicyDecision> {
  const drop = (reason: OutcomeCode): PolicyDecision => ({ kind: 'DROP', reason });

  // 1 — hard safety. A screening offer to someone who has died is the worst single
  // failure this system can produce, and it outranks every other consideration.
  if (input.patientId) {
    const p = await ctx.patient(input.patientId);
    if (p?.deceasedAt) return drop(Outcome.DECEASED);
  }

  // 2 — a number to send to.
  if (!input.phone) return drop(Outcome.NO_PHONE);

  // 3 — opt-out, per NUMBER. The person who typed STOP owns the handset; a relative
  // sharing it does not get to override them.
  if (await ctx.phoneOptedOut(input.phone)) return drop(Outcome.PHONE_OPTED_OUT);

  // 4 — consent, per PATIENT, and only for what we initiated. Reports and bills are
  // answers to something the patient did and are not gated here.
  if (input.intent === 'PROACTIVE' && input.patientId) {
    const p = await ctx.patient(input.patientId);
    if (!p?.marketingOptIn) return drop(Outcome.NOT_OPTED_IN_MARKETING);
  }

  // 5 — this visit's online access was switched off; report and bill sends already
  // honour it, and an automation must not be the one door left open.
  if (input.visitId) {
    const v = await ctx.visit(input.visitId);
    if (v?.patientLinkDisabledAt) return drop(Outcome.LINK_DISABLED);
  }

  // 6 — a person is mid-conversation. Marketing waits; a finalized report does not.
  if (input.intent === 'PROACTIVE' && (await ctx.threadHeldByHuman(input.phone))) {
    return drop(Outcome.HUMAN_HOLDS_THREAD);
  }

  // 7 — another run is holding this line for a reply.
  if (await ctx.lineHeldByAnotherRun(input.phone, input.runId)) {
    return drop(Outcome.LINE_HELD_BY_ANOTHER_RUN);
  }

  // Reactive messages stop here: never capped, never deferred. Five in a day is five
  // things that actually happened.
  if (input.intent === 'REACTIVE') return { kind: 'SEND' };

  // 8 — frequency cap, across every automation. DEFER, never DROP: the message is
  // still wanted, just not today.
  if (input.patientId) {
    const last = await ctx.lastProactiveMessageAt(input.patientId);
    if (last) {
      const eligibleAt = new Date(last.getTime() + FREQUENCY_CAP_DAYS * DAY_MS);
      if (eligibleAt > ctx.now) {
        return { kind: 'DEFER', until: eligibleAt, reason: Outcome.FREQUENCY_CAP };
      }
    }
  }

  // 9 — a more important journey is due for this patient in the same tick. Defer by a
  // tick rather than dropping: this message is still wanted, just not first.
  if (input.patientId && input.priority !== undefined) {
    const rival = await ctx.higherPriorityRunDue(input.patientId, input.priority, input.runId);
    if (rival) {
      return {
        kind: 'DEFER',
        until: new Date(ctx.now.getTime() + 10 * 60_000),
        reason: Outcome.WAITING_ANOTHER_AUTOMATION,
      };
    }
  }

  // 10 — quiet hours.
  const mins = istMinutes(ctx.now);
  if (mins < QUIET_START_MIN || mins >= QUIET_END_MIN) {
    return { kind: 'DEFER', until: nextQuietWindowOpen(ctx.now), reason: Outcome.QUIET_HOURS };
  }

  return { kind: 'SEND' };
}

export const _internals = { istMinutes, nextQuietWindowOpen, QUIET_START_MIN, QUIET_END_MIN, FREQUENCY_CAP_DAYS };
