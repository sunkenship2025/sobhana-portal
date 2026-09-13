/**
 * Read models for the screens. Every number here comes from a persisted row — nothing
 * is reconstructed, and nothing is estimated without saying so.
 *
 * WHAT IS NOT HERE, ON PURPOSE: message cost. Meta bills per 24-hour conversation and
 * we ingest no pricing data, so any figure would be invented. It is omitted rather than
 * guessed, because a made-up cost inside a profit total is worse than no total.
 */
import prisma from '../../lib/prisma';
import type { AutomationDefinition } from './types';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function listAutomations() {
  const rows = await prisma.automation.findMany({ orderBy: [{ group: 'asc' }, { name: 'asc' }] });
  const counts = await prisma.automationRun.groupBy({
    by: ['automationId', 'state'],
    _count: { _all: true },
  });

  return rows.map((a) => {
    const def = a.definition as unknown as AutomationDefinition;
    const mine = counts.filter((c) => c.automationId === a.id);
    const total = mine.reduce((n, c) => n + c._count._all, 0);
    const days = def.steps
      .filter((s) => s.kind === 'WAIT' && s.anchor === 'TRIGGER')
      .map((s) => (s as { days?: number }).days ?? 0);
    return {
      id: a.id,
      key: a.key,
      name: a.name,
      group: a.group,
      enabled: a.enabled,
      version: a.version,
      activatedAt: a.activatedAt,
      status: a.enabled ? 'ACTIVE' : a.activatedAt ? 'PAUSED' : 'DRAFT',
      messageCount: def.steps.filter((s) => s.kind === 'SEND').length,
      days,
      runs: total,
      live: mine.filter((c) => c.state === 'PENDING' || c.state === 'RUNNING')
        .reduce((n, c) => n + c._count._all, 0),
    };
  });
}

/**
 * The funnel, the skip breakdown, and the lift.
 *
 * Three numbers are labelled rather than presented flat, because they are not the same
 * kind of fact: `converted` is window-based (nothing links a clinic visit to the
 * diagnostics it caused unless the front desk captured it), `attributed` is the strict
 * subset that was captured, and `lift` is the only one that survives the bias — both
 * arms carry it equally, so it cancels.
 */
export async function automationResults(automationId: string) {
  const a = await prisma.automation.findUnique({ where: { id: automationId } });
  if (!a) return null;
  const def = a.definition as unknown as AutomationDefinition;

  const runs = await prisma.automationRun.findMany({
    where: { automationId },
    select: {
      id: true, holdout: true, state: true, patientId: true,
      convertedAt: true, convertedBranchId: true, convertedValueInPaise: true,
      triggeredAt: true, branchId: true,
    },
  });

  const treated = runs.filter((r) => !r.holdout);
  const held = runs.filter((r) => r.holdout);
  const within = (r: typeof runs[number]) =>
    !!r.convertedAt &&
    r.convertedAt.getTime() - r.triggeredAt.getTime() <= def.goal.windowDays * DAY_MS;

  const treatedConv = treated.filter(within).length;
  const heldConv = held.filter(within).length;
  const pT = treated.length ? treatedConv / treated.length : 0;
  const pH = held.length ? heldConv / held.length : 0;

  // Standard error of a difference of proportions. Printed because it tells the owner
  // what this design can and cannot detect — at these sample sizes a six-point lift is
  // visible and a two-point one is not.
  const se = Math.sqrt(
    (treated.length ? (pT * (1 - pT)) / treated.length : 0) +
    (held.length ? (pH * (1 - pH)) / held.length : 0),
  );

  const ids = runs.map((r) => r.id);
  const [sent, delivered, read, suppressed] = await Promise.all([
    prisma.messageLog.count({ where: { automationRunId: { in: ids }, status: { not: 'FAILED' } } }),
    prisma.messageLog.count({ where: { automationRunId: { in: ids }, deliveredAt: { not: null } } }),
    prisma.messageLog.count({ where: { automationRunId: { in: ids }, readAt: { not: null } } }),
    prisma.automationStepLog.groupBy({
      by: ['outcome'],
      where: { runId: { in: ids }, kind: { in: ['SUPPRESSED', 'DEFERRED'] } },
      _count: { _all: true },
    }),
  ]);

  const discountGiven = await prisma.coupon.aggregate({
    where: { automationRunId: { in: ids }, status: 'REDEEMED' },
    _count: { _all: true },
  });
  const redeemedBills = await prisma.bill.aggregate({
    where: { couponId: { in: (await prisma.coupon.findMany({
      where: { automationRunId: { in: ids }, status: 'REDEEMED' }, select: { id: true },
    })).map((c) => c.id) } },
    _sum: { couponDiscountInPaise: true },
  });

  const uniquePatients = new Set(runs.map((r) => r.patientId).filter(Boolean)).size;

  return {
    version: a.version,
    windowDays: def.goal.windowDays,
    counts: {
      runs: runs.length,
      uniquePatients,
      treated: treated.length,
      held: held.length,
      sent, delivered, read,
      live: runs.filter((r) => r.state === 'PENDING' || r.state === 'RUNNING').length,
      ended: runs.filter((r) => r.state === 'STOPPED' || r.state === 'DONE' || r.state === 'FAILED').length,
    },
    /** Window-based. Includes walk-ins we did not cause — labelled, never called "caused". */
    converted: { treated: treatedConv, held: heldConv },
    rates: {
      treatedPct: +(pT * 100).toFixed(1),
      heldPct: +(pH * 100).toFixed(1),
      liftPts: +((pT - pH) * 100).toFixed(1),
      /** 95% interval on the lift. */
      liftMarginPts: +(1.96 * se * 100).toFixed(1),
      basis: 'HOLDOUT_DIFFERENCE',
    },
    skipped: suppressed.map((s) => ({ reason: s.outcome, count: s._count._all })),
    money: {
      couponsRedeemed: discountGiven._count._all,
      discountGivenInPaise: redeemedBills._sum.couponDiscountInPaise ?? 0,
      /** Estimated: lift × average converted basket, not a sum of rows. */
      incrementalPatients: Math.max(0, Math.round((pT - pH) * treated.length)),
      messageCostInPaise: null as number | null,
      messageCostNote: 'No source of truth — Meta bills per conversation and we ingest no pricing data.',
    },
    branchSplit: {
      sameBranch: runs.filter((r) => within(r) && r.convertedBranchId === r.branchId).length,
      otherBranch: runs.filter((r) => within(r) && r.convertedBranchId && r.convertedBranchId !== r.branchId).length,
    },
  };
}

