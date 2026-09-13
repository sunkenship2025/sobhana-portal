/**
 * The fact repository every predicate reads through.
 *
 * WHY THIS EXISTS AT ALL: the simulation screen has to answer "what happens if she
 * does her tests on Day 6?" — a fact that is not in the database and never will be.
 * A predicate written as a direct Prisma call can only ever ask about the present,
 * so it can be run but never SIMULATED, and retrofitting this interface later means
 * rewriting every predicate. It costs one parameter on day one.
 *
 * Two implementations: prismaContext reads the live database; memoryContext answers
 * from a plain object, and is what the offline harness and the "Try it out" screen use.
 */
import prisma from '../../lib/prisma';
import { computeBillFinancialsFromPersisted } from '../billFinancialService';

export interface VisitFacts {
  id: string;
  patientId: string;
  branchId: string;
  domain: 'DIAGNOSTICS' | 'CLINIC';
  status: string;
  totalAmountInPaise: number;
  createdAt: Date;
  /** The visit this one came out of, when the front desk captured it. */
  sourceVisitId: string | null;
  patientLinkDisabledAt: Date | null;
}

export interface PatientFacts {
  id: string;
  yearOfBirth: number;
  gender: string;
  phone: string | null;
  marketingOptIn: boolean;
  deceasedAt: Date | null;
}

export interface ResultFacts {
  value: number | null;
  textValue: string | null;
  flag: string | null;
  referenceUnit: string | null;
  criticalMin: number | null;
  criticalMax: number | null;
  finalizedAt: Date | null;
  reportVersionId: string;
}

export interface AutomationContext {
  /** Frozen for the whole evaluation, so two predicates cannot disagree about "now". */
  readonly now: Date;
  visit(visitId: string): Promise<VisitFacts | null>;
  patient(patientId: string): Promise<PatientFacts | null>;
  /**
   * Diagnostics visits for this patient after an instant. GENEROUS by design — this is
   * the suppression question ("should we still send?"), where a false "already done"
   * costs one unsent message. That is the safe direction to be wrong in.
   */
  diagnosticsAfter(patientId: string, after: Date): Promise<VisitFacts[]>;
  /**
   * Diagnostics the front desk actually linked back to this consultation. STRICT — this
   * is the attribution question ("did we cause it?"), and only a captured link counts.
   */
  diagnosticsAttributedTo(sourceVisitId: string): Promise<VisitFacts[]>;
  outstandingDueInPaise(visitId: string): Promise<number>;
  reportOpened(visitId: string): Promise<boolean>;
  daysSinceLastVisit(patientId: string): Promise<number | null>;
  lastProactiveMessageAt(patientId: string): Promise<Date | null>;
  phoneOptedOut(phone: string): Promise<boolean>;
  threadHeldByHuman(phone: string): Promise<boolean>;
  lineHeldByAnotherRun(phone: string, runId: string): Promise<boolean>;
  /**
   * Is a MORE important journey also due for this patient right now?
   *
   * The weekly cap already stops two proactive messages landing in the same week; this
   * is the narrower question of who goes first when two are due in the same tick and
   * neither has sent yet. Without it "Importance" is a control with nothing behind it.
   */
  higherPriorityRunDue(patientId: string, priority: number, runId: string): Promise<string | null>;
  /**
   * Counts and sums over a window. One shape for all of them, because "three or more
   * visits", "spent over ₹25,000" and "no test in 180 days" are the same question with
   * different arguments — and answering them one bespoke predicate at a time is how the
   * vocabulary stops being a vocabulary.
   */
  aggregate(args: {
    patientId: string;
    of: 'VISITS' | 'SPEND';
    domain?: 'CLINIC' | 'DIAGNOSTICS';
    withinDays?: number;
  }): Promise<number>;
  /** Results for one test, newest first, across finalized reports. */
  resultHistory(patientId: string, testCode: string, limit: number): Promise<ResultFacts[]>;
  /** How many times one particular test has been done, ever or within a window. */
  testCodeCount(patientId: string, testCode: string, withinDays?: number): Promise<number>;
  couponState(runId: string): Promise<string | null>;
  resultOf(testOrderId: string, testCode: string): Promise<ResultFacts | null>;
}

