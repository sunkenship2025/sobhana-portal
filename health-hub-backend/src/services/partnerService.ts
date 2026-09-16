/**
 * Partner master — outside labs and referring centres, one list.
 *
 * Replaces externalLabService (we send out) and diagnosticCenterService (they
 * send in). Those were the same relationship written twice in opposite
 * directions, which meant a partner who does both — the normal case in lab work —
 * had to be entered twice and reconciled by hand.
 *
 * Rates live on PartnerArrangement and its two rule tables; resolution is in
 * partnerRateService. This file only writes them.
 */
import type {
  PartnerArrangementKind,
  PartnerDoctorCommissionMode,
  PartnerRateBasis,
} from '@prisma/client';
import { generateNextNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors';
import prisma from '../lib/prisma';

export interface PartnerRuleInput {
  /** Exactly one of productId / category, depending on which rung this is. */
  productId?: string;
  category?: string;
  branchId?: string | null;
  rateBasis: PartnerRateBasis;
  ratePercent?: number | null;
  rateAmountInPaise?: number | null;
  doctorCommissionMode?: PartnerDoctorCommissionMode | null;
}

export interface PartnerArrangementInput {
  kind: PartnerArrangementKind;
  weCollect?: boolean;
  rateBasis: PartnerRateBasis;
  ratePercent?: number | null;
  rateAmountInPaise?: number | null;
  doctorCommissionMode?: PartnerDoctorCommissionMode;
  isActive?: boolean;
  productRules?: PartnerRuleInput[];
  categoryRules?: PartnerRuleInput[];
}

export interface CreatePartnerInput {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  sendBill?: boolean;
  sendReport?: boolean;
  arrangements?: PartnerArrangementInput[];
  branchId: string;
  userId?: string;
}

/** Who takes the patient's money, when the caller does not say. */
const COLLECTS_BY_DEFAULT: Record<PartnerArrangementKind, boolean> = {
  INBOUND_BILLED_HERE: true,
  INBOUND_BILLED_THERE: false,
  OUTBOUND_VENDOR: true,
};

function validateRate(r: {
  rateBasis: PartnerRateBasis;
  ratePercent?: number | null;
  rateAmountInPaise?: number | null;
}) {
  if (r.rateBasis === 'FLAT') {
    if (r.rateAmountInPaise == null || r.rateAmountInPaise < 0) {
      throw new ValidationError('A flat partner rate needs a non-negative amount');
    }
    return;
  }
  if (r.ratePercent == null || r.ratePercent < 0 || r.ratePercent > 100) {
    throw new ValidationError('A partner rate percentage must be between 0 and 100');
  }
}

function validateArrangements(arrangements?: PartnerArrangementInput[]) {
  if (!arrangements?.length) return;
  const kinds = new Set<string>();
  for (const a of arrangements) {
    if (kinds.has(a.kind)) {
      throw new ValidationError(`Duplicate arrangement: ${a.kind}`);
    }
    kinds.add(a.kind);
    validateRate(a);

    const seenProduct = new Set<string>();
    for (const r of a.productRules ?? []) {
      if (!r.productId) throw new ValidationError('Each product rule needs a productId');
      const key = `${r.branchId ?? 'global'}:${r.productId}`;
      if (seenProduct.has(key)) throw new ValidationError('Duplicate product rule');
      seenProduct.add(key);
      validateRate(r);
    }
    const seenCategory = new Set<string>();
    for (const r of a.categoryRules ?? []) {
      if (!r.category?.trim()) throw new ValidationError('Each category rule needs a category');
      const key = `${r.branchId ?? 'global'}:${r.category.trim()}`;
      if (seenCategory.has(key)) throw new ValidationError('Duplicate category rule');
      seenCategory.add(key);
      validateRate(r);
    }
  }
}

async function assertProductsExist(arrangements?: PartnerArrangementInput[]) {
  const ids = [
    ...new Set((arrangements ?? []).flatMap((a) => (a.productRules ?? []).map((r) => r.productId!))),
  ];
  if (!ids.length) return;
  const found = await prisma.billableProduct.count({ where: { id: { in: ids } } });
  if (found !== ids.length) {
    throw new ValidationError('One or more product rules reference an invalid product');
  }
}

export function partnerInclude() {
  return {
    arrangements: {
      orderBy: { kind: 'asc' as const },
      include: {
        productRules: {
          where: { isActive: true },
          include: { product: { select: { id: true, name: true, code: true } } },
          orderBy: { createdAt: 'asc' as const },
        },
        categoryRules: {
          where: { isActive: true },
          orderBy: { category: 'asc' as const },
        },
      },
    },
    _count: { select: { visits: true, testOrders: true, payoutLedger: true } },
  };
}

async function writeArrangements(
  tx: Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>,
  partnerId: string,
  arrangements: PartnerArrangementInput[],
) {
  for (const a of arrangements) {
    const created = await tx.partnerArrangement.create({
      data: {
        partnerId,
        kind: a.kind,
        isActive: a.isActive ?? true,
        weCollect: a.weCollect ?? COLLECTS_BY_DEFAULT[a.kind],
        rateBasis: a.rateBasis,
        ratePercent: a.rateBasis === 'FLAT' ? null : (a.ratePercent ?? 0),
        rateAmountInPaise: a.rateBasis === 'FLAT' ? (a.rateAmountInPaise ?? 0) : null,
        doctorCommissionMode: a.doctorCommissionMode ?? 'OUR_SHARE',
      },
    });
    if (a.productRules?.length) {
      await tx.partnerProductRule.createMany({
        data: a.productRules.map((r) => ({
          arrangementId: created.id,
          branchId: r.branchId ?? null,
          productId: r.productId!,
          rateBasis: r.rateBasis,
          ratePercent: r.rateBasis === 'FLAT' ? null : (r.ratePercent ?? 0),
          rateAmountInPaise: r.rateBasis === 'FLAT' ? (r.rateAmountInPaise ?? 0) : null,
          doctorCommissionMode: r.doctorCommissionMode ?? null,
        })),
      });
    }
    if (a.categoryRules?.length) {
      await tx.partnerCategoryRule.createMany({
        data: a.categoryRules.map((r) => ({
          arrangementId: created.id,
          branchId: r.branchId ?? null,
          category: r.category!.trim(),
          rateBasis: r.rateBasis,
          ratePercent: r.rateBasis === 'FLAT' ? null : (r.ratePercent ?? 0),
          rateAmountInPaise: r.rateBasis === 'FLAT' ? (r.rateAmountInPaise ?? 0) : null,
          doctorCommissionMode: r.doctorCommissionMode ?? null,
        })),
      });
    }
  }
}

export async function createPartner(input: CreatePartnerInput) {
  const name = input.name.trim();
  if (!name) throw new ValidationError('Partner name is required');
  validateArrangements(input.arrangements);
  await assertProductsExist(input.arrangements);

  const duplicate = await prisma.partner.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
  });
  if (duplicate) throw new ConflictError(`Partner "${name}" already exists`);

  const partnerNumber = await generateNextNumber('partner', 'PT');

  const partner = await prisma.$transaction(async (tx) => {
    const created = await tx.partner.create({
      data: {
        name,
        partnerNumber,
        contactPerson: input.contactPerson?.trim() || null,
        phone: input.phone?.trim() || null,
        email: input.email?.trim() || null,
        address: input.address?.trim() || null,
        sendBill: input.sendBill ?? false,
        sendReport: input.sendReport ?? true,
      },
    });
    await writeArrangements(tx, created.id, input.arrangements ?? []);
    return tx.partner.findUniqueOrThrow({ where: { id: created.id }, include: partnerInclude() });
  });

  await logAction({
    branchId: input.branchId,
    actionType: 'CREATE',
    entityType: 'Partner',
    entityId: partner.id,
    userId: input.userId,
    newValues: partner,
  });
  return partner;
}

