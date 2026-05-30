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
 *   - audit             Latest 20 anomalies (identity / discount / multi-patient phone / off-hours)
 *   - commsFailures     Failed MessageLog rows in last 24h, grouped by reason
 */

import prisma from '../lib/prisma';
import { getRedisClient } from '../lib/redis';
import { logger } from '../lib/logger';

const CACHE_TTL_SEC = 30; // shorter TTL — this page is meant to feel live
const cacheKey = (branchId: string | null) =>
  `owner-operations:v1:${branchId ?? 'all'}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLA_TAT_MINUTES = 24;

export interface OperationsKpi {
  tatMedianMinutes: number | null;
  tatSampleCount: number;
  finalizedToday: number;
  finalizableToday: number;
  inQueue: number;
  deliveryRatePercent: number | null;
  deliveryAttempted: number;
}

export interface TatHistogramBin {
  rangeMin: number;
  rangeMax: number; // exclusive; 999 means open-ended (30+)
  count: number;
}

export interface TatHistogram {
  bins: TatHistogramBin[];
  p50Minutes: number | null;
  p95Minutes: number | null;
  slaMinutes: number;
  breachCount: number;
  sampleCount: number;
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
  tatHistogram: TatHistogram;
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

function buildHistogram(durations: number[]): TatHistogramBin[] {
  // 3-min bins from 0..30, then a 30+ open-ended bin
  const bins: TatHistogramBin[] = [];
  for (let lo = 0; lo < 30; lo += 3) {
    bins.push({ rangeMin: lo, rangeMax: lo + 3, count: 0 });
  }
  bins.push({ rangeMin: 30, rangeMax: 999, count: 0 });
  for (const d of durations) {
    const idx = d >= 30 ? bins.length - 1 : Math.min(bins.length - 2, Math.floor(d / 3));
    bins[idx].count += 1;
  }
  return bins;
}

function isOffHoursIst(d: Date): boolean {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  const h = ist.getUTCHours();
  return h < 8 || h >= 20;
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

  const [
    scopedBranch,
    last100Finalized,
    finalizedToday,
    finalizableTodayOrders,
    inQueueCount,
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
  ] = await Promise.all([
    branchId
      ? prisma.branch.findUnique({
          where: { id: branchId },
          select: { id: true, name: true },
        })
      : Promise.resolve(null),

    // Last 100 finalized for histogram + p50
    prisma.reportVersion.findMany({
      where: {
        status: 'FINALIZED',
        ...(branchId ? { report: { branchId } } : {}),
      },
      orderBy: { finalizedAt: 'desc' },
      take: 100,
      select: {
        finalizedAt: true,
        report: { select: { visit: { select: { createdAt: true } } } },
      },
    }),

    prisma.reportVersion.count({
      where: {
        status: 'FINALIZED',
        finalizedAt: { gte: todayStart, lt: tomorrowStart },
        ...(branchId ? { report: { branchId } } : {}),
      },
    }),

    prisma.testOrder.count({
      where: {
        createdAt: { gte: todayStart, lt: tomorrowStart },
        workflowMode: 'REPORTABLE',
        ...(branchId ? { branchId } : {}),
      },
    }),

    prisma.visit.count({
      where: {
        status: { in: ['WAITING', 'IN_PROGRESS'] },
        ...(branchId ? { branchId } : {}),
      },
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
      where: { createdAt: { gte: todayStart, lt: tomorrowStart } },
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
        createdAt: true,
        patient: { select: { name: true, title: true } },
      },
    }),

    prisma.messageLog.findMany({
      where: {
        status: 'FAILED',
        createdAt: { gte: yesterdayStart },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: {
        id: true,
        channel: true,
        contextType: true,
        failureReason: true,
        createdAt: true,
        patient: { select: { name: true } },
      },
    }),

    prisma.branch.findMany({ select: { id: true, code: true, name: true } }),
  ]);

  const branchById = new Map(branches.map((b) => [b.id, b]));

  // --- TAT histogram + KPIs ----------------------------------------------
  const durations = last100Finalized
    .filter((r) => r.report?.visit?.createdAt && r.finalizedAt)
    .map(
      (r) =>
        (r.finalizedAt!.getTime() - r.report!.visit.createdAt.getTime()) / 60_000,
    )
    .filter((d) => d >= 0);
  const sortedDurations = [...durations].sort((a, b) => a - b);
  const tatP50 = percentile(sortedDurations, 50);
  const tatP95 = percentile(sortedDurations, 95);
  const breachCount = durations.filter((d) => d > SLA_TAT_MINUTES).length;
  const tatHistogram: TatHistogram = {
    bins: buildHistogram(durations),
    p50Minutes: tatP50,
    p95Minutes: tatP95,
    slaMinutes: SLA_TAT_MINUTES,
    breachCount,
    sampleCount: durations.length,
  };

  // delivery rate today
  let deliveredToday = 0;
  let attemptedToday = 0;
  for (const row of commsToday) {
    const c = (row._count as any) ?? 0;
    if (row.status === 'SENT' || row.status === 'FAILED') attemptedToday += c;
    else if (row.status === 'DELIVERED' || row.status === 'READ') {
      deliveredToday += c;
      attemptedToday += c;
    }
  }
  const deliveryRate = attemptedToday > 0 ? Math.round((deliveredToday / attemptedToday) * 100) : null;

  const kpis: OperationsKpi = {
    tatMedianMinutes: tatP50,
    tatSampleCount: durations.length,
    finalizedToday,
    finalizableToday: finalizableTodayOrders,
    inQueue: inQueueCount,
    deliveryRatePercent: deliveryRate,
    deliveryAttempted: attemptedToday,
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
      patientTitle: cv.visit.patient.title,
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
  const audit: AuditRow[] = [];
  for (const c of auditIdentity) {
    audit.push({
      id: `id-${c.id}`,
      severity: c.changeReason ? 'medium' : 'high',
      event: 'Identity field changed',
      who: c.changedRole,
      detail: `${c.patient.name}: ${c.fieldName} ${c.oldValue ?? '∅'} → ${c.newValue ?? '∅'}${c.changeReason ? '' : ' (no reason)'}`,
      whenIso: c.createdAt.toISOString(),
      drillTo: `/clinic/patient-360/${c.patientId}`,
    });
  }
  for (const b of auditDiscounts) {
    audit.push({
      id: `disc-${b.id}`,
      severity: 'high',
      event: `Discount ${Math.round(b.discountPercentage ?? 0)}%`,
      who: null,
      detail: `${b.visit.patient.name} · ${b.billNumber} · ₹${Math.round(b.discountAmountInPaise / 100).toLocaleString('en-IN')} off`,
      whenIso: b.billedAt.toISOString(),
      drillTo: null,
    });
  }
  for (const a of auditOffHours) {
    if (!isOffHoursIst(a.createdAt)) continue;
    audit.push({
      id: `audit-${a.id}`,
      severity: 'medium',
      event: `Off-hours ${a.actionType}`,
      who: a.userId ? `user ${a.userId.slice(0, 6)}` : null,
      detail: `${a.entityType} ${a.entityId.slice(0, 8)}`,
      whenIso: a.createdAt.toISOString(),
      drillTo: null,
    });
  }
  audit.sort((a, b) => (a.whenIso < b.whenIso ? 1 : -1));
  const auditTrimmed = audit.slice(0, 20);

  // --- comms failures ------------------------------------------------------
  const commsFailureRows: CommsFailureRow[] = commsFailures.map((m) => ({
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
    tatHistogram,
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
