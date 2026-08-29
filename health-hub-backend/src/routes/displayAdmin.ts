/**
 * Waiting-room Screens admin (owner only)
 *
 * Pair and manage the physical TVs for a branch. Creating a screen mints a
 * random `code`; the TV opens /display/<code> once and remembers it. Revoking a
 * screen kills that code (e.g. a lost device).
 */
import { Router } from 'express';
import crypto from 'crypto';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { emitCatalogChange } from '../lib/displayEvents';
import { slugify, branchSlug } from '../lib/displaySlug';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

function newCode(): string {
  // ~16 URL-safe chars — the code IS the display credential, so keep it random.
  return crypto.randomBytes(12).toString('base64url');
}

function clampHold(v: unknown, def: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(40, Math.max(8, n));
}

async function branchSlugFor(branchId: string): Promise<string> {
  const b = await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true, code: true } });
  return b ? branchSlug(b.name, b.code) : '';
}

/** A screen slug unique within its branch (append -2, -3, … on clash). */
async function uniqueSlug(branchId: string, base: string, excludeId?: string): Promise<string> {
  const root = slugify(base) || 'screen';
  let slug = root;
  let n = 1;
  while (
    await prisma.displayScreen.findFirst({
      where: { branchId, slug, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true },
    })
  ) {
    slug = `${root}-${++n}`;
  }
  return slug;
}

// GET / — screens for the active branch
router.get('/', async (req: AuthRequest, res) => {
  try {
    const screens = await prisma.displayScreen.findMany({
      where: { branchId: req.branchId! },
      orderBy: { createdAt: 'desc' },
    });
    const bSlug = await branchSlugFor(req.branchId!);
    const onlineFloor = Date.now() - 60_000; // seen within 60s = TV currently streaming
    return res.json(
      screens.map((s) => ({
        ...s,
        branchSlug: bSlug,
        online: !!s.lastSeenAt && s.lastSeenAt.getTime() >= onlineFloor,
      })),
    );
  } catch (err: any) {
    console.error('List display screens error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list screens' });
  }
});

// POST / — create + pair a new screen
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, scope, doctorIds, holdSeconds, showTrackQr, slug, chimeSound } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Screen name is required' });
    }
    const finalSlug = await uniqueSlug(
      req.branchId!,
      typeof slug === 'string' && slug.trim() ? slug : name,
    );
    const screen = await prisma.displayScreen.create({
      data: {
        branchId: req.branchId!,
        name: name.trim(),
        code: newCode(),
        slug: finalSlug,
        scope: scope === 'OP_IP' ? 'OP_IP' : 'OP',
        doctorIds: Array.isArray(doctorIds)
          ? doctorIds.filter((x: unknown) => typeof x === 'string')
          : [],
        holdSeconds: clampHold(holdSeconds, 18),
        showTrackQr: typeof showTrackQr === 'boolean' ? showTrackQr : true,
        chimeSound: chimeSound === 'none' ? 'none' : 'dingdong',
      },
    });
    const bSlug = await branchSlugFor(req.branchId!);
    if (req.branchId) emitCatalogChange(req.branchId, 'display-screens');
    return res.status(201).json({ ...screen, branchSlug: bSlug });
  } catch (err: any) {
    console.error('Create display screen error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create screen' });
  }
});

// PATCH /:id — rename / re-scope / re-pick doctors / enable-disable
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.displayScreen.findFirst({
      where: { id, branchId: req.branchId! },
    });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Screen not found' });

    const { name, scope, doctorIds, isActive, holdSeconds, showTrackQr, slug, chimeSound } = req.body || {};
    const data: Record<string, unknown> = {};
    if (typeof name === 'string' && name.trim()) data.name = name.trim();
    if (scope === 'OP' || scope === 'OP_IP') data.scope = scope;
    if (Array.isArray(doctorIds)) {
      data.doctorIds = doctorIds.filter((x: unknown) => typeof x === 'string');
    }
    if (typeof isActive === 'boolean') data.isActive = isActive;
    if (holdSeconds !== undefined) data.holdSeconds = clampHold(holdSeconds, existing.holdSeconds);
    if (typeof showTrackQr === 'boolean') data.showTrackQr = showTrackQr;
    if (typeof slug === 'string' && slug.trim()) data.slug = await uniqueSlug(req.branchId!, slug, id);
    if (chimeSound === 'dingdong' || chimeSound === 'none') data.chimeSound = chimeSound;

    const screen = await prisma.displayScreen.update({ where: { id }, data });
    const bSlug = await branchSlugFor(req.branchId!);
    if (req.branchId) emitCatalogChange(req.branchId, 'display-screens');
    return res.json({ ...screen, branchSlug: bSlug });
  } catch (err: any) {
    console.error('Update display screen error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update screen' });
  }
});

// POST /:id/revoke — unpair a lost / decommissioned TV (soft; kept for API compat)
router.post('/:id/revoke', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.displayScreen.findFirst({
      where: { id, branchId: req.branchId! },
    });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Screen not found' });

    const screen = await prisma.displayScreen.update({
      where: { id },
      data: { revokedAt: new Date(), isActive: false },
    });
    if (req.branchId) emitCatalogChange(req.branchId, 'display-screens');
    return res.json(screen);
  } catch (err: any) {
    console.error('Revoke display screen error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to revoke screen' });
  }
});

// DELETE /:id — permanently remove a screen (what "Unpair" does in the UI)
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.displayScreen.findFirst({
      where: { id, branchId: req.branchId! },
    });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Screen not found' });

    await prisma.displayScreen.delete({ where: { id } });
    if (req.branchId) emitCatalogChange(req.branchId, 'display-screens');
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('Delete display screen error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to remove screen' });
  }
});

export default router;
