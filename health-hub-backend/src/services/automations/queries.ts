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
    const isScheduled = def.trigger.kind === 'SCHEDULE';
    // A day sheet has no SEND step — it has a DAY_SHEET step that fans out to one
    // message per branch per night. Counting SEND alone reported "0 messages" on a
    // thing that sends every night.
    const messageCount = isScheduled
      ? def.steps.filter((s) => s.kind === 'DAY_SHEET').length * Math.max(1, a.branchIds.length)
      : def.steps.filter((s) => s.kind === 'SEND').length;
    return {
      id: a.id,
      key: a.key,
      name: a.name,
      group: a.group,
      enabled: a.enabled,
      version: a.version,
      activatedAt: a.activatedAt,
      status: a.enabled ? 'ACTIVE' : a.activatedAt ? 'PAUSED' : 'DRAFT',
      messageCount,
      kind: isScheduled ? ('SCHEDULE' as const) : ('JOURNEY' as const),
      everyDayAtMinutes: isScheduled
        ? (def.trigger as { everyDayAtMinutes: number }).everyDayAtMinutes
        : null,
      days,
      runs: total,
      live: mine.filter((c) => c.state === 'PENDING' || c.state === 'RUNNING')
        .reduce((n, c) => n + c._count._all, 0),
    };
  });
}

export interface FunnelRun {
  id: string;
  holdout: boolean;
  state: string;
  triggeredAt: Date;
  convertedAt: Date | null;
}

/** Messages that reached for the run's own patient. Staff alerts carry no patientId. */
export interface RunMessages {
  firstAt: Date;
  delivered: boolean;
  read: boolean;
}

/**
 * Where each patient got to, counted in PEOPLE, with every conversion placed on the
 * right side of the first message.
 *
 * A goal met before anything was sent is a walk-in the journey rightly stood aside for.
 * Filing it under "came in" below "Read" made the messages look like they had worked on
 * people who never received one. That split is a timeline question, so it holds for any
 * goal on any journey.
 */
const convertedWithin = (r: Pick<FunnelRun, 'convertedAt' | 'triggeredAt'>, windowDays: number) =>
  !!r.convertedAt && r.convertedAt.getTime() - r.triggeredAt.getTime() <= windowDays * DAY_MS;

