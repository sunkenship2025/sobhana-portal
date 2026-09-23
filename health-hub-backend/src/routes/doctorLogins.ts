/**
 * Owner-only: give a consulting doctor a login, and hold their signature.
 *
 * WHY THIS IS NOT THE ROLES PANEL
 * The Roles panel adds a person to the team. This adds a login to a
 * ClinicDoctor that already exists — a different act with a different primary
 * key, and the join has to be exact: `ClinicDoctor.userId` is UNIQUE because a
 * prescription signature must be attributable to one human. Doing it through a
 * generic "add a user" form would leave the two records unlinked, and an
 * unlinked doctor login is a dead end.
 *
 * WHY THERE IS NO SIGNING RULE HERE
 * SigningRule answers "which doctor signs this DEPARTMENT's reports", because a
 * pathology report has no inherent author. A prescription already knows its
 * author: the ClinicDoctor on the visit. A rule layer would let configuration
 * contradict reality — naming Dr A while Dr B actually signed — and on a
 * document carrying a registration number that is the one failure worth
 * designing out. So this is a list, not a rule editor.
 */
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { logAction } from '../services/auditService';
import { deriveLogin, generatePassword } from '../lib/portalCredentials';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

/** Never returns commission or consultation fee — see doctorPortal.ts. */
const SELECT = {
  id: true, doctorNumber: true, name: true, qualification: true, specialty: true,
  registrationNumber: true, phone: true, email: true, letterheadNote: true,
  signatureImageBase64: true, hprId: true, isActive: true, userId: true,
  user: { select: { id: true, email: true, isActive: true, role: true, portalInviteAt: true } },
} as const;

