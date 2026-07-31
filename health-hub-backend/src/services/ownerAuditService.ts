/**
 * Owner Audit & Anomalies — paginated event feed (slice 1: AuditLog spine).
 *
 * Backs GET /api/owner/audit/events for the dedicated /ops/audit page. Unlike
 * the 20-row / 24h widget in ownerOperationsService, this is:
 *   - keyset (cursor) paginated on (createdAt DESC, id DESC) — no OFFSET,
 *   - queryable over a date-time range up to 1 YEAR,
 *   - branch / actor / category / free-text (q) filterable,
 *   - selects ONLY the fields shown (never the oldValues/newValues blobs),
 * so the list stays cheap and never full-scans (the pending-results / OOM
 * discipline). Drill-in detail (before/after diff) loads on demand elsewhere.
 *
 * Coverage note: this reads the AuditLog table only. The derived rows the widget
 * also shows (discounts off Bill, identity edits from PatientChangeLog, films-only
 * closes, draft authorship) are folded in by later slices; severity is returned
 * per row for display but is DERIVED, so severity-facet filtering waits for the
 * materialized AnomalyEvent projector rather than being faked with a lossy
 * in-memory filter that would break pagination counts.
 */
import prisma from "../lib/prisma";
import { AuditActionType, Prisma } from "@prisma/client";

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export type AuditSeverity = "high" | "medium" | "low" | "info";
export type AuditCategory =
  | "money"
  | "report"
  | "drafts"
  | "identity"
  | "access"
  | "destructive"
  | "ops";

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
  whenIso: string;
  drillTo: string | null;
  actionType: AuditActionType;
}

export interface AuditEventsParams {
  branchId: string | null;
  category?: string | null; // comma list
  actor?: string | null; // userId
  q?: string | null; // free-text search
  from?: string | null; // ISO
  to?: string | null; // ISO
  cursor?: string | null; // opaque `${createdAtISO}|${id}`
  limit?: number | null;
}

export interface AuditEventsResult {
  items: AuditEventRow[];
  nextCursor: string | null;
  /** Echoed so the UI can show the effective (clamped) window. */
  from: string;
  to: string;
  /** Real counts over the whole filtered window (one cheap grouped aggregate) —
   *  powers the KPI strip + filter-rail facet counts without a full fetch. */
  summary: {
    total: number;
    severity: Record<AuditSeverity, number>;
    category: Record<AuditCategory, number>;
    /** Action-oriented signals — what an owner / lab-incharge actually opens
     *  this page to check ("anything alarming, and who's most active?"). */
    highlights: {
      deletions: number; // records deleted (visit/payout/etc) — cover-up risk
      payoutsPaid: number; // money paid out
      billChanges: number; // discounts / refunds / bill edits (₹ in the row)
      postFinalizeEdits: number; // report changed AFTER it was finalized
      finalized: number; // reports finalized (throughput)
      drafts: number; // report drafts written/edited (in-progress work)
      reportAccess: number; // views / prints / downloads
      topActor: { name: string; count: number } | null; // busiest actor
    };
  };
}

const parseList = (v?: string | null): string[] =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

const clampLimit = (v?: number | null): number => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.floor(n));
};

const encodeCursor = (createdAt: Date, id: string): string =>
  `${createdAt.toISOString()}|${id}`;

const decodeCursor = (cursor: string): { at: Date; id: string } | null => {
  const idx = cursor.indexOf("|");
  if (idx < 0) return null;
  const at = new Date(cursor.slice(0, idx));
  const id = cursor.slice(idx + 1);
  if (Number.isNaN(at.getTime()) || !id) return null;
  return { at, id };
};

/**
 * Category → stored-column predicate. Only actionType (enum) and entityType
 * (indexed string) are used, so the filter stays SQL-native and pagination-safe.
 */
