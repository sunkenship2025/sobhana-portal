/**
 * Owner Operations page — GET /api/owner/operations.
 *
 * Answers, in order: what is stuck right now, are reports going out on time
 * (and which department or hour of day is slow), do patients actually get
 * them, and who is doing the work. No money: the lab in-charge sees this page.
 *
 * Live (ignores the period): attention chips, the open-report pipeline by
 * stage × age, the oldest open visits, the clinic queue today.
 *
 * Period: one cohort — diagnostic visits REGISTERED in the window that need a
 * report (at least one live reportable or outside-lab test not closed as films
 * only). Every turnaround, delivery and hour-of-day figure is about that same
 * set, so they reconcile. Turnaround = registration → first report released
 * (a partial release counts: the patient has something). A single day is
 * compared with the same weekday a week earlier, like the Money page.
 *
 * The audit feed that used to sit here lives on its own page (/ops/audit).
 */

import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';
import { describeWaError } from './whatsappErrors';
import { comparisonWindow } from './moneyFactsService';
import { customWindow, periodWindow, toIstDateKey, PeriodKey, CustomRange } from './ownerMoneyService';

const CACHE_TTL_SEC = 60;
const cacheKey = (period: PeriodKey, branchId: string | null, range: CustomRange | null) =>
  `owner-operations:v4:${period}:${branchId ?? 'all'}:${range ? `${range.startKey}_${range.endKey}` : ''}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLA_MINUTES = 1440; // a report within a day of registration (owner decision)
const CLINIC_LONG_WAIT_MINUTES = 30;

/** Open-work age bands, in hours (upper bounds). */
const AGE_BANDS = [
  { label: 'Under 4h', maxH: 4 },
  { label: '4–24h', maxH: 24 },
  { label: '1–3 days', maxH: 72 },
  { label: 'Over 3 days', maxH: Infinity },
];

export type OpenStage = 'none' | 'entering' | 'outside' | 'partly';
const STAGE_LABEL: Record<OpenStage, string> = {
  none: 'No results yet',
  entering: 'Awaiting sign-off',
  outside: 'Outside lab pending',
  partly: 'Partly released',
};

export interface AttentionChip {
  type: string;
  label: string;
  count?: number;
  severity: 'high' | 'medium' | 'low';
  drillTo: string;
}

export interface OpsKpis {
  /** Visits in the cohort (need a report). */
  visits: number;
  released: number;
  medianMinutes: number | null;
  /** Of visits whose day is up (released, or open over 24h): share out within 24h. */
  within24Pct: number | null;
  deliveredPct: number | null; // WhatsApp delivered, of released
  openedPct: number | null; // opened online, of released
  consults: number;
}

export interface OperationsResponse {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  /** cutAtNow: the window is still running, so the comparison stops at the same point in it. */
  comparison: { startIso: string; endIso: string; sameWeekday: boolean; cutAtNow: boolean };
  branchScope: { branchId: string | null; branchName: string | null };
  attention: AttentionChip[];
  pipeline: {
    bands: string[];
    rows: { stage: OpenStage; label: string; counts: number[] }[];
    total: number;
  };
  oldestOpen: {
    visitId: string;
    patientName: string;
    patientTitle: string | null;
    branchCode: string;
    tests: string;
    stage: string;
    ageMinutes: number;
  }[];
  clinicNow: {
    doctorId: string;
    doctorName: string;
    branchName: string | null;
    waiting: number;
    inConsultation: number;
    seenToday: number;
    longestWaitMinutes: number | null;
  }[];
  kpis: OpsKpis;
  prior: OpsKpis;
  byDay: { date: string; onTime: number; late: number; pending: number; medianMinutes: number | null }[];
  byHour: { hour: number; sameDay: number; later: number; notYet: number }[];
  departments: {
    name: string;
    visits: number;
    released: number;
    medianMinutes: number | null;
    within24Pct: number | null;
    filmsOnly: number;
  }[];
  delivery: { released: number; sent: number; delivered: number; opened: number; printed: number };
  team: { userId: string; name: string; role: string; registered: number; testsEntered: number; reportsReleased: number }[];
  clinicDoctors: {
    doctorId: string;
    doctorName: string;
    consults: number;
    priorConsults: number;
    digitalRx: number;
    paperRx: number;
  }[];
  failures: {
    patientId: string | null;
    patientName: string;
    patientTitle: string | null;
    phone: string;
    attemptCount: number;
    contextLabel: string;
    failureReason: string;
    lastTriedIso: string;
  }[];
  failureSummary: { patients: number; sends: number };
}

// --- helpers ------------------------------------------------------------

function startOfTodayIst(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

const istHour = (ms: number) => new Date(ms + IST_OFFSET_MS).getUTCHours();

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
const num = (v: unknown) => Number(v ?? 0);

/** "3 report, 1 bill" for a mixed patient; just "report" for one kind. */
function formatContexts(contexts: Map<string, number>): string {
  const entries = [...contexts.entries()].sort((a, b) => b[1] - a[1]);
  if (entries.length === 1) return entries[0][0];
  return entries.map(([type, n]) => `${n} ${type}`).join(', ');
}

interface CohortRow {
  id: string;
  cur: boolean;
  reg: Date;
  rel: Date | null;
  open: boolean;
  sent: boolean;
  delivered: boolean;
  opened: boolean;
  printed: boolean;
}

/** KPIs as they stood at `asOf` (now, or the same moment in the comparison window). */
function kpisOf(all: CohortRow[], asOf: number, consults: number): OpsKpis {
  const rows = all.map((r) => (r.rel && r.rel.getTime() > asOf ? { ...r, rel: null, open: true } : r));
  const nowMs = asOf;
  const released = rows.filter((r) => r.rel);
  const tats = released.map((r) => (r.rel!.getTime() - r.reg.getTime()) / 60_000).filter((m) => m >= 0);
  const onTime = tats.filter((m) => m <= SLA_MINUTES).length;
  const lateOpen = rows.filter((r) => !r.rel && r.open && nowMs - r.reg.getTime() > SLA_MINUTES * 60_000).length;
  return {
    visits: rows.length,
    released: released.length,
    medianMinutes: median(tats),
    within24Pct: pct(onTime, tats.length + lateOpen),
    deliveredPct: pct(released.filter((r) => r.delivered).length, released.length),
    openedPct: pct(released.filter((r) => r.opened).length, released.length),
    consults,
  };
}

// --- main entry ---------------------------------------------------------

export async function getOwnerOperations(
  period: PeriodKey,
  branchId: string | null,
  range: CustomRange | null = null,
): Promise<OperationsResponse> {
  const redis = getRedisClient();
  const key = cacheKey(period, branchId, range);
  if (redis) {
    try {
      const hit = await redis.get(key);
      if (hit) return JSON.parse(hit) as OperationsResponse;
    } catch (err) {
      logger.warn({ err, branchId }, 'owner-operations: cache read failed');
    }
  }

  const now = new Date();
  const nowMs = now.getTime();
  const todayStart = startOfTodayIst(now);
  const win = period === 'custom' && range ? customWindow(range) : periodWindow(period, now);
  // A window still running is compared with the comparison window up to the
  // same moment: today at 10:47 against last Wednesday up to 10:47, not all of it.
  const full = comparisonWindow(win);
  const shiftMs = win.start.getTime() - full.start.getTime();
  const cutAtNow = win.end.getTime() > nowMs;
  const prior = cutAtNow ? { start: full.start, end: new Date(Math.min(full.end.getTime(), nowMs - shiftMs)) } : full;
  const sameWeekday = Math.round((win.end.getTime() - win.start.getTime()) / DAY_MS) === 1;

  const vBranch = branchId ? Prisma.sql`AND v."branchId" = ${branchId}` : Prisma.empty;
  const aBranch = branchId ? Prisma.sql`AND a."branchId" = ${branchId}` : Prisma.empty;
  const oBranch = branchId ? Prisma.sql`AND o."branchId" = ${branchId}` : Prisma.empty;
  // A visit needs a report while it has a live reportable / outside-lab test
  // that was not closed as films only.
  const needsReport = Prisma.sql`EXISTS (
    SELECT 1 FROM "TestOrder" o WHERE o."visitId" = v.id AND o."cancelledAt" IS NULL
      AND o."noReportAt" IS NULL AND o."workflowMode" IN ('REPORTABLE', 'EXTERNAL_UPLOAD'))`;

  const [
    scopedBranch,
    branches,
    cohort,
    deptRows,
    openVisits,
    clinicOpen,
    clinicSeenToday,
    clinicPeriod,
    registeredBy,
    enteredBy,
    releasedBy,
    failedRows,
    failedReport24h,
  ] = await Promise.all([
    branchId ? prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } }) : null,
    prisma.branch.findMany({ select: { id: true, code: true } }),

    // The cohort, this window and the comparison window, one row per visit.
    prisma.$queryRaw<
      { id: string; cur: boolean; reg: Date; rel: Date | null; open: boolean; sent: boolean; delivered: boolean; opened: boolean; printed: boolean }[]
    >`
      SELECT v.id, (v."createdAt" >= ${win.start}) AS cur, v."createdAt" AS reg,
        (SELECT min(rv."finalizedAt") FROM "DiagnosticReport" r
           JOIN "ReportVersion" rv ON rv."reportId" = r.id AND rv.status = 'FINALIZED'
          WHERE r."visitId" = v.id) AS rel,
        v.status IN ('DRAFT', 'WAITING') AS open,
        EXISTS (SELECT 1 FROM "MessageLog" m WHERE m."contextType" = 'REPORT' AND m."contextId" = v.id) AS sent,
        EXISTS (SELECT 1 FROM "MessageLog" m WHERE m."contextType" = 'REPORT' AND m."contextId" = v.id
                  AND m.status IN ('DELIVERED', 'READ')) AS delivered,
        EXISTS (SELECT 1 FROM "DiagnosticReport" r JOIN "ReportVersion" rv ON rv."reportId" = r.id
                  JOIN "ReportAccessLog" l ON l."reportVersionId" = rv.id
                 WHERE r."visitId" = v.id AND l."accessedVia" IN ('TOKEN', 'PATIENT_PORTAL')) AS opened,
        v."reportPrintedAt" IS NOT NULL AS printed
      FROM "Visit" v
      WHERE v.domain = 'DIAGNOSTICS' AND v.status <> 'CANCELLED' ${vBranch}
        AND ((v."createdAt" >= ${win.start} AND v."createdAt" < ${win.end})
          OR (v."createdAt" >= ${prior.start} AND v."createdAt" < ${prior.end}))
        AND ${needsReport}`,

    // Per department: a visit's part is out when every live test of that
    // department in it is out. Reportable tests are out with the first released
    // version holding their result; an outside-lab test with the first one
    // released after its PDF was uploaded.
    prisma.$queryRaw<{ name: string; visits: number; released: number; films: number; p50: number | null; within: number }[]>`
      WITH t AS (
        SELECT o."visitId", v."createdAt" AS reg,
          CASE WHEN o."workflowMode" = 'EXTERNAL_UPLOAD' AND coalesce(nullif(trim(o."payoutCategorySnapshot"), ''), 'Other') = 'Laboratory'
               THEN 'Outside lab'
               ELSE coalesce(nullif(trim(o."payoutCategorySnapshot"), ''), 'Other') END AS name,
          o."noReportAt" IS NOT NULL AS films,
          CASE WHEN o."workflowMode" = 'REPORTABLE' THEN
            (SELECT min(rv."finalizedAt") FROM "TestResult" tr
               JOIN "ReportVersion" rv ON rv.id = tr."reportVersionId" AND rv.status = 'FINALIZED'
              WHERE tr."testOrderId" = o.id)
          ELSE
            (SELECT min(rv."finalizedAt") FROM "DiagnosticReport" r
               JOIN "ReportVersion" rv ON rv."reportId" = r.id AND rv.status = 'FINALIZED'
              WHERE r."visitId" = o."visitId"
                AND rv."finalizedAt" >= (SELECT min(u."uploadedAt") FROM "ExternalReportUpload" u
                                          WHERE u."testOrderId" = o.id AND u."deletedAt" IS NULL))
          END AS rel
        FROM "TestOrder" o JOIN "Visit" v ON v.id = o."visitId"
        WHERE v.domain = 'DIAGNOSTICS' AND v.status <> 'CANCELLED' AND o."cancelledAt" IS NULL
          AND o."workflowMode" IN ('REPORTABLE', 'EXTERNAL_UPLOAD')
          AND v."createdAt" >= ${win.start} AND v."createdAt" < ${win.end} ${vBranch}
      ), vd AS (
        SELECT "visitId", name, reg, bool_and(films) AS films,
          CASE WHEN bool_and(films OR rel IS NOT NULL) AND bool_or(NOT films) THEN max(rel) END AS rel
        FROM t GROUP BY 1, 2, 3
      )
      SELECT name, count(*)::int AS visits,
        count(*) FILTER (WHERE rel IS NOT NULL)::int AS released,
        count(*) FILTER (WHERE films)::int AS films,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM rel - reg) / 60)
          FILTER (WHERE rel IS NOT NULL) AS p50,
        count(*) FILTER (WHERE rel - reg <= interval '24 hours')::int AS within
      FROM vd GROUP BY 1 ORDER BY 2 DESC`,

    // Open diagnostic work, live: one row per open visit with what its live
    // tests are waiting on. (Raw SQL: Prisma's nested take-1 relations ran a
    // query per test and took 8s.)
    prisma.$queryRaw<
      { id: string; createdAt: Date; branchId: string; name: string; title: string | null; partly: boolean; outsideMissing: number; anyIn: boolean; names: string[] }[]
    >`
      SELECT v.id, v."createdAt", v."branchId", p.name, p.title::text AS title,
        EXISTS (SELECT 1 FROM "DiagnosticReport" r JOIN "ReportVersion" rv ON rv."reportId" = r.id
                 WHERE r."visitId" = v.id AND rv.status = 'FINALIZED') AS partly,
        count(*) FILTER (WHERE o."workflowMode" = 'EXTERNAL_UPLOAD' AND NOT EXISTS (
          SELECT 1 FROM "ExternalReportUpload" u WHERE u."testOrderId" = o.id AND u."deletedAt" IS NULL))::int AS "outsideMissing",
        bool_or(EXISTS (SELECT 1 FROM "TestResult" tr WHERE tr."testOrderId" = o.id)
             OR EXISTS (SELECT 1 FROM "ExternalReportUpload" u WHERE u."testOrderId" = o.id AND u."deletedAt" IS NULL)) AS "anyIn",
        array_agg(DISTINCT coalesce(pr.name, o."testNameSnapshot")) AS names
      FROM "Visit" v
      JOIN "Patient" p ON p.id = v."patientId"
      JOIN "TestOrder" o ON o."visitId" = v.id AND o."cancelledAt" IS NULL AND o."noReportAt" IS NULL
        AND o."workflowMode" IN ('REPORTABLE', 'EXTERNAL_UPLOAD')
      LEFT JOIN "BillableProduct" pr ON pr.id = o."productId"
      WHERE v.domain = 'DIAGNOSTICS' AND v.status IN ('DRAFT', 'WAITING') ${vBranch}
      GROUP BY v.id, p.name, p.title
      ORDER BY v."createdAt"
      LIMIT 500`,

    // Clinic queue, today's check-ins only (an unclosed visit from last week is
    // a housekeeping miss, not a patient in the waiting room).
    prisma.clinicVisit.findMany({
      where: {
        status: { in: ['WAITING', 'IN_PROGRESS'] },
        createdAt: { gte: todayStart },
        ...(branchId ? { visit: { branchId } } : {}),
      },
      select: {
        status: true,
        createdAt: true,
        clinicDoctorId: true,
        clinicDoctor: { select: { name: true } },
        visit: { select: { branch: { select: { name: true } } } },
      },
    }),
    prisma.clinicVisit.groupBy({
      by: ['clinicDoctorId'],
      where: {
        status: 'COMPLETED',
        createdAt: { gte: todayStart },
        ...(branchId ? { visit: { branchId } } : {}),
      },
      _count: true,
    }),

    // Clinic consults, this window and the comparison one.
    // No time-with-doctor: the desk marks visits done in batches (12 in two
    // minutes on 6 Oct 2026) and doctors never press Start, so those times
    // would describe the desk, not the consult.
    prisma.$queryRaw<{ doctorId: string; doctorName: string; cur: boolean; digital: boolean; paper: boolean }[]>`
      SELECT cv."clinicDoctorId" AS "doctorId", d.name AS "doctorName", (cv."createdAt" >= ${win.start}) AS cur,
        EXISTS (SELECT 1 FROM "Prescription" p WHERE p."visitId" = v.id) AS digital,
        cv."rxOutcome" = 'PAPER' AS paper
      FROM "ClinicVisit" cv JOIN "Visit" v ON v.id = cv."visitId" JOIN "ClinicDoctor" d ON d.id = cv."clinicDoctorId"
      WHERE v.status <> 'CANCELLED' ${vBranch}
        AND ((cv."createdAt" >= ${win.start} AND cv."createdAt" < ${win.end})
          OR (cv."createdAt" >= ${prior.start} AND cv."createdAt" < ${prior.end}))`,

    // Team: who registered, who entered results, who released reports.
    prisma.$queryRaw<{ userId: string; n: number }[]>`
      SELECT a."userId", count(*)::int AS n FROM "AuditLog" a
      WHERE a."actionType" = 'CREATE' AND a."entityType" = 'VISIT' AND a."userId" IS NOT NULL
        AND a."createdAt" >= ${win.start} AND a."createdAt" < ${win.end} ${aBranch}
      GROUP BY 1`,
    prisma.$queryRaw<{ userId: string; n: number }[]>`
      SELECT tr."enteredByUserId" AS "userId", count(DISTINCT tr."testOrderId")::int AS n
      FROM "TestResult" tr JOIN "TestOrder" o ON o.id = tr."testOrderId"
      WHERE tr."enteredByUserId" IS NOT NULL
        AND tr."createdAt" >= ${win.start} AND tr."createdAt" < ${win.end} ${oBranch}
      GROUP BY 1`,
    prisma.$queryRaw<{ userId: string; n: number }[]>`
      SELECT a."userId", count(*)::int AS n FROM "AuditLog" a
      WHERE a."actionType" = 'FINALIZE' AND a."entityType" = 'Report' AND a."userId" IS NOT NULL
        AND a."createdAt" >= ${win.start} AND a."createdAt" < ${win.end} ${aBranch}
      GROUP BY 1`,

    // Patient messages that failed in the window. Campaign sends are left out:
    // they fail to numbers that never opted in, which is not an operations fault.
    prisma.messageLog.findMany({
      where: {
        status: 'FAILED',
        contextType: { not: 'CAMPAIGN' },
        createdAt: { gte: win.start, lt: win.end },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: {
        patientId: true,
        contextType: true,
        errorCode: true,
        failureReason: true,
        phone: true,
        createdAt: true,
        patient: { select: { name: true, title: true } },
      },
    }),
    prisma.messageLog.findMany({
      where: {
        status: 'FAILED',
        contextType: 'REPORT',
        createdAt: { gte: new Date(nowMs - DAY_MS) },
        ...(branchId ? { branchId } : {}),
      },
      distinct: ['phone'],
      select: { phone: true },
    }),
  ]);

  const codeOf = new Map(branches.map((b) => [b.id, b.code]));

  // --- cohort: KPIs, by day, by hour, delivery ----------------------------
  const rows: CohortRow[] = cohort.map((r) => ({ ...r, cur: Boolean(r.cur) }));
  const cur = rows.filter((r) => r.cur);
  const clinicCur = clinicPeriod.filter((c) => c.cur).length;
  const kpis = kpisOf(cur, nowMs, clinicCur);
  const priorKpis = kpisOf(rows.filter((r) => !r.cur), nowMs - shiftMs, clinicPeriod.length - clinicCur);

  const dayMap = new Map<string, { onTime: number; late: number; pending: number; tats: number[] }>();
  for (let t = win.start.getTime(); t < Math.min(win.end.getTime(), nowMs); t += DAY_MS) {
    dayMap.set(toIstDateKey(new Date(t)), { onTime: 0, late: 0, pending: 0, tats: [] });
  }
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, sameDay: 0, later: 0, notYet: 0 }));
  for (const r of cur) {
    const d = dayMap.get(toIstDateKey(r.reg));
    const tat = r.rel ? (r.rel.getTime() - r.reg.getTime()) / 60_000 : null;
    if (d) {
      if (tat != null) {
        d.tats.push(tat);
        if (tat <= SLA_MINUTES) d.onTime++;
        else d.late++;
      } else if (r.open) {
        if (nowMs - r.reg.getTime() > SLA_MINUTES * 60_000) d.late++;
        else d.pending++;
      }
    }
    const h = hours[istHour(r.reg.getTime())];
    if (r.rel && toIstDateKey(r.rel) === toIstDateKey(r.reg)) h.sameDay++;
    else if (r.rel || toIstDateKey(r.reg) !== toIstDateKey(now)) h.later++;
    else h.notYet++;
  }
  const byDay = [...dayMap.entries()].map(([date, d]) => ({
    date,
    onTime: d.onTime,
    late: d.late,
    pending: d.pending,
    medianMinutes: median(d.tats),
  }));
  const byHour = hours.filter((h) => h.sameDay + h.later + h.notYet > 0);
  const releasedCur = cur.filter((r) => r.rel);
  const delivery = {
    released: releasedCur.length,
    sent: releasedCur.filter((r) => r.sent).length,
    delivered: releasedCur.filter((r) => r.delivered).length,
    opened: releasedCur.filter((r) => r.opened).length,
    printed: releasedCur.filter((r) => r.printed).length,
  };

  const departments = deptRows.map((d) => ({
    name: d.name,
    visits: num(d.visits),
    released: num(d.released),
    medianMinutes: d.p50 == null ? null : Math.round(num(d.p50)),
    within24Pct: pct(num(d.within), num(d.released)),
    filmsOnly: num(d.films),
  }));

  // --- live pipeline ------------------------------------------------------
  const counts: Record<OpenStage, number[]> = {
    partly: [0, 0, 0, 0],
    outside: [0, 0, 0, 0],
    entering: [0, 0, 0, 0],
    none: [0, 0, 0, 0],
  };
  const open = openVisits.map((v) => {
    const outsideMissing = num(v.outsideMissing);
    const stage: OpenStage = v.partly ? 'partly' : outsideMissing > 0 ? 'outside' : v.anyIn ? 'entering' : 'none';
    const ageMinutes = Math.floor((nowMs - v.createdAt.getTime()) / 60_000);
    const band = AGE_BANDS.findIndex((b) => ageMinutes < b.maxH * 60);
    counts[stage][band]++;
    const names = v.names ?? [];
    return {
      visitId: v.id,
      patientName: v.name,
      patientTitle: v.title,
      branchCode: codeOf.get(v.branchId) ?? '?',
      tests: names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''),
      stage: STAGE_LABEL[stage],
      ageMinutes,
      outsideMissing,
    };
  });
  const pipeline = {
    bands: AGE_BANDS.map((b) => b.label),
    rows: (['none', 'entering', 'outside', 'partly'] as OpenStage[]).map((stage) => ({
      stage,
      label: STAGE_LABEL[stage],
      counts: counts[stage],
    })),
    total: open.length,
  };
  const oldestOpen = open.slice(0, 10).map(({ outsideMissing: _o, ...r }) => r);

  // --- clinic now -----------------------------------------------------------
  const clinicMap = new Map<string, OperationsResponse['clinicNow'][number]>();
  for (const c of clinicOpen) {
    const cur =
      clinicMap.get(c.clinicDoctorId) ??
      {
        doctorId: c.clinicDoctorId,
        doctorName: c.clinicDoctor.name,
        branchName: c.visit?.branch?.name ?? null,
        waiting: 0,
        inConsultation: 0,
        seenToday: 0,
        longestWaitMinutes: null,
      };
    if (c.status === 'IN_PROGRESS') cur.inConsultation++;
    else {
      cur.waiting++;
      const wait = Math.floor((nowMs - c.createdAt.getTime()) / 60_000);
      cur.longestWaitMinutes = Math.max(cur.longestWaitMinutes ?? 0, wait);
    }
    clinicMap.set(c.clinicDoctorId, cur);
  }
  for (const g of clinicSeenToday) {
    const cur = clinicMap.get(g.clinicDoctorId);
    if (cur) cur.seenToday = num(g._count);
  }
  const clinicNow = [...clinicMap.values()].sort((a, b) => (b.longestWaitMinutes ?? 0) - (a.longestWaitMinutes ?? 0));

  // --- clinic doctors over the window ------------------------------------
  const docMap = new Map<string, OperationsResponse['clinicDoctors'][number]>();
  for (const c of clinicPeriod) {
    const d =
      docMap.get(c.doctorId) ??
      { doctorId: c.doctorId, doctorName: c.doctorName.trim(), consults: 0, priorConsults: 0, digitalRx: 0, paperRx: 0 };
    if (c.cur) {
      d.consults++;
      if (c.digital) d.digitalRx++;
      if (c.paper) d.paperRx++;
    } else d.priorConsults++;
    docMap.set(c.doctorId, d);
  }
  const clinicDoctors = [...docMap.values()]
    .filter((d) => d.consults > 0)
    .sort((a, b) => b.consults - a.consults);

  // --- team ---------------------------------------------------------------
  const teamIds = [...new Set([...registeredBy, ...enteredBy, ...releasedBy].map((r) => r.userId))];
  const users = teamIds.length
    ? await prisma.user.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true, role: true } })
    : [];
  const byUser = (rs: { userId: string; n: number }[]) => new Map(rs.map((r) => [r.userId, num(r.n)]));
  const reg = byUser(registeredBy);
  const ent = byUser(enteredBy);
  const relBy = byUser(releasedBy);
  const team = users
    .map((u) => ({
      userId: u.id,
      name: u.name,
      role: String(u.role),
      registered: reg.get(u.id) ?? 0,
      testsEntered: ent.get(u.id) ?? 0,
      reportsReleased: relBy.get(u.id) ?? 0,
    }))
    .sort((a, b) => b.reportsReleased + b.registered - (a.reportsReleased + a.registered) || b.testsEntered - a.testsEntered);

  // --- failed messages, one row per patient ---------------------------------
  interface Group {
    patientId: string | null;
    patientName: string;
    patientTitle: string | null;
    phone: string;
    count: number;
    contexts: Map<string, number>;
    errorCode: string | null;
    failureReason: string | null;
    lastTried: Date;
  }
  const groups = new Map<string, Group>();
  for (const m of failedRows) {
    const k = m.patientId ?? `phone:${m.phone}`;
    let g = groups.get(k);
    if (!g) {
      g = {
        patientId: m.patientId,
        patientName: m.patient?.name ?? '—',
        patientTitle: m.patient?.title ?? null,
        phone: m.phone,
        count: 0,
        contexts: new Map(),
        errorCode: m.errorCode ?? null,
        failureReason: m.failureReason ?? null,
        lastTried: m.createdAt, // rows arrive newest first
      };
      groups.set(k, g);
    }
    g.count++;
    const ctx = String(m.contextType).toLowerCase();
    g.contexts.set(ctx, (g.contexts.get(ctx) ?? 0) + 1);
  }
  const failures = [...groups.values()].slice(0, 25).map((g) => ({
    patientId: g.patientId,
    patientName: g.patientName,
    patientTitle: g.patientTitle,
    phone: g.phone,
    attemptCount: g.count,
    contextLabel: formatContexts(g.contexts),
    failureReason: describeWaError(g.errorCode, g.failureReason).label,
    lastTriedIso: g.lastTried.toISOString(),
  }));

  // --- attention (live) -----------------------------------------------------
  const attention: AttentionChip[] = [];
  const overDay = open.filter((o) => o.ageMinutes > SLA_MINUTES);
  if (overDay.length) {
    attention.push({
      type: 'late-reports',
      label: `${overDay.length === 1 ? 'Report' : 'Reports'} not out after a day`,
      count: overDay.length,
      severity: overDay.some((o) => o.ageMinutes > 3 * SLA_MINUTES) ? 'high' : 'medium',
      drillTo: '/diagnostics/pending',
    });
  }
  const outside = open.filter((o) => o.outsideMissing > 0);
  if (outside.length) {
    const days = Math.floor(Math.max(...outside.map((o) => o.ageMinutes)) / SLA_MINUTES);
    attention.push({
      type: 'outside-lab',
      label: `Outside-lab results not uploaded${days >= 1 ? ` · oldest ${days} day${days === 1 ? '' : 's'}` : ''}`,
      count: outside.length,
      severity: days >= 3 ? 'high' : 'medium',
      drillTo: '/diagnostics/pending',
    });
  }
  if (failedReport24h.length) {
    attention.push({
      type: 'report-not-delivered',
      label: 'Reports not delivered on WhatsApp · last 24h',
      count: failedReport24h.length,
      severity: 'medium',
      drillTo: '#failed-messages',
    });
  }
  const longWaits = clinicOpen.filter(
    (c) => c.status === 'WAITING' && nowMs - c.createdAt.getTime() > CLINIC_LONG_WAIT_MINUTES * 60_000,
  ).length;
  if (longWaits) {
    attention.push({
      type: 'clinic-wait',
      label: `Waiting over ${CLINIC_LONG_WAIT_MINUTES} min for the doctor`,
      count: longWaits,
      severity: 'medium',
      drillTo: '/clinic/queue',
    });
  }

  const response: OperationsResponse = {
    generatedAt: now.toISOString(),
    period: { key: period, startIso: win.start.toISOString(), endIso: win.end.toISOString() },
    comparison: { startIso: prior.start.toISOString(), endIso: prior.end.toISOString(), sameWeekday, cutAtNow },
    branchScope: { branchId, branchName: scopedBranch?.name ?? null },
    attention,
    pipeline,
    oldestOpen,
    clinicNow,
    kpis,
    prior: priorKpis,
    byDay,
    byHour,
    departments,
    delivery,
    team,
    clinicDoctors,
    failures,
    failureSummary: { patients: groups.size, sends: failedRows.length },
  };

  if (redis) {
    redis
      .set(key, JSON.stringify(response), 'EX', CACHE_TTL_SEC)
      .catch((err) => logger.warn({ err, branchId }, 'owner-operations: cache write failed'));
  }
  return response;
}
