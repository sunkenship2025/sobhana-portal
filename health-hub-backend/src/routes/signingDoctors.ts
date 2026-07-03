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

/**
 * Sniff the first bytes of an uploaded file. Extension-only check is
 * bypassable: rename `evil.exe → sig.png` and Multer accepts it. We then
 * base64-encode it into the DB, embed it as `<img src>` in every report,
 * and ship arbitrary bytes to patients.
 */
function isAllowedImageMagic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return true;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true;
  // WEBP: RIFF....WEBP
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return true;
  return false;
}

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── GET /api/signing-doctors ───────────────────────────────────────
// List all signing doctors (global, not branch-scoped)
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { search, active } = req.query;

    const where: any = {};

    // Filter by active status (default: only active)
    if (active === 'all') {
      // no filter
    } else if (active === 'false') {
      where.isActive = false;
    } else {
      where.isActive = true;
    }

    // Search across name, degrees, designation, registrationNumber
    if (search && typeof search === 'string') {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { degrees: { contains: search, mode: 'insensitive' } },
        { designation: { contains: search, mode: 'insensitive' } },
        { registrationNumber: { contains: search, mode: 'insensitive' } },
      ];
    }

    const doctors = await prisma.signingDoctor.findMany({
      where,
      include: {
        _count: {
          select: { signingRules: true },
        },
      },
      orderBy: { name: 'asc' },
    });

    return res.json(doctors);
  } catch (error) {
    console.error('Error fetching signing doctors:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch signing doctors' });
  }
});

// ─── GET /api/signing-doctors/:id ───────────────────────────────────
// Get single signing doctor with their signing rules
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const doctor = await prisma.signingDoctor.findUnique({
      where: { id: req.params.id },
      include: {
        signingRules: {
          include: {
            department: { select: { id: true, name: true } },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    if (!doctor) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing doctor not found' });
    }

    return res.json(doctor);
  } catch (error) {
    console.error('Error fetching signing doctor:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch signing doctor' });
  }
});

// ─── POST /api/signing-doctors ──────────────────────────────────────
// Create a new signing doctor
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, degrees, designation, registrationNumber, signatureImagePath, isActive } = req.body;

    if (!name || !degrees || !designation) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'name, degrees, and designation are required',
      });
    }

    // Check for duplicate name (only among active doctors)
    const existing = await prisma.signingDoctor.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, isActive: true },
    });

    if (existing) {
      return res.status(409).json({
        error: 'DUPLICATE_NAME',
        message: `A signing doctor named "${name}" already exists`,
      });
    }

    const doctor = await prisma.signingDoctor.create({
      data: {
        name: name.trim(),
        degrees: degrees.trim(),
        designation: designation.trim(),
        registrationNumber: registrationNumber?.trim() || null,
        isActive: isActive ?? true,
      },
    });

    return res.status(201).json(doctor);
  } catch (error) {
    console.error('Error creating signing doctor:', error);
    return res.status(500).json({ error: 'CREATE_FAILED', message: 'Failed to create signing doctor' });
  }
});

// ─── PATCH /api/signing-doctors/:id ─────────────────────────────────
// Update a signing doctor
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, degrees, designation, registrationNumber, signatureImagePath, isActive } = req.body;

    // Verify exists
    const existing = await prisma.signingDoctor.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing doctor not found' });
    }

    // If name is changing, check for duplicates (excluding self)
    if (name && name.toLowerCase() !== existing.name.toLowerCase()) {
      const duplicate = await prisma.signingDoctor.findFirst({
        where: {
          name: { equals: name, mode: 'insensitive' },
          id: { not: id },
          isActive: true,
        },
      });
      if (duplicate) {
        return res.status(409).json({
          error: 'DUPLICATE_NAME',
          message: `A signing doctor named "${name}" already exists`,
        });
      }
    }

    const data: any = {};
    if (name !== undefined) data.name = name.trim();
    if (degrees !== undefined) data.degrees = degrees.trim();
    if (designation !== undefined) data.designation = designation.trim();
    if (registrationNumber !== undefined) data.registrationNumber = registrationNumber?.trim() || null;
    if (signatureImagePath !== undefined) data.signatureImagePath = signatureImagePath?.trim() || null;
    if (isActive !== undefined) data.isActive = isActive;

    const doctor = await prisma.signingDoctor.update({
      where: { id },
      data,
    });

    return res.json(doctor);
  } catch (error) {
    console.error('Error updating signing doctor:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: 'Failed to update signing doctor' });
  }
});

