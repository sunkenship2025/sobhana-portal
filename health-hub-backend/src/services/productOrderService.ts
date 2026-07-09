/**
 * productOrderService.ts
 * 
 * Resolves BillableProduct IDs into the data needed to create TestOrders.
 * Bridges the product-based ordering system with the LabTest-based TestOrder model.
 * 
 * Flow: BillableProduct → panels → ClinicalPanel → items → TestDefinition
 *       → LabTest (by code match) + branch pricing override lookup
 */

import { DiagnosticWorkflowMode } from '@prisma/client';
import prisma from '../lib/prisma';
import { ensureBillOnlyPlaceholderLabTest } from './diagnosticWorkflowService';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ResolvedTestOrder {
  labTestId: string;
  testDefinitionId?: string;
  testName: string;
  testCode: string;
  referenceMin: number | null;
  referenceMax: number | null;
  referenceUnit: string | null;
  priceInPaise: number;             // Allocated portion of product price
  productId: string;
  workflowMode: DiagnosticWorkflowMode;
  priceSource: 'BASE' | 'BRANCH_OVERRIDE';
}

export interface ResolvedProduct {
  productId: string;
  productName: string;
  productCode: string;
  workflowMode: DiagnosticWorkflowMode;
  effectivePrice: number;           // Total product price in paise
  priceSource: 'BASE' | 'BRANCH_OVERRIDE';
  testOrders: ResolvedTestOrder[];
}

// ─── Main resolver ──────────────────────────────────────────────────────────

/**
 * Resolves an array of BillableProduct IDs into everything needed to create
 * TestOrders and price snapshots.
 *
 * @param productIds - Array of BillableProduct IDs
 * @param branchId   - The branch for pricing overrides
 * @returns Array of resolved products with test orders
 * @throws If any product is not found, inactive, or can't be resolved to LabTests
 */
