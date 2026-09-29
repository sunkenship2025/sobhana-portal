/**
 * Dry run and simulation.
 *
 * The dry run answers "who matches, and who would actually be messaged today" using
 * the SAME resolver the send path uses — so the preview cannot promise something the
 * sender would refuse. Its valuable half is the suppression breakdown, not the match
 * count.
 *
 * The simulation answers "what happens if she does her tests on Day 6" — a fact that
 * is not in the database. It is only possible because predicates read through an
 * injectable context: the live one in production, an overlay here.
 */
import prisma from '../../lib/prisma';
import { prismaContext, memoryContext, type VisitFacts, type FactSet } from './context';
import { evaluate, type EvalTrace, type Subject } from './predicates';
import { communicationPolicy } from './policy';
import { TRIGGERS } from './triggers';
import { isHeldOut } from './engine';
import type { AutomationDefinition, Step } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PreviewRow {
  visitId: string;
  patientId: string;
  patientName: string;
  patientNumber: string;
  branchName: string;
  visitAt: Date;
  whyQualifies: EvalTrace[];
  todayOutcome: 'WOULD_SEND' | 'HELD_OUT' | string;
}

export async function dryRun(automationId: string, limit = 20) {
  const a = await prisma.automation.findUnique({ where: { id: automationId } });
  if (!a) return null;
  const def = a.definition as unknown as AutomationDefinition;
  const ctx = prismaContext(new Date());

  // Every trigger is previewed by ITS OWN subject finder — the same code that enrols real
  // patients — so the preview cannot disagree with what activation does. This used to
  // know only "a visit is completed" and answer every other trigger with zeros, which the
  // screen showed as "nobody matches".
  const trigger = def.trigger.kind === 'SCHEDULE' ? undefined : TRIGGERS[def.trigger.kind];
  if (!trigger) {
    return { supported: false, subjectType: null, qualifyingVisits: 0, uniquePatients: 0, wouldSendToday: 0, breakdown: {}, rows: [] };
  }

  // Look back a sensible window rather than the whole history: this is "who would
  // enrol from here", and the watermark means history is never back-filled anyway.
  const now = new Date();
  const candidates = await trigger.findSubjects({
    now, since: new Date(now.getTime() - 30 * DAY_MS), branchIds: a.branchIds,
    config: def.trigger as Record<string, unknown>, limit: 500,
  });
  const patientIds = [...new Set(candidates.map((c) => c.patientId).filter((x): x is string => !!x))];
  const branchIds = [...new Set(candidates.map((c) => c.branchId).filter((x): x is string => !!x))];
  const [people, branches] = await Promise.all([
    prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, name: true, patientNumber: true } }),
    prisma.branch.findMany({ where: { id: { in: branchIds } }, select: { id: true, name: true } }),
  ]);

  // The first message someone is actually sent decides whose rules apply today: a
  // message to the team or the referring doctor is not held by patient consent or hours.
  const firstMessage = def.steps.find(
    (s): s is Extract<Step, { kind: 'SEND' | 'ASK' }> => s.kind === 'SEND' || s.kind === 'ASK');
  const toTeam = firstMessage?.kind === 'SEND' && !!firstMessage.to && firstMessage.to.kind !== 'RUN_PATIENT';

  const breakdown: Record<string, number> = {};
  const rows: PreviewRow[] = [];
  const patients = new Set<string>();
  let qualifying = 0;
  let wouldSend = 0;

  for (const c of candidates) {
    const subject: Subject = {
      type: trigger.subjectType, id: c.subjectId, patientId: c.patientId, branchId: c.branchId, triggeredAt: c.triggeredAt,
    };
    const trace: EvalTrace[] = [];
    let ok = false;
    try {
      ok = await evaluate(def.audience, ctx, subject, trace);
    } catch {
      continue;
    }
    if (!ok) continue;

    qualifying += 1;
    if (c.patientId) patients.add(c.patientId);

    let outcome: PreviewRow['todayOutcome'];
    if (c.patientId && isHeldOut(a.id, c.patientId, a.holdoutPct)) {
      outcome = 'HELD_OUT';
    } else if (!c.patientId || toTeam || !firstMessage) {
      outcome = 'WOULD_SEND';
    } else {
      const p = await ctx.patient(c.patientId);
      const decision = await communicationPolicy(ctx, {
        patientId: c.patientId,
        phone: p?.phone ?? null,
        intent: firstMessage.intent ?? 'PROACTIVE',
        runId: 'preview',
        visitId: trigger.subjectType === 'VISIT' ? c.subjectId : null,
        skipMarketingConsent: def.policy?.skipMarketingConsent,
      });
      outcome = decision.kind === 'SEND' ? 'WOULD_SEND' : decision.reason;
    }
    if (outcome === 'WOULD_SEND') wouldSend += 1;
    breakdown[outcome] = (breakdown[outcome] ?? 0) + 1;

    if (rows.length < limit) {
      const person = people.find((x) => x.id === c.patientId);
      rows.push({
        visitId: c.subjectId,
        patientId: c.patientId ?? '',
        patientName: person?.name ?? '—',
        patientNumber: person?.patientNumber ?? '',
        branchName: branches.find((x) => x.id === c.branchId)?.name ?? '',
        visitAt: c.triggeredAt,
        whyQualifies: trace,
        todayOutcome: outcome,
      });
    }
  }

  return {
    supported: true,
    /** VISIT journeys can be tried out in the simulator; others cannot yet. */
    subjectType: trigger.subjectType,
    qualifyingVisits: qualifying,
    uniquePatients: patients.size,
    wouldSendToday: wouldSend,
    breakdown,
    rows,
  };
}

