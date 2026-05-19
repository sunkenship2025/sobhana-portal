/**
 * External Report Uploads
 *
 * Endpoints to attach, list, view, and delete external-lab PDF reports for
 * EXTERNAL_UPLOAD test orders. The PDF bytes live in Cloudflare R2; only
 * metadata + r2Key live in the database.
 *
 * Mounted at /api/external-uploads (auth + branch context required).
 */

import { Router } from 'express';
import multer from 'multer';
import { randomUUID } from 'crypto';
import { DiagnosticWorkflowMode } from '@prisma/client';
import { PDFDocument } from 'pdf-lib';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';
import { logAction } from '../services/auditService';
import {
  putPdf,
  getObject,
  deleteObject,
  buildExternalUploadKey,
} from '../services/r2StorageService';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

const MAX_BYTES = Number(process.env.EXTERNAL_UPLOAD_MAX_BYTES) || 25 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

/** PDF magic bytes: %PDF (0x25 0x50 0x44 0x46) */
function isPdfBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x25 &&
    buf[1] === 0x50 &&
    buf[2] === 0x44 &&
    buf[3] === 0x46
  );
}

function shapeUpload(row: {
  id: string;
  testOrderId: string;
  visitId: string;
  originalFilename: string;
  fileSizeBytes: number;
  pageCount: number | null;
  displayOrder: number;
  uploadedAt: Date;
}) {
  return {
    id: row.id,
    testOrderId: row.testOrderId,
    visitId: row.visitId,
    originalFilename: row.originalFilename,
    fileSizeBytes: row.fileSizeBytes,
    pageCount: row.pageCount,
    displayOrder: row.displayOrder,
    uploadedAt: row.uploadedAt.toISOString(),
  };
}

/**
 * GET /api/external-uploads/by-visit/:visitId
 * Lists all non-deleted uploads for a visit, scoped to the user's active branch.
 */
router.get('/by-visit/:visitId', async (req: AuthRequest, res) => {
  try {
    const { visitId } = req.params;

    const visit = await prisma.visit.findFirst({
      where: { id: visitId, branchId: req.branchId, domain: 'DIAGNOSTICS' },
      select: { id: true },
    });
    if (!visit) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Visit not found' });
    }

    const uploads = await prisma.externalReportUpload.findMany({
      where: { visitId, deletedAt: null },
      orderBy: [{ displayOrder: 'asc' }, { uploadedAt: 'asc' }],
    });

    return res.json(uploads.map(shapeUpload));
  } catch (error: any) {
    req.log.error({ err: error, visitId: req.params.visitId }, 'list external uploads failed');
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

/**
 * POST /api/external-uploads
 * Multipart body: pdf (file), testOrderId (text)
 * Validates the file is a real PDF, parses page count, writes to R2, persists row.
 */
router.post('/', upload.single('pdf'), async (req: AuthRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'UNAUTHORIZED', message: 'Missing user context' });
    }

    const file = req.file;
    const { testOrderId } = req.body;

    if (!file) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'pdf file is required' });
    }
    if (!testOrderId || typeof testOrderId !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'testOrderId is required' });
    }
    if (!isPdfBuffer(file.buffer)) {
      return res.status(400).json({ error: 'INVALID_FILE_TYPE', message: 'File must be a valid PDF' });
    }

    // Verify the test order is EXTERNAL_UPLOAD and belongs to the active branch
    const testOrder = await prisma.testOrder.findFirst({
      where: { id: testOrderId, branchId: req.branchId },
      select: {
        id: true,
        visitId: true,
        workflowMode: true,
        visit: { select: { status: true } },
      },
    });
    if (!testOrder) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Test order not found' });
    }
    if (testOrder.workflowMode !== DiagnosticWorkflowMode.EXTERNAL_UPLOAD) {
      return res.status(400).json({
        error: 'WORKFLOW_MISMATCH',
        message: 'Uploads are only allowed for EXTERNAL_UPLOAD test orders',
      });
    }

    // Partial releases create finalized versions while the visit remains open.
    // New uploads are still valid for pending external-upload orders until the
    // final /finalize call marks the visit COMPLETED.
    if (testOrder.visit.status === 'COMPLETED') {
      return res.status(400).json({
        error: 'REPORT_FINALIZED',
        message: 'Cannot attach uploads after the report has been finalized',
      });
    }

    // Parse page count (also doubles as a validity check; rejects malformed PDFs)
    let pageCount: number | null = null;
    try {
      const doc = await PDFDocument.load(file.buffer, { ignoreEncryption: true });
      pageCount = doc.getPageCount();
    } catch (parseErr: any) {
      return res.status(400).json({
        error: 'PDF_PARSE_FAILED',
        message: 'PDF could not be parsed. Try re-saving or re-exporting the file.',
      });
    }

    // Determine next display order so multiple uploads on one order keep their submission sequence
    const maxOrder = await prisma.externalReportUpload.aggregate({
      where: { testOrderId, deletedAt: null },
      _max: { displayOrder: true },
    });
    const nextDisplayOrder = (maxOrder._max.displayOrder ?? -1) + 1;

    const id = randomUUID();
    const r2Key = buildExternalUploadKey(testOrder.visitId, id);

    await putPdf({
      key: r2Key,
      body: file.buffer,
      originalFilename: file.originalname,
    });

    const created = await prisma.externalReportUpload.create({
      data: {
        id,
        testOrderId,
        visitId: testOrder.visitId,
        r2Key,
        originalFilename: file.originalname,
        mimeType: 'application/pdf',
        fileSizeBytes: file.size,
        pageCount,
        displayOrder: nextDisplayOrder,
        uploadedByUserId: userId,
      },
    });

    // Audit: who uploaded what, when, against which order. Insert-only.
    void logAction({
      branchId: req.branchId!,
      userId,
      actionType: 'CREATE',
      entityType: 'ExternalReportUpload',
      entityId: created.id,
      newValues: {
        testOrderId,
        visitId: testOrder.visitId,
        originalFilename: file.originalname,
        fileSizeBytes: file.size,
        pageCount,
        r2Key,
        displayOrder: nextDisplayOrder,
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.status(201).json(shapeUpload(created));
  } catch (error: any) {
    req.log.error({ err: error }, 'external upload create failed');
    if (error?.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: 'FILE_TOO_LARGE',
        message: `File exceeds the ${Math.round(MAX_BYTES / (1024 * 1024))}MB limit`,
      });
    }
    return res.status(500).json({ error: 'UPLOAD_FAILED', message: error.message });
  }
});

