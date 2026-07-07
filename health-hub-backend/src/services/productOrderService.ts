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

  const invalidPanels: string[] = [];
  for (const product of products) {
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
  for (const product of products) {
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
    for (const product of products) {
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

  // Create a map for quick lookup
  const productMap = new Map(products.map(p => [p.id, p]));

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

    if (product.workflowMode === DiagnosticWorkflowMode.EVENT) {
      // EVENT participation product (e.g. blood-donation camp). Priced (usually ₹0),
      // no report — mirrors BILL_ONLY structurally, but keeps workflowMode=EVENT so the
      // post-commit hook mints a campaign coupon. See EVENTS_AND_COUPONS.md.
      const placeholder = await ensureBillOnlyPlaceholderLabTest();

      resolved.push({
        productId: product.id,
        productName: product.name,
        productCode: product.code,
        workflowMode: DiagnosticWorkflowMode.EVENT,
        effectivePrice,
        priceSource,
        testOrders: [
          {
            labTestId: placeholder.id,
            testName: product.name,
            testCode: product.code,
            referenceMin: null,
            referenceMax: null,
            referenceUnit: null,
            priceInPaise: effectivePrice,
            productId: product.id,
            workflowMode: DiagnosticWorkflowMode.EVENT,
            priceSource,
          },
        ],
      });
      continue;
    }

    if (product.workflowMode === DiagnosticWorkflowMode.BILL_ONLY) {
      const placeholder = await ensureBillOnlyPlaceholderLabTest();

      resolved.push({
        productId: product.id,
        productName: product.name,
        productCode: product.code,
        workflowMode: DiagnosticWorkflowMode.BILL_ONLY,
        effectivePrice,
        priceSource,
        testOrders: [
          {
            labTestId: placeholder.id,
            testName: product.name,
            testCode: product.code,
            referenceMin: null,
            referenceMax: null,
            referenceUnit: null,
            priceInPaise: effectivePrice,
            productId: product.id,
            workflowMode: DiagnosticWorkflowMode.BILL_ONLY,
            priceSource,
          },
        ],
      });
      continue;
    }

    if (product.workflowMode === DiagnosticWorkflowMode.EXTERNAL_UPLOAD) {
      // Reuses the bill-only placeholder LabTest as a generic stub; the placeholder
      // exists only to satisfy the TestOrder->LabTest FK. The TestOrder still carries
      // workflowMode=EXTERNAL_UPLOAD so downstream code can branch correctly, and the
      // uploaded PDF lives in ExternalReportUpload, attached via testOrderId.
      const placeholder = await ensureBillOnlyPlaceholderLabTest();

      resolved.push({
        productId: product.id,
        productName: product.name,
        productCode: product.code,
        workflowMode: DiagnosticWorkflowMode.EXTERNAL_UPLOAD,
        effectivePrice,
        priceSource,
        testOrders: [
          {
            labTestId: placeholder.id,
            testName: product.name,
            testCode: product.code,
            referenceMin: null,
            referenceMax: null,
            referenceUnit: null,
            priceInPaise: effectivePrice,
            productId: product.id,
            workflowMode: DiagnosticWorkflowMode.EXTERNAL_UPLOAD,
            priceSource,
          },
        ],
      });
      continue;
    }

    // Flatten all panel items into test orders. Child-product lines don't
    // contribute test orders here — they're priced into the parent's effective
    // price, and the bill receipt itemizes them separately at render time.
    const allItems: Array<{ testDefinition: any }> = [];
    for (const pp of product.panels) {
      if (!pp.panel) continue;
      for (const item of pp.panel.items) {
        allItems.push(item);
      }
    }

    const testCount = allItems.length;
    const testOrders: ResolvedTestOrder[] = [];

    if (testCount === 1) {
      // Single-test product: full price on one TestOrder
      const item = allItems[0];
      const labTest = labTestByCode.get(item.testDefinition.code)!;
      testOrders.push({
        labTestId: labTest.id,
        testDefinitionId: item.testDefinition.id,
        testName: labTest.name,
        testCode: labTest.code,
        referenceMin: labTest.referenceMin,
        referenceMax: labTest.referenceMax,
        referenceUnit: labTest.referenceUnit,
        priceInPaise: effectivePrice,
        productId: product.id,
        workflowMode: DiagnosticWorkflowMode.REPORTABLE,
        priceSource,
      });
    } else if (testCount > 1) {
      // Bundle: distribute price across all test items
      const perTestPrice = Math.floor(effectivePrice / testCount);
      const remainder = effectivePrice - perTestPrice * testCount;

      for (let i = 0; i < testCount; i++) {
        const item = allItems[i];
        const labTest = labTestByCode.get(item.testDefinition.code)!;
        testOrders.push({
          labTestId: labTest.id,
          testDefinitionId: item.testDefinition.id,
          testName: labTest.name,
          testCode: labTest.code,
          referenceMin: labTest.referenceMin,
          referenceMax: labTest.referenceMax,
          referenceUnit: labTest.referenceUnit,
          priceInPaise: i === 0 ? perTestPrice + remainder : perTestPrice,
          productId: product.id,
          workflowMode: DiagnosticWorkflowMode.REPORTABLE,
          priceSource,
        });
      }
    }

    resolved.push({
      productId: product.id,
      productName: product.name,
      productCode: product.code,
      workflowMode: DiagnosticWorkflowMode.REPORTABLE,
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
