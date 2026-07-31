/**
 * Anomaly projector — populates the AnomalyEvent read-model from the underlying
 * sources so the Audit & Anomalies page can keyset-paginate + filter by
 * severity/category over a 1-year window in plain SQL (no six-way live merge).
 *
 * Sources (all carry a branchId + a stable timestamp + a stable id → a
 * deterministic dedupeKey, so projection is idempotent — safe to re-run):
 *   - AuditLog        (deletes, finalizes, payouts, drafts, role changes …)
 *   - Bill discounts  (₹ amount + reason + who → the real money signal)
 *   - OrderRefund     (refunds / cancellations, ₹ amount + reason)
 *
 * Freshness without a scheduler: the read path calls `ensureProjected()` which
 * re-projects a bounded recent window, throttled per branch. Historical beyond
 * the cap needs a one-off backfill (projectWindow with a wide range).
 */
import prisma from "../lib/prisma";
import { AuditActionType, Prisma } from "@prisma/client";

export type Severity = "high" | "medium" | "low" | "info";
export type Category =
  | "money"
  | "report"
  | "drafts"
  | "identity"
  | "access"
  | "destructive"
  | "ops";

const LARGE_AMOUNT_PAISE = 200000; // ₹2,000

/** Classify a raw AuditLog row into the display taxonomy. Finalize + access are
 *  routine baselines (INFO) — the alarm is editing AFTER finalize / bulk access. */
function classifyAudit(
  actionType: AuditActionType,
  entityType: string,
): { category: Category; severity: Severity; event: string } {
  switch (actionType) {
    case AuditActionType.DELETE:
      return { category: "destructive", severity: "high", event: `Deleted ${entityType}` };
    case AuditActionType.PAYOUT_DELETE:
      return { category: "destructive", severity: "high", event: "Payout deleted" };
    case AuditActionType.PAYOUT_PAID:
      return { category: "money", severity: "high", event: "Payout paid" };
    case AuditActionType.PAYOUT_DERIVE:
      return { category: "money", severity: "medium", event: "Payout derived" };
    case AuditActionType.FINALIZE:
      return { category: "report", severity: "info", event: "Report finalized" };
    case AuditActionType.REPORT_ACCESS:
      return { category: "access", severity: "info", event: "Report accessed" };
    case AuditActionType.UPDATE:
      if (entityType === "ReportDraft")
        return { category: "drafts", severity: "info", event: "Report draft written / edited" };
      if (entityType === "ReportVersion")
        return { category: "report", severity: "high", event: "Report changed after finalize" };
      if (entityType === "Bill")
        return { category: "money", severity: "medium", event: "Bill updated" };
      return { category: "ops", severity: "low", event: `Updated ${entityType}` };
    case AuditActionType.CREATE:
      if (entityType === "Patient")
        return { category: "identity", severity: "low", event: "Patient created" };
      return { category: "ops", severity: "low", event: `Created ${entityType}` };
    default:
      return { category: "ops", severity: "low", event: `${actionType} ${entityType}` };
  }
}

const band = (score: number): Severity =>
  score >= 4 ? "high" : score >= 2 ? "medium" : "low";