export function journeyFunnel(runs: FunnelRun[], messages: Map<string, RunMessages>, windowDays: number) {
  const within = (r: FunnelRun) => convertedWithin(r, windowDays);
  const f = {
    messaged: 0, delivered: 0, read: 0, waiting: 0,
    beforeMessage: 0, afterMessage: 0, treatedConverted: 0, heldConverted: 0,
  };
  for (const r of runs) {
    if (r.holdout) {
      if (within(r)) f.heldConverted += 1;
      continue;
    }
    const m = messages.get(r.id);
    if (m) {
      f.messaged += 1;
      if (m.delivered) f.delivered += 1;
      if (m.read) f.read += 1;
    }
    if (within(r)) {
      f.treatedConverted += 1;
      if (m && r.convertedAt! >= m.firstAt) f.afterMessage += 1;
      else f.beforeMessage += 1;
    } else if (!m && (r.state === 'PENDING' || r.state === 'RUNNING')) {
      f.waiting += 1;
    }
  }
  return f;
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

  // A scheduled report has no audience, no control group and nothing to convert. The
  // only questions worth answering are "did last night go out" and "has any night
  // failed" — so it gets its own shape rather than a funnel full of zeroes.
  if (def.trigger.kind === 'SCHEDULE') return scheduledResults(a.id, a.version);

  const runs = await prisma.automationRun.findMany({
    where: { automationId },
    select: {
      id: true, holdout: true, state: true, stopReason: true, patientId: true,
      convertedAt: true, convertedBranchId: true, convertedValueInPaise: true,
      triggeredAt: true, branchId: true,
    },
  });

  // A suppressed row is a visit passed over because the patient already had a live
  // journey. It qualified, so it is counted as one — but it is not a journey, never
  // converts, and is always filed treated, so leaving it in the arms drags the treated
  // rate down against the held one.
  const journeys = runs.filter((r) => r.stopReason !== 'SUPPRESSED_ACTIVE_JOURNEY');
  const treated = journeys.filter((r) => !r.holdout);
  const held = journeys.filter((r) => r.holdout);

  const ids = runs.map((r) => r.id);
  const [patientMessages, suppressed] = await Promise.all([
    prisma.messageLog.findMany({
      where: { automationRunId: { in: ids }, patientId: { not: null }, status: { not: 'FAILED' } },
      select: { automationRunId: true, createdAt: true, deliveredAt: true, readAt: true },
    }),
    prisma.automationStepLog.groupBy({
      by: ['outcome'],
      where: { runId: { in: ids }, kind: { in: ['SUPPRESSED', 'DEFERRED'] } },
      _count: { _all: true },
    }),
  ]);

  const messages = new Map<string, RunMessages>();
  for (const m of patientMessages) {
    const prev = messages.get(m.automationRunId!);
    messages.set(m.automationRunId!, {
      firstAt: prev && prev.firstAt < m.createdAt ? prev.firstAt : m.createdAt,
      delivered: !!prev?.delivered || !!m.deliveredAt,
      read: !!prev?.read || !!m.readAt,
    });
  }
  const funnel = journeyFunnel(journeys, messages, def.goal.windowDays);

  const pT = treated.length ? funnel.treatedConverted / treated.length : 0;
  const pH = held.length ? funnel.heldConverted / held.length : 0;

  // Standard error of a difference of proportions. Printed because it tells the owner
  // what this design can and cannot detect — at these sample sizes a six-point lift is
  // visible and a two-point one is not.
  const se = Math.sqrt(
    (treated.length ? (pT * (1 - pT)) / treated.length : 0) +
    (held.length ? (pH * (1 - pH)) / held.length : 0),
  );

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

  // Without a held-back group there is nothing to subtract, and pH = 0 would present
  // every walk-in as caused. No number is the honest answer.
  const controlled = held.length > 0;
  const converted = journeys.filter((r) => r.convertedBranchId && convertedWithin(r, def.goal.windowDays));

  return {
    version: a.version,
    windowDays: def.goal.windowDays,
    /** What counts as converted. The screen words it; it never assumes what it is. */
    goal: def.goal,
    counts: {
      runs: runs.length,
      uniquePatients,
      treated: treated.length,
      held: held.length,
      /** Patients, not messages: a three-message journey is still one person reached. */
      messaged: funnel.messaged, delivered: funnel.delivered, read: funnel.read,
      /** No message yet and still live — not due, rather than dropped. */
      waiting: funnel.waiting,
      live: runs.filter((r) => r.state === 'PENDING' || r.state === 'RUNNING').length,
      ended: runs.filter((r) => r.state === 'STOPPED' || r.state === 'DONE' || r.state === 'FAILED').length,
    },
    /**
     * Window-based. `treated` includes walk-ins we did not cause — labelled, never called
     * "caused". before/after split it on the run's first message.
     */
    converted: {
      treated: funnel.treatedConverted, held: funnel.heldConverted,
      beforeMessage: funnel.beforeMessage, afterMessage: funnel.afterMessage,
    },
    rates: {
      treatedPct: +(pT * 100).toFixed(1),
      heldPct: +(pH * 100).toFixed(1),
      /** Of the patients a message actually went to. */
      afterMessagePct: funnel.messaged ? +((funnel.afterMessage / funnel.messaged) * 100).toFixed(1) : null,
      liftPts: controlled ? +((pT - pH) * 100).toFixed(1) : null,
      /** 95% interval on the lift. */
      liftMarginPts: controlled ? +(1.96 * se * 100).toFixed(1) : null,
      basis: 'HOLDOUT_DIFFERENCE',
    },
    skipped: suppressed.map((s) => ({ reason: s.outcome, count: s._count._all })),
    money: {
      couponsRedeemed: discountGiven._count._all,
      discountGivenInPaise: redeemedBills._sum.couponDiscountInPaise ?? 0,
      /** Estimated: lift × treated. Null without a control group — see `controlled`. */
      incrementalPatients: controlled ? Math.max(0, Math.round((pT - pH) * treated.length)) : null,
      messageCostInPaise: null as number | null,
      messageCostNote: 'No source of truth — Meta bills per conversation and we ingest no pricing data.',
    },
    branchSplit: {
      sameBranch: converted.filter((r) => r.convertedBranchId === r.branchId).length,
      otherBranch: converted.filter((r) => r.convertedBranchId !== r.branchId).length,
    },
  };
}

