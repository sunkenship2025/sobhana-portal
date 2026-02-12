import { Router } from 'express';
import { PrismaClient } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';

const router = Router();
const prisma = new PrismaClient();

// All routes require auth + branch context
router.use(authMiddleware);
router.use(branchContextMiddleware);

// GET /api/lab-tests - List all lab tests
router.get('/', async (req: AuthRequest, res) => {
  try {
    const includeInactive = req.query.includeInactive === 'true';
    const includeSubTests = req.query.includeSubTests === 'true';
    
    const whereClause: any = {};
    if (!includeInactive) {
      whereClause.isActive = true;
    }
    // By default, only return top-level tests (panels and standalone tests)
    // Sub-tests are fetched as part of their parent panel
    if (!includeSubTests) {
      whereClause.parentTestId = null;
    }
    
    const tests = await prisma.labTest.findMany({
      where: whereClause,
      orderBy: { name: 'asc' }
    });
    
    // Transform to match frontend expectations
    const transformed = tests.map(test => ({
      id: test.id,
      name: test.name,
      code: test.code,
      priceInPaise: test.priceInPaise, // Keep in paise for frontend
      isPanel: test.isPanel,
      referenceRange: {
        min: test.referenceMin || 0,
        max: test.referenceMax || 0,
        unit: test.referenceUnit || ''
      },
      isActive: test.isActive
    }));
    
    return res.json(transformed);
  } catch (err: any) {
    console.error('List lab tests error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to list lab tests'
    });
  }
});

// POST /api/lab-tests - Create lab test
router.post('/', async (req: AuthRequest, res) => {
  try {
    const { name, code, price, referenceRange } = req.body;

    if (!name || !code || price === undefined) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'Name, code, and price are required'
      });
    }

    // Check for duplicate code
    const existing = await prisma.labTest.findUnique({
      where: { code: code.toUpperCase() }
    });
    
    if (existing) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Test with code ${code.toUpperCase()} already exists`
      });
    }

    const test = await prisma.labTest.create({
      data: {
        name,
        code: code.toUpperCase(),
        priceInPaise: Math.round(price * 100), // Convert rupees to paise
        referenceMin: referenceRange?.min || null,
        referenceMax: referenceRange?.max || null,
        referenceUnit: referenceRange?.unit || null,
        isActive: true
      }
    });

    return res.status(201).json({
      id: test.id,
      name: test.name,
      code: test.code,
      price: test.priceInPaise / 100,
      referenceRange: {
        min: test.referenceMin || 0,
        max: test.referenceMax || 0,
        unit: test.referenceUnit || ''
      },
      isActive: test.isActive
    });
  } catch (err: any) {
    console.error('Create lab test error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to create lab test'
    });
  }
});

// PATCH /api/lab-tests/:id - Update lab test
router.patch('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;
    const { name, code, price, referenceRange } = req.body;

    // Check if test exists
    const existing = await prisma.labTest.findUnique({
      where: { id }
    });
    
    if (!existing) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Lab test not found'
      });
    }

    // Check for duplicate code if code is being changed
    if (code && code.toUpperCase() !== existing.code) {
      const duplicate = await prisma.labTest.findUnique({
        where: { code: code.toUpperCase() }
      });
      
      if (duplicate) {
        return res.status(409).json({
          error: 'CONFLICT',
          message: `Test with code ${code.toUpperCase()} already exists`
        });
      }
    }

    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (code !== undefined) updateData.code = code.toUpperCase();
    if (price !== undefined) updateData.priceInPaise = Math.round(price * 100);
    if (referenceRange?.min !== undefined) updateData.referenceMin = referenceRange.min;
    if (referenceRange?.max !== undefined) updateData.referenceMax = referenceRange.max;
    if (referenceRange?.unit !== undefined) updateData.referenceUnit = referenceRange.unit;

    const updated = await prisma.labTest.update({
      where: { id },
      data: updateData
    });

    return res.json({
      id: updated.id,
      name: updated.name,
      code: updated.code,
      price: updated.priceInPaise / 100,
      referenceRange: {
        min: updated.referenceMin || 0,
        max: updated.referenceMax || 0,
        unit: updated.referenceUnit || ''
      },
      isActive: updated.isActive
    });
  } catch (err: any) {
    console.error('Update lab test error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to update lab test'
    });
  }
});

// DELETE /api/lab-tests/:id - Deactivate lab test
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const { id } = req.params;

    const existing = await prisma.labTest.findUnique({
      where: { id }
    });
    
    if (!existing) {
      return res.status(404).json({
        error: 'NOT_FOUND',
        message: 'Lab test not found'
      });
    }

    const updated = await prisma.labTest.update({
      where: { id },
      data: { isActive: false }
    });

    return res.json({
      id: updated.id,
      message: 'Lab test deactivated'
    });
  } catch (err: any) {
    console.error('Deactivate lab test error:', err);
    return res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: 'Failed to deactivate lab test'
    });
  }
});

export default router;
