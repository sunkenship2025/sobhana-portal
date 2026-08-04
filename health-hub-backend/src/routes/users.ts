import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { branchContextMiddleware } from '../middleware/branch';
import { logAction } from '../services/auditService';
import prisma from '../lib/prisma';

const router = Router();

// User management is owner-only. Owners manage the whole team, so this is
// intentionally global (not branch-scoped).
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

// Roles an owner is allowed to assign through this panel. The `owner` role is
// locked (an owner can never be created or demoted here), and `doctor`/`admin`
// are legacy roles that are not assignable from the Roles UI.
const ASSIGNABLE_ROLES: UserRole[] = ['staff', 'lab_incharge', 'sales'];

// ===========================================================================
// GET /api/users — list team members (owner only)
// ===========================================================================
router.get('/', async (_req: AuthRequest, res) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isActive: true,
        activeBranch: { select: { id: true, name: true } },
      },
    });
    return res.json({ data: users });
  } catch (err) {
    console.error('List users error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list users' });
  }
});

// ===========================================================================
// PATCH /api/users/:id/role — change a member's role (owner only)
// Body: { role: 'staff' | 'lab_incharge' | 'sales' }
// ===========================================================================
router.patch('/:id/role', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body as { role?: UserRole };

    if (!role || !ASSIGNABLE_ROLES.includes(role)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: `role must be one of: ${ASSIGNABLE_ROLES.join(', ')}`,
      });
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true },
    });
    if (!target) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
    }

    // The owner role is locked — it can neither be assigned nor changed here.
    if (target.role === 'owner') {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'The owner role cannot be changed',
      });
    }

    if (target.role === role) {
      return res.json({ data: { id: target.id, role } });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { role },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });

    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'User',
      entityId: updated.id,
      userId: req.user?.id!,
      oldValues: { role: target.role },
      newValues: { role },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ data: updated });
  } catch (err) {
    console.error('Update user role error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update role' });
  }
});

// ===========================================================================
// PATCH /api/users/:id/active — deactivate / reactivate a member (owner only)
// Body: { isActive: boolean }
// A deactivated account is blocked at login and rejected on every request
// (see authService.login + branchContextMiddleware), so this fully revokes
// access. It is reversible and preserves the user's history — we never delete
// the row, because it is referenced by visits, reports, payouts and the audit
// trail.
// ===========================================================================
router.patch('/:id/active', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body as { isActive?: boolean };

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'isActive must be a boolean',
      });
    }

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, role: true, isActive: true },
    });
    if (!target) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
    }

    // The owner account is locked — it can never be deactivated here.
    if (target.role === 'owner') {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'The owner account cannot be deactivated',
      });
    }

    // An owner can't lock themselves out of the portal.
    if (target.id === req.user?.id) {
      return res.status(403).json({
        error: 'FORBIDDEN',
        message: 'You cannot deactivate your own account',
      });
    }

    if (target.isActive === isActive) {
      return res.json({ data: { id: target.id, isActive } });
    }

    const updated = await prisma.user.update({
      where: { id },
      data: { isActive },
      select: { id: true, name: true, email: true, role: true, isActive: true },
    });

    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'User',
      entityId: updated.id,
      userId: req.user?.id!,
      oldValues: { isActive: target.isActive },
      newValues: { isActive },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ data: updated });
  } catch (err) {
    console.error('Update user active error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update account status' });
  }
});

export default router;