// ────────────────────────────────────────────────────────────────────────────

export interface SimulatedEvent {
  /** Days after the trigger. */
  onDay: number;
  /**
   * REPLIED is what makes a branching journey simulable at all.
   *
   * Without it the walk stopped at the first ASK — which for the recovery journey is
   * the Day 2 offer, so the operator could see the question and nothing after it: not
   * the coupon, not the reminder, not the two different things Day 5 says. The branch
   * the automation exists for was the one part that could not be previewed.
   *
   * `payload` names the button. Absent = they replied with something that matched
   * nothing, which is the handoff path.
   */
  kind: 'DIAGNOSTICS_DONE' | 'REPLIED';
  payload?: string;
  valueInPaise?: number;
  branchId?: string;
}

export interface SimulatedStep {
  day: number;
  at: Date;
  kind: Step['kind'];
  outcome: string;
  detail?: unknown;
}

/**
 * Walk the journey on a fake clock, with hypothetical facts layered in.
 *
 * This is the offline harness with a screen on it — the same code path the tests use,
 * which is the only reason its answer can be trusted to match production.
 */
export async function simulate(
  definition: AutomationDefinition,
  seed: {
    patientId: string; visitId: string; branchId: string;
    triggeredAt: Date; marketingOptIn: boolean; phone: string | null;
    yearOfBirth: number; gender: string; visitValueInPaise: number;
  },
  events: SimulatedEvent[],
): Promise<SimulatedStep[]> {
  const out: SimulatedStep[] = [];
  const triggerVisit: VisitFacts = {
    id: seed.visitId, patientId: seed.patientId, branchId: seed.branchId,
    // The kind of visit the trigger watches; "any visit" is walked as a clinic one.
    domain: (definition.trigger as { domain?: string }).domain === 'DIAGNOSTICS' ? 'DIAGNOSTICS' : 'CLINIC',
    status: 'COMPLETED', totalAmountInPaise: seed.visitValueInPaise,
    createdAt: seed.triggeredAt, sourceVisitId: null, patientLinkDisabledAt: null,
  };

  const injected: VisitFacts[] = events
    .filter((e) => e.kind === 'DIAGNOSTICS_DONE')
    .map((e, i) => ({
      id: `sim-dx-${i}`, patientId: seed.patientId, branchId: e.branchId ?? seed.branchId,
      domain: 'DIAGNOSTICS', status: 'COMPLETED',
      totalAmountInPaise: e.valueInPaise ?? 0,
      createdAt: new Date(seed.triggeredAt.getTime() + e.onDay * DAY_MS),
      sourceVisitId: seed.visitId, patientLinkDisabledAt: null,
    }));

  let clock = new Date(seed.triggeredAt);
  let stepIndex = 0;
  let guard = 0;
  /**
   * A coupon this walk has handed out. Without it `couponState` reads null forever and
   * the Day 5 fork always takes the "she never claimed" arm — so the branch that tells
   * a holder of a code from someone who ignored the offer could not be previewed even
   * once the walk got that far.
   */
  let issuedState: string | null = null;
  /** A reply is used up by the question it answers. She replied once, not to each ASK. */
  const spent = new Set<SimulatedEvent>();

  while (stepIndex < definition.steps.length && guard++ < 100) {
    const step = definition.steps[stepIndex];
    // Only facts that have HAPPENED by the simulated clock are visible, which is what
    // makes "she converted on Day 6" change the Day 10 answer and not the Day 2 one.
    const ctx = memoryContext({
      now: clock,
      visits: [triggerVisit, ...injected.filter((v) => v.createdAt <= clock)],
      ...(issuedState ? { couponStateByRun: { sim: issuedState } } : {}),
      patients: [{
        id: seed.patientId, yearOfBirth: seed.yearOfBirth, gender: seed.gender,
        phone: seed.phone, marketingOptIn: seed.marketingOptIn, deceasedAt: null,
      }],
    } satisfies FactSet);

    const subject: Subject = {
      type: 'VISIT', id: seed.visitId, patientId: seed.patientId,
      branchId: seed.branchId, triggeredAt: seed.triggeredAt, runId: 'sim',
    };
    const day = Math.round((clock.getTime() - seed.triggeredAt.getTime()) / DAY_MS);

    if (step.kind === 'WAIT') {
      clock = step.anchor === 'TRIGGER'
        ? new Date(seed.triggeredAt.getTime() + (step.days ?? 0) * DAY_MS + (step.hours ?? 0) * 3600_000)
        : new Date(clock.getTime() + (step.days ?? 0) * DAY_MS + (step.hours ?? 0) * 3600_000);
      out.push({ day, at: clock, kind: 'WAIT', outcome: 'WAITING' });
      stepIndex += 1;
      continue;
    }

    if (step.kind === 'CHECK') {
      const trace: EvalTrace[] = [];
      const hit = await evaluate(step.condition, ctx, subject, trace);
      out.push({ day, at: clock, kind: 'CHECK', outcome: hit ? 'CHECK_TRUE' : 'CHECK_FALSE', detail: trace });

      // This honoured `onTrue === 'STOP'` and nothing else — no numeric jump, and
      // `onFalse` not at all. So a journey that forks was walked straight down the
      // middle: the Day 5 fork appeared to send BOTH the reminder-with-a-code and the
      // claim-a-code question, which is a sequence that can never actually happen.
      // The one tool meant to build confidence before activating was showing a path
      // the engine would never take.
      const go = hit ? step.onTrue : (step.onFalse ?? 'CONTINUE');
      if (go === 'STOP') {
        out.push({ day, at: clock, kind: 'STOP', outcome: step.stopReason ?? 'STOPPED_GOAL_MET' });
        return out;
      }
      stepIndex = typeof go === 'number' ? go : stepIndex + 1;
      continue;
    }

    // "When it stops", before anything that reaches the patient — as the engine does.
    if ((step.kind === 'SEND' || step.kind === 'ASK') && definition.goal
        && clock.getTime() - seed.triggeredAt.getTime() <= definition.goal.windowDays * DAY_MS
        && (await evaluate(definition.goal.condition, ctx, subject).catch(() => false))) {
      out.push({ day, at: clock, kind: 'STOP', outcome: definition.goal.stopReason ?? 'STOPPED_GOAL_MET' });
      return out;
    }

    if (step.kind === 'SEND') {
      const decision = await communicationPolicy(ctx, {
        patientId: seed.patientId, phone: seed.phone, intent: step.intent, runId: 'sim', visitId: seed.visitId,
        // As the engine does: a service follow-up is not held back for offer consent. The
        // walk said "not agreed to offers" for patients the real journey messages.
        skipMarketingConsent: definition.policy?.skipMarketingConsent,
      });
      const sent = decision.kind === 'SEND';
      // One coupon per RUN however many steps ask for one — the same rule the engine
      // enforces with a partial unique index.
      const fresh = sent && step.issueOffer && !issuedState;
      if (fresh) issuedState = 'ISSUED';
      out.push({
        day, at: clock, kind: 'SEND',
        outcome: sent ? 'SENT' : decision.reason,
        detail: {
          template: step.template,
          offer: fresh ? step.issueOffer!.campaignId : null,
          reusedExistingCoupon: Boolean(sent && step.issueOffer && !fresh),
        },
      });
      stepIndex += 1;
      continue;
    }

    if (step.kind === 'DAY_SHEET') {
      // Simulation is about patient journeys; a day sheet has no patient and no
      // condition to try out. Shown, then done.
      out.push({ day, at: clock, kind: 'DAY_SHEET', outcome: 'SENT', detail: { domain: step.domain } });
      stepIndex += 1;
      continue;
    }

    if (step.kind === 'ASK') {
      const decision = await communicationPolicy(ctx, {
        patientId: seed.patientId, phone: seed.phone, intent: step.intent,
        runId: 'sim', visitId: seed.visitId,
        skipMarketingConsent: definition.policy?.skipMarketingConsent,
      });
      if (decision.kind !== 'SEND') {
        out.push({ day, at: clock, kind: 'ASK', outcome: decision.reason,
          detail: { template: step.template } });
        stepIndex += 1;
        continue;
      }

      const waitHours = step.waitHours ?? 24;
      const deadline = new Date(clock.getTime() + waitHours * 3600_000);
      // A reply only counts if it lands inside the window the line is held for.
      const reply = events.find((e) =>
        e.kind === 'REPLIED' && !spent.has(e) &&
        new Date(seed.triggeredAt.getTime() + e.onDay * DAY_MS) >= clock &&
        new Date(seed.triggeredAt.getTime() + e.onDay * DAY_MS) <= deadline);
      if (reply) spent.add(reply);

      out.push({
        day, at: clock, kind: 'ASK',
        outcome: reply ? 'REPLIED' : 'NO_REPLY',
        detail: {
          template: step.template,
          buttons: step.buttons.map((b) => b.label),
          answered: reply?.payload ?? null,
          waitHours,
        },
      });

      if (!reply) {
        // Silence. A DIFFERENT question from an unmatched reply, and the reason this
        // journey does not hand the code to someone who ignored the offer.
        const go = step.onNoReply;
        if (go === 'STOP') { out.push({ day, at: clock, kind: 'STOP', outcome: 'STOPPED_BY_STEP' }); return out; }
        clock = new Date(deadline);
        stepIndex = typeof go === 'number' ? go : stepIndex + 1;
        continue;
      }

      clock = new Date(seed.triggeredAt.getTime() + reply.onDay * DAY_MS);
      const matched = step.buttons.find((b) => b.payload === reply.payload)
        ?? step.keywords?.find((k) => k.match === reply.payload);
      if (matched) {
        if (matched.goTo === 'STOP') {
          out.push({ day, at: clock, kind: 'STOP', outcome: matched.stopReason ?? 'STOPPED_BY_STEP' });
          return out;
        }
        stepIndex = matched.goTo;
        continue;
      }
      // They typed something nobody anticipated.
      if (step.onUnmatched === 'HANDOFF') {
        out.push({ day, at: clock, kind: 'HANDOFF', outcome: 'HANDED_TO_STAFF' });
        return out;
      }
      if (step.onUnmatched === 'STOP') {
        out.push({ day, at: clock, kind: 'STOP', outcome: 'STOPPED_BY_STEP' });
        return out;
      }
      stepIndex += 1;
      continue;
    }
    if (step.kind === 'HANDOFF') {
      out.push({ day, at: clock, kind: 'HANDOFF', outcome: 'HANDED_TO_STAFF' });
      return out;
    }

    out.push({ day, at: clock, kind: 'STOP', outcome: step.reason });
    return out;
  }
  return out;
}
