/**
 * The engine. One tick does three things: enrol what is newly eligible, advance what
 * is due, and re-check what it previously called converted.
 *
 * WHY A SWEEP AND NOT AN EVENT BUS: this codebase has no event infrastructure at all —
 * visit completion, finalization and payment are side effects inside route handlers.
 * Adding a bus means a second write on every one of those, on a 512MB box with an OOM
 * history. Because enrolment is idempotent on (automationId, subjectId, cycleKey), a
 * dropped hook, a duplicated hook and a crashed request all converge on exactly one
 * run — so the sweep is the correctness and any in-request hook is only latency.
 *
 * WHY NO SKIP LOCKED: claiming is a compare-and-set from PENDING to RUNNING, the same
 * idiom the day-sheet ticker and the inbox auto-reply already use. At ~80 enrolments a
 * day this is not a throughput problem, and a CAS costs no transaction pinning on a
 * pooled Neon connection.
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { createHash } from 'crypto';
import { prismaContext, type AutomationContext } from './context';
import { evaluate, UnitMismatch, type EvalTrace, type Subject } from './predicates';
import { communicationPolicy } from './policy';
import {
  sendForStep, issueCouponForStep, activateCoupon, voidPendingCoupon, couponExpiry,
} from './actions';
import { Outcome, type AutomationDefinition, type Step } from './types';
import { resolveRecipients } from './recipients';
import { TRIGGERS } from './triggers';
import { holdLine } from './inbound';
import {
  sendDaySheet, istParts, previousDate, GRACE_MINUTES as SHEET_GRACE_MINUTES, DAY_SHEET,
} from '../automatedMessageService';

const BATCH = 50;
const MAX_ATTEMPTS = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How late an anchored step may still run. Beyond this it is skipped, not sent late. */
const GRACE_MS = 8 * 60 * 60 * 1000;

/**
 * Keyed on the PATIENT, never the subject. Keyed on a visit, the same person gets an
 * independent coin flip per visit and can be treated once and held out the next time,
 * which contaminates both arms and quietly voids the only honest number on Results.
 */
export function isHeldOut(automationId: string, patientId: string, pct: number): boolean {
  if (pct <= 0) return false;
  const h = createHash('sha256').update(`${automationId}:${patientId}`).digest();
  return h.readUInt32BE(0) % 100 < pct;
}

function cycleKeyFor(def: AutomationDefinition, subjectId: string, now: Date): string {
  switch (def.reentry.mode) {
    case 'ONCE': return 'once';
    case 'EVERY_N_DAYS': {
      const days = Math.max(1, def.reentry.days ?? 30);
      return `d${Math.floor(now.getTime() / (days * DAY_MS))}`;
    }
    case 'PER_EVENT':
    default:
      return subjectId;
  }
}

async function log(
  runId: string,
  stepIndex: number,
  kind: string,
  outcome: string,
  detail?: unknown,
  messageLogId?: string,
): Promise<void> {
  await prisma.automationStepLog.create({
    data: {
      runId, stepIndex, kind, outcome,
      detail: (detail ?? undefined) as object | undefined,
      messageLogId: messageLogId ?? null,
    },
  });
}

// ── Enrolment ───────────────────────────────────────────────────────────────

