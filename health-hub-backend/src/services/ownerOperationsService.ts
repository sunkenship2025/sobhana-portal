/**
 * Owner Operations page — GET /api/owner/operations.
 *
 * For the owner (is every branch running?) and the lab in-charge (what do I
 * chase?). No money on it.
 *
 * Live, ignoring the period:
 *   branches  one status card per active branch: today's numbers, what's
 *             late, and when the lab last released a report (is it working?)
 *   pending   every open visit with its stage — waiting for results, awaiting
 *             sign-off, outside lab — plus critical values from the last 48h
 *             and patients whose WhatsApp failed (to call)
 *
 * Period: one cohort — diagnostic visits REGISTERED in the window that need a
 * report (a live reportable or outside-lab test not closed as films only).
 * Turnaround = registration → first report released (a partial release
 * counts: the patient has something). The day chart, the time split and the
 * delivery figures are all about that set.
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
  `owner-operations:v6:${period}:${branchId ?? 'all'}:${range ? `${range.startKey}_${range.endKey}` : ''}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLA_MINUTES = 1440; // a report within a day of registration (owner decision)
const EVENING_HOUR = 17;

export type PendingStage = 'results' | 'signoff' | 'outside';

export interface BranchStatus {
  branchId: string;
  code: string;
  name: string;
  registeredToday: number; // diagnostics + clinic
  outToday: number; // reports released today (first release)
  inProgress: number; // open, under a day
  late: number; // open, over a day
  clinicWaiting: number;
  notDeliveredToday: number; // patients whose report/bill WhatsApp failed today
  lastReleaseAt: string | null;
  lastReleaseBy: string | null;
  lastEntryAt: string | null;
  lastEntryBy: string | null;
}

export interface Speed {
  visits: number;
  released: number;
  medianMinutes: number | null;
  within24Pct: number | null;
  waitForResultMinutes: number | null;
  toSignOffMinutes: number | null;
  daySameDayPct: number | null; // registered before 5 pm: report the same day
  eveningVisits: number;
  eveningSameDayPct: number | null; // registered from 5 pm
}

export interface OperationsResponse {
  generatedAt: string;
  period: { key: PeriodKey; startIso: string; endIso: string };
  branchScope: { branchId: string | null; branchName: string | null };
  branches: BranchStatus[];
  pending: {
    visitId: string;
    patientName: string;
    patientTitle: string | null;
    branchCode: string;
    tests: string;
    stage: PendingStage;
    partlyOut: boolean;
    outsideTests: number;
    enteredBy: string | null;
    ageMinutes: number;
  }[];
  critical: {
    visitId: string;
    patientName: string;
    patientTitle: string | null;
    branchCode: string;
    test: string;
    value: string;
    flag: 'CRITICAL_HIGH' | 'CRITICAL_LOW';
    enteredBy: string | null;
    enteredAt: string;
    released: boolean;
  }[];
  toCall: {
    patientId: string | null;
    patientName: string;
    patientTitle: string | null;
    branchCode: string | null;
    phone: string;
    what: string;
    why: string;
    lastTriedIso: string;
  }[];
  /** The whole cohort; branchSpeed is the same measures per branch (sums to it). */
  overall: Speed;
  branchSpeed: (Speed & { code: string; name: string })[];
  byDay: { date: string; onTime: number; late: number; pending: number; medianMinutes: number | null }[];
  departments: { name: string; visits: number; released: number; medianMinutes: number | null; within24Pct: number | null; filmsOnly: number }[];
  delivery: { released: number; sent: number; delivered: number; opened: number; printed: number };
  team: { userId: string; name: string; role: string; branches: string[]; registered: number; testsEntered: number; reportsReleased: number }[];
  clinicNow: { doctorId: string; doctorName: string; branchCode: string | null; waiting: number; withDoctor: number; seenToday: number; longestWaitMinutes: number | null }[];
  clinicDoctors: { doctorId: string; doctorName: string; consults: number; priorConsults: number; digitalRx: number; paperRx: number }[];
}

// --- helpers ------------------------------------------------------------

