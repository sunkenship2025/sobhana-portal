/**
 * extract-catalog.ts — Build the HealthFlow default catalog from a live source DB.
 *
 * Pulls ONLY the new-architecture clinical taxonomy
 *   Department → TestDefinition (+ranges, +interpretation rules)
 *             → ClinicalPanel (+items) → BillableProduct (+lines)
 * and writes a sanitized, versioned snapshot to prisma/catalog-seed.json.
 *
 * Sanitization policy (see HEALTHFLOW_SELFHOST_PLAN.md §9a-bis / Appendix A3):
 *   - Identity tables are NEVER queried: SigningDoctor, SigningRule,
 *     SigningLabIncharge, LabInchargeRule, Branch, User, Patient, Visit,
 *     ReferralDoctor, ClinicDoctor, DiagnosticReferralCenter, ExternalLab,
 *     ProductBranchPricing — a new tenant supplies its own.
 *   - Legacy tables (LabTest/PanelDefinition/PanelTestItem) are ignored;
 *     production no longer uses them.
 *   - TestDefinition clone-on-edit history is collapsed: only isLatest rows
 *     are taken and reset to a clean v1 baseline.
 *   - Product prices are rounded to neutral bands so the snapshot is a
 *     "suggested starting price list", not the source lab's exact rate card.
 *
 * Usage:  DATABASE_URL=<source db> npx ts-node prisma/extract-catalog.ts
 */

import { PrismaClient } from '@prisma/client';
import { writeFileSync } from 'fs';
import { join } from 'path';

const prisma = new PrismaClient();

const OUT = join(__dirname, 'catalog-seed.json');

/** Round a paise price to a neutral band. Preserves 0 (intentional free/sub-items). */
function roundPrice(paise: number | null | undefined): number {
  if (!paise || paise <= 0) return 0;
  const rupees = paise / 100;
  const step = rupees <= 500 ? 50 : rupees <= 2000 ? 100 : 250;
  return Math.round(rupees / step) * step * 100;
}

