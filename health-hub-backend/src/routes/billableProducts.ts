/**
 * Billable Products Routes
 * 
 * Endpoints for commercial product management.
 * Products are decoupled from clinical definitions — purely commercial.
 * 
 * GET    /api/billable-products              — List products
 * POST   /api/billable-products/export       — Price-list Excel (all or selected ids)
 * GET    /api/billable-products/:id          — Get product detail
 * POST   /api/billable-products              — Create product
 * PUT    /api/billable-products/:id          — Update product
 * PATCH  /api/billable-products/:id          — Toggle active/inactive
 * GET    /api/billable-products/:id/pricing  — Get branch pricing
 * PUT    /api/billable-products/:id/pricing  — Set branch pricing
 */

import { Router } from 'express';
import { DiagnosticWorkflowMode } from '@prisma/client';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { branchContextMiddleware } from '../middleware/branch';
import prisma from '../lib/prisma';
import { buildPriceListWorkbook } from '../services/productExportService';
const router = Router();

router.use(authMiddleware);
router.use(branchContextMiddleware);

// ─── Code format validation ───────────────────────────────────────────
const CODE_REGEX = /^[A-Z0-9_]{2,20}$/;

// ─── Cycle check ──────────────────────────────────────────────────────
// Walks the child-product graph downward from `startId`. Returns true if
// `targetId` is reachable — used to reject `parent → child` lines that
// would create a cycle (parent already inside child's subtree).
async function reachesProduct(startId: string, targetId: string): Promise<boolean> {
  if (startId === targetId) return true;
  const visited = new Set<string>([startId]);
  const queue: string[] = [startId];
  while (queue.length) {
    const current = queue.shift()!;
    const links = await prisma.billableProductPanel.findMany({
      where: { productId: current, childProductId: { not: null } },
      select: { childProductId: true },
    });
    for (const link of links) {
      const next = link.childProductId;
      if (!next || visited.has(next)) continue;
      if (next === targetId) return true;
      visited.add(next);
      queue.push(next);
    }
  }
  return false;
}

// ─── Line-item validation ─────────────────────────────────────────────
// Each line points at exactly one of: a clinical panel, OR a child product.
// Returns null if valid, or an error message string.
function validateLineShape(p: any, idx: number): string | null {
  const hasPanel = !!p?.panelId;
  const hasChild = !!p?.childProductId;
  if (hasPanel === hasChild) {
    return `panels[${idx}] must specify exactly one of panelId or childProductId`;
  }
  return null;
}

// ─── Helper ──────────────────────────────────────────────────────────
function normalizePayoutCategory(v: any): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length ? t : null;
}

function transformProduct(product: any) {
  return {
    ...product,
    // Frontend-friendly derived fields
    productType: product.isBundle ? 'PANEL_BUNDLE' : 'INDIVIDUAL_TEST',
    basePrice: (product.basePriceInPaise ?? 0) / 100,
    panelCount: product.panels?.length ?? product._count?.panels ?? 0,
    hasBranchPricing: (product._count?.branchPricing ?? 0) > 0,
    workflowMode: product.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE,
  };
}

function withResolvedPrice(product: any, branchPriceInPaise?: number | null) {
  const effectivePriceInPaise = branchPriceInPaise ?? product.basePriceInPaise ?? 0;

  return {
    ...transformProduct(product),
    effectivePriceInPaise,
    effectivePrice: effectivePriceInPaise / 100,
    priceSource: branchPriceInPaise != null ? 'BRANCH_OVERRIDE' : 'BASE',
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
    const { search, active, isBundle, workflowMode } = req.query;
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

    if (workflowMode && typeof workflowMode === 'string') {
      where.workflowMode = workflowMode;
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
        ...withResolvedPrice(p, branchPrice),
        branchPricing: undefined, // Don't leak raw pricing array
      };
    });

    return res.json(result);
  } catch (error: any) {
    console.error('Error listing billable products:', error);
    return res.status(500).json({ error: 'FETCH_FAILED', message: error.message });
  }
});

