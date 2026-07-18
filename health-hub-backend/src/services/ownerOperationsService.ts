/**
 * Owner Operations page aggregations.
 *
 * Backs GET /api/owner/operations. Answers: are reports going out on time,
 * where is the queue stuck, what looks wrong, what failed.
 *
 * Sections:
 *   - kpis              TAT median / Reports finalized / In queue / Delivery rate
 *   - tatHistogram      Last 100 finalized reports bucketed in 3-min bins
 *   - diagnosticsQueue  Live, age-tinted list of unfinalized orders
 *   - clinicQueue       Grouped by clinic doctor on shift
 *   - audit             Latest 20 anomalies (identity / discount / deletions), scored
 *                       high/medium/low via a base-tier + context-modifier model
 *   - commsFailures     Failed MessageLog rows in last 24h, grouped by reason
 */

import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';

const CACHE_TTL_SEC = 30; // shorter TTL — this page is meant to feel live
const cacheKey = (branchId: string | null) =>
  `owner-operations:v2:${branchId ?? 'all'}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLA_TAT_MINUTES = 1440; // 24 hours from registration (owner decision)

// Discount-audit thresholds (P1-E): control which discounts ENTER the feed.
const DISCOUNT_AUDIT_PERCENT = 10; // fire audit at >= 10%
const DISCOUNT_AUDIT_PAISE = 50_000; // ...or >= ₹500 absolute

// ── Severity scoring model ────────────────────────────────────────────────
// Every audit event gets a base score by type, plus context modifiers, then
// the total maps to a band. This replaces the old per-source hardcoded tiers
// (which never produced "low" and ignored discount-as-%-of-bill). Each factor
// records a human reason so the detail line can explain WHY it scored.
const SEV_LARGE_AMOUNT_PAISE = 200_000; // >= ₹2,000 absolute → +1
const SEV_PCT_HIGH = 50; // >= 50% of bill → +2
const SEV_PCT_MED = 20; // 20–50% of bill → +1
const IDENTITY_REPEAT_THRESHOLD = 2; // > this many identity edits to one patient → +1

type Severity = 'high' | 'medium' | 'low';

function bandFromScore(score: number): Severity {
  if (score >= 4) return 'high';
  if (score >= 2) return 'medium';
  return 'low';
}

// Fold the scoring reasons into the detail line so the frontend needs no change
// and the owner can see why a row is flagged (e.g. "· 83% of bill · off-hours").
function withReasons(detail: string, reasons: string[]): string {
  return reasons.length ? `${detail} · ${reasons.join(' · ')}` : detail;
}

// Catalog (config) edits we surface in the feed, mapped to a friendly label.
// These are logged to AuditLog by the billable-products / clinical-panels routes.
const CATALOG_ENTITY_LABELS: Record<string, string> = {
  BillableProduct: 'Billable product',
  ClinicalPanel: 'Clinical panel',
};

// Pull a human name out of an AuditLog old/newValues JSON blob (the catalog
// routes stash { name, displayName } there) so the feed can show what changed.
function catalogDisplayName(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return v?.displayName || v?.name || null;
  } catch {
    return null;
  }
}

export interface OperationsKpi {
  tatMedianMinutes: number | null;
  tatSampleCount: number;
  finalizedToday: number;
  finalizableToday: number;
  inQueue: number;
  inQueueDiagnostics: number;
  inQueueClinic: number;
  deliveryRatePercent: number | null;
  deliveryAttempted: number;
  inFlight: number;
}

export interface TurnaroundBucket {
  label: string;
  count: number;
}

export interface ReportTurnaround {
  sampleCount: number;
  windowDays: number;
  medianMinutes: number | null;
  slaMinutes: number;
  withinSlaPercent: number | null; // share finalized within the SLA (<= 24h)
  overSlaCount: number;
  buckets: TurnaroundBucket[];
}

export interface DiagnosticsQueueRow {
  visitId: string;
  patientName: string;
  patientTitle: string | null;
  branchCode: string;
  productName: string | null;
  stage:
    | 'awaiting result entry'
    | 'in progress'
    | 'draft · awaiting sign-off'
    | 'sample pending'
    | 'PDF missing';
  ageMinutes: number;
}

export interface ClinicQueueDoctor {
  doctorId: string;
  doctorName: string;
  branchName: string | null;
  shiftStartIso: string | null;
  waitingCount: number;
  inProgressCount: number;
  avgWaitMinutes: number | null;
  patients: Array<{
    visitId: string;
    patientName: string;
    patientTitle: string;
    visitType: 'OP' | 'IP';
    waitMinutes: number;
  }>;
}

export interface AuditRow {
  id: string;
  severity: 'high' | 'medium' | 'low';
  event: string;
  who: string | null;
  detail: string;
  whenIso: string;
  drillTo: string | null;
}

export interface CommsFailureRow {
  patientName: string;
  patientTitle: string | null;
  channel: 'WHATSAPP' | 'SMS';
  context: string;
  failureReason: string;
  action: string;
  failedAtIso: string;
}

export interface OperationsResponse {
  generatedAt: string;
  branchScope: { branchId: string | null; branchName: string | null };
  kpis: OperationsKpi;
  reportTurnaround: ReportTurnaround;
  diagnosticsQueue: DiagnosticsQueueRow[];
  clinicQueue: ClinicQueueDoctor[];
  audit: AuditRow[];
  commsFailures: CommsFailureRow[];
}

// --- helpers ------------------------------------------------------------

function startOfTodayIst(now: Date): Date {
  const istNow = new Date(now.getTime() + IST_OFFSET_MS);
  istNow.setUTCHours(0, 0, 0, 0);
  return new Date(istNow.getTime() - IST_OFFSET_MS);
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// Fixed, human-readable turnaround buckets. Unlike a data-driven histogram, a
// single slow outlier can't stretch the scale — it just lands in the last
// bucket. Boundaries are inclusive-upper so "12–24h" matches the 24h SLA.
const TURNAROUND_BUCKETS: { label: string; maxMinutes: number }[] = [
  { label: 'Under 4h', maxMinutes: 4 * 60 },
  { label: '4–12h', maxMinutes: 12 * 60 },
  { label: '12–24h', maxMinutes: 24 * 60 },
  { label: '1–3 days', maxMinutes: 72 * 60 },
  { label: 'Over 3 days', maxMinutes: Infinity },
];

function buildTurnaroundBuckets(durations: number[]): TurnaroundBucket[] {
  const counts: TurnaroundBucket[] = TURNAROUND_BUCKETS.map((b) => ({
    label: b.label,
    count: 0,
  }));
  for (const d of durations) {
    let idx = TURNAROUND_BUCKETS.findIndex((b) => d <= b.maxMinutes);
    if (idx === -1) idx = counts.length - 1;
    counts[idx].count += 1;
  }
  return counts;
}

function isOffHoursIst(d: Date): boolean {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const minutesOfDay = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  // Off-hours = 10:00pm–7:30am IST. A diagnostic centre runs into the evening,
  // so only genuinely late/early activity is a signal (not normal evening work).
  return minutesOfDay >= 22 * 60 || minutesOfDay < 7 * 60 + 30;
}

function commsFailureAction(reason: string): string {
  const lower = (reason || '').toLowerCase();
  if (lower.includes('opt')) return 'send sms';
  if (lower.includes('not registered') || lower.includes('invalid')) return 'call patient';
  if (lower.includes('template')) return 'open template settings';
  return 'review';
}

// --- main entry ---------------------------------------------------------

export async function getOwnerOperations(
  branchId: string | null,
): Promise<OperationsResponse> {
  const redis = getRedisClient();
  if (redis) {
    try {
      const hit = await redis.get(cacheKey(branchId));
      if (hit) return JSON.parse(hit) as OperationsResponse;
    } catch (err) {
      logger.warn({ err, branchId }, 'owner-operations: cache read failed');
    }
  }

  const now = new Date();
  const todayStart = startOfTodayIst(now);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);
  const yesterdayStart = new Date(now.getTime() - DAY_MS);
  const sevenDaysStart = new Date(now.getTime() - 7 * DAY_MS);

  const [
    scopedBranch,
    turnaroundRows,
    finalizedTodayRows,
    finalizableTodayVisits,
    inQueueByDomain,
    diagnosticsRaw,
    diagnosticsFinalized,
    clinicWaitingRows,
    clinicInProgressRows,
    commsToday,
    auditIdentity,
    auditDiscounts,
    auditOffHours,
    commsFailures,
    branches,
    auditNoReport,
    auditReopened,
    auditCancelRefunds,
  ] = await Promise.all([
    branchId
      ? prisma.branch.findUnique({
          where: { id: branchId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),

    // Report turnaround sample: finalized reports whose VISIT was registered in
    // the last 7 days. Scoping by REGISTRATION date (not "last N finalized")
    // keeps backlog cleanups — old visits bulk-finalized recently — out of the
    // numbers, so the median/buckets reflect current turnaround. take is a
    // generous safety bound; real 7-day volume sits well under it.
    prisma.reportVersion.findMany({
      where: {
        status: 'FINALIZED',
        report: {
          ...(branchId ? { branchId } : {}),
          visit: { createdAt: { gte: sevenDaysStart } },
        },
      },
      orderBy: { finalizedAt: 'desc' },
      take: 2000,
      select: {
        finalizedAt: true,
        report: { select: { visit: { select: { createdAt: true } } } },
      },
    }),

    // Finalized today as DISTINCT visits (a multi-test visit finalizes one report).
    prisma.reportVersion.findMany({
      where: {
        status: 'FINALIZED',
        finalizedAt: { gte: todayStart, lt: tomorrowStart },
        ...(branchId ? { report: { branchId } } : {}),
      },
      select: { report: { select: { visitId: true } } },
    }),

    // Finalizable today as DISTINCT visits having >= 1 REPORTABLE order today.
    prisma.testOrder.findMany({
      where: {
        createdAt: { gte: todayStart, lt: tomorrowStart },
        workflowMode: 'REPORTABLE',
        ...(branchId ? { branchId } : {}),
      },
      select: { visitId: true },
      distinct: ['visitId'],
    }),

    // In-queue split by domain (P0-D): grouped so the KPI reconciles with the
    // two domain-scoped queue cards below.
    prisma.visit.groupBy({
      by: ['domain'],
      where: {
        status: { in: ['WAITING', 'IN_PROGRESS'] },
        ...(branchId ? { branchId } : {}),
      },
      _count: true,
    }),

    // Diagnostics queue — visits not yet finalized, with patient + first product
    prisma.visit.findMany({
      where: {
        domain: 'DIAGNOSTICS',
        status: { in: ['WAITING', 'IN_PROGRESS'] },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 50,
      select: {
        id: true,
        createdAt: true,
        status: true,
        branchId: true,
        patient: { select: { name: true, title: true } },
        testOrders: {
          select: {
            workflowMode: true,
            product: { select: { name: true } },
            testNameSnapshot: true,
            testResults: { select: { id: true }, take: 1 },
            externalUploads: { select: { id: true }, take: 1 },
          },
          take: 5,
        },
        report: {
          select: {
            versions: {
              orderBy: { versionNum: 'desc' },
              take: 1,
              select: { status: true },
            },
          },
        },
      },
    }),

    prisma.visit.findMany({
      where: {
        domain: 'DIAGNOSTICS',
        status: 'COMPLETED',
        ...(branchId ? { branchId } : {}),
        report: {
          versions: {
            some: { status: 'DRAFT' },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 25,
      select: {
        id: true,
        createdAt: true,
        branchId: true,
        patient: { select: { name: true, title: true } },
        testOrders: {
          select: { product: { select: { name: true } }, testNameSnapshot: true },
          take: 1,
        },
        report: {
          select: {
            versions: {
              orderBy: { versionNum: 'desc' },
              take: 1,
              select: { status: true },
            },
          },
        },
      },
    }),

    prisma.clinicVisit.findMany({
      where: {
        status: 'WAITING',
        ...(branchId ? { visit: { branchId } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: {
        id: true,
        createdAt: true,
        clinicDoctorId: true,
        visitType: true,
        clinicDoctor: { select: { name: true } },
        visit: {
          select: {
            patient: { select: { name: true, title: true } },
            branch: { select: { name: true } },
          },
        },
      },
    }),

    prisma.clinicVisit.findMany({
      where: {
        status: 'IN_PROGRESS',
        ...(branchId ? { visit: { branchId } } : {}),
      },
      select: {
        id: true,
        clinicDoctorId: true,
        startedAt: true,
        clinicDoctor: { select: { name: true } },
        visit: { select: { branch: { select: { name: true } } } },
      },
    }),

    prisma.messageLog.groupBy({
      by: ['status'],
      where: {
        createdAt: { gte: todayStart, lt: tomorrowStart },
        ...(branchId ? { branchId } : {}),
      },
      _count: true,
    }),

    prisma.patientChangeLog.findMany({
      where: { changeType: 'IDENTITY', createdAt: { gte: yesterdayStart } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: {
        id: true,
        patientId: true,
        fieldName: true,
        oldValue: true,
        newValue: true,
        changeReason: true,
        changedRole: true,
        changedBy: true,
        createdAt: true,
        patient: { select: { name: true, title: true } },
      },
    }),

    // Recent bills with significant discounts (P1-E: threshold, not rupee-one)
    prisma.bill.findMany({
      where: {
        billedAt: { gte: yesterdayStart },
        ...(branchId ? { branchId } : {}),
        OR: [
          { discountPercentage: { gte: DISCOUNT_AUDIT_PERCENT } },
          { discountAmountInPaise: { gte: DISCOUNT_AUDIT_PAISE } },
        ],
      },
      orderBy: { billedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        discountPercentage: true,
        discountAmountInPaise: true,
        discountReason: true,
        totalAmountInPaise: true,
        billNumber: true,
        billedAt: true,
        discountedByUser: { select: { name: true } },
        visit: { select: { patient: { select: { name: true } } } },
      },
    }),

    // Recent audit log entries: deletions/payout removals (off-hours anomaly)
    // and catalog edits (products / panels — name pulled from old/newValues).
    prisma.auditLog.findMany({
      where: {
        createdAt: { gte: yesterdayStart },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        actionType: true,
        entityType: true,
        entityId: true,
        userId: true,
        oldValues: true,
        newValues: true,
        createdAt: true,
      },
    }),

    // Failed message deliveries in last 24h
    prisma.messageLog.findMany({
      where: {
        status: 'FAILED',
        createdAt: { gte: yesterdayStart },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        channel: true,
        contextType: true,
        failureReason: true,
        createdAt: true,
        patient: { select: { name: true, title: true } },
      },
    }),

    prisma.branch.findMany({ select: { id: true, code: true, name: true } }),

    // No-report-needed closes (films-only) in the last 24h — a reportable order
    // closed without a written report because the patient declined. Surfaced in
    // the audit feed so owners see it happening (money-neutral, but auditable).
    prisma.testOrder.findMany({
      where: {
        noReportAt: { gte: yesterdayStart },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { noReportAt: 'desc' },
      take: 10,
      select: {
        id: true,
        testNameSnapshot: true,
        noReportAt: true,
        noReportReason: true,
        noReportByUser: { select: { name: true } },
        visit: { select: { patientId: true, patient: { select: { name: true } } } },
      },
    }),

    // Reopened films-only closes in the last 24h — a "no report needed" close
    // reversed so the test re-enters the report workflow. Routine; audit-only.
    prisma.testOrder.findMany({
      where: {
        reopenedAt: { gte: yesterdayStart },
        noReportAt: null,
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { reopenedAt: 'desc' },
      take: 10,
      select: {
        id: true,
        testNameSnapshot: true,
        reopenedAt: true,
        reopenedByUser: { select: { name: true } },
        visit: { select: { patientId: true, patient: { select: { name: true } } } },
      },
    }),

    // Cancel / refund of billed tests in the last 24h. The refund route is the
    // ONLY writer of entityType 'Bill' audit rows (ORDER_REFUND = cash returned,
    // ORDER_CANCEL = charge reversal only), so a dedicated query surfaces them
    // reliably instead of competing for slots in the shared 50-row audit pull.
    prisma.auditLog.findMany({
      where: {
        entityType: 'Bill',
        actionType: 'UPDATE',
        createdAt: { gte: yesterdayStart },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        entityId: true,
        userId: true,
        newValues: true,
        createdAt: true,
      },
    }),
  ]);

  const branchById = new Map((branches ?? []).map((b) => [b.id, b]));

  // --- report turnaround + KPIs -------------------------------------------
  const durations = turnaroundRows
    .filter((r) => r.report?.visit?.createdAt && r.finalizedAt)
    .map(
      (r) =>
        (r.finalizedAt!.getTime() - r.report!.visit.createdAt.getTime()) / 60_000,
    )
    .filter((d) => d >= 0);
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const tatMedian = percentile(sortedDurations, 50);
  const withinSlaCount = durations.filter((d) => d <= SLA_TAT_MINUTES).length;
  const reportTurnaround: ReportTurnaround = {
    sampleCount: durations.length,
    windowDays: 7,
    medianMinutes: tatMedian,
    slaMinutes: SLA_TAT_MINUTES,
    withinSlaPercent:
      durations.length > 0
        ? Math.round((withinSlaCount / durations.length) * 100)
        : null,
    overSlaCount: durations.length - withinSlaCount,
    buckets: buildTurnaroundBuckets(durations),
  };

  // delivery rate today (P0-A): denominator excludes in-flight SENT.
  // attempted = DELIVERED + READ + FAILED; SENT is surfaced separately as inFlight.
  let deliveredToday = 0;
  let attemptedToday = 0;
  let inFlightToday = 0;
  for (const row of commsToday) {
    const c = (row._count as any) ?? 0;
    if (row.status === 'SENT') {
      inFlightToday += c;
    } else if (row.status === 'FAILED') {
      attemptedToday += c;
    } else if (row.status === 'DELIVERED' || row.status === 'READ') {
      deliveredToday += c;
      attemptedToday += c;
    }
  }
  const deliveryRate = attemptedToday > 0 ? Math.round((deliveredToday / attemptedToday) * 100) : null;

  // P0-B: distinct-visit counts (a 3-test visit counts once, not three times).
  const finalizedDistinctVisits = new Set(
    finalizedTodayRows
      .map((r) => r.report?.visitId)
      .filter((v): v is string => Boolean(v)),
  ).size;
  const finalizableDistinctVisits = finalizableTodayVisits.length;

  // P0-D: in-queue split by domain so the KPI reconciles with the two cards.
  let inQueueDiagnostics = 0;
  let inQueueClinic = 0;
  for (const row of inQueueByDomain) {
    const c = (row._count as any) ?? 0;
    if (row.domain === 'DIAGNOSTICS') inQueueDiagnostics += c;
    else if (row.domain === 'CLINIC') inQueueClinic += c;
  }

  const kpis: OperationsKpi = {
    tatMedianMinutes: tatMedian,
    tatSampleCount: durations.length,
    finalizedToday: finalizedDistinctVisits,
    finalizableToday: finalizableDistinctVisits,
    inQueue: inQueueDiagnostics + inQueueClinic,
    inQueueDiagnostics,
    inQueueClinic,
    deliveryRatePercent: deliveryRate,
    deliveryAttempted: attemptedToday,
    inFlight: inFlightToday,
  };

  // --- diagnostics queue ---------------------------------------------------
  const diagnosticsQueue: DiagnosticsQueueRow[] = [];
  for (const v of diagnosticsRaw) {
    const orders = v.testOrders;
    const externalUploadOrder = orders.find((o) => o.workflowMode === 'EXTERNAL_UPLOAD');
    let stage: DiagnosticsQueueRow['stage'];
    if (externalUploadOrder && externalUploadOrder.externalUploads.length === 0) {
      stage = 'PDF missing';
    } else if (v.status === 'WAITING') {
      stage = 'sample pending';
    } else if (v.report?.versions[0]?.status === 'DRAFT') {
      stage = 'draft · awaiting sign-off';
    } else if (orders.every((o) => o.testResults.length === 0)) {
      stage = 'awaiting result entry';
    } else {
      stage = 'in progress';
    }
    const productName =
      orders[0]?.product?.name ?? orders[0]?.testNameSnapshot ?? null;
    const ageMinutes = Math.floor((now.getTime() - v.createdAt.getTime()) / 60_000);
    diagnosticsQueue.push({
      visitId: v.id,
      patientName: v.patient.name,
      patientTitle: v.patient.title,
      branchCode: branchById.get(v.branchId)?.code ?? '?',
      productName,
      stage,
      ageMinutes,
    });
  }
  // append draft-awaiting-sign-off completed visits with finalized status
  for (const v of diagnosticsFinalized) {
    if (diagnosticsQueue.some((q) => q.visitId === v.id)) continue;
    if (v.report?.versions[0]?.status !== 'DRAFT') continue;
    const productName =
      v.testOrders[0]?.product?.name ?? v.testOrders[0]?.testNameSnapshot ?? null;
    const ageMinutes = Math.floor((now.getTime() - v.createdAt.getTime()) / 60_000);
    diagnosticsQueue.push({
      visitId: v.id,
      patientName: v.patient.name,
      patientTitle: v.patient.title,
      branchCode: branchById.get(v.branchId)?.code ?? '?',
      productName,
      stage: 'draft · awaiting sign-off',
      ageMinutes,
    });
  }
  diagnosticsQueue.sort((a, b) => b.ageMinutes - a.ageMinutes);

  // --- clinic queue grouped by doctor --------------------------------------
  const clinicMap = new Map<string, ClinicQueueDoctor>();
  for (const cv of clinicInProgressRows) {
    const cur = clinicMap.get(cv.clinicDoctorId) ?? {
      doctorId: cv.clinicDoctorId,
      doctorName: cv.clinicDoctor.name,
      branchName: cv.visit?.branch?.name ?? null,
      shiftStartIso: cv.startedAt?.toISOString() ?? null,
      waitingCount: 0,
      inProgressCount: 0,
      avgWaitMinutes: null,
      patients: [],
    };
    cur.inProgressCount += 1;
    if (cv.startedAt && (!cur.shiftStartIso || new Date(cur.shiftStartIso) > cv.startedAt)) {
      cur.shiftStartIso = cv.startedAt.toISOString();
    }
    clinicMap.set(cv.clinicDoctorId, cur);
  }
  const waitsByDoctor = new Map<string, number[]>();
  for (const cv of clinicWaitingRows) {
    const cur = clinicMap.get(cv.clinicDoctorId) ?? {
      doctorId: cv.clinicDoctorId,
      doctorName: cv.clinicDoctor.name,
      branchName: cv.visit?.branch?.name ?? null,
      shiftStartIso: null,
      waitingCount: 0,
      inProgressCount: 0,
      avgWaitMinutes: null,
      patients: [],
    };
    const wait = Math.floor((now.getTime() - cv.createdAt.getTime()) / 60_000);
    cur.waitingCount += 1;
    cur.patients.push({
      visitId: cv.id,
      patientName: cv.visit.patient.name,
      patientTitle: cv.visit.patient.title ?? '',
      visitType: cv.visitType as 'OP' | 'IP',
      waitMinutes: wait,
    });
    const arr = waitsByDoctor.get(cv.clinicDoctorId) ?? [];
    arr.push(wait);
    waitsByDoctor.set(cv.clinicDoctorId, arr);
    clinicMap.set(cv.clinicDoctorId, cur);
  }
  for (const [doctorId, arr] of waitsByDoctor) {
    const cur = clinicMap.get(doctorId);
    if (!cur) continue;
    cur.avgWaitMinutes =
      arr.length > 0 ? Math.round(arr.reduce((s, v) => s + v, 0) / arr.length) : null;
    cur.patients.sort((a, b) => b.waitMinutes - a.waitMinutes);
  }
  const clinicQueue = Array.from(clinicMap.values()).sort((a, b) => {
    const aMax = Math.max(0, ...a.patients.map((p) => p.waitMinutes));
    const bMax = Math.max(0, ...b.patients.map((p) => p.waitMinutes));
    return bMax - aMax;
  });

  // --- audit feed ----------------------------------------------------------
  // Resolve who made each identity change: PatientChangeLog stores changedBy
  // (a User id, no FK relation), so look the names up in one batched query and
  // fall back to the role string when the user no longer exists.
  const actorIds = [
    ...new Set(
      [
        ...auditIdentity.map((c) => c.changedBy),
        ...auditOffHours.map((a) => a.userId),
        ...auditCancelRefunds.map((a) => a.userId),
      ].filter((v): v is string => Boolean(v)),
    ),
  ];
  const actorUsers = actorIds.length
    ? await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })
    : [];
  const userNameById = new Map(actorUsers.map((u) => [u.id, u.name]));

  const audit: AuditRow[] = [];

  // Identity changes: a single edit is MEDIUM (base 2) — usually a legit
  // correction, occasionally a cover. Repeated edits to the SAME patient escalate
  // to HIGH (+2). Off-hours adds +1.
  const identityCountByPatient = new Map<string, number>();
  for (const c of auditIdentity) {
    identityCountByPatient.set(c.patientId, (identityCountByPatient.get(c.patientId) ?? 0) + 1);
  }
  for (const c of auditIdentity) {
    const reasons: string[] = [];
    let score = 2;
    if (!c.changeReason) reasons.push('no reason');
    if ((identityCountByPatient.get(c.patientId) ?? 0) > IDENTITY_REPEAT_THRESHOLD) {
      score += 2;
      reasons.push('repeated edits to this patient');
    }
    if (isOffHoursIst(c.createdAt)) {
      score += 1;
      reasons.push('off-hours');
    }
    audit.push({
      id: `id-${c.id}`,
      severity: bandFromScore(score),
      event: 'Identity field changed',
      who: userNameById.get(c.changedBy) ?? c.changedRole,
      detail: withReasons(
        `${c.patient.name}: ${c.fieldName} ${c.oldValue ?? '∅'} → ${c.newValue ?? '∅'}`,
        reasons,
      ),
      whenIso: c.createdAt.toISOString(),
      drillTo: `/clinic/patient-360/${c.patientId}`,
    });
  }

  // Discounts: base 1 (LOW); a big discount — ≥50% of the bill OR ≥₹2,000
  // absolute — is HIGH; a moderate 20–50% is MEDIUM. No-reason and off-hours add
  // +1 each. Works for both percentage and amount discounts.
  for (const b of auditDiscounts) {
    const reasons: string[] = [];
    let score = 1;
    // Effective % of bill — the real signal. Amount discounts report 0% in
    // discountPercentage, so derive it from the amount vs the bill total.
    const effectivePct =
      b.totalAmountInPaise > 0
        ? (b.discountAmountInPaise / b.totalAmountInPaise) * 100
        : (b.discountPercentage ?? 0);
    if (effectivePct >= SEV_PCT_HIGH) {
      score += 3; // ≥50% of bill → HIGH
      reasons.push(`${Math.round(effectivePct)}% of bill`);
    } else if (effectivePct >= SEV_PCT_MED) {
      score += 1; // 20–50% → MEDIUM
      reasons.push(`${Math.round(effectivePct)}% of bill`);
    }
    if (b.discountAmountInPaise >= SEV_LARGE_AMOUNT_PAISE) {
      score += 3; // ≥₹2,000 absolute → HIGH
      reasons.push('large amount');
    }
    if (!b.discountReason) {
      score += 1;
      reasons.push('no reason');
    }
    if (isOffHoursIst(b.billedAt)) {
      score += 1;
      reasons.push('off-hours');
    }
    // Amount-based discounts have no percentage — show the rupee amount instead
    // of a misleading "Discount 0%".
    const pct = b.discountPercentage ?? 0;
    const discountLabel =
      pct > 0
        ? `Discount ${Math.round(pct)}%`
        : `Discount ₹${Math.round(b.discountAmountInPaise / 100).toLocaleString('en-IN')}`;
    const discountBase = `${b.visit.patient.name} · ${b.billNumber} · ₹${Math.round(b.discountAmountInPaise / 100).toLocaleString('en-IN')} off`;
    audit.push({
      id: `disc-${b.id}`,
      severity: bandFromScore(score),
      event: discountLabel,
      who: b.discountedByUser?.name ?? null,
      // Surface the operator's stated reason (e.g. "Camp discount") next to the
      // numbers; the reasons[] tail still explains the severity scoring.
      detail: withReasons(
        b.discountReason ? `${discountBase} · ${b.discountReason}` : discountBase,
        reasons,
      ),
      whenIso: b.billedAt.toISOString(),
      drillTo: null,
    });
  }

  // Deletions & payout removals are the highest-value signals for an owner:
  // base 4 → HIGH regardless of hour. Generic off-hours CREATE/UPDATE rows are
  // intentionally NOT surfaced as standalone events any more — off-hours is now
  // a modifier on the events that matter, which cuts noise.
  for (const a of auditOffHours) {
    // Catalog edits (billable products / clinical panels): informational, low
    // severity. Surfaced so owners see when the price list or report
    // definitions change. Delete is nudged to medium as it's more impactful.
    const catalogLabel = CATALOG_ENTITY_LABELS[a.entityType];
    if (
      catalogLabel &&
      (a.actionType === 'CREATE' || a.actionType === 'UPDATE' || a.actionType === 'DELETE')
    ) {
      const reasons: string[] = [];
      let score = a.actionType === 'DELETE' ? 2 : 1;
      if (isOffHoursIst(a.createdAt)) {
        score += 1;
        reasons.push('off-hours');
      }
      const verb =
        a.actionType === 'CREATE'
          ? 'created'
          : a.actionType === 'DELETE'
            ? 'deleted'
            : 'updated';
      const name =
        catalogDisplayName(a.newValues) ??
        catalogDisplayName(a.oldValues) ??
        a.entityId.slice(0, 8);
      audit.push({
        id: `catalog-${a.id}`,
        severity: bandFromScore(score),
        event: `${catalogLabel} ${verb}`,
        who: a.userId ? userNameById.get(a.userId) ?? `user ${a.userId.slice(0, 6)}` : null,
        detail: withReasons(name, reasons),
        whenIso: a.createdAt.toISOString(),
        drillTo: null,
      });
      continue;
    }

    const isDelete = a.actionType === 'DELETE' || a.actionType === 'PAYOUT_DELETE';
    if (!isDelete) continue;
    const reasons: string[] = [];
    let score = 4;
    if (isOffHoursIst(a.createdAt)) {
      score += 1;
      reasons.push('off-hours');
    }
    const label = a.actionType === 'PAYOUT_DELETE' ? 'Payout deleted' : `${a.entityType} deleted`;
    audit.push({
      id: `audit-${a.id}`,
      severity: bandFromScore(score),
      event: label,
      who: a.userId ? userNameById.get(a.userId) ?? `user ${a.userId.slice(0, 6)}` : null,
      detail: withReasons(`${a.entityType} ${a.entityId.slice(0, 8)}`, reasons),
      whenIso: a.createdAt.toISOString(),
      drillTo: null,
    });
  }

  // No-report-needed closes (films-only) and reopens are routine clinical
  // decisions — always LOW, never escalated by off-hours (a diagnostic centre
  // runs in the evening). Surfaced for the audit trail, not as anomalies.
  for (const t of auditNoReport) {
    if (!t.noReportAt) continue;
    const base = `${t.visit.patient.name} · ${t.testNameSnapshot}${
      t.noReportReason ? ` · ${t.noReportReason}` : ''
    }`;
    audit.push({
      id: `noreport-${t.id}`,
      severity: 'low',
      event: 'No report needed',
      who: t.noReportByUser?.name ?? null,
      detail: base,
      whenIso: t.noReportAt.toISOString(),
      drillTo: `/clinic/patient-360/${t.visit.patientId}`,
    });
  }
  for (const t of auditReopened) {
    if (!t.reopenedAt) continue;
    audit.push({
      id: `reopened-${t.id}`,
      severity: 'low',
      event: 'Reopened',
      who: t.reopenedByUser?.name ?? null,
      detail: `${t.visit.patient.name} · ${t.testNameSnapshot}`,
      whenIso: t.reopenedAt.toISOString(),
      drillTo: `/clinic/patient-360/${t.visit.patientId}`,
    });
  }

  // Cancel / refund of billed tests — money reversed or returned to the patient,
  // so owners see it in the trail. Base 1 (LOW, routine); ≥ ₹2,000 reversed or
  // refunded makes it HIGH; a missing reason and off-hours each add +1.
  const rupees = (paise: number) =>
    `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
  for (const a of auditCancelRefunds) {
    let parsed:
      | {
          action?: string;
          billNumber?: string;
          patientId?: string;
          patientName?: string;
          chargeReversedInPaise?: number;
          refundedInPaise?: number;
          reason?: string;
        }
      | null = null;
    try {
      parsed = a.newValues ? JSON.parse(a.newValues) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.action !== 'ORDER_REFUND' && parsed.action !== 'ORDER_CANCEL')) {
      continue;
    }
    const reversedPaise = Number(parsed.chargeReversedInPaise) || 0;
    const refundedPaise = Number(parsed.refundedInPaise) || 0;
    const reasons: string[] = [];
    let score = 1;
    if (Math.max(reversedPaise, refundedPaise) >= SEV_LARGE_AMOUNT_PAISE) {
      score += 3; // ≥ ₹2,000 reversed/returned → HIGH
      reasons.push('large amount');
    }
    if (!parsed.reason) {
      score += 1;
      reasons.push('no reason');
    }
    if (isOffHoursIst(a.createdAt)) {
      score += 1;
      reasons.push('off-hours');
    }
    const billNumber = parsed.billNumber || a.entityId.slice(0, 8);
    const base =
      (parsed.patientName ? `${parsed.patientName} · ` : '') +
      `${billNumber} · ${rupees(reversedPaise)} cancelled` +
      (refundedPaise > 0 && refundedPaise !== reversedPaise
        ? ` · ${rupees(refundedPaise)} refunded`
        : '') +
      (parsed.reason ? ` · ${parsed.reason}` : '');
    audit.push({
      id: `refund-${a.id}`,
      severity: bandFromScore(score),
      event: refundedPaise > 0 ? `Refund ${rupees(refundedPaise)}` : 'Tests cancelled',
      who: a.userId ? userNameById.get(a.userId) ?? `user ${a.userId.slice(0, 6)}` : null,
      detail: withReasons(base, reasons),
      whenIso: a.createdAt.toISOString(),
      drillTo: parsed.patientId ? `/clinic/patient-360/${parsed.patientId}` : null,
    });
  }
  audit.sort((a, b) => (a.whenIso < b.whenIso ? 1 : -1));
  const auditTrimmed = audit.slice(0, 20);

  // --- comms failures ------------------------------------------------------
  const commsFailureRows: CommsFailureRow[] = (commsFailures ?? []).map((m) => ({
    patientName: m.patient?.name ?? '—',
    patientTitle: m.patient?.title ?? null,
    channel: m.channel as 'WHATSAPP' | 'SMS',
    context: String(m.contextType).toLowerCase(),
    failureReason: m.failureReason || 'unknown',
    action: commsFailureAction(m.failureReason ?? ''),
    failedAtIso: m.createdAt.toISOString(),
  }));

  const response: OperationsResponse = {
    generatedAt: now.toISOString(),
    branchScope: { branchId: branchId ?? null, branchName: scopedBranch?.name ?? null },
    kpis,
    reportTurnaround,
    diagnosticsQueue,
    clinicQueue,
    audit: auditTrimmed,
    commsFailures: commsFailureRows,
  };

  if (redis) {
    redis
      .set(cacheKey(branchId), JSON.stringify(response), 'EX', CACHE_TTL_SEC)
      .catch((err) => logger.warn({ err, branchId }, 'owner-operations: cache write failed'));
  }

  return response;
}
