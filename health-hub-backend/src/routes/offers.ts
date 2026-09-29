/**
 * /api/offers — the Offers tab.
 *
 * An offer is a RESOURCE an automation reaches for, not a peer of it: the automation
 * decides who and when, the offer decides what they get, and billing decides what is
 * redeemable. That separation is why coupon validation stays in couponService on the
 * billing side and is not duplicated here.
 *
 * Owner-only. These rows decide how much money the centre gives away.
 */
import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import { logAction } from '../services/auditService';
import prisma from '../lib/prisma';
import { couponLedger, couponFunnel, couponJourney } from '../services/automations/couponLedger';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

const fail = (res: any, e: unknown) => res.status(500).json({ error: (e as Error).message ?? 'FAILED' });

/** Worked on a ₹2,000 referred bill at 20%, so the screen can show what the switch costs. */
function referralExample(discountPct: number, sharePct: number) {
  const bill = 200000;
  const commissionPct = 20;
  const discount = Math.round((bill * discountPct) / 100);
  const base = bill - Math.round((discount * sharePct) / 100);
  const doctorGets = Math.round((base * commissionPct) / 100);
  return {
    billInPaise: bill,
    discountInPaise: discount,
    doctorPaidInPaise: doctorGets,
    centreKeepsInPaise: bill - discount - doctorGets,
    costToCentreInPaise: discount - (discount - Math.round((discount * sharePct) / 100)) * 0 - Math.round((discount * sharePct) / 100),
    costToDoctorInPaise: Math.round(((bill * commissionPct) / 100) - doctorGets),
  };
}

type CampaignRow = NonNullable<Awaited<ReturnType<typeof prisma.couponCampaign.findUnique>>>;
type CouponCounts = { campaignId: string; status: string; _count: { _all: number } }[];
/** Standing uses per campaign, from CouponRedemption — the only source of "used". */
type UseCounts = { campaignId: string; uses: number; codesUsed: number }[];

/**
 * What the Offers screens are given about one offer — the list AND the detail.
 *
 * They each built their own. The list grew `issued`, `redeemed` and a `budget` block;
 * the detail kept spreading the raw row, which has none of them, so opening an offer
 * read `o.budget.committedInPaise` off undefined and the screen threw on the click —
 * every offer, including the one a live journey hands out, could be listed and never
 * opened or switched on. One function means the two cannot disagree again.
 */
function summarizeOffer(c: CampaignRow, counts: CouponCounts, useCounts: UseCounts = []) {
  const mine = counts.filter((x) => x.campaignId === c.id);
  const by = (s: string) => mine.find((x) => x.status === s)?._count._all ?? 0;
  const issued = by('ISSUED') + by('REDEEMED') + by('REFUNDED') + by('EXPIRED');
  const u = useCounts.find((x) => x.campaignId === c.id);
  return {
    id: c.id,
    code: c.code,
    name: c.name,
    isActive: c.isActive,
    discountPercentage: c.discountPercentage,
    scope: c.scope,
    validityDays: c.validityDays,
    distribution: c.distribution,
    bindToPatient: c.holder === 'ISSUED_PATIENT_ONLY',
    /** Who may use a code: anyone, only the patient it was given to, or anyone BUT them. */
    holder: c.holder,
    maxUsesPerCode: c.maxUsesPerCode,
    /** Which tests a code discounts: all, the listed products, or the abnormal ones. */
    forTests: c.forTests,
    testProductIds: c.testProductIds,
    referrerSharePct: c.referrerSharePct,
    issued,
    /** Codes used at least once — a partly used family code counts. */
    redeemed: u?.codesUsed ?? 0,
    /** Standing uses: one family code can account for several bills. */
    uses: u?.uses ?? 0,
    expired: by('EXPIRED'),
    voided: by('VOID'),
    /// PENDING means the message carrying the code never left. Not a live code.
    pending: by('PENDING'),
    budget: {
      maxDiscountBudgetInPaise: c.maxDiscountBudgetInPaise,
      maxDiscountPerBillInPaise: c.maxDiscountPerBillInPaise,
      maxRedemptions: c.maxRedemptions,
      reservedInPaise: c.reservedInPaise,
      committedInPaise: c.committedInPaise,
      /// Exhausted counts what is RESERVED as well as spent: counting only
      /// redemptions lets a campaign issue far past its budget and discover it
      /// when redemption catches up.
      exhausted:
        c.maxDiscountBudgetInPaise !== null &&
        c.reservedInPaise + c.committedInPaise >= c.maxDiscountBudgetInPaise,
    },
  };
}