// ─── POST /export — price-list Excel (all active, or the selected ids) ─────
router.post('/export', async (req: AuthRequest, res) => {
  try {
    const branchId = (req as any).branchId;
    const idsRaw = req.body?.ids;
    const ids = Array.isArray(idsRaw)
      ? idsRaw.filter((x: any) => typeof x === 'string').slice(0, 5000)
      : [];

    const products = await prisma.billableProduct.findMany({
      where: ids.length ? { id: { in: ids } } : { isActive: true },
      include: {
        branchPricing: branchId ? {
          where: { branchId, isActive: true },
          select: { priceInPaise: true },
        } : false,
      },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });

    const rows = products.map(p => ({
      code: p.code,
      name: p.name,
      isBundle: p.isBundle,
      priceInPaise: p.branchPricing?.[0]?.priceInPaise ?? p.basePriceInPaise ?? 0,
    }));

    const branch = branchId
      ? await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } })
      : null;

    const buffer = await buildPriceListWorkbook(rows, branch?.name);
    const filename = `price-list-${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(buffer);
  } catch (error: any) {
    console.error('Error exporting price list:', error);
    return res.status(500).json({ error: 'EXPORT_FAILED', message: error.message });
  }
});

// ─── POST /quick-create-bill-only — Fast inline creation for visit entry ───
router.post('/quick-create-bill-only', async (req: AuthRequest, res) => {
  try {
    const {
      name,
      code,
      description,
      basePriceInPaise: rawPriceInPaise,
      basePrice,
      displayOrder,
    } = req.body;

    const resolvedPriceInPaise =
      rawPriceInPaise ?? (basePrice != null ? Math.round(basePrice * 100) : undefined);

    if (!name || !code || resolvedPriceInPaise === undefined) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'name, code, and basePriceInPaise (or basePrice) are required',
      });
    }

    // Apply the same code-format check as the regular POST path. Without
    // this, the quick path lets in lowercase / special-char codes that the
    // rest of the codebase assumes are uppercase alphanumeric.
    const normalizedCode = String(code).trim().toUpperCase();
    if (!CODE_REGEX.test(normalizedCode)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'code must be 2-20 uppercase alphanumeric characters or underscores (e.g. CBC_PANEL)',
      });
    }
    if (!Number.isFinite(resolvedPriceInPaise) || !Number.isInteger(resolvedPriceInPaise) || resolvedPriceInPaise < 0) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'basePriceInPaise must be a non-negative integer',
      });
    }

    const product = await prisma.billableProduct.create({
      data: {
        name: String(name).trim(),
        code: normalizedCode,
        description: description ?? null,
        basePriceInPaise: resolvedPriceInPaise,
        isBundle: false,
        workflowMode: DiagnosticWorkflowMode.BILL_ONLY,
        displayOrder: displayOrder ?? 0,
      },
      include: {
        panels: true,
      },
    });

    return res.status(201).json(withResolvedPrice(product));
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Product code "${req.body.code}" already exists`,
      });
    }
    console.error('Error quick-creating bill-only product:', error);
    return res.status(500).json({ error: 'CREATE_FAILED', message: error.message });
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
            childProduct: {
              select: {
                id: true, name: true, code: true,
                workflowMode: true, basePriceInPaise: true, isActive: true,
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

    return res.json(withResolvedPrice(product));
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
      workflowMode,
      payoutCategory,
      displayOrder, panels,
    } = req.body;

    // Accept either basePriceInPaise (paise) or basePrice (rupees)
    const resolvedPriceInPaise = rawPriceInPaise ?? (basePrice != null ? Math.round(basePrice * 100) : undefined);
    // Accept either isBundle (boolean) or productType (string)
    const resolvedIsBundle = rawIsBundle ?? (productType === 'PANEL_BUNDLE' || productType === 'CUSTOM_PACKAGE');
    const resolvedWorkflowMode = workflowMode ?? DiagnosticWorkflowMode.REPORTABLE;

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

    // Validate each line points at exactly one of panel/child product
    if (panels?.length) {
      for (const [idx, p] of panels.entries()) {
        const err = validateLineShape(p, idx);
        if (err) return res.status(400).json({ error: 'VALIDATION_ERROR', message: err });
      }
    }

    // Validate line counts based on workflow mode and product type
    const resolvedProductType = productType ?? (resolvedIsBundle ? 'PANEL_BUNDLE' : 'INDIVIDUAL_TEST');
    if (
      resolvedWorkflowMode === DiagnosticWorkflowMode.REPORTABLE &&
      resolvedProductType === 'INDIVIDUAL_TEST' &&
      panels &&
      panels.length > 1
    ) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'INDIVIDUAL_TEST products can have at most 1 panel',
      });
    }
    if (
      resolvedWorkflowMode === DiagnosticWorkflowMode.REPORTABLE &&
      (!panels || panels.length < 1)
    ) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'REPORTABLE products must have at least 1 line item (panel or sub-product)',
      });
    }
    // EXTERNAL_UPLOAD products carry their result as a PDF, not as panel-linked tests.
    // Reject any attempt to attach lines to them so the data model stays clean.
    if (
      resolvedWorkflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD &&
      panels &&
      panels.length > 0
    ) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'EXTERNAL_UPLOAD products do not support linked panels or sub-products',
      });
    }

    // Validate panel references
    const panelIds = (panels ?? []).filter((p: any) => p.panelId).map((p: any) => p.panelId);
    if (panelIds.length) {
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

    // Validate child-product references
    const childProductIds = (panels ?? []).filter((p: any) => p.childProductId).map((p: any) => p.childProductId);
    if (childProductIds.length) {
      const found = await prisma.billableProduct.findMany({
        where: { id: { in: childProductIds } },
        select: { id: true },
      });
      const foundIds = new Set(found.map((p: any) => p.id));
      const missing = childProductIds.filter((id: string) => !foundIds.has(id));
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `Sub-products not found: ${missing.join(', ')}`,
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
        workflowMode: resolvedWorkflowMode,
        payoutCategory: normalizePayoutCategory(payoutCategory),
        displayOrder: displayOrder ?? 0,
        panels: panels?.length ? {
          create: panels.map((p: any, idx: number) => ({
            panelId: p.panelId ?? null,
            childProductId: p.childProductId ?? null,
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
            childProduct: {
              select: { id: true, name: true, code: true, workflowMode: true, basePriceInPaise: true },
            },
            testDefinition: {
              select: { id: true, name: true, code: true, version: true },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
      },
    });

    return res.status(201).json(withResolvedPrice(product));
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
      name, description, code,
      basePriceInPaise: rawPriceInPaise, basePrice,
      isBundle: rawIsBundle, productType,
      workflowMode,
      payoutCategory,
      displayOrder, panels,
    } = req.body;

    // Accept either field naming
    const resolvedPriceInPaise = rawPriceInPaise ?? (basePrice != null ? Math.round(basePrice * 100) : undefined);
    const resolvedIsBundle = rawIsBundle ?? (productType != null ? (productType === 'PANEL_BUNDLE' || productType === 'CUSTOM_PACKAGE') : undefined);

    if (code !== undefined && !CODE_REGEX.test(code)) {
      return res.status(400).json({
        error: 'VALIDATION_ERROR',
        message: 'code must be 2-20 uppercase alphanumeric characters or underscores (e.g. CBC_PANEL)',
      });
    }

    const existing = await prisma.billableProduct.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Product not found' });
    }

    const resolvedWorkflowMode = workflowMode ?? existing.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE;

    // Validate each line points at exactly one of panel/child product
    if (panels !== undefined) {
      for (const [idx, p] of panels.entries()) {
        const err = validateLineShape(p, idx);
        if (err) return res.status(400).json({ error: 'VALIDATION_ERROR', message: err });
      }
    }

    // Validate line counts based on effective product type
    if (panels !== undefined) {
      const effectiveIsBundle = resolvedIsBundle ?? existing.isBundle;
      const effectiveType = productType ?? (effectiveIsBundle ? 'PANEL_BUNDLE' : 'INDIVIDUAL_TEST');
      if (
        resolvedWorkflowMode === DiagnosticWorkflowMode.REPORTABLE &&
        effectiveType === 'INDIVIDUAL_TEST' &&
        panels.length > 1
      ) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'INDIVIDUAL_TEST products can have at most 1 panel',
        });
      }
      if (
        resolvedWorkflowMode === DiagnosticWorkflowMode.REPORTABLE &&
        panels.length < 1
      ) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'REPORTABLE products must have at least 1 line item (panel or sub-product)',
        });
      }
      if (
        resolvedWorkflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD &&
        panels.length > 0
      ) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'EXTERNAL_UPLOAD products do not support linked panels or sub-products',
        });
      }
    }

    // Validate panel references
    const panelIds = (panels ?? []).filter((p: any) => p.panelId).map((p: any) => p.panelId);
    if (panelIds.length) {
      const found = await prisma.clinicalPanel.findMany({
        where: { id: { in: panelIds } },
        select: { id: true },
      });
      const foundIds = new Set(found.map((p: any) => p.id));
      const missing = panelIds.filter((panelId: string) => !foundIds.has(panelId));
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `Clinical panels not found: ${missing.join(', ')}`,
        });
      }
    }

    // Validate child-product references + cycle check
    const childProductIds = (panels ?? []).filter((p: any) => p.childProductId).map((p: any) => p.childProductId);
    if (childProductIds.length) {
      // No self-reference
      if (childProductIds.includes(req.params.id)) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: 'A product cannot include itself as a sub-product',
        });
      }

      const found = await prisma.billableProduct.findMany({
        where: { id: { in: childProductIds } },
        select: { id: true },
      });
      const foundIds = new Set(found.map((p: any) => p.id));
      const missing = childProductIds.filter((id: string) => !foundIds.has(id));
      if (missing.length > 0) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `Sub-products not found: ${missing.join(', ')}`,
        });
      }

      // Cycle check: each candidate child must not transitively contain `this`
      for (const childId of childProductIds) {
        if (await reachesProduct(childId, req.params.id)) {
          return res.status(400).json({
            error: 'VALIDATION_ERROR',
            message: `Adding sub-product ${childId} would create a cycle`,
          });
        }
      }
    }

    const product = await prisma.$transaction(async (tx) => {
      // Replace panel links if provided
      if (panels) {
        await tx.billableProductPanel.deleteMany({ where: { productId: req.params.id } });
      }
      // EXTERNAL_UPLOAD never carries panels; clear stale links if the workflow
      // was just switched (panel field omitted in the request body).
      else if (resolvedWorkflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD) {
        await tx.billableProductPanel.deleteMany({ where: { productId: req.params.id } });
      }

      return tx.billableProduct.update({
        where: { id: req.params.id },
        data: {
          name: name ?? existing.name,
          code: code ?? existing.code,
          description: description !== undefined ? description : existing.description,
          basePriceInPaise: resolvedPriceInPaise ?? existing.basePriceInPaise,
          isBundle: resolvedIsBundle ?? existing.isBundle,
          workflowMode: resolvedWorkflowMode,
          payoutCategory:
            payoutCategory !== undefined
              ? normalizePayoutCategory(payoutCategory)
              : existing.payoutCategory,
          displayOrder: displayOrder ?? existing.displayOrder,
          panels: panels ? {
            create: panels.map((p: any, idx: number) => ({
              panelId: p.panelId ?? null,
              childProductId: p.childProductId ?? null,
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
              childProduct: {
                select: { id: true, name: true, code: true, workflowMode: true, basePriceInPaise: true },
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

    return res.json(withResolvedPrice(product));
  } catch (error: any) {
    console.error('Error updating billable product:', error);
    if (error.code === 'P2002') {
      return res.status(409).json({ error: 'CONFLICT', message: `Product code already exists` });
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

    const product = await prisma.billableProduct.update({
      where: { id: req.params.id },
      data: { isActive },
      include: { _count: { select: { panels: true } } },
    });

    return res.json(withResolvedPrice(product));
  } catch (error: any) {
    console.error('Error toggling product:', error);
    return res.status(500).json({ error: 'UPDATE_FAILED', message: error.message });
  }
});

// ─── DELETE /:id — Delete product ────────────────────────────────────
// Hard-delete is only safe for products with NO historical TestOrder
// references. If any past visit ordered this product, hard-deleting would
// break the bill receipt for that visit (FK Restrict → 500, or FK SetNull →
// silent data loss). Falls back to soft-delete (isActive=false) so admins
// have a recoverable path.
router.delete('/:id', async (req: AuthRequest, res) => {
  try {
    const existing = await prisma.billableProduct.findUnique({ where: { id: req.params.id } });
    if (!existing) {
      return res.status(404).json({ error: 'NOT_FOUND', message: 'Product not found' });
    }

    const orderRefCount = await prisma.testOrder.count({
      where: { productId: req.params.id },
    });

    if (orderRefCount > 0) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Cannot hard-delete: ${orderRefCount} historical test order(s) reference this product. Deactivate it instead via PATCH /:id { isActive: false }.`,
        referenceCount: orderRefCount,
      });
    }

    // Block hard-delete if this product is a sub-product of any package.
    // The FK is Restrict, so a delete would fail anyway, but a clean 409 is
    // friendlier than a generic 500.
    const childRefCount = await prisma.billableProductPanel.count({
      where: { childProductId: req.params.id },
    });

    if (childRefCount > 0) {
      return res.status(409).json({
        error: 'CONFLICT',
        message: `Cannot hard-delete: this product is a sub-product of ${childRefCount} package(s). Remove it from those packages first, or deactivate it instead.`,
        referenceCount: childRefCount,
      });
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

    // Validate every entry up front so a malformed row doesn't half-apply
    // (the $transaction would abort, but Prisma's error mapping is messy).
    for (const [index, p] of (pricing as any[]).entries()) {
      if (!p || typeof p.branchId !== 'string' || !p.branchId) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `pricing[${index}].branchId must be a non-empty string`,
        });
      }
      if (
        !Number.isFinite(p.priceInPaise) ||
        !Number.isInteger(p.priceInPaise) ||
        p.priceInPaise < 0
      ) {
        return res.status(400).json({
          error: 'VALIDATION_ERROR',
          message: `pricing[${index}].priceInPaise must be a non-negative integer`,
        });
      }
    }

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
