import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── Helper: transform panel with counts ─────────────────────────────
function transformPanel(panel: any) {
  return {
    ...panel,
    testCount: panel._count?.testItems ?? panel.testItems?.length ?? 0,
    _count: undefined,
  };
}

// ─── GET /api/panels ─────────────────────────────────────────────────
// List all panel definitions with optional filters
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

    // Filter by active status (default: only active)
    if (active === 'all') {
      // no filter
    } else if (active === 'false') {
      where.isActive = false;
    } else {
      where.isActive = true;
    }

    const panels = await prisma.panelDefinition.findMany({
      where,
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { testItems: true } },
      },
      orderBy: [
        { department: { name: 'asc' } },
        { displayOrder: 'asc' },
        { name: 'asc' },
      ],
    });

    return res.json(panels.map(transformPanel));
  } catch (error) {
    console.error('Error fetching panels:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch panels' });
  }
});

// ─── GET /api/panels/:id ─────────────────────────────────────────────
// Get full panel detail including all test items
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const panel = await prisma.panelDefinition.findUnique({
      where: { // @ts-ignore Prisma types
 id: req.params.id },
      include: {
        department: { select: { id: true, name: true } },
        testItems: {
          include: {
            test: {
              select: {
                id: true,
                name: true,
                code: true,
                method: true,
                referenceUnit: true,
                sampleType: true,
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

    return res.json(panel);
  } catch (error) {
    console.error('Error fetching panel:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch panel' });
  }
});

// ─── POST /api/panels ────────────────────────────────────────────────
// Create a new panel definition
router.post('/', async (req: AuthRequest, res) => {
  try {
    const {
      name, displayName, departmentId, layoutType,
      displayOrder, showMethodColumn,
    } = req.body;

    if (!name || !displayName || !departmentId) {
      return res.status(400).json({
        error: 'MISSING_FIELDS',
        message: 'name, displayName, and departmentId are required',
      });
    }

    // Verify department exists
    const department = await prisma.department.findUnique({ where: { // @ts-ignore Prisma types
 id: departmentId } });
    if (!department) {
      return res.status(404).json({ error: 'DEPARTMENT_NOT_FOUND', message: 'Department not found' });
    }

    const panel = await prisma.panelDefinition.create({
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        name: name.trim().toUpperCase(),
        displayName: displayName.trim(),
        departmentId,
        layoutType: layoutType || 'TABLE',
        displayOrder: displayOrder ?? 0,
        showMethodColumn: showMethodColumn ?? false,
      },
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { testItems: true } },
      },
    });

    return res.status(201).json(transformPanel(panel));
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'DUPLICATE_NAME',
        message: 'A panel with this name already exists',
      });
    }
    console.error('Error creating panel:', error);
    return res.status(500).json({ error: 'CREATE_FAILED', message: 'Failed to create panel' });
  }
});

// ─── PATCH /api/panels/:id ───────────────────────────────────────────
// Update a panel definition (metadata only, not test items)
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const {
      displayName, departmentId, layoutType,
      displayOrder, showMethodColumn, isActive,
    } = req.body;

    const existing = await prisma.panelDefinition.findUnique({ where: { // @ts-ignore Prisma types
 id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    const data: // @ts-ignore
any = {};
    if (displayName !== undefined) data.displayName = displayName.trim();
    if (departmentId !== undefined) data.departmentId = departmentId;
    if (layoutType !== undefined) data.layoutType = layoutType;
    if (displayOrder !== undefined) data.displayOrder = displayOrder;
    if (showMethodColumn !== undefined) data.showMethodColumn = showMethodColumn;
    if (isActive !== undefined) data.isActive = isActive;

    const panel = await prisma.panelDefinition.update({
      where: { // @ts-ignore Prisma types
 id },
      data,
      include: {
        department: { select: { id: true, name: true } },
        _count: { select: { testItems: true } },
      },
    });

    return res.json(transformPanel(panel));
  } catch (error) {
    console.error('Error updating panel:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: 'Failed to update panel' });
  }
});

// ─── DELETE /api/panels/:id ──────────────────────────────────────────
// Soft-delete a panel (deactivates, keeps test items)
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.panelDefinition.findUnique({ where: { // @ts-ignore Prisma types
 id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel not found' });
    }

    await prisma.panelDefinition.update({
      where: { // @ts-ignore Prisma types
 id },
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 isActive: false },
    });

    return res.json({ message: 'Panel deactivated' });
  } catch (error) {
    console.error('Error deleting panel:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: 'Failed to delete panel' });
  }
});