/** Standing uses per campaign, counted from CouponRedemption. */
async function useCountsFor(campaignIds: string[]): Promise<UseCounts> {
  if (campaignIds.length === 0) return [];
  return prisma.$queryRaw<UseCounts>`
    SELECT c."campaignId", COUNT(*)::int AS uses, COUNT(DISTINCT r."couponId")::int AS "codesUsed"
    FROM "CouponRedemption" r JOIN "Coupon" c ON c."id" = r."couponId"
    WHERE r."reversedAt" IS NULL AND c."campaignId" = ANY(${campaignIds})
    GROUP BY c."campaignId"`;
}

router.get('/', async (_req: AuthRequest, res) => {
  try {
    const campaigns = await prisma.couponCampaign.findMany({ orderBy: { createdAt: 'desc' } });
    const counts = await prisma.coupon.groupBy({
      by: ['campaignId', 'status'],
      _count: { _all: true },
    });
    const useCounts = await useCountsFor(campaigns.map((c) => c.id));

    return res.json({
      offers: campaigns.map((c) => {
        return summarizeOffer(c, counts, useCounts);
      }),
    });
  } catch (e) { return fail(res, e); }
});

/**
 * Everything the offer detail screen is given. Exported so the render check loads the
 * SAME payload production sends, rather than a hand-written guess at it — a guess is
 * exactly how the list and the detail came to disagree in the first place.
 */
export async function buildOfferDetail(id: string) {
  const c = await prisma.couponCampaign.findUnique({
    where: { id },
    include: { products: { select: { id: true, name: true } } },
  });
  if (!c) return null;

  const [redeemedSum, usedByAutomations] = await Promise.all([
    // Every standing use's own discount. A refunded use stops counting; summing the bills
    // that point at a code would keep counting it.
    prisma.couponRedemption.aggregate({
      where: { reversedAt: null, coupon: { campaignId: c.id } },
      _sum: { discountInPaise: true },
    }),
    // Filtered here, not in SQL: `array_contains: []` matched every automation, so the
    // screen said every offer was used by every journey, day sheets included.
    prisma.automation.findMany({ select: { id: true, name: true, definition: true } })
      .then((all) => all
        .filter((a) => ((a.definition as { steps?: { issueOffer?: { campaignId?: string } }[] })?.steps ?? [])
          .some((s) => s.issueOffer?.campaignId === c.id))
        .map((a) => ({ id: a.id, name: a.name }))),
  ]);
  const testProducts = c.testProductIds.length
    ? await prisma.billableProduct.findMany({ where: { id: { in: c.testProductIds } }, select: { id: true, name: true, code: true } })
    : [];

  const counts = await prisma.coupon.groupBy({
    by: ['campaignId', 'status'],
    where: { campaignId: c.id },
    _count: { _all: true },
  });

  return {
    ...c,
    ...summarizeOffer(c, counts, await useCountsFor([c.id])),
    discountGivenInPaise: redeemedSum._sum.discountInPaise ?? 0,
    usedByAutomations,
    testProducts,
    /// Three ways to answer "who pays for the discount on a referred patient",
    /// computed rather than described so the screen does not have to do the arithmetic.
    referralExamples: {
      centreAbsorbs: referralExample(c.discountPercentage ?? 0, 0),
      split: referralExample(c.discountPercentage ?? 0, 50),
      doctorShares: referralExample(c.discountPercentage ?? 0, 100),
      current: referralExample(c.discountPercentage ?? 0, c.referrerSharePct),
    },
    stackingRule: 'LARGER_IN_RUPEES_WINS',
  };
}

router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const detail = await buildOfferDetail(req.params.id);
    if (!detail) return res.status(404).json({ error: 'NOT_FOUND' });
    return res.json(detail);
  } catch (e) { return fail(res, e); }
});

/**
 * Who may use a code, from a request. `holder` is the setting; the old on/off
 * `bindToPatient` still works for any client that sends it, and the column is kept in
 * step until nothing reads it.
 */
