/**
 * Clinical Panels Routes
 * 
 * Endpoints for panel definition management (report groupings).
 * Panels reference specific TestDefinition versions (pinned).
 * 
 * GET    /api/clinical-panels          — List panels
 * GET    /api/clinical-panels/:id      — Get panel detail
 * POST   /api/clinical-panels          — Create panel
 * PUT    /api/clinical-panels/:id      — Update panel
 * PATCH  /api/clinical-panels/:id      — Toggle active/inactive
 * POST   /api/clinical-panels/:id/preview — Live render preview
 */

import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── Code format validation ───────────────────────────────────────────
const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

// ─── Helper ──────────────────────────────────────────────────────────
function transformPanel(panel: any) {
  return {
    ...panel,
    // Frontend expects `code` (unique key) + `name` (human label)
    // Schema has `name` (unique key) + `displayName` (human label)
    code: panel.name,                  // unique key → code
    name: panel.displayName || panel.name, // human label → name
    sampleType: panel.sampleType ?? null,
    itemCount: panel.items?.length ?? panel._count?.items ?? 0,
  };
}

function validateLayoutConstraints(layoutType: string, items: any[]): string | null {
  const itemCount = items.length;

  switch (layoutType) {
    case 'TEXT_ONLY':
      if (itemCount !== 1) {
        return 'TEXT_ONLY layout requires exactly 1 test item';
      }
      break;
    case 'IMAGING_NARRATIVE':
      if (itemCount !== 1) {
        return 'IMAGING_NARRATIVE layout requires exactly 1 test item';
      }
      break;
    case 'STANDARD_TABLE':
    case 'PROCEDURE_STRUCTURED':
      if (itemCount < 1) {
        return `${layoutType} layout requires at least 1 test item`;
      }
      break;
    default:
      if (itemCount < 1) {
        return `${layoutType} layout requires at least 1 test item`;
      }
      break;
  }

  return null;
}

// ─── GET /check-code — Real-time code uniqueness check ───────────────
router.get('/check-code', async (req: AuthRequest, res) => {
  try {
    const { code } = req.query;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'code query parameter is required' });
    }
    const existing = await prisma.clinicalPanel.findUnique({
      where: { name: code.toUpperCase() },
      select: { id: true },
    });
    return res.json({ available: !existing });
  } catch (error: any) {
    console.error('Error checking code:', error);
    return res.status(500).json({ error: 'CHECK_FAILED', message: error.message });
  }
});

