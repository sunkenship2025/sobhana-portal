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

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── Helper: transform for API response ──────────────────────────────
function transformDefinition(def: any) {
  return {
    ...def,
    rangeCount: def.ranges?.length ?? def._count?.ranges ?? 0,
    ruleCount: def.interpretationRules?.length ?? def._count?.interpretationRules ?? 0,
  };
}

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

    if (status && typeof status === 'string') {
      where.status = status;
    } else {
      // Default: show ACTIVE and DEPRECATED (not LOCKED/ARCHIVED)
      where.status = { in: ['ACTIVE', 'DEPRECATED'] };
    }

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
      },
      orderBy: { version: 'desc' },
    });

    if (versions.length === 0) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'No versions found' });
    }

    return res.json(versions);
  } catch (error: any) {
    console.error('Error fetching versions:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── POST / — Create new test definition ─────────────────────────────
router.post('/', async (req: AuthRequest, res) => {
  try {
    const definition = await createTestDefinition(req.body);
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
