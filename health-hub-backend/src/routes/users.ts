import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { branchContextMiddleware } from '../middleware/branch';
import { logAction } from '../services/auditService';
import prisma from '../lib/prisma';
import { emitCatalogChange } from '../lib/displayEvents';
import { invalidateAuthUser } from '../middleware/branch';

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
        phone: true,
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
// PATCH /api/users/:id/phone — set a member's WhatsApp number (owner only)
// Body: { phone: string | null }  — 10 digits, or null to clear.
//
// The column existed from the start but nothing ever wrote it, so every user
// had phone = null. Automated messages send to the OWNER's number, so this is
// where that number comes from.
// ===========================================================================
router.patch('/:id/phone', async (req: AuthRequest, res) => {
  try {
    const raw = (req.body as { phone?: string | null })?.phone;
    let phone: string | null = null;
    if (raw !== null && raw !== undefined && String(raw).trim() !== '') {
      // Accept what people actually type — spaces, +91, hyphens — and store the
      // bare 10 digits, which is what formatPhoneForWhatsApp expects.
      const digits = String(raw).replace(/\D/g, '').replace(/^91(?=\d{10}$)/, '');
      if (digits.length !== 10) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'Enter a 10-digit mobile number',
        });
      }
      phone = digits;
    }

    const existing = await prisma.user.findUnique({ where: { id: req.params.id }, select: { phone: true } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { phone },
      select: { id: true, name: true, email: true, role: true, phone: true, isActive: true },
    });
    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'User',
      entityId: user.id,
      userId: req.user?.id,
      oldValues: { phone: existing.phone },
      newValues: { phone },
    });
    invalidateAuthUser(user.id);
    return res.json({ data: user });
  } catch (err) {
    console.error('Update user phone error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update phone' });
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
    // branchContextMiddleware caches this row for 60s; drop it so a demotion
    // binds on the next request rather than at TTL expiry.
    await invalidateAuthUser(id);

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

    if (req.branchId) emitCatalogChange(req.branchId, 'users');
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
    // Disabling an account must lock it out NOW, not in 60s.
    await invalidateAuthUser(id);

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

    if (req.branchId) emitCatalogChange(req.branchId, 'users');
    return res.json({ data: updated });
  } catch (err) {
    console.error('Update user active error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update account status' });
  }
});

export default router;
