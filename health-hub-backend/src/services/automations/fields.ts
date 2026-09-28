/**
 * What can fill a blank in a message — and how each one is looked up.
 *
 * The same rule as predicates, triggers and step kinds: the vocabulary lives here, the
 * builder is served it, and a new field is one entry below rather than a new screen or
 * a new case in the engine.
 *
 * It exists because "fill {{2}} with the code" was resolved only on the step that ISSUED
 * the code. OP recovery's Day-5 "your code expires soon" reminder issues nothing — it
 * reminds the patient of a code issued days earlier — so it was bound to an empty
 * string and would have gone out blank. Here COUPON_CODE means "this journey's code",
 * whichever step issued it.
 *
 * A field that cannot be resolved stops the message rather than sending a hole in it:
 * `resolveFields` reports it as missing and the engine does not send.
 */
import prisma from '../../lib/prisma';
import { prismaContext } from './context';

export interface FieldMeta {
  /** The key a message stores, e.g. { from: 'COUPON_EXPIRY' }. */
  from: string;
  label: string;
  group: 'Patient' | 'Visit' | 'Offer' | 'Centre' | 'Other';
  /** What it looks like in a message, shown in the builder. */
  example: string;
  help?: string;
  /** Only meaningful if something in the journey issues an offer. */
  needsOffer?: boolean;
  /** Only meaningful when the journey is about a visit. */
  needsVisit?: boolean;
}

/** Everything a resolver may need, about the run doing the sending. */
export interface FieldSource {
  runId: string;
  patientId: string | null;
  branchId: string | null;
  subjectType: string;
  subjectId: string;
  /** The code this very step just issued, when it issued one. */
  couponCode?: string | null;
  now: Date;
}

/** Lazy, per-send lookups, so a message with three blanks is not three patient reads. */
interface Loaders {
  patient(): Promise<{ name: string } | null>;
  branch(): Promise<{ name: string } | null>;
  coupon(): Promise<{ code: string; expiresAt: Date; discountPercentage: number | null } | null>;
  visit(): Promise<{ id: string; createdAt: Date } | null>;
}

type Resolver = (src: FieldSource, load: Loaders, value?: string) => Promise<string | null>;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A date as a patient reads it: IST, never the UTC day before.
 *
 * Built by hand, not with toLocaleDateString: ICU versions disagree ("Sep" vs "Sept"),
 * and the words in a patient's message must not depend on which Node the server runs.
 */
export function istDate(d: Date): string {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return `${ist.getUTCDate()} ${MONTHS[ist.getUTCMonth()]} ${ist.getUTCFullYear()}`;
}

