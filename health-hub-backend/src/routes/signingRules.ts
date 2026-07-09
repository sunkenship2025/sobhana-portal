import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── GET /api/signing-rules ─────────────────────────────────────────
// List signing rules, optionally filtered by department
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { departmentId, active } = req.query;

    const where: any = {};

    if (departmentId && typeof departmentId === 'string') {
      where.departmentId = departmentId;
    }

    // Filter by active status (default: only active)
    if (active === 'all') {
      // no filter
    } else if (active === 'false') {
      where.isActive = false;
    } else {
      where.isActive = true;
    }

    const rules = await prisma.signingRule.findMany({
      where,
      include: {
        department: { select: { id: true, name: true } },
        signingDoctor: {
          select: { id: true, name: true, degrees: true, designation: true },
        },
      },
      orderBy: [
        { department: { name: 'asc' } },
        { displayOrder: 'asc' },
      ],
    });

    return res.json(rules);
  } catch (error) {
    console.error('Error fetching signing rules:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch signing rules' });
  }
});

// ─── GET /api/signing-rules/:id ─────────────────────────────────────
// Get a single signing rule
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const rule = await prisma.signingRule.findUnique({
      where: { id: req.params.id },
      include: {
        department: { select: { id: true, name: true } },
        signingDoctor: true,
      },
    });

    if (!rule) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing rule not found' });
    }

    return res.json(rule);
  } catch (error) {
    console.error('Error fetching signing rule:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch signing rule' });
  }
});

// ─── POST /api/signing-rules ────────────────────────────────────────
// Create a signing rule (assign a doctor to a department)
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { departmentId, signingDoctorId, showLabInchargeNote, displayOrder } = req.body;

    if (!departmentId || !signingDoctorId) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'departmentId and signingDoctorId are required',
      });
    }

    // Verify department exists
    const department = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!department) {
      return res.status(404).json({ error: 'DEPARTMENT_NOT_FOUND', message: 'Department not found' });
    }

    // Verify signing doctor exists
    const doctor = await prisma.signingDoctor.findUnique({ where: { id: signingDoctorId } });
    if (!doctor) {
      return res.status(404).json({ error: 'DOCTOR_NOT_FOUND', message: 'Signing doctor not found' });
    }

    const rule = await prisma.signingRule.create({
      data: {
        departmentId,
        signingDoctorId,
        showLabInchargeNote: showLabInchargeNote ?? false,
        displayOrder: displayOrder ?? 0,
      },
      include: {
        department: { select: { id: true, name: true } },
        signingDoctor: {
          select: { id: true, name: true, degrees: true, designation: true },
        },
      },
    });

    return res.status(201).json(rule);
  } catch (error: any) {
    // Handle unique constraint violation (department + doctor already linked)
    if (error.code === 'P2002') {
      // Check if there's a soft-deleted rule — reactivate it
      const existing = await prisma.signingRule.findFirst({
        where: { departmentId: req.body.departmentId, signingDoctorId: req.body.signingDoctorId },
      });
      if (existing && !existing.isActive) {
        const reactivated = await prisma.signingRule.update({
          where: { id: existing.id },
          data: {
            isActive: true,
            showLabInchargeNote: req.body.showLabInchargeNote ?? false,
            displayOrder: req.body.displayOrder ?? 0,
          },
          include: {
            department: { select: { id: true, name: true } },
            signingDoctor: {
              select: { id: true, name: true, degrees: true, designation: true },
            },
          },
        });
        return res.status(201).json(reactivated);
      }
      return res.status(409).json({
        error: 'DUPLICATE_RULE',
        message: 'This doctor is already assigned to this department',
      });
    }
    console.error('Error creating signing rule:', error);
    return res.status(500).json({ error: 'CREATE_FAILED', message: 'Failed to create signing rule' });
  }
});

// ─── PATCH /api/signing-rules/:id ───────────────────────────────────
// Update a signing rule
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { showLabInchargeNote, displayOrder, isActive, signingDoctorId } = req.body;

    const existing = await prisma.signingRule.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing rule not found' });
    }

    const data: any = {};
    if (showLabInchargeNote !== undefined) data.showLabInchargeNote = showLabInchargeNote;
    if (displayOrder !== undefined) data.displayOrder = displayOrder;
    if (isActive !== undefined) data.isActive = isActive;

    // Reassigning the rule to a different doctor keeps the department fixed (the
    // rule "belongs" to its department). Guard the [departmentId, signingDoctorId]
    // unique constraint so a friendly 409 replaces a raw Prisma error.
    if (signingDoctorId !== undefined && signingDoctorId !== existing.signingDoctorId) {
      const collision = await prisma.signingRule.findFirst({
        where: {
          departmentId: existing.departmentId,
          signingDoctorId,
          id: { not: id },
        },
      });
      if (collision) {
        return res.status(409).json({
          error: 'DUPLICATE_RULE',
          message: 'That doctor already has a signing rule for this department',
        });
      }
      data.signingDoctorId = signingDoctorId;
    }

    const rule = await prisma.signingRule.update({
      where: { id },
      data,
      include: {
        department: { select: { id: true, name: true } },
        signingDoctor: {
          select: { id: true, name: true, degrees: true, designation: true },
        },
      },
    });

    return res.json(rule);
  } catch (error) {
    console.error('Error updating signing rule:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: 'Failed to update signing rule' });
  }
});

// ─── DELETE /api/signing-rules/:id ──────────────────────────────────
// Hard-delete a signing rule (rules are just assignments, not historical data)
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.signingRule.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing rule not found' });
    }

    await prisma.signingRule.delete({
      where: { id },
    });

    return res.json({ message: 'Signing rule deleted' });
  } catch (error) {
    console.error('Error deleting signing rule:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: 'Failed to delete signing rule' });
  }
});

// ─── PUT /api/signing-rules/reorder ─────────────────────────────────
// Bulk-update display order for rules in a department
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
        prisma.signingRule.update({
          where: { id: rule.id },
          data: { displayOrder: rule.displayOrder },
        })
      )
    );

    return res.json({ message: 'Display order updated', count: rules.length });
  } catch (error) {
    console.error('Error reordering signing rules:', error);
    return res.status(500).json({ error: 'REORDER_FAILED', message: 'Failed to reorder signing rules' });
  }
});

export default router;
