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

router.get('/', async (_req: AuthRequest, res) => {
  try {
    const campaigns = await prisma.couponCampaign.findMany({ orderBy: { createdAt: 'desc' } });
    const counts = await prisma.coupon.groupBy({
      by: ['campaignId', 'status'],
      _count: { _all: true },
    });

    return res.json({
      offers: campaigns.map((c) => {
        const mine = counts.filter((x) => x.campaignId === c.id);
        const by = (s: string) => mine.find((x) => x.status === s)?._count._all ?? 0;
        const issued = by('ISSUED') + by('REDEEMED');
        return {
          id: c.id,
          code: c.code,
          name: c.name,
          isActive: c.isActive,
          discountPercentage: c.discountPercentage,
          scope: c.scope,
          validityDays: c.validityDays,
          distribution: c.distribution,
          bindToPatient: c.bindToPatient,
          referrerSharePct: c.referrerSharePct,
          issued,
          redeemed: by('REDEEMED'),
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
      }),
    });
  } catch (e) { return fail(res, e); }
});

router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const c = await prisma.couponCampaign.findUnique({
      where: { id: req.params.id },
      include: { products: { select: { id: true, name: true } } },
    });
    if (!c) return res.status(404).json({ error: 'NOT_FOUND' });

    const [redeemedSum, usedByAutomations] = await Promise.all([
      prisma.bill.aggregate({
        where: { couponId: { in: (await prisma.coupon.findMany({
          where: { campaignId: c.id, status: 'REDEEMED' }, select: { id: true },
        })).map((x) => x.id) } },
        _sum: { couponDiscountInPaise: true },
      }),
      prisma.automation.findMany({
        where: { definition: { path: ['steps'], array_contains: [] } },
        select: { id: true, name: true },
      }).catch(() => [] as { id: string; name: string }[]),
    ]);

    return res.json({
      ...c,
      discountGivenInPaise: redeemedSum._sum.couponDiscountInPaise ?? 0,
      usedByAutomations,
      /// Three ways to answer "who pays for the discount on a referred patient",
      /// computed rather than described so the screen does not have to do the arithmetic.
      referralExamples: {
        centreAbsorbs: referralExample(c.discountPercentage ?? 0, 0),
        split: referralExample(c.discountPercentage ?? 0, 50),
        doctorShares: referralExample(c.discountPercentage ?? 0, 100),
        current: referralExample(c.discountPercentage ?? 0, c.referrerSharePct),
      },
      stackingRule: 'LARGER_IN_RUPEES_WINS',
    });
  } catch (e) { return fail(res, e); }
});

router.post('/', async (req: AuthRequest, res) => {
  try {
    const { code, name, discountPercentage, discountReason, validityDays, scope, whatsappTemplate } = req.body ?? {};
    if (!code || !name) return res.status(400).json({ error: 'CODE_AND_NAME_REQUIRED' });

    const c = await prisma.couponCampaign.create({
      data: {
        code: String(code).toUpperCase(),
        name,
        discountPercentage: discountPercentage ?? 15,
        discountReason: discountReason ?? name,
        validityDays: validityDays ?? 30,
        scope: scope ?? 'TESTS_ONLY',
        whatsappTemplate: whatsappTemplate ?? '',
        // Created INACTIVE. An offer that is live the moment it is saved is one slip
        // away from money going out the door before anyone agreed the numbers.
        isActive: false,
        distribution: req.body.distribution ?? 'UNIQUE_PER_PATIENT',
        bindToPatient: req.body.bindToPatient ?? false,
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

    const fields = [
      'name', 'discountPercentage', 'discountReason', 'validityDays', 'scope',
      'isActive', 'bindToPatient', 'referrerSharePct', 'whatsappTemplate',
      'maxDiscountBudgetInPaise', 'maxDiscountPerBillInPaise', 'maxRedemptions',
    ] as const;
    const data: Record<string, unknown> = {};
    for (const f of fields) if (req.body[f] !== undefined) data[f] = req.body[f];

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
        automationRunId: true,
      },
    });
    const hasMore = rows.length > take;
    return res.json({
      coupons: rows.slice(0, take),
      nextCursor: hasMore ? rows[take - 1].id : null,
    });
  } catch (e) { return fail(res, e); }
});

export default router;
