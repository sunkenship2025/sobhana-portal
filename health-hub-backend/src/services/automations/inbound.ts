/**
 * What an inbound WhatsApp message does to the automation layer.
 *
 * THE BUG THIS REPLACES: webhooks.ts derives the patient from the newest MessageLog
 * for that phone. Your own PatientIdentifier comment says families share a number, so
 * a mother replying to her own recall is attributed to whichever child was messaged
 * most recently — wrong name in the reply, wrong patient on the coupon, wrong row in
 * the attribution. AwaitingReply pins the patient when the QUESTION was asked, which
 * is the only moment we actually know who we were talking to.
 *
 * STOP ships before anything that sells. It is one database write on a path that
 * already exists, and it is the only keyword that is legally load-bearing.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

const STOP_WORDS = /^\s*(stop|unsubscribe|opt\s*out)\b/i;
const START_WORDS = /^\s*(start|resume|subscribe)\b/i;

export interface InboundResolution {
  /** Set when the reply landed on an automation that was waiting for it. */
  runId: string | null;
  /** The patient the question was actually addressed to — never guessed from a phone. */
  patientId: string | null;
  /** The step the matched button or keyword routes to. */
  stepIndex: number | null;
  optedOut: boolean;
  optedIn: boolean;
}

interface MatchSpec {
  buttons?: Record<string, number>;
  keywords?: { match: string; stepIndex: number }[];
}

/**
 * Correlate on the BUTTON PAYLOAD, not the display text. The payload is the one field
 * we control and the only exact key WhatsApp offers — a quoted-reply context id only
 * arrives when the patient uses the swipe gesture, and most people just type.
 */
export async function resolveInbound(
  phone: string,
  body: string,
  buttonPayload: string | null,
  now: Date = new Date(),
): Promise<InboundResolution> {
  const result: InboundResolution = {
    runId: null, patientId: null, stepIndex: null, optedOut: false, optedIn: false,
  };

  // STOP wins over everything, including an automation holding the line.
  if (STOP_WORDS.test(body)) {
    await prisma.phoneOptOut.upsert({
      where: { phone },
      create: { phone, source: 'INBOUND_STOP' },
      update: { optedOutAt: now, source: 'INBOUND_STOP' },
    });
    // End whatever was mid-conversation with this number: a journey that keeps its
    // place after an opt-out is a journey waiting to break the opt-out.
    await prisma.automationRun.updateMany({
      where: { state: { in: ['PENDING', 'RUNNING'] }, id: { in: await runIdsHolding(phone) } },
      data: { state: 'STOPPED', stopReason: 'PHONE_OPTED_OUT', nextActionAt: null },
    });
    await prisma.awaitingReply.deleteMany({ where: { phone } });
    result.optedOut = true;
    logger.info(`[automations] ${phone} opted out of marketing`);
    return result;
  }

  if (START_WORDS.test(body)) {
    await prisma.phoneOptOut.deleteMany({ where: { phone } });
    result.optedIn = true;
    return result;
  }

  const slot = await prisma.awaitingReply.findUnique({ where: { phone } });
  if (!slot) return result;

  // An expired slot resumes nothing. A thirty-day-old campaign waking up because
  // someone finally replied is worse than no automation at all.
  if (slot.expiresAt <= now) {
    await prisma.awaitingReply.delete({ where: { phone } }).catch(() => {});
    return result;
  }

  result.runId = slot.automationRunId;
  result.patientId = slot.patientId;

  const spec = (slot.match ?? {}) as MatchSpec;
  if (buttonPayload && spec.buttons && spec.buttons[buttonPayload] !== undefined) {
    result.stepIndex = spec.buttons[buttonPayload];
  } else if (spec.keywords) {
    const hit = spec.keywords.find((k) => new RegExp(`^\\s*${k.match}\\b`, 'i').test(body));
    if (hit) result.stepIndex = hit.stepIndex;
  }

  if (result.stepIndex !== null) {
    // Claim before acting, the same way the day-sheet ticker claims a run: two rapid
    // replies must not drive the journey forward twice.
    const claimed = await prisma.awaitingReply.deleteMany({ where: { phone, automationRunId: slot.automationRunId } });
    if (claimed.count !== 1) {
      result.stepIndex = null;
      return result;
    }
    await prisma.automationRun.updateMany({
      where: { id: slot.automationRunId, state: { in: ['PENDING', 'RUNNING'] } },
      data: { stepIndex: result.stepIndex, state: 'PENDING', nextActionAt: now },
    });
  }
  return result;
}

async function runIdsHolding(phone: string): Promise<string[]> {
  const slot = await prisma.awaitingReply.findUnique({
    where: { phone },
    select: { automationRunId: true },
  });
  return slot ? [slot.automationRunId] : [];
}

/** Called by the engine when an ASK step sends its question. */
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