// ─── DELETE /api/signing-doctors/:id ────────────────────────────────
// Soft-delete a signing doctor (deactivate).
//
// IMPORTANT: this is now ALWAYS a soft-delete, even when the doctor has no
// current signing rules. Reason: report snapshots reference signing doctors by
// `doctorId` and rely on `SigningDoctor.signatureImageBase64` for rendering at
// read time (signature dedup, see saveReportSnapshot in reportSnapshotService.ts).
// Hard-deleting a doctor would break historical reports' signature rendering.
//
// If a doctor was added by mistake and has zero historical references, an
// admin can manually purge the row from the DB after confirming no
// ReportVersion.signaturesSnapshot or AuditLog references their `doctorId`.
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.signingDoctor.findUnique({ where: { id } });

    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing doctor not found' });
    }

    if (!existing.isActive) {
      return res.json({ message: 'Signing doctor already deactivated' });
    }

    // Mark inactive — historical reports keep working because the row (and its
    // signatureImageBase64) is still queryable; the renderer doesn't filter on isActive.
    await prisma.signingDoctor.update({
      where: { id },
      data: { isActive: false },
    });

    // Hard-delete their signing rules — removes the unique constraint rows
    // so the same department can be re-assigned to any doctor in future.
    await prisma.signingRule.deleteMany({
      where: { signingDoctorId: id },
    });

    return res.json({ message: 'Signing doctor deactivated' });
  } catch (error) {
    console.error('Error deleting signing doctor:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: 'Failed to delete signing doctor' });
  }
});

// ─── POST /api/signing-doctors/:id/upload-signature ─────────────────
// Upload a signature image for a signing doctor
router.post('/:id/upload-signature', uploadSignature.single('signature'), async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    // Verify doctor exists
    const doctor = await prisma.signingDoctor.findUnique({ where: { id } });
    if (!doctor) {
      // Clean up uploaded file if doctor not found
      if (req.file) fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Signing doctor not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'NO_FILE', message: 'No signature image uploaded. Use field name "signature".' });
    }

    // Magic-byte sniff: confirm the bytes actually match an allowed image
    // format. Multer's fileFilter only checks extension which is trivially
    // bypassable.
    const fileBytes = fs.readFileSync(req.file.path);
    if (!isAllowedImageMagic(fileBytes)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
      return res.status(400).json({
        error: 'INVALID_FILE_TYPE',
        message: 'File contents are not a valid PNG, JPEG, or WebP image',
      });
    }

    // Append-only: KEEP the previous signature file. Each upload gets a unique
    // filename, so finalized reports that froze the old path in their snapshot
    // still resolve to the exact signature they were signed with. Deleting it
    // would retroactively blank the signature on historical reports.
    // Store relative path from public/
    const relativePath = `/images/signatures/${req.file.filename}`;

    // Encode to base64 immediately — survives Render's ephemeral filesystem across deploys
    const ext = path.extname(req.file.filename).toLowerCase();
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
    const imageBase64 = `data:${mime};base64,${fileBytes.toString('base64')}`;

    const updated = await prisma.signingDoctor.update({
      where: { id },
      data: { signatureImagePath: relativePath, signatureImageBase64: imageBase64 },
    });

    return res.json({
      message: 'Signature uploaded successfully',
      signatureImagePath: relativePath,
      doctor: updated,
    });
  } catch (error) {
    // Clean up file on error
    if (req.file && fs.existsSync(req.file.path)) {
      try { fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    console.error('Error uploading signature:', error);
    return res.status(500).json({ error: 'UPLOAD_FAILED', message: 'Failed to upload signature' });
  }
});

export default router;