// ─── GET / — List panels ─────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { search, departmentId, layoutType, active } = req.query;

    const where: any = {};

    if (search && typeof search === 'string') {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { displayName: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (departmentId && typeof departmentId === 'string') {
      where.departmentId = departmentId;
    }

    if (layoutType && typeof layoutType === 'string') {
      where.layoutType = layoutType;
    }

    if (active === 'all') {
      // no filter
    } else if (active === 'false') {
      where.isActive = false;
    } else {
      where.isActive = true;
    }

    const panels = await prisma.clinicalPanel.findMany({
      where,
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
      orderBy: [
        { department: { name: 'asc' } },
        { displayOrder: 'asc' },
        { name: 'asc' },
      ],
    });

    return res.json(panels.map(transformPanel));
  } catch (error: any) {
    console.error('Error listing clinical panels:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── GET /:id — Get panel detail with items ──────────────────────────
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const panel = await prisma.clinicalPanel.findUnique({
      where: { id: req.params.id },
      include: {
        department: { select: { id: true, name: true } },
        items: {
          include: {
            testDefinition: {
              select: {
                id: true,
                rootDefinitionId: true,
                name: true,
                code: true,
                version: true,
                status: true,
                referenceMin: true,
                referenceMax: true,
                referenceUnit: true,
                referenceText: true,
                method: true,
                sampleType: true,
                interpretationMode: true,
              },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    if (!panel) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    return res.json(transformPanel(panel));
  } catch (error: any) {
    console.error('Error fetching clinical panel:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── POST / — Create panel ───────────────────────────────────────────
router.post('/', async (req: AuthRequest, res) => {
  try {
    const {
      name, displayName, departmentId, layoutType, sampleType,
      displayOrder, showMethodColumn, showSubgroups, showInterpretation, valueDisplayPrefix,
      summaryInterpretationTemplate, subgroupMethods, subgroupTableOverrides,
      panelMethodText, panelMethodItalic, items,
    } = req.body;

    if (!name || !displayName || !departmentId || !layoutType) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'name, displayName, departmentId, and layoutType are required',
      });
    }

    // Validate code (name) format
    if (!CODE_REGEX.test(name)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Panel code must be 2-20 uppercase alphanumeric characters or underscores (e.g. CBC_PANEL)',
      });
    }

    // Validate layout type constraints
    const layoutError = validateLayoutConstraints(layoutType, items ?? []);
    if (layoutError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: layoutError });
    }

    // Validate that all referenced test definitions exist and are ACTIVE
    if (items?.length) {
      const defIds = items.map((i: any) => i.testDefinitionId);
      const defs = await prisma.testDefinition.findMany({
        where: { id: { in: defIds } },
        select: { id: true, status: true, name: true },
      });

      const foundIds = new Set(defs.map(d => d.id));
      const missing = defIds.filter((id: string) => !foundIds.has(id));
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `Test definitions not found: ${missing.join(', ')}`,
        });
      }

      const inactive = defs.filter(d => d.status !== 'ACTIVE');
      if (inactive.length > 0) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `Test definitions not ACTIVE: ${inactive.map(d => d.name).join(', ')}`,
        });
      }
    }

    const panel = await prisma.clinicalPanel.create({
      data: {
        name,
        displayName,
        departmentId,
        layoutType,
        sampleType: sampleType ?? null,
        displayOrder: displayOrder ?? 0,
        showMethodColumn: showMethodColumn ?? false,
        showSubgroups: showSubgroups ?? false,
        showInterpretation: showInterpretation ?? false,
        valueDisplayPrefix: valueDisplayPrefix ?? null,
        summaryInterpretationTemplate: summaryInterpretationTemplate ?? null,
        subgroupMethods: subgroupMethods ?? null,
        subgroupTableOverrides: subgroupTableOverrides ?? null,
        panelMethodText: panelMethodText ?? null,
        panelMethodItalic: panelMethodItalic ?? false,
        items: items?.length ? {
          create: items.map((item: any, idx: number) => ({
            testDefinitionId: item.testDefinitionId,
            displayOrder: item.displayOrder ?? idx,
            showMethod: item.showMethod ?? false,
            methodText: item.methodText ?? null,
            indentLevel: item.indentLevel ?? 0,
            isBold: item.isBold ?? false,
            isItalic: item.isItalic ?? false,
            subGroup: item.subGroup ?? null,
          })),
        } : undefined,
      },
      include: {
        department: { select: { id: true, name: true } },
        items: {
          include: {
            testDefinition: {
              select: { id: true, name: true, code: true, version: true, status: true },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    return res.status(201).json(transformPanel(panel));
  } catch (error: any) {
    console.error('Error creating clinical panel:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'CONFLICT', message: `Panel name "${req.body.name}" already exists` });
    }
    return res.status(500).json({ error: 'CREATE_FAILED', message: error.message });
  }
});

// ─── PUT /:id — Update panel (full replace of items) ─────────────────
router.put('/:id', async (req: AuthRequest, res) => {
  try {
    const {
      name, displayName, departmentId, layoutType, sampleType,
      displayOrder, showMethodColumn, showSubgroups, showInterpretation, valueDisplayPrefix,
      summaryInterpretationTemplate, subgroupMethods, subgroupTableOverrides,
      panelMethodText, panelMethodItalic, items,
    } = req.body;

    const existing = await prisma.clinicalPanel.findUnique({
      where: { id: req.params.id },
      include: {
        items: {
          select: { id: true },
        },
      },
    });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    // Validate layout constraints
    const nextLayoutType = layoutType ?? existing.layoutType;
    const nextItems = items ?? existing.items;
    const layoutError = validateLayoutConstraints(nextLayoutType, nextItems);
    if (layoutError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: layoutError });
    }

    const panel = await prisma.$transaction(async (tx) => {
      // Delete existing items and recreate
      if (items) {
        await tx.clinicalPanelItem.deleteMany({ where: { panelId: req.params.id } });
      }

      return tx.clinicalPanel.update({
        where: { id: req.params.id },
        data: {
          name: name ?? existing.name,
          displayName: displayName ?? existing.displayName,
          departmentId: departmentId ?? existing.departmentId,
          layoutType: layoutType ?? existing.layoutType,
          sampleType: sampleType !== undefined ? sampleType : existing.sampleType,
          displayOrder: displayOrder ?? existing.displayOrder,
          showMethodColumn: showMethodColumn ?? existing.showMethodColumn,
          showSubgroups: showSubgroups ?? existing.showSubgroups,
          showInterpretation: showInterpretation ?? existing.showInterpretation,
          valueDisplayPrefix: valueDisplayPrefix !== undefined ? valueDisplayPrefix : existing.valueDisplayPrefix,
          summaryInterpretationTemplate: summaryInterpretationTemplate !== undefined
            ? summaryInterpretationTemplate
            : existing.summaryInterpretationTemplate,
          subgroupMethods: subgroupMethods !== undefined ? subgroupMethods : existing.subgroupMethods,
          subgroupTableOverrides: subgroupTableOverrides !== undefined ? subgroupTableOverrides : existing.subgroupTableOverrides,
          panelMethodText: panelMethodText !== undefined ? panelMethodText : existing.panelMethodText,
          panelMethodItalic: panelMethodItalic !== undefined ? panelMethodItalic : existing.panelMethodItalic,
          items: items ? {
            create: items.map((item: any, idx: number) => ({
              testDefinitionId: item.testDefinitionId,
              displayOrder: item.displayOrder ?? idx,
              showMethod: item.showMethod ?? false,
              methodText: item.methodText ?? null,
              indentLevel: item.indentLevel ?? 0,
              isBold: item.isBold ?? false,
              isItalic: item.isItalic ?? false,
              subGroup: item.subGroup ?? null,
            })),
          } : undefined,
        },
        include: {
          department: { select: { id: true, name: true } },
          items: {
            include: {
              testDefinition: {
                select: { id: true, name: true, code: true, version: true, status: true },
              },
            },
            orderBy: { displayOrder: 'asc' },
          },
        },
      });
    });

    return res.json(transformPanel(panel));
  } catch (error: any) {
    console.error('Error updating clinical panel:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'CONFLICT', message: 'Panel name already exists' });
    }
    return res.status(500).json({ error: 'UPDATE_FAILED', message: error.message });
  }
});

// ─── PATCH /:id — Toggle active/inactive ─────────────────────────────
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'isActive (boolean) is required' });
    }

    const panel = await prisma.clinicalPanel.update({
      where: { id: req.params.id },
      data: { isActive },
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { items: true } },
      },
    });

    return res.json(transformPanel(panel));
  } catch (error: any) {
    console.error('Error toggling panel:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: error.message });
  }
});