// ────────────────────────────────────────────────────────────────────────────
// Live
// ────────────────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

export function prismaContext(now: Date = new Date()): AutomationContext {
  const visitSelect = {
    id: true, patientId: true, branchId: true, domain: true, status: true,
    totalAmountInPaise: true, createdAt: true, sourceVisitId: true, patientLinkDisabledAt: true,
  } as const;

  return {
    now,

    async visit(visitId) {
      const v = await prisma.visit.findUnique({ where: { id: visitId }, select: visitSelect });
      return v ? (v as VisitFacts) : null;
    },

    async patient(patientId) {
      const p = await prisma.patient.findUnique({
        where: { id: patientId },
        select: {
          id: true, yearOfBirth: true, gender: true, marketingOptIn: true, deceasedAt: true,
          identifiers: { where: { type: 'PHONE' }, select: { value: true, isPrimary: true } },
        },
      });
      if (!p) return null;
      const phone =
        p.identifiers.find((i) => i.isPrimary)?.value ?? p.identifiers[0]?.value ?? null;
      return {
        id: p.id, yearOfBirth: p.yearOfBirth, gender: p.gender,
        phone, marketingOptIn: p.marketingOptIn, deceasedAt: p.deceasedAt,
      };
    },

    async diagnosticsAfter(patientId, after) {
      const rows = await prisma.visit.findMany({
        where: {
          patientId,
          domain: 'DIAGNOSTICS',
          status: { not: 'CANCELLED' },
          createdAt: { gt: after },
        },
        select: visitSelect,
        orderBy: { createdAt: 'asc' },
      });
      return rows as VisitFacts[];
    },

    async diagnosticsAttributedTo(sourceVisitId) {
      const rows = await prisma.visit.findMany({
        where: { sourceVisitId, domain: 'DIAGNOSTICS', status: { not: 'CANCELLED' } },
        select: visitSelect,
        orderBy: { createdAt: 'asc' },
      });
      return rows as VisitFacts[];
    },

    async outstandingDueInPaise(visitId) {
      const bill = await prisma.bill.findUnique({
        where: { visitId },
        select: {
          totalAmountInPaise: true, discountAmountInPaise: true, couponDiscountInPaise: true,
          paidAmountInPaise: true, refundedAmountInPaise: true, reversedChargeInPaise: true,
        },
      });
      if (!bill) return 0;
      return computeBillFinancialsFromPersisted(bill).dueAmountInPaise;
    },

    async reportOpened(visitId) {
      const report = await prisma.diagnosticReport.findUnique({
        where: { visitId },
        select: { versions: { select: { id: true } } },
      });
      if (!report || report.versions.length === 0) return false;
      const seen = await prisma.reportAccessLog.count({
        where: { reportVersionId: { in: report.versions.map((v) => v.id) } },
      });
      return seen > 0;
    },

    async daysSinceLastVisit(patientId) {
      const last = await prisma.visit.findFirst({
        where: { patientId, status: { not: 'CANCELLED' } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (!last) return null;
      return Math.floor((now.getTime() - last.createdAt.getTime()) / DAY_MS);
    },

    async lastProactiveMessageAt(patientId) {
      const last = await prisma.messageLog.findFirst({
        where: { patientId, templateCategory: 'MARKETING', status: { not: 'FAILED' } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      return last?.createdAt ?? null;
    },

    async phoneOptedOut(phone) {
      const row = await prisma.phoneOptOut.findUnique({ where: { phone }, select: { phone: true } });
      return !!row;
    },

    async threadHeldByHuman(phone) {
      const c = await prisma.conversation.findUnique({
        where: { phone },
        select: { assignedToId: true, status: true },
      });
      return !!c?.assignedToId && c.status === 'OPEN';
    },

    async lineHeldByAnotherRun(phone, runId) {
      const slot = await prisma.awaitingReply.findUnique({
        where: { phone },
        select: { automationRunId: true, expiresAt: true },
      });
      if (!slot) return false;
      if (slot.expiresAt <= now) return false; // expired slots hold nothing
      return slot.automationRunId !== runId;
    },

    async aggregate({ patientId, of, domain, withinDays }) {
      const where = {
        patientId,
        status: { not: 'CANCELLED' as const },
        ...(domain ? { domain } : {}),
        ...(withinDays ? { createdAt: { gte: new Date(now.getTime() - withinDays * DAY_MS) } } : {}),
      };
      if (of === 'VISITS') return prisma.visit.count({ where });
      const sum = await prisma.visit.aggregate({ where, _sum: { totalAmountInPaise: true } });
      return sum._sum.totalAmountInPaise ?? 0;
    },

    async resultHistory(patientId, testCode, limit) {
      const rows = await prisma.testResult.findMany({
        where: {
          reportVersion: { status: 'FINALIZED', report: { visit: { patientId } } },
          OR: [{ testDefinition: { code: testCode } }, { test: { code: testCode } }],
        },
        orderBy: { reportVersion: { finalizedAt: 'desc' } },
        take: limit,
        select: {
          value: true, textValue: true, flag: true,
          testDefinition: { select: { referenceUnit: true } },
          reportVersion: { select: { id: true, finalizedAt: true } },
        },
      });
      return rows.map((r) => ({
        value: r.value, textValue: r.textValue, flag: r.flag,
        referenceUnit: r.testDefinition?.referenceUnit ?? null,
        criticalMin: null, criticalMax: null,
        finalizedAt: r.reportVersion.finalizedAt,
        reportVersionId: r.reportVersion.id,
      }));
    },

    async testCodeCount(patientId, testCode, withinDays) {
      return prisma.testResult.count({
        where: {
          reportVersion: {
            status: 'FINALIZED',
            report: { visit: { patientId } },
            ...(withinDays
              ? { finalizedAt: { gte: new Date(now.getTime() - withinDays * DAY_MS) } }
              : {}),
          },
          OR: [{ testDefinition: { code: testCode } }, { test: { code: testCode } }],
        },
      });
    },

    async couponState(runId) {
      const c = await prisma.coupon.findFirst({
        where: { automationRunId: runId },
        orderBy: { createdAt: 'desc' },
        select: { status: true, expiresAt: true },
      });
      if (!c) return null;
      // An issued coupon past its date is expired whether or not a sweep has said so.
      if (c.status === 'ISSUED' && c.expiresAt <= now) return 'EXPIRED';
      return c.status;
    },

    async higherPriorityRunDue(patientId, priority, runId) {
      const rival = await prisma.automationRun.findFirst({
        where: {
          patientId,
          id: { not: runId },
          state: 'PENDING',
          nextActionAt: { lte: now },
          automation: { priority: { gt: priority }, enabled: true },
        },
        // Highest priority first, then the one that has been waiting longest — a total
        // order, so the same two runs always resolve the same way.
        orderBy: [{ automation: { priority: 'desc' } }, { nextActionAt: 'asc' }],
        select: { automation: { select: { name: true } } },
      });
      return rival?.automation.name ?? null;
    },

    async resultOf(testOrderId, testCode) {
      const order = await prisma.testOrder.findUnique({
        where: { id: testOrderId },
        select: { visitId: true },
      });
      if (!order) return null;

      // The value, from the latest FINALIZED version of this visit's report.
      const version = await prisma.reportVersion.findFirst({
        where: { report: { visitId: order.visitId }, status: 'FINALIZED' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, finalizedAt: true },
      });
      if (!version) return null;

      const result = await prisma.testResult.findFirst({
        where: {
          reportVersionId: version.id,
          testOrderId,
          OR: [{ testDefinition: { code: testCode } }, { test: { code: testCode } }],
        },
        select: {
          value: true, textValue: true, flag: true,
          testDefinition: { select: { referenceUnit: true } },
        },
      });
      if (!result) return null;

      return {
        value: result.value,
        textValue: result.textValue,
        flag: result.flag,
        // Units and critical bounds are the clinicians' business; this only reads them.
        referenceUnit: result.testDefinition?.referenceUnit ?? null,
        criticalMin: null,
        criticalMax: null,
        finalizedAt: version.finalizedAt,
        reportVersionId: version.id,
      };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// In memory — the harness, and the "Try it out" screen
// ────────────────────────────────────────────────────────────────────────────

export interface FactSet {
  now: Date;
  visits?: VisitFacts[];
  patients?: PatientFacts[];
  dueByVisit?: Record<string, number>;
  openedVisits?: string[];
  lastProactiveByPatient?: Record<string, Date>;
  optedOutPhones?: string[];
  humanHeldPhones?: string[];
  linesHeldByRun?: Record<string, string>;
  results?: Record<string, ResultFacts>;
  /** patientId -> the name of a more important journey also due right now. */
  higherPriorityDueFor?: Record<string, string>;
  /** "patientId:TESTCODE" -> results newest first. */
  resultHistory?: Record<string, ResultFacts[]>;
  couponStateByRun?: Record<string, string>;
}

/**
 * Answers from a plain object. Everything absent is absent — never "unknown, assume
 * yes" — so a harness case that forgets to state a fact fails rather than passing by
 * accident.
 */
export function memoryContext(facts: FactSet): AutomationContext {
  const visits = facts.visits ?? [];
  const byId = new Map(visits.map((v) => [v.id, v]));
  const patients = new Map((facts.patients ?? []).map((p) => [p.id, p]));

  return {
    now: facts.now,
    async visit(id) { return byId.get(id) ?? null; },
    async patient(id) { return patients.get(id) ?? null; },
    async diagnosticsAfter(patientId, after) {
      return visits.filter(
        (v) => v.patientId === patientId && v.domain === 'DIAGNOSTICS' &&
               v.status !== 'CANCELLED' && v.createdAt > after,
      );
    },
    async diagnosticsAttributedTo(sourceVisitId) {
      return visits.filter(
        (v) => v.sourceVisitId === sourceVisitId && v.domain === 'DIAGNOSTICS' && v.status !== 'CANCELLED',
      );
    },
    async outstandingDueInPaise(visitId) { return facts.dueByVisit?.[visitId] ?? 0; },
    async reportOpened(visitId) { return (facts.openedVisits ?? []).includes(visitId); },
    async daysSinceLastVisit(patientId) {
      const mine = visits.filter((v) => v.patientId === patientId && v.status !== 'CANCELLED');
      if (mine.length === 0) return null;
      const latest = mine.reduce((a, b) => (a.createdAt > b.createdAt ? a : b));
      return Math.floor((facts.now.getTime() - latest.createdAt.getTime()) / DAY_MS);
    },
    async lastProactiveMessageAt(patientId) {
      return facts.lastProactiveByPatient?.[patientId] ?? null;
    },
    async phoneOptedOut(phone) { return (facts.optedOutPhones ?? []).includes(phone); },
    async threadHeldByHuman(phone) { return (facts.humanHeldPhones ?? []).includes(phone); },
    async lineHeldByAnotherRun(phone, runId) {
      const holder = facts.linesHeldByRun?.[phone];
      return !!holder && holder !== runId;
    },
    async higherPriorityRunDue(patientId) {
      return facts.higherPriorityDueFor?.[patientId] ?? null;
    },
    async aggregate({ patientId, of, domain, withinDays }) {
      const cutoff = withinDays ? new Date(facts.now.getTime() - withinDays * DAY_MS) : null;
      const mine = visits.filter(
        (v) => v.patientId === patientId && v.status !== 'CANCELLED' &&
               (!domain || v.domain === domain) && (!cutoff || v.createdAt >= cutoff),
      );
      return of === 'VISITS' ? mine.length : mine.reduce((n, v) => n + v.totalAmountInPaise, 0);
    },
    async resultHistory(patientId, testCode, limit) {
      return (facts.resultHistory?.[`${patientId}:${testCode}`] ?? []).slice(0, limit);
    },
    async testCodeCount(patientId, testCode) {
      return (facts.resultHistory?.[`${patientId}:${testCode}`] ?? []).length;
    },
    async couponState(runId) {
      return facts.couponStateByRun?.[runId] ?? null;
    },
    async resultOf(testOrderId, testCode) {
      return facts.results?.[`${testOrderId}:${testCode}`] ?? null;
    },
  };
}