function categoryPredicate(cat: string): Prisma.AuditLogWhereInput[] {
  switch (cat) {
    case "destructive":
      return [
        {
          actionType: {
            in: [AuditActionType.DELETE, AuditActionType.PAYOUT_DELETE],
          },
        },
      ];
    case "access":
      return [{ actionType: AuditActionType.REPORT_ACCESS }];
    case "money":
      return [
        {
          actionType: {
            in: [AuditActionType.PAYOUT_PAID, AuditActionType.PAYOUT_DERIVE],
          },
        },
        { entityType: "Bill" },
      ];
    case "report":
      return [
        { actionType: AuditActionType.FINALIZE },
        { entityType: "ReportVersion" },
      ];
    case "drafts":
      return [{ entityType: "ReportDraft" }];
    case "identity":
      return [{ entityType: "Patient" }];
    default:
      return [];
  }
}

/** Classify a raw AuditLog row into the display taxonomy. */
function classify(
  actionType: AuditActionType,
  entityType: string,
): { category: AuditCategory; severity: AuditSeverity; event: string } {
  switch (actionType) {
    case AuditActionType.DELETE:
      return {
        category: "destructive",
        severity: "high",
        event: `Deleted ${entityType}`,
      };
    case AuditActionType.PAYOUT_DELETE:
      return { category: "destructive", severity: "high", event: "Payout deleted" };
    case AuditActionType.PAYOUT_PAID:
      return { category: "money", severity: "high", event: "Payout paid" };
    case AuditActionType.PAYOUT_DERIVE:
      return { category: "money", severity: "medium", event: "Payout derived" };
    case AuditActionType.FINALIZE:
      // Finalizing is the routine daily milestone — a baseline, NOT an alarm.
      // (Editing a report AFTER finalize is the high-severity signal; see below.)
      return { category: "report", severity: "info", event: "Report finalized" };
    case AuditActionType.REPORT_ACCESS:
      // A single view/print is baseline; bulk/off-hours access is the anomaly,
      // surfaced by the Access tab, not by making every access medium.
      return { category: "access", severity: "info", event: "Report accessed" };
    case AuditActionType.UPDATE:
      if (entityType === "ReportDraft")
        return {
          category: "drafts",
          severity: "info",
          event: "Report draft written / edited",
        };
      if (entityType === "ReportVersion")
        return { category: "report", severity: "high", event: "Report updated" };
      if (entityType === "Bill")
        return { category: "money", severity: "medium", event: "Bill updated" };
      return { category: "ops", severity: "low", event: `Updated ${entityType}` };
    case AuditActionType.CREATE:
      if (entityType === "Patient")
        return { category: "identity", severity: "low", event: "Patient created" };
      return { category: "ops", severity: "low", event: `Created ${entityType}` };
    default:
      return {
        category: "ops",
        severity: "low",
        event: `${actionType} ${entityType}`,
      };
  }
}

