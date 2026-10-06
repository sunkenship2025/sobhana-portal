/**
 * The side effects, each executed AT MOST ONCE per (run, step).
 *
 * The ticker can execute a step twice — a crash between the provider call and the
 * state write, a slow tick, a second instance. Every effect here is therefore keyed
 * on (automationRunId, automationStep) with a PARTIAL UNIQUE INDEX behind it, so a
 * replay finds the existing row instead of sending a second message or minting a
 * second code against the same budget.
 *
 * ORDER MATTERS: the coupon is minted PENDING before the send (its code goes in the
 * message body, so it must exist), and only promoted to ISSUED once the send
 * succeeds. A failed send leaves no live code and releases the budget it reserved.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import {
  sendTemplate,
  sendText,
  sendButtons,
  formatPhoneForWhatsApp,
  listMessageTemplates,
  isWhatsAppEnabled,
  type TemplateComponent,
} from '../whatsappCloudService';
import { randomBytes, createHash } from 'crypto';
import { allowedProductsFor } from '../couponService';
import { Outcome, startsWhenReceived, type AutomationDefinition } from './types';

export interface SendInput {
  runId: string;
  stepIndex: number;
  patientId: string | null;
  branchId: string | null;
  phone: string;
  /** Every resolved recipient. A staff alert has several; a patient has one. */
  phones?: string[];
  template: string;
  language: string;
  /** Every blank, already filled — see fields.ts. Never a partial message. */
  values: string[];
  contextId: string;
  /**
   * The patient has just messaged us, so the 24h window is open: send the template's
   * words as an ordinary chat message (with these reply buttons, for a question) — not a
   * template, so Meta's per-person marketing limit does not apply.
   */
  inChat?: { buttons?: { id: string; title: string }[] };
}

export interface SendOutcome {
  messageLogId: string;
  waMessageId: string | null;
  alreadySent: boolean;
  failed?: string;
}

/**
 * Meta edits templates in place and exposes no version id, so the body is snapshotted
 * on the log at send time. Without it, every message sent before a template edit
 * becomes unreconstructable — retroactively, and for good.
 */
