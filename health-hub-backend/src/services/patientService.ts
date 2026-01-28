import { PrismaClient, IdentifierType, PatientChangeType } from '@prisma/client';
import { generatePatientNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError, ConflictError } from '../utils/errors';
import * as patientMatching from './patientMatchingService';
import crypto from 'crypto';

const prisma = new PrismaClient();

/**
 * E2-16: Convert string to 32-bit signed integer for PostgreSQL advisory lock
 * Uses first 4 bytes of SHA-256 hash to ensure consistent lock ID for same input
 */
function stringToLockId(input: string): number {
  const hash = crypto.createHash('sha256').update(input).digest();
  // Read first 4 bytes as signed 32-bit integer (PostgreSQL bigint range)
  return hash.readInt32BE(0);
}

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
  forceDuplicate?: boolean; // E2-03: Explicit user confirmation to create duplicate
}

export async function createPatient(input: CreatePatientInput) {
  // Validation
  if (!input.identifiers || input.identifiers.length === 0) {
    throw new ValidationError('At least one identifier (phone/email) is required');
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

  // E2-02 & E2-16: Use advisory lock to prevent concurrent duplicate patient creation
  const primaryPhone = input.identifiers.find(id => id.type === 'PHONE' && id.isPrimary);
  
  // Wrap duplicate check and creation in transaction with advisory lock
  const patient = await prisma.$transaction(async (tx) => {
    // E2-16: Acquire advisory lock on phone number before checking duplicates
    // This ensures only one request can check+create for this phone at a time
    if (primaryPhone) {
      const lockId = stringToLockId(primaryPhone.value);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${lockId})`;
      // Lock automatically released when transaction commits/rolls back
    }

    // E2-02 & SHP-1: Use centralized matching service for duplicate detection
    // E2-03: Never auto-merge - throw error if potential duplicate found
    if (primaryPhone && !input.forceDuplicate) {
      const existingCheck = await patientMatching.checkPatientExists({
        phone: primaryPhone.value
      });

      if (existingCheck.exists) {
        const existingPatient = existingCheck.patient;
        
        // Check if it's the same person (not just same phone/family member)
        const normalizedInputName = input.name.toUpperCase().trim();
        const normalizedExistingName = existingPatient.name.toUpperCase().trim();
        
        const nameMatch = normalizedExistingName === normalizedInputName;
        const genderMatch = existingPatient.gender === input.gender;
        const ageClose = Math.abs(existingPatient.age - input.age) <= 1;
        
        if (nameMatch && genderMatch && ageClose) {
          // E2-03: Potential duplicate detected - DO NOT auto-merge
          // Frontend must handle this and let user decide (confirm duplicate or create new)
          throw new ConflictError(
            JSON.stringify({
              error: 'POTENTIAL_DUPLICATE',
              message: 'A patient with similar details already exists',
              existingPatient: {
                id: existingPatient.id,
                patientNumber: existingPatient.patientNumber,
                name: existingPatient.name,
                age: existingPatient.age,
                gender: existingPatient.gender,
                phone: primaryPhone.value
              }
            })
          );
        }
        // Different family member with same phone - proceed with creation
      }
    }
    
    // No duplicate found - proceed with creating new patient
    // Generate patient number
    const patientNumber = await generatePatientNumber();

    // Create patient with identifiers
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

/**
 * E2-02: Search patients using centralized matching strategy
 * 
 * Priority:
 * 1. Phone (primary, exact match)
 * 2. Email (primary, exact match)
 * 3. Name (secondary, fuzzy match)
 */
export async function searchPatients(query: {
  phone?: string;
  email?: string;
  name?: string;
  limit?: number;
}) {
  const limit = query.limit || 20;

  // Use centralized patient matching service (E2-02)
  const matches = await patientMatching.findPatientsByIdentifier(
    {
      phone: query.phone,
      email: query.email,
      name: query.name
    },
    {
      limit,
      includeVisitHistory: true,
      strictMode: false // Allow fuzzy name matching
    }
  );

  // Return just the patient data (without match metadata)
  // Frontend doesn't need to know about match scores/confidence
  const patients = matches.map(match => match.patient);

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

// ============================================================================
// SHP-14 (E2-13a): Patient Editing with Mandatory Reason for Identity Fields
// ============================================================================

// Identity fields that require change reason for staff
const IDENTITY_FIELDS = ['name', 'age', 'gender', 'phone', 'email'];

export interface UpdatePatientInput {
  patientId: string;
  updates: {
    name?: string;
    age?: number;
    gender?: 'M' | 'F' | 'O';
    address?: string;
    phone?: string; // Primary phone
    email?: string; // Primary email
  };
  changeReason?: string;
  userId: string;
  userRole: string; // staff, admin, owner
  branchId: string; // For audit log
}

export async function updatePatient(input: UpdatePatientInput) {
  const { patientId, updates, changeReason, userId, userRole, branchId } = input;

  // Fetch existing patient
  const existingPatient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      identifiers: true
    }
  });

  if (!existingPatient) {
    throw new ValidationError('Patient not found');
  }

  // Build map of current values
  const currentPhone = existingPatient.identifiers.find(
    id => id.type === 'PHONE' && id.isPrimary
  )?.value;
  const currentEmail = existingPatient.identifiers.find(
    id => id.type === 'EMAIL' && id.isPrimary
  )?.value;

  const currentValues: Record<string, any> = {
    name: existingPatient.name,
    age: existingPatient.age,
    gender: existingPatient.gender,
    address: existingPatient.address,
    phone: currentPhone,
    email: currentEmail
  };

  // Detect changes
  const changedFields: Array<{
    field: string;
    oldValue: any;
    newValue: any;
    changeType: PatientChangeType;
  }> = [];

  for (const [field, newValue] of Object.entries(updates)) {
    if (newValue === undefined) continue;

    const oldValue = currentValues[field];

    // Skip if no actual change (critical check!)
    if (oldValue === newValue) continue;

    const changeType = IDENTITY_FIELDS.includes(field) 
      ? PatientChangeType.IDENTITY 
      : PatientChangeType.NON_IDENTITY;

    changedFields.push({
      field,
      oldValue: oldValue ? String(oldValue) : null,
      newValue: String(newValue),
      changeType
    });
  }

  // If no changes, return existing patient
  if (changedFields.length === 0) {
    return existingPatient;
  }

  // Validate changeReason requirement
  const identityChanges = changedFields.filter(c => c.changeType === PatientChangeType.IDENTITY);
  
  if (identityChanges.length > 0) {
    // Staff: reason is MANDATORY
    if (userRole === 'staff' && !changeReason) {
      throw new ValidationError(
        'Change reason is required for identity field changes (staff role)'
      );
    }
    // Admin/Owner: reason is optional but still logged if provided
  }

  // Generate request ID to group related changes
  const requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

  // Update patient atomically in transaction
  const updatedPatient = await prisma.$transaction(async (tx) => {
    // Log all changes to PatientChangeLog
    for (const change of changedFields) {
      await tx.patientChangeLog.create({
        data: {
          patientId,
          fieldName: change.field,
          oldValue: change.oldValue,
          newValue: change.newValue,
          changeType: change.changeType,
          changeReason: changeReason || null,
          changedBy: userId,
          changedRole: userRole,
          requestId
        }
      });
    }

    // Update Patient table fields
    const patientUpdates: any = {};
    if (updates.name !== undefined) patientUpdates.name = updates.name.toUpperCase();
    if (updates.age !== undefined) patientUpdates.age = updates.age;
    if (updates.gender !== undefined) patientUpdates.gender = updates.gender;
    if (updates.address !== undefined) patientUpdates.address = updates.address;

    // Update patient main fields
    const updated = await tx.patient.update({
      where: { id: patientId },
      data: patientUpdates,
      include: {
        identifiers: true
      }
    });

    // Update identifiers if changed
    if (updates.phone !== undefined && updates.phone !== currentPhone) {
      // Update or create primary phone
      const existingPhone = existingPatient.identifiers.find(
        id => id.type === 'PHONE' && id.isPrimary
      );

      if (existingPhone) {
        await tx.patientIdentifier.update({
          where: { id: existingPhone.id },
          data: { value: updates.phone }
        });
      } else {
        await tx.patientIdentifier.create({
          data: {
            patientId,
            type: 'PHONE',
            value: updates.phone,
            isPrimary: true
          }
        });
      }
    }

    if (updates.email !== undefined && updates.email !== currentEmail) {
      // Update or create primary email
      const existingEmail = existingPatient.identifiers.find(
        id => id.type === 'EMAIL' && id.isPrimary
      );

      if (existingEmail) {
        await tx.patientIdentifier.update({
          where: { id: existingEmail.id },
          data: { value: updates.email }
        });
      } else {
        await tx.patientIdentifier.create({
          data: {
            patientId,
            type: 'EMAIL',
            value: updates.email,
            isPrimary: true
          }
        });
      }
    }

    return updated;
  });

  // Audit log for high-level patient update action
  await logAction({
    branchId,
    actionType: 'UPDATE',
    entityType: 'Patient',
    entityId: patientId,
    userId,
    oldValues: { changedFields: changedFields.map(c => c.field) },
    newValues: { 
      requestId,
      changeCount: changedFields.length,
      identityChangeCount: identityChanges.length,
      reason: changeReason || 'N/A'
    }
  });

  return updatedPatient;
}

export async function getPatientChangeHistory(patientId: string) {
  const changeLogs = await prisma.patientChangeLog.findMany({
    where: { patientId },
    orderBy: { createdAt: 'desc' }
  });

  return changeLogs;
}