export interface AuditDiffRow {
  field: string;
  old: string | null;
  new: string | null;
}
export interface AuditEventDetail extends AuditEventRow {
  ipAddress: string | null;
  userAgent: string | null;
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

function parseJson(value: string | null): any {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/** Field-level before→after diff — only the keys that actually changed. */
function buildDiff(oldV: any, newV: any): AuditDiffRow[] {
  const o = oldV && typeof oldV === "object" ? oldV : {};
  const n = newV && typeof newV === "object" ? newV : {};
  const keys = Array.from(new Set([...Object.keys(o), ...Object.keys(n)]));
  const asStr = (v: any): string | null =>
    v === undefined || v === null
      ? null
      : typeof v === "object"
        ? JSON.stringify(v)
        : String(v);
  const rows: AuditDiffRow[] = [];
  for (const k of keys) {
    const os = asStr(o[k]);
    const ns = asStr(n[k]);
    if (os !== ns) rows.push({ field: k, old: os, new: ns });
  }
  return rows.slice(0, 40);
}

export async function getAuditEventDetail(
  id: string,
  branchId: string | null,
): Promise<AuditEventDetail | null> {
  const row = await prisma.auditLog.findFirst({
    where: { id, ...(branchId ? { branchId } : {}) },
    select: {
      id: true,
      branchId: true,
      actionType: true,
      entityType: true,
      entityId: true,
      userId: true,
      createdAt: true,
      oldValues: true,
      newValues: true,
      ipAddress: true,
      userAgent: true,
    },
  });
  if (!row) return null;

  // Related events on the same entity (the entity's timeline), newest first.
  const relatedRows = await prisma.auditLog.findMany({
    where: { branchId: row.branchId, entityId: row.entityId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 10,
    select: {
      id: true,
      actionType: true,
      entityType: true,
      userId: true,
      createdAt: true,
    },
  });

  const userIds = Array.from(
    new Set(
      [row.userId, ...relatedRows.map((r) => r.userId)].filter(
        (v): v is string => Boolean(v),
      ),
    ),
  );
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, role: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const c = classify(row.actionType, row.entityType);
  const u = row.userId ? userMap.get(row.userId) : null;
  const drillTo =
    c.category === "drafts" ? `/diagnostics/results/${row.entityId}` : null;

  // Draft rows carry the patient in the visit, not the audit row.
  let detail = c.event;
  if (c.category === "drafts") {
    const visit = await prisma.visit.findUnique({
      where: { id: row.entityId },
      select: { patient: { select: { name: true } } },
    });
    if (visit?.patient?.name) detail = visit.patient.name;
  }

  return {
    id: row.id,
    severity: c.severity,
    category: c.category,
    event: c.event,
    who: u?.name ?? null,
    role: u?.role ?? null,
    entityType: row.entityType,
    entityId: row.entityId,
    detail,
    whenIso: row.createdAt.toISOString(),
    drillTo,
    actionType: row.actionType,
    ipAddress: row.ipAddress ?? null,
    userAgent: row.userAgent ?? null,
    diff: buildDiff(parseJson(row.oldValues), parseJson(row.newValues)),
    related: relatedRows.map((r) => {
      const rc = classify(r.actionType, r.entityType);
      const ru = r.userId ? userMap.get(r.userId) : null;
      return {
        id: r.id,
        severity: rc.severity,
        event: rc.event,
        who: ru?.name ?? null,
        whenIso: r.createdAt.toISOString(),
        isThis: r.id === row.id,
      };
    }),
  };
}

export async function getAuditEvents(
  params: AuditEventsParams,
): Promise<AuditEventsResult> {
  const limit = clampLimit(params.limit);

  // Resolve + clamp the window to at most one year.
  const now = Date.now();
  const to = params.to ? new Date(params.to) : new Date(now);
  let from = params.from ? new Date(params.from) : new Date(now - DEFAULT_WINDOW_MS);
  if (Number.isNaN(to.getTime()) || Number.isNaN(from.getTime())) {
    from = new Date(now - DEFAULT_WINDOW_MS);
  }
  if (to.getTime() - from.getTime() > YEAR_MS) {
    from = new Date(to.getTime() - YEAR_MS);
  }

  const and: Prisma.AuditLogWhereInput[] = [
    { createdAt: { gte: from, lte: to } },
  ];
  if (params.branchId) and.push({ branchId: params.branchId });
  if (params.actor) and.push({ userId: params.actor });

  const cats = parseList(params.category);
  if (cats.length) {
    const or = cats.flatMap(categoryPredicate);
    // If every requested category is one we can't express against AuditLog yet
    // (e.g. drafts), return an impossible predicate rather than "everything".
    and.push(or.length ? { OR: or } : { id: "__none__" });
  }

  const q = params.q?.trim();
  if (q) {
    and.push({
      OR: [
        { entityType: { contains: q, mode: "insensitive" } },
        { entityId: { contains: q, mode: "insensitive" } },
      ],
    });
  }

  // Facet counts over the whole filtered window (before the cursor slice) — a
  // single grouped aggregate on stored columns, so the KPI strip / rail counts
  // are real without fetching every row.
  const severityCounts: Record<AuditSeverity, number> = {
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };
  const categoryCounts: Record<AuditCategory, number> = {
    money: 0,
    report: 0,
    drafts: 0,
    identity: 0,
    access: 0,
    destructive: 0,
    ops: 0,
  };
  let total = 0;
  const hl = {
    deletions: 0,
    payoutsPaid: 0,
    billChanges: 0,
    postFinalizeEdits: 0,
    finalized: 0,
    drafts: 0,
    reportAccess: 0,
  };
  const grouped = await prisma.auditLog.groupBy({
    by: ["actionType", "entityType"],
    where: { AND: and },
    _count: { _all: true },
  });
  for (const g of grouped) {
    const n = g._count._all;
    const c = classify(g.actionType, g.entityType);
    severityCounts[c.severity] += n;
    categoryCounts[c.category] += n;
    total += n;
    // Action-oriented tallies.
    if (
      g.actionType === AuditActionType.DELETE ||
      g.actionType === AuditActionType.PAYOUT_DELETE
    )
      hl.deletions += n;
    if (g.actionType === AuditActionType.PAYOUT_PAID) hl.payoutsPaid += n;
    if (g.actionType === AuditActionType.FINALIZE) hl.finalized += n;
    if (g.actionType === AuditActionType.REPORT_ACCESS) hl.reportAccess += n;
    if (g.actionType === AuditActionType.UPDATE) {
      if (g.entityType === "Bill") hl.billChanges += n;
      else if (g.entityType === "ReportVersion") hl.postFinalizeEdits += n;
      else if (g.entityType === "ReportDraft") hl.drafts += n;
    }
  }

  // Busiest actor in the window (one cheap grouped aggregate + a name lookup).
  let topActor: { name: string; count: number } | null = null;
  const actorGroups = await prisma.auditLog.groupBy({
    by: ["userId"],
    where: { AND: [...and, { userId: { not: null } }] },
    _count: { _all: true },
    orderBy: { _count: { userId: "desc" } },
    take: 1,
  });
  if (actorGroups.length && actorGroups[0].userId) {
    const topUser = await prisma.user.findUnique({
      where: { id: actorGroups[0].userId },
      select: { name: true },
    });
    if (topUser)
      topActor = { name: topUser.name, count: actorGroups[0]._count._all };
  }

  const cur = params.cursor ? decodeCursor(params.cursor) : null;
  const pageAnd = cur
    ? [
        ...and,
        {
          OR: [
            { createdAt: { lt: cur.at } },
            { AND: [{ createdAt: cur.at }, { id: { lt: cur.id } }] },
          ],
        } as Prisma.AuditLogWhereInput,
      ]
    : and;

  const rows = await prisma.auditLog.findMany({
    where: { AND: pageAnd },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true,
      actionType: true,
      entityType: true,
      entityId: true,
      userId: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  // Resolve actor names in one batched query (AuditLog.userId has no relation).
  const userIds = Array.from(
    new Set(page.map((r) => r.userId).filter((v): v is string => Boolean(v))),
  );
  const users = userIds.length
    ? await prisma.user.findMany({
        where: { id: { in: userIds } },
        select: { id: true, name: true, role: true },
      })
    : [];
  const userMap = new Map(users.map((u) => [u.id, u]));

  const items: AuditEventRow[] = page.map((r) => {
    const c = classify(r.actionType, r.entityType);
    const u = r.userId ? userMap.get(r.userId) : null;
    // Draft rows key their entityId to the visit, so they can deep-link to the
    // result-entry screen for that report.
    const drillTo =
      c.category === "drafts" ? `/diagnostics/results/${r.entityId}` : null;
    return {
      id: r.id,
      severity: c.severity,
      category: c.category,
      event: c.event,
      who: u?.name ?? null,
      role: u?.role ?? null,
      entityType: r.entityType,
      entityId: r.entityId,
      detail: c.event,
      whenIso: r.createdAt.toISOString(),
      drillTo,
      actionType: r.actionType,
    };
  });

  // Enrich draft rows with the patient's name (their entityId is the visitId) so
  // the feed reads "who wrote the draft · for which patient" — one batched join,
  // never per-row.
  const draftVisitIds = Array.from(
    new Set(items.filter((i) => i.category === "drafts").map((i) => i.entityId)),
  );
  if (draftVisitIds.length) {
    const visits = await prisma.visit.findMany({
      where: { id: { in: draftVisitIds } },
      select: { id: true, patient: { select: { name: true } } },
    });
    const nameMap = new Map(visits.map((v) => [v.id, v.patient?.name ?? null]));
    for (const it of items) {
      if (it.category === "drafts") {
        const name = nameMap.get(it.entityId);
        if (name) it.detail = name;
      }
    }
  }

  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return {
    items,
    nextCursor,
    from: from.toISOString(),
    to: to.toISOString(),
    summary: {
      total,
      severity: severityCounts,
      category: categoryCounts,
      highlights: { ...hl, topActor },
    },
  };
}
