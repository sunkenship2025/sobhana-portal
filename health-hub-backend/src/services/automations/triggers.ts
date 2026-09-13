/**
 * What can START an automation — a registry, not an if-chain.
 *
 * The sweep used to read `if (kind === 'SCHEDULE') … if (kind !== 'VISIT_COMPLETED')
 * continue`, so every new kind of automation meant editing the engine. That is the same
 * shape of problem as hardcoding predicates in React: the thing that should be data was
 * control flow.
 *
 * A trigger says how to find subjects that have become eligible since the watermark.
 * The engine does not know what any of them mean.
 *
 * ONE OF THESE IS WORTH MORE THAN THE REST. `AUDIENCE_SWEEP` re-asks the audience
 * question on a period instead of waiting for an event, which is how "nobody has seen
 * them in 90 days", "lifetime spend over ₹25,000" and "five or more visits" all become
 * ordinary automations. Without it each of those wants its own trigger, and there is no
 * end to that list.
 */
import prisma from '../../lib/prisma';
import type { SubjectType } from './types';

export interface Candidate {
  subjectId: string;
  patientId: string | null;
  branchId: string | null;
  /** Anchors every wait and the conversion window. */
  triggeredAt: Date;
  /** Overrides the re-entry cycle key where the trigger owns the period. */
  cycleKey?: string;
}

export interface TriggerContext {
  now: Date;
  /** Nothing before this enrolled — the activation watermark. */
  since: Date;
  branchIds: string[];
  /** Trigger-specific settings from the definition. */
  config: Record<string, unknown>;
  limit: number;
}