export async function sendForStep(input: SendInput): Promise<SendOutcome> {
  const existing = await prisma.messageLog.findFirst({
    where: { automationRunId: input.runId, automationStep: input.stepIndex },
    select: { id: true, waMessageId: true, status: true },
  });
  // A FAILED row is a message the patient never got, so the run being back on this step —
  // a transient error's backoff, or the resend after Meta's marketing limit — sends it
  // again on the same row. It used to answer "already sent", so neither retry ever sent.
  if (existing && existing.status !== 'FAILED') {
    return { messageLogId: existing.id, waMessageId: existing.waMessageId, alreadySent: true };
  }

  let category: string | null = null;
  let bodyText: string | null = null;
  let paramCount: number | null = null;
  try {
    const templates = await listMessageTemplates();
    const t = templates.find((x) => x.name === input.template);
    if (t) {
      category = t.category;
      bodyText = t.bodyText;
      paramCount = t.paramCount;
    }
  } catch (e) {
    // A template-list failure must not silently change what gets sent; it only costs
    // us the snapshot and the category, which are recorded as unknown.
    logger.warn(`[automations] template lookup failed for ${input.template}: ${(e as Error).message}`);
  }

  const values = input.values;
  if (paramCount !== null && paramCount !== values.length) {
    return {
      messageLogId: '',
      waMessageId: null,
      alreadySent: false,
      failed: `template ${input.template} expects ${paramCount} values, ${values.length} bound`,
    };
  }

  const components: TemplateComponent[] =
    values.length > 0
      ? [{ type: 'body', parameters: values.map((text) => ({ type: 'text' as const, text })) }]
      : [];

  // Claim BEFORE the provider call. A crash between the two leaves a PENDING row that
  // the partial unique index blocks from being sent again — the wrong way to fail, but
  // the safe one.
  const row = {
    patientId: input.patientId,
    phone: input.phone,
    channel: 'WHATSAPP' as const,
    templateName: input.template,
    templateParams: values as unknown as object,
    status: 'PENDING' as const,
    contextType: 'CAMPAIGN' as const,
    contextId: input.contextId,
    branchId: input.branchId,
    automationRunId: input.runId,
    automationStep: input.stepIndex,
    templateCategory: category,
    templateBody: bodyText,
  };
  const log = existing
    ? await prisma.messageLog.update({
      where: { id: existing.id },
      data: { ...row, waMessageId: null, errorCode: null, failureReason: null, sentAt: null, deliveredAt: null, readAt: null },
      select: { id: true },
    })
    : await prisma.messageLog.create({ data: row, select: { id: true } });

  if (!isWhatsAppEnabled()) {
    await prisma.messageLog.update({
      where: { id: log.id },
      data: { status: 'FAILED', failureReason: 'WHATSAPP_DISABLED' },
    });
    return { messageLogId: log.id, waMessageId: null, alreadySent: false, failed: 'WHATSAPP_DISABLED' };
  }

  const targets = input.phones && input.phones.length > 0 ? input.phones : [input.phone];
  // The words exactly as the approved template reads them, blanks filled.
  const words = bodyText?.replace(/\{\{(\d+)\}\}/g, (_, n: string) => values[Number(n) - 1] ?? '') ?? null;
  try {
    if (input.inChat && !words) throw new Error(`template ${input.template} has no text to send in the chat`);
    let first: string | null = null;
    const failures: string[] = [];
    for (const target of targets) {
      try {
        const to = formatPhoneForWhatsApp(target);
        const r = input.inChat
          ? input.inChat.buttons?.length
            ? await sendButtons(to, words!, input.inChat.buttons)
            : await sendText(to, words!)
          : await sendTemplate(to, input.template, components, input.language);
        if (!first) first = r.waMessageId;
      } catch (e) {
        // One unreachable number must not cost the others their message.
        failures.push((e as Error).message);
      }
    }
    if (!first) throw new Error(failures[0] ?? 'every recipient failed');

    await prisma.messageLog.update({
      where: { id: log.id },
      data: {
        status: 'SENT', sentAt: new Date(), waMessageId: first,
        ...(failures.length
          ? { failureReason: `${failures.length} of ${targets.length} recipients failed` }
          : {}),
      },
    });
    return { messageLogId: log.id, waMessageId: first, alreadySent: false };
  } catch (e) {
    const err = e as Error & { errorCode?: string };
    await prisma.messageLog.update({
      where: { id: log.id },
      data: { status: 'FAILED', failureReason: err.message?.slice(0, 500), errorCode: err.errorCode ?? null },
    });
    return { messageLogId: log.id, waMessageId: null, alreadySent: false, failed: err.message };
  }
}

// ────────────────────────────────────────────────────────────────────────────

export interface CouponOutcome {
  couponId: string;
  code: string;
  alreadyIssued: boolean;
  refused?: 'OFFER_EXHAUSTED' | 'CAMPAIGN_INACTIVE' | 'NO_MATCHING_TESTS';
}

function mintCode(prefix: string): string {
  const raw = randomBytes(3).toString('hex').toUpperCase();
  return `${prefix}-${raw}`;
}

/**
 * Mint a coupon for this step, reserving budget atomically.
 *
 * The reservation is a CONDITIONAL UPDATE, not a read-then-write: two bills arriving
 * together must not both pass the last-rupee check. And budget counts RESERVED plus
 * COMMITTED — counting only redemptions lets a campaign issue three times its budget
 * and discover it when redemption catches up.
 */
/** IST is UTC+5:30 with no DST, so a fixed offset is exact. */
const IST_OFFSET_MIN = 330;
const DAY_MS = 24 * 60 * 60 * 1000;

export const isSundayIST = (d: Date) => new Date(d.getTime() + IST_OFFSET_MIN * 60_000).getUTCDay() === 0;

/**
 * `days` whole days on from `from`. With skipSundays only the days the centre is open
 * count — two days after a Friday is Monday — so a wait and the code it sends end on the
 * same day, and "expires tomorrow" in the reminder stays true.
 */
export function addDays(from: Date, days: number, skipSundays = false): Date {
  let at = from;
  for (let i = 0; i < days; i += 1) {
    at = new Date(at.getTime() + DAY_MS);
    while (skipSundays && isSundayIST(at)) at = new Date(at.getTime() + DAY_MS);
  }
  return at;
}

