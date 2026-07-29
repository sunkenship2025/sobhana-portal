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
import { AuditActionType } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';
import { logAction } from '../services/auditService';
import { renderReportHtml } from '../services/reportRendererService';
import { generateMergedReportPdf } from '../services/mergedReportPdfService';
import { buildDraftPanelSnapshot } from '../services/reportSnapshotService';

const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── Code format validation ───────────────────────────────────────────
const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

// Record a clinical-panel change to the append-only audit log. Best-effort
// (logAction swallows its own errors so it never blocks the response); these
// rows surface in the owner Audit & Anomalies feed as catalog changes.
function auditPanel(
  req: AuthRequest,
  actionType: AuditActionType,
  entityId: string,
  oldValues: any,
  newValues: any,
) {
  return logAction({
    branchId: req.branchId!,
    actionType,
    entityType: 'ClinicalPanel',
    entityId,
    userId: req.user?.id,
    oldValues,
    newValues,
    ipAddress: req.ip,
    userAgent: req.get('user-agent'),
  });
}

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

/**
 * Panel items must always reference the latest ACTIVE version of a definition.
 * A save may submit a superseded version id (panel stored before the
 * definition was edited) — re-point it to the latest version of its root
 * instead of rejecting, then validate the resolved version is ACTIVE.
 */
