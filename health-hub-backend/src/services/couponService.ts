/**
 * Coupon Service — reusable campaign coupons (see EVENTS_AND_COUPONS.md)
 *
 * A coupon is minted when an EVENT BillableProduct is billed, delivered over
 * WhatsApp with a public /c/:token link, and redeemed once from a later
 * diagnostic/clinic bill.
 *
 * Design:
 *  - issueCoupon() runs POST-commit (own connection). Token/code uniqueness uses
 *    a retry loop, which would abort a surrounding transaction — so it must NOT
 *    run inside the visit-creation tx. Mirrors the post-commit WhatsApp send.
 *  - redeemCouponInTx() runs INSIDE the redeeming bill's transaction. A single
 *    conditional updateMany (status ISSUED -> REDEEMED) makes redemption atomic
 *    and one-time even under concurrent bills; count 0 => already used/expired.
 *  - Tokens mirror billAccessService: 256-bit CSPRNG, only the SHA-256 hash stored.
 */

import crypto from 'crypto';
import { Prisma, BillDiscountType, CouponStatus } from '@prisma/client';
import prisma from '../lib/prisma';

type Tx = Prisma.TransactionClient;

// ============================================================================
// TOKEN + CODE GENERATION
// ============================================================================

function generateToken(): string {
  // 32 bytes CSPRNG (~256 bits), base64url. Only the hash is persisted.
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Unambiguous alphabet: no 0/O/1/I/L so codes are easy to read aloud & type.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Human-facing code, e.g. "BLOOD-4K9X2". Prefix derived from the campaign code. */
function generateCode(campaignCode: string): string {
  const prefix = (campaignCode.split('_')[0] || 'CODE').slice(0, 6).toUpperCase();
  let body = '';
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i += 1) {
    body += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return `${prefix}-${body}`;
}

// ============================================================================
// ISSUE  (post-commit; own connection)
// ============================================================================

export interface IssueCouponInput {
  campaignId: string;
  patientId?: string | null;
  phone?: string | null;
  issuedVisitId?: string | null;
  issuedByUserId?: string | null;
  allowedProductIds?: string[]; // [] = all in-scope tests; else discount only these products
}

export interface IssuedCoupon {
  couponId: string;
  code: string;
  rawToken: string; // goes in the WhatsApp /c/:token link — never stored raw
  expiresAt: Date;
}

/**
 * Mint one coupon for a campaign. Retries on the (astronomically rare) token or
 * (rare) code collision. Returns the raw token for the public link.
 */
export async function issueCoupon(input: IssueCouponInput): Promise<IssuedCoupon> {
  const campaign = await prisma.couponCampaign.findUnique({
    where: { id: input.campaignId },
    select: { id: true, code: true, validityDays: true, isActive: true, maxUsesPerCode: true },
  });
  if (!campaign) throw new Error(`CouponCampaign not found: ${input.campaignId}`);
  if (!campaign.isActive) throw new Error(`CouponCampaign inactive: ${campaign.code}`);

  const expiresAt = new Date(Date.now() + campaign.validityDays * 24 * 60 * 60 * 1000);

  const maxAttempts = 10;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const rawToken = generateToken();
    const code = generateCode(campaign.code);
    try {
      const coupon = await prisma.coupon.create({
        data: {
          code,
          token: hashToken(rawToken),
          campaignId: campaign.id,
          status: CouponStatus.ISSUED,
          patientId: input.patientId ?? null,
          phone: input.phone ?? null,
          issuedVisitId: input.issuedVisitId ?? null,
          issuedByUserId: input.issuedByUserId ?? null,
          allowedProductIds: input.allowedProductIds ?? [],
          expiresAt,
          // Snapshotted: editing the offer later never changes a code already handed out.
          maxUses: Math.max(1, campaign.maxUsesPerCode),
        },
        select: { id: true },
      });
      return { couponId: coupon.id, code, rawToken, expiresAt };
    } catch (err: any) {
      if (err?.code === 'P2002') continue; // unique clash on code or token — retry
      throw err;
    }
  }
  throw new Error('Failed to generate a unique coupon after multiple attempts');
}

/**
 * BillableProduct ids the patient STILL has an abnormal result for (flag
 * HIGH/LOW/CRITICAL_* with no later normal for that analyte). Used to scope a
 * retest coupon to exactly the patient's off-panels. Mirrors the recall query.
 */
