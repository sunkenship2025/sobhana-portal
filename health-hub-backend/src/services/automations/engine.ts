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
  sendForStep, issueCouponForStep, activateCoupon, voidPendingCoupon, couponExpiry, addDays, isSundayIST,
} from './actions';
import { Outcome, type AutomationDefinition, type Step } from './types';
import { resolveRecipients } from './recipients';
import { TRIGGERS } from './triggers';
import { holdLine, releaseLine } from './inbound';
import { phoneKey, threadPhone } from './phone';
import { resolveFields } from './fields';
import { expireCoupons } from '../couponService';
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
    // "Every N days" limits the PATIENT (patientReentry, at enrolment). Keyed on a
    // calendar window here, the same old visit started the journey again every N days.
    case 'EVERY_N_DAYS':
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

    // Read FORWARD from where the last sweep stopped, a page at a time. Reading from
    // activation every tick returned the same oldest page for ever: OP recovery enrolled
    // its first 50 visits and then never looked at another one.
    const config = def.trigger as unknown as Record<string, unknown>;
    const state = (a.sweepState ?? {}) as SweepState;
    const period = trigger.period ? trigger.period(config, ctx.now) : null;
    if (period && state.period === period && state.done) continue; // this period is read
    // A past window is read once, first day to last, and never again.
    const past = !period && def.past ? {
      from: new Date(`${def.past.from}T00:00:00+05:30`), to: new Date(`${def.past.to}T23:59:59.999+05:30`),
    } : null;
    if (past && state.done) continue;
    if (def.skipSundays && isSundayIST(ctx.now)) continue;
    // Today's room under the daily limit: what this automation actually started today.
    let room = Infinity;
    if (def.dailyLimit) {
      const started = await prisma.automationRun.count({
        where: {
          automationId: a.id, createdAt: { gte: new Date(`${istParts(ctx.now).date}T00:00:00+05:30`) },
          OR: [{ stopReason: null }, { stopReason: { notIn: [Outcome.SUPPRESSED_REENTRY, 'SUPPRESSED_ACTIVE_JOURNEY'] } }],
        },
      });
      room = def.dailyLimit - started;
      if (room <= 0) continue;
    }
    const floor = past ? past.from : a.activatedAt!;
    let since = state.through
      ? new Date(Math.max(floor.getTime(), new Date(state.through).getTime() - SWEEP_OVERLAP_MS))
      : floor;
    let cursor: string | null = period && state.period === period ? state.cursor ?? null : null;
    let through = state.through ? new Date(state.through) : null;
    let done = false;
    let limit = BATCH;
    // Stopped short — today's limit reached, or the past window's end — so the mark moves
    // only as far as what was actually read, and tomorrow picks up from there.
    let stop = false;

    for (let page = 0; page < SWEEP_PAGES && !stop; page += 1) {
      let candidates: Awaited<ReturnType<typeof trigger.findSubjects>>;
      try {
        candidates = await trigger.findSubjects({
          now: ctx.now, since, branchIds: a.branchIds, config, limit, cursor,
        });
      } catch (e) {
        logger.warn(`[automations] ${a.key} trigger failed: ${(e as Error).message}`);
        break;
      }

      let lastSeen: (typeof candidates)[number] | undefined;
      for (const c of candidates) {
        if (past && c.triggeredAt > past.to) { done = true; stop = true; break; }
        if (room <= 0) { stop = true; break; }
        lastSeen = c;
        // A past subject starts its journey today: its own day 0 is the day it is reached.
        const triggeredAt = past ? ctx.now : c.triggeredAt;
        const cycleKey = c.cycleKey ?? cycleKeyFor(def, c.subjectId, ctx.now);
        const already = await prisma.automationRun.findUnique({
          where: { automationId_subjectId_cycleKey: { automationId: a.id, subjectId: c.subjectId, cycleKey } },
          select: { id: true },
        });
        if (already) continue;

        // "Once" and "every N days" are about the PATIENT. They were keyed on the subject —
        // for a visit trigger, the visit — so every new visit was a new subject and neither
        // limited anything: a regular would have been enrolled on every visit.
        const limit = patientReentry(def.reentry, ctx.now);
        if (c.patientId && limit.check) {
          const before = await prisma.automationRun.count({
            where: {
              automationId: a.id, patientId: c.patientId,
              // A suppressed or held-back run still counts: the patient was considered. A
              // visit passed over by THIS limit does not — or a regular who comes every ten
              // days would push the window forward on every visit and never qualify again.
              OR: [{ stopReason: null }, { stopReason: { not: Outcome.SUPPRESSED_REENTRY } }],
              ...(limit.since ? { triggeredAt: { gte: limit.since } } : {}),
            },
          });
          if (before > 0) {
            // Written down, so this visit is never considered again. Left unrecorded it was
            // re-read, and once the earlier journey slid out of "every 15 days" the old
            // visit enrolled late — a second code the rule was there to prevent.
            try {
              const passed = await prisma.automationRun.create({
                data: {
                  automationId: a.id, version: a.version,
                  subjectType: trigger.subjectType, subjectId: c.subjectId, cycleKey,
                  patientId: c.patientId, branchId: c.branchId,
                  definition: a.definition as object,
                  triggeredAt,
                  state: 'STOPPED', stopReason: Outcome.SUPPRESSED_REENTRY,
                  nextActionAt: null, holdout: false,
                },
                select: { id: true },
              });
              await log(passed.id, 0, 'SUPPRESSED', Outcome.SUPPRESSED_REENTRY,
                { reason: `already started this ${def.reentry.mode === 'ONCE' ? 'once' : `within ${def.reentry.days} days`}` });
            } catch {
              // Already recorded by another tick.
            }
            continue;
          }
        }

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
                  triggeredAt,
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
          triggeredAt,
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
              triggeredAt,
              // The engine's clock, so "started today" for the daily limit means its today.
              createdAt: ctx.now,
              nextActionAt: ctx.now,
              holdout: c.patientId ? isHeldOut(a.id, c.patientId, a.holdoutPct) : false,
            },
            select: { id: true, holdout: true },
          });
          await log(run.id, 0, 'ENROLLED', Outcome.ENROLLED, { trace, holdout: run.holdout });
          created += 1;
          room -= 1;
        } catch {
          // Unique violation: another tick got there first. The intended outcome.
        }
      }

      // Advance to what was read. A short page is the end of what there is to read.
      if (lastSeen) {
        if (period) cursor = lastSeen.subjectId;
        else if (!through || lastSeen.triggeredAt > through) through = lastSeen.triggeredAt;
      }
      if (stop) break;
      const last = candidates[candidates.length - 1];
      if (candidates.length < limit) { done = true; break; }
      if (!period) {
        if (last.triggeredAt.getTime() <= since.getTime()) {
          // A full page all at one instant: a bulk update stamps hundreds of rows alike,
          // and paging by time cannot get past it — the sweep would stop here for good.
          // Read that instant whole with bigger pages, then step past it.
          if (limit >= SWEEP_INSTANT_MAX) {
            logger.warn(`[automations] ${a.key}: over ${SWEEP_INSTANT_MAX} subjects at ${since.toISOString()}; stepping past`);
            since = new Date(since.getTime() + 1);
            limit = BATCH;
          } else {
            limit = Math.min(SWEEP_INSTANT_MAX, limit * 4);
          }
          continue;
        }
        since = last.triggeredAt;
        limit = BATCH;
      }
    }

    const next: SweepState = period
      ? { period, cursor: cursor ?? undefined, done }
      : { through: through?.toISOString(), ...(past && done ? { done: true } : {}) };
    if (JSON.stringify(next) !== JSON.stringify(state)) {
      // Raw, so bookkeeping does not move the automation's own updatedAt.
      await prisma.$executeRaw`UPDATE "Automation" SET "sweepState" = ${JSON.stringify(next)}::jsonb WHERE "id" = ${a.id}`;
    }
  }
  return created;
}

