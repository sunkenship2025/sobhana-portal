/**
 * Clinical Definitions Routes
 * 
 * Endpoints for versioned test definition management.
 * All routes require auth + branch context.
 * 
 * GET    /api/clinical-definitions          — List latest definitions
 * GET    /api/clinical-definitions/:id      — Get specific version detail
 * GET    /api/clinical-definitions/:rootId/versions — Get all versions
 * POST   /api/clinical-definitions          — Create new definition
 * POST   /api/clinical-definitions/:rootId/new-version — Clone-on-edit
 * PATCH  /api/clinical-definitions/:id/status — Transition status
 * GET    /api/clinical-definitions/:rootId/impact — Impact analysis
 * GET    /api/clinical-definitions/:rootId/dependents — Dependent definitions
 * POST   /api/clinical-definitions/:id/preview — Sandbox preview
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';
import {
  createTestDefinition,
  createNewVersion,
  transitionStatus,
  getImpact,
  getDependents,
  sandboxPreview,
} from '../services/clinicalDefinitionService';
import { checkConcurrency } from '../utils/clinicalValidation';
import { emitCatalogChange } from '../lib/displayEvents';
import { logAction } from '../services/auditService';
import { AuditActionType } from '@prisma/client';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// Record a clinical-definition change to the audit log (best-effort; logAction
// swallows its own errors). Surfaces in the Audit & Anomalies feed as "who
// edited which clinical definition".
function auditDef(req: AuthRequest, actionType: AuditActionType, entityId: string, oldValues: any, newValues: any) {
  return logAction({
    branchId: req.branchId!, actionType, entityType: 'TestDefinition', entityId,
    userId: req.user?.id, oldValues, newValues, ipAddress: req.ip, userAgent: req.get('user-agent'),
  });
}

// ─── Code format validation ───────────────────────────────────────────
const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

// ─── Helper: transform for API response ──────────────────────────────
function transformDefinition(def: any) {
  return {
    ...def,
    rangeCount: def.ranges?.length ?? def._count?.ranges ?? 0,
    ruleCount: def.interpretationRules?.length ?? def._count?.interpretationRules ?? 0,
  };
}

// ─── GET /check-code — Real-time code uniqueness check ───────────────
router.get('/check-code', async (req: AuthRequest, res) => {
  try {
    const { code } = req.query;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'code query parameter is required' });
    }
    const existing = await prisma.testDefinition.findFirst({
      where: { code: code.toUpperCase(), isLatest: true },
      select: { id: true },
    });
    return res.json({ available: !existing });
  } catch (error: any) {
    console.error('Error checking code:', error);
    return res.status(500).json({ error: 'CHECK_FAILED', message: error.message });
  }
});

// ─── GET / — List latest test definitions ────────────────────────────
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { search, departmentId, status, interpretationMode, code } = req.query;

    const where: any = { isLatest: true };

    if (search && typeof search === 'string') {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (departmentId && typeof departmentId === 'string') {
      where.departmentId = departmentId;
    }

    if (status && typeof status === 'string' && status !== 'all') {
      where.status = status;
    } else if (!status) {
      // Default (no filter param): show ACTIVE and DEPRECATED for non-management callers
      where.status = { in: ['ACTIVE', 'DEPRECATED'] };
    }
    // status=all → no status filter, show everything

    if (interpretationMode && typeof interpretationMode === 'string') {
      where.interpretationMode = interpretationMode;
    }

    if (code && typeof code === 'string') {
      where.code = code;
    }

    const definitions = await prisma.testDefinition.findMany({
      where,
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { ranges: true, interpretationRules: true, panelItems: true, productPanels: true } },
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });

    return res.json(definitions.map(transformDefinition));
  } catch (error: any) {
    console.error('Error listing clinical definitions:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── GET /:id — Get specific version detail ──────────────────────────
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const def = await prisma.testDefinition.findUnique({
      where: { id: req.params.id },
      include: {
        department: { select: { id: true, name: true } },
        ranges: { orderBy: { minAgeDays: 'asc' } },
        interpretationRules: { orderBy: { displayOrder: 'asc' } },
        panelItems: {
          include: { panel: { select: { id: true, name: true, displayName: true } } },
        },
        productPanels: {
          include: { product: { select: { id: true, name: true, code: true } } },
        },
      },
    });

    if (!def) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Test definition not found' });
    }

    return res.json(transformDefinition(def));
  } catch (error: any) {
    console.error('Error fetching clinical definition:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── GET /:rootId/versions — Get all versions of a definition ────────
router.get('/:rootId/versions', async (req: AuthRequest, res) => {
  try {
    const versions = await prisma.testDefinition.findMany({
      where: { rootDefinitionId: req.params.rootId },
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { ranges: true, interpretationRules: true } },
      },
      orderBy: { version: 'desc' },
    });

    if (versions.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No versions found' });
    }

    return res.json(versions.map(transformDefinition));
  } catch (error: any) {
    console.error('Error fetching versions:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── POST / — Create new test definition ─────────────────────────────
router.post('/', async (req: AuthRequest, res) => {
  try {
    const definition = await createTestDefinition(req.body);
    if (definition) await auditDef(req, 'CREATE', definition.id, null, { name: definition.name, code: definition.code });
    if (req.branchId) emitCatalogChange(req.branchId, 'clinical-definitions');
    return res.status(201).json(definition);
  } catch (error: any) {
    console.error('Error creating clinical definition:', error);
    if (error.message.includes('already exists') || error.message.includes('overlap') || error.message.includes('Circular')) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: error.message });
    }
    return res.status(500).json({ error: 'CREATE_FAILED', message: error.message });
  }
});

// ─── POST /:rootId/new-version — Clone-on-edit ──────────────────────
router.post('/:rootId/new-version', async (req: AuthRequest, res) => {
  try {
    const ifMatch = req.headers['if-match'] as string | undefined;
    const definition = await createNewVersion(req.params.rootId, req.body, ifMatch);
    if (definition) await auditDef(req, 'UPDATE', definition.id, null, { name: definition.name, code: definition.code, version: definition.version, change: 'new version (edit)' });
    if (req.branchId) emitCatalogChange(req.branchId, 'clinical-definitions');
    return res.status(201).json(definition);
  } catch (error: any) {
    console.error('Error creating new version:', error);
    if (error.message.startsWith('CONFLICT')) {
      return res.status(409).json({ error: 'CONFLICT', message: error.message });
    }
    if (error.message.includes('not found') || error.message.includes('Cannot create')) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: error.message });
    }
    return res.status(500).json({ error: 'CREATE_FAILED', message: error.message });
  }
});

// ─── PATCH /:id/status — Transition status ───────────────────────────
router.patch('/:id/status', async (req: AuthRequest, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'status is required' });
    }

    const ifMatch = req.headers['if-match'] as string | undefined;
    const definition = await transitionStatus(req.params.id, status, ifMatch);
    if (definition) await auditDef(req, 'UPDATE', definition.id, null, { name: definition.name, code: definition.code, status });
    if (req.branchId) emitCatalogChange(req.branchId, 'clinical-definitions');
    return res.json(definition);
  } catch (error: any) {
    console.error('Error transitioning status:', error);
    if (error.message.startsWith('CONFLICT')) {
      return res.status(409).json({ error: 'CONFLICT', message: error.message });
    }
    if (error.message.includes('Invalid transition') || error.message.includes('not found')) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: error.message });
    }
    return res.status(500).json({ error: 'UPDATE_FAILED', message: error.message });
  }
});

// ─── GET /:rootId/impact — Impact analysis ───────────────────────────
router.get('/:rootId/impact', async (req: AuthRequest, res) => {
  try {
    const impact = await getImpact(req.params.rootId);
    return res.json(impact);
  } catch (error: any) {
    console.error('Error fetching impact:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── GET /:rootId/dependents — Dependent definitions ─────────────────
router.get('/:rootId/dependents', async (req: AuthRequest, res) => {
  try {
    // First get the code for this root definition
    const def = await prisma.testDefinition.findFirst({
      where: { rootDefinitionId: req.params.rootId, isLatest: true },
      select: { code: true },
    });

    if (!def) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Definition not found' });
    }

    const dependents = await getDependents(def.code);
    return res.json(dependents);
  } catch (error: any) {
    console.error('Error fetching dependents:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── PATCH /:id/toggle-visibility — Toggle isActive flag ─────────────
router.patch('/:id/toggle-visibility', async (req: AuthRequest, res) => {
  try {
    const def = await prisma.testDefinition.findUnique({ where: { id: req.params.id } });
    if (!def) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Test definition not found' });
    }
    // Optimistic concurrency: same protocol the other clinicalDef endpoints
    // use. Two admins viewing the row at the same time would otherwise stomp
    // each other's toggle silently.
    const ifMatch = req.headers['if-match'] as string | undefined;
    if (!checkConcurrency(ifMatch, def.updatedAt)) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'This definition was modified by another user. Refresh and try again.',
      });
    }
    const updated = await prisma.testDefinition.update({
      where: { id: req.params.id },
      data: { isActive: !def.isActive },
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { ranges: true, interpretationRules: true, panelItems: true, productPanels: true } },
      },
    });
    await auditDef(req, 'UPDATE', updated.id, { isActive: def.isActive }, { name: updated.name, code: updated.code, isActive: updated.isActive });
    if (req.branchId) emitCatalogChange(req.branchId, 'clinical-definitions');
    return res.json(transformDefinition(updated));
  } catch (error: any) {
    console.error('Error toggling visibility:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: error.message });
  }
});

// ─── DELETE /:rootId — Delete all versions of a definition ───────────
// Strategy: physical delete if no FK references; otherwise archive
// (set isLatest=false + status=ARCHIVED) so the code becomes reusable.
router.delete('/:rootId', async (req: AuthRequest, res) => {
  try {
    const versions = await prisma.testDefinition.findMany({
      where: { rootDefinitionId: req.params.rootId },
      select: { id: true, code: true, name: true, isLatest: true, updatedAt: true },
    });

    if (versions.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Test definition not found' });
    }

    // Optimistic concurrency vs. the latest version's updatedAt — same
    // protocol as PATCH /:id/status and POST /:rootId/new-version. Without
    // this check, a delete can race with a concurrent edit and silently win.
    const latest = versions.find((v) => v.isLatest) ?? versions[0];
    const ifMatch = req.headers['if-match'] as string | undefined;
    if (!checkConcurrency(ifMatch, latest.updatedAt)) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: 'This definition was modified by another user. Refresh and try again.',
      });
    }

    const versionIds = versions.map(v => v.id);

    // Check for active references in panels — block unless panel items removed first
    const panelItemCount = await prisma.clinicalPanelItem.count({
      where: { testDefinitionId: { in: versionIds } },
    });

    if (panelItemCount > 0) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Cannot delete: this definition is used in ${panelItemCount} panel item(s). Remove it from all panels first.`,
      });
    }

    // Check for test orders / results referencing this definition
    const [orderCount, resultCount] = await Promise.all([
      prisma.testOrder.count({ where: { testDefinitionId: { in: versionIds } } }),
      prisma.testResult.count({ where: { testDefinitionId: { in: versionIds } } }),
    ]);

    const hasHistoricalData = orderCount > 0 || resultCount > 0;

    if (hasHistoricalData) {
      // Can't physically delete (FK Restrict) — archive instead so the code is freed
      await prisma.testDefinition.updateMany({
        where: { rootDefinitionId: req.params.rootId },
        data: { isLatest: false, status: 'ARCHIVED' },
      });
      await auditDef(req, 'DELETE', latest.id, null, { name: latest.name, code: latest.code, change: 'archived' });
      if (req.branchId) emitCatalogChange(req.branchId, 'clinical-definitions');
      return res.json({
        success: true,
        archived: true,
        message: `Definition archived (${orderCount} order(s), ${resultCount} result(s) reference it). Code is now available for reuse.`,
      });
    }

    // No references — safe to physically delete (ranges + rules cascade)
    // Also clear any BillableProductPanel references (onDelete: SetNull handles this)
    await prisma.testDefinition.deleteMany({
      where: { rootDefinitionId: req.params.rootId },
    });

    await auditDef(req, 'DELETE', latest.id, null, { name: latest.name, code: latest.code, change: 'deleted' });
    if (req.branchId) emitCatalogChange(req.branchId, 'clinical-definitions');
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting definition:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: error.message });
  }
});

// ─── POST /:id/preview — Sandbox preview ─────────────────────────────
router.post('/:id/preview', async (req: AuthRequest, res) => {
  try {
    const { testValue } = req.body;
    if (testValue === undefined || testValue === null) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'testValue is required' });
    }

    const result = await sandboxPreview(req.params.id, testValue);
    return res.json(result);
  } catch (error: any) {
    console.error('Error in sandbox preview:', error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: 'NOT_FOUND', message: error.message });
    }
    return res.status(500).json({ error: 'PREVIEW_FAILED', message: error.message });
  }
});

export default router;