export async function listPartners(includeInactive = false, search?: string) {
  return prisma.partner.findMany({
    where: {
      ...(includeInactive ? {} : { isActive: true }),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { partnerNumber: { contains: search, mode: 'insensitive' } },
              { contactPerson: { contains: search, mode: 'insensitive' } },
              { phone: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    include: partnerInclude(),
    orderBy: { name: 'asc' },
  });
}

export async function getPartnerById(id: string) {
  return prisma.partner.findUnique({ where: { id }, include: partnerInclude() });
}

export async function updatePartner(
  id: string,
  updates: Partial<Omit<CreatePartnerInput, 'branchId' | 'userId'>> & { isActive?: boolean },
  branchId: string,
  userId?: string,
) {
  const existing = await prisma.partner.findUnique({ where: { id }, include: partnerInclude() });
  if (!existing) throw new NotFoundError('Partner not found');

  if (updates.name !== undefined) {
    const name = updates.name.trim();
    if (!name) throw new ValidationError('Partner name cannot be empty');
    const duplicate = await prisma.partner.findFirst({
      where: { id: { not: id }, name: { equals: name, mode: 'insensitive' } },
    });
    if (duplicate) throw new ConflictError(`Partner "${name}" already exists`);
  }

  validateArrangements(updates.arrangements);
  await assertProductsExist(updates.arrangements);

  const updated = await prisma.$transaction(async (tx) => {
    await tx.partner.update({
      where: { id },
      data: {
        name: updates.name?.trim(),
        contactPerson:
          updates.contactPerson !== undefined ? updates.contactPerson?.trim() || null : undefined,
        phone: updates.phone !== undefined ? updates.phone?.trim() || null : undefined,
        email: updates.email !== undefined ? updates.email?.trim() || null : undefined,
        address: updates.address !== undefined ? updates.address?.trim() || null : undefined,
        sendBill: updates.sendBill,
        sendReport: updates.sendReport,
        isActive: updates.isActive,
      },
    });
    // Rewritten wholesale, like the referral rules: the editor always sends the
    // complete ladder, so a removed rule is a removed row. Frozen TestOrder
    // snapshots mean this never disturbs money already booked.
    if (updates.arrangements !== undefined) {
      await tx.partnerArrangement.deleteMany({ where: { partnerId: id } });
      await writeArrangements(tx, id, updates.arrangements);
    }
    return tx.partner.findUniqueOrThrow({ where: { id }, include: partnerInclude() });
  });

  await logAction({
    branchId,
    actionType: 'UPDATE',
    entityType: 'Partner',
    entityId: id,
    userId,
    oldValues: existing,
    newValues: updated,
  });
  return updated;
}

export async function deactivatePartner(id: string, branchId: string, userId?: string) {
  const existing = await prisma.partner.findUnique({
    where: { id },
    include: { _count: { select: { visits: true, testOrders: true } } },
  });
  if (!existing) throw new NotFoundError('Partner not found');

  await prisma.partner.update({ where: { id }, data: { isActive: false } });
  await logAction({
    branchId,
    actionType: 'DELETE',
    entityType: 'Partner',
    entityId: id,
    userId,
    oldValues: existing,
  });
  return {
    id,
    message: 'Partner deactivated',
    linkedVisitCount: existing._count.visits,
    linkedOrderCount: existing._count.testOrders,
  };
}
