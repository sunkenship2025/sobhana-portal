import prisma from '../lib/prisma';
import { createId } from '@paralleldrive/cuid2';

export interface CloneOptions {
  fromTenantId: string;
  toTenantId: string;
  include: {
    departments?: boolean;
    tests?: boolean;
    panels?: boolean;
    products?: boolean;
  };
}

export class CatalogClonerService {
  /**
   * Performs a deep clone of catalog data from one tenant to another.
   * Modifies references safely while persisting to the database.
   */
  static async clone(options: CloneOptions): Promise<void> {
    const { fromTenantId, toTenantId, include } = options;

    const idMap = new Map<string, string>(); // oldId -> newId

    // Define a helper to generate a new ID and map it
    const mapId = (oldId: string): string => {
      if (idMap.has(oldId)) return idMap.get(oldId)!;
      const newId = createId();
      idMap.set(oldId, newId);
      return newId;
    };

    // Helper to rewrite fields
    const remap = (data: any, fieldMappings: { [key: string]: boolean }) => {
      const result: any = { ...data, tenantId: toTenantId };
      delete result.createdAt;
      delete result.updatedAt;

      for (const [field, required] of Object.entries(fieldMappings)) {
        if (result[field]) {
          const newId = idMap.get(result[field]);
          if (newId) {
             result[field] = newId;
          } else if (required) {
             throw new Error(`Missing mapped ID for required field ${field} with old value ${result[field]}`);
          }
        }
      }
      return result;
    };

    await prisma.$transaction(async (tx: any) => {
      // 1. Department
      if (include.departments || include.tests || include.panels || include.products) {
        const departments = await tx.department.findMany({ where: { tenantId: fromTenantId } });
        for (const d of departments) {
          const newId = mapId(d.id);
          await tx.department.create({ data: { ...remap(d, {}), id: newId } });
        }
      }

      // 2. TestDefinition
      if (include.tests || include.panels || include.products) {
        const tests = await tx.testDefinition.findMany({ where: { tenantId: fromTenantId } });
        for (const t of tests) {
          const newId = mapId(t.id);
          await tx.testDefinition.create({
            data: {
              ...remap(t, { departmentId: true }),
              id: newId,
              rootDefinitionId: t.rootDefinitionId === t.id ? newId : mapId(t.rootDefinitionId)
            }
          });
        }

        // 3. TestDefinitionRange
        const ranges = await tx.testDefinitionRange.findMany({ where: { tenantId: fromTenantId } });
        for (const r of ranges) {
          const newId = mapId(r.id);
          await tx.testDefinitionRange.create({
            data: { ...remap(r, { testDefinitionId: true }), id: newId }
          });
        }

        // 4. InterpretationRule
        const interpretations = await tx.interpretationRule.findMany({ where: { tenantId: fromTenantId } });
        for (const r of interpretations) {
          const newId = mapId(r.id);
          await tx.interpretationRule.create({
            data: { ...remap(r, { testDefinitionId: true }), id: newId }
          });
        }
      }

      // 5. ClinicalPanel
      if (include.panels || include.products) {
        const panels = await tx.clinicalPanel.findMany({ where: { tenantId: fromTenantId } });
        for (const p of panels) {
          const newId = mapId(p.id);
          await tx.clinicalPanel.create({
            data: { ...remap(p, { departmentId: true }), id: newId }
          });
        }

        // 6. ClinicalPanelItem
        const panelItems = await tx.clinicalPanelItem.findMany({ where: { tenantId: fromTenantId } });
        for (const pi of panelItems) {
          const newId = mapId(pi.id);
          await tx.clinicalPanelItem.create({
            data: { ...remap(pi, { panelId: true, testDefinitionId: true }), id: newId }
          });
        }
      }

      // 7. BillableProduct
      if (include.products) {
        const products = await tx.billableProduct.findMany({ where: { tenantId: fromTenantId } });
        for (const p of products) {
          const newId = mapId(p.id);
          await tx.billableProduct.create({
            data: { ...remap(p, {}), id: newId }
          });
        }

        // 8. BillableProductPanel (Product Lines)
        const productPanels = await tx.billableProductPanel.findMany({ where: { tenantId: fromTenantId } });
        for (const pp of productPanels) {
          const newId = mapId(pp.id);
          await tx.billableProductPanel.create({
            data: {
              ...remap(pp, {
                 productId: true,
                 panelId: false,
                 childProductId: false,
                 testDefinitionId: false
              }),
              id: newId
            }
          });
        }
      }

      // 9. TestInputConfig
      if (include.tests || include.panels || include.products) {
        const inputConfigs = await tx.testInputConfig.findMany({ where: { tenantId: fromTenantId } });
        for (const tic of inputConfigs) {
          // tic.rootDefinitionId is the ID. We only map it if the test was cloned.
          const newRootId = idMap.get(tic.rootDefinitionId);
          if (newRootId) {
             await tx.testInputConfig.create({
               data: { ...remap(tic, {}), rootDefinitionId: newRootId }
             });
          }
        }
      }

      // 10. DerivedParameterDef
      if (include.tests || include.panels || include.products) {
        const derivedDefs = await tx.derivedParameterDef.findMany({ where: { tenantId: fromTenantId } });
        for (const dp of derivedDefs) {
          const newId = mapId(dp.id);
          await tx.derivedParameterDef.create({
            data: { ...remap(dp, {}), id: newId }
          });
        }
      }
    }, { timeout: 30000 });
  }
}
