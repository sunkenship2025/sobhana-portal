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

/**
 * "Mistakes" = staff rework / corrections (things that shouldn't have needed to
 * happen): a cancelled test, a refund, a swapped test, a changed referral doctor,
 * a report edited after it was finalized. The KPI + the Staff scorecard rank
 * staff by these. Keyed by the projected event name; the label is what the
 * scorecard column shows.
 */
const MISTAKE_TYPES: Array<{ event: string; label: string; key: string }> = [
  { event: "Order cancelled", label: "Cancelled", key: "cancelled" },
  { event: "Refund issued", label: "Refunds", key: "refunds" },
  { event: "Test swapped", label: "Tests edited", key: "swaps" },
  { event: "Test reopened", label: "Reopened", key: "reopened" },
  { event: "Referral changed", label: "Referral edits", key: "referralChanges" },
  { event: "Report changed after finalize", label: "Post-finalize edits", key: "postFinalizeEdits" },
];
const MISTAKE_EVENTS = MISTAKE_TYPES.map((m) => m.event);

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
  status: "new" | "ack" | "resolved";
}
export interface AuditEventsParams {
  branchId: string | null;
  severity?: string | null;
  category?: string | null;
  status?: string | null;
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
      mistakesActor: { name: string; count: number } | null;
    };
    triage: { new: number; ack: number; resolved: number; open: number };
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

  // Facet base — branch / actor / q / date only (NOT the severity/category the
  // user picked), so the rail always shows the TRUE distribution and you can see
  // how many Low/Info you're currently hiding.
  const windowAnd: Prisma.AnomalyEventWhereInput[] = [{ occurredAt: { gte: from, lte: to } }];
  if (params.branchId) windowAnd.push({ branchId: params.branchId });
  if (params.actor) windowAnd.push({ actorUserId: params.actor });
  const q = params.q?.trim();
  if (q) {
    // A patient / bill lookup by an ID we don't store on the event row (phone,
    // patient number, bill number) is resolved to the visits it touches — every
    // patient-linked event drills to `/diagnostics/results/{visitId}`, so we
    // match on that path. Only runs when the user actually searches.
    const branchAnd = params.branchId ? { branchId: params.branchId } : {};
    const [idPatients, billVisits] = await Promise.all([
      prisma.patient.findMany({
        where: {
          OR: [
            { patientNumber: { contains: q, mode: "insensitive" } },
            { identifiers: { some: { value: { contains: q, mode: "insensitive" } } } },
          ],
        },
        select: { visits: { where: branchAnd, select: { id: true }, take: 200 } },
        take: 50,
      }),
      prisma.bill.findMany({
        where: { billNumber: { contains: q, mode: "insensitive" }, ...branchAnd },
        select: { visitId: true },
        take: 200,
      }),
    ]);
    const visitIds = new Set<string>();
    for (const p of idPatients) for (const v of p.visits) visitIds.add(v.id);
    for (const b of billVisits) if (b.visitId) visitIds.add(b.visitId);
    const drillPaths = Array.from(visitIds).map((id) => `/diagnostics/results/${id}`);

    windowAnd.push({
      OR: [
        { detail: { contains: q, mode: "insensitive" } },
        { event: { contains: q, mode: "insensitive" } },
        { entityId: { contains: q, mode: "insensitive" } },
        { actorName: { contains: q, mode: "insensitive" } },
        { patientName: { contains: q, mode: "insensitive" } },
        ...(drillPaths.length ? [{ drillTo: { in: drillPaths } }] : []),
      ],
    });
  }

  // The severity / category the user selected — applied to the PAGE, not facets.
  const sevs = parseList(params.severity).filter((s) =>
    ["high", "medium", "low", "info"].includes(s));
  const cats = parseList(params.category);
  const statuses = parseList(params.status).filter((s) => ["new", "ack", "resolved"].includes(s));
  const selectAnd: Prisma.AnomalyEventWhereInput[] = [];
  if (sevs.length) selectAnd.push({ severity: { in: sevs } });
  if (cats.length) selectAnd.push({ category: { in: cats } });
  if (statuses.length) {
    const or: Prisma.AnomalyEventWhereInput[] = [];
    if (statuses.includes("new")) or.push({ triage: { is: null } });
    if (statuses.includes("ack")) or.push({ triage: { status: "ack" } });
    if (statuses.includes("resolved")) or.push({ triage: { status: "resolved" } });
    selectAnd.push({ OR: or });
  }

  // Facet + highlight aggregates over the FULL window (ignore the selection), plus
  // the actor with the most FLAGGED (high/medium) events — "who to watch", not
  // just who clicked the most.
  const [sevGroups, catGroups, eventGroups, actorGroups, ackCount, resolvedCount] = await Promise.all([
    prisma.anomalyEvent.groupBy({ by: ["severity"], where: { AND: windowAnd }, _count: { _all: true } }),
    prisma.anomalyEvent.groupBy({ by: ["category"], where: { AND: windowAnd }, _count: { _all: true } }),
    prisma.anomalyEvent.groupBy({ by: ["event"], where: { AND: windowAnd }, _count: { _all: true } }),
    prisma.anomalyEvent.groupBy({
      by: ["actorName"],
      where: {
        AND: [
          ...windowAnd,
          { actorName: { not: null } },
          { actorRole: { not: "lab_incharge" } },
          { event: { in: MISTAKE_EVENTS } },
        ],
      },
      _count: { _all: true },
      orderBy: { _count: { actorName: "desc" } },
      take: 1,
    }),
    prisma.anomalyEvent.count({ where: { AND: [...windowAnd, { triage: { status: "ack" } }] } }),
    prisma.anomalyEvent.count({ where: { AND: [...windowAnd, { triage: { status: "resolved" } }] } }),
  ]);
  const severityCounts: Record<AuditSeverity, number> = { high: 0, medium: 0, low: 0, info: 0 };
  for (const g of sevGroups) severityCounts[g.severity as AuditSeverity] = g._count._all;
  const categoryCounts: Record<AuditCategory, number> = {
    money: 0, report: 0, drafts: 0, identity: 0, access: 0, destructive: 0, ops: 0,
  };
  for (const g of catGroups) categoryCounts[g.category as AuditCategory] = g._count._all;
  const total =
    severityCounts.high + severityCounts.medium + severityCounts.low + severityCounts.info;
  const ev = new Map(eventGroups.map((g) => [g.event, g._count._all]));
  const evc = (name: string) => ev.get(name) ?? 0;
  const mistakesActor =
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
    mistakesActor,
  };

  // Keyset page — window + the severity/category selection + cursor.
  const cur = params.cursor ? decodeCursor(params.cursor) : null;
  const pageAnd: Prisma.AnomalyEventWhereInput[] = [...windowAnd, ...selectAnd];
  if (cur) {
    pageAnd.push({
      OR: [
        { occurredAt: { lt: cur.at } },
        { AND: [{ occurredAt: cur.at }, { id: { lt: cur.id } }] },
      ],
    });
  }
  const rows = await prisma.anomalyEvent.findMany({
    where: { AND: pageAnd },
    orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true, severity: true, category: true, event: true, actorName: true,
      actorRole: true, entityType: true, entityId: true, detail: true,
      amountInPaise: true, occurredAt: true, drillTo: true, sourceKind: true,
      triage: { select: { status: true } },
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
    status: (r.triage?.status as "ack" | "resolved" | undefined) ?? "new",
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
    summary: {
      total,
      severity: severityCounts,
      category: categoryCounts,
      highlights,
      triage: {
        new: Math.max(0, total - ackCount - resolvedCount),
        ack: ackCount,
        resolved: resolvedCount,
        open: Math.max(0, total - resolvedCount),
      },
    },
  };
}