// ═══════════════════════════════════════════════════════════════════════
//  PANEL TEST ITEMS — Nested sub-routes
// ═══════════════════════════════════════════════════════════════════════

// ─── GET /api/panels/:id/tests ──────────────────────────────────────
// List all test items in a panel
router.get('/:id/tests', async (req: AuthRequest, res) => {
  try {
    const panel = await prisma.panelDefinition.findUnique({
      where: { // @ts-ignore Prisma types
 id: req.params.id },
      select: { id: true },
    });

    if (!panel) {
      return res.status(404).json({ error: 'PANEL_NOT_FOUND', message: 'Panel not found' });
    }

    const items = await prisma.panelTestItem.findMany({
      where: { // @ts-ignore Prisma types
 panelId: req.params.id },
      include: {
        test: {
          select: {
            id: true,
            name: true,
            code: true,
            method: true,
            referenceUnit: true,
            sampleType: true,
          },
        },
      },
      orderBy: { displayOrder: 'asc' },
    });

    return res.json(items);
  } catch (error) {
    console.error('Error fetching panel tests:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: 'Failed to fetch panel tests' });
  }
});

// ─── POST /api/panels/:id/tests ─────────────────────────────────────
// Add a test to a panel
router.post('/:id/tests', async (req: AuthRequest, res) => {
  try {
    const { id: panelId } = req.params;
    const {
      testId, displayOrder, showMethod, methodText,
      indentLevel, isBold, isItalic, subGroup,
    } = req.body;

    if (!testId) {
      return res.status(400).json({ error: 'MISSING_FIELDS', message: 'testId is required' });
    }

    // Verify panel exists
    const panel = await prisma.panelDefinition.findUnique({ where: { // @ts-ignore Prisma types
 id: panelId } });
    if (!panel) {
      return res.status(404).json({ error: 'PANEL_NOT_FOUND', message: 'Panel not found' });
    }

    // Verify test exists
    const test = await prisma.labTest.findUnique({ where: { // @ts-ignore Prisma types
 id: testId } });
    if (!test) {
      return res.status(404).json({ error: 'TEST_NOT_FOUND', message: 'Lab test not found' });
    }

    const item = await prisma.panelTestItem.create({
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        panelId,
        testId,
        displayOrder: displayOrder ?? 0,
        showMethod: showMethod ?? false,
        methodText: methodText?.trim() || null,
        indentLevel: indentLevel ?? 0,
        isBold: isBold ?? false,
        isItalic: isItalic ?? false,
        subGroup: subGroup?.trim() || null,
      },
      include: {
        test: {
          select: { id: true, name: true, code: true, method: true, referenceUnit: true },
        },
      },
    });

    return res.status(201).json(item);
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'DUPLICATE_TEST',
        message: 'This test is already in the panel',
      });
    }
    console.error('Error adding test to panel:', error);
    return res.status(500).json({ error: 'CREATE_FAILED', message: 'Failed to add test to panel' });
  }
});

// ─── PATCH /api/panels/:id/tests/:itemId ────────────────────────────
// Update a test item's display properties
router.patch('/:id/tests/:itemId', async (req: AuthRequest, res) => {
  try {
    const { itemId } = req.params;
    const {
      displayOrder, showMethod, methodText,
      indentLevel, isBold, isItalic, subGroup,
    } = req.body;

    const existing = await prisma.panelTestItem.findUnique({ where: { // @ts-ignore Prisma types
 id: itemId } });
    if (!existing || existing.panelId !== req.params.id) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel test item not found' });
    }

    const data: // @ts-ignore
any = {};
    if (displayOrder !== undefined) data.displayOrder = displayOrder;
    if (showMethod !== undefined) data.showMethod = showMethod;
    if (methodText !== undefined) data.methodText = methodText?.trim() || null;
    if (indentLevel !== undefined) data.indentLevel = indentLevel;
    if (isBold !== undefined) data.isBold = isBold;
    if (isItalic !== undefined) data.isItalic = isItalic;
    if (subGroup !== undefined) data.subGroup = subGroup?.trim() || null;

    const item = await prisma.panelTestItem.update({
      where: { // @ts-ignore Prisma types
 id: itemId },
      data,
      include: {
        test: {
          select: { id: true, name: true, code: true, method: true, referenceUnit: true },
        },
      },
    });

    return res.json(item);
  } catch (error) {
    console.error('Error updating panel test item:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: 'Failed to update panel test item' });
  }
});