function holderFields(body: Record<string, unknown>): { holder: 'ANYONE' | 'ISSUED_PATIENT_ONLY' | 'NOT_ISSUED_PATIENT'; bindToPatient: boolean } {
  const holder = body.holder === 'ISSUED_PATIENT_ONLY' || body.holder === 'NOT_ISSUED_PATIENT' || body.holder === 'ANYONE'
    ? body.holder
    : body.bindToPatient === true ? 'ISSUED_PATIENT_ONLY' : 'ANYONE';
  return { holder, bindToPatient: holder === 'ISSUED_PATIENT_ONLY' };
}

const pctOk = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100;

/** Which tests a code discounts. Anything unrecognised is "all tests", the old behaviour. */
function testsFields(body: Record<string, unknown>): { forTests: 'ALL' | 'LISTED' | 'ABNORMAL_ON_VISIT' | 'STILL_ABNORMAL'; testProductIds: string[] } {
  const forTests = (['LISTED', 'ABNORMAL_ON_VISIT', 'STILL_ABNORMAL'] as const).find((v) => v === body.forTests) ?? 'ALL';
  const ids = Array.isArray(body.testProductIds) ? body.testProductIds.filter((x): x is string => typeof x === 'string') : [];
  // Only a listed offer keeps its list; the others resolve their tests per code.
  return { forTests, testProductIds: forTests === 'LISTED' ? [...new Set(ids)] : [] };
}

router.post('/', async (req: AuthRequest, res) => {
  try {
    const { code, name, discountPercentage, discountReason, validityDays, scope, whatsappTemplate } = req.body ?? {};
    if (!code || !name) return res.status(400).json({ error: 'CODE_AND_NAME_REQUIRED' });
    if (discountPercentage !== undefined && !pctOk(discountPercentage)) {
      return res.status(400).json({ error: 'BAD_DISCOUNT', message: 'The discount must be between 1% and 100%.' });
    }
    if (req.body.forTests === 'LISTED' && testsFields(req.body).testProductIds.length === 0) {
      return res.status(400).json({ error: 'NO_TESTS_LISTED', message: 'Choose at least one test, or let it apply to all tests.' });
    }

    const c = await prisma.couponCampaign.create({
      data: {
        code: String(code).toUpperCase(),
        name,
        discountPercentage: discountPercentage ?? 15,
        discountReason: discountReason ?? name,
        validityDays: validityDays ?? 30,
        // A code for particular tests discounts tests; the bill ignores a test list on a
        // whole-bill offer, so the two cannot be combined.
        scope: testsFields(req.body).forTests !== 'ALL' ? 'TESTS_ONLY' : scope ?? 'TESTS_ONLY',
        whatsappTemplate: whatsappTemplate ?? '',
        // Created INACTIVE. An offer that is live the moment it is saved is one slip
        // away from money going out the door before anyone agreed the numbers.
        isActive: false,
        distribution: req.body.distribution ?? 'UNIQUE_PER_PATIENT',
        ...holderFields(req.body),
        ...testsFields(req.body),
        maxUsesPerCode: Math.max(1, Math.round(Number(req.body.maxUsesPerCode ?? 1)) || 1),
        referrerSharePct: req.body.referrerSharePct ?? 0,
        maxDiscountBudgetInPaise: req.body.maxDiscountBudgetInPaise ?? null,
        maxDiscountPerBillInPaise: req.body.maxDiscountPerBillInPaise ?? null,
        maxRedemptions: req.body.maxRedemptions ?? null,
      },
    });
    await logAction({
      branchId: req.branchId!, actionType: 'CREATE', entityType: 'CouponCampaign',
      entityId: c.id, userId: req.user?.id, newValues: JSON.stringify({ code: c.code }),
    });
    return res.status(201).json(c);
  } catch (e) { return fail(res, e); }
});