function parseJson(value: string | null): any {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}
// Internal plumbing we never want to show in a human before→after diff: storage
// keys, byte sizes, foreign-key ids, timestamps, the correction marker.
const DIFF_NOISE = new Set([
  "id", "r2Key", "fileSizeBytes", "pageCount", "displayOrder", "checksum",
  "mimeType", "createdAt", "updatedAt", "action", "severity", "ordersResnapshotted",
  "resultsDeleted",
]);
const isNoiseKey = (k: string): boolean =>
  DIFF_NOISE.has(k) || /Id$/.test(k) || k.toLowerCase().includes("key");

function buildDiff(oldV: any, newV: any): AuditDiffRow[] {
  const o = oldV && typeof oldV === "object" ? oldV : {};
  const n = newV && typeof newV === "object" ? newV : {};
  const keys = Array.from(new Set([...Object.keys(o), ...Object.keys(n)])).filter((k) => !isNoiseKey(k));
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
    include: { triage: { select: { status: true } } },
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
    status: (e.triage?.status as "ack" | "resolved" | undefined) ?? "new",
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

// ---------------------------------------------------------------------------
// Staff scorecard — staff ranked by "mistakes" (rework/corrections) in the
// window, broken down by type. Reads the materialized model (stored `event`),
// so it's one grouped aggregate. Powers the Staff scorecard tab.
// ---------------------------------------------------------------------------
export interface StaffScorecardRow {
  name: string;
  role: string | null;
  total: number;
  billed: number; // patients this staff billed in the window (the denominator)
  rate: number; // mistakes per 100 billed — the fair ranking metric
  byType: Record<string, number>;
}
export interface StaffScorecardResult {
  from: string;
  to: string;
  types: Array<{ key: string; label: string }>;
  actors: StaffScorecardRow[]; // staff (front desk / diagnostics) — the leaderboard
  labIncharge: StaffScorecardRow[]; // lab in-charges, listed separately (they edit/finalize)
}

export async function getStaffScorecard(params: {
  branchId: string | null;
  from?: string | null;
  to?: string | null;
}): Promise<StaffScorecardResult> {
  // Unlike the feed, the scorecard is a single aggregate — allow an unbounded
  // window (no 1-year clamp) so "All time" works; absent `from` = everything.
  const to = params.to && !Number.isNaN(new Date(params.to).getTime()) ? new Date(params.to) : new Date();
  const from = params.from && !Number.isNaN(new Date(params.from).getTime()) ? new Date(params.from) : new Date(0);
  await ensureProjected(params.branchId, from, to);

  const branchAnd = params.branchId ? [{ branchId: params.branchId }] : [];
  const [groups, billedGroups] = await Promise.all([
    prisma.anomalyEvent.groupBy({
      by: ["actorName", "actorRole", "event"],
      where: {
        AND: [
          { occurredAt: { gte: from, lte: to } },
          ...branchAnd,
          { actorName: { not: null } },
          { event: { in: MISTAKE_EVENTS } },
        ],
      },
      _count: { _all: true },
    }),
    // Denominator: patients each staff billed in the same window (CREATE Visit →
    // "Visit billed"). Ranking on mistakes/billed is fair — a busy desk with 11
    // slips in 400 bills beats a quiet one with 5 in 40.
    prisma.anomalyEvent.groupBy({
      by: ["actorName"],
      where: {
        AND: [
          { occurredAt: { gte: from, lte: to } },
          ...branchAnd,
          { actorName: { not: null } },
          { event: "Visit billed" },
        ],
      },
      _count: { _all: true },
    }),
  ]);
  const billedByName = new Map(billedGroups.map((g) => [g.actorName as string, g._count._all]));

  const eventToKey = new Map(MISTAKE_TYPES.map((m) => [m.event, m.key]));
  const byActor = new Map<string, StaffScorecardRow>();
  for (const g of groups) {
    const name = g.actorName as string;
    const key = eventToKey.get(g.event);
    if (!key) continue;
    if (!byActor.has(name)) byActor.set(name, { name, role: g.actorRole ?? null, total: 0, billed: 0, rate: 0, byType: {} });
    const row = byActor.get(name)!;
    if (g.actorRole && !row.role) row.role = g.actorRole;
    row.byType[key] = (row.byType[key] ?? 0) + g._count._all;
    row.total += g._count._all;
  }
  // Fill in the denominator + rate (mistakes per 100 billed). No bills billed →
  // fall back to raw count so they still sort sensibly and aren't rewarded for it.
  for (const row of byActor.values()) {
    row.billed = billedByName.get(row.name) ?? 0;
    row.rate = row.billed > 0 ? (row.total / row.billed) * 100 : row.total * 100;
  }
  // Cleanest (lowest rate) first — celebrate the fairest, not just the quietest.
  // Lab in-charges are split out: they legitimately edit/finalize, so they don't
  // belong in the front-desk staff leaderboard.
  const all = Array.from(byActor.values()).sort((a, b) => a.rate - b.rate || a.total - b.total);
  const actors = all.filter((a) => a.role !== "lab_incharge");
  const labIncharge = all.filter((a) => a.role === "lab_incharge");

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    types: MISTAKE_TYPES.map((m) => ({ key: m.key, label: m.label })),
    actors,
    labIncharge,
  };
}