const rupees = (paise: number) =>
  `₹${(paise / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

function parseJson(v: string | null): any {
  if (!v) return null;
  try { return JSON.parse(v); } catch { return null; }
}

/**
 * A post-bill visit correction is logged as `UPDATE Visit` with the real action
 * inside newValues.action. These are the staff "mistakes" (rework): a wrong
 * referral fixed, the wrong test swapped, tests added after billing. Returns the
 * classification, or null for a plain visit update.
 */
function correctionEvent(nv: any): {
  event: string; category: Category; severity: Severity;
  detail: string; reason: string | null; amountInPaise: number | null;
} | null {
  const reason = (nv?.reason as string) ?? null;
  switch (nv?.action) {
    case "REFERRAL_CHANGE":
      return {
        event: "Referral changed", category: "money", severity: "medium",
        detail: `${nv?.referralDoctorName ?? "—"}${reason ? ` · ${reason}` : ""}`,
        reason, amountInPaise: null,
      };
    case "PRODUCT_SWAP":
      return {
        event: "Test swapped", category: "report", severity: "medium",
        detail: `→ ${nv?.productName ?? "—"}${reason ? ` · ${reason}` : ""}`,
        reason, amountInPaise: null,
      };
    case "ADD_TESTS_TO_BILL":
      return {
        event: "Tests added to bill", category: "money", severity: "high",
        detail: reason ?? "post-bill add", reason,
        amountInPaise: typeof nv?.totalAmountInPaise === "number" ? nv.totalAmountInPaise : null,
      };
    default:
      return null;
  }
}

type ProjRow = Prisma.AnomalyEventCreateManyInput;

/** Project one window (idempotent upsert by dedupeKey). Bounded by `take` caps. */
export async function projectWindow(
  from: Date,
  to: Date,
  branchId: string | null,
): Promise<number> {
  const branchWhere = branchId ? { branchId } : {};
  const window = { gte: from, lte: to };

  const [auditRows, bills, refunds, reopens] = await Promise.all([
    prisma.auditLog.findMany({
      where: { createdAt: window, ...branchWhere },
      orderBy: { createdAt: "desc" },
      take: 20000,
      select: {
        id: true, branchId: true, actionType: true, entityType: true,
        entityId: true, userId: true, createdAt: true, newValues: true,
      },
    }),
    prisma.bill.findMany({
      where: { discountAmountInPaise: { gt: 0 }, billedAt: window, ...branchWhere },
      orderBy: { billedAt: "desc" },
      take: 5000,
      select: {
        id: true, branchId: true, billNumber: true, totalAmountInPaise: true,
        discountAmountInPaise: true, discountPercentage: true, discountReason: true,
        discountedByUserId: true, billedAt: true,
        visit: { select: { id: true, patient: { select: { name: true } } } },
      },
    }),
    prisma.orderRefund.findMany({
      where: { createdAt: window, ...branchWhere },
      orderBy: { createdAt: "desc" },
      take: 5000,
      select: {
        id: true, branchId: true, kind: true, amountInPaise: true, reason: true,
        createdByUserId: true, createdAt: true,
        bill: { select: { billNumber: true, visit: { select: { id: true, patient: { select: { name: true } } } } } },
      },
    }),
    prisma.testOrder.findMany({
      where: { reopenedAt: window, reopenedByUserId: { not: null }, ...branchWhere },
      orderBy: { reopenedAt: "desc" },
      take: 5000,
      select: {
        id: true, branchId: true, reopenedAt: true, reopenedByUserId: true,
        testNameSnapshot: true,
        visit: { select: { id: true, patient: { select: { name: true } } } },
      },
    }),
  ]);

  // Batched actor-name lookup across all sources.
  const userIds = Array.from(new Set([
    ...auditRows.map((r) => r.userId),
    ...bills.map((b) => b.discountedByUserId),
    ...refunds.map((r) => r.createdByUserId),
    ...reopens.map((r) => r.reopenedByUserId),
  ].filter((v): v is string => Boolean(v))));
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, role: true } })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  // Draft rows key entityId to the visit — resolve those patients in one query.
  const draftVisitIds = Array.from(new Set(
    auditRows.filter((r) => r.entityType === "ReportDraft").map((r) => r.entityId),
  ));
  const draftVisits = draftVisitIds.length
    ? await prisma.visit.findMany({ where: { id: { in: draftVisitIds } }, select: { id: true, patient: { select: { name: true } } } })
    : [];
  const draftPatient = new Map(draftVisits.map((v) => [v.id, v.patient?.name ?? null]));

  const auditEvents: ProjRow[] = auditRows.map((r) => {
    const u0 = r.userId ? userMap.get(r.userId) : null;
    // Post-bill visit corrections (staff "mistakes") — the real action is in
    // newValues.action, not the actionType.
    if (r.actionType === "UPDATE" && r.entityType === "Visit") {
      const m = correctionEvent(parseJson(r.newValues));
      if (m) {
        return {
          id: `al:${r.id}`, dedupeKey: `al:${r.id}`, branchId: r.branchId,
          occurredAt: r.createdAt, severity: m.severity, category: m.category,
          score: m.severity === "high" ? 4 : m.severity === "medium" ? 2 : 1,
          event: m.event, detail: m.detail,
          actorUserId: r.userId, actorName: u0?.name ?? null, actorRole: u0?.role ?? null,
          entityType: "Visit", entityId: r.entityId, patientName: null,
          amountInPaise: m.amountInPaise, reason: m.reason,
          drillTo: `/diagnostics/results/${r.entityId}`,
          sourceKind: "audit", sourceId: r.id,
        };
      }
    }
    const c = classifyAudit(r.actionType, r.entityType);
    const u = r.userId ? userMap.get(r.userId) : null;
    const isDraft = c.category === "drafts";
    const patientName = isDraft ? draftPatient.get(r.entityId) ?? null : null;
    return {
      id: `al:${r.id}`, dedupeKey: `al:${r.id}`, branchId: r.branchId,
      occurredAt: r.createdAt, severity: c.severity, category: c.category,
      score: c.severity === "high" ? 4 : c.severity === "medium" ? 2 : 1,
      event: c.event, detail: patientName ?? "",
      actorUserId: r.userId, actorName: u?.name ?? null, actorRole: u?.role ?? null,
      entityType: r.entityType, entityId: r.entityId, patientName,
      amountInPaise: null, reason: null,
      drillTo: isDraft ? `/diagnostics/results/${r.entityId}` : null,
      sourceKind: "audit", sourceId: r.id,
    };
  });

  const discountEvents: ProjRow[] = bills.map((b) => {
    const total = Math.max(0, b.totalAmountInPaise);
    const pct = b.discountPercentage ?? (total > 0 ? (b.discountAmountInPaise / total) * 100 : 0);
    const hasReason = Boolean(b.discountReason && b.discountReason.trim());
    let score = 1;
    if (pct >= 50 || b.discountAmountInPaise >= LARGE_AMOUNT_PAISE) score += 3;
    else if (pct >= 20) score += 1;
    if (!hasReason) score += 1;
    const u = b.discountedByUserId ? userMap.get(b.discountedByUserId) : null;
    const patientName = b.visit?.patient?.name ?? null;
    const detail = `${Math.round(pct)}% off ${rupees(total)} · ${hasReason ? b.discountReason : "no reason"}${patientName ? ` · ${patientName}` : ""}`;
    return {
      id: `disc:${b.id}`, dedupeKey: `disc:${b.id}`, branchId: b.branchId,
      occurredAt: b.billedAt, severity: band(score), category: "money", score,
      event: "Discount applied", detail,
      actorUserId: b.discountedByUserId, actorName: u?.name ?? null, actorRole: u?.role ?? null,
      entityType: "Bill", entityId: b.id, patientName,
      amountInPaise: b.discountAmountInPaise, reason: b.discountReason ?? null,
      drillTo: b.visit ? `/diagnostics/results/${b.visit.id}` : null,
      sourceKind: "discount", sourceId: b.id,
    };
  });

  const refundEvents: ProjRow[] = refunds.map((r) => {
    let score = 3;
    if (r.amountInPaise >= LARGE_AMOUNT_PAISE) score += 1;
    const u = r.createdByUserId ? userMap.get(r.createdByUserId) : null;
    const patientName = r.bill?.visit?.patient?.name ?? null;
    const isCancel = r.kind === "CANCEL";
    const detail = `${isCancel ? "Cancelled" : `Refund ${rupees(r.amountInPaise)}`} · ${r.reason}${patientName ? ` · ${patientName}` : ""}`;
    return {
      id: `refund:${r.id}`, dedupeKey: `refund:${r.id}`, branchId: r.branchId,
      occurredAt: r.createdAt, severity: "high", category: "money", score,
      event: isCancel ? "Order cancelled" : "Refund issued", detail,
      actorUserId: r.createdByUserId, actorName: u?.name ?? null, actorRole: u?.role ?? null,
      entityType: "OrderRefund", entityId: r.id, patientName,
      amountInPaise: r.amountInPaise, reason: r.reason,
      drillTo: r.bill?.visit ? `/diagnostics/results/${r.bill.visit.id}` : null,
      sourceKind: "refund", sourceId: r.id,
    };
  });

  // Film-only reopens (a correction/rework) — a point event, insert-only.
  const reopenEvents: ProjRow[] = reopens.map((r) => {
    const u = r.reopenedByUserId ? userMap.get(r.reopenedByUserId) : null;
    const patientName = r.visit?.patient?.name ?? null;
    return {
      id: `reopen:${r.id}`, dedupeKey: `reopen:${r.id}`, branchId: r.branchId,
      occurredAt: r.reopenedAt ?? new Date(), severity: "medium", category: "report", score: 2,
      event: "Test reopened",
      detail: `${r.testNameSnapshot ?? "test"}${patientName ? ` · ${patientName}` : ""}`,
      actorUserId: r.reopenedByUserId, actorName: u?.name ?? null, actorRole: u?.role ?? null,
      entityType: "TestOrder", entityId: r.id, patientName,
      amountInPaise: null, reason: null,
      drillTo: r.visit ? `/diagnostics/results/${r.visit.id}` : null,
      sourceKind: "reopen", sourceId: r.id,
    };
  });

  // Immutable point events → insert-only (createMany skipDuplicates).
  const inserted = await prisma.anomalyEvent.createMany({
    data: [...auditEvents, ...reopenEvents],
    skipDuplicates: true,
  });

  // Discounts + refunds can change (a discount edited at collect-time) → upsert.
  const mutable = [...discountEvents, ...refundEvents];
  for (const e of mutable) {
    const { id: _id, dedupeKey, ...rest } = e;
    await prisma.anomalyEvent.upsert({
      where: { dedupeKey },
      create: e,
      update: rest,
    });
  }

  return inserted.count + mutable.length;
}

// Freshness: re-project a bounded recent window on read, throttled per branch.
const lastProjected = new Map<string, number>();
const THROTTLE_MS = 120_000; // re-scan sources at most once / 2 min per branch
const CAP_DAYS = 45;

export async function ensureProjected(
  branchId: string | null,
  from: Date,
  to: Date,
): Promise<void> {
  const key = branchId ?? "__all__";
  const now = Date.now();
  if (now - (lastProjected.get(key) ?? 0) < THROTTLE_MS) return;
  lastProjected.set(key, now);
  const capFrom = new Date(Math.max(from.getTime(), now - CAP_DAYS * 864e5));
  if (capFrom.getTime() >= to.getTime()) return;
  try {
    await projectWindow(capFrom, to, branchId);
  } catch (err) {
    lastProjected.set(key, 0); // let the next read retry
    console.error("anomaly projection failed:", err);
  }
}

/**
 * One-off backfill — materialize up to `days` of history by walking backwards in
 * weekly chunks (each chunk stays under the per-window row caps). Fire-and-forget
 * from an owner endpoint; idempotent, so re-running is safe. Lets the scorecard's
 * Yearly / All-time and long feed history be complete without waiting for the
 * incremental on-read projection to accumulate.
 */
export async function backfillProjection(
  days: number,
  branchId: string | null,
): Promise<void> {
  const now = Date.now();
  const totalMs = Math.min(Math.max(1, days), 366) * 864e5;
  const chunkMs = 7 * 864e5;
  for (let offset = 0; offset < totalMs; offset += chunkMs) {
    const to = new Date(now - offset);
    const from = new Date(Math.max(now - totalMs, now - offset - chunkMs));
    try {
      await projectWindow(from, to, branchId);
    } catch (err) {
      console.error("anomaly backfill chunk failed:", err);
    }
  }
}
