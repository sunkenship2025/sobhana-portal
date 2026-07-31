/**
 * Owner Audit & Anomalies — paginated feed over the materialized AnomalyEvent
 * read-model (populated by anomalyProjectorService). Because severity/category/
 * amount are STORED columns, the page keyset-paginates and filters by
 * severity/category in plain SQL over a 1-year window — no six-way live merge,
 * and money rows carry the ₹ amount + reason + who.
 */
import prisma from "../lib/prisma";
import { Prisma } from "@prisma/client";
import { ensureProjected } from "./anomalyProjectorService";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // default = today-ish
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export type AuditSeverity = "high" | "medium" | "low" | "info";
export type AuditCategory =
  | "money" | "report" | "drafts" | "identity" | "access" | "destructive" | "ops";

export interface AuditEventRow {
  id: string;
  severity: AuditSeverity;
  category: AuditCategory;
  event: string;
  who: string | null;
  role: string | null;
  entityType: string;
  entityId: string;
  detail: string;
  amountInPaise: number | null;
  whenIso: string;
  drillTo: string | null;
  actionType: string;
}
export interface AuditEventsParams {
  branchId: string | null;
  severity?: string | null;
  category?: string | null;
  actor?: string | null;
  q?: string | null;
  from?: string | null;
  to?: string | null;
  cursor?: string | null;
  limit?: number | null;
}
export interface AuditEventsResult {
  items: AuditEventRow[];
  nextCursor: string | null;
  from: string;
  to: string;
  summary: {
    total: number;
    severity: Record<AuditSeverity, number>;
    category: Record<AuditCategory, number>;
    highlights: {
      deletions: number;
      payoutsPaid: number;
      billChanges: number;
      postFinalizeEdits: number;
      finalized: number;
      drafts: number;
      reportAccess: number;
      topActor: { name: string; count: number } | null;
    };
  };
}
export interface AuditDiffRow {
  field: string;
  old: string | null;
  new: string | null;
}
export interface AuditEventDetail extends AuditEventRow {
  ipAddress: string | null;
  userAgent: string | null;
  reason: string | null;
  diff: AuditDiffRow[];
  related: Array<{
    id: string;
    severity: AuditSeverity;
    event: string;
    who: string | null;
    whenIso: string;
    isThis: boolean;
  }>;
}

const parseList = (v?: string | null): string[] =>
  (v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const clampLimit = (v?: number | null): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
};
const encodeCursor = (occurredAt: Date, id: string): string =>
  `${occurredAt.toISOString()}|${id}`;
const decodeCursor = (cursor: string): { at: Date; id: string } | null => {
  const idx = cursor.indexOf("|");
  if (idx < 0) return null;
  const at = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(at.getTime()) || !id) return null;
  return { at, id };
};

function resolveWindow(fromRaw?: string | null, toRaw?: string | null) {
  const now = Date.now();
  const to = toRaw ? new Date(toRaw) : new Date(now);
  let from = fromRaw ? new Date(fromRaw) : new Date(now - DEFAULT_WINDOW_MS);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime()))
    from = new Date(now - DEFAULT_WINDOW_MS);
  if (to.getTime() - from.getTime() > YEAR_MS) from = new Date(to.getTime() - YEAR_MS);
  return { from, to };
}