function startOfTodayIst(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

const istHour = (d: Date) => new Date(d.getTime() + IST_OFFSET_MS).getUTCHours();

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : null);
const num = (v: unknown) => Number(v ?? 0);
const minutesBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;

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
  const recent = new Date(nowMs - 2 * DAY_MS);
  const win = period === 'custom' && range ? customWindow(range) : periodWindow(period, now);
  // Clinic consults are compared with the comparison window, cut at the same
  // moment when this window is still running (today at 10:47 vs last Wed to 10:47).
  const full = comparisonWindow(win);
  const shiftMs = win.start.getTime() - full.start.getTime();
  const prior = { start: full.start, end: new Date(Math.min(full.end.getTime(), nowMs - shiftMs)) };

  const vBranch = branchId ? Prisma.sql`AND v."branchId" = ${branchId}` : Prisma.empty;
  const aBranch = branchId ? Prisma.sql`AND a."branchId" = ${branchId}` : Prisma.empty;
  const rBranch = branchId ? Prisma.sql`AND r."branchId" = ${branchId}` : Prisma.empty;
  // A visit needs a report while it has a live reportable / outside-lab test
  // that was not closed as films only.
  const needsReport = Prisma.sql`EXISTS (
    SELECT 1 FROM "TestOrder" o WHERE o."visitId" = v.id AND o."cancelledAt" IS NULL
      AND o."noReportAt" IS NULL AND o."workflowMode" IN ('REPORTABLE', 'EXTERNAL_UPLOAD'))`;

  const [
    branchRows,
    registeredToday,
    outToday,
    lastRelease,
    lastEntry,
    openVisits,
    criticalRows,
    failedRows,
    clinicOpen,
    clinicSeenToday,
    cohort,
    deptRows,
    clinicPeriod,
    registeredBy,
    enteredBy,
    releasedBy,
  ] = await Promise.all([
    prisma.branch.findMany({ where: { isActive: true }, select: { id: true, code: true, name: true } }),

    prisma.visit.groupBy({
      by: ['branchId'],
      where: { createdAt: { gte: todayStart }, status: { not: 'CANCELLED' }, ...(branchId ? { branchId } : {}) },
      _count: true,
    }),
    // Reports out today: today's releases (indexed) that were the visit's FIRST.
    prisma.$queryRaw<{ branchId: string; n: number }[]>`
      SELECT r."branchId", count(DISTINCT r.id)::int AS n
      FROM "ReportVersion" rv JOIN "DiagnosticReport" r ON r.id = rv."reportId"
      WHERE rv.status = 'FINALIZED' AND rv."finalizedAt" >= ${todayStart} ${rBranch}
        AND NOT EXISTS (SELECT 1 FROM "ReportVersion" e WHERE e."reportId" = rv."reportId"
                          AND e.status = 'FINALIZED' AND e."finalizedAt" < ${todayStart})
      GROUP BY 1`,
    // The lab's heartbeat: last report released and last result saved, per branch.
    prisma.$queryRaw<{ branchId: string; at: Date; by: string | null }[]>`
      SELECT DISTINCT ON (a."branchId") a."branchId", a."createdAt" AS at, u.name AS by
      FROM "AuditLog" a LEFT JOIN "User" u ON u.id = a."userId"
      WHERE a."actionType" = 'FINALIZE' AND a."entityType" = 'Report' AND a."createdAt" >= ${recent} ${aBranch}
      ORDER BY a."branchId", a."createdAt" DESC`,
    prisma.$queryRaw<{ branchId: string; at: Date; by: string | null }[]>`
      SELECT DISTINCT ON (a."branchId") a."branchId", a."createdAt" AS at, u.name AS by
      FROM "AuditLog" a LEFT JOIN "User" u ON u.id = a."userId"
      WHERE a."actionType" = 'UPDATE' AND a."entityType" = 'ReportDraft' AND a."createdAt" >= ${recent} ${aBranch}
      ORDER BY a."branchId", a."createdAt" DESC`,

    // Open diagnostic work: one row per open visit with what its live tests
    // are waiting on. (Raw SQL: Prisma's nested take-1 relations ran a query
    // per test and took 8s.)
    prisma.$queryRaw<
      { id: string; createdAt: Date; branchId: string; name: string; title: string | null; partly: boolean; outside: number; entered: string | null; anyIn: boolean; names: string[] }[]
    >`
      SELECT v.id, v."createdAt", v."branchId", p.name, p.title::text AS title,
        EXISTS (SELECT 1 FROM "DiagnosticReport" r JOIN "ReportVersion" rv ON rv."reportId" = r.id
                 WHERE r."visitId" = v.id AND rv.status = 'FINALIZED') AS partly,
        count(*) FILTER (WHERE o."workflowMode" = 'EXTERNAL_UPLOAD' AND NOT EXISTS (
          SELECT 1 FROM "ExternalReportUpload" u WHERE u."testOrderId" = o.id AND u."deletedAt" IS NULL))::int AS outside,
        bool_or(EXISTS (SELECT 1 FROM "TestResult" tr WHERE tr."testOrderId" = o.id)
             OR EXISTS (SELECT 1 FROM "ExternalReportUpload" u WHERE u."testOrderId" = o.id AND u."deletedAt" IS NULL)) AS "anyIn",
        (SELECT u.name FROM "TestOrder" o2 JOIN "TestResult" tr ON tr."testOrderId" = o2.id JOIN "User" u ON u.id = tr."enteredByUserId"
          WHERE o2."visitId" = v.id ORDER BY tr."createdAt" DESC LIMIT 1) AS entered,
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

    // Critical values on tests ordered in the last 48h (one row per test,
    // whichever report version it was carried into).
    prisma.$queryRaw<
      { visitId: string; name: string; title: string | null; branchId: string; test: string; value: number | null; textValue: string | null; unit: string | null; flag: 'CRITICAL_HIGH' | 'CRITICAL_LOW'; by: string | null; at: Date; released: boolean }[]
    >`
      SELECT DISTINCT ON (o.id, tr."testId") v.id AS "visitId", p.name, p.title::text AS title, v."branchId",
        coalesce(td.name, lt.name) AS test, tr.value, tr."textValue", o."referenceUnitSnapshot" AS unit,
        tr.flag::text AS flag, u.name AS by, tr."createdAt" AS at,
        EXISTS (SELECT 1 FROM "ReportVersion" rv WHERE rv.id = tr."reportVersionId" AND rv.status = 'FINALIZED') AS released
      FROM "TestResult" tr
      JOIN "TestOrder" o ON o.id = tr."testOrderId"
      JOIN "Visit" v ON v.id = o."visitId"
      JOIN "Patient" p ON p.id = v."patientId"
      JOIN "LabTest" lt ON lt.id = tr."testId"
      LEFT JOIN "TestDefinition" td ON td.id = tr."testDefinitionId"
      LEFT JOIN "User" u ON u.id = tr."enteredByUserId"
      WHERE v."createdAt" >= ${recent} ${vBranch}
        AND tr.flag IN ('CRITICAL_HIGH', 'CRITICAL_LOW') AND o."cancelledAt" IS NULL
      ORDER BY o.id, tr."testId", tr."createdAt" DESC`,

    // Messages that failed in the last 48h — reports, bills, prescriptions.
    // Campaign sends are left out: they fail to numbers that never opted in.
    prisma.messageLog.findMany({
      where: {
        status: 'FAILED',
        contextType: { not: 'CAMPAIGN' },
        createdAt: { gte: recent },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 300,
      select: {
        patientId: true,
        branchId: true,
        contextType: true,
        errorCode: true,
        failureReason: true,
        phone: true,
        createdAt: true,
        patient: { select: { name: true, title: true } },
      },
    }),

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
        visit: { select: { branchId: true } },
      },
    }),
    prisma.clinicVisit.groupBy({
      by: ['clinicDoctorId'],
      where: { status: 'COMPLETED', createdAt: { gte: todayStart }, ...(branchId ? { visit: { branchId } } : {}) },
      _count: true,
    }),

    // The period's cohort, one row per visit. Every lookup is bounded by the
    // window — a release, a message or a link opened can only happen after
    // registration — so the work grows with the period, not with history.
    prisma.$queryRaw<
      { branchId: string; reg: Date; entry: Date | null; rel: Date | null; open: boolean; sent: boolean; delivered: boolean; opened: boolean; printed: boolean }[]
    >`
      WITH v AS (
        SELECT v.id, v."branchId", v."createdAt", v.status, v."reportPrintedAt" FROM "Visit" v
        WHERE v.domain = 'DIAGNOSTICS' AND v.status <> 'CANCELLED' ${vBranch}
          AND v."createdAt" >= ${win.start} AND v."createdAt" < ${win.end}
          AND ${needsReport}
      ), rv AS (
        SELECT r."visitId", rv.id, rv."finalizedAt" FROM v
        JOIN "DiagnosticReport" r ON r."visitId" = v.id
        JOIN "ReportVersion" rv ON rv."reportId" = r.id AND rv.status = 'FINALIZED' AND rv."finalizedAt" >= ${win.start}
      ), rel AS (
        SELECT "visitId", min("finalizedAt") AS at FROM rv GROUP BY 1
      ), msg AS (
        SELECT m."contextId" AS "visitId", bool_or(m.status IN ('DELIVERED', 'READ')) AS delivered
        FROM "MessageLog" m
        WHERE m."contextType" = 'REPORT' AND m."createdAt" >= ${win.start} AND m."contextId" IN (SELECT id FROM v)
        GROUP BY 1
      ), opened AS (
        SELECT DISTINCT rv."visitId" FROM rv
        JOIN "ReportAccessLog" l ON l."reportVersionId" = rv.id AND l."createdAt" >= ${win.start}
        WHERE l."accessedVia" IN ('TOKEN', 'PATIENT_PORTAL')
      )
      SELECT v."branchId", v."createdAt" AS reg,
        -- per visit through the visitId / testOrderId indexes
        (SELECT min(tr."createdAt") FROM "TestOrder" o JOIN "TestResult" tr ON tr."testOrderId" = o.id
          WHERE o."visitId" = v.id) AS entry,
        rel.at AS rel,
        v.status IN ('DRAFT', 'WAITING') AS open,
        msg."visitId" IS NOT NULL AS sent,
        coalesce(msg.delivered, false) AS delivered,
        opened."visitId" IS NOT NULL AS opened,
        v."reportPrintedAt" IS NOT NULL AS printed
      FROM v
      LEFT JOIN rel ON rel."visitId" = v.id
      LEFT JOIN msg ON msg."visitId" = v.id
      LEFT JOIN opened ON opened."visitId" = v.id`,

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
        FROM "Visit" v
        CROSS JOIN LATERAL (
          SELECT * FROM "TestOrder" o WHERE o."visitId" = v.id AND o."cancelledAt" IS NULL
            AND o."workflowMode" IN ('REPORTABLE', 'EXTERNAL_UPLOAD')
          OFFSET 0
        ) o
        WHERE v.domain = 'DIAGNOSTICS' AND v.status <> 'CANCELLED'
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

    // Clinic consults, this window and the comparison one. No time-with-doctor:
    // the desk marks visits done in batches (12 in two minutes on 6 Oct 2026)
    // and doctors never press Start, so those times describe the desk.
    prisma.$queryRaw<{ doctorId: string; doctorName: string; cur: boolean; digital: boolean; paper: boolean }[]>`
      SELECT cv."clinicDoctorId" AS "doctorId", d.name AS "doctorName", (cv."createdAt" >= ${win.start}) AS cur,
        EXISTS (SELECT 1 FROM "Prescription" p WHERE p."visitId" = v.id) AS digital,
        cv."rxOutcome" = 'PAPER' AS paper
      FROM "ClinicVisit" cv JOIN "Visit" v ON v.id = cv."visitId" JOIN "ClinicDoctor" d ON d.id = cv."clinicDoctorId"
      WHERE v.status <> 'CANCELLED' ${vBranch}
        AND ((cv."createdAt" >= ${win.start} AND cv."createdAt" < ${win.end})
          OR (cv."createdAt" >= ${prior.start} AND cv."createdAt" < ${prior.end}))`,

    // Team: who registered, who entered results, who released reports.
    prisma.$queryRaw<{ userId: string; branchId: string; n: number }[]>`
      SELECT a."userId", a."branchId", count(*)::int AS n FROM "AuditLog" a
      WHERE a."actionType" = 'CREATE' AND a."entityType" = 'VISIT' AND a."userId" IS NOT NULL
        AND a."createdAt" >= ${win.start} AND a."createdAt" < ${win.end} ${aBranch}
      GROUP BY 1, 2`,
    // TestResult has no date index, so start from visits (which do) and walk
    // down. ponytail: a result entered more than 30 days after registration is
    // missed; index TestResult."createdAt" if backlog entry ever matters here.
    prisma.$queryRaw<{ userId: string; branchId: string; n: number }[]>`
      SELECT x."userId", v."branchId", count(DISTINCT x."testOrderId")::int AS n
      FROM "Visit" v
      CROSS JOIN LATERAL (
        SELECT tr."enteredByUserId" AS "userId", tr."testOrderId"
        FROM "TestOrder" o JOIN "TestResult" tr ON tr."testOrderId" = o.id
        WHERE o."visitId" = v.id AND tr."enteredByUserId" IS NOT NULL
          AND tr."createdAt" >= ${win.start} AND tr."createdAt" < ${win.end}
        OFFSET 0
      ) x
      WHERE v."createdAt" >= ${new Date(win.start.getTime() - 30 * DAY_MS)} AND v."createdAt" < ${win.end} ${vBranch}
      GROUP BY 1, 2`,
    prisma.$queryRaw<{ userId: string; branchId: string; n: number }[]>`
      SELECT a."userId", a."branchId", count(*)::int AS n FROM "AuditLog" a
      WHERE a."actionType" = 'FINALIZE' AND a."entityType" = 'Report' AND a."userId" IS NOT NULL
        AND a."createdAt" >= ${win.start} AND a."createdAt" < ${win.end} ${aBranch}
      GROUP BY 1, 2`,
  ]);

  const codeOf = new Map(branchRows.map((b) => [b.id, b.code]));
  const scopedBranch = branchId ? branchRows.find((b) => b.id === branchId) ?? null : null;

  // --- pending (live) -------------------------------------------------------
  const open = openVisits.map((v) => {
    const outsideTests = num(v.outside);
    const names = v.names ?? [];
    return {
      visitId: v.id,
      patientName: v.name,
      patientTitle: v.title,
      branchCode: codeOf.get(v.branchId) ?? '?',
      tests: names.slice(0, 3).join(', ') + (names.length > 3 ? ` +${names.length - 3}` : ''),
      stage: (outsideTests > 0 ? 'outside' : v.partly || v.anyIn ? 'signoff' : 'results') as PendingStage,
      partlyOut: Boolean(v.partly),
      outsideTests,
      enteredBy: v.entered,
      ageMinutes: Math.floor(minutesBetween(v.createdAt, now)),
      branchId: v.branchId,
    };
  });

  const critical = criticalRows
    .map((c) => ({
      visitId: c.visitId,
      patientName: c.name,
      patientTitle: c.title,
      branchCode: codeOf.get(c.branchId) ?? '?',
      test: c.test,
      value: `${c.value ?? c.textValue ?? '—'}${c.unit ? ` ${c.unit}` : ''}`,
      flag: c.flag,
      enteredBy: c.by,
      enteredAt: c.at.toISOString(),
      released: Boolean(c.released),
    }))
    .sort((a, b) => (a.enteredAt < b.enteredAt ? 1 : -1));

  // One row per patient to call, newest failure first.
  const callMap = new Map<string, OperationsResponse['toCall'][number] & { kinds: Set<string> }>();
  for (const m of failedRows) {
    const k = m.patientId ?? `phone:${m.phone}`;
    const kind = String(m.contextType).toLowerCase();
    const cur = callMap.get(k);
    if (cur) {
      cur.kinds.add(kind);
      continue;
    }
    callMap.set(k, {
      patientId: m.patientId,
      patientName: m.patient?.name ?? '—',
      patientTitle: m.patient?.title ?? null,
      branchCode: m.branchId ? codeOf.get(m.branchId) ?? null : null,
      phone: m.phone,
      what: '',
      why: describeWaError(m.errorCode, m.failureReason).label,
      lastTriedIso: m.createdAt.toISOString(),
      kinds: new Set([kind]),
    });
  }
  const KIND: Record<string, string> = { report: 'Report', bill: 'Bill', prescription: 'Prescription', payment: 'Payment', reminder: 'Reminder' };
  const toCall = [...callMap.values()].map(({ kinds, ...r }) => ({ ...r, what: [...kinds].map((k) => KIND[k] ?? k).join(' + ') }));

  // --- branch status (live) --------------------------------------------------
  const regMap = new Map(registeredToday.map((r) => [r.branchId, num(r._count)]));
  const outMap = new Map(outToday.map((r) => [r.branchId, num(r.n)]));
  const relMap = new Map(lastRelease.map((r) => [r.branchId, r]));
  const entMap = new Map(lastEntry.map((r) => [r.branchId, r]));
  const failedToday = new Map<string, Set<string>>();
  for (const m of failedRows) {
    if (!m.branchId || m.createdAt < todayStart) continue;
    const s = failedToday.get(m.branchId) ?? new Set<string>();
    s.add(m.patientId ?? m.phone);
    failedToday.set(m.branchId, s);
  }
  const branches: BranchStatus[] = branchRows
    .filter((b) => !branchId || b.id === branchId)
    .map((b) => {
      const mine = open.filter((p) => p.branchId === b.id);
      return {
        branchId: b.id,
        code: b.code,
        name: b.name,
        registeredToday: regMap.get(b.id) ?? 0,
        outToday: outMap.get(b.id) ?? 0,
        inProgress: mine.filter((p) => p.ageMinutes <= SLA_MINUTES).length,
        late: mine.filter((p) => p.ageMinutes > SLA_MINUTES).length,
        clinicWaiting: clinicOpen.filter((c) => c.status === 'WAITING' && c.visit.branchId === b.id).length,
        notDeliveredToday: failedToday.get(b.id)?.size ?? 0,
        lastReleaseAt: relMap.get(b.id)?.at.toISOString() ?? null,
        lastReleaseBy: relMap.get(b.id)?.by ?? null,
        lastEntryAt: entMap.get(b.id)?.at.toISOString() ?? null,
        lastEntryBy: entMap.get(b.id)?.by ?? null,
      };
    })
    // Nothing today and no report in two days: a test or dormant branch.
    .filter((b) => branchId || b.registeredToday + b.outToday > 0 || b.lastReleaseAt);

  // --- the period's cohort ----------------------------------------------------
  type Row = (typeof cohort)[number];
  // Speed of one set of visits: the same measures for every branch and the total.
  const speedOf = (rows: Row[]): Speed => {
    const tats = rows.filter((r) => r.rel).map((r) => minutesBetween(r.reg, r.rel!)).filter((m) => m >= 0);
    const lateOpen = rows.filter((r) => !r.rel && r.open && minutesBetween(r.reg, now) > SLA_MINUTES).length;
    // Registration → first result entered → first report out. Visits with no
    // entered result (outside-lab PDFs only) can't be split and are left out.
    const split = rows.filter((r) => r.entry && r.rel && r.rel >= r.entry);
    // Same-day share by arrival time. Today's visits without a report can still
    // make it, so they're left out.
    const sameDay = (rs: Row[]) => {
      const done = rs.filter((r) => r.rel || toIstDateKey(r.reg) !== toIstDateKey(now));
      return pct(done.filter((r) => r.rel && toIstDateKey(r.rel) === toIstDateKey(r.reg)).length, done.length);
    };
    const evening = rows.filter((r) => istHour(r.reg) >= EVENING_HOUR);
    return {
      visits: rows.length,
      released: tats.length,
      medianMinutes: median(tats),
      within24Pct: pct(tats.filter((m) => m <= SLA_MINUTES).length, tats.length + lateOpen),
      waitForResultMinutes: median(split.map((r) => minutesBetween(r.reg, r.entry!))),
      toSignOffMinutes: median(split.map((r) => minutesBetween(r.entry!, r.rel!))),
      daySameDayPct: sameDay(rows.filter((r) => istHour(r.reg) < EVENING_HOUR)),
      eveningVisits: evening.length,
      eveningSameDayPct: sameDay(evening),
    };
  };
  const overall = speedOf(cohort);
  const branchSpeed = branchRows
    .map((b) => ({ code: b.code, name: b.name, ...speedOf(cohort.filter((r) => r.branchId === b.id)) }))
    .filter((b) => b.visits > 0)
    .sort((a, b) => b.visits - a.visits);

  const dayMap = new Map<string, { onTime: number; late: number; pending: number; tats: number[] }>();
  for (let t = win.start.getTime(); t < Math.min(win.end.getTime(), nowMs); t += DAY_MS) {
    dayMap.set(toIstDateKey(new Date(t)), { onTime: 0, late: 0, pending: 0, tats: [] });
  }
  for (const r of cohort) {
    const d = dayMap.get(toIstDateKey(r.reg));
    if (!d) continue;
    if (r.rel) {
      const tat = minutesBetween(r.reg, r.rel);
      d.tats.push(tat);
      if (tat <= SLA_MINUTES) d.onTime++;
      else d.late++;
    } else if (r.open) {
      if (minutesBetween(r.reg, now) > SLA_MINUTES) d.late++;
      else d.pending++;
    }
  }
  const byDay = [...dayMap.entries()].map(([date, d]) => ({
    date,
    onTime: d.onTime,
    late: d.late,
    pending: d.pending,
    medianMinutes: median(d.tats),
  }));

  const releasedRows = cohort.filter((r) => r.rel);
  const delivery = {
    released: releasedRows.length,
    sent: releasedRows.filter((r) => r.sent).length,
    delivered: releasedRows.filter((r) => r.delivered).length,
    opened: releasedRows.filter((r) => r.opened).length,
    printed: releasedRows.filter((r) => r.printed).length,
  };

  const departments = deptRows.map((d) => ({
    name: d.name,
    visits: num(d.visits),
    released: num(d.released),
    medianMinutes: d.p50 == null ? null : Math.round(num(d.p50)),
    within24Pct: pct(num(d.within), num(d.released)),
    filmsOnly: num(d.films),
  }));

  // --- clinic ---------------------------------------------------------------
  const nowMap = new Map<string, OperationsResponse['clinicNow'][number]>();
  for (const c of clinicOpen) {
    const cur =
      nowMap.get(c.clinicDoctorId) ??
      { doctorId: c.clinicDoctorId, doctorName: c.clinicDoctor.name.trim(), branchCode: codeOf.get(c.visit.branchId) ?? null, waiting: 0, withDoctor: 0, seenToday: 0, longestWaitMinutes: null };
    if (c.status === 'IN_PROGRESS') cur.withDoctor++;
    else {
      cur.waiting++;
      cur.longestWaitMinutes = Math.max(cur.longestWaitMinutes ?? 0, Math.floor(minutesBetween(c.createdAt, now)));
    }
    nowMap.set(c.clinicDoctorId, cur);
  }
  for (const g of clinicSeenToday) {
    const cur = nowMap.get(g.clinicDoctorId);
    if (cur) cur.seenToday = num(g._count);
  }
  const clinicNow = [...nowMap.values()].sort((a, b) => (b.longestWaitMinutes ?? 0) - (a.longestWaitMinutes ?? 0));

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
  const clinicDoctors = [...docMap.values()].filter((d) => d.consults > 0).sort((a, b) => b.consults - a.consults);

  // --- team -------------------------------------------------------------------
  const teamIds = [...new Set([...registeredBy, ...enteredBy, ...releasedBy].map((r) => r.userId))];
  const users = teamIds.length
    ? await prisma.user.findMany({ where: { id: { in: teamIds } }, select: { id: true, name: true, role: true } })
    : [];
  const countBy = (rs: { userId: string; n: number }[]) => {
    const m = new Map<string, number>();
    for (const r of rs) m.set(r.userId, (m.get(r.userId) ?? 0) + num(r.n));
    return m;
  };
  // Where each person worked in the period, busiest branch first.
  const worked = new Map<string, Map<string, number>>();
  for (const r of [...registeredBy, ...enteredBy, ...releasedBy]) {
    const m = worked.get(r.userId) ?? new Map<string, number>();
    m.set(r.branchId, (m.get(r.branchId) ?? 0) + num(r.n));
    worked.set(r.userId, m);
  }
  const reg = countBy(registeredBy);
  const ent = countBy(enteredBy);
  const rel = countBy(releasedBy);
  const team = users
    .map((u) => ({
      userId: u.id,
      name: u.name,
      role: String(u.role),
      branches: [...(worked.get(u.id) ?? new Map<string, number>()).entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([id]) => codeOf.get(id) ?? '?'),
      registered: reg.get(u.id) ?? 0,
      testsEntered: ent.get(u.id) ?? 0,
      reportsReleased: rel.get(u.id) ?? 0,
    }))
    .sort((a, b) => b.reportsReleased + b.registered - (a.reportsReleased + a.registered) || b.testsEntered - a.testsEntered);

  const response: OperationsResponse = {
    generatedAt: now.toISOString(),
    period: { key: period, startIso: win.start.toISOString(), endIso: win.end.toISOString() },
    branchScope: { branchId, branchName: scopedBranch?.name ?? null },
    branches,
    pending: open.map(({ branchId: _b, ...p }) => p),
    critical,
    toCall,
    overall,
    branchSpeed,
    byDay,
    departments,
    delivery,
    team,
    clinicNow,
    clinicDoctors,
  };

  if (redis) {
    redis
      .set(key, JSON.stringify(response), 'EX', CACHE_TTL_SEC)
      .catch((err) => logger.warn({ err, branchId }, 'owner-operations: cache write failed'));
  }
  return response;
}
