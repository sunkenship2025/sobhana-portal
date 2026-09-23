import { Router } from 'express';
import { UserRole } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';
import { branchContextMiddleware } from '../middleware/branch';
import { logAction } from '../services/auditService';
import prisma from '../lib/prisma';
import { emitCatalogChange } from '../lib/displayEvents';
import { invalidateAuthUser } from '../middleware/branch';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { sendPortalInvite } from '../services/notificationService';
import { deriveLogin, activationPatch } from '../lib/portalCredentials';

const router = Router();

// User management is owner-only. Owners manage the whole team, so this is
// intentionally global (not branch-scoped).
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

// Roles an owner is allowed to assign through this panel. `doctor`/`admin` are
// legacy roles that are not assignable from the Roles UI. `owner` IS assignable
// now — the portal has to be able to hand somebody full access without us running
// psql — but every path that could leave it with nobody in charge is guarded by
// lastOwnerGuard below.
const ASSIGNABLE_ROLES: UserRole[] = ['staff', 'lab_incharge', 'sales', 'owner'];

/**
 * Refuse anything that would remove the final active owner.
 *
 * Without this, demoting or deactivating the last owner locks everyone out of
 * user management permanently: this screen is owner-only, so there is nobody left
 * who can put it right, and recovery means psql against prod.
 */
async function lastOwnerGuard(targetId: string): Promise<string | null> {
  const owners = await prisma.user.count({ where: { role: 'owner', isActive: true } });
  if (owners > 1) return null;
  const target = await prisma.user.findUnique({
    where: { id: targetId },
    select: { role: true, isActive: true },
  });
  if (target?.role === 'owner' && target.isActive) {
    return 'This is the only active owner — make somebody else an owner first';
  }
  return null;
}

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
        // Non-null = invited, hasn't replied yet. The card says so, and Resend
        // uses it to tell an unanswered invite apart from a password reset.
        portalInviteAt: true,
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
// POST /api/users — add a team member (owner only)
// Body: { name, phone, role? }
//
// The login is DERIVED, not typed: <firstname>@sobhana.com, which is the shape
// every account in this database already has — "Dileep Kumar" becomes
// dileep@sobhana.com. The password is generated in the same shape every time
// (Dileep@1234) and sent to the person's WhatsApp, because it is never
// recoverable afterwards — only the bcrypt hash is kept.
// ===========================================================================
router.post('/', async (req: AuthRequest, res) => {
  try {
    const b = (req.body ?? {}) as { name?: string; phone?: string; role?: UserRole };
    const name = String(b.name ?? '').trim();
    // Digits only. The invite reply is matched by the LAST TEN DIGITS of the
    // inbound number, and Prisma's endsWith is a literal string compare — so a
    // number typed "98491 16358" or "+91 98491 16358" would never match
    // "919849116358", and the person would get the generic auto-reply instead of
    // their credentials.
    const phone = String(b.phone ?? '').replace(/\D/g, '');
    const role: UserRole = b.role && ASSIGNABLE_ROLES.includes(b.role) ? b.role : 'staff';

    if (name.length < 2) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Enter their full name' });
    }
    if (!/^[0-9]{10,15}$/.test(phone)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Enter a valid mobile number — the sign-in details are sent there',
      });
    }

    // Every account needs a home branch. Prefer the branch the operator is
    // working in; fall back to the oldest active one.
    const branch =
      (req.branchId
        ? await prisma.branch.findUnique({ where: { id: req.branchId }, select: { id: true, code: true } })
        : null) ??
      (await prisma.branch.findFirst({
        where: { isActive: true },
        select: { id: true, code: true },
        orderBy: { createdAt: 'asc' },
      }));
    if (!branch) {
      return res.status(400).json({ error: 'NO_BRANCH', message: 'There is no active branch to attach the login to' });
    }

    // Inherit the domain the portal already uses rather than hard-coding it, so a
    // rename never splits the team across two. Earliest account wins.
    const existing = await prisma.user.findMany({
      select: { email: true },
      orderBy: { createdAt: 'asc' },
    });
    // Two people called Anusha must not collide into one login — which is why
    // anusha2@sobhana.com already exists, put there by hand. deriveLogin is that
    // same rule, written down. See portal-credentials-check.ts, which replays
    // every account already in this database through it.
    const email = deriveLogin(name, existing.map((u) => u.email));

    // No password yet. It is generated when they reply and the 24h window opens,
    // so an unanswered invite leaves no credential sitting anywhere. Until then the
    // hash is random and unusable — the account exists but cannot be signed into.
    const user = await prisma.user.create({
      data: {
        email,
        name,
        phone,
        role,
        activeBranchId: branch.id,
        isActive: true,
        portalInviteAt: new Date(),
        passwordHash: await bcrypt.hash(randomUUID(), 10),
      },
      select: {
        id: true, name: true, email: true, role: true, phone: true, isActive: true,
        portalInviteAt: true, activeBranch: { select: { id: true, name: true } },
      },
    });

    await logAction({
      branchId: branch.id,
      actionType: 'CREATE',
      entityType: 'User',
      entityId: user.id,
      userId: req.user?.id!,
      // The generated password is deliberately absent: the audit log is one of the
      // places it would otherwise sit in plaintext forever.
      newValues: { role, email, name },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    // Delivery is reported, never assumed.
    const delivery = await sendPortalInvite({ userId: user.id, name, phone, branchId: branch.id });

    if (req.branchId) emitCatalogChange(req.branchId, 'users');
    return res.status(201).json({ data: user, invite: delivery });
  } catch (err) {
    console.error('Create user error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to add the team member' });
  }
});