// ---------------------------------------------------------------------------
// Access & disclosure — who VIEWED / DOWNLOADED / PRINTED patient reports.
// Reads ReportAccessLog directly (branch via the reportVersion→report→visit
// join), keyset-paginated. Backs the "who saw my report" / DPDP lens.
// ---------------------------------------------------------------------------
export interface ReportAccessRow {
  id: string;
  accessType: string; // VIEW | DOWNLOAD | PRINT
  accessedVia: string; // TOKEN | STAFF_PORTAL | DIRECT
  who: string | null;
  patient: string | null;
  ipAddress: string | null;
  whenIso: string;
}
export interface ReportAccessResult {
  items: ReportAccessRow[];
  nextCursor: string | null;
  from: string;
  to: string;
  counts: { view: number; download: number; print: number };
}

export async function getReportAccess(params: {
  branchId: string | null;
  from?: string | null;
  to?: string | null;
  type?: string | null;
  cursor?: string | null;
  limit?: number | null;
}): Promise<ReportAccessResult> {
  const limit = clampLimit(params.limit);
  const { from, to } = resolveWindow(params.from, params.to);

  const branchFilter: Prisma.ReportAccessLogWhereInput = params.branchId
    ? { reportVersion: { report: { visit: { branchId: params.branchId } } } }
    : {};
  const baseAnd: Prisma.ReportAccessLogWhereInput[] = [
    { createdAt: { gte: from, lte: to } },
    branchFilter,
  ];

  const countGroups = await prisma.reportAccessLog.groupBy({
    by: ["accessType"],
    where: { AND: baseAnd },
    _count: { _all: true },
  });
  const counts = { view: 0, download: 0, print: 0 };
  for (const g of countGroups) {
    if (g.accessType === "VIEW") counts.view = g._count._all;
    else if (g.accessType === "DOWNLOAD") counts.download = g._count._all;
    else if (g.accessType === "PRINT") counts.print = g._count._all;
  }

  const typeUpper = (params.type ?? "").trim().toUpperCase();
  const cur = params.cursor ? decodeCursor(params.cursor) : null;
  const pageAnd: Prisma.ReportAccessLogWhereInput[] = [...baseAnd];
  if (["VIEW", "DOWNLOAD", "PRINT"].includes(typeUpper)) pageAnd.push({ accessType: typeUpper });
  if (cur) {
    pageAnd.push({
      OR: [
        { createdAt: { lt: cur.at } },
        { AND: [{ createdAt: cur.at }, { id: { lt: cur.id } }] },
      ],
    });
  }

  const rows = await prisma.reportAccessLog.findMany({
    where: { AND: pageAnd },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    select: {
      id: true, accessType: true, accessedVia: true, userId: true,
      ipAddress: true, createdAt: true,
      reportVersion: { select: { report: { select: { visit: { select: { billNumber: true, patient: { select: { name: true } } } } } } } },
    },
  });
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const userIds = Array.from(new Set(page.map((r) => r.userId).filter((v): v is string => Boolean(v))));
  const users = userIds.length
    ? await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
    : [];
  const uMap = new Map(users.map((u) => [u.id, u.name]));

  const items: ReportAccessRow[] = page.map((r) => {
    const v = r.reportVersion?.report?.visit;
    const patient = v
      ? v.patient?.name
        ? v.billNumber ? `${v.patient.name} · ${v.billNumber}` : v.patient.name
        : v.billNumber ?? null
      : null;
    const who = r.userId
      ? uMap.get(r.userId) ?? "staff"
      : r.accessedVia === "TOKEN" ? "patient / public link" : "—";
    return {
      id: r.id,
      accessType: r.accessType,
      accessedVia: r.accessedVia,
      who,
      patient,
      ipAddress: r.ipAddress ?? null,
      whenIso: r.createdAt.toISOString(),
    };
  });
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  return { items, nextCursor, from: from.toISOString(), to: to.toISOString(), counts };
}

// ---------------------------------------------------------------------------
// Triage — set an event's workqueue state. 'new' clears the row (back to new);
// 'ack'/'resolved' upsert it. Lives in AnomalyTriage so re-projection can't wipe it.
// ---------------------------------------------------------------------------
export async function setEventTriage(params: {
  eventId: string;
  status: "new" | "ack" | "resolved";
  note?: string | null;
  actorUserId?: string | null;
  actorName?: string | null;
}): Promise<{ status: "new" | "ack" | "resolved" }> {
  if (params.status === "new") {
    await prisma.anomalyTriage.deleteMany({ where: { anomalyEventId: params.eventId } });
    return { status: "new" };
  }
  const data = {
    status: params.status,
    note: params.note ?? null,
    actorUserId: params.actorUserId ?? null,
    actorName: params.actorName ?? null,
  };
  await prisma.anomalyTriage.upsert({
    where: { anomalyEventId: params.eventId },
    create: { anomalyEventId: params.eventId, ...data },
    update: data,
  });
  return { status: params.status };
}
