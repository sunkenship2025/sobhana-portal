/**
 * Data Migration Script: Legacy → New Architecture
 *
 * Migrates:
 *   LabTest → TestDefinition (v1, root=self)
 *   TestAgeRange → TestDefinitionRange
 *   InterpretationTemplate → InterpretationRule
 *   DerivedParameter → TestDefinition.formulaExpression + dependsOnCodes
 *   PanelDefinition → ClinicalPanel + ClinicalPanelItem
 *   LabTest (priced) → BillableProduct + BillableProductComponent
 *
 * Run with: npx tsx prisma/migrate-to-new-architecture.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('=== Starting Migration: Legacy → New Architecture ===\n');

  // ─── 1. LabTest → TestDefinition ────────────────────────────────────────

  console.log('Step 1: Migrating LabTests → TestDefinitions...');
  const labTests = await prisma.labTest.findMany({
    include: {
      department: true,
      ageRanges: true,
      interpretations: true,
      derivedParameter: true,
    },
  });

  // Map old LabTest.id → new TestDefinition.id so we can reference them later
  const testIdMap = new Map<string, string>();
  let defCount = 0;

  for (const lt of labTests) {
    // Skip panel parents — we'll create ClinicalPanels for them
    // Only migrate individual tests (non-panel) and sub-tests
    // We create a TestDefinition for every individual LabTest (isPanel=false)
    // and also for panel LabTests that are actual containers

    // Determine interpretation mode
    let interpretationMode: 'NONE' | 'RANGE_BASED' | 'CATEGORY_BASED' | 'TEXT_ONLY' = 'NONE';
    if (lt.interpretations.length > 0) {
      const hasNumeric = lt.interpretations.some(i => i.minValue !== null || i.maxValue !== null);
      interpretationMode = hasNumeric ? 'RANGE_BASED' : 'TEXT_ONLY';
    }

    // Determine dependsOnCodes from DerivedParameter
    let formulaExpression: string | null = null;
    let dependsOnCodes: string[] | null = null;
    if (lt.derivedParameter) {
      formulaExpression = lt.derivedParameter.formula;
      const raw = lt.derivedParameter.dependsOnTestCodes;
      if (Array.isArray(raw)) {
        dependsOnCodes = raw as string[];
      } else if (typeof raw === 'string') {
        try { dependsOnCodes = JSON.parse(raw); } catch { dependsOnCodes = null; }
      }
    }

    const td = await prisma.testDefinition.create({
      data: {
        name: lt.name,
        code: lt.code,
        version: 1,
        isLatest: true,
        status: lt.isActive ? 'ACTIVE' : 'ARCHIVED',
        sampleType: lt.sampleType,
        method: lt.method,
        referenceUnit: lt.referenceUnit,
        referenceMin: lt.referenceMin,
        referenceMax: lt.referenceMax,
        referenceText: lt.referenceText,
        departmentId: lt.departmentId,
        displayOrder: lt.displayOrder,
        interpretationMode,
        formulaExpression,
        dependsOnCodes: dependsOnCodes ? dependsOnCodes : undefined,
        // root = self for v1
        rootDefinitionId: 'PLACEHOLDER',
      },
    });

    // Set rootDefinitionId = own id
    await prisma.testDefinition.update({
      where: { id: td.id },
      data: { rootDefinitionId: td.id },
    });

    testIdMap.set(lt.id, td.id);
    defCount++;

    // ─── 1a. TestAgeRange → TestDefinitionRange ─────────────────────────
    if (lt.ageRanges.length > 0) {
      await prisma.testDefinitionRange.createMany({
        data: lt.ageRanges.map(ar => ({
          testDefinitionId: td.id,
          minAgeDays: ar.minAgeDays,
          maxAgeDays: ar.maxAgeDays,
          gender: ar.gender,
          referenceMin: ar.referenceMin,
          referenceMax: ar.referenceMax,
          referenceUnit: ar.referenceUnit,
          referenceText: ar.referenceText,
        })),
      });
    }

    // ─── 1b. InterpretationTemplate → InterpretationRule ────────────────
    if (lt.interpretations.length > 0) {
      await prisma.interpretationRule.createMany({
        data: lt.interpretations.map(it => ({
          testDefinitionId: td.id,
          ruleType: (it.minValue !== null || it.maxValue !== null) ? 'NUMERIC_RANGE' : 'TEXT_MATCH',
          operator: (it.minValue !== null && it.maxValue !== null) ? 'BETWEEN' :
                    (it.minValue !== null) ? 'GTE' :
                    (it.maxValue !== null) ? 'LTE' : 'MATCH',
          value1: it.minValue,
          value2: it.maxValue,
          textMatch: (it.minValue === null && it.maxValue === null) ? it.interpretationText : null,
          interpretationText: it.interpretationText,
          severity: null,
          displayOrder: it.displayOrder,
          isActive: it.isActive,
        })),
      });
    }
  }

  console.log(`  ✓ Created ${defCount} TestDefinitions with ranges & interpretation rules\n`);

  // ─── 2. PanelDefinition → ClinicalPanel + ClinicalPanelItem ────────────

  console.log('Step 2: Migrating PanelDefinitions → ClinicalPanels...');
  const panels = await prisma.panelDefinition.findMany({
    include: { testItems: { include: { test: true } } },
  });

  let panelCount = 0;
  for (const pd of panels) {
    // Map layoutType from legacy to new
    // Map layout type: legacy enum values are already matching new architecture
    const cp = await prisma.clinicalPanel.create({
      data: {
        name: pd.name,
        displayName: pd.displayName || pd.name,
        layoutType: pd.layoutType,
        departmentId: pd.departmentId,
        isActive: pd.isActive,
        summaryInterpretationTemplate: null,
        items: {
          create: pd.testItems.map(item => {
            const newDefId = testIdMap.get(item.testId);
            if (!newDefId) {
              console.warn(`  ⚠ Panel "${pd.name}" item references unknown LabTest ${item.testId}, skipping`);
              return null as any;
            }
            return {
              testDefinitionId: newDefId,
              subGroup: item.subGroup,
              displayOrder: item.displayOrder,
            };
          }).filter(Boolean),
        },
      },
    });
    panelCount++;
  }

  console.log(`  ✓ Created ${panelCount} ClinicalPanels with items\n`);

  // ─── 3. Priced LabTests → BillableProduct + BillableProductComponent ────

  console.log('Step 3: Creating BillableProducts from priced LabTests...');
  let productCount = 0;

  // Individual tests with price
  const pricedTests = labTests.filter(lt => lt.priceInPaise > 0 && !lt.isPanel);
  for (const lt of pricedTests) {
    const defId = testIdMap.get(lt.id);
    if (!defId) continue;

    await prisma.billableProduct.create({
      data: {
        name: lt.name,
        code: lt.code,
        basePriceInPaise: lt.priceInPaise,
        isActive: lt.isActive,
        isBundle: false,
        description: null,
        components: {
          create: [{
            testDefinitionId: defId,
            componentVersionId: defId,
            displayOrder: 0,
          }],
        },
      },
    });
    productCount++;
  }

  // Panel LabTests with price → PANEL_BUNDLE
  const pricedPanels = labTests.filter(lt => lt.priceInPaise > 0 && lt.isPanel);
  for (const lt of pricedPanels) {
    // Find child tests in legacy hierarchy
    const childTests = labTests.filter(child => child.parentTestId === lt.id);
    const componentData = childTests
      .map(child => testIdMap.get(child.id))
      .filter(Boolean)
      .map((defId, i) => ({
        testDefinitionId: defId!,
        componentVersionId: defId!,
        displayOrder: i,
      }));

    // If no children found, create self as single component
    if (componentData.length === 0) {
      const selfDefId = testIdMap.get(lt.id);
      if (selfDefId) {
        componentData.push({
          testDefinitionId: selfDefId,
          componentVersionId: selfDefId,
          displayOrder: 0,
        });
      }
    }

    await prisma.billableProduct.create({
      data: {
        name: lt.name,
        code: lt.code,
        basePriceInPaise: lt.priceInPaise,
        isActive: lt.isActive,
        isBundle: true,
        description: null,
        components: {
          create: componentData,
        },
      },
    });
    productCount++;
  }

  console.log(`  ✓ Created ${productCount} BillableProducts (${pricedTests.length} individual, ${pricedPanels.length} bundles)\n`);

  // ─── Summary ────────────────────────────────────────────────────────────

  console.log('=== Migration Complete ===');
  console.log(`  TestDefinitions:   ${defCount}`);
  console.log(`  ClinicalPanels:    ${panelCount}`);
  console.log(`  BillableProducts:  ${productCount}`);
  console.log(`  TestDefinition ID Map: ${testIdMap.size} entries`);
  console.log('\nLegacy tables preserved (LabTest, PanelDefinition, etc.) — both systems run in parallel.');
}

main()
  .catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