/** Nights, for a scheduled report. Built from the step log, which is what records them. */
async function scheduledResults(automationId: string, version: number) {
  const logs = await prisma.automationStepLog.findMany({
    where: { run: { automationId }, kind: { in: ['SEND', 'FAILED'] } },
    orderBy: { at: 'desc' },
    take: 200,
    select: {
      at: true, outcome: true, detail: true,
      run: { select: { cycleKey: true, branchId: true } },
    },
  });

  const branchIds = [...new Set(logs.map((l) => l.run.branchId).filter(Boolean))] as string[];
  const branches = await prisma.branch.findMany({
    where: { id: { in: branchIds } },
    select: { id: true, name: true },
  });
  const branchName = new Map(branches.map((b) => [b.id, b.name]));

  const byNight = new Map<string, { night: string; sent: number; failed: number; handedOver: number;
    branches: { branch: string; outcome: string; at: Date }[] }>();
  for (const l of logs) {
    const night = l.run.cycleKey;
    if (!byNight.has(night)) {
      byNight.set(night, { night, sent: 0, failed: 0, handedOver: 0, branches: [] });
    }
    const row = byNight.get(night)!;
    if (l.outcome === 'SENT') row.sent += 1;
    else if (l.outcome === 'ALREADY_SENT_BY_OLD_TICKER') row.handedOver += 1;
    else row.failed += 1;
    row.branches.push({
      branch: branchName.get(l.run.branchId ?? '') ?? 'Unknown branch',
      outcome: l.outcome,
      at: l.at,
    });
  }

  const nights = [...byNight.values()].sort((x, y) => (x.night < y.night ? 1 : -1)).slice(0, 14);
  return {
    kind: 'SCHEDULE' as const,
    version,
    nights,
    totals: {
      nightsRecorded: byNight.size,
      sent: nights.reduce((n, x) => n + x.sent, 0),
      failed: nights.reduce((n, x) => n + x.failed, 0),
      /// Nights the older sender got to first. Expected while both are live.
      handedOver: nights.reduce((n, x) => n + x.handedOver, 0),
    },
  };
}

/** The Activity list. */
export async function activity(filters: {
  automationId?: string; outcome?: string; patientId?: string; branchId?: string;
  days?: number; take?: number; cursor?: string;
}) {
  const since = new Date(Date.now() - (filters.days ?? 7) * DAY_MS);
  const take = Math.min(filters.take ?? 50, 200);
  const rows = await prisma.automationStepLog.findMany({
    where: {
      at: { gte: since },
      ...(filters.outcome ? { outcome: filters.outcome } : {}),
      run: {
        ...(filters.automationId ? { automationId: filters.automationId } : {}),
        ...(filters.patientId ? { patientId: filters.patientId } : {}),
        ...(filters.branchId ? { branchId: filters.branchId } : {}),
      },
    },
    orderBy: { at: 'desc' },
    // One extra row is the "is there more" answer, without a second count query.
    take: take + 1,
    ...(filters.cursor ? { cursor: { id: filters.cursor }, skip: 1 } : {}),
    select: {
      id: true, at: true, kind: true, outcome: true, stepIndex: true, detail: true,
      run: {
        select: {
          id: true, patientId: true, version: true, branchId: true,
          automation: { select: { name: true } },
        },
      },
    },
  });

  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  const patientIds = [...new Set(page.map((r) => r.run.patientId).filter(Boolean))] as string[];
  const patients = await prisma.patient.findMany({
    where: { id: { in: patientIds } },
    select: { id: true, name: true, patientNumber: true },
  });
  const byId = new Map(patients.map((p) => [p.id, p]));

  return {
    rows: page.map((r) => ({
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
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
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