/**
 * DELETE /api/external-uploads/:id
 * Soft-deletes the row and removes the R2 object.
 */
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const upload = await prisma.externalReportUpload.findUnique({
      where: { id: req.params.id },
      include: { visit: { select: { branchId: true, status: true } } },
    });
    if (!upload || upload.deletedAt) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Upload not found' });
    }
    if (upload.visit.branchId !== req.branchId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Upload belongs to another branch' });
    }

    const finalizedVersions = await prisma.reportVersion.findMany({
      where: { report: { visitId: upload.visitId }, status: 'FINALIZED' },
      select: { externalUploadsSnapshot: true },
    });
    const uploadAlreadyReleased = finalizedVersions.some((version) => {
      const snapshot = version.externalUploadsSnapshot;
      return (
        Array.isArray(snapshot) &&
        snapshot.some((item: any) => item?.uploadId === upload.id)
      );
    });
    if (upload.visit.status === 'COMPLETED' || uploadAlreadyReleased) {
      return res.status(400).json({
        error: 'REPORT_FINALIZED',
        message: 'Cannot remove an upload after it has been finalized into a report',
      });
    }

    await deleteObject(upload.r2Key).catch((err) => {
      req.log.error(
        { err, uploadId: upload.id, visitId: upload.visitId },
        'R2 deleteObject failed — proceeding to mark deleted in DB anyway',
      );
    });

    await prisma.externalReportUpload.update({
      where: { id: upload.id },
      data: { deletedAt: new Date() },
    });

    // Audit: who removed an upload pre-finalize. Captures the prior file metadata
    // so a tampering attempt (delete + re-upload of a different file) is reconstructable.
    void logAction({
      branchId: req.branchId!,
      userId: req.user?.id ?? null,
      actionType: 'DELETE',
      entityType: 'ExternalReportUpload',
      entityId: upload.id,
      oldValues: {
        testOrderId: upload.testOrderId,
        visitId: upload.visitId,
        originalFilename: upload.originalFilename,
        fileSizeBytes: upload.fileSizeBytes,
        pageCount: upload.pageCount,
        r2Key: upload.r2Key,
        uploadedByUserId: upload.uploadedByUserId,
        uploadedAt: upload.uploadedAt.toISOString(),
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    return res.json({ success: true });
  } catch (error: any) {
    req.log.error({ err: error, uploadId: req.params.id }, 'external upload delete failed');
    return res.status(500).json({ error: 'DELETE_FAILED', message: error.message });
  }
});

/**
 * GET /api/external-uploads/:id
 * Streams the raw uploaded PDF (auth-gated). Used by the entry-screen "view" link.
 */
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const upload = await prisma.externalReportUpload.findUnique({
      where: { id: req.params.id },
      include: { visit: { select: { branchId: true } } },
    });
    if (!upload || upload.deletedAt) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Upload not found' });
    }
    if (upload.visit.branchId !== req.branchId) {
      return res.status(403).json({ error: 'FORBIDDEN', message: 'Upload belongs to another branch' });
    }

    const buffer = await getObject(upload.r2Key);

    // Audit: who viewed which uploaded patient PDF, when, from where.
    // Equivalent to ReportAccessLog for the public report path, but for staff-
    // gated views of source uploads.
    void logAction({
      branchId: req.branchId!,
      userId: req.user?.id ?? null,
      actionType: 'REPORT_ACCESS',
      entityType: 'ExternalReportUpload',
      entityId: upload.id,
      newValues: {
        visitId: upload.visitId,
        testOrderId: upload.testOrderId,
        originalFilename: upload.originalFilename,
        accessKind: 'STAFF_VIEW',
      },
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
    });

    res.setHeader('Content-Type', 'application/pdf');
    // Strip quotes AND CRLF — newlines in the filename would let a crafted
    // upload inject arbitrary response headers (CRLF injection). Express
    // usually sanitizes at the HTTP layer, but defense-in-depth is cheap.
    const safeName = upload.originalFilename.replace(/[\r\n"]/g, '');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${safeName}"`,
    );
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('Cache-Control', 'no-store');
    return res.send(buffer);
  } catch (error: any) {
    req.log.error({ err: error, uploadId: req.params.id }, 'external upload fetch failed');
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

export default router;
