import type { ReferralPayoutType } from '@prisma/client';
import { generateNextNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors';
import prisma from '../lib/prisma';

/**
 * Outside-lab vendor master + per-product overrides. Mirrors
 * diagnosticCenterService, but each product rule carries BOTH the lab's rate
 * (what we owe the lab) AND an optional reduced referring-doctor commission for
 * tests outsourced to this lab.
 */

export interface ExternalLabProductRuleInput {
  productId: string;
  rateType: ReferralPayoutType;
  ratePercent: number | null;
  rateAmountInPaise: number | null;
  reducedReferralCommissionType?: ReferralPayoutType | null;
  reducedReferralCommissionPercent?: number | null;
  reducedReferralCommissionAmountInPaise?: number | null;
}

export interface CreateExternalLabInput {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  rateType: ReferralPayoutType;
  ratePercent: number | null;
  rateAmountInPaise: number | null;
  productRules?: ExternalLabProductRuleInput[];
  branchId: string;
  userId?: string;
}

function validateRate(input: {
  rateType: ReferralPayoutType;
  ratePercent: number | null;
  rateAmountInPaise: number | null;
}) {
  if (input.rateType === 'FIXED_AMOUNT') {
    if (input.rateAmountInPaise === null || input.rateAmountInPaise < 0) {
      throw new ValidationError('Lab rate amount must be a non-negative number');
    }
    return;
  }
  if (input.ratePercent === null || input.ratePercent < 0 || input.ratePercent > 100) {
    throw new ValidationError('Lab rate percent must be between 0 and 100');
  }
}

function validateReducedReferral(rule: ExternalLabProductRuleInput) {
  if (rule.reducedReferralCommissionType == null) return;
  if (rule.reducedReferralCommissionType === 'FIXED_AMOUNT') {
    if (
      rule.reducedReferralCommissionAmountInPaise == null ||
      rule.reducedReferralCommissionAmountInPaise < 0
    ) {
      throw new ValidationError('Reduced doctor commission amount must be a non-negative number');
    }
    return;
  }
  if (
    rule.reducedReferralCommissionPercent == null ||
    rule.reducedReferralCommissionPercent < 0 ||
    rule.reducedReferralCommissionPercent > 100
  ) {
    throw new ValidationError('Reduced doctor commission percent must be between 0 and 100');
  }
}

function validateProductRules(productRules?: ExternalLabProductRuleInput[]) {
  if (!productRules) return;
  const seen = new Set<string>();
  for (const rule of productRules) {
    if (!rule.productId) {
      throw new ValidationError('Each product rule must include a productId');
    }
    if (seen.has(rule.productId)) {
      throw new ValidationError('Duplicate product rule found');
    }
    seen.add(rule.productId);
    validateRate(rule);
    validateReducedReferral(rule);
  }
}

function labInclude() {
  return {
    productRules: {
      where: { isActive: true },
      include: {
        product: { select: { id: true, name: true, code: true } },
      },
      orderBy: { createdAt: 'asc' as const },
    },
    _count: {
      select: {
        testOrders: true,
        payoutLedger: true,
      },
    },
  };
}

function productRuleData(rule: ExternalLabProductRuleInput) {
  return {
    productId: rule.productId,
    rateType: rule.rateType,
    ratePercent: rule.ratePercent,
    rateAmountInPaise: rule.rateAmountInPaise,
    reducedReferralCommissionType: rule.reducedReferralCommissionType ?? null,
    reducedReferralCommissionPercent: rule.reducedReferralCommissionPercent ?? null,
    reducedReferralCommissionAmountInPaise: rule.reducedReferralCommissionAmountInPaise ?? null,
    isActive: true,
  };
}

async function assertProductsExist(productRules?: ExternalLabProductRuleInput[]) {
  if (!productRules?.length) return;
  const productCount = await prisma.billableProduct.count({
    where: { id: { in: productRules.map((rule) => rule.productId) } },
  });
  if (productCount !== productRules.length) {
    throw new ValidationError('One or more product rules reference an invalid product');
  }
}

export async function createExternalLab(input: CreateExternalLabInput) {
  validateRate(input);
  validateProductRules(input.productRules);

  const existing = await prisma.externalLab.findFirst({
    where: { name: { equals: input.name.trim(), mode: 'insensitive' } },
  });
  if (existing) {
    throw new ConflictError(`Outside lab "${input.name.trim()}" already exists`);
  }

  await assertProductsExist(input.productRules);

  const labNumber = await generateNextNumber('externalLab', 'EL');

  const lab = await prisma.$transaction(async (tx) => {
    const created = await tx.externalLab.create({
      data: {
        name: input.name.trim(),
        labNumber,
        contactPerson: input.contactPerson?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        rateType: input.rateType,
        ratePercent: input.ratePercent ?? 0,
        rateAmountInPaise: input.rateAmountInPaise,
      },
    });

    if (input.productRules?.length) {
      await tx.externalLabProductRule.createMany({
        data: input.productRules.map((rule) => ({
          externalLabId: created.id,
          ...productRuleData(rule),
        })),
      });
    }

    return tx.externalLab.findUniqueOrThrow({
      where: { id: created.id },
      include: labInclude(),
    });
  });

  await logAction({
    branchId: input.branchId,
    actionType: 'CREATE',
    entityType: 'ExternalLab',
    entityId: lab.id,
    userId: input.userId,
    newValues: lab,
  });

  return lab;
}

export async function listExternalLabs(includeInactive = false, search?: string) {
  return prisma.externalLab.findMany({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { labNumber: { contains: search, mode: 'insensitive' } },
              { contactPerson: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: labInclude(),
    orderBy: { name: 'asc' },
  });
}

export async function getExternalLabById(id: string) {
  return prisma.externalLab.findUnique({
    where: { id },
    include: labInclude(),
  });
}

export async function updateExternalLab(
  id: string,
  updates: {
    name?: string;
    contactPerson?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    rateType?: ReferralPayoutType;
    ratePercent?: number | null;
    rateAmountInPaise?: number | null;
    productRules?: ExternalLabProductRuleInput[];
    isActive?: boolean;
  },
  branchId: string,
  userId?: string
) {
  const existing = await prisma.externalLab.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError('Outside lab not found');
  }

  if (updates.name !== undefined) {
    const trimmedName = updates.name.trim();
    if (!trimmedName) {
      throw new ValidationError('Lab name cannot be empty');
    }
    const duplicate = await prisma.externalLab.findFirst({
      where: { id: { not: id }, name: { equals: trimmedName, mode: 'insensitive' } },
    });
    if (duplicate) {
      throw new ConflictError(`Outside lab "${trimmedName}" already exists`);
    }
  }

  if (
    updates.rateType !== undefined ||
    updates.ratePercent !== undefined ||
    updates.rateAmountInPaise !== undefined
  ) {
    validateRate({
      rateType: updates.rateType ?? existing.rateType,
      ratePercent: updates.ratePercent !== undefined ? updates.ratePercent : existing.ratePercent,
      rateAmountInPaise:
        updates.rateAmountInPaise !== undefined
          ? updates.rateAmountInPaise
          : existing.rateAmountInPaise,
    });
  }

  validateProductRules(updates.productRules);
  await assertProductsExist(updates.productRules);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.externalLab.update({
      where: { id },
      data: {
        name: updates.name?.trim(),
        contactPerson:
          updates.contactPerson !== undefined ? updates.contactPerson?.trim() || null : undefined,
        phone: updates.phone !== undefined ? updates.phone?.trim() || null : undefined,
        email: updates.email !== undefined ? updates.email?.trim() || null : undefined,
        address: updates.address !== undefined ? updates.address?.trim() || null : undefined,
        rateType: updates.rateType,
        ratePercent:
          updates.ratePercent !== undefined ? updates.ratePercent ?? existing.ratePercent : undefined,
        rateAmountInPaise: updates.rateAmountInPaise,
        isActive: updates.isActive,
      },
    });

    if (updates.productRules !== undefined) {
      await tx.externalLabProductRule.deleteMany({ where: { externalLabId: id } });
      if (updates.productRules.length > 0) {
        await tx.externalLabProductRule.createMany({
          data: updates.productRules.map((rule) => ({
            externalLabId: id,
            ...productRuleData(rule),
          })),
        });
      }
    }

    return tx.externalLab.findUniqueOrThrow({
      where: { id },
      include: labInclude(),
    });
  });

  await logAction({
    branchId,
    actionType: 'UPDATE',
    entityType: 'ExternalLab',
    entityId: id,
    userId,
    oldValues: existing,
    newValues: updated,
  });

  return updated;
}

export async function deactivateExternalLab(id: string, branchId: string, userId?: string) {
  const existing = await prisma.externalLab.findUnique({
    where: { id },
    include: { _count: { select: { testOrders: true } } },
  });

  if (!existing) {
    throw new NotFoundError('Outside lab not found');
  }

  await prisma.externalLab.update({
    where: { id },
    data: { isActive: false },
  });

  await logAction({
    branchId,
    actionType: 'DELETE',
    entityType: 'ExternalLab',
    entityId: id,
    userId,
    oldValues: existing,
  });

  return {
    id,
    message: 'Outside lab deactivated',
    linkedOrderCount: existing._count.testOrders,
  };
}
