import { Router, Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { generateNextNumber } from '../services/numberService';
import prisma from '../lib/prisma';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── GET / — List all diagnostic referral centers ────────────────
router.get('/', async (req: Request, res: Response) => {
  try {
    const { includeInactive, search } = req.query;

    const where: any = {};
    if (!includeInactive) {
      where.isActive = true;
    }
    if (search && typeof search === 'string') {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { centerNumber: { contains: search, mode: 'insensitive' } },
        { contactPerson: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
      ];
    }

    const centers = await prisma.diagnosticReferralCenter.findMany({
      where,
      include: {
        _count: { select: { visitReferrals: true, payoutLedger: true } }
      },
      orderBy: { name: 'asc' }
    });

    return res.json(centers);
  } catch (error) {
    console.error('Error fetching diagnostic centers:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch diagnostic centers' });
  }
});

// ─── GET /:id — Get a single diagnostic center with details ─────
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const center = await prisma.diagnosticReferralCenter.findUnique({
      where: { id: req.params.id },
      include: {
        visitReferrals: {
          take: 20,
          orderBy: { createdAt: 'desc' },
          include: {
            visit: { select: { id: true, billNumber: true, createdAt: true } },
            branch: { select: { id: true, name: true } }
          }
        },
        _count: { select: { visitReferrals: true, payoutLedger: true } }
      }
    });

    if (!center) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Diagnostic center not found' });
    }

    return res.json(center);
  } catch (error) {
    console.error('Error fetching diagnostic center:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to fetch diagnostic center' });
  }
});

// ─── POST / — Create a new diagnostic referral center ────────────
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, contactPerson, phone, email, address, commissionPercent } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Center name is required' });
    }

    // Check duplicate name
    const existing = await prisma.diagnosticReferralCenter.findFirst({
      where: { name: { equals: name.trim(), mode: 'insensitive' } }
    });
    if (existing) {
      return res.status(409).json({ error: 'DUPLICATE', message: `Diagnostic center "${name.trim()}" already exists` });
    }

    // Validate commission percent
    const commission = commissionPercent !== undefined ? parseFloat(commissionPercent) : 0;
    if (isNaN(commission) || commission < 0 || commission > 100) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Commission percent must be between 0 and 100' });
    }

    // Auto-generate center number
    const centerNumber = await generateNextNumber('diagnosticCenter', 'DC');

    const center = await prisma.diagnosticReferralCenter.create({
      data: {
        name: name.trim(),
        centerNumber,
        contactPerson: contactPerson?.trim() || null,
        phone: phone?.trim() || null,
        email: email?.trim() || null,
        address: address?.trim() || null,
        commissionPercent: commission,
      }
    });

    return res.status(201).json(center);
  } catch (error) {
    console.error('Error creating diagnostic center:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create diagnostic center' });
  }
});

// ─── PATCH /:id — Update a diagnostic referral center ────────────
router.patch('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await prisma.diagnosticReferralCenter.findUnique({
      where: { id: req.params.id }
    });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Diagnostic center not found' });
    }

    const { name, contactPerson, phone, email, address, commissionPercent, isActive } = req.body;
    const updateData: any = {};

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Center name cannot be empty' });
      }
      // Check duplicate name excluding self
      const dup = await prisma.diagnosticReferralCenter.findFirst({
        where: {
          name: { equals: name.trim(), mode: 'insensitive' },
          id: { not: req.params.id }
        }
      });
      if (dup) {
        return res.status(409).json({ error: 'DUPLICATE', message: `Diagnostic center "${name.trim()}" already exists` });
      }
      updateData.name = name.trim();
    }

    if (contactPerson !== undefined) updateData.contactPerson = contactPerson?.trim() || null;
    if (phone !== undefined) updateData.phone = phone?.trim() || null;
    if (email !== undefined) updateData.email = email?.trim() || null;
    if (address !== undefined) updateData.address = address?.trim() || null;

    if (commissionPercent !== undefined) {
      const commission = parseFloat(commissionPercent);
      if (isNaN(commission) || commission < 0 || commission > 100) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Commission percent must be between 0 and 100' });
      }
      updateData.commissionPercent = commission;
    }

    if (typeof isActive === 'boolean') updateData.isActive = isActive;

    const updated = await prisma.diagnosticReferralCenter.update({
      where: { id: req.params.id },
      data: updateData
    });

    return res.json(updated);
  } catch (error) {
    console.error('Error updating diagnostic center:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update diagnostic center' });
  }
});

// ─── DELETE /:id — Soft-delete a diagnostic referral center ──────
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const existing = await prisma.diagnosticReferralCenter.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { visitReferrals: true } } }
    });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Diagnostic center not found' });
    }

    await prisma.diagnosticReferralCenter.update({
      where: { id: req.params.id },
      data: { isActive: false }
    });

    return res.json({
      id: req.params.id,
      message: 'Diagnostic center deactivated',
      linkedVisitCount: existing._count.visitReferrals
    });
  } catch (error) {
    console.error('Error deleting diagnostic center:', error);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete diagnostic center' });
  }
});

export default router;
