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
import { emitCatalogChange } from '../lib/displayEvents';
import { putObject, deleteObjects } from '../services/r2StorageService';

const router = Router();
router.use(authMiddleware);
router.use(branchContextMiddleware);
router.use(requireRole('owner'));

// Ad media lives in a dedicated PUBLIC bucket when configured, so it can be served
// straight from R2/CDN without ever exposing the private report bucket. Undefined
// falls back to the default (private) bucket + backend proxy.
const ADS_BUCKET = process.env.R2_PUBLIC_BUCKET || undefined;

const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];
const VIDEO_MIMES = ['video/mp4', 'video/webm'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024, files: 8 }, // 25MB/file x8 cap: memoryStorage buffers whole files in RAM, so worst-case (~200MB) must stay well under the 512MB box. Keep signage videos short.
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
      await putObject({ key, body: f.buffer, contentType: f.mimetype, bucket: ADS_BUCKET });
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

    if (req.branchId) emitCatalogChange(req.branchId, 'display-ads');
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
    if (req.branchId) emitCatalogChange(req.branchId, 'display-ads');
    return res.json(shape(ad));
  } catch (err: any) {
    console.error('Update display ad error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update ad' });
  }
});

// PUT /:id/media — rebuild an image/slideshow ad's slide list (+ metadata) in one save.
// Multipart body:
//   slides  JSON array of tokens, in final display order: "<idx>" keeps the existing
//           slide at that index, "new" consumes the next uploaded file.
//   files[] new images, in the order their "new" tokens appear.
//   plus optional name / fit / durationSec / weight / screenIds.
// Reorder keeps the same R2 keys, so with R2_PUBLIC_URL (CDN, per-key URLs) the TV
// shows the new order immediately. ponytail: proxy-fallback path is index-keyed, so a
// reorder can serve stale bytes for up to the 1h media cache when R2_PUBLIC_URL is unset.
router.put('/:id/media', upload.array('files', 12), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.displayAd.findFirst({ where: { id, branchId: req.branchId! } });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Ad not found' });
    if (existing.kind === 'VIDEO') return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Videos have no slides to edit' });

    const files = (req.files as Express.Multer.File[]) || [];
    if (!files.every((f) => IMAGE_MIMES.includes(f.mimetype))) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Slides must be images (PNG/JPG/WebP)' });
    }
    let tokens: unknown;
    try { tokens = JSON.parse(req.body.slides || '[]'); } catch { tokens = []; }
    if (!Array.isArray(tokens) || tokens.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Keep at least one slide (delete the ad to remove it entirely)' });
    }

    const folder = crypto.randomBytes(8).toString('hex');
    const newKeys: string[] = [];
    const newMimes: string[] = [];
    let cursor = 0;
    for (const t of tokens) {
      if (t === 'new') {
        const f = files[cursor++];
        if (!f) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Slide/file mismatch' });
        const key = `display-ads/${req.branchId}/${folder}/${crypto.randomBytes(6).toString('hex')}${extFor(f.mimetype)}`;
        await putObject({ key, body: f.buffer, contentType: f.mimetype, bucket: ADS_BUCKET });
        newKeys.push(key);
        newMimes.push(f.mimetype);
      } else {
        const i = parseInt(String(t), 10);
        if (Number.isNaN(i) || i < 0 || i >= existing.mediaKeys.length) {
          return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Bad slide reference' });
        }
        newKeys.push(existing.mediaKeys[i]);
        newMimes.push(existing.mimeTypes[i]);
      }
    }
    if (cursor !== files.length) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Some uploaded files were not placed' });

    const kept = new Set(newKeys);
    const dropped = existing.mediaKeys.filter((k) => !kept.has(k));
    if (dropped.length) await deleteObjects(dropped, ADS_BUCKET).catch(() => {});

    const data: Record<string, unknown> = {
      mediaKeys: newKeys,
      mimeTypes: newMimes,
      kind: newKeys.length > 1 ? 'SLIDESHOW' : 'IMAGE',
    };
    if (typeof req.body.name === 'string' && req.body.name.trim()) data.name = req.body.name.trim();
    if (req.body.fit === 'cover' || req.body.fit === 'contain') data.fit = req.body.fit;
    if (req.body.durationSec !== undefined) data.durationSec = clampInt(req.body.durationSec, existing.durationSec, 3, 60);
    if (req.body.weight !== undefined) data.weight = clampInt(req.body.weight, existing.weight, 1, 10);
    if (req.body.screenIds !== undefined) {
      try {
        const p = JSON.parse(req.body.screenIds);
        if (Array.isArray(p)) data.screenIds = p.filter((x: unknown) => typeof x === 'string');
      } catch { /* leave screens unchanged */ }
    }

    const ad = await prisma.displayAd.update({ where: { id }, data });
    if (req.branchId) emitCatalogChange(req.branchId, 'display-ads');
    return res.json(shape(ad));
  } catch (err: any) {
    console.error('Edit display ad media error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to update slides' });
  }
});

// DELETE /:id — remove ad + its R2 media
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.displayAd.findFirst({ where: { id, branchId: req.branchId! } });
    if (!existing) return res.status(404).json({ error: 'NOT_FOUND', message: 'Ad not found' });

    await deleteObjects(existing.mediaKeys, ADS_BUCKET);
    await prisma.displayAd.delete({ where: { id } });
    if (req.branchId) emitCatalogChange(req.branchId, 'display-ads');
    return res.json({ ok: true });
  } catch (err: any) {
    console.error('Delete display ad error:', err);
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Failed to delete ad' });
  }
});

export default router;