export async function resolveAbnormalProductIds(patientId: string): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ productId: string }>>`
    SELECT DISTINCT tord."productId" AS "productId"
    FROM "TestResult" tr
    JOIN "TestOrder" tord ON tr."testOrderId" = tord.id
    JOIN "Visit" v ON tord."visitId" = v.id
    WHERE v."patientId" = ${patientId}
      AND tr.flag IN ('HIGH','LOW','CRITICAL_HIGH','CRITICAL_LOW')
      AND tord."productId" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "TestResult" tr2
        JOIN "TestOrder" tord2 ON tr2."testOrderId" = tord2.id
        JOIN "Visit" v2 ON tord2."visitId" = v2.id
        WHERE v2."patientId" = v."patientId"
          AND tr2."testDefinitionId" = tr."testDefinitionId"
          AND tr2."createdAt" > tr."createdAt"
          AND tr2.flag NOT IN ('HIGH','LOW','CRITICAL_HIGH','CRITICAL_LOW')
      )`;
  return rows.map((r) => r.productId).filter(Boolean);
}

// ============================================================================
// VALIDATE + DISCOUNT (pre-tx, for the billing screen)
// ============================================================================

export type CouponRejection =
  | 'NOT_FOUND'
  | 'ALREADY_REDEEMED'
  | 'EXPIRED'
  | 'VOID'
  | 'CAMPAIGN_INACTIVE'
  /// The code belongs to a different patient and the campaign is patient-bound.
  | 'WRONG_PATIENT'
  /// A family-and-friends code presented for the very patient it was given to.
  | 'OWN_CODE'
  /// Minted but its message never left; it is not a live code.
  | 'NOT_ISSUED';

export interface CouponValidation {
  ok: boolean;
  reason?: CouponRejection;
  coupon?: {
    id: string;
    code: string;
    status: CouponStatus;
    expiresAt: Date;
    allowedProductIds: string[];
    /** Bills this code can still discount. */
    usesLeft: number;
  };
  campaign?: {
    id: string;
    code: string;
    name: string;
    discountType: BillDiscountType;
    discountPercentage: number | null;
    discountReason: string;
    scope: string;
    /// Caps the rupee value of ONE redemption. 15% of a ₹40,000 bill is ₹6,000
    /// unless something says otherwise, and nothing did.
    maxDiscountPerBillInPaise: number | null;
    /// How much of this discount the referring doctor shares, 0-100. Read by the
    /// payout allocator so the answer is a decision rather than an accident of
    /// which column it happened to read.
    referrerSharePct: number;
  };
}

/**
 * Look a code up and decide whether it can be redeemed right now.
 *
 * `redeemingPatientId` is optional so every existing caller keeps working, but a
 * patient-bound campaign REFUSES when it is absent — the safe direction, since the
 * alternative is a bound coupon that silently binds to nobody.
 */
/**
 * Who may use a code, against the patient being billed. Pure, so the rules are checked
 * offline. By patient RECORD, never phone: families share phones, and a family offer
 * blocked by phone would block exactly the people it is for.
 */
export function holderAllows(
  holder: 'ANYONE' | 'ISSUED_PATIENT_ONLY' | 'NOT_ISSUED_PATIENT',
  issuedPatientId: string | null,
  redeemingPatientId: string | null | undefined,
): 'OK' | 'WRONG_PATIENT' | 'OWN_CODE' {
  // A code issued to nobody in particular has no holder to compare with.
  if (!issuedPatientId) return 'OK';
  if (holder === 'ISSUED_PATIENT_ONLY') {
    // A missing patient reads as the wrong one: the safe direction for a bound code.
    return redeemingPatientId === issuedPatientId ? 'OK' : 'WRONG_PATIENT';
  }
  if (holder === 'NOT_ISSUED_PATIENT') {
    // A brand-new registration has no record yet, and cannot be the holder.
    return redeemingPatientId && redeemingPatientId === issuedPatientId ? 'OWN_CODE' : 'OK';
  }
  return 'OK';
}

