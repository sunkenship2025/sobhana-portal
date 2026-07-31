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
      return { category: "report", severity: "high", event: "Report finalized" };
    case AuditActionType.REPORT_ACCESS:
      return { category: "access", severity: "medium", event: "Report accessed" };
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
    summary: { total, severity: severityCounts, category: categoryCounts },
  };
}