const FIELDS: { meta: FieldMeta; resolve: Resolver }[] = [
  {
    meta: { from: 'PATIENT_FIRST_NAME', label: 'First name', group: 'Patient', example: 'Ravi',
      help: 'Falls back to "there" when a name is missing, so a greeting never reads "Hi ,".' },
    resolve: async (_s, l) => ((await l.patient())?.name ?? '').trim().split(/\s+/)[0] || 'there',
  },
  {
    meta: { from: 'PATIENT_NAME', label: 'Full name', group: 'Patient', example: 'Ravi Kumar' },
    resolve: async (_s, l) => (await l.patient())?.name?.trim() || null,
  },
  {
    meta: { from: 'BRANCH_NAME', label: 'Branch', group: 'Centre', example: 'Chintal' },
    resolve: async (_s, l) => (await l.branch())?.name || null,
  },
  {
    meta: { from: 'COUPON_CODE', label: 'Offer code', group: 'Offer', example: 'OPR-4K9X2', needsOffer: true,
      help: "This journey's code — the one this step issues, or the one an earlier step issued." },
    resolve: async (s, l) => s.couponCode || (await l.coupon())?.code || null,
  },
  {
    meta: { from: 'COUPON_EXPIRY', label: 'Offer expiry date', group: 'Offer', example: '29 Sep 2026', needsOffer: true,
      help: 'The date the code stops working, in IST.' },
    resolve: async (_s, l) => { const c = await l.coupon(); return c ? istDate(c.expiresAt) : null; },
  },
  {
    meta: { from: 'DISCOUNT_PCT', label: 'Discount', group: 'Offer', example: '50%', needsOffer: true },
    resolve: async (_s, l) => {
      const c = await l.coupon();
      return c?.discountPercentage != null ? `${c.discountPercentage}%` : null;
    },
  },
  {
    meta: { from: 'VISIT_DATE', label: 'Visit date', group: 'Visit', example: '23 Sep 2026', needsVisit: true },
    resolve: async (_s, l) => { const v = await l.visit(); return v ? istDate(v.createdAt) : null; },
  },
  {
    meta: { from: 'AMOUNT_DUE', label: 'Amount still due', group: 'Visit', example: '₹1,200', needsVisit: true,
      help: 'The same figure as the "Amount still due" condition.' },
    resolve: async (s, l) => {
      const v = await l.visit();
      if (!v) return null;
      const paise = await prismaContext(s.now).outstandingDueInPaise(v.id);
      return `₹${Math.round(paise / 100).toLocaleString('en-IN')}`;
    },
  },
  {
    meta: { from: 'REFERRING_DOCTOR', label: 'Referring doctor', group: 'Visit', example: 'Dr. Rao', needsVisit: true,
      help: 'The doctor the visit is referred by today. A self visit has none, so the message is not sent.' },
    resolve: async (_s, l) => {
      const v = await l.visit();
      if (!v) return null;
      const link = await prisma.referralDoctor_Visit.findFirst({
        where: { visitId: v.id, deletedAt: null },
        select: { referralDoctor: { select: { name: true } } },
      });
      return link?.referralDoctor.name || null;
    },
  },
  {
    meta: { from: 'LITERAL', label: 'Fixed text', group: 'Other', example: 'any text you type' },
    resolve: async (_s, _l, value) => (value ?? '').trim() || null,
  },
];

/** What the builder is served. `resolve` never crosses the wire. */
export const FIELD_CATALOG: FieldMeta[] = FIELDS.map((f) => f.meta);

function loaders(src: FieldSource): Loaders {
  const once = <T>(fn: () => Promise<T>) => { let p: Promise<T> | null = null; return () => (p ??= fn()); };
  return {
    patient: once(() => (src.patientId
      ? prisma.patient.findUnique({ where: { id: src.patientId }, select: { name: true } })
      : Promise.resolve(null))),
    branch: once(() => (src.branchId
      ? prisma.branch.findUnique({ where: { id: src.branchId }, select: { name: true } })
      : Promise.resolve(null))),
    coupon: once(async () => {
      const c = await prisma.coupon.findFirst({
        where: { automationRunId: src.runId, status: { not: 'VOID' } },
        orderBy: { createdAt: 'desc' },
        select: { code: true, expiresAt: true, campaign: { select: { discountPercentage: true } } },
      });
      return c ? { code: c.code, expiresAt: c.expiresAt, discountPercentage: c.campaign.discountPercentage } : null;
    }),
    visit: once(() => (src.subjectType === 'VISIT'
      ? prisma.visit.findUnique({ where: { id: src.subjectId }, select: { id: true, createdAt: true } })
      : Promise.resolve(null))),
  };
}

/**
 * Fill every blank, or say which could not be filled. Never returns a partial message:
 * the caller sends `values` only when `missing` is empty.
 */
export async function resolveFields(
  params: { from: string; value?: string }[],
  src: FieldSource,
  /** Stand-in lookups, for the offline checks. Production passes nothing. */
  overrides?: Partial<Loaders>,
): Promise<{ values: string[]; missing: string[] }> {
  const load = { ...loaders(src), ...overrides };
  const values: string[] = [];
  const missing: string[] = [];
  for (const p of params) {
    const field = FIELDS.find((f) => f.meta.from === p.from);
    const v = field ? await field.resolve(src, load, p.value) : null;
    if (v == null || v === '') missing.push(p.from);
    values.push(v ?? '');
  }
  return { values, missing };
}