// ─── DELETE /api/panels/:id/tests/:itemId ───────────────────────────
// Remove a test from a panel (hard delete — not soft-delete)
router.delete('/:id/tests/:itemId', async (req: AuthRequest, res) => {
  try {
    const { itemId } = req.params;

    const existing = await prisma.panelTestItem.findUnique({ where: { // @ts-ignore Prisma types
 id: itemId } });
    if (!existing || existing.panelId !== req.params.id) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Panel test item not found' });
    }

    await prisma.panelTestItem.delete({ where: { // @ts-ignore Prisma types
 id: itemId } });

    return res.json({ message: 'Test removed from panel' });
  } catch (error) {
    console.error('Error removing test from panel:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: 'Failed to remove test from panel' });
  }
});

// ─── PUT /api/panels/:id/tests/reorder ──────────────────────────────
// Bulk-update display order for test items in a panel
router.put('/:id/tests/reorder', async (req: AuthRequest, res) => {
  try {
    const { id: panelId } = req.params;
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'items must be a non-empty array of { id, displayOrder }',
      });
    }

    // Verify panel exists
    const panel = await prisma.panelDefinition.findUnique({ where: { // @ts-ignore Prisma types
 id: panelId } });
    if (!panel) {
      return res.status(404).json({ error: 'PANEL_NOT_FOUND', message: 'Panel not found' });
    }

    await prisma.$transaction(
      items.map((item: { id: string; displayOrder: number }) =>
        prisma.panelTestItem.update({
          where: { // @ts-ignore Prisma types
 id: item.id },
          data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 displayOrder: item.displayOrder },
        })
      )
    );

    return res.json({ message: 'Test order updated', count: items.length });
  } catch (error) {
    console.error('Error reordering panel tests:', error);
    return res.status(500).json({ error: 'REORDER_FAILED', message: 'Failed to reorder panel tests' });
  }
});

// ─── PUT /api/panels/:id/tests/bulk ─────────────────────────────────
// Replace all test items in a panel (full sync)
router.put('/:id/tests/bulk', async (req: AuthRequest, res) => {
  try {
    const { id: panelId } = req.params;
    const { items } = req.body;

    if (!Array.isArray(items)) {
      return res.status(400).json({
        error: 'INVALID_INPUT',
        message: 'items must be an array of test item objects',
      });
    }

    // Verify panel exists
    const panel = await prisma.panelDefinition.findUnique({ where: { // @ts-ignore Prisma types
 id: panelId } });
    if (!panel) {
      return res.status(404).json({ error: 'PANEL_NOT_FOUND', message: 'Panel not found' });
    }

    // Atomic replace: delete all existing, create all new
    const result = await prisma.$transaction(async (tx) => {
      await tx.panelTestItem.deleteMany({ where: { // @ts-ignore Prisma types
 panelId } });

      if (items.length === 0) return [];

      const created = await Promise.all(
        items.map((item: any, index: number) =>
          tx.panelTestItem.create({
            data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

              panelId,
              testId: item.testId,
              displayOrder: item.displayOrder ?? index,
              showMethod: item.showMethod ?? false,
              methodText: item.methodText?.trim() || null,
              indentLevel: item.indentLevel ?? 0,
              isBold: item.isBold ?? false,
              isItalic: item.isItalic ?? false,
              subGroup: item.subGroup?.trim() || null,
            },
            include: {
              test: {
                select: { id: true, name: true, code: true },
              },
            },
          })
        )
      );

      return created;
    });

    return res.json({ message: 'Panel tests updated', count: result.length, items: result });
  } catch (error: any) {
    if (error.code === 'P2002') {
      return res.status(409).json({
        error: 'DUPLICATE_TEST',
        message: 'Duplicate test found in items list',
      });
    }
    console.error('Error bulk updating panel tests:', error);
    return res.status(500).json({ error: 'BULK_UPDATE_FAILED', message: 'Failed to bulk update panel tests' });
  }
});

export default router;
