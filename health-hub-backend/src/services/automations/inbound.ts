/**
 * What an inbound WhatsApp message does to the automation layer.
 *
 * THE BUG THIS REPLACES: webhooks.ts derives the patient from the newest MessageLog for
 * that phone. Your own PatientIdentifier comment says families share a number, so a
 * mother replying to her own recall is attributed to whichever child was messaged most
 * recently — wrong name in the reply, wrong patient on the coupon, wrong row in the
 * attribution. AwaitingReply pins the patient when the QUESTION was asked, which is the
 * only moment we actually know who we were talking to.
 *
 * STOP ships before anything that sells. It is one database write on a path that already
 * exists, and it is the only keyword that is legally load-bearing.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { Outcome, type AutomationDefinition } from './types';
import { phoneKey } from './phone';

const STOP_WORDS = /^\s*(stop|unsubscribe|opt\s*out)\b/i;
const START_WORDS = /^\s*(start|resume|subscribe)\b/i;

/** 'STOP' is a destination too — "Not now" ends the journey rather than jumping. */
type Destination = number | 'STOP';

interface MatchSpec {
  buttons?: Record<string, Destination>;
  keywords?: { match: string; stepIndex: Destination }[];
  onUnmatched?: 'HANDOFF' | 'STOP' | 'CONTINUE';
}

/**
 * Which button this reply is, by what it SAYS as well as by its payload.
 *
 * A quick-reply on a template carries whatever payload the send set, and the send sets
 * none — so WhatsApp reports the button's own text ("Get my code") as the payload. The
 * line is held under the step's payload ("GET_CODE"), so a real tap matched nothing and
 * was handed to a person as a reply nobody understood. A patient who TYPES the button's
 * words has said the same thing, and is read the same way.
 */

/**
 * A reply that STARTS with the word, as a whole word: "code please" matches "code",
 * "codeine" does not. The word is escaped — typed by staff in the builder, "c++" was a
 * regex that threw — and the word boundary is Unicode-aware: `\b` treats Telugu letters
 * as non-word characters, so a Telugu keyword could never match.
 */