export async function sweepEnrolments(ctx: AutomationContext): Promise<number> {
  const automations = await prisma.automation.findMany({
    where: { enabled: true, activatedAt: { not: null } },
  });
  let created = 0;

  for (const a of automations) {
    const def = a.definition as unknown as AutomationDefinition;

    // ── Scheduled: one run per branch per night ──────────────────────────────
    if (def.trigger.kind === 'SCHEDULE') {
      const { date, minutes } = istParts(ctx.now);
      // Which night do we owe? Today's once the clock passes the send time; if the box
      // was asleep over that moment the next tick still owes YESTERDAY's — late rather
      // than lost — but only inside the grace, so a long outage cannot replay a week.
      const sheetStep = def.steps.find(
        (s): s is Extract<Step, { kind: 'DAY_SHEET' }> => s.kind === 'DAY_SHEET',
      );
      if (!sheetStep) continue;

      // Grace is a property of the schedule, not of what it then does.
      const graceMinutes = (def.trigger.graceHours ?? SHEET_GRACE_MINUTES / 60) * 60;
      let runDate: string | null = null;
      if (minutes >= def.trigger.everyDayAtMinutes) runDate = date;
      else if (minutes + 1440 - def.trigger.everyDayAtMinutes <= graceMinutes) {
        runDate = previousDate(date);
      }
      if (!runDate) continue;

      for (const branchId of a.branchIds) {
        const subjectId = `${branchId}:${sheetStep.domain}`;
        try {
          const run = await prisma.automationRun.create({
            data: {
              automationId: a.id,
              version: a.version,
              subjectType: 'BRANCH_DAY',
              subjectId,
              // The night IS the cycle key, so a second tick the same evening finds
              // the row already there rather than owing another sheet.
              cycleKey: runDate,
              branchId,
              definition: a.definition as object,
              triggeredAt: ctx.now,
              nextActionAt: ctx.now,
              holdout: false,
            },
            select: { id: true },
          });
          await log(run.id, 0, 'ENROLLED', Outcome.ENROLLED, { runDate, domain: sheetStep.domain });
          created += 1;
        } catch {
          // Unique violation: this night is already owned.
        }
      }
      continue;
    }

    // Everything else goes through the registry. The engine does not know what any
    // trigger means — only that it can be asked for subjects that became eligible.
    const trigger = TRIGGERS[def.trigger.kind];
    if (!trigger) {
      logger.warn(`[automations] ${a.key} names an unknown trigger "${def.trigger.kind}"`);
      continue;
    }

    let candidates: Awaited<ReturnType<typeof trigger.findSubjects>>;
    try {
      candidates = await trigger.findSubjects({
        now: ctx.now,
        since: a.activatedAt!,
        branchIds: a.branchIds,
        config: def.trigger as unknown as Record<string, unknown>,
        limit: BATCH,
      });
    } catch (e) {
      logger.warn(`[automations] ${a.key} trigger failed: ${(e as Error).message}`);
      continue;
    }

    for (const c of candidates) {
      const cycleKey = c.cycleKey ?? cycleKeyFor(def, c.subjectId, ctx.now);
      const already = await prisma.automationRun.findUnique({
        where: { automationId_subjectId_cycleKey: { automationId: a.id, subjectId: c.subjectId, cycleKey } },
        select: { id: true },
      });
      if (already) continue;

      if (def.reentry.concurrency === 'ONE_ACTIVE_PER_PATIENT' && c.patientId) {
        const live = await prisma.automationRun.count({
          where: { automationId: a.id, patientId: c.patientId, state: { in: ['PENDING', 'RUNNING'] } },
        });
        if (live > 0) {
          // Write the miss down rather than skipping silently. Two things follow from
          // one row: analytics can say how many chances were passed over, and the
          // unique key means this visit is never reconsidered once the other journey
          // ends — a suppressed opportunity is skipped, not queued.
          try {
            const suppressed = await prisma.automationRun.create({
              data: {
                automationId: a.id, version: a.version,
                subjectType: trigger.subjectType, subjectId: c.subjectId, cycleKey,
                patientId: c.patientId, branchId: c.branchId,
                definition: a.definition as object,
                triggeredAt: c.triggeredAt,
                state: 'STOPPED', stopReason: 'SUPPRESSED_ACTIVE_JOURNEY',
                nextActionAt: null, holdout: false,
              },
              select: { id: true },
            });
            await log(suppressed.id, 0, 'SUPPRESSED', 'SUPPRESSED_ACTIVE_JOURNEY',
              { reason: 'this patient already has a live journey on this automation' });
          } catch {
            // Already recorded by another tick.
          }
          continue;
        }
      }

      const subject: Subject = {
        type: trigger.subjectType,
        id: c.subjectId,
        patientId: c.patientId,
        branchId: c.branchId,
        triggeredAt: c.triggeredAt,
      };
      const trace: EvalTrace[] = [];
      let qualifies = false;
      try {
        qualifies = await evaluate(def.audience, ctx, subject, trace);
      } catch (e) {
        logger.warn(`[automations] audience failed for ${a.key}/${c.subjectId}: ${(e as Error).message}`);
        continue;
      }
      if (!qualifies) continue;

      try {
        const run = await prisma.automationRun.create({
          data: {
            automationId: a.id,
            version: a.version,
            subjectType: trigger.subjectType,
            subjectId: c.subjectId,
            cycleKey,
            patientId: c.patientId,
            branchId: c.branchId,
            definition: a.definition as object,
            triggeredAt: c.triggeredAt,
            nextActionAt: ctx.now,
            holdout: c.patientId ? isHeldOut(a.id, c.patientId, a.holdoutPct) : false,
          },
          select: { id: true, holdout: true },
        });
        await log(run.id, 0, 'ENROLLED', Outcome.ENROLLED, { trace, holdout: run.holdout });
        created += 1;
      } catch {
        // Unique violation: another tick got there first. The intended outcome.
      }
    }
  }
  return created;
}

