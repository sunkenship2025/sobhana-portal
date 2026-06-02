import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── GET /api/lab-incharge-rules ────────────────────────────────────
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { branchId, active } = req.query;

    const where: any = {};

    if (branchId && typeof branchId === 'string') {
      where.branchId = branchId;
    }

    if (active === 'all') {
      // no filter
    } else if (active === 'false') {
      where.isActive = false;
    } else {
      where.isActive = true;
    }

    const rules = await prisma.labInchargeRule.findMany({
      where,
      include: {
        branch: { select: { id: true, name: true } },
        signingLabIncharge: {
          select: { id: true, name: true, designation: true, signatureImagePath: true },
        },
      },
      orderBy: [
        { branch: { name: 'asc' } },
        { displayOrder: 'asc' },
      ],
    });

    return res.json(rules);
  } catch (error) {
    console.error('Error fetching lab incharge rules:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch lab incharge rules' });
  }
});

// ─── GET /api/lab-incharge-rules/:id ────────────────────────────────
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const rule = await prisma.labInchargeRule.findUnique({
      where: { // @ts-ignore Prisma types
 id: req.params.id },
      include: {
        branch: { select: { id: true, name: true } },
        signingLabIncharge: true,
      },
    });

    if (!rule) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab incharge rule not found' });
    }

    return res.json(rule);
  } catch (error) {
    console.error('Error fetching lab incharge rule:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch lab incharge rule' });
  }
});

// ─── POST /api/lab-incharge-rules ───────────────────────────────────
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { signingLabInchargeId, branchId, displayOrder } = req.body;

    if (!signingLabInchargeId) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'signingLabInchargeId is required',
      });
    }

    // Verify lab incharge exists
    const labIncharge = await prisma.signingLabIncharge.findUnique({ where: { // @ts-ignore Prisma types
 id: signingLabInchargeId } });
    if (!labIncharge) {
      return res.status(404).json({ error: 'LAB_INCHARGE_NOT_FOUND', message: 'Signing lab incharge not found' });
    }

    // Check for duplicate active rule on this branch scope
    const existingActive = await prisma.labInchargeRule.findFirst({
      where: { // @ts-ignore Prisma types

        branchId: branchId || null,
        isActive: true,
      },
    });

    if (existingActive) {
      const branchLabel = branchId ? 'this branch' : 'All Branches';
      return res.status(409).json({
        error: 'DUPLICATE_RULE',
        message: `An active lab incharge rule already exists for ${branchLabel}`,
      });
    }

    const rule = await prisma.labInchargeRule.create({
      // @ts-ignore Prisma strict typing
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        signingLabInchargeId,
        branchId: branchId || null,
        displayOrder: displayOrder ?? 0,
      },
      include: {
        branch: { select: { id: true, name: true } },
        signingLabIncharge: {
          select: { id: true, name: true, designation: true },
        },
      },
    });

    return res.status(201).json(rule);
  } catch (error: any) {
    // Handle unique constraint violation
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'DUPLICATE_RULE',
        message: 'An active lab incharge rule already exists for this branch scope',
      });
    }
    console.error('Error creating lab incharge rule:', error);
    return res.status(500).json({ error: 'CREATE_FAILED', message: 'Failed to create lab incharge rule' });
  }
});

// ─── PATCH /api/lab-incharge-rules/:id ──────────────────────────────
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { signingLabInchargeId, branchId, displayOrder, isActive } = req.body;

    const existing = await prisma.labInchargeRule.findUnique({ where: { // @ts-ignore Prisma types
 id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab incharge rule not found' });
    }

    // If changing branchId or signingLabInchargeId, check for conflicts
    if ((branchId !== undefined && branchId !== existing.branchId) ||
        (signingLabInchargeId !== undefined && signingLabInchargeId !== existing.signingLabInchargeId)) {
      const conflict = await prisma.labInchargeRule.findFirst({
        where: { // @ts-ignore Prisma types

          branchId: branchId || null,
          isActive: true,
          id: { not: id },
        },
      });
      if (conflict) {
        const branchLabel = branchId ? 'this branch' : 'All Branches';
        return res.status(409).json({
          error: 'DUPLICATE_RULE',
          message: `An active lab incharge rule already exists for ${branchLabel}`,
        });
      }
    }

    const data: // @ts-ignore
any = {};
    if (signingLabInchargeId !== undefined) data.signingLabInchargeId = signingLabInchargeId;
    if (branchId !== undefined) data.branchId = branchId || null;
    if (displayOrder !== undefined) data.displayOrder = displayOrder;
    if (isActive !== undefined) data.isActive = isActive;

    const rule = await prisma.labInchargeRule.update({
      where: { // @ts-ignore Prisma types
 id },
      data,
      include: {
        branch: { select: { id: true, name: true } },
        signingLabIncharge: {
          select: { id: true, name: true, designation: true },
        },
      },
    });

    return res.json(rule);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'DUPLICATE_RULE',
        message: 'An active lab incharge rule already exists for this branch scope',
      });
    }
    console.error('Error updating lab incharge rule:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: 'Failed to update lab incharge rule' });
  }
});

// ─── DELETE /api/lab-incharge-rules/:id ───────────────────────────
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.labInchargeRule.findUnique({ where: { // @ts-ignore Prisma types
 id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab incharge rule not found' });
    }

    await prisma.labInchargeRule.delete({
      where: { // @ts-ignore Prisma types
 id },
    });

    return res.json({ message: 'Lab incharge rule deleted' });
  } catch (error) {
    console.error('Error deleting lab incharge rule:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: 'Failed to delete lab incharge rule' });
  }
});

// ─── PUT /api/lab-incharge-rules/reorder ───────────────────────────
router.put('/reorder', async (req: AuthRequest, res) => {
  try {
    const { rules } = req.body;

    if (!Array.isArray(rules) || rules.length === 0) {
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'rules must be a non-empty array of { id, displayOrder }',
      });
    }

    await prisma.$transaction(
      rules.map((rule: { id: string; displayOrder: number }) =>
        prisma.labInchargeRule.update({
          where: { // @ts-ignore Prisma types
 id: rule.id },
          data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 displayOrder: rule.displayOrder },
        })
      )
    );

    return res.json({ message: 'Display order updated', count: rules.length });
  } catch (error) {
    console.error('Error reordering lab incharge rules:', error);
    return res.status(500).json({ error: 'REORDER_FAILED', message: 'Failed to reorder lab incharge rules' });
  }
});

export default router;