export function keywordMatches(word: string, body: string): boolean {
  const w = word.trim();
  if (!w) return false;
  const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*${escaped}(?![\\p{L}\\p{N}\\p{M}])`, 'iu').test(body);
}

export function matchButton<T extends { payload: string; label: string }>(
  buttons: T[], buttonPayload: string | null, body: string,
): T | null {
  const said = [buttonPayload, body]
    .filter((x): x is string => !!x)
    .map((x) => x.trim().toLowerCase());
  return buttons.find((b) =>
    said.includes(b.payload.trim().toLowerCase()) || said.includes(b.label.trim().toLowerCase()),
  ) ?? null;
}

export interface InboundResolution {
  /** Set when the reply landed on an automation that was waiting for it. */
  runId: string | null;
  /** The patient the question was actually addressed to — never guessed from a phone. */
  patientId: string | null;
  /** The step a matched button or keyword routes to. */
  stepIndex: number | null;
  /** The answer ended the journey rather than moving it on. */
  stopped: boolean;
  /** Nothing matched, and the question said to give the thread to a person. */
  handedOff: boolean;
  /**
   * The reply was one of the question's own answers — a button, or a word standing in for
   * one — so the journey answers it and the inbox never needs to see it. Also true for
   * the second of two quick taps, which loses the claim below to the first.
   */
  answered: boolean;
  optedOut: boolean;
  optedIn: boolean;
}

/**
 * Correlate on the BUTTON PAYLOAD, not the display text. The payload is the one field we
 * control and the only exact key WhatsApp offers — a quoted-reply context id only arrives
 * when the patient uses the swipe gesture, and most people just type.
 */
export async function resolveInbound(
  from: string,
  body: string,
  buttonPayload: string | null,
  now: Date = new Date(),
): Promise<InboundResolution> {
  // WhatsApp says `919876543210`; the line was held under `9876543210`. See phone.ts.
  const phone = phoneKey(from);
  const result: InboundResolution = {
    runId: null, patientId: null, stepIndex: null,
    stopped: false, handedOff: false, optedOut: false, optedIn: false, answered: false,
  };

  // STOP wins over everything, including an automation holding the line.
  if (STOP_WORDS.test(body)) {
    const slot = await prisma.awaitingReply.findUnique({
      where: { phone },
      select: { automationRunId: true },
    });

    // Scope. GLOBAL is the default and what a person means by "stop" — it silences
    // every journey on this number. A journey may declare THIS_JOURNEY where the
    // messages are operational rather than marketing, and then a stop ends only that
    // one. Whichever it is, the run that asked the question ends here.
    let scope: 'GLOBAL' | 'THIS_JOURNEY' = 'GLOBAL';
    if (slot) {
      const run = await prisma.automationRun.findUnique({
        where: { id: slot.automationRunId },
        select: { definition: true },
      });
      const declared = (run?.definition as { policy?: { stopScope?: string } } | null)?.policy?.stopScope;
      if (declared === 'THIS_JOURNEY') scope = 'THIS_JOURNEY';
    }

    if (scope === 'GLOBAL') {
      await prisma.phoneOptOut.upsert({
        where: { phone },
        create: { phone, source: 'INBOUND_STOP' },
        update: { optedOutAt: now, source: 'INBOUND_STOP' },
      });
    }

    if (slot) {
      await prisma.automationRun.updateMany({
        where: { id: slot.automationRunId, state: { in: ['PENDING', 'RUNNING'] } },
        data: {
          state: 'STOPPED',
          stopReason: scope === 'GLOBAL' ? 'PHONE_OPTED_OUT' : 'STOPPED_BY_PATIENT',
          nextActionAt: null,
        },
      });
    }
    await prisma.awaitingReply.deleteMany({ where: { phone } });
    result.optedOut = scope === 'GLOBAL';
    result.stopped = true;
    logger.info(`[automations] ${phone} said stop — scope ${scope}`);
    return result;
  }

  if (START_WORDS.test(body)) {
    await prisma.phoneOptOut.deleteMany({ where: { phone } });
    result.optedIn = true;
    return result;
  }

  const slot = await prisma.awaitingReply.findUnique({ where: { phone } });
  if (!slot) return result;

  // An expired slot resumes nothing. A thirty-day-old campaign waking up because someone
  // finally replied is worse than no automation at all.
  if (slot.expiresAt <= now) {
    await prisma.awaitingReply.delete({ where: { phone } }).catch(() => {});
    return result;
  }

  result.runId = slot.automationRunId;
  result.patientId = slot.patientId;

  const spec = (slot.match ?? {}) as MatchSpec;
  let destination: Destination | null = null;

  if (buttonPayload && spec.buttons && spec.buttons[buttonPayload] !== undefined) {
    destination = spec.buttons[buttonPayload];
  } else if (spec.keywords) {
    const hit = spec.keywords.find((k) => keywordMatches(k.match, body));
    if (hit) destination = hit.stepIndex;
  }
  // The payload a template button actually arrives with is its text. Read the question
  // the run is on and match the reply against its buttons by label too.
  if (destination === null) {
    const on = await prisma.automationRun.findUnique({
      where: { id: slot.automationRunId },
      select: { stepIndex: true, definition: true },
    });
    const q = (on?.definition as unknown as AutomationDefinition | null)?.steps[on!.stepIndex];
    if (q?.kind === 'ASK') {
      const b = matchButton(q.buttons, buttonPayload, body);
      if (b) destination = b.goTo;
    }
  }

  result.answered = destination !== null;

  // Claim before acting, the same way the day-sheet ticker claims a night: two rapid
  // replies must not drive the journey forward twice.
  const claimed = await prisma.awaitingReply.deleteMany({
    where: { phone, automationRunId: slot.automationRunId },
  });
  if (claimed.count !== 1) return result;

  // Write the answer down. The jump below moves the run and leaves no trace of why, so
  // "how many tapped Get my code" had no row to be counted from. The label is the one
  // the question's own step defines; a typed keyword is filed under the button it
  // stands in for, and anything unmatched under null.
  const asking = await prisma.automationRun.findUnique({
    where: { id: slot.automationRunId },
    select: { stepIndex: true, definition: true },
  });
  const steps = (asking?.definition as unknown as AutomationDefinition | null)?.steps;
  const step = steps?.[asking!.stepIndex];
  // An answer that hands the thread to a person must reach the inbox — that is where the
  // person is, and a first tap is what opens the thread there.
  if (typeof destination === 'number' && steps?.[destination]?.kind === 'HANDOFF') result.answered = false;
  if (step?.kind === 'ASK') {
    const answer = destination === null ? null
      : step.buttons.find((b) => b.payload === buttonPayload)?.label
        ?? step.buttons.find((b) => b.goTo === destination)?.label
        ?? String(destination);
    // The line is already released, so a failed write must not also lose the tap.
    await prisma.automationStepLog.create({
      data: { runId: slot.automationRunId, stepIndex: asking!.stepIndex, kind: 'ASK', outcome: Outcome.REPLIED, detail: { answer }, at: now },
    }).catch((e) => logger.warn(`[automations] reply not recorded for ${slot.automationRunId}: ${e.message}`));
  }

  const live = { id: slot.automationRunId, state: { in: ['PENDING', 'RUNNING'] } };

  if (destination === 'STOP') {
    await prisma.automationRun.updateMany({
      where: live, data: { state: 'STOPPED', stopReason: 'REPLIED', nextActionAt: null },
    });
    result.stopped = true;
    return result;
  }

  if (typeof destination === 'number') {
    await prisma.automationRun.updateMany({
      where: live, data: { stepIndex: destination, state: 'PENDING', nextActionAt: now },
    });
    result.stepIndex = destination;
    return result;
  }

  // Nothing matched. Free text that matches nothing is not a failure — it is the handoff,
  // and a person reads it better than a classifier would. Defaulting to HANDOFF is
  // deliberate: the safe answer to "we did not understand" is a human, not silence.
  if (spec.onUnmatched === 'STOP') {
    await prisma.automationRun.updateMany({
      where: live, data: { state: 'STOPPED', stopReason: 'REPLIED', nextActionAt: null },
    });
    result.stopped = true;
    return result;
  }
  if (spec.onUnmatched === 'CONTINUE') {
    await prisma.automationRun.updateMany({
      where: live, data: { state: 'PENDING', nextActionAt: now },
    });
    return result;
  }
  await prisma.automationRun.updateMany({
    where: live, data: { state: 'STOPPED', stopReason: 'HANDED_TO_STAFF', nextActionAt: null },
  });
  result.handedOff = true;
  return result;
}

/**
 * Hold the phone line while a question is outstanding.
 *
 * The single-column primary key IS the feature: one automation may hold one number, and
 * a second wanting it is refused by the database rather than by a convention.
 */
/** A run that has ended gives its line back, whatever ended it. */
export async function releaseLine(runId: string): Promise<void> {
  await prisma.awaitingReply.deleteMany({ where: { automationRunId: runId } });
}

/** Every line still held by a run that is no longer waiting — after a bulk stop. */
export async function releaseLinesOfEndedRuns(): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "AwaitingReply" a WHERE NOT EXISTS (
      SELECT 1 FROM "AutomationRun" r WHERE r."id" = a."automationRunId" AND r."state" IN ('PENDING', 'RUNNING'))`;
}

export async function holdLine(
  phone: string,
  runId: string,
  patientId: string,
  match: MatchSpec,
  hours = 24,
  /** The engine's clock — the window is measured on the same clock that closes it. */
  now: Date = new Date(),
): Promise<boolean> {
  // A slot whose window has closed holds nothing. Its run stopped without coming back
  // to release it — the patient came in while it waited, or staff stopped it — and the
  // row, left in place, refused every later question to this number as "line busy".
  await prisma.awaitingReply.deleteMany({ where: { phone: phoneKey(phone), expiresAt: { lte: now } } });
  try {
    await prisma.awaitingReply.create({
      data: {
        phone: phoneKey(phone), automationRunId: runId, patientId,
        expiresAt: new Date(now.getTime() + hours * 60 * 60 * 1000),
        match: match as object,
      },
    });
    return true;
  } catch {
    // The primary key refused it: another automation already holds this line. That is
    // the feature, not an error.
    return false;
  }
}
