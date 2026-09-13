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

const STOP_WORDS = /^\s*(stop|unsubscribe|opt\s*out)\b/i;
const START_WORDS = /^\s*(start|resume|subscribe)\b/i;

/** 'STOP' is a destination too — "Not now" ends the journey rather than jumping. */
type Destination = number | 'STOP';

interface MatchSpec {
  buttons?: Record<string, Destination>;
  keywords?: { match: string; stepIndex: Destination }[];
  onUnmatched?: 'HANDOFF' | 'STOP' | 'CONTINUE';
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
  optedOut: boolean;
  optedIn: boolean;
}

/**
 * Correlate on the BUTTON PAYLOAD, not the display text. The payload is the one field we
 * control and the only exact key WhatsApp offers — a quoted-reply context id only arrives
 * when the patient uses the swipe gesture, and most people just type.
 */
export async function resolveInbound(
  phone: string,
  body: string,
  buttonPayload: string | null,
  now: Date = new Date(),
): Promise<InboundResolution> {
  const result: InboundResolution = {
    runId: null, patientId: null, stepIndex: null,
    stopped: false, handedOff: false, optedOut: false, optedIn: false,
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
    const hit = spec.keywords.find((k) => new RegExp(`^\\s*${k.match}\\b`, 'i').test(body));
    if (hit) destination = hit.stepIndex;
  }

  // Claim before acting, the same way the day-sheet ticker claims a night: two rapid
  // replies must not drive the journey forward twice.
  const claimed = await prisma.awaitingReply.deleteMany({
    where: { phone, automationRunId: slot.automationRunId },
  });
  if (claimed.count !== 1) return result;

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
export async function holdLine(
  phone: string,
  runId: string,
  patientId: string,
  match: MatchSpec,
  hours = 24,
): Promise<boolean> {
  try {
    await prisma.awaitingReply.create({
      data: {
        phone, automationRunId: runId, patientId,
        expiresAt: new Date(Date.now() + hours * 60 * 60 * 1000),
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
