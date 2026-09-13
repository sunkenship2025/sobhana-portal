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

  if (def.trigger.kind !== 'VISIT_COMPLETED') {
    return { qualifyingVisits: 0, uniquePatients: 0, wouldSendToday: 0, breakdown: {}, rows: [] };
  }

  // Look back a sensible window rather than the whole history: this is "who would
  // enrol from here", and the watermark means history is never back-filled anyway.
  const since = new Date(Date.now() - 30 * DAY_MS);
  const candidates = await prisma.visit.findMany({
    where: {
      domain: def.trigger.domain,
      status: 'COMPLETED',
      updatedAt: { gte: since },
      ...(a.branchIds.length > 0 ? { branchId: { in: a.branchIds } } : {}),
    },
    select: {
      id: true, patientId: true, branchId: true, updatedAt: true,
      patient: { select: { name: true, patientNumber: true } },
      branch: { select: { name: true } },
    },
    orderBy: { updatedAt: 'desc' },
    take: 500,
  });

  const breakdown: Record<string, number> = {};
  const rows: PreviewRow[] = [];
  const patients = new Set<string>();
  let qualifying = 0;
  let wouldSend = 0;

  for (const v of candidates) {
    const subject: Subject = {
      type: 'VISIT', id: v.id, patientId: v.patientId, branchId: v.branchId, triggeredAt: v.updatedAt,
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
    patients.add(v.patientId);

    let outcome: PreviewRow['todayOutcome'];
    if (isHeldOut(a.id, v.patientId, a.holdoutPct)) {
      outcome = 'HELD_OUT';
    } else {
      const firstSend = def.steps.find((s): s is Extract<Step, { kind: 'SEND' }> => s.kind === 'SEND');
      const p = await ctx.patient(v.patientId);
      const decision = await communicationPolicy(ctx, {
        patientId: v.patientId,
        phone: p?.phone ?? null,
        intent: firstSend?.intent ?? 'PROACTIVE',
        runId: 'preview',
        visitId: v.id,
      });
      outcome = decision.kind === 'SEND' ? 'WOULD_SEND' : decision.reason;
      if (decision.kind === 'SEND') wouldSend += 1;
    }
    breakdown[outcome] = (breakdown[outcome] ?? 0) + 1;

    if (rows.length < limit) {
      rows.push({
        visitId: v.id,
        patientId: v.patientId,
        patientName: v.patient.name,
        patientNumber: v.patient.patientNumber,
        branchName: v.branch.name,
        visitAt: v.updatedAt,
        whyQualifies: trace,
        todayOutcome: outcome,
      });
    }
  }

  return {
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
  kind: 'DIAGNOSTICS_DONE';
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
    domain: 'CLINIC', status: 'COMPLETED', totalAmountInPaise: seed.visitValueInPaise,
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

  while (stepIndex < definition.steps.length && guard++ < 100) {
    const step = definition.steps[stepIndex];
    // Only facts that have HAPPENED by the simulated clock are visible, which is what
    // makes "she converted on Day 6" change the Day 10 answer and not the Day 2 one.
    const ctx = memoryContext({
      now: clock,
      visits: [triggerVisit, ...injected.filter((v) => v.createdAt <= clock)],
      patients: [{
        id: seed.patientId, yearOfBirth: seed.yearOfBirth, gender: seed.gender,
        phone: seed.phone, marketingOptIn: seed.marketingOptIn, deceasedAt: null,
      }],
    } satisfies FactSet);

    const subject: Subject = {
      type: 'VISIT', id: seed.visitId, patientId: seed.patientId,
      branchId: seed.branchId, triggeredAt: seed.triggeredAt,
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
      if (hit && step.onTrue === 'STOP') {
        out.push({ day, at: clock, kind: 'STOP', outcome: step.stopReason ?? 'STOPPED_GOAL_MET' });
        return out;
      }
      stepIndex += 1;
      continue;
    }

    if (step.kind === 'SEND') {
      const decision = await communicationPolicy(ctx, {
        patientId: seed.patientId, phone: seed.phone, intent: step.intent, runId: 'sim', visitId: seed.visitId,
      });
      out.push({
        day, at: clock, kind: 'SEND',
        outcome: decision.kind === 'SEND' ? 'SENT' : decision.reason,
        detail: { template: step.template, offer: step.issueOffer?.campaignId ?? null },
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
      out.push({ day, at: clock, kind: 'ASK', outcome: 'ASKED',
        detail: { template: step.template, buttons: step.buttons.map((b) => b.label) } });
      // A simulation cannot know what someone would tap, so it shows the question and
      // stops rather than inventing an answer.
      return out;
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