async function main() {
  console.log('Extracting catalog from', (process.env.DATABASE_URL || '').replace(/:\/\/[^@]*@/, '://***@').replace(/\?.*/, ''));

  // ─── Departments (taxonomy, no PII) ───
  const departments = await prisma.department.findMany({
    select: { id: true, name: true, reportHeaderText: true, displayOrder: true, isActive: true, showLabIncharge: true },
    orderBy: { displayOrder: 'asc' },
  });
  const deptIds = new Set(departments.map((d) => d.id));

  // ─── TestDefinitions: latest only, reset to clean v1 baseline ───
  const tdRaw = await prisma.testDefinition.findMany({
    where: { isLatest: true },
    select: {
      id: true, name: true, code: true, sampleType: true, method: true, referenceUnit: true,
      departmentId: true, referenceMin: true, referenceMax: true, referenceText: true,
      criticalMin: true, criticalMax: true, formulaExpression: true, dependsOnCodes: true,
      interpretationMode: true, displayOrder: true, isActive: true,
    },
    orderBy: { displayOrder: 'asc' },
  });
  const testDefinitions = tdRaw.map((t) => ({
    ...t,
    departmentId: t.departmentId && deptIds.has(t.departmentId) ? t.departmentId : null,
    dependsOnCodes: t.dependsOnCodes ?? [],
    // v1 baseline — strip clone-on-edit history
    version: 1,
    previousVersionId: null as string | null,
    isLatest: true,
    status: 'ACTIVE' as const,
    rootDefinitionId: t.id, // self
  }));
  const tdIds = new Set(testDefinitions.map((t) => t.id));

  const testDefinitionRanges = await prisma.testDefinitionRange.findMany({
    where: { testDefinitionId: { in: [...tdIds] } },
    select: {
      id: true, testDefinitionId: true, category: true, categoryLabel: true, minAgeDays: true,
      maxAgeDays: true, gender: true, referenceMin: true, referenceMax: true, referenceUnit: true,
      referenceText: true, criticalMin: true, criticalMax: true,
    },
  });

  const interpretationRules = await prisma.interpretationRule.findMany({
    where: { testDefinitionId: { in: [...tdIds] } },
    select: {
      id: true, testDefinitionId: true, ruleType: true, operator: true, value1: true, value2: true,
      textMatch: true, interpretationText: true, severity: true, displayOrder: true, isActive: true,
    },
  });

  // ─── Clinical panels + items (RI-filtered) ───
  const clinicalPanels = await prisma.clinicalPanel.findMany({
    select: {
      id: true, name: true, displayName: true, departmentId: true, layoutType: true, displayOrder: true,
      showMethodColumn: true, sampleType: true, panelMethodText: true, panelMethodItalic: true,
      narrativeTemplateHtml: true, showSubgroups: true, showInterpretation: true, valueDisplayPrefix: true,
      spacedDefinitionsGap: true, summaryInterpretationTemplate: true, subgroupMethods: true,
      subgroupTableOverrides: true, isActive: true,
    },
    orderBy: { displayOrder: 'asc' },
  });
  const panelIds = new Set(clinicalPanels.filter((p) => deptIds.has(p.departmentId)).map((p) => p.id));
  const clinicalPanelsClean = clinicalPanels.filter((p) => panelIds.has(p.id));

  const clinicalPanelItemsRaw = await prisma.clinicalPanelItem.findMany({
    where: { panelId: { in: [...panelIds] } },
    select: {
      id: true, panelId: true, testDefinitionId: true, displayOrder: true, showMethod: true,
      methodText: true, indentLevel: true, isBold: true, isItalic: true, subGroup: true,
      joinPrevious: true, gridWidth: true,
    },
  });
  const clinicalPanelItems = clinicalPanelItemsRaw.filter((i) => tdIds.has(i.testDefinitionId));

  // ─── Billable products + lines (prices rounded to neutral bands) ───
  const productsRaw = await prisma.billableProduct.findMany({
    select: {
      id: true, name: true, code: true, description: true, basePriceInPaise: true, isBundle: true,
      workflowMode: true, payoutCategory: true, displayOrder: true, isActive: true,
    },
    orderBy: { displayOrder: 'asc' },
  });
  const billableProducts = productsRaw.map((p) => ({ ...p, basePriceInPaise: roundPrice(p.basePriceInPaise) }));
  const prodIds = new Set(billableProducts.map((p) => p.id));

  const productPanelsRaw = await prisma.billableProductPanel.findMany({
    where: { productId: { in: [...prodIds] } },
    select: { id: true, productId: true, panelId: true, childProductId: true, testDefinitionId: true, displayOrder: true },
  });
  // Keep a line only if whichever target it points at survived extraction.
  const billableProductPanels = productPanelsRaw.filter(
    (l) =>
      (l.panelId && panelIds.has(l.panelId)) ||
      (l.childProductId && prodIds.has(l.childProductId)) ||
      (l.testDefinitionId && tdIds.has(l.testDefinitionId)),
  );

  const snapshot = {
    _manifest: {
      generatedFrom: 'live source DB (identity excluded, prices rounded to neutral bands)',
      schema: 'new-architecture (Department→TestDefinition→ClinicalPanel→BillableProduct)',
      counts: {
        departments: departments.length,
        testDefinitions: testDefinitions.length,
        testDefinitionRanges: testDefinitionRanges.length,
        interpretationRules: interpretationRules.length,
        clinicalPanels: clinicalPanelsClean.length,
        clinicalPanelItems: clinicalPanelItems.length,
        billableProducts: billableProducts.length,
        billableProductPanels: billableProductPanels.length,
      },
      droppedForReferentialIntegrity: {
        panelItems: clinicalPanelItemsRaw.length - clinicalPanelItems.length,
        productLines: productPanelsRaw.length - billableProductPanels.length,
      },
    },
    departments,
    testDefinitions,
    testDefinitionRanges,
    interpretationRules,
    clinicalPanels: clinicalPanelsClean,
    clinicalPanelItems,
    billableProducts,
    billableProductPanels,
  };

  writeFileSync(OUT, JSON.stringify(snapshot, null, 2));
  console.log('Wrote', OUT);
  console.table(snapshot._manifest.counts);
  console.log('Dropped for RI:', JSON.stringify(snapshot._manifest.droppedForReferentialIntegrity));
}

main()
  .catch((e) => {
    console.error('Extraction failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
