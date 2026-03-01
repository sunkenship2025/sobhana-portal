/**
 * Clinical Definitions Service
 * 
 * Handles versioned test definition CRUD with clone-on-edit semantics:
 * - Create new test definitions
 * - Create new versions (clone current → lock old → create new ACTIVE)
 * - Status transitions (ACTIVE → LOCKED → DEPRECATED → ARCHIVED)
 * - Interpretation rules management (inline with definition)
 * - Impact analysis (what panels/products reference this definition)
 * - Sandbox preview (dry-run of interpretation evaluation)
 */

import prisma from '../lib/prisma';
import {
  detectInterpretationOverlaps,
  detectCircularDependencies,
  isValidStatusTransition,
  evaluateInterpretation,
  checkConcurrency,
  InterpretationRuleInput,
} from '../utils/clinicalValidation';
import { TestDefinitionStatus, InterpretationMode, ComparisonOperator, InterpretationRuleType } from '@prisma/client';

// ============================================================================
// TYPES
// ============================================================================

export interface CreateTestDefinitionInput {
  name: string;
  code: string;
  sampleType?: string;
  method?: string;
  referenceUnit?: string;
  departmentId?: string;
  referenceMin?: number;
  referenceMax?: number;
  referenceText?: string;
  formulaExpression?: string;
  dependsOnCodes?: string[];
  interpretationMode?: InterpretationMode;
  displayOrder?: number;
  ranges?: RangeInput[];
  interpretationRules?: InterpretationRuleInput[];
}

export interface RangeInput {
  minAgeDays?: number;
  maxAgeDays?: number;
  gender?: 'M' | 'F' | 'O';
  referenceMin?: number;
  referenceMax?: number;
  referenceUnit?: string;
  referenceText?: string;
}

// ============================================================================
// CREATE
// ============================================================================

export async function createTestDefinition(input: CreateTestDefinitionInput) {
  // Validate code uniqueness among latest versions
  const existing = await prisma.testDefinition.findFirst({
    where: { code: input.code, isLatest: true },
  });
  if (existing) {
    throw new Error(`Test code "${input.code}" already exists`);
  }

  // Validate interpretation rules for overlaps
  if (input.interpretationRules?.length) {
    const overlaps = detectInterpretationOverlaps(input.interpretationRules);
    if (overlaps.length > 0) {
      throw new Error(`Interpretation rule overlaps: ${overlaps.join('; ')}`);
    }
  }

  // Validate circular dependencies
  if (input.dependsOnCodes?.length) {
    const allDeps = await getAllDependencyMap();
    const cycles = detectCircularDependencies(input.code, input.dependsOnCodes, allDeps);
    if (cycles.length > 0) {
      throw new Error(`Circular dependency: ${cycles.join('; ')}`);
    }
  }

  // Create definition + ranges + rules in a single transaction
  const definition = await prisma.$transaction(async (tx) => {
    const def = await tx.testDefinition.create({
      data: {
        rootDefinitionId: '', // Will be set to own ID below
        version: 1,
        isLatest: true,
        status: 'ACTIVE',
        name: input.name,
        code: input.code,
        sampleType: input.sampleType,
        method: input.method,
        referenceUnit: input.referenceUnit,
        departmentId: input.departmentId,
        referenceMin: input.referenceMin,
        referenceMax: input.referenceMax,
        referenceText: input.referenceText,
        formulaExpression: input.formulaExpression,
        dependsOnCodes: input.dependsOnCodes ?? [],
        interpretationMode: input.interpretationMode ?? 'NONE',
        displayOrder: input.displayOrder ?? 0,
      },
    });

    // Set rootDefinitionId = own id (version 1 is the root)
    await tx.testDefinition.update({
      where: { id: def.id },
      data: { rootDefinitionId: def.id },
    });

    // Create age/gender ranges
    if (input.ranges?.length) {
      await tx.testDefinitionRange.createMany({
        data: input.ranges.map((r) => ({
          testDefinitionId: def.id,
          minAgeDays: r.minAgeDays,
          maxAgeDays: r.maxAgeDays,
          gender: r.gender,
          referenceMin: r.referenceMin,
          referenceMax: r.referenceMax,
          referenceUnit: r.referenceUnit,
          referenceText: r.referenceText,
        })),
      });
    }

    // Create interpretation rules
    if (input.interpretationRules?.length) {
      await tx.interpretationRule.createMany({
        data: input.interpretationRules.map((r, i) => ({
          testDefinitionId: def.id,
          ruleType: r.ruleType,
          operator: r.operator,
          value1: r.value1,
          value2: r.value2,
          textMatch: r.textMatch,
          interpretationText: r.interpretationText,
          severity: r.severity,
          displayOrder: r.displayOrder ?? i,
        })),
      });
    }

    return tx.testDefinition.findUnique({
      where: { id: def.id },
      include: {
        department: { select: { id: true, name: true } },
        ranges: true,
        interpretationRules: { orderBy: { displayOrder: 'asc' } },
      },
    });
  });

  return definition;
}