// ─── DELETE /:id — Delete panel ──────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.clinicalPanel.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    // Check if referenced by billable products
    const productRefCount = await prisma.billableProductPanel.count({
      where: { panelId: req.params.id },
    });

    if (productRefCount > 0) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Cannot delete: panel is used by ${productRefCount} billable product(s). Remove it from those products first.`,
      });
    }

    // Delete panel items first, then panel
    await prisma.clinicalPanelItem.deleteMany({ where: { panelId: req.params.id } });
    await prisma.clinicalPanel.delete({ where: { id: req.params.id } });

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting panel:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: error.message });
  }
});

// ─── POST /:id/preview — Live render preview ─────────────────────────
router.post('/:id/preview', async (req: AuthRequest, res) => {
  try {
    // This endpoint returns the panel data structured for the renderer
    // The actual HTML rendering can be done on the frontend or via the report renderer
    const panel = await prisma.clinicalPanel.findUnique({
      where: { id: req.params.id },
      include: {
        department: { select: { id: true, name: true, reportHeaderText: true } },
        items: {
          include: {
            testDefinition: {
              include: {
                ranges: true,
                interpretationRules: { where: { isActive: true }, orderBy: { displayOrder: 'asc' } },
              },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    if (!panel) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    // Build preview data structure
    const previewData = {
      panel: {
        name: panel.name,
        displayName: panel.displayName,
        layoutType: panel.layoutType,
        showMethodColumn: panel.showMethodColumn,
        summaryInterpretationTemplate: panel.summaryInterpretationTemplate,
        panelMethodText: panel.panelMethodText,
        panelMethodItalic: panel.panelMethodItalic,
      },
      department: panel.department,
      tests: panel.items.map(item => ({
        definitionId: item.testDefinition.id,
        name: item.testDefinition.name,
        code: item.testDefinition.code,
        method: item.showMethod ? (item.methodText ?? item.testDefinition.method) : null,
        referenceMin: item.testDefinition.referenceMin,
        referenceMax: item.testDefinition.referenceMax,
        referenceUnit: item.testDefinition.referenceUnit,
        referenceText: item.testDefinition.referenceText,
        displayOrder: item.displayOrder,
        indentLevel: item.indentLevel,
        isBold: item.isBold,
        isItalic: item.isItalic,
        subGroup: item.subGroup,
        interpretationMode: item.testDefinition.interpretationMode,
        ranges: item.testDefinition.ranges,
        interpretationRules: item.testDefinition.interpretationRules,
      })),
      // mockResults from request body for preview
      mockResults: req.body.mockResults ?? {},
    };

    return res.json(previewData);
  } catch (error: any) {
    console.error('Error generating panel preview:', error);
    return res.status(500).json({ error: 'PREVIEW_FAILED', message: error.message });
  }
});

export default router;