// ── Step execution ──────────────────────────────────────────────────────────

function nextActionFor(step: Extract<Step, { kind: 'WAIT' }>, triggeredAt: Date, now: Date): Date {
  if (step.anchor === 'TRIGGER') {
    const ms = (step.days ?? 0) * DAY_MS + (step.hours ?? 0) * 60 * 60 * 1000;
    return new Date(triggeredAt.getTime() + ms);
  }
  const ms = (step.days ?? 0) * DAY_MS + (step.hours ?? 0) * 60 * 60 * 1000;
  return new Date(now.getTime() + ms);
}

async function finish(runId: string, state: string, reason: string, stepIndex: number): Promise<void> {
  await prisma.automationRun.update({
    where: { id: runId },
    data: { state, stopReason: reason, nextActionAt: null },
  });
  await log(runId, stepIndex, 'STOPPED', reason);
}

export async function executeOneStep(runId: string, ctx: AutomationContext): Promise<void> {
  const run = await prisma.automationRun.findUnique({ where: { id: runId } });
  if (!run || run.state !== 'RUNNING') return;

  const def = run.definition as unknown as AutomationDefinition;
  const step = def.steps[run.stepIndex];
  const subject: Subject = {
    type: run.subjectType, id: run.subjectId, patientId: run.patientId,
    branchId: run.branchId, triggeredAt: run.triggeredAt,
  };

  if (!step) {
    await finish(runId, 'DONE', Outcome.STOPPED_BY_STEP, run.stepIndex);
    return;
  }

  const advance = async (nextAt: Date | null) => {
    await prisma.automationRun.update({
      where: { id: runId },
      data: { stepIndex: run.stepIndex + 1, state: 'PENDING', nextActionAt: nextAt ?? ctx.now },
    });
  };

  switch (step.kind) {
    case 'WAIT': {
      const at = nextActionFor(step, run.triggeredAt, ctx.now);
      // A day already past runs now, inside the grace. Beyond it, a Day-10 nudge
      // delivered on Day 13 is worse than not sending it at all.
      if (at.getTime() + GRACE_MS < ctx.now.getTime()) {
        await log(runId, run.stepIndex, 'WAIT', Outcome.MISSED_WINDOW, { due: at });
        await advance(ctx.now);
        return;
      }
      await log(runId, run.stepIndex, 'WAIT', Outcome.WAITING, { until: at });
      await advance(at < ctx.now ? ctx.now : at);
      return;
    }

    case 'CHECK': {
      const trace: EvalTrace[] = [];
      let hit = false;
      try {
        hit = await evaluate(step.condition, ctx, subject, trace);
      } catch (e) {
        if (e instanceof UnitMismatch) {
          await log(runId, run.stepIndex, 'CHECK', Outcome.UNIT_MISMATCH, { message: e.message });
          await finish(runId, 'FAILED', Outcome.UNIT_MISMATCH, run.stepIndex);
          return;
        }
        throw e;
      }
      await log(runId, run.stepIndex, 'CHECK', hit ? Outcome.CHECK_TRUE : Outcome.CHECK_FALSE, { trace });

      const outcome = hit ? step.onTrue : (step.onFalse ?? 'CONTINUE');
      // A number is a jump. It is how one journey says two different things to two
      // patients without becoming two journeys that have to be kept in step.
      if (typeof outcome === 'number') {
        await prisma.automationRun.update({
          where: { id: runId },
          data: { stepIndex: outcome, state: 'PENDING', nextActionAt: ctx.now },
        });
        return;
      }
      if (outcome === 'STOP' && !hit) {
        await finish(runId, 'DONE', step.stopReason ?? Outcome.STOPPED_BY_STEP, run.stepIndex);
        return;
      }
      if (hit && outcome === 'STOP') {
        const conv = await goalValue(ctx, subject);
        await prisma.automationRun.update({
          where: { id: runId },
          data: {
            state: 'STOPPED',
            stopReason: step.stopReason ?? Outcome.STOPPED_GOAL_MET,
            nextActionAt: null,
            convertedAt: conv ? ctx.now : null,
            convertedBranchId: conv?.branchId ?? null,
            convertedValueInPaise: conv?.valueInPaise ?? null,
          },
        });
        return;
      }
      await advance(ctx.now);
      return;
    }

    case 'SEND': {
      // Through the same resolver as every other sending action. A journey defaults to
      // its own patient, which is what it almost always means — but a step that says
      // otherwise now works without the engine learning a second way to address people.
      const to = await resolveRecipients(step.to, run, { kind: 'RUN_PATIENT' });
      const phone = to.phones[0] ?? null;

      // Enrolled, evaluated, never messaged — which is what makes it a control group
      // rather than an exclusion.
      if (run.holdout) {
        await log(runId, run.stepIndex, 'SUPPRESSED', Outcome.HELD_OUT);
        await advance(ctx.now);
        return;
      }

      const priority = (await prisma.automation.findUnique({
        where: { id: run.automationId },
        select: { priority: true },
      }))?.priority;

      // Consent, opt-out, quiet hours and the weekly cap are PATIENT protections. A
      // message addressed to the centre's own staff carries no patientId here, so they
      // do not apply to it — which is why a staff alert is not silently held until 8am.
      const decision = await communicationPolicy(ctx, {
        patientId: to.patientId,
        phone,
        intent: step.intent,
        runId,
        visitId: run.subjectType === 'VISIT' ? run.subjectId : null,
        priority,
        skipMarketingConsent: def.policy?.skipMarketingConsent,
      });

      if (decision.kind === 'DROP') {
        await log(runId, run.stepIndex, 'SUPPRESSED', decision.reason);
        await advance(ctx.now);
        return;
      }
      if (decision.kind === 'DEFER') {
        // The step stays where it is. A delay moves when a step is sent; it never
        // moves when the next one is due.
        await log(runId, run.stepIndex, 'DEFERRED', decision.reason, { until: decision.until });
        await prisma.automationRun.update({
          where: { id: runId },
          data: { state: 'PENDING', nextActionAt: decision.until },
        });
        return;
      }

      let couponCode: string | null = null;
      let couponId: string | null = null;
      if (step.issueOffer) {
        const c = await issueCouponForStep(
          step.issueOffer.campaignId, runId, run.stepIndex, run.patientId, phone,
          run.subjectType === 'VISIT' ? run.subjectId : null,
          step.issueOffer.expiry
            ? couponExpiry(step.issueOffer.expiry, run.triggeredAt, ctx.now, 30)
            : undefined,
        );
        if (c?.refused) {
          await log(runId, run.stepIndex, 'COUPON', c.refused);
        } else if (c) {
          couponCode = c.code;
          couponId = c.couponId;
        }
      }

      const branch = run.branchId
        ? await prisma.branch.findUnique({ where: { id: run.branchId }, select: { name: true } })
        : null;
      const patientRow = run.patientId
        ? await prisma.patient.findUnique({ where: { id: run.patientId }, select: { name: true } })
        : null;

      // Every resolved number, not just the first. A patient is one phone; a staff
      // alert is "tell the three people who need to know", and sending to one of them
      // is the failure that looks like success.
      const out = await sendForStep({
        runId, stepIndex: run.stepIndex,
        patientId: to.patientId, branchId: run.branchId,
        phone: phone!, phones: to.phones, template: step.template, language: step.language ?? 'en',
        params: step.params, couponCode,
        patientFirstName: patientRow?.name ?? null,
        branchName: branch?.name ?? null,
        contextId: run.subjectId,
      });

      if (out.failed) {
        if (couponId) await voidPendingCoupon(couponId);
        const attempts = run.attempts + 1;
        const permanent = /WHATSAPP_DISABLED|expects \d+ values/.test(out.failed);
        if (permanent || attempts >= MAX_ATTEMPTS) {
          await log(runId, run.stepIndex, 'FAILED', Outcome.SEND_FAILED, { error: out.failed, attempts });
          await finish(runId, 'FAILED', Outcome.SEND_FAILED, run.stepIndex);
          return;
        }
        // Transient: back off and try again rather than losing the message.
        await log(runId, run.stepIndex, 'FAILED', Outcome.SEND_FAILED, { error: out.failed, attempts });
        await prisma.automationRun.update({
          where: { id: runId },
          data: {
            attempts,
            state: 'PENDING',
            nextActionAt: new Date(ctx.now.getTime() + attempts * 30 * 60 * 1000),
          },
        });
        return;
      }

      if (couponId) await activateCoupon(couponId);
      await log(
        runId, run.stepIndex, 'SEND',
        out.alreadySent ? Outcome.ALREADY_SENT : Outcome.SENT,
        { template: step.template, couponCode }, out.messageLogId,
      );
      await advance(ctx.now);
      return;
    }

    case 'DAY_SHEET': {
      const [branchId, domain] = run.subjectId.split(':');
      const runDate = run.cycleKey;

      // THE INTERLOCK. Both this engine and the old automatedMessageService ticker
      // claim the same (kind, branch, domain, night) key before sending, so whichever
      // reaches it first owns the night and the other stands down. That is what makes
      // the two safe to run side by side during a cutover — and it is the same
      // claim-before-send property the old ticker was already relying on.
      try {
        await prisma.scheduledMessageRun.create({
          data: { kind: DAY_SHEET, branchId, domain, runDate, status: 'SENDING' },
        });
      } catch {
        await log(runId, run.stepIndex, 'SEND', Outcome.ALREADY_SENT_BY_OLD_TICKER, { runDate });
        await finish(runId, 'DONE', Outcome.ALREADY_SENT_BY_OLD_TICKER, run.stepIndex);
        return;
      }

      let outcome: { status: string; detail: string | null };
      try {
        const to = await resolveRecipients(step.to, run, { kind: 'USERS', role: 'owner' });
        outcome = await sendDaySheet({ branchId, domain }, runDate, {
          template: step.template,
          phones: to.phones,
          recipientLabel: to.describe,
          linkExpiryHours: step.linkExpiryHours,
        });
      } catch (e) {
        outcome = { status: 'FAILED', detail: (e as Error).message?.slice(0, 500) ?? 'unknown' };
      }

      if (outcome.status === 'FAILED') {
        // RELEASE THE NIGHT. Claiming and then failing would leave the key taken and
        // the sheet unsent — the old ticker would skip, and the owner would simply not
        // get the day's takings. Handing the claim back means the proven path picks it
        // up on its next five-minute tick, well inside its eight-hour grace.
        //
        // This is what makes the two senders an overlap rather than a handover: the new
        // one can only ever take a night it actually delivers.
        await prisma.scheduledMessageRun.deleteMany({
          where: { kind: DAY_SHEET, branchId, domain, runDate, status: 'SENDING' },
        });
        await log(runId, run.stepIndex, 'FAILED', Outcome.SEND_FAILED, {
          runDate, domain, detail: outcome.detail, releasedToOldTicker: true,
        });
        await finish(runId, 'FAILED', Outcome.SEND_FAILED, run.stepIndex);
        return;
      }

      await prisma.scheduledMessageRun.updateMany({
        where: { kind: DAY_SHEET, branchId, domain, runDate },
        data: { status: outcome.status, detail: outcome.detail, sentAt: new Date() },
      });

      await log(
        runId, run.stepIndex, 'SEND',
        outcome.status === 'SENT' ? Outcome.SENT : outcome.status,
        { runDate, domain, detail: outcome.detail },
      );
      await advance(ctx.now);
      return;
    }

    case 'ASK': {
      const to = await resolveRecipients(undefined, run, { kind: 'RUN_PATIENT' });
      const phone = to.phones[0] ?? null;

      // Coming BACK to this step means the window closed with no answer — the reply
      // path moves stepIndex itself, so we only ever return here unanswered.
      const slot = phone
        ? await prisma.awaitingReply.findUnique({ where: { phone }, select: { automationRunId: true, expiresAt: true } })
        : null;
      const asked = await prisma.automationStepLog.findFirst({
        where: { runId, stepIndex: run.stepIndex, outcome: Outcome.ASKED },
        select: { id: true },
      });
      if (asked) {
        if (slot?.automationRunId === runId) {
          await prisma.awaitingReply.delete({ where: { phone: phone! } }).catch(() => {});
        }
        await log(runId, run.stepIndex, 'ASK', Outcome.NO_REPLY);
        if (step.onUnmatched === 'STOP') {
          await finish(runId, 'DONE', Outcome.NO_REPLY, run.stepIndex);
          return;
        }
        await advance(ctx.now);
        return;
      }

      if (run.holdout) {
        await log(runId, run.stepIndex, 'SUPPRESSED', Outcome.HELD_OUT);
        await advance(ctx.now);
        return;
      }

      const priorityA = (await prisma.automation.findUnique({
        where: { id: run.automationId }, select: { priority: true },
      }))?.priority;

      const decision = await communicationPolicy(ctx, {
        patientId: to.patientId, phone, intent: step.intent, runId,
        visitId: run.subjectType === 'VISIT' ? run.subjectId : null, priority: priorityA,
        skipMarketingConsent: def.policy?.skipMarketingConsent,
      });
      if (decision.kind === 'DROP') {
        await log(runId, run.stepIndex, 'SUPPRESSED', decision.reason);
        await advance(ctx.now);
        return;
      }
      if (decision.kind === 'DEFER') {
        await log(runId, run.stepIndex, 'DEFERRED', decision.reason, { until: decision.until });
        await prisma.automationRun.update({
          where: { id: runId }, data: { state: 'PENDING', nextActionAt: decision.until },
        });
        return;
      }

      // Claim the line BEFORE asking. One automation may hold a phone; a second wanting
      // it waits rather than both talking over each other.
      const waitHours = step.waitHours ?? 24;
      const held = await holdLine(
        phone!, runId, to.patientId ?? '',
        {
          buttons: Object.fromEntries(step.buttons.map((b) => [b.payload, b.goTo])),
          keywords: (step.keywords ?? []).map((k) => ({ match: k.match, stepIndex: k.goTo })),
          onUnmatched: step.onUnmatched,
        },
        waitHours,
      );
      if (!held) {
        await log(runId, run.stepIndex, 'DEFERRED', Outcome.LINE_BUSY);
        await prisma.automationRun.update({
          where: { id: runId },
          data: { state: 'PENDING', nextActionAt: new Date(ctx.now.getTime() + 60 * 60 * 1000) },
        });
        return;
      }

      const branchA = run.branchId
        ? await prisma.branch.findUnique({ where: { id: run.branchId }, select: { name: true } })
        : null;
      const patientA = run.patientId
        ? await prisma.patient.findUnique({ where: { id: run.patientId }, select: { name: true } })
        : null;

      const sent = await sendForStep({
        runId, stepIndex: run.stepIndex, patientId: to.patientId, branchId: run.branchId,
        phone: phone!, template: step.template, language: step.language ?? 'en',
        params: step.params, couponCode: null,
        patientFirstName: patientA?.name ?? null, branchName: branchA?.name ?? null,
        contextId: run.subjectId,
      });

      if (sent.failed) {
        await prisma.awaitingReply.deleteMany({ where: { automationRunId: runId } });
        await log(runId, run.stepIndex, 'FAILED', Outcome.SEND_FAILED, { error: sent.failed });
        await finish(runId, 'FAILED', Outcome.SEND_FAILED, run.stepIndex);
        return;
      }

      await log(runId, run.stepIndex, 'ASK', Outcome.ASKED,
        { template: step.template, buttons: step.buttons.map((b) => b.label) }, sent.messageLogId);
      // Wake when the window closes, so silence is an outcome rather than a run that
      // sits forever.
      await prisma.automationRun.update({
        where: { id: runId },
        data: {
          state: 'PENDING',
          nextActionAt: new Date(ctx.now.getTime() + waitHours * 60 * 60 * 1000),
        },
      });
      return;
    }

    case 'HANDOFF': {
      const toH = await resolveRecipients(undefined, run, { kind: 'RUN_PATIENT' });
      const phoneH = toH.phones[0] ?? null;
      if (phoneH) {
        // Mark the thread as needing a person. Marketing then stays off it while they
        // are there — a report still reaches the patient.
        await prisma.conversation.updateMany({
          where: { phone: phoneH },
          data: { status: 'OPEN', unreadCount: { increment: 1 } },
        });
        await prisma.awaitingReply.deleteMany({ where: { phone: phoneH } });
      }
      await log(runId, run.stepIndex, 'HANDOFF', Outcome.HANDED_TO_STAFF, { note: step.note ?? null });
      // The run ENDS here. A journey that wakes up three days into a human conversation
      // is worse than no journey at all.
      await finish(runId, 'DONE', Outcome.HANDED_TO_STAFF, run.stepIndex);
      return;
    }

    case 'STOP': {
      await finish(runId, 'DONE', step.reason || Outcome.STOPPED_BY_STEP, run.stepIndex);
      return;
    }
  }
}