async function resolveItemsToLatestActive(
  items: any[]
): Promise<{ items?: any[]; error?: string }> {
  const defIds = items.map((i: any) => i.testDefinitionId);
  const defs = await prisma.testDefinition.findMany({
    where: { id: { in: defIds } },
    select: { id: true, status: true, name: true, rootDefinitionId: true, isLatest: true },
  });

  const byId = new Map(defs.map(d => [d.id, d]));
  const missing = defIds.filter((id: string) => !byId.has(id));
  if (missing.length > 0) {
    return { error: `Test definitions not found: ${missing.join(', ')}` };
  }

  const staleRoots = [...new Set(defs.filter(d => !d.isLatest).map(d => d.rootDefinitionId))];
  const latestByRoot = new Map<string, typeof defs[number]>();
  if (staleRoots.length > 0) {
    const latest = await prisma.testDefinition.findMany({
      where: { rootDefinitionId: { in: staleRoots }, isLatest: true },
      select: { id: true, status: true, name: true, rootDefinitionId: true, isLatest: true },
    });
    for (const d of latest) latestByRoot.set(d.rootDefinitionId, d);
  }

  const resolved: any[] = [];
  const seen = new Set<string>();
  const inactive: string[] = [];
  for (const item of items) {
    const def = byId.get(item.testDefinitionId)!;
    const target = def.isLatest ? def : (latestByRoot.get(def.rootDefinitionId) ?? def);
    if (target.status !== 'ACTIVE') {
      inactive.push(target.name);
      continue;
    }
    // Two stale versions of the same root collapse into one item after re-pointing
    if (seen.has(target.id)) continue;
    seen.add(target.id);
    resolved.push({ ...item, testDefinitionId: target.id });
  }

  if (inactive.length > 0) {
    return { error: `Test definitions not ACTIVE: ${inactive.join(', ')}` };
  }
  return { items: resolved };
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
      displayOrder, showMethodColumn, showSubgroups, showInterpretation, valueDisplayPrefix, spacedDefinitionsGap,
      summaryInterpretationTemplate, comments, interpretation, subgroupMethods, subgroupTableOverrides,
      panelMethodText, panelMethodItalic, narrativeTemplateHtml, items,
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

    // Resolve items to the latest ACTIVE definition versions
    let resolvedItems = items;
    if (items?.length) {
      const resolution = await resolveItemsToLatestActive(items);
      if (resolution.error) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: resolution.error });
      }
      resolvedItems = resolution.items;
    }

    // Validate layout type constraints
    const layoutError = validateLayoutConstraints(layoutType, resolvedItems ?? []);
    if (layoutError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: layoutError });
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
        spacedDefinitionsGap: spacedDefinitionsGap ?? 0,
        valueDisplayPrefix: valueDisplayPrefix || null,
        summaryInterpretationTemplate: summaryInterpretationTemplate ?? null,
        comments: comments ?? null,
        interpretation: interpretation ?? null,
        subgroupMethods: subgroupMethods ?? null,
        subgroupTableOverrides: subgroupTableOverrides ?? null,
        panelMethodText: panelMethodText ?? null,
        panelMethodItalic: panelMethodItalic ?? false,
        narrativeTemplateHtml: narrativeTemplateHtml ?? null,
        items: resolvedItems?.length ? {
          create: resolvedItems.map((item: any, idx: number) => ({
            testDefinitionId: item.testDefinitionId,
            displayOrder: item.displayOrder ?? idx,
            showMethod: item.showMethod ?? false,
            methodText: item.methodText ?? null,
            indentLevel: item.indentLevel ?? 0,
            isBold: item.isBold ?? false,
            isItalic: item.isItalic ?? false,
            subGroup: item.subGroup ?? null,
            joinPrevious: item.joinPrevious ?? false,
            gridWidth: item.gridWidth ?? null,
            displayLabel: item.displayLabel ?? null,
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

    await auditPanel(req, 'CREATE', panel.id, null, {
      name: panel.name,
      displayName: panel.displayName,
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
      displayOrder, showMethodColumn, showSubgroups, showInterpretation, valueDisplayPrefix, spacedDefinitionsGap,
      summaryInterpretationTemplate, comments, interpretation, subgroupMethods, subgroupTableOverrides,
      panelMethodText, panelMethodItalic, narrativeTemplateHtml, items,
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

    // Resolve items to the latest ACTIVE definition versions
    let resolvedItems = items;
    if (items?.length) {
      const resolution = await resolveItemsToLatestActive(items);
      if (resolution.error) {
        return res.status(400).json({ error: 'VALIDATION_ERROR', message: resolution.error });
      }
      resolvedItems = resolution.items;
    }

    // Validate layout constraints
    const nextLayoutType = layoutType ?? existing.layoutType;
    const nextItems = resolvedItems ?? existing.items;
    const layoutError = validateLayoutConstraints(nextLayoutType, nextItems);
    if (layoutError) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: layoutError });
    }

    console.log("PUT /:id payload spacedDefinitionsGap:", spacedDefinitionsGap);


    const panel = await prisma.$transaction(async (tx) => {
      // Delete existing items and recreate
      if (resolvedItems) {
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
          spacedDefinitionsGap: spacedDefinitionsGap ?? existing.spacedDefinitionsGap,
          valueDisplayPrefix: valueDisplayPrefix !== undefined ? (valueDisplayPrefix || null) : existing.valueDisplayPrefix,
          summaryInterpretationTemplate: summaryInterpretationTemplate !== undefined
            ? summaryInterpretationTemplate
            : existing.summaryInterpretationTemplate,
          comments: comments !== undefined ? comments : existing.comments,
          interpretation: interpretation !== undefined ? interpretation : existing.interpretation,
          subgroupMethods: subgroupMethods !== undefined ? subgroupMethods : existing.subgroupMethods,
          subgroupTableOverrides: subgroupTableOverrides !== undefined ? subgroupTableOverrides : existing.subgroupTableOverrides,
          panelMethodText: panelMethodText !== undefined ? panelMethodText : existing.panelMethodText,
          panelMethodItalic: panelMethodItalic !== undefined ? panelMethodItalic : existing.panelMethodItalic,
          narrativeTemplateHtml: narrativeTemplateHtml !== undefined ? narrativeTemplateHtml : existing.narrativeTemplateHtml,
          items: resolvedItems ? {
            create: resolvedItems.map((item: any, idx: number) => ({
              testDefinitionId: item.testDefinitionId,
              displayOrder: item.displayOrder ?? idx,
              showMethod: item.showMethod ?? false,
              methodText: item.methodText ?? null,
              indentLevel: item.indentLevel ?? 0,
              isBold: item.isBold ?? false,
              isItalic: item.isItalic ?? false,
              subGroup: item.subGroup ?? null,
              joinPrevious: item.joinPrevious ?? false,
              gridWidth: item.gridWidth ?? null,
              displayLabel: item.displayLabel ?? null,
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

    console.log("PUT /:id saved spacedDefinitionsGap:", panel.spacedDefinitionsGap);

    await auditPanel(
      req,
      'UPDATE',
      panel.id,
      { name: existing.name, displayName: existing.displayName },
      { name: panel.name, displayName: panel.displayName },
    );
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

    await auditPanel(req, 'UPDATE', panel.id, null, {
      name: panel.name,
      displayName: panel.displayName,
      isActive,
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

    await auditPanel(
      req,
      'DELETE',
      existing.id,
      { name: existing.name, displayName: existing.displayName },
      null,
    );
    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting panel:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: error.message });
  }
});

// ─── POST /preview-html — Report Builder live preview ────────────────
// Renders an UNSAVED builder draft (in-progress panel + items + mock patient +
// mock values) through the EXACT same renderer the finalized report uses, so
// the builder preview is byte-identical to production. Stateless / persists
// nothing. profile: 'digital' → screen HTML, 'letterhead' → pdf-physical HTML;
// format: 'pdf' → the real merged digital PDF (byte-exact download preview).
// Registered BEFORE '/:id/preview' — '/preview-html' is a single literal segment
// so it never collides with the '/:id/preview' two-segment route.
router.post('/preview-html', async (req: AuthRequest, res) => {
  try {
    const { panel, items, patient, profile, format } = req.body;
    if (!panel || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'panel and at least one item are required' });
    }

    const branch = await prisma.branch.findUnique({ where: { id: req.branchId! } });
    if (!branch) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Active branch not found' });
    }

    // Real department (READ-ONLY) so signature/lab-incharge resolution and the
    // department header are accurate. Falls back to a placeholder when the
    // builder hasn't picked a department yet.
    const department = panel.departmentId
      ? await prisma.department.findUnique({ where: { id: panel.departmentId } })
      : null;

    const snapshot = await buildDraftPanelSnapshot({
      branch: { id: branch.id, name: branch.name, code: branch.code, address: branch.address, phone: branch.phone },
      department: department
        ? {
            id: department.id,
            name: department.name,
            reportHeaderText: department.reportHeaderText,
            displayOrder: department.displayOrder,
            showLabIncharge: department.showLabIncharge,
          }
        : {
            id: 'draft-dept',
            name: panel.departmentName || 'DEPARTMENT',
            reportHeaderText: panel.departmentName ? `DEPARTMENT OF ${String(panel.departmentName).toUpperCase()}` : 'DEPARTMENT',
            displayOrder: 0,
            showLabIncharge: true,
          },
      panel: {
        code: panel.code ?? panel.name ?? 'PREVIEW',
        label: panel.label ?? panel.displayName ?? panel.name ?? 'Preview',
        layoutType: panel.layoutType ?? 'STANDARD_TABLE',
        sampleType: panel.sampleType ?? null,
        panelMethodText: panel.panelMethodText ?? null,
        panelMethodItalic: panel.panelMethodItalic ?? false,
        showSubgroups: panel.showSubgroups ?? false,
        showInterpretation: panel.showInterpretation ?? false,
        subgroupMethods: panel.subgroupMethods ?? null,
        subgroupTableOverrides: panel.subgroupTableOverrides ?? null,
        valueDisplayPrefix: panel.valueDisplayPrefix ?? null,
        spacedDefinitionsGap: panel.spacedDefinitionsGap ?? 0,
        comments: panel.comments ?? null,
        interpretation: panel.interpretation ?? null,
      },
      items,
      patient,
    });

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    // Byte-exact digital PDF (only when the builder explicitly opens the PDF tab
    // — never on every keystroke, to keep Puppeteer load off the hot path).
    if (format === 'pdf') {
      const pdf = await generateMergedReportPdf(snapshot, { mode: 'digital', baseUrl, qrDataUrl: '', cache: false });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Cache-Control', 'no-store');
      return res.send(pdf);
    }

    // HTML preview. 'letterhead' → the real physical/letterhead profile (header +
    // footer hidden as pre-printed stationery); everything else → the screen
    // profile (identical to the live staff report preview).
    const renderProfile = (profile === 'letterhead' || profile === 'pdf-physical') ? 'pdf-physical' : 'screen';
    const html = renderReportHtml(snapshot, { profile: renderProfile, baseUrl });
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.send(html);
  } catch (error: any) {
    console.error('Error rendering builder preview:', error);
    return res.status(500).json({ error: 'PREVIEW_FAILED', message: error.message });
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
        comments: panel.comments,
        interpretation: panel.interpretation,
        panelMethodText: panel.panelMethodText,
        panelMethodItalic: panel.panelMethodItalic,
        narrativeTemplateHtml: panel.narrativeTemplateHtml,
        spacedDefinitionsGap: panel.spacedDefinitionsGap,
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
        joinPrevious: item.joinPrevious,
        gridWidth: item.gridWidth,
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