export async function validateCouponByCode(
  rawCode: string,
  redeemingPatientId?: string | null,
): Promise<CouponValidation> {
  const code = rawCode.trim().toUpperCase();
  const coupon = await prisma.coupon.findUnique({
    where: { code },
    include: {
      campaign: {
        select: {
          id: true, code: true, name: true, isActive: true,
          discountType: true, discountPercentage: true, discountReason: true, scope: true,
          maxDiscountPerBillInPaise: true, referrerSharePct: true, holder: true,
        },
      },
    },
  });
  if (!coupon) return { ok: false, reason: 'NOT_FOUND' };

  const campaign = coupon.campaign;
  if (coupon.status === CouponStatus.REDEEMED) return { ok: false, reason: 'ALREADY_REDEEMED' };
  if (coupon.status === CouponStatus.VOID) return { ok: false, reason: 'VOID' };
  // PENDING means the message carrying it never left. It is not a code the patient has.
  if (coupon.status === CouponStatus.PENDING) return { ok: false, reason: 'NOT_ISSUED' };
  if (coupon.status === CouponStatus.EXPIRED || coupon.expiresAt < new Date()) {
    return { ok: false, reason: 'EXPIRED' };
  }
  if (!campaign.isActive) return { ok: false, reason: 'CAMPAIGN_INACTIVE' };

  // Who may use it — see holderAllows. The billing screen and the bill route both pass
  // the patient being billed; before they did, a bound code refused everyone.
  const who = holderAllows(campaign.holder, coupon.patientId, redeemingPatientId);
  if (who !== 'OK') return { ok: false, reason: who };

  return {
    ok: true,
    coupon: {
      id: coupon.id, code: coupon.code, status: coupon.status, expiresAt: coupon.expiresAt,
      allowedProductIds: coupon.allowedProductIds, usesLeft: coupon.maxUses - coupon.useCount,
    },
    campaign: {
      id: campaign.id, code: campaign.code, name: campaign.name,
      discountType: campaign.discountType, discountPercentage: campaign.discountPercentage,
      discountReason: campaign.discountReason, scope: campaign.scope,
      maxDiscountPerBillInPaise: campaign.maxDiscountPerBillInPaise,
      referrerSharePct: campaign.referrerSharePct,
    },
  };
}

/**
 * Coupon discount in paise for a given in-scope subtotal.
 * The caller decides the in-scope amount (TESTS_ONLY -> test line items;
 * WHOLE_BILL -> the whole subtotal), keeping this pure and reusable.
 */
export function computeCouponDiscountInPaise(
  campaign: {
    discountType: BillDiscountType;
    discountPercentage: number | null;
    maxDiscountPerBillInPaise?: number | null;
  },
  inScopeAmountInPaise: number,
): number {
  const subtotal = Math.max(0, Math.round(inScopeAmountInPaise || 0));
  const cap = campaign.maxDiscountPerBillInPaise ?? null;
  if (campaign.discountType === BillDiscountType.PERCENTAGE) {
    const pct = Math.min(100, Math.max(0, campaign.discountPercentage ?? 0));
    const raw = Math.min(subtotal, Math.round((subtotal * pct) / 100));
    return cap !== null ? Math.min(raw, Math.max(0, cap)) : raw;
  }
  // FLAT_AMOUNT campaigns are not used yet; treat percentage as the primary path.
  return 0;
}

// ============================================================================
// REDEEM  (inside the redeeming bill's transaction — atomic, one-time)
// ============================================================================

export interface RedeemCouponInput {
  couponId: string;
  visitId: string;
  billId: string;
  userId: string;
  /** The patient being billed — for a family offer, not the one the code was issued to. */
  patientId?: string | null;
  /** What this bill was actually discounted, for "discount given" and the budget. */
  discountInPaise?: number;
}

/**
 * Use one of a code's uses, inside the bill's own transaction.
 *
 * The increment is a single conditional UPDATE — prisma cannot say `useCount < maxUses`
 * — so two bills racing for a code's last use cannot both have it. The last use turns
 * the code REDEEMED; earlier uses leave it ISSUED with uses to spare. The first use also
 * fills Coupon.redeemed* for older readers; CouponRedemption is the record of every use.
 *
 * Throws if the code has no use left, expired, or is not live, so the bill rolls back.
 */
export async function redeemCouponInTx(tx: Tx, input: RedeemCouponInput): Promise<void> {
  const rows = await tx.$queryRaw<{ campaignId: string; reservedPerUseInPaise: number }[]>`
    UPDATE "Coupon" SET
      "useCount" = "useCount" + 1,
      "status" = CASE WHEN "useCount" + 1 >= "maxUses" THEN 'REDEEMED'::"CouponStatus" ELSE "status" END,
      "redeemedAt" = COALESCE("redeemedAt", now()),
      "redeemedVisitId" = COALESCE("redeemedVisitId", ${input.visitId}),
      "redeemedBillId" = COALESCE("redeemedBillId", ${input.billId}),
      "redeemedByUserId" = COALESCE("redeemedByUserId", ${input.userId}),
      "updatedAt" = now()
    WHERE "id" = ${input.couponId} AND "status" = 'ISSUED'
      AND "useCount" < "maxUses" AND "expiresAt" > now()
    RETURNING "campaignId", "reservedPerUseInPaise"`;
  if (rows.length !== 1) {
    throw new Error('COUPON_NOT_REDEEMABLE'); // used up, expired, or gone
  }

  const phone = input.patientId
    ? (await tx.patientIdentifier.findFirst({
        where: { patientId: input.patientId, type: 'PHONE' },
        orderBy: { isPrimary: 'desc' }, select: { value: true },
      }))?.value ?? null
    : null;
  const discount = Math.max(0, Math.round(input.discountInPaise ?? 0));
  await tx.couponRedemption.create({
    data: {
      couponId: input.couponId, visitId: input.visitId, billId: input.billId,
      patientId: input.patientId ?? null, phone, redeemedByUserId: input.userId,
      discountInPaise: discount,
    },
  });
  // The budget: this use's promise becomes money actually given. Recording the spend
  // never happened before — committedInPaise was read everywhere and written nowhere.
  const { campaignId, reservedPerUseInPaise } = rows[0];
  await tx.couponCampaign.update({
    where: { id: campaignId },
    data: {
      committedInPaise: { increment: discount },
      ...(reservedPerUseInPaise > 0 ? { reservedInPaise: { decrement: reservedPerUseInPaise } } : {}),
    },
  });
}

