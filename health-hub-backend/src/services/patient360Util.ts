import { Prisma, VisitDomain } from '@prisma/client';

// ============================================================================
// Patient360 — pure helpers (cursor, filter, derivation)
// No DB access; unit-testable in isolation. See 05-backend-plan.md §3 (Step 3,5).
// ============================================================================

export interface TimelineFilters {
  domain: VisitDomain | null;
  from: Date | null;
  to: Date | null;
  branchId: string | null;
  unpaidOnly: boolean;
  includeCancelled: boolean;
  pageSize: number;
  cursor: TimelineCursor | null;
}

export interface TimelineCursor {
  createdAt: Date;
  id: string;
}

export interface AppliedFilters {
  domain: VisitDomain | null;
  from: string | null;
  to: string | null;
  branchId: string | null;
  unpaidOnly: boolean;
  includeCancelled: boolean;
}

const DEFAULT_PAGE_SIZE = 20;
const MIN_PAGE_SIZE = 1;
const MAX_PAGE_SIZE = 50;

// ----------------------------------------------------------------------------
// Cursor: opaque base64-encoded JSON of { createdAt, id }
// ----------------------------------------------------------------------------

export function encodeCursor(createdAt: Date, id: string): string {
  const payload = JSON.stringify({ createdAt: createdAt.toISOString(), id });
  return Buffer.from(payload, 'utf8').toString('base64');
}

export function decodeCursor(cursor?: string | null): TimelineCursor | null {
  if (!cursor) return null;
  try {
    const json = Buffer.from(cursor, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as { createdAt?: string; id?: string };
    if (!parsed.createdAt || !parsed.id) return null;
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id: parsed.id };
  } catch {
    return null;
  }
}

// ----------------------------------------------------------------------------
// Query parsing / coercion
// ----------------------------------------------------------------------------

function coerceBool(value: unknown): boolean {
  return value === true || value === 'true' || value === '1';
}

function coerceDate(value: unknown, endOfDay: boolean): Date | null {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const raw = value.trim();
  // Date-only (YYYY-MM-DD) → normalize to UTC start/end of day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const suffix = endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    const d = new Date(`${raw}${suffix}`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function coerceDomain(value: unknown): VisitDomain | null {
  if (value === 'DIAGNOSTICS') return VisitDomain.DIAGNOSTICS;
  if (value === 'CLINIC') return VisitDomain.CLINIC;
  return null;
}

function clampPageSize(value: unknown): number {
  const n = typeof value === 'number' ? value : parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return DEFAULT_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(MIN_PAGE_SIZE, Math.trunc(n)));
}

/**
 * Parse + coerce raw query params into a normalized TimelineFilters object.
 * - pageSize clamped to [1, 50], default 20.
 * - `to` normalized to UTC end-of-day when date-only.
 */
export function parseTimelineQuery(query: Record<string, unknown>): TimelineFilters {
  return {
    domain: coerceDomain(query.domain),
    from: coerceDate(query.from, false),
    to: coerceDate(query.to, true),
    branchId: typeof query.branchId === 'string' && query.branchId.trim() !== '' ? query.branchId : null,
    unpaidOnly: coerceBool(query.unpaidOnly),
    includeCancelled: coerceBool(query.includeCancelled),
    pageSize: clampPageSize(query.pageSize),
    cursor: decodeCursor(typeof query.cursor === 'string' ? query.cursor : null),
  };
}

export function toAppliedFilters(filters: TimelineFilters): AppliedFilters {
  return {
    domain: filters.domain,
    from: filters.from ? filters.from.toISOString() : null,
    to: filters.to ? filters.to.toISOString() : null,
    branchId: filters.branchId,
    unpaidOnly: filters.unpaidOnly,
    includeCancelled: filters.includeCancelled,
  };
}

// ----------------------------------------------------------------------------
// Prisma where builder (keyset pagination + filters)
// GLOBAL: never references branchId for tenancy — branchId here is a user
// filter, not a tenancy scope (see §11).
// ----------------------------------------------------------------------------

export function buildTimelineWhere(
  patientId: string,
  filters: TimelineFilters,
): Prisma.VisitWhereInput {
  const where: Prisma.VisitWhereInput = { patientId };

  if (filters.domain) {
    where.domain = filters.domain;
  }

  if (!filters.includeCancelled) {
    where.status = { not: 'CANCELLED' };
  }

  if (filters.branchId) {
    where.branchId = filters.branchId;
  }

  if (filters.from || filters.to) {
    where.createdAt = {
      ...(filters.from ? { gte: filters.from } : {}),
      ...(filters.to ? { lte: filters.to } : {}),
    };
  }

  if (filters.unpaidOnly) {
    where.bill = { is: { paymentStatus: { notIn: ['PAID', 'REFUNDED'] } } };
  }

  // Keyset cursor predicate on (createdAt desc, id desc):
  //   (createdAt < cursor.createdAt) OR (createdAt = cursor.createdAt AND id < cursor.id)
  if (filters.cursor) {
    const { createdAt, id } = filters.cursor;
    where.OR = [
      { createdAt: { lt: createdAt } },
      { createdAt: { equals: createdAt }, id: { lt: id } },
    ];
  }

  return where;
}
