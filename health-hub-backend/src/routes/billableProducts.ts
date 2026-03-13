/**
 * Billable Products Routes
 * 
 * Endpoints for commercial product management.
 * Products are decoupled from clinical definitions — purely commercial.
 * 
 * GET    /api/billable-products              — List products
 * GET    /api/billable-products/:id          — Get product detail
 * POST   /api/billable-products              — Create product
 * PUT    /api/billable-products/:id          — Update product
 * PATCH  /api/billable-products/:id          — Toggle active/inactive
 * GET    /api/billable-products/:id/pricing  — Get branch pricing
 * PUT    /api/billable-products/:id/pricing  — Set branch pricing
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
function transformProduct(product: any) {
  return {
    ...product,
    // Frontend-friendly derived fields
    productType: product.isBundle ? 'PANEL_BUNDLE' : 'INDIVIDUAL_TEST',
    basePrice: (product.basePriceInPaise ?? 0) / 100,
    panelCount: product.panels?.length ?? product._count?.panels ?? 0,
    hasBranchPricing: (product._count?.branchPricing ?? 0) > 0,
  };
}

// ─── GET /check-code — Real-time code uniqueness check ───────────────
router.get('/check-code', async (req: AuthRequest, res) => {
  try {
    const { code } = req.query;
    if (!code || typeof code !== 'string') {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'code query parameter is required' });
    }
    const existing = await prisma.billableProduct.findUnique({
      where: { code: code.toUpperCase() },
      select: { id: true },
    });
    return res.json({ available: !existing });
  } catch (error: any) {
    console.error('Error checking code:', error);
    return res.status(500).json({ error: 'CHECK_FAILED', message: error.message });
  }
});

// ─── GET / — List products ───────────────────────────────────────────
router.get('/', async (req: AuthRequest, res) => {
  try {
    const { search, active, isBundle } = req.query;
    const branchId = (req as any).branchId;

    const where: any = {};

    if (search && typeof search === 'string') {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { code: { contains: search, mode: 'insensitive' } },
      ];
    }

    if (active === 'all') {
      // no filter
    } else if (active === 'false') {
      where.isActive = false;
    } else {
      where.isActive = true;
    }

    if (isBundle !== undefined) {
      where.isBundle = isBundle === 'true';
    }

    const products = await prisma.billableProduct.findMany({
      where,
      include: {
        _count: { select: { panels: true, branchPricing: true } },
        branchPricing: branchId ? {
          where: { branchId, isActive: true },
          select: { priceInPaise: true },
        } : false,
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });

    // Compute effective price (branch override or base)
    const result = products.map(p => {
      const branchPrice = p.branchPricing?.[0]?.priceInPaise;
      return {
        ...transformProduct(p),
        effectivePriceInPaise: branchPrice ?? p.basePriceInPaise,
        effectivePrice: (branchPrice ?? p.basePriceInPaise) / 100,
        priceSource: branchPrice ? 'BRANCH_OVERRIDE' : 'BASE',
        branchPricing: undefined, // Don't leak raw pricing array
      };
    });

    return res.json(result);
  } catch (error: any) {
    console.error('Error listing billable products:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── GET /:id — Get product detail ───────────────────────────────────
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const product = await prisma.billableProduct.findUnique({
      where: { id: req.params.id },
      include: {
        panels: {
          include: {
            panel: {
              select: {
                id: true, name: true, displayName: true,
                layoutType: true, departmentId: true, displayOrder: true,
                items: {
                  include: {
                    testDefinition: {
                      select: {
                        id: true, name: true, code: true,
                        version: true, status: true, sampleType: true, method: true,
                      },
                    },
                  },
                  orderBy: { displayOrder: 'asc' },
                },
              },
            },
            testDefinition: {
              select: { id: true, name: true, code: true, version: true, status: true },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
        branchPricing: {
          include: {
            branch: { select: { id: true, name: true, code: true } },
          },
        },
      },
    });

    if (!product) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Product not found' });
    }

    return res.json(transformProduct(product));
  } catch (error: any) {
    console.error('Error fetching billable product:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── POST / — Create product ─────────────────────────────────────────
router.post('/', async (req: AuthRequest, res) => {
  try {
    const {
      name, code, description,
      basePriceInPaise: rawPriceInPaise, basePrice,
      isBundle: rawIsBundle, productType,
      displayOrder, panels,
    } = req.body;

    // Accept either basePriceInPaise (paise) or basePrice (rupees)
    const resolvedPriceInPaise = rawPriceInPaise ?? (basePrice != null ? Math.round(basePrice * 100) : undefined);
    // Accept either isBundle (boolean) or productType (string)
    const resolvedIsBundle = rawIsBundle ?? (productType === 'PANEL_BUNDLE' || productType === 'CUSTOM_PACKAGE');

    if (!name || !code || resolvedPriceInPaise === undefined) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'name, code, and basePriceInPaise (or basePrice) are required',
      });
    }

    // Validate code format
    if (!CODE_REGEX.test(code)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'code must be 2-20 uppercase alphanumeric characters or underscores (e.g. CBC_PANEL)',
      });
    }

    // Validate panel count based on product type
    const resolvedProductType = productType ?? (resolvedIsBundle ? 'PANEL_BUNDLE' : 'INDIVIDUAL_TEST');
    if (resolvedProductType === 'INDIVIDUAL_TEST' && panels && panels.length > 1) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'INDIVIDUAL_TEST products can have at most 1 panel',
      });
    }
    if (resolvedProductType === 'PANEL_BUNDLE' && (!panels || panels.length < 1)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'PANEL_BUNDLE products must have at least 1 panel',
      });
    }

    // Validate panels reference existing ClinicalPanels
    if (panels?.length) {
      const panelIds = panels.map((p: any) => p.panelId);
      const found = await prisma.clinicalPanel.findMany({
        where: { id: { in: panelIds } },
        select: { id: true },
      });

      const foundIds = new Set(found.map((p: any) => p.id));
      const missing = panelIds.filter((id: string) => !foundIds.has(id));
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `Clinical panels not found: ${missing.join(', ')}`,
        });
      }
    }

    const product = await prisma.billableProduct.create({
      data: {
        name,
        code,
        description: description ?? null,
        basePriceInPaise: resolvedPriceInPaise,
        isBundle: resolvedIsBundle,
        displayOrder: displayOrder ?? 0,
        panels: panels?.length ? {
          create: panels.map((p: any, idx: number) => ({
            panelId: p.panelId,
            testDefinitionId: p.testDefinitionId ?? null,
            displayOrder: p.displayOrder ?? idx,
          })),
        } : undefined,
      },
      include: {
        panels: {
          include: {
            panel: {
              select: { id: true, name: true, displayName: true },
            },
            testDefinition: {
              select: { id: true, name: true, code: true, version: true },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    return res.status(201).json(transformProduct(product));
  } catch (error: any) {
    console.error('Error creating billable product:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'CONFLICT', message: `Product code "${req.body.code}" already exists` });
    }
    return res.status(500).json({ error: 'CREATE_FAILED', message: error.message });
  }
});

// ─── PUT /:id — Update product ───────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res) => {
  try {
    const {
      name, description,
      basePriceInPaise: rawPriceInPaise, basePrice,
      isBundle: rawIsBundle, productType,
      displayOrder, panels,
    } = req.body;

    // Accept either field naming
    const resolvedPriceInPaise = rawPriceInPaise ?? (basePrice != null ? Math.round(basePrice * 100) : undefined);
    const resolvedIsBundle = rawIsBundle ?? (productType != null ? (productType === 'PANEL_BUNDLE' || productType === 'CUSTOM_PACKAGE') : undefined);

    const existing = await prisma.billableProduct.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Product not found' });
    }

    // Validate panel count based on effective product type
    if (panels !== undefined) {
      const effectiveIsBundle = resolvedIsBundle ?? existing.isBundle;
      const effectiveType = productType ?? (effectiveIsBundle ? 'PANEL_BUNDLE' : 'INDIVIDUAL_TEST');
      if (effectiveType === 'INDIVIDUAL_TEST' && panels.length > 1) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'INDIVIDUAL_TEST products can have at most 1 panel',
        });
      }
      if (effectiveType === 'PANEL_BUNDLE' && panels.length < 1) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'PANEL_BUNDLE products must have at least 1 panel',
        });
      }
    }

    const product = await prisma.$transaction(async (tx) => {
      // Replace panel links if provided
      if (panels) {
        await tx.billableProductPanel.deleteMany({ where: { productId: req.params.id } });
      }

      return tx.billableProduct.update({
        where: { id: req.params.id },
        data: {
          name: name ?? existing.name,
          description: description !== undefined ? description : existing.description,
          basePriceInPaise: resolvedPriceInPaise ?? existing.basePriceInPaise,
          isBundle: resolvedIsBundle ?? existing.isBundle,
          displayOrder: displayOrder ?? existing.displayOrder,
          panels: panels ? {
            create: panels.map((p: any, idx: number) => ({
              panelId: p.panelId,
              testDefinitionId: p.testDefinitionId ?? null,
              displayOrder: p.displayOrder ?? idx,
            })),
          } : undefined,
        },
        include: {
          panels: {
            include: {
              panel: {
                select: { id: true, name: true, displayName: true },
              },
              testDefinition: {
                select: { id: true, name: true, code: true, version: true },
              },
            },
            orderBy: { displayOrder: 'asc' },
          },
        },
      });
    });

    return res.json(transformProduct(product));
  } catch (error: any) {
    console.error('Error updating billable product:', error);
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

    const product = await prisma.billableProduct.update({
      where: { id: req.params.id },
      data: { isActive },
      include: { _count: { select: { panels: true } } },
    });

    return res.json(transformProduct(product));
  } catch (error: any) {
    console.error('Error toggling product:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: error.message });
  }
});

// ─── DELETE /:id — Delete product ────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.billableProduct.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Product not found' });
    }

    await prisma.$transaction([
      prisma.billableProductPanel.deleteMany({ where: { productId: req.params.id } }),
      prisma.productBranchPricing.deleteMany({ where: { productId: req.params.id } }),
      prisma.billableProduct.delete({ where: { id: req.params.id } }),
    ]);

    return res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting product:', error);
    return res.status(500).json({ error: 'DELETE_FAILED', message: error.message });
  }
});

// ─── GET /:id/pricing — Get branch pricing ───────────────────────────
router.get('/:id/pricing', async (req: AuthRequest, res) => {
  try {
    const pricing = await prisma.productBranchPricing.findMany({
      where: { productId: req.params.id },
      include: {
        branch: { select: { id: true, name: true, code: true } },
      },
      orderBy: { branch: { name: 'asc' } },
    });

    return res.json(pricing);
  } catch (error: any) {
    console.error('Error fetching pricing:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── PUT /:id/pricing — Set/update branch pricing ────────────────────
router.put('/:id/pricing', async (req: AuthRequest, res) => {
  try {
    const { pricing } = req.body;
    // pricing: [{ branchId, priceInPaise, isActive }]

    if (!Array.isArray(pricing)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'pricing array is required' });
    }

    const productId = req.params.id;

    const results = await prisma.$transaction(
      pricing.map((p: any) =>
        prisma.productBranchPricing.upsert({
          where: {
            productId_branchId: { productId, branchId: p.branchId },
          },
          create: {
            productId,
            branchId: p.branchId,
            priceInPaise: p.priceInPaise,
            isActive: p.isActive ?? true,
          },
          update: {
            priceInPaise: p.priceInPaise,
            isActive: p.isActive ?? true,
          },
        })
      )
    );

    return res.json(results);
  } catch (error: any) {
    console.error('Error updating pricing:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: error.message });
  }
});

export default router;
