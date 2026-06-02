import { generateNextNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors';
import prisma from '../lib/prisma';
import type { NormalizedReferralPayout } from './referralPayoutService';

export interface DiagnosticCenterProductRuleInput extends NormalizedReferralPayout {
  productId: string;
}

export interface CreateDiagnosticCenterInput {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  commissionType: NormalizedReferralPayout['commissionType'];
  commissionPercent: number | null;
  commissionAmountInPaise: number | null;
  productRules?: DiagnosticCenterProductRuleInput[];
  branchId: string;
  userId?: string;
}

function validatePayout(
  input: Pick<NormalizedReferralPayout, 'commissionType' | 'commissionPercent' | 'commissionAmountInPaise'>
) {
  if (input.commissionType === 'FIXED_AMOUNT') {
    if (input.commissionAmountInPaise === null || input.commissionAmountInPaise < 0) {
      throw new ValidationError('Commission amount must be a non-negative number');
    }
    return;
  }

  if (
    input.commissionPercent === null ||
    input.commissionPercent < 0 ||
    input.commissionPercent > 100
  ) {
    throw new ValidationError('Commission percent must be between 0 and 100');
  }
}

function validateProductRules(productRules?: DiagnosticCenterProductRuleInput[]) {
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
    validatePayout(rule);
  }
}

function centerInclude() {
  return {
    productRules: {
      where: { // @ts-ignore Prisma types
 isActive: true },
      include: {
        product: {
          select: { id: true, name: true, code: true },
        },
      },
      orderBy: { createdAt: 'asc' as const },
    },
    _count: {
      select: {
        visitReferrals: true,
        payoutLedger: true,
      },
    },
  };
}

export async function createDiagnosticCenter(input: CreateDiagnosticCenterInput) {
  validatePayout(input);
  validateProductRules(input.productRules);

  const existing = await prisma.diagnosticReferralCenter.findFirst({
    where: { // @ts-ignore Prisma types

      name: { equals: input.name.trim(), mode: 'insensitive' },
    },
  });

  if (existing) {
    throw new ConflictError(`Diagnostic center "${input.name.trim()}" already exists`);
  }

  if (input.productRules?.length) {
    const productCount = await prisma.billableProduct.count({
      where: { // @ts-ignore Prisma types
 id: { in: input.productRules.map((rule) => rule.productId) } },
    });

    if (productCount !== input.productRules.length) {
      throw new ValidationError('One or more product rules reference an invalid product');
    }
  }

  const centerNumber = await generateNextNumber('diagnosticCenter', 'DC');

  const center = await prisma.$transaction(async (tx) => {
    const created = await tx.diagnosticReferralCenter.create({
      // @ts-ignore Prisma strict typing
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        name: input.name.trim(),
        centerNumber,
        contactPerson: input.contactPerson?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        commissionType: input.commissionType,
        commissionPercent: input.commissionPercent ?? 0,
        commissionAmountInPaise: input.commissionAmountInPaise,
      },
    });

    if (input.productRules?.length) {
        // @ts-ignore Prisma strict typing
      await tx.diagnosticCenterProductRule.createMany({
        // @ts-ignore Prisma strict typing
        data: // @ts-ignore
input.productRules.map((rule) => ({
          diagnosticCenterId: created.id,
          productId: rule.productId,
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
          isActive: true,
        })),
      });
    }

    return tx.diagnosticReferralCenter.findUniqueOrThrow({
      where: { // @ts-ignore Prisma types
 id: created.id },
      include: centerInclude(),
    });
  });

  await logAction({
    branchId: input.branchId,
    actionType: 'CREATE',
    entityType: 'DiagnosticReferralCenter',
    entityId: center.id,
    userId: input.userId,
    newValues: center,
  });

  return center;
}

