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
  /** Human label for the entity — patient name (+ bill number) for visit-scoped
   *  rows, or the entity's own name for people/catalog. null when the id can't be
   *  resolved (deleted, or an unmapped type); the UI falls back to the raw id. */
  entityLabel: string | null;
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

/**
 * Resolve audit entityType/entityId pairs → a human label: the patient's name
 * (+ bill number) for visit-scoped entities, or the entity's own name for
 * people / catalog. ONE batched query per entity type — never per row. Keyed
 * `${entityType.toLowerCase()}:${entityId}`; unmapped or deleted ids are absent,
 * so the UI falls back to the raw id.
 */
async function resolveEntityLabels(
  pairs: Array<{ entityType: string; entityId: string }>,
): Promise<Map<string, string>> {
  const key = (type: string, id: string) => `${type.toLowerCase()}:${id}`;
  const idsFor = (...types: string[]): string[] => {
    const set = new Set<string>();
    for (const p of pairs)
      if (types.includes(p.entityType.toLowerCase())) set.add(p.entityId);
    return [...set];
  };
  const withBill = (name?: string | null, bill?: string | null): string | null =>
    name ? (bill ? `${name} · ${bill}` : name) : bill ?? null;

  // entityId IS a visitId for visit / reportdraft rows.
  const visitIds = idsFor("visit", "reportdraft");
  const billIds = idsFor("bill");
  const testOrderIds = idsFor("testorder");
  const reportVersionIds = idsFor("report", "reportversion");
  const uploadIds = idsFor("externalreportupload");
  const refundIds = idsFor("orderrefund");
  const patientIds = idsFor("patient");
  const refDoctorIds = idsFor("referraldoctor");
  const clinicDoctorIds = idsFor("clinicdoctor");
  const externalLabIds = idsFor("externallab");
  const centreIds = idsFor("diagnosticreferralcenter");
  const panelIds = idsFor("clinicalpanel");
  const productIds = idsFor("billableproduct");
  const userIds = idsFor("user");

  const [
    visits, bills, testOrders, reportVersions, uploads, refunds, patients,
    refDoctors, clinicDoctors, externalLabs, centres, panels, products, users,
  ] = await Promise.all([
    visitIds.length
      ? prisma.visit.findMany({ where: { id: { in: visitIds } }, select: { id: true, billNumber: true, patient: { select: { name: true } } } })
      : [],
    billIds.length
      ? prisma.bill.findMany({ where: { id: { in: billIds } }, select: { id: true, billNumber: true, visit: { select: { patient: { select: { name: true } } } } } })
      : [],
    testOrderIds.length
      ? prisma.testOrder.findMany({ where: { id: { in: testOrderIds } }, select: { id: true, visit: { select: { billNumber: true, patient: { select: { name: true } } } } } })
      : [],
    reportVersionIds.length
      ? prisma.reportVersion.findMany({ where: { id: { in: reportVersionIds } }, select: { id: true, report: { select: { visit: { select: { billNumber: true, patient: { select: { name: true } } } } } } } })
      : [],
    uploadIds.length
      ? prisma.externalReportUpload.findMany({ where: { id: { in: uploadIds } }, select: { id: true, visit: { select: { billNumber: true, patient: { select: { name: true } } } } } })
      : [],
    refundIds.length
      ? prisma.orderRefund.findMany({ where: { id: { in: refundIds } }, select: { id: true, visit: { select: { billNumber: true, patient: { select: { name: true } } } } } })
      : [],
    patientIds.length
      ? prisma.patient.findMany({ where: { id: { in: patientIds } }, select: { id: true, name: true } })
      : [],
    refDoctorIds.length
      ? prisma.referralDoctor.findMany({ where: { id: { in: refDoctorIds } }, select: { id: true, name: true } })
      : [],
    clinicDoctorIds.length
      ? prisma.clinicDoctor.findMany({ where: { id: { in: clinicDoctorIds } }, select: { id: true, name: true } })
      : [],
    externalLabIds.length
      ? prisma.externalLab.findMany({ where: { id: { in: externalLabIds } }, select: { id: true, name: true } })
      : [],
    centreIds.length
      ? prisma.diagnosticReferralCenter.findMany({ where: { id: { in: centreIds } }, select: { id: true, name: true } })
      : [],
    panelIds.length
      ? prisma.clinicalPanel.findMany({ where: { id: { in: panelIds } }, select: { id: true, name: true } })
      : [],
    productIds.length
      ? prisma.billableProduct.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } })
      : [],
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : [],
  ]);

  const vmap = new Map(visits.map((v) => [v.id, v]));
  const bmap = new Map(bills.map((b) => [b.id, b]));
  const tmap = new Map(testOrders.map((t) => [t.id, t]));
  const rvmap = new Map(reportVersions.map((r) => [r.id, r]));
  const umap = new Map(uploads.map((u) => [u.id, u]));
  const rfmap = new Map(refunds.map((r) => [r.id, r]));
  const pmap = new Map(patients.map((p) => [p.id, p]));
  const nameMaps: Record<string, Map<string, string>> = {
    referraldoctor: new Map(refDoctors.map((d) => [d.id, d.name])),
    clinicdoctor: new Map(clinicDoctors.map((d) => [d.id, d.name])),
    externallab: new Map(externalLabs.map((l) => [l.id, l.name])),
    diagnosticreferralcenter: new Map(centres.map((c) => [c.id, c.name])),
    clinicalpanel: new Map(panels.map((p) => [p.id, p.name])),
    billableproduct: new Map(products.map((p) => [p.id, p.name])),
    user: new Map(users.map((u) => [u.id, u.name])),
  };

  const labels = new Map<string, string>();
  for (const p of pairs) {
    const t = p.entityType.toLowerCase();
    let label: string | null = null;
    switch (t) {
      case "visit":
      case "reportdraft": {
        const v = vmap.get(p.entityId);
        label = v ? withBill(v.patient?.name, v.billNumber) : null;
        break;
      }
      case "bill": {
        const b = bmap.get(p.entityId);
        label = b ? withBill(b.visit?.patient?.name, b.billNumber) : null;
        break;
      }
      case "testorder": {
        const o = tmap.get(p.entityId);
        label = o ? withBill(o.visit?.patient?.name, o.visit?.billNumber) : null;
        break;
      }
      case "report":
      case "reportversion": {
        const rv = rvmap.get(p.entityId);
        label = rv
          ? withBill(rv.report?.visit?.patient?.name, rv.report?.visit?.billNumber)
          : null;
        break;
      }
      case "externalreportupload": {
        const u = umap.get(p.entityId);
        label = u ? withBill(u.visit?.patient?.name, u.visit?.billNumber) : null;
        break;
      }
      case "orderrefund": {
        const r = rfmap.get(p.entityId);
        label = r ? withBill(r.visit?.patient?.name, r.visit?.billNumber) : null;
        break;
      }
      case "patient": {
        label = pmap.get(p.entityId)?.name ?? null;
        break;
      }
      default: {
        label = nameMaps[t]?.get(p.entityId) ?? null;
      }
    }
    if (label) labels.set(key(p.entityType, p.entityId), label);
  }
  return labels;
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
    entityLabel: null,
    detail: r.detail,
    amountInPaise: r.amountInPaise,
    whenIso: r.occurredAt.toISOString(),
    drillTo: r.drillTo,
    actionType: r.sourceKind,
  }));
  // Resolve entity ids → human labels (patient name / bill / entity name), one
  // batched query per type over just this page.
  const labelMap = await resolveEntityLabels(items);
  for (const it of items)
    it.entityLabel =
      labelMap.get(`${it.entityType.toLowerCase()}:${it.entityId}`) ?? null;
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

  const labelMap = await resolveEntityLabels([
    { entityType: e.entityType, entityId: e.entityId },
  ]);

  return {
    id: e.id,
    severity: e.severity as AuditSeverity,
    category: e.category as AuditCategory,
    event: e.event,
    who: e.actorName,
    role: e.actorRole,
    entityType: e.entityType,
    entityId: e.entityId,
    entityLabel:
      labelMap.get(`${e.entityType.toLowerCase()}:${e.entityId}`) ?? null,
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
