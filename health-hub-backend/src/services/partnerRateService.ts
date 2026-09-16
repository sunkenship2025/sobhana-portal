/**
 * Partner rate resolution — the one place a partner's money is decided.
 *
 * A rate ALWAYS expresses OUR SHARE: what we keep, never what the other side
 * takes. One meaning across all three arrangements, so a number can never be
 * read inverted:
 *
 *   INBOUND_BILLED_HERE   we collect ₹300, share 20% ⇒ keep ₹60, owe them ₹240
 *   INBOUND_BILLED_THERE  they collect ₹300, share 20% ⇒ they owe us ₹60
 *   OUTBOUND_VENDOR       we collect ₹750, share 40% ⇒ keep ₹300, owe them ₹450
 *
 * The ladder mirrors the referral one (visitCorrectionService.ts), most specific
 * first, with a branch row beating a global row inside each rung:
 *
 *   product → category → the arrangement's own default
 *
 * Resolution happens ONCE, at order time, and the answer is frozen onto the
 * TestOrder (ourShareBasis / ourSharePercent / ourShareInPaise / partnerCut).
 * Editing a rate in November therefore cannot restate October — the same reason
 * referralCommission* and the old labCost* were snapshotted.
 */
import type {
  PartnerArrangementKind,
  PartnerDoctorCommissionMode,
  PartnerRateBasis,
} from '@prisma/client';
import prisma from '../lib/prisma';
import { distributeFixedAmountInPaise } from './referralPayoutService';

/** A resolved rate: what we keep, and how the referring doctor is paid. */
export interface ResolvedPartnerRate {
  basis: PartnerRateBasis;
  percent: number | null;
  amountInPaise: number | null;
  doctorCommissionMode: PartnerDoctorCommissionMode;
  /** Which rung answered — surfaced in the UI so a surprising number is explainable. */
  source: 'product' | 'category' | 'arrangement';
}

interface RateRow {
  branchId: string | null;
  rateBasis: PartnerRateBasis;
  ratePercent: number | null;
  rateAmountInPaise: number | null;
  doctorCommissionMode: PartnerDoctorCommissionMode | null;
}

/** The whole ladder for one arrangement, loaded once per billing pass. */
export interface PartnerRateCard {
  partnerId: string;
  arrangementId: string;
  kind: PartnerArrangementKind;
  weCollect: boolean;
  fallback: ResolvedPartnerRate;
  byProduct: Map<string, RateRow>;
  byCategory: Map<string, RateRow>;
}

/**
 * Global rows first, so a branch row overwrites the global one for the same key
 * when fed into a Map in order. Same trick as loadCenterCategoryRates.
 */
function branchLast<T extends { branchId: string | null }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.branchId === null ? 0 : 1) - (b.branchId === null ? 0 : 1));
}

/**
 * Load a partner's card for one arrangement in one branch. Returns null when the
 * partner has no active arrangement of that kind — the caller then treats the
 * visit as ordinary, rather than inventing a rate.
 */
export async function loadPartnerRateCard(
  partnerId: string,
  kind: PartnerArrangementKind,
  branchId: string,
): Promise<PartnerRateCard | null> {
  const arrangement = await prisma.partnerArrangement.findFirst({
    where: { partnerId, kind, isActive: true },
    include: {
      productRules: { where: { isActive: true, OR: [{ branchId }, { branchId: null }] } },
      categoryRules: { where: { isActive: true, OR: [{ branchId }, { branchId: null }] } },
    },
  });
  if (!arrangement) return null;

  const byProduct = new Map<string, RateRow>();
  for (const r of branchLast(arrangement.productRules)) byProduct.set(r.productId, r);
  const byCategory = new Map<string, RateRow>();
  for (const r of branchLast(arrangement.categoryRules)) byCategory.set(r.category, r);

  return {
    partnerId,
    arrangementId: arrangement.id,
    kind: arrangement.kind,
    weCollect: arrangement.weCollect,
    byProduct,
    byCategory,
    fallback: {
      basis: arrangement.rateBasis,
      percent: arrangement.ratePercent,
      amountInPaise: arrangement.rateAmountInPaise,
      doctorCommissionMode: arrangement.doctorCommissionMode,
      source: 'arrangement',
    },
  };
}