// ---------------------------------------------------------------------------
// GET /api/doctor-logins — every consulting doctor, with login + signature state
// ---------------------------------------------------------------------------
router.get('/', async (_req: AuthRequest, res) => {
  try {
    const rows = await prisma.clinicDoctor.findMany({
      where: { isActive: true },
      orderBy: { name: 'asc' },
      select: SELECT,
    });
    res.json(
      rows.map((d) => ({
        id: d.id,
        doctorNumber: d.doctorNumber,
        name: d.name,
        qualification: d.qualification,
        specialty: d.specialty,
        registrationNumber: d.registrationNumber,
        phone: d.phone,
        hprId: d.hprId,
        hasSignature: !!d.signatureImageBase64,
        login: d.user ? { id: d.user.id, email: d.user.email, isActive: d.user.isActive, role: d.user.role } : null,
      })),
    );
  } catch (err) {
    logger.error({ err }, 'doctorLogins: list failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Failed to load consulting doctors' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/doctor-logins/:id — create a login for this doctor and link it
//
// The password is returned ONCE, here, and never again — only the bcrypt hash is
// stored. The owner conveys it however they choose. (When the WhatsApp portal
// invite lands, this is where sendPortalInvite hooks in; the derived-login shape
// is already shared with it via portalCredentials so the two cannot drift.)
// ---------------------------------------------------------------------------
router.post('/:id', async (req: AuthRequest, res) => {
  try {
    const doctor = await prisma.clinicDoctor.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, userId: true, registrationNumber: true, isActive: true },
    });
    if (!doctor) { res.status(404).json({ error: 'NOT_FOUND', message: 'Doctor not found' }); return; }
    if (doctor.userId) { res.status(409).json({ error: 'ALREADY_LINKED', message: 'This doctor already has a login' }); return; }
    if (!doctor.isActive) { res.status(409).json({ error: 'INACTIVE', message: 'This doctor is not active' }); return; }
    if (!doctor.registrationNumber) {
      // A doctor cannot sign a prescription without one, so a login would be
      // useless. Say so now rather than at the moment they try to sign.
      res.status(409).json({
        error: 'NO_REGISTRATION',
        message: 'Add a registration number first — every prescription must carry it.',
      });
      return;
    }

    const existing = await prisma.user.findMany({ select: { email: true }, orderBy: { createdAt: 'asc' } });
    const email = deriveLogin(doctor.name, existing.map((u) => u.email));
    const password = generatePassword(doctor.name);

    const user = await prisma.$transaction(async (tx) => {
      const created = await tx.user.create({
        data: {
          email,
          name: doctor.name,
          role: 'doctor',
          passwordHash: await bcrypt.hash(password, 10),
          activeBranchId: req.branchId!,
          isActive: true,
        },
        select: { id: true, email: true },
      });
      await tx.clinicDoctor.update({ where: { id: doctor.id }, data: { userId: created.id } });
      return created;
    });

    await logAction({
      branchId: req.branchId!,
      actionType: 'CREATE',
      entityType: 'User',
      entityId: user.id,
      userId: req.user!.id,
      // The password is never written to the audit log, only the fact of creation.
      newValues: { email: user.email, role: 'doctor', linkedClinicDoctorId: doctor.id },
    });

    res.status(201).json({ login: { id: user.id, email: user.email }, password });
  } catch (err) {
    logger.error({ err }, 'doctorLogins: create failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not create the login' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/doctor-logins/:id/reset — new password for an existing login
// ---------------------------------------------------------------------------
router.post('/:id/reset', async (req: AuthRequest, res) => {
  try {
    const doctor = await prisma.clinicDoctor.findUnique({
      where: { id: req.params.id },
      select: { id: true, name: true, userId: true },
    });
    if (!doctor?.userId) { res.status(404).json({ error: 'NOT_FOUND', message: 'This doctor has no login' }); return; }

    const password = generatePassword(doctor.name);
    await prisma.user.update({
      where: { id: doctor.userId },
      data: { passwordHash: await bcrypt.hash(password, 10) },
    });

    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'User',
      entityId: doctor.userId,
      userId: req.user!.id,
      newValues: { passwordReset: true, clinicDoctorId: doctor.id },
    });

    res.json({ password });
  } catch (err) {
    logger.error({ err }, 'doctorLogins: reset failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not reset the password' });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/doctor-logins/:id — revoke access, keep the doctor and their work
//
// Deactivates the login and unlinks it. Signed prescriptions are untouched:
// they render from a frozen snapshot, so a doctor who leaves still has correctly
// rendering prescriptions in every patient's history.
// ---------------------------------------------------------------------------
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const doctor = await prisma.clinicDoctor.findUnique({
      where: { id: req.params.id },
      select: { id: true, userId: true },
    });
    if (!doctor?.userId) { res.status(404).json({ error: 'NOT_FOUND', message: 'This doctor has no login' }); return; }

    await prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id: doctor.userId! }, data: { isActive: false } });
      await tx.clinicDoctor.update({ where: { id: doctor.id }, data: { userId: null } });
    });

    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'ClinicDoctor',
      entityId: doctor.id,
      userId: req.user!.id,
      oldValues: { userId: doctor.userId },
      newValues: { userId: null, loginDeactivated: true },
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'doctorLogins: revoke failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not revoke the login' });
  }
});

// ---------------------------------------------------------------------------
// PATCH /api/doctor-logins/:id/signature — owner sets a doctor's signature
// Same base64 shape and same cleanup pipeline as SigningDoctor.
// ---------------------------------------------------------------------------
router.patch('/:id/signature', async (req: AuthRequest, res) => {
  try {
    const value = req.body?.signatureImageBase64;
    if (typeof value !== 'string' && value !== null) {
      res.status(400).json({ error: 'BAD_REQUEST', message: 'signatureImageBase64 must be a data URI or null' });
      return;
    }
    await prisma.clinicDoctor.update({
      where: { id: req.params.id },
      data: { signatureImageBase64: value },
    });
    await logAction({
      branchId: req.branchId!,
      actionType: 'UPDATE',
      entityType: 'ClinicDoctor',
      entityId: req.params.id,
      userId: req.user!.id,
      newValues: { signature: value ? 'set' : 'removed' },
    });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'doctorLogins: signature failed');
    res.status(500).json({ error: 'SERVER_ERROR', message: 'Could not save the signature' });
  }
});

export default router;