async function goalValue(
  ctx: AutomationContext,
  subject: Subject,
): Promise<{ branchId: string; valueInPaise: number } | null> {
  if (subject.type !== 'VISIT' || !subject.patientId) return null;
  const visit = await ctx.visit(subject.id);
  if (!visit) return null;
  const after = await ctx.diagnosticsAfter(subject.patientId, visit.createdAt);
  if (after.length === 0) return null;
  const first = after[0];
  return { branchId: first.branchId, valueInPaise: first.totalAmountInPaise };
}

// ── The tick ────────────────────────────────────────────────────────────────

export async function runDue(ctx: AutomationContext): Promise<number> {
  const due = await prisma.automationRun.findMany({
    where: { state: 'PENDING', nextActionAt: { lte: ctx.now } },
    orderBy: { nextActionAt: 'asc' },
    take: BATCH,
    select: { id: true },
  });

  let done = 0;
  for (const { id } of due) {
    // Compare-and-set: only one worker can move a run out of PENDING.
    const claim = await prisma.automationRun.updateMany({
      where: { id, state: 'PENDING' },
      data: { state: 'RUNNING' },
    });
    if (claim.count !== 1) continue;
    try {
      await executeOneStep(id, ctx);
      done += 1;
    } catch (e) {
      logger.error(`[automations] step failed for run ${id}: ${(e as Error).message}`);
      await prisma.automationRun.updateMany({
        where: { id, state: 'RUNNING' },
        data: { state: 'PENDING', nextActionAt: new Date(ctx.now.getTime() + 30 * 60 * 1000) },
      });
    }
  }
  return done;
}

