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
  formatPhoneForWhatsApp,
  listMessageTemplates,
  isWhatsAppEnabled,
  type TemplateComponent,
} from '../whatsappCloudService';
import { randomBytes, createHash } from 'crypto';
import type { ParamBinding } from './types';

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
  params: ParamBinding[];
  couponCode?: string | null;
  patientFirstName?: string | null;
  branchName?: string | null;
  contextId: string;
}

export interface SendOutcome {
  messageLogId: string;
  waMessageId: string | null;
  alreadySent: boolean;
  failed?: string;
}

function bind(b: ParamBinding, input: SendInput): string {
  switch (b.from) {
    case 'PATIENT_FIRST_NAME': return (input.patientFirstName ?? '').split(' ')[0] || 'there';
    case 'BRANCH_NAME': return input.branchName ?? '';
    case 'COUPON_CODE': return input.couponCode ?? '';
    case 'LITERAL': return b.value;
  }
}

/**
 * Meta edits templates in place and exposes no version id, so the body is snapshotted
 * on the log at send time. Without it, every message sent before a template edit
 * becomes unreconstructable — retroactively, and for good.
 */
export async function sendForStep(input: SendInput): Promise<SendOutcome> {
  const existing = await prisma.messageLog.findFirst({
    where: { automationRunId: input.runId, automationStep: input.stepIndex },
    select: { id: true, waMessageId: true },
  });
  if (existing) {
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

  const values = input.params.map((p) => bind(p, input));
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
  const log = await prisma.messageLog.create({
    data: {
      patientId: input.patientId,
      phone: input.phone,
      channel: 'WHATSAPP',
      templateName: input.template,
      templateParams: values as unknown as object,
      status: 'PENDING',
      contextType: 'CAMPAIGN',
      contextId: input.contextId,
      branchId: input.branchId,
      automationRunId: input.runId,
      automationStep: input.stepIndex,
      templateCategory: category,
      templateBody: bodyText,
    },
    select: { id: true },
  });

  if (!isWhatsAppEnabled()) {
    await prisma.messageLog.update({
      where: { id: log.id },
      data: { status: 'FAILED', failureReason: 'WHATSAPP_DISABLED' },
    });
    return { messageLogId: log.id, waMessageId: null, alreadySent: false, failed: 'WHATSAPP_DISABLED' };
  }

  const targets = input.phones && input.phones.length > 0 ? input.phones : [input.phone];
  try {
    let first: string | null = null;
    const failures: string[] = [];
    for (const target of targets) {
      try {
        const r = await sendTemplate(
          formatPhoneForWhatsApp(target), input.template, components, input.language,
        );
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
  refused?: 'OFFER_EXHAUSTED' | 'CAMPAIGN_INACTIVE';
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
export async function issueCouponForStep(
  campaignId: string,
  runId: string,
  stepIndex: number,
  patientId: string | null,
  phone: string | null,
  issuedVisitId: string | null,
): Promise<CouponOutcome | null> {
  const existing = await prisma.coupon.findFirst({
    where: { automationRunId: runId, automationStep: stepIndex },
    select: { id: true, code: true },
  });
  if (existing) return { couponId: existing.id, code: existing.code, alreadyIssued: true };

  const campaign = await prisma.couponCampaign.findUnique({ where: { id: campaignId } });
  if (!campaign || !campaign.isActive) {
    return { couponId: '', code: '', alreadyIssued: false, refused: 'CAMPAIGN_INACTIVE' };
  }

  // Worst-case exposure of one more coupon: the per-bill cap when set, otherwise we
  // cannot bound it and the reservation is skipped rather than guessed.
  const exposure = campaign.maxDiscountPerBillInPaise ?? 0;
  if (campaign.maxDiscountBudgetInPaise !== null && exposure > 0) {
    const claimed = await prisma.couponCampaign.updateMany({
      where: {
        id: campaignId,
        reservedInPaise: { lte: campaign.maxDiscountBudgetInPaise - campaign.committedInPaise - exposure },
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
      expiresAt: new Date(Date.now() + campaign.validityDays * 24 * 60 * 60 * 1000),
      automationRunId: runId,
      automationStep: stepIndex,
    },
    select: { id: true, code: true },
  });
  return { couponId: coupon.id, code: coupon.code, alreadyIssued: false };
}

/** Promote after a successful send. */
export async function activateCoupon(couponId: string): Promise<void> {
  await prisma.coupon.updateMany({ where: { id: couponId, status: 'PENDING' }, data: { status: 'ISSUED' } });
}

/** Void after a failed send, and hand the reserved budget back. */
export async function voidPendingCoupon(couponId: string): Promise<void> {
  const coupon = await prisma.coupon.findUnique({
    where: { id: couponId },
    select: { status: true, campaign: { select: { id: true, maxDiscountPerBillInPaise: true } } },
  });
  if (!coupon || coupon.status !== 'PENDING') return;
  await prisma.coupon.updateMany({ where: { id: couponId, status: 'PENDING' }, data: { status: 'VOID' } });
  const exposure = coupon.campaign.maxDiscountPerBillInPaise ?? 0;
  if (exposure > 0) {
    await prisma.couponCampaign.update({
      where: { id: coupon.campaign.id },
      data: { reservedInPaise: { decrement: exposure } },
    });
  }
}