/**
 * When a coupon dies.
 *
 * Anchored to the TRIGGER by default: claiming on day five gives you one day, not six.
 * An offer whose clock restarts every time somebody taps it is not an expiring offer,
 * and "expires tomorrow" in the reminder has to still be true tomorrow.
 *
 * `endOfDayIST` gives the patient the WHOLE of the last day — 11:59 PM, not whatever
 * o'clock their consultation happened to finish.
 */
export function couponExpiry(
  opts: { anchor: 'TRIGGER' | 'ISSUE'; days: number; endOfDayIST?: boolean; skipSundays?: boolean } | undefined,
  triggeredAt: Date,
  now: Date,
  fallbackDays: number,
): Date {
  const days = opts?.days ?? fallbackDays;
  const from = opts?.anchor === 'ISSUE' ? now : triggeredAt;
  const raw = addDays(from, days, opts?.skipSundays);
  if (!opts?.endOfDayIST) return raw;

  const ist = new Date(raw.getTime() + IST_OFFSET_MIN * 60_000);
  const endOfDayIst = Date.UTC(
    ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 23, 59, 59, 999,
  );
  return new Date(endOfDayIst - IST_OFFSET_MIN * 60_000);
}

/**
 * Meta held back the message that carried this step's code, and this is another try: a
 * code that starts when they get it starts again now, so the "valid till" it goes out
 * with is a full one. A code someone has used, or one an earlier step handed out (so the
 * patient may already hold it), keeps its date.
 */
export async function restartHeldCode(runId: string, stepIndex: number, step: object, now: Date): Promise<void> {
  if (!startsWhenReceived(step)) return;
  const held = await prisma.automationStepLog.count({ where: { runId, stepIndex, outcome: Outcome.RETRY_SCHEDULED } });
  if (held === 0) return;
  const code = await prisma.coupon.findFirst({
    where: { automationRunId: runId, automationStep: stepIndex, status: { in: ['PENDING', 'ISSUED'] }, redemptions: { none: {} } },
    select: { id: true, campaign: { select: { validityDays: true } } },
  });
  if (!code) return;
  const expiry = (step as { issueOffer?: { expiry?: Parameters<typeof couponExpiry>[0] } }).issueOffer?.expiry;
  const expiresAt = expiry
    ? couponExpiry(expiry, now, now, code.campaign.validityDays)
    : new Date(now.getTime() + code.campaign.validityDays * DAY_MS);
  await prisma.coupon.update({ where: { id: code.id }, data: { expiresAt } });
}

/**
 * When a journey's window closes: the goal's days from the trigger, to the end of that
 * day in IST — and never while the journey's own code is still alive. A fixed "end of day
 * N after the trigger" that skips Sundays outlives plain days, and a code that starts when
 * they get it can run well past them. Sending, stopping on the goal and counting a
 * conversion all read this one end. Null without a goal: there is no window.
 */
export function windowEnds(
  triggeredAt: Date,
  def: Pick<AutomationDefinition, 'goal' | 'steps'>,
  now: Date,
  codeEndsAt: Date | null = null,
): Date | null {
  const days = def.goal?.windowDays;
  if (!days || days <= 0) return null;
  let end = couponExpiry({ anchor: 'TRIGGER', days, endOfDayIST: true }, triggeredAt, now, days);
  for (const st of def.steps ?? []) {
    const e = (st as { issueOffer?: { expiry?: Parameters<typeof couponExpiry>[0] } }).issueOffer?.expiry;
    if (e?.anchor === 'TRIGGER') {
      const offerEnds = couponExpiry(e, triggeredAt, now, e.days);
      if (offerEnds > end) end = offerEnds;
    }
  }
  if (codeEndsAt && codeEndsAt > end) end = codeEndsAt;
  return end;
}

