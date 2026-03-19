import { generateReferralDoctorNumber, generateClinicDoctorNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors';
import prisma from '../lib/prisma';
import type { NormalizedReferralPayout } from './referralPayoutService';


// ==================== REFERRAL DOCTORS ====================

export interface ReferralDoctorProductRuleInput extends NormalizedReferralPayout {
  productId: string;
}

export interface CreateReferralDoctorInput {
  name: string;
  phone?: string;
  email?: string;
  commissionType: NormalizedReferralPayout['commissionType'];
  commissionPercent: number | null;
  commissionAmountInPaise: number | null;
  productRules?: ReferralDoctorProductRuleInput[];
  clinicDoctorId?: string; // Link if already exists as clinic doctor
  branchId: string;
  userId?: string;
}

function validateReferralPayout(input: Pick<NormalizedReferralPayout, 'commissionType' | 'commissionPercent' | 'commissionAmountInPaise'>) {
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

function validateProductRules(productRules?: ReferralDoctorProductRuleInput[]) {
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
    validateReferralPayout(rule);
  }
}

export async function createReferralDoctor(input: CreateReferralDoctorInput) {
  // Validation
  validateReferralPayout(input);
  validateProductRules(input.productRules);

  // Check for duplicates by phone/email
  if (input.phone) {
    const existing = await prisma.referralDoctor.findFirst({
      where: { phone: input.phone, isActive: true }
    });
    if (existing) {
      throw new ConflictError(
        `Referral doctor with phone ${input.phone} already exists: ${existing.name} (${existing.doctorNumber})`
      );
    }
  }

  // If linking to clinic doctor, verify it exists
  if (input.clinicDoctorId) {
    const clinicDoctor = await prisma.clinicDoctor.findUnique({
      where: { id: input.clinicDoctorId }
    });
    if (!clinicDoctor) {
      throw new NotFoundError('Clinic doctor not found');
    }
  }

  if (input.productRules?.length) {
    const productCount = await prisma.billableProduct.count({
      where: { id: { in: input.productRules.map((rule) => rule.productId) } },
    });

    if (productCount !== input.productRules.length) {
      throw new ValidationError('One or more product rules reference an invalid product');
    }
  }

  // Generate doctor number
  const doctorNumber = await generateReferralDoctorNumber();

  const doctor = await prisma.$transaction(async (tx) => {
    const created = await tx.referralDoctor.create({
      data: {
        doctorNumber,
        name: input.name,
        phone: input.phone,
        email: input.email,
        commissionType: input.commissionType,
        commissionPercent: input.commissionPercent ?? 0,
        commissionAmountInPaise: input.commissionAmountInPaise,
        clinicDoctorId: input.clinicDoctorId,
        isActive: true
      }
    });

    if (input.productRules?.length) {
      await tx.referralDoctorProductRule.createMany({
        data: input.productRules.map((rule) => ({
          referralDoctorId: created.id,
          productId: rule.productId,
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
          isActive: true,
        })),
      });
    }

    return tx.referralDoctor.findUniqueOrThrow({
      where: { id: created.id },
      include: {
        productRules: {
          where: { isActive: true },
          include: {
            product: {
              select: { id: true, name: true, code: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  });

  // Audit log
  await logAction({
    branchId: input.branchId,
    actionType: 'CREATE',
    entityType: 'ReferralDoctor',
    entityId: doctor.id,
    userId: input.userId,
    newValues: doctor
  });

  return doctor;
}

export async function listReferralDoctors(includeInactive = false) {
  return prisma.referralDoctor.findMany({
    where: includeInactive ? {} : { isActive: true },
    include: {
      productRules: {
        where: { isActive: true },
        include: {
          product: {
            select: { id: true, name: true, code: true },
          },
        },
        orderBy: { createdAt: 'asc' },
      },
    },
    orderBy: { createdAt: 'desc' }
  });
}

export async function updateReferralDoctor(
  id: string,
  updates: {
    name?: string;
    phone?: string;
    email?: string;
    commissionType?: NormalizedReferralPayout['commissionType'];
    commissionPercent?: number | null;
    commissionAmountInPaise?: number | null;
    productRules?: ReferralDoctorProductRuleInput[];
    isActive?: boolean;
  },
  branchId: string,
  userId?: string
) {
  const existing = await prisma.referralDoctor.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError('Referral doctor not found');
  }

  if (
    updates.commissionType !== undefined ||
    updates.commissionPercent !== undefined ||
    updates.commissionAmountInPaise !== undefined
  ) {
    validateReferralPayout({
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
      where: { id: { in: updates.productRules.map((rule) => rule.productId) } },
    });

    if (productCount !== updates.productRules.length) {
      throw new ValidationError('One or more product rules reference an invalid product');
    }
  }

  const updated = await prisma.$transaction(async (tx) => {
    await tx.referralDoctor.update({
      where: { id },
      data: {
        name: updates.name,
        phone: updates.phone,
        email: updates.email,
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
      await tx.referralDoctorProductRule.deleteMany({
        where: { referralDoctorId: id },
      });

      if (updates.productRules.length > 0) {
        await tx.referralDoctorProductRule.createMany({
          data: updates.productRules.map((rule) => ({
            referralDoctorId: id,
            productId: rule.productId,
            commissionType: rule.commissionType,
            commissionPercent: rule.commissionPercent,
            commissionAmountInPaise: rule.commissionAmountInPaise,
            isActive: true,
          })),
        });
      }
    }

    return tx.referralDoctor.findUniqueOrThrow({
      where: { id },
      include: {
        productRules: {
          where: { isActive: true },
          include: {
            product: {
              select: { id: true, name: true, code: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
  });

  // Audit log
  await logAction({
    branchId,
    actionType: 'UPDATE',
    entityType: 'ReferralDoctor',
    entityId: id,
    userId,
    oldValues: existing,
    newValues: updated
  });

  return updated;
}

export async function deactivateReferralDoctor(
  id: string,
  branchId: string,
  userId?: string
) {
  const existing = await prisma.referralDoctor.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError('Referral doctor not found');
  }

  const updated = await prisma.referralDoctor.update({
    where: { id },
    data: { isActive: false }
  });

  // Audit log
  await logAction({
    branchId,
    actionType: 'DELETE',
    entityType: 'ReferralDoctor',
    entityId: id,
    userId,
    oldValues: existing
  });

  return updated;
}

export async function searchReferralDoctorByContact(
  phone?: string,
  email?: string
) {
  if (!phone && !email) {
    return null;
  }

  return prisma.referralDoctor.findFirst({
    where: {
      OR: [
        phone ? { phone } : {},
        email ? { email } : {}
      ],
      isActive: true
    }
  });
}

// ==================== CLINIC DOCTORS ====================

export interface CreateClinicDoctorInput {
  name: string;
  qualification: string;
  specialty: string;
  registrationNumber: string;
  phone?: string;
  email?: string;
  letterheadNote?: string;
  commissionType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
  commissionPercent?: number;
  commissionAmountInPaise?: number;
  referralDoctorId?: string; // Link if already exists as referral doctor
  branchId: string;
  userId?: string;
}

export async function createClinicDoctor(input: CreateClinicDoctorInput) {
  // Check for duplicate registration number
  const existingReg = await prisma.clinicDoctor.findUnique({
    where: { registrationNumber: input.registrationNumber }
  });
  if (existingReg) {
    throw new ConflictError(
      `Clinic doctor with registration ${input.registrationNumber} already exists: ${existingReg.name} (${existingReg.doctorNumber})`
    );
  }

  // Check for duplicates by phone
  if (input.phone) {
    const existing = await prisma.clinicDoctor.findFirst({
      where: { phone: input.phone, isActive: true }
    });
    if (existing) {
      throw new ConflictError(
        `Clinic doctor with phone ${input.phone} already exists: ${existing.name} (${existing.doctorNumber})`
      );
    }
  }

  // If linking to referral doctor, verify it exists
  if (input.referralDoctorId) {
    const referralDoctor = await prisma.referralDoctor.findUnique({
      where: { id: input.referralDoctorId }
    });
    if (!referralDoctor) {
      throw new NotFoundError('Referral doctor not found');
    }
  }

  // Generate doctor number
  const doctorNumber = await generateClinicDoctorNumber();

  const doctor = await prisma.clinicDoctor.create({
    data: {
      doctorNumber,
      name: input.name,
      qualification: input.qualification,
      specialty: input.specialty,
      registrationNumber: input.registrationNumber,
      phone: input.phone,
      email: input.email,
      letterheadNote: input.letterheadNote,
      commissionType: input.commissionType ?? 'PERCENTAGE',
      commissionPercent: input.commissionPercent ?? 100,
      commissionAmountInPaise: input.commissionAmountInPaise,
      referralDoctorId: input.referralDoctorId,
      isActive: true
    }
  });

  // Audit log
  await logAction({
    branchId: input.branchId,
    actionType: 'CREATE',
    entityType: 'ClinicDoctor',
    entityId: doctor.id,
    userId: input.userId,
    newValues: doctor
  });

  return doctor;
}

export async function listClinicDoctors(includeInactive = false) {
  return prisma.clinicDoctor.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: { createdAt: 'desc' }
  });
}

export async function updateClinicDoctor(
  id: string,
  updates: {
    name?: string;
    qualification?: string;
    specialty?: string;
    phone?: string;
    email?: string;
    letterheadNote?: string;
    commissionType?: 'PERCENTAGE' | 'FIXED_AMOUNT';
    commissionPercent?: number;
    commissionAmountInPaise?: number;
  },
  branchId: string,
  userId?: string
) {
  const existing = await prisma.clinicDoctor.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError('Clinic doctor not found');
  }

  const updated = await prisma.clinicDoctor.update({
    where: { id },
    data: updates
  });

  // Audit log
  await logAction({
    branchId,
    actionType: 'UPDATE',
    entityType: 'ClinicDoctor',
    entityId: id,
    userId,
    oldValues: existing,
    newValues: updated
  });

  return updated;
}

export async function deactivateClinicDoctor(
  id: string,
  branchId: string,
  userId?: string
) {
  const existing = await prisma.clinicDoctor.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError('Clinic doctor not found');
  }

  const updated = await prisma.clinicDoctor.update({
    where: { id },
    data: { isActive: false }
  });

  // Audit log
  await logAction({
    branchId,
    actionType: 'DELETE',
    entityType: 'ClinicDoctor',
    entityId: id,
    userId,
    oldValues: existing
  });

  return updated;
}

export async function searchClinicDoctorByContact(
  phone?: string,
  email?: string
) {
  if (!phone && !email) {
    return null;
  }

  return prisma.clinicDoctor.findFirst({
    where: {
      OR: [
        phone ? { phone } : {},
        email ? { email } : {}
      ],
      isActive: true
    }
  });
}
