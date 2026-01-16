import { PrismaClient, IdentifierType } from '@prisma/client';
import { generatePatientNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError } from '../utils/errors';

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

  // Note: Multiple patients can share the same phone number (e.g., family members)
  // So we don't check for duplicate identifiers

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
        name: input.name.toUpperCase(), // Medical standard: names in all caps
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

  let patients: any[] = [];

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
                  select: { id: true, name: true, code: true }
                }
              },
              orderBy: { createdAt: 'desc' },
              take: 5 // Last 5 visits for history snapshot
            }
          }
        }
      },
      take: limit
    });

    patients = identifiers.map(id => id.patient);
  } else if (query.name) {
    // Search by name
    patients = await prisma.patient.findMany({
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
              select: { id: true, name: true, code: true }
            }
          },
          orderBy: { createdAt: 'desc' },
          take: 5
        }
      },
      take: limit
    });
  } else {
    throw new ValidationError('Provide phone, email, or name to search');
  }

  // Transform to search result format with history snapshot
  return patients.map((patient: any) => ({
    patient: {
      id: patient.id,
      patientNumber: patient.patientNumber,
      name: patient.name,
      age: patient.age,
      gender: patient.gender,
      address: patient.address,
      identifiers: patient.identifiers,
      createdAt: patient.createdAt
    },
    historySnapshot: patient.visits.slice(0, 3).map((visit: any) => ({
      visitId: visit.id,
      domain: visit.domain,
      branchName: visit.branch?.name || 'Unknown',
      visitType: visit.visitType,
      createdAt: visit.createdAt
    })),
    totalVisits: patient.visits.length
  }));
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

/**
 * Patient 360 View - Complete read-only global view of patient history
 * This is the single source of truth for patient information across all branches
 */
export async function getPatient360View(patientId: string) {
  // Fetch patient with all visits and related data
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      identifiers: true,
      visits: {
        include: {
          branch: {
            select: { id: true, name: true, code: true }
          },
          bill: {
            select: { paymentType: true, paymentStatus: true }
          },
          report: {
            include: {
              versions: {
                orderBy: { versionNum: 'desc' },
                take: 1
              }
            }
          },
          clinicVisit: {
            include: {
              clinicDoctor: {
                select: { name: true }
              }
            }
          }
        },
        orderBy: { createdAt: 'desc' }
      }
    }
  });

  if (!patient) {
    return null;
  }

  // Collect unique branches where patient has activity
  const branchMap = new Map<string, { id: string; name: string }>();
  
  // Build visit timeline with proper typing
  const visitTimeline = patient.visits.map((visit: any) => {
    // Track branches
    if (visit.branch) {
      branchMap.set(visit.branch.id, {
        id: visit.branch.id,
        name: visit.branch.name
      });
    }

    // Base timeline item
    const timelineItem: any = {
      visitId: visit.id,
      domain: visit.domain,
      billNumber: visit.billNumber,
      branchId: visit.branchId,
      branchName: visit.branch?.name || 'Unknown',
      status: visit.status,
      totalAmountInPaise: visit.totalAmountInPaise,
      paymentType: visit.bill?.paymentType || 'CASH',
      paymentStatus: visit.bill?.paymentStatus || 'PENDING',
      createdAt: visit.createdAt
    };

    // Clinic-specific fields
    if (visit.domain === 'CLINIC' && visit.clinicVisit) {
      timelineItem.visitType = visit.clinicVisit.visitType;
      timelineItem.doctorName = visit.clinicVisit.clinicDoctor?.name;
    }

    // Diagnostic-specific fields - report status
    if (visit.domain === 'DIAGNOSTICS' && visit.report?.versions?.length > 0) {
      const latestVersion = visit.report.versions[0];
      timelineItem.reportStatus = latestVersion.status;
      timelineItem.reportVersionId = latestVersion.id;
      timelineItem.finalizedAt = latestVersion.finalizedAt;
    }

    return timelineItem;
  });

  return {
    patient: {
      id: patient.id,
      patientNumber: patient.patientNumber,
      name: patient.name,
      age: patient.age,
      gender: patient.gender,
      address: patient.address,
      identifiers: patient.identifiers,
      createdAt: patient.createdAt
    },
    visitTimeline,
    totalVisits: patient.visits.length,
    branches: Array.from(branchMap.values())
  };
}