router.put('/:id', async (req: AuthRequest, res) => {
  try {
    const before = await prisma.couponCampaign.findUnique({ where: { id: req.params.id } });
    if (!before) return res.status(404).json({ error: 'NOT_FOUND' });

    // SHARED_CODE mints at redemption, which is not built. Refuse rather than accept a
    // setting the engine cannot honour — a stored mode nothing implements is a lie the
    // screen will faithfully display.
    if (req.body.distribution === 'SHARED_CODE') {
      return res.status(400).json({ error: 'SHARED_CODE_NOT_IMPLEMENTED' });
    }
    if (req.body.discountPercentage !== undefined && !pctOk(req.body.discountPercentage)) {
      return res.status(400).json({ error: 'BAD_DISCOUNT', message: 'The discount must be between 1% and 100%.' });
    }

    const fields = [
      'name', 'discountPercentage', 'discountReason', 'validityDays', 'scope',
      'isActive', 'referrerSharePct', 'whatsappTemplate',
      'maxDiscountBudgetInPaise', 'maxDiscountPerBillInPaise', 'maxRedemptions',
    ] as const;
    const data: Record<string, unknown> = {};
    for (const f of fields) if (req.body[f] !== undefined) data[f] = req.body[f];
    if (req.body.holder !== undefined || req.body.bindToPatient !== undefined) Object.assign(data, holderFields(req.body));
    if (req.body.maxUsesPerCode !== undefined) data.maxUsesPerCode = Math.max(1, Math.round(Number(req.body.maxUsesPerCode)) || 1);
    if (req.body.forTests !== undefined || req.body.testProductIds !== undefined) {
      Object.assign(data, testsFields({ forTests: before.forTests, testProductIds: before.testProductIds, ...req.body }));
    }
    if ((data.forTests ?? before.forTests) !== 'ALL' && (data.scope ?? before.scope) === 'WHOLE_BILL') {
      return res.status(400).json({ error: 'TESTS_ON_WHOLE_BILL', message: 'An offer for particular tests discounts those tests, not the whole bill.' });
    }
    if (data.forTests === 'LISTED' && (data.testProductIds as string[]).length === 0) {
      return res.status(400).json({ error: 'NO_TESTS_LISTED', message: 'Choose at least one test, or let it apply to all tests.' });
    }

    if (typeof data.referrerSharePct === 'number') {
      data.referrerSharePct = Math.min(100, Math.max(0, Math.round(data.referrerSharePct)));
    }

    const c = await prisma.couponCampaign.update({ where: { id: req.params.id }, data });
    await logAction({
      branchId: req.branchId!, actionType: 'UPDATE', entityType: 'CouponCampaign',
      entityId: c.id, userId: req.user?.id,
      oldValues: JSON.stringify({
        discountPercentage: before.discountPercentage, referrerSharePct: before.referrerSharePct,
        maxDiscountBudgetInPaise: before.maxDiscountBudgetInPaise, isActive: before.isActive,
      }),
      newValues: JSON.stringify(data),
    });
    return res.json(c);
  } catch (e) { return fail(res, e); }
});

/** The coupons themselves, for an offer's detail screen and for Patient 360. */
router.get('/:id/coupons', async (req: AuthRequest, res) => {
  try {
    const take = Math.min(Number(req.query.limit ?? 50), 200);
    const cursor = req.query.cursor as string | undefined;
    const rows = await prisma.coupon.findMany({
      where: {
        campaignId: req.params.id,
        ...(req.query.status ? { status: req.query.status as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true, code: true, status: true, patientId: true, phone: true,
        expiresAt: true, createdAt: true, redeemedAt: true, redeemedVisitId: true,
        automationRunId: true, useCount: true, maxUses: true,
      },
    });
    const hasMore = rows.length > take;
    return res.json({
      coupons: rows.slice(0, take),
      nextCursor: hasMore ? rows[take - 1].id : null,
    });
  } catch (e) { return fail(res, e); }
});

/**
 * The ledger: one row per coupon with the visit, run, bill, branch and money joined.
 *
 * Every field existed already; nothing joined them, so the question this answers could
 * previously only be asked in raw SQL.
 */
router.get('/:id/ledger', async (req: AuthRequest, res) => {
  try {
    const [rows, funnel] = await Promise.all([
      couponLedger(req.params.id, req.query.limit ? Number(req.query.limit) : 200),
      couponFunnel(req.params.id),
    ]);
    return res.json({ funnel, rows });
  } catch (e) { return fail(res, e); }
});

/** One coupon, end to end: what the journey did and what happened to the code. */
router.get('/coupons/:couponId/journey', async (req: AuthRequest, res) => {
  try {
    const j = await couponJourney(req.params.couponId);
    return j ? res.json(j) : res.status(404).json({ error: 'NOT_FOUND' });
  } catch (e) { return fail(res, e); }
});

export default router;