/**
 * A conversion is a claim, not a fact. The order it rested on can be cancelled or
 * refunded, and visit completion is not monotonic here (reopenVisitForEntry), so what
 * was true when the run stopped may not be true a week later.
 */
export async function reconcileConversions(ctx: AutomationContext): Promise<number> {
  const recent = await prisma.automationRun.findMany({
    where: { convertedAt: { gte: new Date(ctx.now.getTime() - 30 * DAY_MS) } },
    select: { id: true, subjectId: true, subjectType: true, patientId: true, triggeredAt: true, stepIndex: true },
    take: BATCH,
  });

  let reversed = 0;
  for (const run of recent) {
    if (run.subjectType !== 'VISIT' || !run.patientId) continue;
    const visit = await ctx.visit(run.subjectId);
    if (!visit) continue;
    const after = await ctx.diagnosticsAfter(run.patientId, visit.createdAt);
    if (after.length > 0) continue;
    await prisma.automationRun.update({
      where: { id: run.id },
      data: { convertedAt: null, convertedBranchId: null, convertedValueInPaise: null },
    });
    await log(run.id, run.stepIndex, 'REVERSED', Outcome.CONVERSION_REVERSED);
    reversed += 1;
  }
  return reversed;
}

export async function tick(now: Date = new Date()): Promise<void> {
  const ctx = prismaContext(now);
  try {
    const enrolled = await sweepEnrolments(ctx);
    const advanced = await runDue(ctx);
    const reversed = await reconcileConversions(ctx);
    if (enrolled || advanced || reversed) {
      logger.info(`[automations] enrolled ${enrolled} · advanced ${advanced} · reversed ${reversed}`);
    }
  } catch (e) {
    logger.error(`[automations] tick failed: ${(e as Error).message}`);
  }
}
