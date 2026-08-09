import { generateReferralDoctorNumber, generateClinicDoctorNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors';
import prisma from '../lib/prisma';
import type { NormalizedReferralPayout } from './referralPayoutService';


// ==================== REFERRAL DOCTORS ====================

export interface ReferralDoctorProductRuleInput extends NormalizedReferralPayout {
  productId: string;
}

export interface ReferralDoctorCategoryRuleInput
  extends Pick<NormalizedReferralPayout, 'commissionType' | 'commissionPercent' | 'commissionAmountInPaise'> {
  category: string;
}

// A create/update of a doctor's rules always targets ONE scope: null = the
// doctor's global rate (every branch), or a branchId = that branch's override.
// Rules for other scopes are left untouched, so editing one branch tab can
// never wipe another's overrides.

export interface CreateReferralDoctorInput {
  name: string;
  phone?: string;
  email?: string;
  commissionType: NormalizedReferralPayout['commissionType'];
  commissionPercent: number | null;
  commissionAmountInPaise: number | null;
  productRules?: ReferralDoctorProductRuleInput[];
  categoryRules?: ReferralDoctorCategoryRuleInput[];
  rulesBranchId?: string | null; // scope the productRules/categoryRules apply to (null = global)
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

function validateCategoryRules(categoryRules?: ReferralDoctorCategoryRuleInput[]) {
  if (!categoryRules) return;

  const seen = new Set<string>();
  for (const rule of categoryRules) {
    const category = rule.category?.trim();
    if (!category) {
      throw new ValidationError('Each category rule must include a category');
    }
    if (seen.has(category)) {
      throw new ValidationError('Duplicate category rule found');
    }
    seen.add(category);
    validateReferralPayout(rule);
  }
}

// Shared include for returning a referral doctor with its overrides.
const REFERRAL_DOCTOR_INCLUDE = {
  productRules: {
    where: { isActive: true },
    include: { product: { select: { id: true, name: true, code: true } } },
    orderBy: { createdAt: 'asc' },
  },
  categoryRules: {
    where: { isActive: true },
    orderBy: { category: 'asc' },
  },
} as const;

export async function createReferralDoctor(input: CreateReferralDoctorInput) {
  // Validation
  validateReferralPayout(input);
  validateProductRules(input.productRules);
  validateCategoryRules(input.categoryRules);

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

    const rulesBranchId = input.rulesBranchId ?? null;

    if (input.productRules?.length) {
      await tx.referralDoctorProductRule.createMany({
        data: input.productRules.map((rule) => ({
          referralDoctorId: created.id,
          branchId: rulesBranchId,
          productId: rule.productId,
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
          isActive: true,
        })),
      });
    }

    if (input.categoryRules?.length) {
      await tx.referralDoctorCategoryRule.createMany({
        data: input.categoryRules.map((rule) => ({
          referralDoctorId: created.id,
          branchId: rulesBranchId,
          category: rule.category.trim(),
          commissionType: rule.commissionType,
          commissionPercent: rule.commissionPercent,
          commissionAmountInPaise: rule.commissionAmountInPaise,
          isActive: true,
        })),
      });
    }

    return tx.referralDoctor.findUniqueOrThrow({
      where: { id: created.id },
      include: REFERRAL_DOCTOR_INCLUDE,
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
  const doctors = await prisma.referralDoctor.findMany({
    where: includeInactive ? {} : { isActive: true },
    include: REFERRAL_DOCTOR_INCLUDE,
    orderBy: { createdAt: 'desc' }
  });
  if (doctors.length === 0) return doctors;

  // Which branches each doctor has referred to (for branch-wise grouping in the
  // UI — a doctor who referred to two branches is listed under both).
  const branchRows = await prisma.referralDoctor_Visit.groupBy({
    by: ['referralDoctorId', 'branchId'],
    where: { referralDoctorId: { in: doctors.map((d) => d.id) } },
  });
  const branchesByDoctor = new Map<string, string[]>();
  for (const row of branchRows) {
    const list = branchesByDoctor.get(row.referralDoctorId) ?? [];
    list.push(row.branchId);
    branchesByDoctor.set(row.referralDoctorId, list);
  }
  return doctors.map((d) => ({ ...d, branchIds: branchesByDoctor.get(d.id) ?? [] }));
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
    categoryRules?: ReferralDoctorCategoryRuleInput[];
    rulesBranchId?: string | null; // scope the rule replacement targets (null = global)
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
  validateCategoryRules(updates.categoryRules);

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

    // Replace rules only WITHIN the edited scope (branch tab). Other scopes'
    // overrides are untouched, so editing Balanagar never wipes Chintak/global.
    const rulesBranchId = updates.rulesBranchId ?? null;

    if (updates.productRules !== undefined) {
      await tx.referralDoctorProductRule.deleteMany({
        where: { referralDoctorId: id, branchId: rulesBranchId },
      });

      if (updates.productRules.length > 0) {
        await tx.referralDoctorProductRule.createMany({
          data: updates.productRules.map((rule) => ({
            referralDoctorId: id,
            branchId: rulesBranchId,
            productId: rule.productId,
            commissionType: rule.commissionType,
            commissionPercent: rule.commissionPercent,
            commissionAmountInPaise: rule.commissionAmountInPaise,
            isActive: true,
          })),
        });
      }
    }

    if (updates.categoryRules !== undefined) {
      await tx.referralDoctorCategoryRule.deleteMany({
        where: { referralDoctorId: id, branchId: rulesBranchId },
      });

      if (updates.categoryRules.length > 0) {
        await tx.referralDoctorCategoryRule.createMany({
          data: updates.categoryRules.map((rule) => ({
            referralDoctorId: id,
            branchId: rulesBranchId,
            category: rule.category.trim(),
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
      include: REFERRAL_DOCTOR_INCLUDE,
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
  // Build OR list from only the fields that are actually set. Previous code did
  // `OR: [phone ? { phone } : {}, ...]` which becomes `OR: [{}]` when both are
  // missing, and Prisma treats an empty object as "match every row" — so the
  // helper would return the first active doctor and break duplicate-create
  // checks for doctors registered without contact info.
  const conditions: any[] = [];
  if (phone) conditions.push({ phone });
  if (email) conditions.push({ email });
  if (conditions.length === 0) return null;

  return prisma.referralDoctor.findFirst({
    where: {
      OR: conditions,
      isActive: true,
    },
  });
}

// ==================== REFERRAL CATEGORY RATE CARD ====================
// Branch-scoped referral rate per payout category (the base commission for a
// referred test, resolved from the test's panel category). A row with
// branchId = null is the GLOBAL default every branch inherits; a row with a
// branchId overrides it for that branch. A per-doctor category rule /
// per-product rule / ad-hoc bill override takes precedence at billing time.

export interface ReferralCategoryRateInput
  extends Pick<NormalizedReferralPayout, 'commissionType' | 'commissionPercent' | 'commissionAmountInPaise'> {
  category: string;
}

/**
 * List the rate card for a scope. Global scope (branchId = null) returns just
 * the global rows; a branch scope returns the global rows PLUS that branch's
 * overrides, so the UI can show the effective (inherited-or-overridden) value.
 */
export async function listReferralCategoryRates(branchId: string | null = null) {
  return prisma.referralCategoryRate.findMany({
    where:
      branchId === null
        ? { isActive: true, branchId: null }
        : { isActive: true, OR: [{ branchId }, { branchId: null }] },
    orderBy: { category: 'asc' },
  });
}

/**
 * Save the rate card for ONE scope (branchId = null for global, or a branchId
 * for a branch override). The payload is the full set of rows for that scope:
 * rows present are upserted, rows absent are removed — so clearing a branch
 * override reverts that category to the global default, and clearing a global
 * row removes it. Only the given scope is touched; other branches are untouched.
 */
export async function setReferralCategoryRates(
  rates: ReferralCategoryRateInput[],
  scopeBranchId: string | null,
  auditBranchId: string,
  userId?: string,
) {
  const seen = new Set<string>();
  for (const rate of rates) {
    const category = rate.category?.trim();
    if (!category) {
      throw new ValidationError('Each category rate must include a category');
    }
    if (seen.has(category)) {
      throw new ValidationError(`Duplicate category rate for "${category}"`);
    }
    seen.add(category);
    validateReferralPayout(rate);
  }
  const keep = Array.from(seen);

  const results = await prisma.$transaction(async (tx) => {
    // Remove rows in this scope that the owner cleared (absent from the payload).
    await tx.referralCategoryRate.deleteMany({
      where: {
        branchId: scopeBranchId,
        ...(keep.length > 0 ? { category: { notIn: keep } } : {}),
      },
    });

    const saved = [];
    for (const rate of rates) {
      const category = rate.category.trim();
      const data = {
        commissionType: rate.commissionType,
        commissionPercent: rate.commissionPercent,
        commissionAmountInPaise: rate.commissionAmountInPaise,
        isActive: true,
      };
      // No compound-unique upsert (null branchId is awkward there) — find then write.
      const existing = await tx.referralCategoryRate.findFirst({
        where: { branchId: scopeBranchId, category },
      });
      saved.push(
        existing
          ? await tx.referralCategoryRate.update({ where: { id: existing.id }, data })
          : await tx.referralCategoryRate.create({ data: { branchId: scopeBranchId, category, ...data } }),
      );
    }
    return saved;
  });

  await logAction({
    branchId: auditBranchId,
    actionType: 'UPDATE',
    entityType: 'ReferralCategoryRate',
    entityId: scopeBranchId ? `rate-card:${scopeBranchId}` : 'rate-card:global',
    userId,
    newValues: results,
  });

  return results;
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
  consultationFeeInPaise?: number;
  referralDoctorId?: string; // Link if already exists as referral doctor
  branchId: string;
  userId?: string;
}

export async function createClinicDoctor(input: CreateClinicDoctorInput) {
  // Registration number is required and must be unique. The Postgres unique
  // constraint treats NULL = NULL as "not equal", so a nullable column with
  // multiple null rows wouldn't catch duplicates — and `findUnique({ where:
  // { registrationNumber: null } })` is a Prisma type error anyway. Reject
  // missing/blank registration numbers up front.
  const trimmedReg = input.registrationNumber?.trim();
  if (!trimmedReg) {
    throw new ValidationError('Registration number is required for clinic doctors');
  }

  // Check for duplicate registration number
  const existingReg = await prisma.clinicDoctor.findUnique({
    where: { registrationNumber: trimmedReg }
  });
  if (existingReg) {
    throw new ConflictError(
      `Clinic doctor with registration ${trimmedReg} already exists: ${existingReg.name} (${existingReg.doctorNumber})`
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
      registrationNumber: trimmedReg,
      phone: input.phone,
      email: input.email,
      letterheadNote: input.letterheadNote,
      consultationFeeInPaise: input.consultationFeeInPaise,
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
    consultationFeeInPaise?: number;
    roomLabel?: string | null;
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
  // See note on searchReferralDoctorByContact — OR with empty objects is a
  // match-everything trap.
  const conditions: any[] = [];
  if (phone) conditions.push({ phone });
  if (email) conditions.push({ email });
  if (conditions.length === 0) return null;

  return prisma.clinicDoctor.findFirst({
    where: {
      OR: conditions,
      isActive: true,
    },
  });
}