/** product → category → arrangement default. */
export function resolvePartnerRate(
  card: PartnerRateCard,
  productId: string | null,
  category: string | null,
): ResolvedPartnerRate {
  const hit =
    (productId ? card.byProduct.get(productId) : undefined) ??
    (category ? card.byCategory.get(category) : undefined);
  if (!hit) return card.fallback;
  return {
    basis: hit.rateBasis,
    percent: hit.ratePercent,
    amountInPaise: hit.rateAmountInPaise,
    // A rule may leave the doctor mode unset, meaning "inherit the arrangement".
    doctorCommissionMode: hit.doctorCommissionMode ?? card.fallback.doctorCommissionMode,
    source: productId && card.byProduct.has(productId) ? 'product' : 'category',
  };
}

/**
 * Our share of ONE product, in paise.
 *
 * `chargeInPaise` is the standing charge for that product — price less its share
 * of any discount, less anything reversed off it — never the raw list price, so
 * a discounted or partly-refunded order can never earn more than it stood for.
 *
 * `partnerBilledInPaise` is what the partner charged the patient. Only consulted
 * for PCT_OF_PARTNER_BILLED; when it is missing (the chit never arrived) we fall
 * back to our own charge rather than silently reporting zero revenue.
 */
export function computeOurShareInPaise(
  rate: ResolvedPartnerRate,
  chargeInPaise: number,
  partnerBilledInPaise: number | null,
): number {
  const charge = Math.max(0, Math.round(chargeInPaise));
  switch (rate.basis) {
    case 'FLAT':
      // A flat share is per product and never exceeds what the order stood for.
      return Math.min(charge, Math.max(0, Math.round(rate.amountInPaise ?? 0)));
    case 'PCT_OF_PARTNER_BILLED': {
      const base = partnerBilledInPaise != null ? Math.max(0, partnerBilledInPaise) : charge;
      return Math.round((base * (rate.percent ?? 0)) / 100);
    }
    case 'PCT_OF_OUR_PRICE':
    default:
      return Math.round((charge * (rate.percent ?? 0)) / 100);
  }
}

/** What we owe the partner on this order: nothing when the money was never ours. */
export function computePartnerCutInPaise(
  card: Pick<PartnerRateCard, 'weCollect'>,
  chargeInPaise: number,
  ourShareInPaise: number,
): number {
  if (!card.weCollect) return 0;
  return Math.max(0, Math.round(chargeInPaise) - ourShareInPaise);
}

/**
 * Spread ONE product's share across the TestOrder leaves it became.
 *
 * A CBP is 13 TestOrder rows at ₹23.07 each, so Lalitha's ₹60 cannot sit on any
 * one of them. Weighted by price and made to sum EXACTLY to the product total —
 * the same helper the fixed-amount referral path already uses, so rounding
 * behaves identically on both.
 */
export function distributeShareAcrossLeaves(
  totalShareInPaise: number,
  leafChargesInPaise: number[],
): number[] {
  return distributeFixedAmountInPaise(totalShareInPaise, leafChargesInPaise);
}

/**
 * The referring doctor's commission base for a partner order.
 *
 * NONE   → no commission at all (the partner IS the referrer — Lalitha).
 * GROSS  → the standing charge, exactly as for a walk-in.
 * OUR_SHARE (default) → what we kept.
 *
 * Whatever the mode, the caller must also clamp the resulting commission to our
 * share: a rate set wrong should not be able to pay out more than came in. That
 * guard lives at the call site because only it knows the final rupee figure.
 */
export function doctorCommissionBaseInPaise(
  mode: PartnerDoctorCommissionMode,
  chargeInPaise: number,
  ourShareInPaise: number,
): number | null {
  switch (mode) {
    case 'NONE':
      return null;
    case 'GROSS':
      return chargeInPaise;
    case 'OUR_SHARE':
    default:
      return ourShareInPaise;
  }
}
