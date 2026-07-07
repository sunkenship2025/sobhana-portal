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
    select: { id: true, code: true, validityDays: true, isActive: true },
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
          expiresAt,
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

// ============================================================================
// VALIDATE + DISCOUNT (pre-tx, for the billing screen)
// ============================================================================

export type CouponRejection =
  | 'NOT_FOUND'
  | 'ALREADY_REDEEMED'
  | 'EXPIRED'
  | 'VOID'
  | 'CAMPAIGN_INACTIVE';

export interface CouponValidation {
  ok: boolean;
  reason?: CouponRejection;
  coupon?: {
    id: string;
    code: string;
    status: CouponStatus;
    expiresAt: Date;
  };
  campaign?: {
    id: string;
    code: string;
    name: string;
    discountType: BillDiscountType;
    discountPercentage: number | null;
    discountReason: string;
    scope: string;
  };
}

/** Look a code up and decide whether it can be redeemed right now. */
export async function validateCouponByCode(rawCode: string): Promise<CouponValidation> {
  const code = rawCode.trim().toUpperCase();
  const coupon = await prisma.coupon.findUnique({
    where: { code },
    include: {
      campaign: {
        select: {
          id: true, code: true, name: true, isActive: true,
          discountType: true, discountPercentage: true, discountReason: true, scope: true,
        },
      },
    },
  });
  if (!coupon) return { ok: false, reason: 'NOT_FOUND' };

  const campaign = coupon.campaign;
  if (coupon.status === CouponStatus.REDEEMED) return { ok: false, reason: 'ALREADY_REDEEMED' };
  if (coupon.status === CouponStatus.VOID) return { ok: false, reason: 'VOID' };
  if (coupon.status === CouponStatus.EXPIRED || coupon.expiresAt < new Date()) {
    return { ok: false, reason: 'EXPIRED' };
  }
  if (!campaign.isActive) return { ok: false, reason: 'CAMPAIGN_INACTIVE' };

  return {
    ok: true,
    coupon: { id: coupon.id, code: coupon.code, status: coupon.status, expiresAt: coupon.expiresAt },
    campaign: {
      id: campaign.id, code: campaign.code, name: campaign.name,
      discountType: campaign.discountType, discountPercentage: campaign.discountPercentage,
      discountReason: campaign.discountReason, scope: campaign.scope,
    },
  };
}

/**
 * Coupon discount in paise for a given in-scope subtotal.
 * The caller decides the in-scope amount (TESTS_ONLY -> test line items;
 * WHOLE_BILL -> the whole subtotal), keeping this pure and reusable.
 */
export function computeCouponDiscountInPaise(
  campaign: { discountType: BillDiscountType; discountPercentage: number | null },
  inScopeAmountInPaise: number,
): number {
  const subtotal = Math.max(0, Math.round(inScopeAmountInPaise || 0));
  if (campaign.discountType === BillDiscountType.PERCENTAGE) {
    const pct = Math.min(100, Math.max(0, campaign.discountPercentage ?? 0));
    return Math.min(subtotal, Math.round((subtotal * pct) / 100));
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
}

/**
 * Atomically flip ISSUED -> REDEEMED. Throws if the coupon is no longer
 * redeemable (already used / expired / void) so the surrounding bill tx rolls
 * back. Call validateCouponByCode() first for a friendly pre-check; this is the
 * race-proof guard.
 */
export async function redeemCouponInTx(tx: Tx, input: RedeemCouponInput): Promise<void> {
  const res = await tx.coupon.updateMany({
    where: { id: input.couponId, status: CouponStatus.ISSUED, expiresAt: { gt: new Date() } },
    data: {
      status: CouponStatus.REDEEMED,
      redeemedAt: new Date(),
      redeemedVisitId: input.visitId,
      redeemedBillId: input.billId,
      redeemedByUserId: input.userId,
    },
  });
  if (res.count !== 1) {
    throw new Error('COUPON_NOT_REDEEMABLE'); // already used, expired, or gone
  }
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
          discountReason: true, landingTheme: true, scope: true,
        },
      },
    },
  });
  if (!coupon) return null;
  return coupon;
}