// ============================================================================
// CREATE NEW VERSION (Clone-on-Edit)
// ============================================================================

export async function createNewVersion(
  rootDefinitionId: string,
  updates: Partial<CreateTestDefinitionInput>,
  ifMatch?: string
) {
  return prisma.$transaction(async (tx) => {
    // Find current latest version
    const current = await tx.testDefinition.findFirst({
      where: { rootDefinitionId, isLatest: true },
      include: {
        ranges: true,
        interpretationRules: { orderBy: { displayOrder: 'asc' } },
      },
    });

    if (!current) {
      throw new Error(`Test definition not found: ${rootDefinitionId}`);
    }

    // Concurrency check
    if (!checkConcurrency(ifMatch, current.updatedAt)) {
      throw new Error('CONFLICT: This definition has been modified by another user. Please refresh and try again.');
    }

    if (current.status !== 'ACTIVE') {
      throw new Error(`Cannot create new version: current version is ${current.status}`);
    }

    // Validate interpretation rules
    const newRules = updates.interpretationRules ?? current.interpretationRules.map(r => ({
      ruleType: r.ruleType,
      operator: r.operator,
      value1: r.value1,
      value2: r.value2,
      textMatch: r.textMatch,
      interpretationText: r.interpretationText,
      severity: r.severity,
      displayOrder: r.displayOrder,
    }));

    if (newRules.length) {
      const overlaps = detectInterpretationOverlaps(newRules);
      if (overlaps.length > 0) {
        throw new Error(`Interpretation rule overlaps: ${overlaps.join('; ')}`);
      }
    }

    // Validate code uniqueness if code changed
    const newCode = updates.code ?? current.code;
    if (newCode !== current.code) {
      const codeExists = await tx.testDefinition.findFirst({
        where: { code: newCode, isLatest: true, rootDefinitionId: { not: rootDefinitionId } },
      });
      if (codeExists) {
        throw new Error(`Test code "${newCode}" already exists`);
      }
    }

    // Lock the current version
    await tx.testDefinition.update({
      where: { id: current.id },
      data: { isLatest: false, status: 'LOCKED' },
    });

    // Create new version
    const newVersion = await tx.testDefinition.create({
      data: {
        rootDefinitionId,
        version: current.version + 1,
        isLatest: true,
        previousVersionId: current.id,
        status: 'ACTIVE',
        name: updates.name ?? current.name,
        code: newCode,
        sampleType: updates.sampleType ?? current.sampleType,
        method: updates.method ?? current.method,
        referenceUnit: updates.referenceUnit ?? current.referenceUnit,
        departmentId: updates.departmentId ?? current.departmentId,
        referenceMin: updates.referenceMin ?? current.referenceMin,
        referenceMax: updates.referenceMax ?? current.referenceMax,
        referenceText: updates.referenceText ?? current.referenceText,
        formulaExpression: updates.formulaExpression ?? current.formulaExpression,
        dependsOnCodes: updates.dependsOnCodes ?? (current.dependsOnCodes as string[]) ?? [],
        interpretationMode: updates.interpretationMode ?? current.interpretationMode,
        displayOrder: updates.displayOrder ?? current.displayOrder,
      },
    });

    // Clone or update ranges
    const ranges = updates.ranges ?? current.ranges.map(r => ({
      minAgeDays: r.minAgeDays,
      maxAgeDays: r.maxAgeDays,
      gender: r.gender as 'M' | 'F' | 'O' | undefined,
      referenceMin: r.referenceMin,
      referenceMax: r.referenceMax,
      referenceUnit: r.referenceUnit,
      referenceText: r.referenceText,
    }));

    if (ranges.length) {
      await tx.testDefinitionRange.createMany({
        data: ranges.map((r) => ({
          testDefinitionId: newVersion.id,
          minAgeDays: r.minAgeDays,
          maxAgeDays: r.maxAgeDays,
          gender: r.gender,
          referenceMin: r.referenceMin,
          referenceMax: r.referenceMax,
          referenceUnit: r.referenceUnit,
          referenceText: r.referenceText,
        })),
      });
    }

    // Clone or update interpretation rules
    if (newRules.length) {
      await tx.interpretationRule.createMany({
        data: newRules.map((r, i) => ({
          testDefinitionId: newVersion.id,
          ruleType: r.ruleType,
          operator: r.operator,
          value1: r.value1,
          value2: r.value2,
          textMatch: r.textMatch,
          interpretationText: r.interpretationText,
          severity: r.severity,
          displayOrder: r.displayOrder ?? i,
        })),
      });
    }

    return tx.testDefinition.findUnique({
      where: { id: newVersion.id },
      include: {
        department: { select: { id: true, name: true } },
        ranges: true,
        interpretationRules: { orderBy: { displayOrder: 'asc' } },
      },
    });
  });
}