export interface TriggerDef {
  kind: string;
  label: string;
  group: string;
  subjectType: SubjectType;
  /** Shown in the UI so an operator knows what the automation reacts to. */
  describe: (config: Record<string, unknown>) => string;
  findSubjects: (ctx: TriggerContext) => Promise<Candidate[]>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const str = (c: Record<string, unknown>, k: string, d: string) =>
  typeof c[k] === 'string' ? (c[k] as string) : d;
const num = (c: Record<string, unknown>, k: string, d: number) => {
  const n = Number(c[k]);
  return Number.isFinite(n) ? n : d;
};

const visitSelect = {
  id: true, patientId: true, branchId: true, updatedAt: true,
} as const;

export const TRIGGERS: Record<string, TriggerDef> = {
  VISIT_COMPLETED: {
    kind: 'VISIT_COMPLETED',
    label: 'A visit is completed',
    group: 'Visits',
    subjectType: 'VISIT',
    describe: (c) => `A ${str(c, 'domain', 'CLINIC') === 'CLINIC' ? 'clinic' : 'diagnostic'} visit is completed`,
    async findSubjects({ since, branchIds, config, limit }) {
      const rows = await prisma.visit.findMany({
        where: {
          domain: str(config, 'domain', 'CLINIC') as 'CLINIC' | 'DIAGNOSTICS',
          status: 'COMPLETED',
          updatedAt: { gte: since },
          ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
        },
        select: visitSelect,
        orderBy: { updatedAt: 'asc' },
        take: limit,
      });
      return rows.map((v) => ({
        subjectId: v.id, patientId: v.patientId, branchId: v.branchId, triggeredAt: v.updatedAt,
      }));
    },
  },

  VISIT_CANCELLED: {
    kind: 'VISIT_CANCELLED',
    label: 'A visit is cancelled',
    group: 'Visits',
    subjectType: 'VISIT',
    describe: (c) => `A ${str(c, 'domain', 'CLINIC') === 'CLINIC' ? 'clinic' : 'diagnostic'} visit is cancelled`,
    async findSubjects({ since, branchIds, config, limit }) {
      const rows = await prisma.visit.findMany({
        where: {
          domain: str(config, 'domain', 'CLINIC') as 'CLINIC' | 'DIAGNOSTICS',
          status: 'CANCELLED',
          updatedAt: { gte: since },
          ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
        },
        select: visitSelect,
        orderBy: { updatedAt: 'asc' },
        take: limit,
      });
      return rows.map((v) => ({
        subjectId: v.id, patientId: v.patientId, branchId: v.branchId, triggeredAt: v.updatedAt,
      }));
    },
  },

  CLINIC_NO_SHOW: {
    kind: 'CLINIC_NO_SHOW',
    label: 'Someone queued and was never seen',
    group: 'Visits',
    subjectType: 'VISIT',
    describe: (c) => `Waiting for more than ${num(c, 'hours', 6)} hours and never called in`,
    async findSubjects({ now, since, branchIds, config, limit }) {
      // There is no no-show event anywhere. It is the ABSENCE of a transition: queued,
      // never moved to in-progress, and enough time has passed that it is not going to.
      const cutoff = new Date(now.getTime() - num(config, 'hours', 6) * 60 * 60 * 1000);
      const rows = await prisma.clinicVisit.findMany({
        where: {
          status: 'WAITING',
          startedAt: null,
          createdAt: { gte: since, lte: cutoff },
          ...(branchIds.length ? { visit: { branchId: { in: branchIds } } } : {}),
        },
        select: {
          createdAt: true,
          visit: { select: visitSelect },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      return rows.map((r) => ({
        subjectId: r.visit.id, patientId: r.visit.patientId,
        branchId: r.visit.branchId, triggeredAt: r.createdAt,
      }));
    },
  },

  PATIENT_REGISTERED: {
    kind: 'PATIENT_REGISTERED',
    label: 'A patient is registered',
    group: 'Patients',
    subjectType: 'PATIENT',
    describe: () => 'A patient is registered for the first time',
    async findSubjects({ since, limit }) {
      const rows = await prisma.patient.findMany({
        where: { createdAt: { gte: since } },
        select: { id: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      return rows.map((p) => ({
        subjectId: p.id, patientId: p.id, branchId: null, triggeredAt: p.createdAt,
      }));
    },
  },

  REPORT_FINALIZED: {
    kind: 'REPORT_FINALIZED',
    label: 'A report is finalized',
    group: 'Reports',
    subjectType: 'VISIT',
    describe: () => 'A report is finalized',
    async findSubjects({ since, branchIds, limit }) {
      // Subject is the VISIT, not the version — that is what "was this opened" and
      // "what was billed" are both about, and it keeps one run per visit.
      const rows = await prisma.reportVersion.findMany({
        where: {
          status: 'FINALIZED',
          finalizedAt: { gte: since },
          ...(branchIds.length ? { report: { visit: { branchId: { in: branchIds } } } } : {}),
        },
        select: {
          finalizedAt: true,
          report: { select: { visit: { select: visitSelect } } },
        },
        orderBy: { finalizedAt: 'asc' },
        take: limit,
      });
      return rows
        .filter((r) => r.report?.visit)
        .map((r) => ({
          subjectId: r.report.visit.id,
          patientId: r.report.visit.patientId,
          branchId: r.report.visit.branchId,
          triggeredAt: r.finalizedAt ?? r.report.visit.updatedAt,
        }));
    },
  },

  COUPON_ISSUED: {
    kind: 'COUPON_ISSUED',
    label: 'An offer is issued',
    group: 'Offers',
    subjectType: 'COUPON',
    describe: () => 'An offer is issued to a patient',
    async findSubjects({ since, limit }) {
      const rows = await prisma.coupon.findMany({
        where: { status: 'ISSUED', createdAt: { gte: since } },
        select: { id: true, patientId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      return rows.map((c) => ({
        subjectId: c.id, patientId: c.patientId, branchId: null, triggeredAt: c.createdAt,
      }));
    },
  },

  VISIT_CREATED: {
    kind: 'VISIT_CREATED',
    label: 'A visit is registered',
    group: 'Visits',
    subjectType: 'VISIT',
    describe: (c) => `A ${str(c, 'domain', 'DIAGNOSTICS') === 'CLINIC' ? 'clinic' : 'diagnostic'} visit is registered`,
    async findSubjects({ since, branchIds, config, limit }) {
      const rows = await prisma.visit.findMany({
        where: {
          domain: str(config, 'domain', 'DIAGNOSTICS') as 'CLINIC' | 'DIAGNOSTICS',
          status: { not: 'CANCELLED' },
          createdAt: { gte: since },
          ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
        },
        select: { ...visitSelect, createdAt: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      return rows.map((v) => ({
        subjectId: v.id, patientId: v.patientId, branchId: v.branchId, triggeredAt: v.createdAt,
      }));
    },
  },

  PAYMENT_RECEIVED: {
    kind: 'PAYMENT_RECEIVED',
    label: 'A bill is paid',
    group: 'Money',
    subjectType: 'VISIT',
    describe: () => 'A bill is settled in full',
    async findSubjects({ since, branchIds, limit }) {
      const rows = await prisma.bill.findMany({
        where: {
          paymentStatus: 'PAID',
          updatedAt: { gte: since },
          ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
        },
        select: { updatedAt: true, visit: { select: visitSelect } },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      });
      return rows.map((b) => ({
        subjectId: b.visit.id, patientId: b.visit.patientId,
        branchId: b.visit.branchId, triggeredAt: b.updatedAt,
      }));
    },
  },

  PAYMENT_REFUNDED: {
    kind: 'PAYMENT_REFUNDED',
    label: 'Money is refunded',
    group: 'Money',
    subjectType: 'VISIT',
    describe: () => 'A refund is processed, in full or in part',
    async findSubjects({ since, branchIds, limit }) {
      const rows = await prisma.bill.findMany({
        where: {
          paymentStatus: { in: ['REFUNDED', 'PARTIALLY_REFUNDED'] },
          refundedAt: { gte: since },
          ...(branchIds.length ? { branchId: { in: branchIds } } : {}),
        },
        select: { refundedAt: true, visit: { select: visitSelect } },
        orderBy: { refundedAt: 'asc' },
        take: limit,
      });
      return rows.map((b) => ({
        subjectId: b.visit.id, patientId: b.visit.patientId,
        branchId: b.visit.branchId, triggeredAt: b.refundedAt ?? b.visit.updatedAt,
      }));
    },
  },

  /**
   * An offer running out of money. The subject is the CAMPAIGN, not a patient — nobody
   * is being messaged about their own care here, the centre is being told its budget is
   * going. Pair it with a SEND addressed to a role.
   */
  CAMPAIGN_BUDGET: {
    kind: 'CAMPAIGN_BUDGET',
    label: 'An offer is running out of budget',
    group: 'Offers',
    subjectType: 'COUPON',
    describe: (c) => `An offer passes ${num(c, 'atPercent', 80)}% of its budget`,
    async findSubjects({ now, config, limit }) {
      const atPercent = Math.min(100, Math.max(1, num(config, 'atPercent', 80)));
      const campaigns = await prisma.couponCampaign.findMany({
        where: { isActive: true, maxDiscountBudgetInPaise: { not: null } },
        select: {
          id: true, maxDiscountBudgetInPaise: true,
          reservedInPaise: true, committedInPaise: true,
        },
        take: limit,
      });
      // Reserved counts: a promise already made is money already gone as far as the
      // budget is concerned, which is the whole reason both numbers are tracked.
      return campaigns
        .filter((c) => {
          const used = c.reservedInPaise + c.committedInPaise;
          return used >= ((c.maxDiscountBudgetInPaise ?? 0) * atPercent) / 100;
        })
        .map((c) => ({
          subjectId: c.id, patientId: null, branchId: null, triggeredAt: now,
          // Once per campaign per threshold — not every tick for the rest of its life.
          cycleKey: `budget-${atPercent}`,
        }));
    },
  },

  /**
   * The one that removes a whole category of would-be triggers.
   *
   * Re-asks the audience question every so often instead of waiting for something to
   * happen. "No visit in 90 days", "lifetime spend over ₹25,000", "five or more visits",
   * "returned after a long gap" — none of these are events, they are states, and a state
   * has no moment to fire on. Without this each one wants a bespoke trigger and the list
   * never ends.
   *
   * The cycle key is the period, so a patient enrols at most once per period no matter
   * how many times the sweep runs.
   */
  AUDIENCE_SWEEP: {
    kind: 'AUDIENCE_SWEEP',
    label: 'Anyone who matches, checked regularly',
    group: 'Patients',
    subjectType: 'PATIENT',
    describe: (c) => `Every ${num(c, 'everyDays', 30)} days, anyone who matches`,
    async findSubjects({ now, config, limit }) {
      const everyDays = Math.max(1, num(config, 'everyDays', 30));
      // The period bucket. Same string for every candidate in this window, so the
      // unique key admits each patient once per period and no more.
      const bucket = `sweep-${Math.floor(now.getTime() / (everyDays * DAY_MS))}`;

      // A coarse candidate set the audience then narrows. Bounded on purpose: this runs
      // every tick and must never try to walk the whole patient table.
      const lookbackDays = Math.max(everyDays, num(config, 'lookbackDays', 730));
      const rows = await prisma.patient.findMany({
        where: { visits: { some: { createdAt: { gte: new Date(now.getTime() - lookbackDays * DAY_MS) } } } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      return rows.map((p) => ({
        subjectId: p.id, patientId: p.id, branchId: null, triggeredAt: now, cycleKey: bucket,
      }));
    },
  },
};

/** For the blueprint/UI layer, so a trigger list is never retyped in the browser. */
export function listTriggers() {
  return Object.values(TRIGGERS).map((t) => ({
    kind: t.kind, label: t.label, group: t.group, subjectType: t.subjectType,
  }));
}