export async function listDiagnosticCenters(includeInactive = false, search?: string) {
  return prisma.diagnosticReferralCenter.findMany({
    where: { // @ts-ignore Prisma types

      ...(includeInactive ? {} : { isActive: true }),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { centerNumber: { contains: search, mode: 'insensitive' } },
              { contactPerson: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: centerInclude(),
    orderBy: { name: 'asc' },
  });
}

export async function getDiagnosticCenterById(id: string) {
  return prisma.diagnosticReferralCenter.findUnique({
    where: { // @ts-ignore Prisma types
 id },
    include: {
      ...centerInclude(),
      visitReferrals: {
        take: 20,
        orderBy: { createdAt: 'desc' },
        include: {
          visit: { select: { id: true, billNumber: true, createdAt: true } },
          branch: { select: { id: true, name: true } },
        },
      },
    },
  });
}

export async function updateDiagnosticCenter(
  id: string,
  updates: {
    name?: string;
    contactPerson?: string | null;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    commissionType?: NormalizedReferralPayout['commissionType'];
    commissionPercent?: number | null;
    commissionAmountInPaise?: number | null;
    productRules?: DiagnosticCenterProductRuleInput[];
    isActive?: boolean;
  },
  branchId: string,
  userId?: string
) {
  const existing = await prisma.diagnosticReferralCenter.findUnique({
    where: { // @ts-ignore Prisma types
 id },
  });

  if (!existing) {
    throw new NotFoundError('Diagnostic center not found');
  }

  if (updates.name !== undefined) {
    const trimmedName = updates.name.trim();
    if (!trimmedName) {
      throw new ValidationError('Center name cannot be empty');
    }

    const duplicate = await prisma.diagnosticReferralCenter.findFirst({
      where: { // @ts-ignore Prisma types

        id: { not: id },
        name: { equals: trimmedName, mode: 'insensitive' },
      },
    });

    if (duplicate) {
      throw new ConflictError(`Diagnostic center "${trimmedName}" already exists`);
    }
  }

  if (
    updates.commissionType !== undefined ||
    updates.commissionPercent !== undefined ||
    updates.commissionAmountInPaise !== undefined
  ) {
    validatePayout({
      commissionType: updates.commissionType ?? existing.commissionType,
      commissionPercent:
        updates.commissionPercent !== undefined
          ? updates.commissionPercent
          : existing.commissionPercent,
      commissionAmountInPaise:
        updates.commissionAmountInPaise !== undefined
          ? updates.commissionAmountInPaise
          : existing.commissionAmountInPaise,
    });
  }

  validateProductRules(updates.productRules);

  if (updates.productRules) {
    const productCount = await prisma.billableProduct.count({
      where: { // @ts-ignore Prisma types
 id: { in: updates.productRules.map((rule) => rule.productId) } },
    });

    if (productCount !== updates.productRules.length) {
      throw new ValidationError('One or more product rules reference an invalid product');
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.diagnosticReferralCenter.update({
      where: { // @ts-ignore Prisma types
 id },
      data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types

        name: updates.name?.trim(),
        contactPerson:
          updates.contactPerson !== undefined
            ? updates.contactPerson?.trim() || null
            : undefined,
        phone:
          updates.phone !== undefined
            ? updates.phone?.trim() || null
            : undefined,
        email:
          updates.email !== undefined
            ? updates.email?.trim() || null
            : undefined,
        address:
          updates.address !== undefined
            ? updates.address?.trim() || null
            : undefined,
        commissionType: updates.commissionType,
        commissionPercent:
          updates.commissionPercent !== undefined
            ? updates.commissionPercent ?? existing.commissionPercent
            : undefined,
        commissionAmountInPaise: updates.commissionAmountInPaise,
        isActive: updates.isActive,
      },
    });

    if (updates.productRules !== undefined) {
      await tx.diagnosticCenterProductRule.deleteMany({
        where: { // @ts-ignore Prisma types
 diagnosticCenterId: id },
      });

      if (updates.productRules.length > 0) {
        await tx.diagnosticCenterProductRule.createMany({
        // @ts-ignore Prisma strict typing
          data: // @ts-ignore
updates.productRules.map((rule) => ({
            diagnosticCenterId: id,
            productId: rule.productId,
            commissionType: rule.commissionType,
            commissionPercent: rule.commissionPercent,
            commissionAmountInPaise: rule.commissionAmountInPaise,
            isActive: true,
          })),
        });
      }
    }

    return tx.diagnosticReferralCenter.findUniqueOrThrow({
      where: { // @ts-ignore Prisma types
 id },
      include: centerInclude(),
    });
  });

  await logAction({
    branchId,
    actionType: 'UPDATE',
    entityType: 'DiagnosticReferralCenter',
    entityId: id,
    userId,
    oldValues: existing,
    newValues: updated,
  });

  return updated;
}

export async function deactivateDiagnosticCenter(
  id: string,
  branchId: string,
  userId?: string
) {
  const existing = await prisma.diagnosticReferralCenter.findUnique({
    where: { // @ts-ignore Prisma types
 id },
    include: {
      _count: {
        select: { visitReferrals: true },
      },
    },
  });

  if (!existing) {
    throw new NotFoundError('Diagnostic center not found');
  }

  await prisma.diagnosticReferralCenter.update({
    where: { // @ts-ignore Prisma types
 id },
    data: // @ts-ignore
{ // @ts-ignore
 // @ts-ignore Prisma types
 isActive: false },
  });

  await logAction({
    branchId,
    actionType: 'DELETE',
    entityType: 'DiagnosticReferralCenter',
    entityId: id,
    userId,
    oldValues: existing,
  });

  return {
    id,
    message: 'Diagnostic center deactivated',
    linkedVisitCount: existing._count.visitReferrals,
  };
}