// ===========================================================================
// POST /api/users/:id/invite — send (or resend) the WhatsApp invite (owner only)
//
// Also the forgotten-password path: the reply mints a FRESH password and
// overwrites the hash, so there is no separate "reset" to keep in step. Their
// current password keeps working until they actually reply, and the new one
// reaches them on the same message — so this rotates, it never locks anyone out.
// ===========================================================================
router.post('/:id/invite', async (req: AuthRequest, res) => {
  try {
    const target = await prisma.user.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, phone: true, isActive: true, activeBranchId: true },
    });
    if (!target) return res.status(404).json({ error: 'NOT_FOUND', message: 'No such team member' });
    if (!target.isActive) {
      return res.status(400).json({ error: 'INACTIVE', message: 'Reactivate them before sending an invite' });
    }
    if (!target.phone) {
      return res.status(400).json({ error: 'NO_PHONE', message: 'They have no mobile number on file to send to' });
    }

    await prisma.user.update({ where: { id: target.id }, data: { portalInviteAt: new Date() } });
    const delivery = await sendPortalInvite({
      userId: target.id,
      name: target.name,
      phone: target.phone,
      branchId: target.activeBranchId,
    });

    await logAction({
      branchId: target.activeBranchId,
      actionType: 'UPDATE',
      entityType: 'User',
      entityId: target.id,
      userId: req.user?.id!,
      newValues: { portalInvite: 'sent', delivered: delivery.success },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (req.branchId) emitCatalogChange(req.branchId, 'users');
    return res.json({ invite: delivery });
  } catch (err) {
    console.error('Resend invite error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to send the invite' });
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

    // An owner may now be demoted — access has to be revocable from the UI — but
    // never the last one, or nobody can reach this screen again.
    if (target.role === 'owner') {
      const blocked = await lastOwnerGuard(target.id);
      if (blocked) return res.status(400).json({ error: 'LAST_OWNER', message: blocked });
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

    // Same rule on deactivation: allowed, unless it would remove the last owner.
    if (target.role === 'owner' && isActive === false) {
      const blocked = await lastOwnerGuard(target.id);
      if (blocked) return res.status(400).json({ error: 'LAST_OWNER', message: blocked });
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
      data: activationPatch(isActive),
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

// ===========================================================================
// DELETE /api/users/:id — undo a mistyped name (owner only)
//
// Deactivating is the right answer for somebody who has left: their row is
// referenced by the work they did. But it was the ONLY answer, and that made a
// typo permanent — the login is derived from the name and there is no email
// edit, so "Anuhs" would sit in the list forever AND hold `anuhs` reserved.
//
// The window is deliberately narrow: only while the invite is still unanswered.
// Such a member has never had a usable password (the hash is a random UUID), so
// they cannot have entered a result or collected a payment — which matters,
// because seven of the eleven User foreign keys are SetNull, and Postgres would
// erase who did that work without a word rather than refuse the delete. Tying
// the gate to "never signed in" instead of a list of relations means a column
// added next month cannot quietly fall outside it.
// ===========================================================================
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const target = await prisma.user.findUnique({
      where: { id },
      select: { id: true, name: true, email: true, role: true, portalInviteAt: true },
    });
    if (!target) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'User not found' });
    }
    if (target.id === req.user?.id) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'You cannot remove your own account' });
    }
    if (!target.portalInviteAt) {
      return res.status(409).json({
        error: 'HAS_SIGNED_IN',
        message: `${target.name} has already been given their sign-in details. Deactivate them instead — removing the account could erase who entered their results and who authorised their discounts.`,
      });
    }

    await prisma.user.delete({ where: { id } });
    await invalidateAuthUser(id);

    await logAction({
      branchId: req.branchId!,
      actionType: 'DELETE',
      entityType: 'User',
      entityId: target.id,
      userId: req.user?.id!,
      oldValues: { name: target.name, email: target.email, role: target.role },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    if (req.branchId) emitCatalogChange(req.branchId, 'users');
    return res.json({ data: { id: target.id, email: target.email } });
  } catch (err) {
    console.error('Delete user error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to remove the team member' });
  }
});

export default router;
