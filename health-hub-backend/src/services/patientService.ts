import { PrismaClient, IdentifierType } from '@prisma/client';
import { generatePatientNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError, ConflictError } from '../utils/errors';

const prisma = new PrismaClient();

export interface CreatePatientInput {
  name: string;
  age: number;
  gender: 'M' | 'F' | 'O';
  address?: string;
  identifiers: {
    type: IdentifierType;
    value: string;
    isPrimary: boolean;
  }[];
  branchId: string; // For audit log only
  userId?: string; // For audit log
}

export async function createPatient(input: CreatePatientInput) {
  // Validation
  if (!input.identifiers || input.identifiers.length === 0) {
    throw new ValidationError('At least one identifier (phone/email) is required');
  }

  // Check for duplicate identifiers
  for (const identifier of input.identifiers) {
    const existing = await prisma.patientIdentifier.findUnique({
      where: {
        type_value: {
          type: identifier.type,
          value: identifier.value
        }
      },
      include: { patient: true }
    });

    if (existing) {
      throw new ConflictError(
        `A patient with ${identifier.type} ${identifier.value} already exists: ${existing.patient.name} (${existing.patient.patientNumber})`
      );
    }
  }

  // Validate one primary per type
  const typeCount: Record<string, number> = {};
  for (const id of input.identifiers) {
    if (id.isPrimary) {
      typeCount[id.type] = (typeCount[id.type] || 0) + 1;
      if (typeCount[id.type] > 1) {
        throw new ValidationError(`Only one primary identifier allowed per type`);
      }
    }
  }

  // Generate patient number
  const patientNumber = await generatePatientNumber();

  // Create patient with identifiers in transaction
  const patient = await prisma.$transaction(async (tx) => {
    const newPatient = await tx.patient.create({
      data: {
        patientNumber,
        name: input.name,
        age: input.age,
        gender: input.gender,
        address: input.address,
        identifiers: {
          create: input.identifiers
        }
      },
      include: {
        identifiers: true
      }
    });

    return newPatient;
  });

  // Audit log
  await logAction({
    branchId: input.branchId,
    actionType: 'CREATE',
    entityType: 'Patient',
    entityId: patient.id,
    userId: input.userId,
    newValues: patient
  });

  return patient;
}

export async function searchPatients(query: {
  phone?: string;
  email?: string;
  name?: string;
  limit?: number;
}) {
  const limit = query.limit || 20;

  // Search by identifier (phone/email)
  if (query.phone || query.email) {
    const identifierType = query.phone ? 'PHONE' : 'EMAIL';
    const identifierValue = query.phone || query.email!;

    const identifiers = await prisma.patientIdentifier.findMany({
      where: {
        type: identifierType,
        value: {
          contains: identifierValue,
          mode: 'insensitive'
        }
      },
      include: {
        patient: {
          include: {
            identifiers: true,
            visits: {
              include: {
                branch: {
                  select: { name: true, code: true }
                }
              },
              orderBy: { createdAt: 'desc' },
              take: 5 // Last 5 visits
            }
          }
        }
      },
      take: limit
    });

    return identifiers.map(id => id.patient);
  }

  // Search by name
  if (query.name) {
    const patients = await prisma.patient.findMany({
      where: {
        name: {
          contains: query.name,
          mode: 'insensitive'
        }
      },
      include: {
        identifiers: true,
        visits: {
          include: {
            branch: {
              select: { name: true, code: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 5
        }
      },
      take: limit
    });

    return patients;
  }

  throw new ValidationError('Provide phone, email, or name to search');
}

export async function getPatientById(patientId: string) {
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      identifiers: true,
      visits: {
        include: {
          branch: {
            select: { name: true, code: true }
          }
        },
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  return patient;
}
