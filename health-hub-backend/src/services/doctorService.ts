import { PrismaClient } from '@prisma/client';
import { generateReferralDoctorNumber, generateClinicDoctorNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors';

const prisma = new PrismaClient();

// ==================== REFERRAL DOCTORS ====================

export interface CreateReferralDoctorInput {
  name: string;
  phone?: string;
  email?: string;
  commissionPercent: number;
  clinicDoctorId?: string; // Link if already exists as clinic doctor
  branchId: string;
  userId?: string;
}

export async function createReferralDoctor(input: CreateReferralDoctorInput) {
  // Validation
  if (input.commissionPercent < 0 || input.commissionPercent > 100) {
    throw new ValidationError('Commission percent must be between 0 and 100');
  }

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

  // Generate doctor number
  const doctorNumber = await generateReferralDoctorNumber();

  const doctor = await prisma.referralDoctor.create({
    data: {
      doctorNumber,
      name: input.name,
      phone: input.phone,
      email: input.email,
      commissionPercent: input.commissionPercent,
      clinicDoctorId: input.clinicDoctorId,
      isActive: true
    }
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
    orderBy: { createdAt: 'desc' }
  });
}

export async function updateReferralDoctor(
  id: string,
  updates: {
    name?: string;
    phone?: string;
    email?: string;
    commissionPercent?: number;
    isActive?: boolean;
  },
  branchId: string,
  userId?: string
) {
  const existing = await prisma.referralDoctor.findUnique({ where: { id } });
  if (!existing) {
    throw new NotFoundError('Referral doctor not found');
  }

  if (updates.commissionPercent !== undefined) {
    if (updates.commissionPercent < 0 || updates.commissionPercent > 100) {
      throw new ValidationError('Commission percent must be between 0 and 100');
    }
  }

  const updated = await prisma.referralDoctor.update({
    where: { id },
    data: updates
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