// ============================================================================
// STATUS TRANSITION
// ============================================================================

export async function transitionStatus(
  id: string,
  newStatus: TestDefinitionStatus,
  ifMatch?: string
) {
  return prisma.$transaction(async (tx) => {
    const def = await tx.testDefinition.findUnique({ where: { id } });
    if (!def) throw new Error('Test definition not found');

    if (!checkConcurrency(ifMatch, def.updatedAt)) {
      throw new Error('CONFLICT: This definition has been modified by another user.');
    }

    if (!isValidStatusTransition(def.status, newStatus)) {
      throw new Error(
        `Invalid transition: ${def.status} → ${newStatus}. ` +
        `Allowed: ${def.status} → ${isValidStatusTransition(def.status, newStatus)}`
      );
    }

    return tx.testDefinition.update({
      where: { id },
      data: { status: newStatus },
      include: {
        department: { select: { id: true, name: true } },
        ranges: true,
        interpretationRules: { orderBy: { displayOrder: 'asc' } },
      },
    });
  });
}

// ============================================================================
// IMPACT ANALYSIS
// ============================================================================

/**
 * Get all panels and products that reference a given test definition.
 */
export async function getImpact(rootDefinitionId: string) {
  // Find all versions of this definition
  const versions = await prisma.testDefinition.findMany({
    where: { rootDefinitionId },
    select: { id: true, version: true, isLatest: true, status: true },
  });

  const versionIds = versions.map(v => v.id);

  // Panels referencing any version
  const panelItems = await prisma.clinicalPanelItem.findMany({
    where: { testDefinitionId: { in: versionIds } },
    include: {
      panel: { select: { id: true, name: true, displayName: true, isActive: true } },
    },
  });

  // Products referencing any version
  const productPanels = await prisma.billableProductPanel.findMany({
    where: { testDefinitionId: { in: versionIds } },
    include: {
      product: { select: { id: true, name: true, code: true, isActive: true } },
    },
  });

  return {
    versions,
    referencedByPanels: panelItems.map(pi => ({
      panelId: pi.panel.id,
      panelName: pi.panel.name,
      panelDisplayName: pi.panel.displayName,
      panelActive: pi.panel.isActive,
      pinnedVersionId: pi.testDefinitionId,
    })),
    referencedByProducts: productPanels.map((pc: any) => ({
      productId: pc.product.id,
      productName: pc.product.name,
      productCode: pc.product.code,
      productActive: pc.product.isActive,
      pinnedVersionId: pc.testDefinitionId,
    })),
  };
}

/**
 * Get all definitions that depend on a given definition (dependents, not dependencies).
 */
export async function getDependents(code: string) {
  // Find all definitions whose dependsOnCodes contains this code
  const dependents = await prisma.testDefinition.findMany({
    where: {
      isLatest: true,
      dependsOnCodes: { array_contains: [code] },
    },
    select: {
      id: true,
      rootDefinitionId: true,
      name: true,
      code: true,
      version: true,
      formulaExpression: true,
    },
  });

  return dependents;
}

// ============================================================================
// SANDBOX PREVIEW
// ============================================================================

/**
 * Dry-run interpretation evaluation without saving anything.
 */
export async function sandboxPreview(
  testDefinitionId: string,
  testValue: number | string
) {
  const def = await prisma.testDefinition.findUnique({
    where: { id: testDefinitionId },
    include: {
      interpretationRules: { where: { isActive: true }, orderBy: { displayOrder: 'asc' } },
    },
  });

  if (!def) throw new Error('Test definition not found');

  const rules: InterpretationRuleInput[] = def.interpretationRules.map(r => ({
    ruleType: r.ruleType,
    operator: r.operator,
    value1: r.value1,
    value2: r.value2,
    textMatch: r.textMatch,
    interpretationText: r.interpretationText,
    severity: r.severity,
    displayOrder: r.displayOrder,
  }));

  const result = evaluateInterpretation(testValue, rules);

  return {
    testDefinitionId,
    testValue,
    interpretationMode: def.interpretationMode,
    rulesChecked: rules.length,
    result,
  };
}

// ============================================================================
// HELPERS
// ============================================================================

async function getAllDependencyMap(): Promise<Map<string, string[]>> {
  const all = await prisma.testDefinition.findMany({
    where: { isLatest: true },
    select: { code: true, dependsOnCodes: true },
  });

  const map = new Map<string, string[]>();
  for (const d of all) {
    const codes = Array.isArray(d.dependsOnCodes) ? d.dependsOnCodes as string[] : [];
    map.set(d.code, codes);
  }
  return map;
}