export async function getAuditEvents(
  params: AuditEventsParams,
): Promise<AuditEventsResult> {
  const limit = clampLimit(params.limit);
  const { from, to } = resolveWindow(params.from, params.to);

  // Keep the recent window materialized (throttled per branch).
  await ensureProjected(params.branchId, from, to);

  const and: Prisma.AnomalyEventWhereInput[] = [{ occurredAt: { gte: from, lte: to } }];
  if (params.branchId) and.push({ branchId: params.branchId });
  if (params.actor) and.push({ actorUserId: params.actor });
  const sevs = parseList(params.severity).filter((s) =>
    ["high", "medium", "low", "info"].includes(s));
  if (sevs.length) and.push({ severity: { in: sevs } });
  const cats = parseList(params.category);
  if (cats.length) and.push({ category: { in: cats } });
  const q = params.q?.trim();
  if (q) {
    and.push({
      OR: [
        { detail: { contains: q, mode: "insensitive" } },
        { event: { contains: q, mode: "insensitive" } },
        { entityId: { contains: q, mode: "insensitive" } },
        { actorName: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  // Facet + highlight aggregates over the whole filtered window.
  const [sevGroups, catGroups, eventGroups, actorGroups] = await Promise.all([
    prisma.anomalyEvent.groupBy({ by: ["severity"], where: { AND: and }, _count: { _all: true } }),
    prisma.anomalyEvent.groupBy({ by: ["category"], where: { AND: and }, _count: { _all: true } }),
    prisma.anomalyEvent.groupBy({ by: ["event"], where: { AND: and }, _count: { _all: true } }),
    prisma.anomalyEvent.groupBy({
      by: ["actorName"],
      where: { AND: [...and, { actorName: { not: null } }] },
      _count: { _all: true },
      orderBy: { _count: { actorName: "desc" } },
      take: 1,
    }),
  ]);
  const severityCounts: Record<AuditSeverity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  let total = 0;
  for (const g of sevGroups) {
    severityCounts[g.severity as AuditSeverity] = g._count._all;
    total += g._count._all;
  }
  const categoryCounts: Record<AuditCategory, number> = {
    money: 0, report: 0, drafts: 0, identity: 0, access: 0, destructive: 0, ops: 0,
  };
  for (const g of catGroups) categoryCounts[g.category as AuditCategory] = g._count._all;
  const ev = new Map(eventGroups.map((g) => [g.event, g._count._all]));
  const evc = (name: string) => ev.get(name) ?? 0;
  const topActor =
    actorGroups.length && actorGroups[0].actorName
      ? { name: actorGroups[0].actorName, count: actorGroups[0]._count._all }
      : null;
  const highlights = {
    deletions: categoryCounts.destructive,
    payoutsPaid: evc("Payout paid"),
    billChanges: evc("Discount applied") + evc("Refund issued") + evc("Order cancelled") + evc("Bill updated"),
    postFinalizeEdits: evc("Report changed after finalize"),
    finalized: evc("Report finalized"),
    drafts: categoryCounts.drafts,
    reportAccess: evc("Report accessed"),
    topActor,
  };

  // Keyset page.
  const cur = params.cursor ? decodeCursor(params.cursor) : null;
  const pageAnd = cur
    ? [...and, {
        OR: [
          { occurredAt: { lt: cur.at } },
          { AND: [{ occurredAt: cur.at }, { id: { lt: cur.id } }] },
        ],
      } as Prisma.AnomalyEventWhereInput]
    : and;
  const rows = await prisma.anomalyEvent.findMany({
    where: { AND: pageAnd },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true, severity: true, category: true, event: true, actorName: true,
      actorRole: true, entityType: true, entityId: true, detail: true,
      amountInPaise: true, occurredAt: true, drillTo: true, sourceKind: true,
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const items: AuditEventRow[] = page.map((r) => ({
    id: r.id,
    severity: r.severity as AuditSeverity,
    category: r.category as AuditCategory,
    event: r.event,
    who: r.actorName,
    role: r.actorRole,
    entityType: r.entityType,
    entityId: r.entityId,
    detail: r.detail,
    amountInPaise: r.amountInPaise,
    whenIso: r.occurredAt.toISOString(),
    drillTo: r.drillTo,
    actionType: r.sourceKind,
  }));
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.occurredAt, last.id) : null;

  return {
    items,
    nextCursor,
    from: from.toISOString(),
    to: to.toISOString(),
    summary: { total, severity: severityCounts, category: categoryCounts, highlights },
  };
}

function parseJson(value: string | null): any {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
function buildDiff(oldV: any, newV: any): AuditDiffRow[] {
  const o = oldV && typeof oldV === "object" ? oldV : {};
  const n = newV && typeof newV === "object" ? newV : {};
  const keys = Array.from(new Set([...Object.keys(o), ...Object.keys(n)]));
  const s = (v: any): string | null =>
    v === undefined || v === null ? null : typeof v === "object" ? JSON.stringify(v) : String(v);
  const rows: AuditDiffRow[] = [];
  for (const k of keys) {
    const os = s(o[k]); const ns = s(n[k]);
    if (os !== ns) rows.push({ field: k, old: os, new: ns });
  }
  return rows.slice(0, 40);
}

export async function getAuditEventDetail(
  id: string,
  branchId: string | null,
): Promise<AuditEventDetail | null> {
  const e = await prisma.anomalyEvent.findFirst({
    where: { id, ...(branchId ? { branchId } : {}) },
  });
  if (!e) return null;

  let diff: AuditDiffRow[] = [];
  let ipAddress: string | null = null;
  let userAgent: string | null = null;
  if (e.sourceKind === "audit") {
    const al = await prisma.auditLog.findUnique({
      where: { id: e.sourceId },
      select: { oldValues: true, newValues: true, ipAddress: true, userAgent: true },
    });
    if (al) {
      diff = buildDiff(parseJson(al.oldValues), parseJson(al.newValues));
      ipAddress = al.ipAddress ?? null;
      userAgent = al.userAgent ?? null;
    }
  } else if (e.amountInPaise !== null) {
    // Money rows have no field-level diff; show the amount + reason.
    diff = [
      { field: "amount", old: null, new: `₹${(e.amountInPaise / 100).toLocaleString("en-IN")}` },
      { field: "reason", old: null, new: e.reason ?? "—" },
    ];
  }

  const relatedRows = await prisma.anomalyEvent.findMany({
    where: { branchId: e.branchId, entityId: e.entityId },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: 10,
    select: { id: true, severity: true, event: true, actorName: true, occurredAt: true },
  });

  return {
    id: e.id,
    severity: e.severity as AuditSeverity,
    category: e.category as AuditCategory,
    event: e.event,
    who: e.actorName,
    role: e.actorRole,
    entityType: e.entityType,
    entityId: e.entityId,
    detail: e.detail,
    amountInPaise: e.amountInPaise,
    whenIso: e.occurredAt.toISOString(),
    drillTo: e.drillTo,
    actionType: e.sourceKind,
    ipAddress,
    userAgent,
    reason: e.reason,
    diff,
    related: relatedRows.map((r) => ({
      id: r.id,
      severity: r.severity as AuditSeverity,
      event: r.event,
      who: r.actorName,
      whenIso: r.occurredAt.toISOString(),
      isThis: r.id === e.id,
    })),
  };
}
