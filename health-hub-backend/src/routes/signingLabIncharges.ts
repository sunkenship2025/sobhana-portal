import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';

const router = Router();

// ─── Multer config for signature uploads ────────────────────────────
const SIGNATURES_DIR = path.join(__dirname, '../../public/images/signatures');

// Ensure directory exists
if (!fs.existsSync(SIGNATURES_DIR)) {
  fs.mkdirSync(SIGNATURES_DIR, { recursive: true });
}

const signatureStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, SIGNATURES_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.png';
    const unique = `sig-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, unique);
  },
});

const uploadSignature = multer({
  storage: signatureStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB max
  fileFilter: (_req, file, cb) => {
    const allowed = ['.png', '.jpg', '.jpeg', '.webp'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Only PNG, JPG, JPEG, and WebP images are allowed'));
    }
  },
});

function isAllowedImageMagic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return true;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;
  return false;
}

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── GET /api/signing-lab-incharges ─────────────────────────────────
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { search, active } = req.query;

    const where: any = {};

    if (active === 'all') {
      // no filter
    } else if (active === 'false') {
      where.isActive = false;
    } else {
      where.isActive = true;
    }

    if (search && typeof search === 'string') {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { designation: { contains: search, mode: 'insensitive' } },
      ];
    }

    const labIncharges = await prisma.signingLabIncharge.findMany({
      where,
      include: {
        _count: {
          select: { labInchargeRules: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    return res.json(labIncharges);
  } catch (error) {
    console.error('Error fetching signing lab incharges:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch signing lab incharges' });
  }
});

// ─── GET /api/signing-lab-incharges/:id ─────────────────────────────
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const labIncharge = await prisma.signingLabIncharge.findUnique({
      where: { // @ts-ignore Prisma types
 id: req.params.id },
      include: {
        labInchargeRules: {
          include: {
            branch: { select: { id: true, name: true } },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    if (!labIncharge) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing lab incharge not found' });
    }

    return res.json(labIncharge);
  } catch (error) {
    console.error('Error fetching signing lab incharge:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch signing lab incharge' });
  }
});

// ─── POST /api/signing-lab-incharges ────────────────────────────────
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, designation, isActive } = req.body;

    if (!name) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'name is required',
      });
    }

    const existing = await prisma.signingLabIncharge.findFirst({
      where: { // @ts-ignore Prisma types
 name: { equals: name, mode: 'insensitive' }, isActive: true },
    });

    if (existing) {
      return res.status(409).json({
        error: 'DUPLICATE_NAME',
        message: `A signing lab incharge named "${name}" already exists`,
      });
    }

    const labIncharge = await prisma.signingLabIncharge.create({
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        name: name.trim(),
        designation: designation?.trim() || 'Lab Incharge',
        isActive: isActive ?? true,
      },
    });

    return res.status(201).json(labIncharge);
  } catch (error) {
    console.error('Error creating signing lab incharge:', error);
    return res.status(500).json({ error: 'CREATE_FAILED', message: 'Failed to create signing lab incharge' });
  }
});

// ─── PATCH /api/signing-lab-incharges/:id ───────────────────────────
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, designation, isActive } = req.body;

    const existing = await prisma.signingLabIncharge.findUnique({ where: { // @ts-ignore Prisma types
 id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing lab incharge not found' });
    }

    if (name && name.toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = await prisma.signingLabIncharge.findFirst({
        where: { // @ts-ignore Prisma types

          name: { equals: name, mode: 'insensitive' },
          id: { not: id },
          isActive: true,
        },
      });
      if (duplicate) {
        return res.status(409).json({
          error: 'DUPLICATE_NAME',
          message: `A signing lab incharge named "${name}" already exists`,
        });
      }
    }

    const data: // @ts-ignore
any = {};
    if (name !== undefined) data.name = name.trim();
    if (designation !== undefined) data.designation = designation?.trim() || 'Lab Incharge';
    if (isActive !== undefined) data.isActive = isActive;

    const labIncharge = await prisma.signingLabIncharge.update({
      where: { // @ts-ignore Prisma types
 id },
      data,
    });

    return res.json(labIncharge);
  } catch (error) {
    console.error('Error updating signing lab incharge:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: 'Failed to update signing lab incharge' });
  }
});

// ─── DELETE /api/signing-lab-incharges/:id ──────────────────────────
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.signingLabIncharge.findUnique({ where: { // @ts-ignore Prisma types
 id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing lab incharge not found' });
    }

    if (!existing.isActive) {
      return res.json({ message: 'Signing lab incharge already deactivated' });
    }

    await prisma.signingLabIncharge.update({
      where: { // @ts-ignore Prisma types
 id },
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 isActive: false },
    });

    // Hard-delete their rules
    await prisma.labInchargeRule.deleteMany({
      where: { // @ts-ignore Prisma types
 signingLabInchargeId: id },
    });

    return res.json({ message: 'Signing lab incharge deactivated' });
  } catch (error) {
    console.error('Error deleting signing lab incharge:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: 'Failed to delete signing lab incharge' });
  }
});

// ─── POST /api/signing-lab-incharges/:id/upload-signature ───────────
router.post('/:id/upload-signature', uploadSignature.single('signature'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const labIncharge = await prisma.signingLabIncharge.findUnique({ where: { // @ts-ignore Prisma types
 id } });
    if (!labIncharge) {
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing lab incharge not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'NO_FILE', message: 'No signature image uploaded. Use field name "signature".' });
    }

    const fileBytes = fs.readFileSync(req.file.path);
    if (!isAllowedImageMagic(fileBytes)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      return res.status(400).json({
        error: 'INVALID_FILE_TYPE',
        message: 'File contents are not a valid PNG, JPEG, or WebP image',
      });
    }

    // Delete old signature file if it exists
    if (labIncharge.signatureImagePath) {
      const oldPath = path.join(__dirname, '../../public', labIncharge.signatureImagePath);
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    const relativePath = `/images/signatures/${req.file.filename}`;
    const ext = path.extname(req.file.filename).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const imageBase64 = `data:${mime};base64,${fileBytes.toString('base64')}`;

    const updated = await prisma.signingLabIncharge.update({
      where: { // @ts-ignore Prisma types
 id },
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 signatureImagePath: relativePath, signatureImageBase64: imageBase64 },
    });

    return res.json({
      message: 'Signature uploaded successfully',
      signatureImagePath: relativePath,
      labIncharge: updated,
    });
  } catch (error) {
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    console.error('Error uploading signature:', error);
    return res.status(500).json({ error: 'UPLOAD_FAILED', message: 'Failed to upload signature' });
  }
});

export default router;