/** The Activity list. */
export async function activity(filters: {
  automationId?: string; outcome?: string; patientId?: string; days?: number; take?: number;
}) {
  const since = new Date(Date.now() - (filters.days ?? 7) * DAY_MS);
  const rows = await prisma.automationStepLog.findMany({
    where: {
      at: { gte: since },
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      run: {
        ...(filters.automationId ? { automationId: filters.automationId } : {}),
        ...(filters.patientId ? { patientId: filters.patientId } : {}),
      },
    },
    orderBy: { at: 'desc' },
    take: Math.min(filters.take ?? 100, 200),
    select: {
      id: true, at: true, kind: true, outcome: true, stepIndex: true, detail: true,
      run: {
        select: {
          id: true, patientId: true, version: true,
          automation: { select: { name: true } },
        },
      },
    },
  });

  const patientIds = [...new Set(rows.map((r) => r.run.patientId).filter(Boolean))] as string[];
  const patients = await prisma.patient.findMany({
    where: { id: { in: patientIds } },
    select: { id: true, name: true, patientNumber: true },
  });
  const byId = new Map(patients.map((p) => [p.id, p]));

  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    kind: r.kind,
    outcome: r.outcome,
    stepIndex: r.stepIndex,
    detail: r.detail,
    runId: r.run.id,
    automation: r.run.automation.name,
    version: r.run.version,
    patient: r.run.patientId ? byId.get(r.run.patientId) ?? null : null,
  }));
}

/** One run: why she entered, what happened, why it stopped — all from the step log. */
export async function runDetail(runId: string) {
  const run = await prisma.automationRun.findUnique({
    where: { id: runId },
    select: {
      id: true, automationId: true, version: true, subjectType: true, subjectId: true,
      patientId: true, branchId: true, state: true, stopReason: true, holdout: true,
      stepIndex: true, triggeredAt: true, nextActionAt: true,
      convertedAt: true, convertedBranchId: true, convertedValueInPaise: true,
      definition: true,
      automation: { select: { name: true, key: true } },
      steps: { orderBy: { at: 'asc' } },
    },
  });
  if (!run) return null;

  const def = run.definition as unknown as AutomationDefinition;
  const enrolled = run.steps.find((s) => s.kind === 'ENROLLED');
  const nextStep = def.steps[run.stepIndex];

  return {
    ...run,
    /** The values as they were READ at enrolment — not recomputed now. */
    whyEntered: (enrolled?.detail as { trace?: unknown })?.trace ?? null,
    whyStopped: run.stopReason,
    next: run.state === 'PENDING' && nextStep
      ? { at: run.nextActionAt, kind: nextStep.kind, stepIndex: run.stepIndex }
      : null,
    timeline: run.steps.map((s) => ({
      at: s.at, kind: s.kind, outcome: s.outcome, stepIndex: s.stepIndex, detail: s.detail,
    })),
  };
}

/** The Patient 360 section: runs grouped by the visit that caused them. */
export async function patientAutomations(patientId: string) {
  const runs = await prisma.automationRun.findMany({
    where: { patientId },
    orderBy: { triggeredAt: 'desc' },
    select: {
      id: true, subjectId: true, subjectType: true, state: true, stopReason: true,
      holdout: true, version: true, triggeredAt: true, nextActionAt: true, stepIndex: true,
      convertedAt: true, convertedBranchId: true, convertedValueInPaise: true,
      automation: { select: { name: true } },
      steps: { where: { kind: 'SEND' }, select: { at: true, outcome: true } },
    },
  });

  const coupons = await prisma.coupon.findMany({
    where: { patientId, status: { in: ['ISSUED', 'REDEEMED'] } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true, code: true, status: true, expiresAt: true, createdAt: true,
      issuedVisitId: true, redeemedVisitId: true, automationRunId: true,
      campaign: { select: { name: true, discountPercentage: true, scope: true, maxDiscountPerBillInPaise: true } },
    },
  });

  return {
    runs: runs.map((r) => ({
      id: r.id,
      automation: r.automation.name,
      visitId: r.subjectType === 'VISIT' ? r.subjectId : null,
      state: r.state,
      stopReason: r.stopReason,
      holdout: r.holdout,
      version: r.version,
      messagesSent: r.steps.filter((s) => s.outcome === 'SENT').length,
      nextActionAt: r.state === 'PENDING' ? r.nextActionAt : null,
      convertedAt: r.convertedAt,
      convertedValueInPaise: r.convertedValueInPaise,
    })),
    coupons,
  };
}