export async function issueCouponForStep(
  campaignId: string,
  runId: string,
  stepIndex: number,
  patientId: string | null,
  phone: string | null,
  issuedVisitId: string | null,
  expiresAt?: Date,
): Promise<CouponOutcome | null> {
  // ONE per RUN, not one per step. A patient who can claim from either the first
  // message or the reminder must end up with a single code — two steps both wanting to
  // issue is the normal shape of this journey, not an edge case.
  const existing = await prisma.coupon.findFirst({
    where: { automationRunId: runId },
    orderBy: { createdAt: 'asc' },
    select: { id: true, code: true },
  });
  if (existing) return { couponId: existing.id, code: existing.code, alreadyIssued: true };

  const campaign = await prisma.couponCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !campaign.isActive) {
    return { couponId: '', code: '', alreadyIssued: false, refused: 'CAMPAIGN_INACTIVE' };
  }

  // Which tests it discounts, fixed now. Resolved before any budget is set aside, so a
  // refusal here leaves nothing reserved.
  const allowedProductIds = await allowedProductsFor(campaign, { patientId, visitId: issuedVisitId });
  if (allowedProductIds === null) {
    return { couponId: '', code: '', alreadyIssued: false, refused: 'NO_MATCHING_TESTS' };
  }

  // Worst-case exposure of one more code: the per-bill cap for EACH use it allows, set
  // aside now so a code in someone's hand is never refused at the counter for budget.
  // No cap means the exposure cannot be bounded, and the reservation is skipped rather
  // than guessed.
  const uses = Math.max(1, campaign.maxUsesPerCode);
  const perUse = campaign.maxDiscountPerBillInPaise ?? 0;
  const exposure = perUse * uses;
  const budget = campaign.maxDiscountBudgetInPaise;
  const reserving = budget !== null && exposure > 0;
  if (budget !== null && reserving) {
    const claimed = await prisma.couponCampaign.updateMany({
      where: {
        id: campaignId,
        reservedInPaise: { lte: budget - campaign.committedInPaise - exposure },
      },
      data: { reservedInPaise: { increment: exposure } },
    });
    if (claimed.count !== 1) {
      return { couponId: '', code: '', alreadyIssued: false, refused: 'OFFER_EXHAUSTED' };
    }
  }

  if (campaign.maxRedemptions !== null) {
    const live = await prisma.coupon.count({
      where: { campaignId, status: { in: ['PENDING', 'ISSUED', 'REDEEMED'] } },
    });
    if (live >= campaign.maxRedemptions) {
      return { couponId: '', code: '', alreadyIssued: false, refused: 'OFFER_EXHAUSTED' };
    }
  }

  const rawToken = randomBytes(32).toString('hex');
  const coupon = await prisma.coupon.create({
    data: {
      code: mintCode(campaign.code.slice(0, 4).toUpperCase()),
      token: createHash('sha256').update(rawToken).digest('hex'),
      campaignId,
      // PENDING, not ISSUED: the code exists so it can go in the body, but it is not
      // live until the message it travels in has actually left.
      status: 'PENDING',
      patientId,
      phone,
      issuedVisitId,
      expiresAt: expiresAt ?? new Date(Date.now() + campaign.validityDays * 24 * 60 * 60 * 1000),
      automationRunId: runId,
      automationStep: stepIndex,
      maxUses: uses,
      reservedPerUseInPaise: reserving ? perUse : 0,
      allowedProductIds,
    },
    select: { id: true, code: true },
  });
  return { couponId: coupon.id, code: coupon.code, alreadyIssued: false };
}

/** Promote after a successful send. */
export async function activateCoupon(couponId: string): Promise<void> {
  await prisma.coupon.updateMany({ where: { id: couponId, status: 'PENDING' }, data: { status: 'ISSUED' } });
}

/** Void after a failed send, and hand back everything that was set aside for it. */
export async function voidPendingCoupon(couponId: string): Promise<void> {
  const coupon = await prisma.coupon.findUnique({
    where: { id: couponId },
    select: { status: true, campaignId: true, maxUses: true, reservedPerUseInPaise: true },
  });
  if (!coupon || coupon.status !== 'PENDING') return;
  const voided = await prisma.coupon.updateMany({ where: { id: couponId, status: 'PENDING' }, data: { status: 'VOID' } });
  // What THIS code reserved, per use, times its uses — not the campaign's current cap,
  // which may have been edited since the code was issued.
  const held = coupon.reservedPerUseInPaise * coupon.maxUses;
  if (voided.count === 1 && held > 0) {
    await prisma.couponCampaign.update({
      where: { id: coupon.campaignId },
      data: { reservedInPaise: { decrement: held } },
    });
  }
}