/** How far enrolment has read, per automation. See Automation.sweepState. */
interface SweepState { through?: string; period?: string; cursor?: string; done?: boolean }
/** Re-read this much behind the mark, for rows saved a moment after the last sweep read. */
const SWEEP_OVERLAP_MS = 5 * 60 * 1000;
/** Pages per automation per sweep, so one busy day cannot stall a tick. */
const SWEEP_PAGES = 20;
/** The most subjects read at one instant before stepping past it. */
const SWEEP_INSTANT_MAX = 5000;

// ── Step execution ──────────────────────────────────────────────────────────

/** When a WAIT ends, counted from the trigger or from now. The preview counts the same way. */
export function waitUntil(step: Extract<Step, { kind: 'WAIT' }>, triggeredAt: Date, now: Date): Date {
  const from = step.anchor === 'TRIGGER' ? triggeredAt : now;
  let at = new Date(addDays(from, step.days ?? 0, step.skipSundays).getTime() + (step.hours ?? 0) * 60 * 60 * 1000);
  while (step.skipSundays && isSundayIST(at)) at = new Date(at.getTime() + DAY_MS);
  return at;
}

async function finish(runId: string, state: string, reason: string, stepIndex: number): Promise<void> {
  await prisma.automationRun.update({
    where: { id: runId },
    data: { state, stopReason: reason, nextActionAt: null },
  });
  await releaseLine(runId);
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
    // The run, so a step can ask about the run's OWN coupon. subject.id is the visit.
    runId: run.id,
  };

  if (!step) {
    await finish(runId, 'DONE', Outcome.STOPPED_BY_STEP, run.stepIndex);
    return;
  }

  // The visit that started this journey has since been cancelled. Everything the journey
  // says rests on that visit having happened — a thank-you, an offer for the family, a
  // nudge about tests the doctor advised — so it ends before its next action. A journey
  // started BY a cancellation is the exception: the cancelled visit is its whole subject.
  if (run.subjectType === 'VISIT' && def.trigger.kind !== 'VISIT_CANCELLED' && step.kind !== 'WAIT') {
    const started = await ctx.visit(run.subjectId);
    if (started?.status === 'CANCELLED') {
      await finish(runId, 'STOPPED', Outcome.VISIT_CANCELLED, run.stepIndex);
      return;
    }
  }

  // "Who qualifies", again, before anything reaches the patient. It was read once, at
  // entry — so a self visit corrected to doctor-referred the next morning still got the
  // family offer that evening. What made them qualify has to still be true when we speak.
  if ((step.kind === 'SEND' || step.kind === 'ASK') && run.patientId) {
    let still = true;
    try {
      still = await evaluate(def.audience, ctx, subject);
    } catch {
      still = true; // unreadable is not a reason to drop someone who qualified
    }
    if (!still) {
      await finish(runId, 'STOPPED', Outcome.NO_LONGER_QUALIFIES, run.stepIndex);
      return;
    }
  }

  // "When it stops", checked before every action — as the builder and Setup both say.
  // It was only ever read to count Results, so a journey that relied on it (rather than a
  // CHECK step of its own) went on reminding people who had already come in.
  if (def.goal && (step.kind === 'SEND' || step.kind === 'ASK' || step.kind === 'HANDOFF')
      && ctx.now.getTime() - run.triggeredAt.getTime() <= def.goal.windowDays * DAY_MS) {
    let met = false;
    try {
      met = await evaluate(def.goal.condition, ctx, subject);
    } catch (e) {
      // Unreadable is not "met": the step goes ahead, and the reason is on record.
      await log(runId, run.stepIndex, 'CHECK', Outcome.UNIT_MISMATCH, { goal: true, message: (e as Error).message });
    }
    if (met) {
      await finish(runId, 'STOPPED', def.goal.stopReason ?? Outcome.STOPPED_GOAL_MET, run.stepIndex);
      return;
    }
  }

  const advance = async (nextAt: Date | null) => {
    await prisma.automationRun.update({
      where: { id: runId },
      data: { stepIndex: run.stepIndex + 1, state: 'PENDING', nextActionAt: nextAt ?? ctx.now },
    });
  };

  switch (step.kind) {
    case 'WAIT': {
      const at = waitUntil(step, run.triggeredAt, ctx.now);
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
        // No conversion is written here. A CHECK is whatever the author made it, and
        // the goal is the only thing that decides "converted" — see reconcileConversions.
        await prisma.automationRun.update({
          where: { id: runId },
          data: {
            state: 'STOPPED',
            stopReason: step.stopReason ?? Outcome.STOPPED_GOAL_MET,
            nextActionAt: null,
          },
        });
        await releaseLine(runId);
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
      // A promotional message never goes out after its journey's window has closed —
      // held by the cap or quiet hours past the last day, it ends here instead. The four
      // Day-5 reminders held last night would otherwise have woken on Day 9 asking
      // patients to claim an offer that expired on Day 6.
      if (step.intent === 'PROACTIVE' && to.patientId && lateForWindow(run.triggeredAt, def, decision, ctx.now)) {
        await log(runId, run.stepIndex, 'SUPPRESSED', Outcome.MISSED_WINDOW, {
          wouldSendAt: decision.kind === 'DEFER' ? decision.until : ctx.now,
        });
        await finish(runId, 'DONE', Outcome.MISSED_WINDOW, run.stepIndex);
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
          // The message was going out anyway with COUPON_CODE bound to '' — "your code is
          // ." to someone who had just tapped Get my code. When the words need the code
          // and there is no code, the message does not go: a person picks the thread up
          // instead, because the patient asked for something and silence is not an answer.
          if (step.params.some((b) => b.from === 'COUPON_CODE')) {
            await handToStaff(runId, run.stepIndex, phone, `No code could be issued: ${c.refused}`);
            return;
          }
        } else if (c) {
          couponCode = c.code;
          couponId = c.couponId;
        }
      }

      // Every blank filled from fields.ts, or nothing sent. The fields describe the RUN's
      // patient and visit, so a staff alert can still say whose bill is due.
      const filled = await resolveFields(step.params, {
        runId, patientId: run.patientId, branchId: run.branchId,
        subjectType: run.subjectType, subjectId: run.subjectId, couponCode, now: ctx.now,
      });
      if (filled.missing.length > 0) {
        if (couponId) await voidPendingCoupon(couponId);
        await log(runId, run.stepIndex, 'SUPPRESSED', Outcome.FIELD_MISSING, { fields: filled.missing });
        await advance(ctx.now);
        return;
      }

      // Every resolved number, not just the first. A patient is one phone; a staff
      // alert is "tell the three people who need to know", and sending to one of them
      // is the failure that looks like success.
      const out = await sendForStep({
        runId, stepIndex: run.stepIndex,
        patientId: to.patientId, branchId: run.branchId,
        phone: phone!, phones: to.phones, template: step.template, language: step.language ?? 'en',
        values: filled.values,
        contextId: run.subjectId,
      });

      if (out.failed) {
        const attempts = run.attempts + 1;
        const permanent = /WHATSAPP_DISABLED|expects \d+ values/.test(out.failed);
        if (permanent || attempts >= MAX_ATTEMPTS) {
          if (couponId) await voidPendingCoupon(couponId);
          await log(runId, run.stepIndex, 'FAILED', Outcome.SEND_FAILED, { error: out.failed, attempts });
          await finish(runId, 'FAILED', Outcome.SEND_FAILED, run.stepIndex);
          return;
        }
        // Transient: back off and try again rather than losing the message. The code stays
        // PENDING for the retry — voided here, the retry would have sent a dead one.
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
        ? await prisma.awaitingReply.findUnique({ where: { phone: phoneKey(phone) }, select: { automationRunId: true, expiresAt: true } })
        : null;
      const asked = await prisma.automationStepLog.findFirst({
        where: { runId, stepIndex: run.stepIndex, outcome: Outcome.ASKED },
        select: { id: true },
      });
      if (asked) {
        if (slot?.automationRunId === runId) {
          await prisma.awaitingReply.delete({ where: { phone: phoneKey(phone!) } }).catch(() => {});
        }
        await log(runId, run.stepIndex, 'ASK', Outcome.NO_REPLY);

        // Silence is NOT the same as an answer nobody understood. Falling through to the
        // next step is right for some questions and catastrophic for others — here the
        // next step hands out a discount, so ignoring the offer would have granted it.
        const onSilence = step.onNoReply ?? 'CONTINUE';
        if (onSilence === 'STOP') {
          await finish(runId, 'DONE', Outcome.NO_REPLY, run.stepIndex);
          return;
        }
        if (typeof onSilence === 'number') {
          await prisma.automationRun.update({
            where: { id: runId },
            data: { stepIndex: onSilence, state: 'PENDING', nextActionAt: ctx.now },
          });
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
      // A promotional message never goes out after its journey's window has closed —
      // held by the cap or quiet hours past the last day, it ends here instead. The four
      // Day-5 reminders held last night would otherwise have woken on Day 9 asking
      // patients to claim an offer that expired on Day 6.
      if (step.intent === 'PROACTIVE' && to.patientId && lateForWindow(run.triggeredAt, def, decision, ctx.now)) {
        await log(runId, run.stepIndex, 'SUPPRESSED', Outcome.MISSED_WINDOW, {
          wouldSendAt: decision.kind === 'DEFER' ? decision.until : ctx.now,
        });
        await finish(runId, 'DONE', Outcome.MISSED_WINDOW, run.stepIndex);
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
        ctx.now,
      );
      if (!held) {
        await log(runId, run.stepIndex, 'DEFERRED', Outcome.LINE_BUSY);
        await prisma.automationRun.update({
          where: { id: runId },
          data: { state: 'PENDING', nextActionAt: new Date(ctx.now.getTime() + 60 * 60 * 1000) },
        });
        return;
      }

      const filledA = await resolveFields(step.params, {
        runId, patientId: run.patientId, branchId: run.branchId,
        subjectType: run.subjectType, subjectId: run.subjectId, now: ctx.now,
      });
      if (filledA.missing.length > 0) {
        // The line was claimed a moment ago for an answer that will now never be asked for.
        await prisma.awaitingReply.deleteMany({ where: { automationRunId: runId } });
        await log(runId, run.stepIndex, 'SUPPRESSED', Outcome.FIELD_MISSING, { fields: filledA.missing });
        await advance(ctx.now);
        return;
      }

      const sent = await sendForStep({
        runId, stepIndex: run.stepIndex, patientId: to.patientId, branchId: run.branchId,
        phone: phone!, template: step.template, language: step.language ?? 'en',
        values: filledA.values,
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
      // Meta's refusal arrives by webhook a few seconds after it accepted the send. If it
      // already has, notDelivered woke this run a moment ago — pushing the wake-up out
      // by the whole window here would undo that.
      const refusedAlready = sent.messageLogId
        ? (await prisma.messageLog.findUnique({ where: { id: sent.messageLogId }, select: { status: true } }))?.status === 'FAILED'
        : false;
      // Wake when the window closes, so silence is an outcome rather than a run that
      // sits forever.
      await prisma.automationRun.update({
        where: { id: runId },
        data: {
          state: 'PENDING',
          nextActionAt: refusedAlready ? ctx.now : new Date(ctx.now.getTime() + waitHours * 60 * 60 * 1000),
        },
      });
      return;
    }

    case 'HANDOFF': {
      const toH = await resolveRecipients(undefined, run, { kind: 'RUN_PATIENT' });
      await handToStaff(runId, run.stepIndex, toH.phones[0] ?? null, step.note ?? null);
      return;
    }

    case 'STOP': {
      await finish(runId, 'DONE', step.reason || Outcome.STOPPED_BY_STEP, run.stepIndex);
      return;
    }
  }
}

/**
 * Give the thread to a person and end the run.
 *
 * The inbox files a thread under the number as WhatsApp reports it — twelve digits —
 * and this flagged it under the patient's ten. It matched no thread, ever: every
 * handoff logged HANDED_TO_STAFF and put nothing in front of anyone.
 */
async function handToStaff(runId: string, stepIndex: number, phone: string | null, note: string | null) {
  if (phone) {
    // Mark the thread as needing a person. Marketing then stays off it while they
    // are there — a report still reaches the patient.
    await prisma.conversation.updateMany({
      where: { phone: threadPhone(phone) },
      data: { status: 'OPEN', unreadCount: { increment: 1 } },
    });
    await prisma.awaitingReply.deleteMany({ where: { phone: phoneKey(phone) } });
  }
  await log(runId, stepIndex, 'HANDOFF', Outcome.HANDED_TO_STAFF, { note });
  // The run ENDS here. A journey that wakes up three days into a human conversation
  // is worse than no journey at all.
  await finish(runId, 'DONE', Outcome.HANDED_TO_STAFF, stepIndex);
}

/** How long Meta's per-person marketing limit is given before the one resend. */
const RESEND_AFTER_MS = 2 * DAY_MS;

/**
 * WhatsApp accepted a message and then refused to deliver it.
 *
 * Meta says yes when we send and no a few seconds later by webhook. What follows depends
 * on why:
 *
 * - 131049, its per-person limit on marketing, refused a third of the recovery offers in
 *   their first week. Of the people refused once and messaged again 1-4 days later, about
 *   one in four got through — worth ONE more try, two days on, and no more. A question
 *   moves on instead: the journey's own reminder is its second try.
 * - 131050 is the patient blocking our marketing from inside WhatsApp. That is a STOP.
 * - Anything else (not on WhatsApp, Meta's experiment hold-back) cannot succeed later.
 *
 * Never allowed to break the webhook's ack — the caller catches.
 */
export async function notDelivered(waMessageId: string, errorCode: string | null, now: Date = new Date()): Promise<boolean> {
  const msg = await prisma.messageLog.findFirst({
    where: { waMessageId, automationRunId: { not: null } },
    select: { automationRunId: true, automationStep: true, phone: true, patientId: true },
  });
  if (!msg?.automationRunId || msg.automationStep === null) return false;
  const runId = msg.automationRunId;
  const stepIndex = msg.automationStep;

  if (errorCode === '131050') {
    await prisma.phoneOptOut.upsert({
      where: { phone: phoneKey(msg.phone) },
      create: { phone: phoneKey(msg.phone), source: 'WHATSAPP_BLOCKED_MARKETING' },
      update: {},
    });
  }

  const run = await prisma.automationRun.findUnique({
    where: { id: runId },
    select: { stepIndex: true, state: true, stopReason: true, triggeredAt: true, definition: true },
  });
  const def = run?.definition as unknown as AutomationDefinition | undefined;
  const step = def?.steps[stepIndex];
  if (!run || !step) return false;

  if (step.kind === 'ASK') {
    // Only a run still sitting on THAT question. One that has already moved on — answered,
    // stopped, or past it — is left alone.
    if (run.stepIndex !== stepIndex) return false;
    const woke = await prisma.automationRun.updateMany({
      where: { id: runId, stepIndex, state: 'PENDING' },
      data: { nextActionAt: now },
    });
    if (woke.count !== 1) return false;
    await log(runId, stepIndex, 'ASK', Outcome.NOT_DELIVERED, { errorCode });
    return true;
  }

  if (step.kind !== 'SEND' || !msg.patientId) return false;
  let retryAt = new Date(now.getTime() + RESEND_AFTER_MS);
  while (isSundayIST(retryAt)) retryAt = new Date(retryAt.getTime() + DAY_MS);
  const retried = await prisma.automationStepLog.count({
    where: { runId, stepIndex, outcome: Outcome.RETRY_SCHEDULED },
  });
  const code = await prisma.coupon.findFirst({ where: { automationRunId: runId }, select: { expiresAt: true } });
  const nextWait = def!.steps.slice(stepIndex + 1).find((s): s is Extract<Step, { kind: 'WAIT' }> => s.kind === 'WAIT');
  // Worth it only if the message still means something in two days: the journey does not
  // speak again sooner by itself (that would be the second try), it has not ended for a
  // reason — goal met, STOP, cancelled, handed to a person — and its code is still alive.
  // Whatever the resend finds by then, the send's own checks run again first.
  const worth = errorCode === '131049' && retried === 0
    && (run.state === 'PENDING'
      || (run.state === 'DONE' && run.stopReason !== Outcome.HANDED_TO_STAFF && run.stopReason !== Outcome.MISSED_WINDOW))
    && (!nextWait || waitUntil(nextWait, run.triggeredAt, now) > retryAt)
    && (!code || code.expiresAt > retryAt);
  if (worth) {
    const moved = await prisma.automationRun.updateMany({
      where: { id: runId, state: run.state, stepIndex: run.stepIndex },
      data: { stepIndex, state: 'PENDING', stopReason: null, nextActionAt: retryAt },
    });
    if (moved.count === 1) {
      await log(runId, stepIndex, 'SEND', Outcome.RETRY_SCHEDULED, { errorCode, retryAt });
      return true;
    }
  }
  await log(runId, stepIndex, 'SEND', Outcome.NOT_DELIVERED, { errorCode });
  return true;
}

/**
 * Would this message go out after the journey's window has closed?
 *
 * The window is the goal's own — "counts as converted within N days" — closing at the
 * END of that day in IST, the same boundary an anchored offer expiry uses, so a patient
 * who taps at 9pm on the last day is still inside it.
 */
export function lateForWindow(
  triggeredAt: Date,
  def: AutomationDefinition,
  decision: { kind: string; until?: Date },
  now: Date,
): boolean {
  const days = def.goal?.windowDays;
  if (!days || days <= 0) return false;
  const end = couponExpiry({ anchor: 'TRIGGER', days, endOfDayIST: true }, triggeredAt, now, days);
  const at = decision.kind === 'DEFER' && decision.until ? decision.until : now;
  return at > end;
}

/**
 * How often one PATIENT may enter, as a check the enrolment loop can run: "every time"
 * needs no check; "once" means any earlier run at all; "every N days" means a run in the
 * last N days.
 */
export function patientReentry(
  reentry: AutomationDefinition['reentry'],
  now: Date,
): { check: boolean; since?: Date } {
  if (reentry.mode === 'ONCE') return { check: true };
  if (reentry.mode === 'EVERY_N_DAYS') {
    return { check: true, since: new Date(now.getTime() - Math.max(1, reentry.days ?? 30) * DAY_MS) };
  }
  return { check: false };
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
  for (const { id } of due) if (await runOne(id, ctx)) done += 1;
  return done;
}

async function runOne(id: string, ctx: AutomationContext): Promise<boolean> {
  // Compare-and-set: only one worker can move a run out of PENDING.
  const claim = await prisma.automationRun.updateMany({
    where: { id, state: 'PENDING' },
    data: { state: 'RUNNING' },
  });
  if (claim.count !== 1) return false;
  try {
    await executeOneStep(id, ctx);
    return true;
  } catch (e) {
    logger.error(`[automations] step failed for run ${id}: ${(e as Error).message}`);
    await prisma.automationRun.updateMany({
      where: { id, state: 'RUNNING' },
      data: { state: 'PENDING', nextActionAt: new Date(ctx.now.getTime() + 30 * 60 * 1000) },
    });
    return false;
  }
}

/**
 * Take a run's next step now rather than at the next tick. A patient who tapped "Get my
 * code" is looking at the chat waiting for it; five minutes of nothing is when they tap
 * again, or give up. The same claim as the ticker, so the two cannot both take the step.
 */
export async function runNow(runId: string, now: Date = new Date()): Promise<void> {
  await runOne(runId, prismaContext(now));
}

/**
 * Keep every run's conversion in step with its GOAL, for the goal's whole window.
 *
 * Conversions used to be written only when a CHECK step stopped a run. That counted the
 * patient who walked in before Day 2 and never the one who came in after the message —
 * a journey ends right after its last send, so there was no step left to notice. Both
 * arms are asked the same question here, whatever state the run is in, which is what
 * the lift needs to mean anything.
 *
 * convertedAt is when this sweep first saw the goal met, so it can trail the real moment
 * by one sweep. It never runs early, so a CHECK before each send keeps "before or after
 * the message" exact; a journey without one can file a walk-in under "after".
 *
 * A conversion is also a claim, not a fact. The order it rested on can be cancelled or
 * refunded, and visit completion is not monotonic here (reopenVisitForEntry), so a goal
 * that no longer holds within 30 days is taken back.
 */
export async function reconcileConversions(
  ctx: AutomationContext,
): Promise<{ converted: number; reversed: number }> {
  // ponytail: every run of the last 30 days is read each sweep; page it if runs/day reach the thousands.
  const horizon = new Date(ctx.now.getTime() - 30 * DAY_MS);
  const runs = await prisma.automationRun.findMany({
    where: {
      AND: [
        { OR: [{ convertedAt: null, triggeredAt: { gte: horizon } }, { convertedAt: { gte: horizon } }] },
        // A suppressed row is a chance passed over, not a journey — its patient's live
        // run answers. Spelled with the null arm because `not` alone drops live runs.
        { OR: [{ stopReason: null }, { stopReason: { notIn: ['SUPPRESSED_ACTIVE_JOURNEY', Outcome.SUPPRESSED_REENTRY] } }] },
      ],
    },
    select: {
      id: true, subjectId: true, subjectType: true, patientId: true, branchId: true,
      triggeredAt: true, stepIndex: true, convertedAt: true, definition: true,
    },
  });

  let converted = 0;
  let reversed = 0;
  for (const run of runs) {
    const def = run.definition as unknown as AutomationDefinition;
    if (def.trigger.kind === 'SCHEDULE' || !def.goal) continue;
    const windowOpen = ctx.now.getTime() - run.triggeredAt.getTime() <= def.goal.windowDays * DAY_MS;
    if (!run.convertedAt && !windowOpen) continue;

    const subject: Subject = {
      type: run.subjectType, id: run.subjectId, patientId: run.patientId,
      branchId: run.branchId, triggeredAt: run.triggeredAt, runId: run.id,
    };
    let met: boolean;
    try {
      met = await evaluate(def.goal.condition, ctx, subject);
    } catch (e) {
      logger.warn(`[automations] goal unreadable for run ${run.id}: ${(e as Error).message}`);
      continue;
    }

    if (met && !run.convertedAt) {
      const v = await goalValue(ctx, subject);
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { convertedAt: ctx.now, convertedBranchId: v?.branchId ?? null, convertedValueInPaise: v?.valueInPaise ?? null },
      });
      converted += 1;
    } else if (!met && run.convertedAt) {
      await prisma.automationRun.update({
        where: { id: run.id },
        data: { convertedAt: null, convertedBranchId: null, convertedValueInPaise: null },
      });
      await log(run.id, run.stepIndex, 'REVERSED', Outcome.CONVERSION_REVERSED);
      reversed += 1;
    }
  }
  return { converted, reversed };
}

/**
 * The earliest moment this process believes work could exist.
 *
 * The tick used to sweep three tables every five minutes — 316 queries a day against 2
 * enabled automations, 6 runs ever and 0 of them active. Those queries cost 0.01 seconds
 * of database time between them, and cost real money anyway: each one restarts Neon's
 * 300-second idle timer, so a compute that should sleep all night never does.
 *
 * So the question "is anything due" is answered from this number instead. `null` means
 * unknown — look. Everything that could create work either lands as an HTTP write (which
 * clears this through `automationsMayHaveWork`) or has a time we can compute.
 */
let nextDueAt: number | null = null;

/**
 * A write happened that could have created work. Called from the router hook on every
 * successful mutation, so no individual handler has to remember — the failure mode of
 * per-route signalling is that the next route added silently forgets.
 */
export function automationsMayHaveWork(): void {
  nextDueAt = null;
}

/**
 * Never wait longer than this, whatever the arithmetic says. A trigger kind this
 * function has not learned to predict then runs LATE rather than never, and a failed
 * enrolment is retried within the hour instead of at tomorrow's firing.
 */
const BLIND_CEILING_MS = 60 * 60 * 1000;

/** The next instant at which IST clock-minutes equals `atMinutes`. Exported for the self-check. */
export function nextDailyFireMs(now: Date, atMinutes: number): number {
  const { minutes } = istParts(now);
  const wait = minutes < atMinutes ? atMinutes - minutes : atMinutes + 1440 - minutes;
  return now.getTime() + wait * 60_000;
}

async function computeNextDueAt(now: Date): Promise<number> {
  const [soonest, activated] = await Promise.all([
    prisma.automationRun.findFirst({
      where: { state: 'PENDING' },
      orderBy: { nextActionAt: 'asc' },
      select: { nextActionAt: true },
    }),
    prisma.automation.findMany({
      where: { enabled: true, activatedAt: { not: null } },
      select: { definition: true },
    }),
  ]);

  const at: number[] = [now.getTime() + BLIND_CEILING_MS];
  if (soonest?.nextActionAt) at.push(soonest.nextActionAt.getTime());
  for (const a of activated) {
    const trigger = (a.definition as unknown as AutomationDefinition).trigger;
    if (trigger.kind === 'SCHEDULE') at.push(nextDailyFireMs(now, trigger.everyDayAtMinutes));
  }
  return Math.min(...at);
}

/**
 * The goal sweep evaluates every open window, so it runs on its own clock rather than on
 * every write-triggered tick. Half an hour is how late a conversion may appear on
 * Results; overnight the hourly ceiling paces it instead, which costs no extra wake-up.
 */
const GOAL_SWEEP_MS = 30 * 60 * 1000;
let goalsSweptAt = 0;

export async function tick(now: Date = new Date()): Promise<void> {
  // The common case, and the whole point: no connection is opened.
  if (nextDueAt !== null && now.getTime() < nextDueAt) return;

  const ctx = prismaContext(now);
  try {
    const enrolled = await sweepEnrolments(ctx);
    const advanced = await runDue(ctx);
    let goals = { converted: 0, reversed: 0 };
    if (now.getTime() - goalsSweptAt >= GOAL_SWEEP_MS) {
      goals = await reconcileConversions(ctx);
      // Rides the same half-hourly pass, so it wakes the database no more often.
      await expireCoupons(now);
      goalsSweptAt = now.getTime();
    }
    const { converted, reversed } = goals;
    if (enrolled || advanced || converted || reversed) {
      logger.info(`[automations] enrolled ${enrolled} · advanced ${advanced} · converted ${converted} · reversed ${reversed}`);
    }
    nextDueAt = await computeNextDueAt(now);
  } catch (e) {
    // Never go blind on a failure — the next tick looks again.
    nextDueAt = null;
    logger.error(`[automations] tick failed: ${(e as Error).message}`);
  }
}
