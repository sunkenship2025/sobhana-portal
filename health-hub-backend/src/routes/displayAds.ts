/**
 * Waiting-room Ad CMS (owner only)
 *
 * Uploaded creatives shown on the display when idle. Three kinds:
 *   IMAGE      — one photo, held for durationSec
 *   VIDEO      — one MP4/WebM, plays to its end
 *   SLIDESHOW  — several photos cycled, durationSec each
 *
 * Media is stored in R2 (keys on the row) and streamed to the TV via the public
 * display route. Uploads are held in memory only transiently (multer memory),
 * so caps are enforced to protect the 512MB instance.
 */
import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import { requireRole } from '../middleware/rbac';
import prisma from '../lib/prisma';
import { putObject, deleteObjects } from '../services/r2StorageService';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const VIDEO_MIMES = ['video/mp4', 'video/webm'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 45 * 1024 * 1024, files: 12 }, // 45MB/file cap; keep signage videos short
});

function extFor(mime: string): string {
  return (
    {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'video/mp4': '.mp4',
      'video/webm': '.webm',
    } as Record<string, string>
  )[mime] || '';
}

function clampInt(v: unknown, def: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ''), 10);
  if (Number.isNaN(n)) return def;
  return Math.min(max, Math.max(min, n));
}

function parseDate(v: unknown): Date | null {
  if (!v || typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function shape(ad: {
  id: string;
  name: string;
  kind: string;
  mediaKeys: string[];
  mimeTypes: string[];
  screenIds: string[];
  fit: string;
  durationSec: number;
  enabled: boolean;
  weight: number;
  sortOrder: number;
  startDate: Date | null;
  endDate: Date | null;
}) {
  return {
    id: ad.id,
    name: ad.name,
    kind: ad.kind,
    fit: ad.fit,
    durationSec: ad.durationSec,
    enabled: ad.enabled,
    weight: ad.weight,
    sortOrder: ad.sortOrder,
    screenIds: ad.screenIds,
    startDate: ad.startDate,
    endDate: ad.endDate,
    media: ad.mediaKeys.map((_k, i) => ({
      index: i,
      mimeType: ad.mimeTypes[i] || 'application/octet-stream',
      path: `/display/ads/media/${ad.id}/${i}`, // public, relative to API base
    })),
  };
}

// GET / — ads for the active branch
router.get('/', async (req: AuthRequest, res) => {
  try {
    const ads = await prisma.displayAd.findMany({
      where: { branchId: req.branchId! },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    return res.json(ads.map(shape));
  } catch (err: any) {
    console.error('List display ads error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to list ads' });
  }
});

// POST / — create an ad (multipart: files[] + fields)
router.post('/', upload.array('files', 12), async (req: AuthRequest, res) => {
  try {
    const files = (req.files as Express.Multer.File[]) || [];
    const name = String(req.body.name || '').trim();
    const kind = String(req.body.kind || 'IMAGE').toUpperCase();
    const fit = req.body.fit === 'contain' ? 'contain' : 'cover';
    const durationSec = clampInt(req.body.durationSec, 10, 3, 60);
    const weight = clampInt(req.body.weight, 1, 1, 10);
    const startDate = parseDate(req.body.startDate);
    const endDate = parseDate(req.body.endDate);
    let screenIds: string[] = [];
    try {
      const parsed = JSON.parse(req.body.screenIds || '[]');
      if (Array.isArray(parsed)) screenIds = parsed.filter((x) => typeof x === 'string');
    } catch {
      screenIds = [];
    }

    if (!name) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Name is required' });
    if (!files.length) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'At least one file is required' });
    if (!['IMAGE', 'VIDEO', 'SLIDESHOW'].includes(kind)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid ad kind' });
    }

    if (kind === 'IMAGE' && (files.length !== 1 || !IMAGE_MIMES.includes(files[0].mimetype))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Photo ad needs exactly one image (PNG/JPG/WebP)' });
    }
    if (kind === 'VIDEO' && (files.length !== 1 || !VIDEO_MIMES.includes(files[0].mimetype))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Video ad needs exactly one MP4/WebM' });
    }
    if (kind === 'SLIDESHOW' && !files.every((f) => IMAGE_MIMES.includes(f.mimetype))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Slideshow accepts images only (PNG/JPG/WebP)' });
    }

    const folder = crypto.randomBytes(8).toString('hex');
    const mediaKeys: string[] = [];
    const mimeTypes: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const key = `display-ads/${req.branchId}/${folder}/${i}${extFor(f.mimetype)}`;
      await putObject({ key, body: f.buffer, contentType: f.mimetype });
      mediaKeys.push(key);
      mimeTypes.push(f.mimetype);
    }

    const count = await prisma.displayAd.count({ where: { branchId: req.branchId! } });
    const ad = await prisma.displayAd.create({
      data: {
        branchId: req.branchId!,
        name,
        kind,
        mediaKeys,
        mimeTypes,
        screenIds,
        fit,
        durationSec,
        weight,
        sortOrder: count,
        startDate,
        endDate,
      },
    });

    return res.status(201).json(shape(ad));
  } catch (err: any) {
    console.error('Create display ad error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to create ad' });
  }
});

// PATCH /:id — metadata only (not media)
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.displayAd.findFirst({ where: { id, branchId: req.branchId! } });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Ad not found' });

    const data: Record<string, unknown> = {};
    if (typeof req.body.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim();
    if (req.body.fit === 'cover' || req.body.fit === 'contain') data.fit = req.body.fit;
    if (typeof req.body.enabled === 'boolean') data.enabled = req.body.enabled;
    if (req.body.durationSec !== undefined) data.durationSec = clampInt(req.body.durationSec, existing.durationSec, 3, 60);
    if (req.body.weight !== undefined) data.weight = clampInt(req.body.weight, existing.weight, 1, 10);
    if (req.body.sortOrder !== undefined) data.sortOrder = clampInt(req.body.sortOrder, existing.sortOrder, 0, 9999);
    if ('startDate' in req.body) data.startDate = parseDate(req.body.startDate);
    if ('endDate' in req.body) data.endDate = parseDate(req.body.endDate);
    if (Array.isArray(req.body.screenIds)) {
      data.screenIds = req.body.screenIds.filter((x: unknown) => typeof x === 'string');
    }

    const ad = await prisma.displayAd.update({ where: { id }, data });
    return res.json(shape(ad));
  } catch (err: any) {
    console.error('Update display ad error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update ad' });
  }
});

// DELETE /:id — remove ad + its R2 media
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.displayAd.findFirst({ where: { id, branchId: req.branchId! } });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Ad not found' });

    await deleteObjects(existing.mediaKeys);
    await prisma.displayAd.delete({ where: { id } });
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('Delete display ad error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete ad' });
  }
});

export default router;