export async function resolveProducts(
  productIds: string[],
  branchId: string
): Promise<ResolvedProduct[]> {
  // Fetch products with panel → items → testDefinition chain
  const products = await prisma.billableProduct.findMany({
    where: { id: { in: productIds }, isActive: true },
    include: {
      panels: {
        include: {
          panel: {
            include: {
              items: {
                include: {
                  testDefinition: {
                    select: { id: true, code: true, name: true, referenceUnit: true,
                              referenceMin: true, referenceMax: true },
                  },
                },
                orderBy: { displayOrder: 'asc' },
              },
            },
          },
        },
        orderBy: { displayOrder: 'asc' },
      },
      branchPricing: {
        where: { branchId, isActive: true },
        take: 1,
      },
    },
  });

  // Validate all products found
  if (products.length !== productIds.length) {
    const foundIds = new Set(products.map((p) => p.id));
    const missing = productIds.filter((id) => !foundIds.has(id));
    throw new ProductResolutionError(
      `Products not found or inactive: ${missing.join(', ')}`,
      'PRODUCT_NOT_FOUND',
      missing
    );
  }

  // ── Pull in nested child products ────────────────────────────────────────
  // A package line can point at another BillableProduct (childProductId). Walk
  // the child graph into `allProducts` so children (and their children) can be
  // expanded into their own report/upload orders. Bounded depth; the save-time
  // cycle guard keeps real data acyclic, and collectLeaves() re-checks per path.
  const allProducts = new Map<string, (typeof products)[number]>(
    products.map((p) => [p.id, p]),
  );
  let childFrontier: string[] = products.flatMap((p) =>
    p.panels.filter((pp) => pp.childProductId).map((pp) => pp.childProductId!),
  );
  for (let depth = 0; depth < 6 && childFrontier.length > 0; depth++) {
    const toFetch = [...new Set(childFrontier)].filter((id) => !allProducts.has(id));
    if (toFetch.length === 0) break;
    const kids = await prisma.billableProduct.findMany({
      where: { id: { in: toFetch } },
      include: {
        panels: {
          include: {
            panel: {
              include: {
                items: {
                  include: {
                    testDefinition: {
                      select: { id: true, code: true, name: true, referenceUnit: true,
                                referenceMin: true, referenceMax: true },
                    },
                  },
                  orderBy: { displayOrder: 'asc' },
                },
              },
            },
          },
          orderBy: { displayOrder: 'asc' },
        },
        branchPricing: {
          where: { branchId, isActive: true },
          take: 1,
        },
      },
    });
    for (const kid of kids) allProducts.set(kid.id, kid as (typeof products)[number]);
    childFrontier = kids.flatMap((k) =>
      k.panels.filter((pp) => pp.childProductId).map((pp) => pp.childProductId!),
    );
  }

  const invalidPanels: string[] = [];
  for (const product of allProducts.values()) {
    // BILL_ONLY, EXTERNAL_UPLOAD and EVENT never carry panels — skip panel validation entirely.
    if (
      product.workflowMode === DiagnosticWorkflowMode.BILL_ONLY ||
      product.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD ||
      product.workflowMode === DiagnosticWorkflowMode.EVENT
    ) {
      continue;
    }

    for (const productPanel of product.panels) {
      // Skip child-product line items — they don't have a panel of their own.
      // The child's own resolution (if any) happens when it's ordered directly.
      const panel = productPanel.panel;
      if (!panel) continue;

      const itemCount = panel.items.length;
      const message = validatePanelItemCount(panel.layoutType, itemCount);

      if (message) {
        invalidPanels.push(
          `Product "${product.name}" -> panel "${panel.displayName || panel.name}": ${message}`
        );
      }
    }
  }

  if (invalidPanels.length > 0) {
    throw new ProductResolutionError(
      'One or more linked panels are misconfigured. Please fix the panel items before ordering this product.',
      'INVALID_PANEL_CONFIGURATION',
      invalidPanels,
    );
  }

  // Collect all unique TestDefinition codes across all panels to batch-fetch LabTests
  const allCodes = new Set<string>();
  for (const product of allProducts.values()) {
    if (
      product.workflowMode === DiagnosticWorkflowMode.BILL_ONLY ||
      product.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD ||
      product.workflowMode === DiagnosticWorkflowMode.EVENT
    ) {
      continue;
    }

    for (const pp of product.panels) {
      if (!pp.panel) continue; // child-product line — no panel items to collect
      for (const item of pp.panel.items) {
        allCodes.add(item.testDefinition.code);
      }
    }
  }

  // Batch lookup: code → LabTest
  const labTests = allCodes.size > 0
    ? await prisma.labTest.findMany({
        where: { code: { in: Array.from(allCodes) } },
        select: {
          id: true,
          name: true,
          code: true,
          referenceMin: true,
          referenceMax: true,
          referenceUnit: true,
        },
      })
    : [];

  const labTestByCode = new Map(labTests.map((lt) => [lt.code, lt]));

  // Auto-create missing LabTest records from TestDefinition data (migration bridge)
  const missingCodes: string[] = [];
  for (const code of allCodes) {
    if (!labTestByCode.has(code)) {
      missingCodes.push(code);
    }
  }

  if (missingCodes.length > 0) {
    // Collect TestDefinition data for missing codes from the already-fetched products
    const missingDefs: Array<{ code: string; name: string; referenceMin: number | null; referenceMax: number | null; referenceUnit: string | null }> = [];
    for (const product of allProducts.values()) {
      for (const pp of product.panels) {
        if (!pp.panel) continue; // child-product line
        for (const item of pp.panel.items) {
          if (missingCodes.includes(item.testDefinition.code)) {
            missingDefs.push({
              code: item.testDefinition.code,
              name: item.testDefinition.name,
              referenceMin: item.testDefinition.referenceMin,
              referenceMax: item.testDefinition.referenceMax,
              referenceUnit: item.testDefinition.referenceUnit,
            });
          }
        }
      }
    }

    // Deduplicate by code
    const uniqueDefs = new Map(missingDefs.map(d => [d.code, d]));

    // Upsert (not raw create) so two concurrent visit-creation requests for
    // the same test don't both try to create a LabTest with the same code
    // and one hits a P2002 unique-constraint error → returned as 500.
    // `code` has a unique constraint on LabTest, which is what `where` keys on.
    for (const [code, def] of uniqueDefs) {
      const upserted = await prisma.labTest.upsert({
        where: { code: def.code },
        create: {
          name: def.name,
          code: def.code,
          priceInPaise: 0,  // Price is tracked via BillableProduct
          referenceMin: def.referenceMin,
          referenceMax: def.referenceMax,
          referenceUnit: def.referenceUnit,
          isActive: true,
          isPanel: false,
        },
        update: {}, // existing row is fine; we only need an id back
        select: { id: true, name: true, code: true, referenceMin: true, referenceMax: true, referenceUnit: true },
      });
      labTestByCode.set(code, upserted);
    }
  }

  // Create a map for quick lookup of the top-level products being ordered.
  const productMap = new Map(products.map(p => [p.id, p]));

  // The bill-only/external/event placeholder LabTest satisfies the
  // TestOrder→LabTest FK for orders with no backing test (bill-only lines,
  // external uploads, event coupons). Fetched once and reused.
  const placeholder = await ensureBillOnlyPlaceholderLabTest();

  type Leaf = Omit<ResolvedTestOrder, 'priceInPaise' | 'productId' | 'priceSource'>;

  const placeholderLeaf = (
    mode: DiagnosticWorkflowMode,
    p: { name: string; code: string },
  ): Leaf => ({
    labTestId: placeholder.id,
    testName: p.name,
    testCode: p.code,
    referenceMin: null,
    referenceMax: null,
    referenceUnit: null,
    workflowMode: mode,
  });

  // Recursively flatten a product into leaf orders. Panel lines become
  // reportable tests; an EXTERNAL_UPLOAD product becomes a single upload order;
  // a REPORTABLE child (including a nested package) expands recursively. A
  // BILL_ONLY / EVENT product yields its own placeholder order ONLY when it is
  // the top-level product being ordered — as a *child line* it's bill
  // itemization only (unchanged) and contributes nothing. `path` guards against
  // cycles / runaway depth in legacy data (real data is kept acyclic at save).
  const collectLeaves = (
    product: (typeof products)[number],
    isTopLevel: boolean,
    path: Set<string>,
  ): Leaf[] => {
    if (path.has(product.id) || path.size >= 6) {
      throw new ProductResolutionError(
        `Package "${product.code}" nests too deeply or references itself.`,
        'INVALID_NESTING',
        [product.code],
      );
    }
    const mode = product.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE;

    if (mode === DiagnosticWorkflowMode.EVENT) {
      return isTopLevel ? [placeholderLeaf(DiagnosticWorkflowMode.EVENT, product)] : [];
    }
    if (mode === DiagnosticWorkflowMode.BILL_ONLY) {
      return isTopLevel ? [placeholderLeaf(DiagnosticWorkflowMode.BILL_ONLY, product)] : [];
    }
    if (mode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD) {
      // A nested external-upload investigation DOES get its own upload order —
      // that's the point of bundling an outside scan into a package.
      return [placeholderLeaf(DiagnosticWorkflowMode.EXTERNAL_UPLOAD, product)];
    }

    // REPORTABLE: panels expand into tests; child lines expand recursively.
    const nextPath = new Set(path).add(product.id);
    const leaves: Leaf[] = [];
    for (const pp of product.panels) {
      if (pp.panel) {
        for (const item of pp.panel.items) {
          const labTest = labTestByCode.get(item.testDefinition.code);
          if (!labTest) continue;
          leaves.push({
            labTestId: labTest.id,
            testDefinitionId: item.testDefinition.id,
            testName: labTest.name,
            testCode: labTest.code,
            referenceMin: labTest.referenceMin,
            referenceMax: labTest.referenceMax,
            referenceUnit: labTest.referenceUnit,
            workflowMode: DiagnosticWorkflowMode.REPORTABLE,
          });
        }
      } else if (pp.childProductId) {
        const child = allProducts.get(pp.childProductId);
        if (child) leaves.push(...collectLeaves(child, false, nextPath));
      }
    }
    return leaves;
  };

  // Resolve each product in the EXACT order of input productIds
  const resolved: ResolvedProduct[] = [];

  for (const productId of productIds) {
    const product = productMap.get(productId);
    if (!product) continue;

    // Determine effective price: branch override > base price
    const branchOverride = product.branchPricing[0];
    const effectivePrice = branchOverride
      ? branchOverride.priceInPaise
      : product.basePriceInPaise;
    const priceSource: 'BASE' | 'BRANCH_OVERRIDE' = branchOverride
      ? 'BRANCH_OVERRIDE'
      : 'BASE';

    // Flatten the whole product (panels + nested children) into leaf orders,
    // then spread the FIXED package price across them. Every leaf carries the
    // top-level productId, so the package stays one bill line / one refund unit
    // however deep it nests, and a child's own list price is ignored.
    const leaves = collectLeaves(product, true, new Set());
    const testCount = leaves.length;
    const testOrders: ResolvedTestOrder[] = [];

    if (testCount === 1) {
      testOrders.push({
        ...leaves[0],
        priceInPaise: effectivePrice,
        productId: product.id,
        priceSource,
      });
    } else if (testCount > 1) {
      const perTestPrice = Math.floor(effectivePrice / testCount);
      const remainder = effectivePrice - perTestPrice * testCount;
      leaves.forEach((leaf, i) => {
        testOrders.push({
          ...leaf,
          priceInPaise: i === 0 ? perTestPrice + remainder : perTestPrice,
          productId: product.id,
          priceSource,
        });
      });
    }

    resolved.push({
      productId: product.id,
      productName: product.name,
      productCode: product.code,
      workflowMode: product.workflowMode ?? DiagnosticWorkflowMode.REPORTABLE,
      effectivePrice,
      priceSource,
      testOrders,
    });
  }

  return resolved;
}

function validatePanelItemCount(layoutType: string, itemCount: number): string | null {
  switch (layoutType) {
    case 'TEXT_ONLY':
      return itemCount === 1 ? null : 'TEXT_ONLY layout requires exactly 1 backing test item';
    case 'IMAGING_NARRATIVE':
      return itemCount === 1 ? null : 'IMAGING_NARRATIVE layout requires exactly 1 backing test item';
    case 'STANDARD_TABLE':
    case 'PROCEDURE_STRUCTURED':
      return itemCount > 0 ? null : `${layoutType} layout requires at least 1 test item`;
    default:
      return itemCount > 0 ? null : `${layoutType} layout requires at least 1 test item`;
  }
}

// ─── Error class ────────────────────────────────────────────────────────────

export class ProductResolutionError extends Error {
  code: string;
  details: string[];

  constructor(message: string, code: string, details: string[]) {
    super(message);
    this.name = 'ProductResolutionError';
    this.code = code;
    this.details = details;
  }
}
