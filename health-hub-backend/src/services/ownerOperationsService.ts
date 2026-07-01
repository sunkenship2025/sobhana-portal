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
  `owner-operations:v2:${branchId ?? 'all'}`;

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLA_TAT_MINUTES = 1440; // 24 hours from registration (owner decision)

// Discount-audit thresholds (P1-E)
const DISCOUNT_AUDIT_PERCENT = 10; // fire audit at >= 10%
const DISCOUNT_AUDIT_PAISE = 50_000; // ...or >= ₹500 absolute
const DISCOUNT_HIGH_PERCENT = 30; // "high" severity tier
const DISCOUNT_HIGH_PAISE = 200_000; // ...or >= ₹2,000 absolute

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
  xMaxMinutes: number; // data-driven upper bound of the x-axis (for frontend scaling)
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

const HISTOGRAM_BIN_COUNT = 11; // 10 fixed-width bins + 1 open-ended overflow bin

/**
 * Data-driven histogram. The x-range is derived from the data (p95 + largest
 * non-empty observation, padded 10%) instead of a hardcoded 33-min window, so
 * the same chart works whether durations are minutes or many hours.
 * Returns the bins plus the xMax the frontend should scale to.
 */
function buildHistogram(
  durations: number[],
  p95: number | null,
): { bins: TatHistogramBin[]; xMaxMinutes: number } {
  const maxObserved = durations.length > 0 ? Math.max(...durations) : 0;
  // Use p95 (robust) and the largest observation as anchors; pad 10%.
  const rawMax = Math.max(p95 ?? 0, maxObserved);
  // Round to a sensible step and guarantee a non-zero range.
  const xMaxMinutes = Math.max(30, Math.ceil((rawMax * 1.1) / 5) * 5);
  const binWidth = xMaxMinutes / (HISTOGRAM_BIN_COUNT - 1);

  const bins: TatHistogramBin[] = [];
  for (let i = 0; i < HISTOGRAM_BIN_COUNT - 1; i += 1) {
    bins.push({ rangeMin: i * binWidth, rangeMax: (i + 1) * binWidth, count: 0 });
  }
  // Final open-ended overflow bin (anything >= xMax).
  bins.push({ rangeMin: xMaxMinutes, rangeMax: 999_999, count: 0 });

  for (const d of durations) {
    const idx =
      d >= xMaxMinutes
        ? bins.length - 1
        : Math.min(bins.length - 2, Math.floor(d / binWidth));
    bins[idx].count += 1;
  }
  return { bins, xMaxMinutes };
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
        billNumber: true,
        billedAt: true,
        discountedByUser: { select: { name: true } },
        visit: { select: { patient: { select: { name: true } } } },
      },
    }),

    // Recent audit log entries (for off-hours anomaly detection)
    prisma.auditLog.findMany({
      where: {
        createdAt: { gte: yesterdayStart },
        ...(branchId ? { branchId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
      select: {
        id: true,
        actionType: true,
        entityType: true,
        entityId: true,
        userId: true,
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
  ]);

  const branchById = new Map((branches ?? []).map((b) => [b.id, b]));

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
  const { bins: histogramBins, xMaxMinutes } = buildHistogram(durations, tatP95);
  const tatHistogram: TatHistogram = {
    bins: histogramBins,
    p50Minutes: tatP50,
    p95Minutes: tatP95,
    slaMinutes: SLA_TAT_MINUTES,
    breachCount,
    sampleCount: durations.length,
    xMaxMinutes,
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
    tatMedianMinutes: tatP50,
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
  const changedByIds = [...new Set(auditIdentity.map((c) => c.changedBy).filter(Boolean))];
  const changedByUsers = changedByIds.length
    ? await prisma.user.findMany({ where: { id: { in: changedByIds } }, select: { id: true, name: true } })
    : [];
  const userNameById = new Map(changedByUsers.map((u) => [u.id, u.name]));

  const audit: AuditRow[] = [];
  for (const c of auditIdentity) {
    audit.push({
      id: `id-${c.id}`,
      severity: c.changeReason ? 'medium' : 'high',
      event: 'Identity field changed',
      who: userNameById.get(c.changedBy) ?? c.changedRole,
      detail: `${c.patient.name}: ${c.fieldName} ${c.oldValue ?? '∅'} → ${c.newValue ?? '∅'}${c.changeReason ? '' : ' (no reason)'}`,
      whenIso: c.createdAt.toISOString(),
      drillTo: `/clinic/patient-360/${c.patientId}`,
    });
  }
  for (const b of auditDiscounts) {
    // P1-E: reserve "high" for the top tier; the query already enforced the
    // audit threshold (>= 10% or >= ₹500), so everything here is at least medium.
    const pct = b.discountPercentage ?? 0;
    const isHigh =
      pct >= DISCOUNT_HIGH_PERCENT || b.discountAmountInPaise >= DISCOUNT_HIGH_PAISE;
    // Amount-based discounts have no percentage — show the rupee amount instead
    // of a misleading "Discount 0%".
    const discountLabel =
      pct > 0
        ? `Discount ${Math.round(pct)}%`
        : `Discount ₹${Math.round(b.discountAmountInPaise / 100).toLocaleString('en-IN')}`;
    audit.push({
      id: `disc-${b.id}`,
      severity: isHigh ? 'high' : 'medium',
      event: discountLabel,
      who: b.discountedByUser?.name ?? null,
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
