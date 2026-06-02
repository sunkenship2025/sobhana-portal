import { Router } from 'express';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';

const router = Router();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// GET /api/departments - List all departments
router.get('/', async (req: AuthRequest, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';

    const whereClause: any = {};
    if (!includeInactive) {
      whereClause.isActive = true;
    }

    const departments = await prisma.department.findMany({
      where: whereClause,
      include: {
        _count: {
          select: {
            labTests: true,
            panels: true,
            signingRules: true,
            testDefinitions: true,
            clinicalPanels: true,
          }
        }
      },
      orderBy: { displayOrder: 'asc' }
    });

    return res.json(departments);
  } catch (err: any) {
    console.error('List departments error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list departments'
    });
  }
});

// GET /api/departments/:id - Get single department with relations
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const department = await prisma.department.findUnique({
      where: { // @ts-ignore Prisma types
 id: req.params.id },
      include: {
        panels: {
          where: { // @ts-ignore Prisma types
 isActive: true },
          orderBy: { displayOrder: 'asc' },
        },
        signingRules: {
          where: { // @ts-ignore Prisma types
 isActive: true },
          include: { signingDoctor: true },
          orderBy: { displayOrder: 'asc' },
        },
        labTests: {
          where: { // @ts-ignore Prisma types
 isActive: true },
          orderBy: { displayOrder: 'asc' },
          select: { id: true, name: true, code: true, isPanel: true },
        },
        _count: {
          select: { labTests: true, panels: true, signingRules: true, testDefinitions: true, clinicalPanels: true }
        }
      }
    });

    if (!department) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Department not found'
      });
    }

    return res.json(department);
  } catch (err: any) {
    console.error('Get department error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to get department'
    });
  }
});

// POST /api/departments - Create department
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, reportHeaderText, displayOrder, showLabIncharge } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Department name is required'
      });
    }

    // Check duplicate name
    const existing = await prisma.department.findUnique({
      // @ts-ignore Prisma strict typing
      where: { // @ts-ignore Prisma types
 name: name.trim().toUpperCase() }
    });
    if (existing) {
      return res.status(409).json({
        error: 'DUPLICATE_NAME',
        message: `Department "${name}" already exists`
      });
    }

      // @ts-ignore Prisma strict typing
    const department = await prisma.department.create({
      // @ts-ignore Prisma strict typing
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        name: name.trim().toUpperCase(),
        reportHeaderText: reportHeaderText?.trim() || null,
        displayOrder: displayOrder ?? 0,
        ...(typeof showLabIncharge === 'boolean' ? { showLabIncharge } : {}),
      }
    });

    return res.status(201).json(department);
  } catch (err: any) {
    console.error('Create department error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create department'
    });
  }
});

// PATCH /api/departments/:id - Update department
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.department.findUnique({
      where: { // @ts-ignore Prisma types
 id: req.params.id }
    });
    if (!existing) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Department not found'
      });
    }

    const { name, reportHeaderText, displayOrder, isActive, showLabIncharge } = req.body;
    const updateData: any = {};

    if (name !== undefined) {
      const trimmed = name.trim().toUpperCase();
      // Check for duplicate name (excluding self)
      const duplicate = await prisma.department.findFirst({
        where: { // @ts-ignore Prisma types
 name: trimmed, id: { not: req.params.id } }
      });
      if (duplicate) {
        return res.status(409).json({
          error: 'DUPLICATE_NAME',
          message: `Department "${name}" already exists`
        });
      }
      updateData.name = trimmed;
    }

    if (reportHeaderText !== undefined) {
      updateData.reportHeaderText = reportHeaderText?.trim() || null;
    }
    if (displayOrder !== undefined) {
      updateData.displayOrder = displayOrder;
    }
    if (isActive !== undefined) {
      updateData.isActive = isActive;
    }
    if (typeof showLabIncharge === 'boolean') {
      updateData.showLabIncharge = showLabIncharge;
    }

    const updated = await prisma.department.update({
      where: { // @ts-ignore Prisma types
 id: req.params.id },
      data: // @ts-ignore
updateData,
    });

    return res.json(updated);
  } catch (err: any) {
    console.error('Update department error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to update department'
    });
  }
});

// DELETE /api/departments/:id - Soft-delete department
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.department.findUnique({
      where: { // @ts-ignore Prisma types
 id: req.params.id },
      include: { _count: { select: { labTests: true, panels: true, testDefinitions: true, clinicalPanels: true } } }
    });
    if (!existing) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Department not found'
      });
    }

    // Warn if department has active tests or panels
    if (existing._count.labTests > 0) {
      console.warn(`Deactivating department ${existing.name} with ${existing._count.labTests} linked tests`);
    }
    if (existing._count.panels > 0) {
      console.warn(`Deactivating department ${existing.name} with ${existing._count.panels} linked panels`);
    }

    const deactivated = await prisma.department.update({
      where: { // @ts-ignore Prisma types
 id: req.params.id },
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 isActive: false }
    });

    return res.json({
      id: deactivated.id,
      message: 'Department deactivated',
      linkedTestCount: existing._count.labTests,
      linkedPanelCount: existing._count.panels,
    });
  } catch (err: any) {
    console.error('Delete department error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to deactivate department'
    });
  }
});

export default router;
