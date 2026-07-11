import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

/** Shared include: branch, the covered departments, and the signer. */
const ruleInclude = {
  branch: { select: { id: true, name: true } },
  departments: { include: { department: { select: { id: true, name: true } } } },
  signingLabIncharge: {
    select: { id: true, name: true, designation: true, signatureImagePath: true },
  },
} as const;

/** Flatten the join rows into a plain `departments: [{ id, name }]` array. */
function shapeRule(rule: any) {
  return {
    ...rule,
    departments: (rule.departments ?? []).map((d: any) => d.department),
  };
}

/** Normalize a departmentIds body value to a de-duped list of non-empty strings. */
function normalizeDeptIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((x): x is string => typeof x === 'string' && x.length > 0))];
}

/**
 * Enforce "one incharge per (branch, department) slot" across rules at the same
 * branch scope. An All-Departments (empty set) rule is a catch-all: it coexists
 * with specific-department rules (most-specific resolution handles precedence),
 * so it only conflicts with another All-Departments rule. Two specific rules
 * conflict when their department sets intersect. Returns a human message, or null.
 */
async function findDepartmentConflict(
  branchScope: string | null,
  departmentIds: string[],
  excludeRuleId?: string,
): Promise<string | null> {
  const others = await prisma.labInchargeRule.findMany({
    where: {
      branchId: branchScope,
      isActive: true,
      ...(excludeRuleId ? { id: { not: excludeRuleId } } : {}),
    },
    include: { departments: { include: { department: { select: { name: true } } } } },
  });

  const isAll = departmentIds.length === 0;
  const wanted = new Set(departmentIds);

  for (const other of others) {
    const otherAll = other.departments.length === 0;
    if (isAll && otherAll) {
      return 'An active "All Departments" lab incharge rule already exists for this branch scope.';
    }
    if (!isAll && !otherAll) {
      const clash = other.departments.filter((d) => wanted.has(d.departmentId));
      if (clash.length > 0) {
        const names = clash.map((d) => d.department.name).join(', ');
        return `Another active lab incharge rule already covers: ${names}.`;
      }
    }
  }
  return null;
}

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
      include: ruleInclude,
      orderBy: [
        { branch: { name: 'asc' } },
        { displayOrder: 'asc' },
      ],
    });

    return res.json(rules.map(shapeRule));
  } catch (error) {
    console.error('Error fetching lab incharge rules:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch lab incharge rules' });
  }
});

// ─── GET /api/lab-incharge-rules/:id ────────────────────────────────
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const rule = await prisma.labInchargeRule.findUnique({
      where: { id: req.params.id },
      include: ruleInclude,
    });

    if (!rule) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab incharge rule not found' });
    }

    return res.json(shapeRule(rule));
  } catch (error) {
    console.error('Error fetching lab incharge rule:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch lab incharge rule' });
  }
});

// ─── POST /api/lab-incharge-rules ───────────────────────────────────
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { signingLabInchargeId, branchId, departmentIds, displayOrder } = req.body;

    if (!signingLabInchargeId) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'signingLabInchargeId is required',
      });
    }

    // Verify lab incharge exists
    const labIncharge = await prisma.signingLabIncharge.findUnique({ where: { id: signingLabInchargeId } });
    if (!labIncharge) {
      return res.status(404).json({ error: 'LAB_INCHARGE_NOT_FOUND', message: 'Signing lab incharge not found' });
    }

    const deptIds = normalizeDeptIds(departmentIds);
    const conflict = await findDepartmentConflict(branchId || null, deptIds);
    if (conflict) {
      return res.status(409).json({ error: 'DUPLICATE_RULE', message: conflict });
    }

    const rule = await prisma.labInchargeRule.create({
      data: {
        signingLabInchargeId,
        branchId: branchId || null,
        displayOrder: displayOrder ?? 0,
        departments: { create: deptIds.map((departmentId) => ({ departmentId })) },
      },
      include: ruleInclude,
    });

    return res.status(201).json(shapeRule(rule));
  } catch (error: any) {
    console.error('Error creating lab incharge rule:', error);
    return res.status(500).json({ error: 'CREATE_FAILED', message: 'Failed to create lab incharge rule' });
  }
});

// ─── PATCH /api/lab-incharge-rules/:id ──────────────────────────────
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { signingLabInchargeId, branchId, departmentIds, displayOrder, isActive } = req.body;

    const existing = await prisma.labInchargeRule.findUnique({
      where: { id },
      include: { departments: true },
    });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab incharge rule not found' });
    }

    const nextBranchId = branchId !== undefined ? (branchId || null) : existing.branchId;
    const nextDeptIds =
      departmentIds !== undefined
        ? normalizeDeptIds(departmentIds)
        : existing.departments.map((d) => d.departmentId);
    const willBeActive = isActive !== undefined ? isActive : existing.isActive;

    // Guard the one-per-slot rule whenever the rule stays/becomes active.
    if (willBeActive) {
      const conflict = await findDepartmentConflict(nextBranchId, nextDeptIds, id);
      if (conflict) {
        return res.status(409).json({ error: 'DUPLICATE_RULE', message: conflict });
      }
    }

    const data: any = {};
    if (signingLabInchargeId !== undefined) data.signingLabInchargeId = signingLabInchargeId;
    if (branchId !== undefined) data.branchId = branchId || null;
    if (displayOrder !== undefined) data.displayOrder = displayOrder;
    if (isActive !== undefined) data.isActive = isActive;
    if (departmentIds !== undefined) {
      // Replace the covered-department set.
      data.departments = {
        deleteMany: {},
        create: nextDeptIds.map((departmentId) => ({ departmentId })),
      };
    }

    const rule = await prisma.labInchargeRule.update({
      where: { id },
      data,
      include: ruleInclude,
    });

    return res.json(shapeRule(rule));
  } catch (error: any) {
    console.error('Error updating lab incharge rule:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: 'Failed to update lab incharge rule' });
  }
});

// ─── DELETE /api/lab-incharge-rules/:id ───────────────────────────
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.labInchargeRule.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Lab incharge rule not found' });
    }

    await prisma.labInchargeRule.delete({
      where: { id },
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
          where: { id: rule.id },
          data: { displayOrder: rule.displayOrder },
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