/**
 * What a code becomes when one of its uses is reversed. Pure, for the offline checks.
 * A code still in date gets the use back (Pranav's decision: a refunded use returns to
 * the code); an expired one records that it was used and then refunded.
 */
export function statusAfterReversal(expiresAt: Date, now: Date): { status: 'ISSUED' | 'REFUNDED'; usable: boolean } {
  return expiresAt > now ? { status: 'ISSUED', usable: true } : { status: 'REFUNDED', usable: false };
}

/**
 * The bill was cancelled or fully refunded: every use of a code on it is undone.
 *
 * Nothing wrote CouponStatus.REFUNDED before this — a cancelled bill kept its code
 * "used" and its discount counted as given, so Results' "used, then refunded" was
 * always 0. Returns how many uses were reversed.
 */
export async function reverseRedemptionsForBill(tx: Tx, billId: string, reason: string, now = new Date()): Promise<number> {
  const live = await tx.couponRedemption.findMany({
    where: { billId, reversedAt: null },
    select: {
      id: true, discountInPaise: true,
      coupon: { select: { id: true, campaignId: true, expiresAt: true, reservedPerUseInPaise: true } },
    },
  });
  for (const r of live) {
    const claimed = await tx.couponRedemption.updateMany({
      where: { id: r.id, reversedAt: null }, data: { reversedAt: now, reversedReason: reason },
    });
    if (claimed.count !== 1) continue;
    const next = statusAfterReversal(r.coupon.expiresAt, now);
    await tx.coupon.update({
      where: { id: r.coupon.id },
      data: { useCount: { decrement: 1 }, status: next.status },
    });
    await tx.couponCampaign.update({
      where: { id: r.coupon.campaignId },
      data: {
        committedInPaise: { decrement: r.discountInPaise },
        // The use is promised again only if the code can still be used.
        ...(next.usable && r.coupon.reservedPerUseInPaise > 0
          ? { reservedInPaise: { increment: r.coupon.reservedPerUseInPaise } } : {}),
      },
    });
  }
  return live.length;
}

/**
 * Codes past their date are marked EXPIRED and their unused budget is released.
 *
 * Nothing wrote EXPIRED before — expiry was only ever worked out on read — so budget set
 * aside for a code nobody used stayed set aside for good. Runs on the automation engine's
 * half-hourly pass, which already wakes the database; it adds no wake-up of its own.
 */
export async function expireCoupons(now = new Date()): Promise<number> {
  const due = await prisma.coupon.findMany({
    where: { status: CouponStatus.ISSUED, expiresAt: { lte: now } },
    select: { id: true, campaignId: true, maxUses: true, useCount: true, reservedPerUseInPaise: true },
    take: 500,
  });
  let expired = 0;
  for (const c of due) {
    const claimed = await prisma.coupon.updateMany({
      where: { id: c.id, status: CouponStatus.ISSUED }, data: { status: CouponStatus.EXPIRED },
    });
    if (claimed.count !== 1) continue;
    expired += 1;
    const unused = Math.max(0, c.maxUses - c.useCount) * c.reservedPerUseInPaise;
    if (unused > 0) {
      await prisma.couponCampaign.update({
        where: { id: c.campaignId }, data: { reservedInPaise: { decrement: unused } },
      });
    }
  }
  return expired;
}

// ============================================================================
// PUBLIC PAGE  (/c/:token)
// ============================================================================

/** Resolve a raw public token to its coupon + campaign for the landing page. */
export async function getCouponByToken(rawToken: string) {
  const coupon = await prisma.coupon.findUnique({
    where: { token: hashToken(rawToken) },
    include: {
      campaign: {
        select: {
          name: true, discountType: true, discountPercentage: true,
          discountReason: true, landingTheme: true, scope: true, holder: true,
        },
      },
    },
  });
  if (!coupon) return null;
  return coupon;
}
