import { PrismaClient, IdentifierType, PatientChangeType, Prisma, BillDiscountType, PaymentStatus, PaymentType, ReportStatus, VisitStatus, VisitDomain, DiagnosticWorkflowMode } from '@prisma/client';
import { generatePatientNumber } from './numberService';
import { logAction } from './auditService';
import { ValidationError, ConflictError, NotFoundError } from '../utils/errors';
import * as patientMatching from './patientMatchingService';
import { validatePatientDemographics, validateAddress, calculateYOBFromAge, calculateAgeFromDOB, getPatientAge, getPatientAgeDisplay } from '../utils/validation';
import { computeBillFinancialsFromPersisted } from './billFinancialService';
import {
  buildTimelineWhere,
  encodeCursor,
  toAppliedFilters,
  TimelineFilters,
} from './patient360Util';
import crypto from 'crypto';
import prisma from '../lib/prisma';


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
  title?: 'MR' | 'MRS' | 'MS' | 'BABY';
  age?: number; // E2-09: Optional - used to calculate YOB if DOB not provided
  ageUnit?: string; // DAYS, MONTHS, YEARS — defaults to YEARS
  dateOfBirth?: Date; // E2-09: Optional - exact DOB if known
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
  whatsappOptIn?: boolean; // WhatsApp notification consent
}

export async function createPatient(input: CreatePatientInput) {
  // E2-09: Calculate yearOfBirth from DOB or age FIRST (needed for validation)
  let yearOfBirth: number;
  let dateOfBirth: Date | null = null;
  const ageUnit = input.ageUnit || 'YEARS';
  
  if (input.dateOfBirth) {
    dateOfBirth = input.dateOfBirth;
    yearOfBirth = input.dateOfBirth.getFullYear();
  } else if (input.age !== undefined) {
    // For DAYS/MONTHS: compute an approximate DOB for precise reference range matching
    const now = new Date();
    if (ageUnit === 'DAYS') {
      dateOfBirth = new Date(now.getTime() - input.age * 24 * 60 * 60 * 1000);
      yearOfBirth = dateOfBirth.getFullYear();
    } else if (ageUnit === 'MONTHS') {
      dateOfBirth = new Date(now);
      dateOfBirth.setMonth(dateOfBirth.getMonth() - input.age);
      yearOfBirth = dateOfBirth.getFullYear();
    } else {
      yearOfBirth = calculateYOBFromAge(input.age);
    }
  } else {
    throw new ValidationError('Either age or dateOfBirth must be provided');
  }

  // E2-10: Validate demographic fields
  const validationResult = validatePatientDemographics({
    name: input.name,
    title: input.title,
    age: input.age,
    dateOfBirth: input.dateOfBirth,
    gender: input.gender,
    identifiers: input.identifiers,
  });

  if (!validationResult.valid) {
    const errorMessages = Object.entries(validationResult.errors)
      .map(([field, message]) => `${field}: ${message}`)
      .join('; ');
    throw new ValidationError(errorMessages);
  }

  // Validate address
  const addressError = validateAddress(input.address);
  if (addressError) {
    throw new ValidationError(addressError);
  }

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
  const patientNumber = await generatePatientNumber();
  
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
        
        // E2-09: Calculate current age from YOB/DOB for comparison
        const existingAge = getPatientAge(existingPatient.dateOfBirth, existingPatient.yearOfBirth);
        const inputAge = input.age || (input.dateOfBirth ? calculateAgeFromDOB(input.dateOfBirth) : 0);
        const ageClose = Math.abs(existingAge - inputAge) <= 1;
        
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
                title: existingPatient.title,
                age: existingAge, // E2-09: Use calculated age
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
    const newPatient = await tx.patient.create({
      data: {
        patientNumber,
        name: input.name.toUpperCase(), // Medical standard: names in all caps
        title: input.title,
        yearOfBirth, // E2-09: Required - derived from age or DOB
        dateOfBirth, // E2-09: Optional - exact DOB if provided
        ageUnit: input.dateOfBirth ? 'YEARS' : ageUnit, // Store unit hint for smart display
        gender: input.gender,
        address: input.address,
        whatsappOptIn: input.whatsappOptIn ?? false,
        ...(input.whatsappOptIn ? {
          whatsappOptInAt: new Date(),
          whatsappOptInSource: 'PATIENT_REGISTRATION_FORM',
        } : {}),
        identifiers: {
          create: input.identifiers
        }
      },
      include: {
        identifiers: true
      }
    });

    return newPatient;
  }, {
    timeout: 15000,
    maxWait: 15000,
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

  // Return the same shape as searchPatients / getPatient360View — including
  // computed `age` and `ageDisplay`. Without these, downstream UI (bill
  // receipt, queue cards) falls back to "N/A" for newly-created patients
  // because the raw Prisma row only has yearOfBirth/dateOfBirth.
  return {
    ...patient,
    age: getPatientAge(patient.dateOfBirth, patient.yearOfBirth),
    ageDisplay: getPatientAgeDisplay(
      patient.dateOfBirth,
      patient.yearOfBirth,
      patient.ageUnit,
    ),
  };
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
  patientNumber?: string;
  limit?: number;
}) {
  const limit = query.limit || 20;

  // patientNumber is an exact/unique key — do NOT route through fuzzy matching.
  // Direct findUnique, mapped into the SAME search-result shape. Empty array (not
  // 404) on no match so the frontend shows the "no match → register" state.
  if (query.patientNumber) {
    const patient = await prisma.patient.findUnique({
      where: { patientNumber: query.patientNumber },
      include: {
        identifiers: true,
        visits: {
          include: { branch: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!patient) return [];
    return [toSearchResult(patient)];
  }

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
  return patients.map((patient: any) => toSearchResult(patient));
}

// Shared search-result shaper (used by fuzzy + patientNumber paths).
function toSearchResult(patient: any) {
  return {
    patient: {
      id: patient.id,
      patientNumber: patient.patientNumber,
      name: patient.name,
      title: patient.title,
      age: getPatientAge(patient.dateOfBirth, patient.yearOfBirth), // E2-09: Calculate current age
      ageUnit: patient.ageUnit || 'YEARS',
      ageDisplay: getPatientAgeDisplay(patient.dateOfBirth, patient.yearOfBirth, patient.ageUnit),
      dateOfBirth: patient.dateOfBirth, // E2-09: Include DOB in response
      yearOfBirth: patient.yearOfBirth, // E2-09: Include YOB in response
      gender: patient.gender,
      address: patient.address,
      identifiers: patient.identifiers,
      whatsappOptIn: patient.whatsappOptIn,
      createdAt: patient.createdAt
    },
    historySnapshot: (patient.visits ?? []).slice(0, 3).map((visit: any) => ({
      visitId: visit.id,
      domain: visit.domain,
      branchName: visit.branch?.name || 'Unknown',
      visitType: visit.visitType,
      createdAt: visit.createdAt
    })),
    totalVisits: (patient.visits ?? []).length
  };
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
            select: {
              paymentStatus: true,
              billedAt: true,
              transactions: {
                select: { paymentType: true },
                orderBy: { transactionDate: 'desc' },
              },
            },
          },
          report: {
            include: {
              versions: {
                orderBy: { versionNum: 'desc' },
                take: 1,
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
  const originalVisitIds = patient.visits
    .map((visit: any) => visit.clinicVisit?.originalVisitId)
    .filter((visitId: string | null | undefined): visitId is string => Boolean(visitId));

  const originalVisitMap = originalVisitIds.length > 0
    ? new Map(
        (
          await prisma.visit.findMany({
            where: { id: { in: Array.from(new Set(originalVisitIds)) } },
            select: {
              id: true,
              createdAt: true,
              billNumber: true,
              bill: {
                select: {
                  billNumber: true,
                },
              },
            },
          })
        ).map((visit) => [
          visit.id,
          {
            visitRef: visit.billNumber,
            billNumber: visit.bill?.billNumber || null,
            createdAt: visit.createdAt,
          },
        ]),
      )
    : new Map<string, { visitRef: string; billNumber: string | null; createdAt: Date }>();
  
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
      visitRef: visit.billNumber,
      billNumber: visit.bill?.billNumber || null,
      hasBill: Boolean(visit.bill),
      branchId: visit.branchId,
      branchName: visit.branch?.name || 'Unknown',
      status: visit.status,
      totalAmountInPaise: visit.totalAmountInPaise,
      paymentType: visit.bill?.transactions?.[0]?.paymentType || null,
      paymentStatus: visit.bill?.paymentStatus || null,
      billedAt: visit.bill?.billedAt || null,
      createdAt: visit.createdAt
    };

    // Clinic-specific fields
    if (visit.domain === 'CLINIC' && visit.clinicVisit) {
      timelineItem.visitType = visit.clinicVisit.visitType;
      timelineItem.doctorName = visit.clinicVisit.clinicDoctor?.name;
      timelineItem.startedAt = visit.clinicVisit.startedAt;
      timelineItem.completedAt = visit.clinicVisit.completedAt;
      timelineItem.isRevisit = visit.clinicVisit.isRevisit;
      timelineItem.originalVisitId = visit.clinicVisit.originalVisitId;

      if (visit.clinicVisit.originalVisitId) {
        const originalVisit = originalVisitMap.get(visit.clinicVisit.originalVisitId);
        timelineItem.originalVisitVisitRef = originalVisit?.visitRef || null;
        timelineItem.originalVisitBillNumber = originalVisit?.billNumber || null;
        timelineItem.originalVisitDate = originalVisit?.createdAt || null;
      }
    }

    // Diagnostic-specific fields - report status
    if (visit.domain === 'DIAGNOSTICS' && visit.report?.versions?.length > 0) {
      const latestVersion = visit.report.versions[0];
      timelineItem.reportStatus = latestVersion.status;
      timelineItem.reportVersionId = latestVersion.id;
      timelineItem.finalizedAt = latestVersion.finalizedAt;
      timelineItem.reportFinalizedAt = latestVersion.finalizedAt;
    }

    return timelineItem;
  });

  return {
    patient: {
      id: patient.id,
      patientNumber: patient.patientNumber,
      name: patient.name,
      title: patient.title,
      age: getPatientAge(patient.dateOfBirth, patient.yearOfBirth), // E2-09: Calculate current age
      ageUnit: patient.ageUnit || 'YEARS',
      ageDisplay: getPatientAgeDisplay(patient.dateOfBirth, patient.yearOfBirth, patient.ageUnit),
      dateOfBirth: patient.dateOfBirth, // E2-09: Include DOB
      yearOfBirth: patient.yearOfBirth, // E2-09: Include YOB
      gender: patient.gender,
      address: patient.address,
      identifiers: patient.identifiers,
      whatsappOptIn: patient.whatsappOptIn,
      whatsappOptInAt: patient.whatsappOptInAt,
      createdAt: patient.createdAt
    },
    visitTimeline,
    totalVisits: patient.visits.length,
    branches: Array.from(branchMap.values())
  };
}

// ============================================================================
// Patient360 — Glance Summary + Cursor-Paginated Timeline (05-backend-plan.md)
// GLOBAL across branches: no query here filters by req.branchId (§11).
// ============================================================================

const ABNORMAL_FLAGS: ('HIGH' | 'LOW' | 'CRITICAL_HIGH' | 'CRITICAL_LOW')[] = [
  'HIGH',
  'LOW',
  'CRITICAL_HIGH',
  'CRITICAL_LOW',
];

export interface VisitDiscount {
  amount: number;
  type: 'FLAT_AMOUNT' | 'PERCENTAGE' | null;
  reason: string | null;
}

export interface MappedBillFinancials {
  hasBill: boolean;
  paymentStatus: PaymentStatus | null;
  paymentType: PaymentType | null;
  paidAmountInPaise: number;
  netAmountInPaise: number;
  dueAmountInPaise: number;
  discountAmountInPaise: number;
  discountType: BillDiscountType | null;
  discountPercentage: number | null;
  discountReason: string | null;
  discount: VisitDiscount;
  refundedAmountInPaise: number;
  reversedChargeInPaise: number;
  refundReason: string | null;
  refundedAt: Date | null;
  transactions: { amountInPaise: number; paymentType: PaymentType; transactionDate: Date; transactionType?: string }[];
}

type BillForMapping = {
  paymentStatus: PaymentStatus;
  totalAmountInPaise: number;
  discountType: BillDiscountType | null;
  discountPercentage: number | null;
  discountAmountInPaise: number;
  discountReason: string | null;
  paidAmountInPaise: number;
  refundedAmountInPaise?: number | null;
  reversedChargeInPaise?: number | null;
  refundReason?: string | null;
  refundedAt?: Date | null;
  transactions?: { amountInPaise: number; paymentType: PaymentType; transactionDate: Date; transactionType?: string }[];
} | null | undefined;

/**
 * Step 1 — Shared per-bill mapping helper with REFUNDED/CANCELLED guards.
 * Reuses the authoritative computeBillFinancialsFromPersisted; never re-derives due.
 * Forces dueAmountInPaise=0 for REFUNDED bills or CANCELLED visits (the compute
 * helper is refund-unaware and would otherwise fabricate a positive due).
 */
export function mapBillFinancials(
  bill: BillForMapping,
  visitStatus: VisitStatus | string,
): MappedBillFinancials {
  if (!bill) {
    return {
      hasBill: false,
      paymentStatus: null,
      paymentType: null,
      paidAmountInPaise: 0,
      netAmountInPaise: 0,
      dueAmountInPaise: 0,
      discountAmountInPaise: 0,
      discountType: null,
      discountPercentage: null,
      discountReason: null,
      discount: { amount: 0, type: null, reason: null },
      refundedAmountInPaise: 0,
      reversedChargeInPaise: 0,
      refundReason: null,
      refundedAt: null,
      transactions: [],
    };
  }

  const computed = computeBillFinancialsFromPersisted({
    totalAmountInPaise: bill.totalAmountInPaise,
    discountReason: bill.discountReason,
    discountType: bill.discountType,
    discountPercentage: bill.discountPercentage,
    discountAmountInPaise: bill.discountAmountInPaise,
    paidAmountInPaise: bill.paidAmountInPaise,
    refundedAmountInPaise: bill.refundedAmountInPaise,
    reversedChargeInPaise: bill.reversedChargeInPaise,
    transactions: bill.transactions,
  });

  const isRefunded = bill.paymentStatus === 'REFUNDED';
  const isCancelled = visitStatus === 'CANCELLED';
  const dueAmountInPaise = isRefunded || isCancelled ? 0 : computed.dueAmountInPaise;

  const transactions = bill.transactions ?? [];
  const paymentType = transactions[0]?.paymentType ?? null;

  return {
    hasBill: true,
    paymentStatus: bill.paymentStatus,
    paymentType,
    paidAmountInPaise: computed.paidAmountInPaise,
    netAmountInPaise: computed.netAmountInPaise,
    dueAmountInPaise,
    discountAmountInPaise: computed.discountAmountInPaise,
    discountType: computed.discountType,
    discountPercentage: computed.discountPercentage,
    discountReason: computed.discountReason,
    discount: {
      amount: computed.discountAmountInPaise,
      type: computed.discountType,
      reason: computed.discountReason,
    },
    refundedAmountInPaise: Math.max(0, bill.refundedAmountInPaise ?? 0),
    reversedChargeInPaise: Math.max(0, bill.reversedChargeInPaise ?? 0),
    refundReason: bill.refundReason ?? null,
    refundedAt: bill.refundedAt ?? null,
    transactions,
  };
}

export type ReportState =
  | { kind: 'FINALIZED'; version: number }
  | { kind: 'PARTIALLY_FINALIZED'; finalized: number; total: number }
  | { kind: 'BILL_ONLY' }
  | { kind: 'EXTERNAL_UPLOAD_PENDING' }
  | { kind: 'RESULTS_PENDING' }
  | null;

export type VisitWorkflowMode = 'REPORTABLE' | 'BILL_ONLY' | 'EXTERNAL_UPLOAD' | 'MIXED';

type VisitForReportState = {
  domain: VisitDomain | string;
  status: VisitStatus | string;
  testOrders?: { workflowMode: DiagnosticWorkflowMode }[];
  report?: { versions?: { status: ReportStatus; versionNum: number }[] } | null;
};

/**
 * Step 5 — reportState derivation. Mirrors deriveDiagnosticVisitComposition's
 * FINALIZED/version logic. CLINIC visits → null. Precedence per §5.
 */
export function deriveReportState(visit: VisitForReportState): ReportState {
  if (visit.domain === 'CLINIC') return null;

  const orders = visit.testOrders ?? [];
  const versions = visit.report?.versions ?? [];

  // 1. Zero-order diagnostic visit → RESULTS_PENDING (explicit, no fall-through).
  if (orders.length === 0) return { kind: 'RESULTS_PENDING' };

  // 2. All BILL_ONLY → BILL_ONLY.
  if (orders.every((o) => o.workflowMode === 'BILL_ONLY')) return { kind: 'BILL_ONLY' };

  const finalizedVersions = versions.filter((v) => v.status === 'FINALIZED');
  const hasFinalizedVersion = finalizedVersions.length > 0;

  // 3. COMPLETED && some FINALIZED → FINALIZED with MAX finalized versionNum
  //    (never length / trailing draft).
  if (visit.status === 'COMPLETED' && hasFinalizedVersion) {
    const version = finalizedVersions.reduce((max, v) => Math.max(max, v.versionNum), 0);
    return { kind: 'FINALIZED', version };
  }

  // 4. Some FINALIZED but not COMPLETED → PARTIALLY_FINALIZED.
  if (hasFinalizedVersion && visit.status !== 'COMPLETED') {
    const total = orders.filter((o) => o.workflowMode !== 'BILL_ONLY').length;
    return { kind: 'PARTIALLY_FINALIZED', finalized: finalizedVersions.length, total };
  }

  // 5. EXTERNAL_UPLOAD present and none finalized → EXTERNAL_UPLOAD_PENDING.
  if (orders.some((o) => o.workflowMode === 'EXTERNAL_UPLOAD')) {
    return { kind: 'EXTERNAL_UPLOAD_PENDING' };
  }

  // 6. Reportable orders exist, none finalized → RESULTS_PENDING.
  return { kind: 'RESULTS_PENDING' };
}

/**
 * workflowMode rollup: single mode if testOrders homogeneous, else 'MIXED'.
 * CLINIC visits → null.
 */
export function deriveWorkflowMode(visit: VisitForReportState): VisitWorkflowMode | null {
  if (visit.domain === 'CLINIC') return null;
  const orders = visit.testOrders ?? [];
  if (orders.length === 0) return null;
  const modes = new Set(orders.map((o) => o.workflowMode));
  if (modes.size > 1) return 'MIXED';
  return [...modes][0] as VisitWorkflowMode;
}

/**
 * Step 2 — getPatient360Summary: aggregate-only glance. One $transaction batch.
 * No visit array load. Stays correct across timeline paging (independent of pages).
 */
export async function getPatient360Summary(patientId: string) {
  const [
    patient,
    openBills,
    totalVisits,
    totalVisitsIncludingCancelled,
    lastVisit,
    finalized,
    billOnly,
    diagnosticTotal,
    branchRows,
  ] = await prisma.$transaction([
    prisma.patient.findUnique({
      where: { id: patientId },
      include: { identifiers: true },
    }),
    prisma.bill.findMany({
      where: {
        visit: { patientId, status: { not: 'CANCELLED' } },
        paymentStatus: { notIn: ['PAID', 'REFUNDED'] },
      },
      select: {
        totalAmountInPaise: true,
        discountAmountInPaise: true,
        paidAmountInPaise: true,
      },
    }),
    prisma.visit.count({ where: { patientId, status: { not: 'CANCELLED' } } }),
    prisma.visit.count({ where: { patientId } }),
    prisma.visit.findFirst({
      where: { patientId, status: { not: 'CANCELLED' } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        domain: true,
        createdAt: true,
        branch: { select: { name: true } },
      },
    }),
    prisma.visit.count({
      where: {
        patientId,
        domain: 'DIAGNOSTICS',
        status: 'COMPLETED',
        report: { is: { versions: { some: { status: 'FINALIZED' } } } },
      },
    }),
    prisma.visit.count({
      where: {
        patientId,
        domain: 'DIAGNOSTICS',
        status: { not: 'CANCELLED' },
        testOrders: { every: { workflowMode: 'BILL_ONLY' }, some: {} },
      },
    }),
    prisma.visit.count({
      where: { patientId, domain: 'DIAGNOSTICS', status: { not: 'CANCELLED' } },
    }),
    prisma.visit.findMany({
      where: { patientId },
      distinct: ['branchId'],
      select: { branch: { select: { id: true, name: true } } },
    }),
  ]);

  if (!patient) {
    return null;
  }

  const outstandingDueInPaise = openBills.reduce(
    (sum, b) => sum + computeBillFinancialsFromPersisted(b).dueAmountInPaise,
    0,
  );

  const notFinalized = Math.max(0, diagnosticTotal - finalized - billOnly);

  return {
    patient: {
      id: patient.id,
      patientNumber: patient.patientNumber,
      name: patient.name,
      title: patient.title,
      age: getPatientAge(patient.dateOfBirth, patient.yearOfBirth),
      ageUnit: patient.ageUnit || 'YEARS',
      ageDisplay: getPatientAgeDisplay(patient.dateOfBirth, patient.yearOfBirth, patient.ageUnit),
      dateOfBirth: patient.dateOfBirth,
      yearOfBirth: patient.yearOfBirth,
      gender: patient.gender,
      address: patient.address,
      identifiers: patient.identifiers,
      whatsappOptIn: patient.whatsappOptIn,
      whatsappOptInAt: patient.whatsappOptInAt,
      createdAt: patient.createdAt,
    },
    glance: {
      outstandingDueInPaise,
      totalVisits,
      totalVisitsIncludingCancelled,
      lastVisit: lastVisit
        ? {
            visitId: lastVisit.id,
            domain: lastVisit.domain,
            branchName: lastVisit.branch?.name || 'Unknown',
            createdAt: lastVisit.createdAt,
          }
        : null,
      reportCounts: { finalized, notFinalized, billOnly },
    },
    branches: branchRows
      .map((row) => row.branch)
      .filter((b): b is { id: string; name: string } => Boolean(b)),
  };
}

// TIMELINE_INCLUDE: rich per-visit selection for the inspector list.
const TIMELINE_INCLUDE = {
  branch: { select: { id: true, name: true, code: true } },
  bill: {
    select: {
      billNumber: true,
      paymentStatus: true,
      billedAt: true,
      totalAmountInPaise: true,
      discountType: true,
      discountPercentage: true,
      discountAmountInPaise: true,
      discountReason: true,
      paidAmountInPaise: true,
      refundedAmountInPaise: true,
      reversedChargeInPaise: true,
      refundReason: true,
      refundedAt: true,
      transactions: {
        select: { amountInPaise: true, paymentType: true, transactionDate: true, transactionType: true },
        orderBy: { transactionDate: 'desc' as const },
      },
    },
  },
  report: {
    select: {
      versions: {
        select: { id: true, status: true, versionNum: true, finalizedAt: true },
        orderBy: { versionNum: 'desc' as const },
      },
    },
  },
  testOrders: {
    select: {
      id: true,
      workflowMode: true,
      testNameSnapshot: true,
      priceInPaise: true,
      cancelledAt: true,
      cancelReason: true,
      reversedChargeInPaise: true,
      productId: true,
      product: { select: { name: true } },
      externalLabId: true,
      // "No written report needed" (films only) — surfaced so the inspector can
      // show a trace (who/when/why) instead of the Report section going blank.
      noReportAt: true,
      noReportReason: true,
      noReportByUser: { select: { name: true } },
      reopenedAt: true,
      reopenedByUser: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
  referrals: {
    where: { deletedAt: null },
    select: {
      referralDoctor: { select: { id: true, name: true } },
    },
    take: 1,
  },
  clinicVisit: {
    include: { clinicDoctor: { select: { name: true } } },
  },
} satisfies Prisma.VisitInclude;

/**
 * Step 4 — getPatient360Timeline: cursor-paginated page + 3 batched lookups
 * (4 with revisits). No per-visit loops / N+1.
 */
export async function getPatient360Timeline(patientId: string, filters: TimelineFilters) {
  const pageSize = filters.pageSize;

  // Query 1 — the visit page (take pageSize+1 sentinel for hasMore).
  const rows = await prisma.visit.findMany({
    where: buildTimelineWhere(patientId, filters),
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: pageSize + 1,
    include: TIMELINE_INCLUDE,
  });

  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.createdAt, last.id) : null;

  const dxIds = page.filter((v) => v.domain === 'DIAGNOSTICS').map((v) => v.id);
  const pageIds = page.map((v) => v.id);

  // Query 2 — abnormal-results existence (batched, FINALIZED only). Boolean per
  // visit — NO values/flags/test-names (privacy).
  const abnormalVisitIds = new Set<string>();
  if (dxIds.length > 0) {
    const abnormalRows = await prisma.testResult.findMany({
      where: {
        flag: { in: ABNORMAL_FLAGS },
        reportVersion: { status: 'FINALIZED', report: { visitId: { in: dxIds } } },
      },
      select: { reportVersion: { select: { report: { select: { visitId: true } } } } },
      distinct: ['reportVersionId'],
    });
    for (const r of abnormalRows) {
      const vid = r.reportVersion?.report?.visitId;
      if (vid) abnormalVisitIds.add(vid);
    }
  }

  // Query 3 — latest REPORT MessageLog per visit (batched). Sorted desc, keep first.
  const deliveryByVisit = new Map<
    string,
    { status: string; sentAt: Date | null; deliveredAt: Date | null; readAt: Date | null }
  >();
  if (pageIds.length > 0) {
    const logs = await prisma.messageLog.findMany({
      where: { contextType: 'REPORT', contextId: { in: pageIds } },
      orderBy: { createdAt: 'desc' },
      select: {
        contextId: true,
        status: true,
        sentAt: true,
        deliveredAt: true,
        readAt: true,
      },
    });
    for (const log of logs) {
      if (!deliveryByVisit.has(log.contextId)) {
        deliveryByVisit.set(log.contextId, {
          status: log.status,
          sentAt: log.sentAt,
          deliveredAt: log.deliveredAt,
          readAt: log.readAt,
        });
      }
    }
  }

  // Query 4 (conditional) — original-visit map for clinic revisits.
  const originalVisitIds = page
    .map((v) => v.clinicVisit?.originalVisitId)
    .filter((id): id is string => Boolean(id));

  const originalVisitMap =
    originalVisitIds.length > 0
      ? new Map(
          (
            await prisma.visit.findMany({
              where: { id: { in: Array.from(new Set(originalVisitIds)) } },
              select: {
                id: true,
                createdAt: true,
                billNumber: true,
                bill: { select: { billNumber: true } },
              },
            })
          ).map((v) => [
            v.id,
            {
              visitRef: v.billNumber,
              billNumber: v.bill?.billNumber || null,
              createdAt: v.createdAt,
            },
          ]),
        )
      : new Map<string, { visitRef: string; billNumber: string | null; createdAt: Date }>();

  const items = page.map((visit) => {
    const financials = mapBillFinancials(visit.bill, visit.status);
    const delivery = deliveryByVisit.get(visit.id) ?? null;

    const item: any = {
      visitId: visit.id,
      domain: visit.domain,
      visitRef: visit.billNumber,
      billNumber: visit.bill?.billNumber || null,
      hasBill: financials.hasBill,
      branchId: visit.branchId,
      branchName: visit.branch?.name || 'Unknown',
      status: visit.status,
      totalAmountInPaise: visit.totalAmountInPaise,
      paymentType: financials.paymentType,
      paymentStatus: financials.paymentStatus,
      billedAt: visit.bill?.billedAt || null,
      createdAt: visit.createdAt,
      // Financials (flat compat + nested discount)
      paidAmountInPaise: financials.paidAmountInPaise,
      netAmountInPaise: financials.netAmountInPaise,
      dueAmountInPaise: financials.dueAmountInPaise,
      discountAmountInPaise: financials.discountAmountInPaise,
      discountType: financials.discountType,
      discountPercentage: financials.discountPercentage,
      discountReason: financials.discountReason,
      discount: financials.discount,
      refundedAmountInPaise: financials.refundedAmountInPaise,
      reversedChargeInPaise: financials.reversedChargeInPaise,
      refundReason: financials.refundReason,
      refundedAt: financials.refundedAt,
      transactions: financials.transactions,
      // Referring doctor (null ⇒ SELF) so the inspector can offer correction.
      referralDoctor: visit.referrals?.[0]?.referralDoctor ?? null,
      // Test line items so the inspector can offer per-test cancel/refund/swap.
      testOrders:
        visit.domain === 'DIAGNOSTICS'
          ? visit.testOrders.map((order) => ({
              id: order.id,
              testName: order.testNameSnapshot,
              priceInPaise: order.priceInPaise,
              workflowMode: order.workflowMode,
              cancelledAt: order.cancelledAt,
              cancelReason: order.cancelReason,
              reversedChargeInPaise: order.reversedChargeInPaise,
              productId: order.productId,
              productName: order.product?.name ?? null,
              isOutsourced: Boolean(order.externalLabId),
              noReportAt: order.noReportAt,
              noReportReason: order.noReportReason,
              noReportBy: order.noReportByUser?.name ?? null,
              reopenedAt: order.reopenedAt,
              reopenedBy: order.reopenedByUser?.name ?? null,
            }))
          : undefined,
      // Report state + workflow + abnormal flag + delivery
      reportState: deriveReportState(visit),
      workflowMode: deriveWorkflowMode(visit),
      hasAbnormalResults: abnormalVisitIds.has(visit.id),
      delivery,
    };

    if (visit.domain === 'CLINIC' && visit.clinicVisit) {
      item.visitType = visit.clinicVisit.visitType;
      item.doctorName = visit.clinicVisit.clinicDoctor?.name;
      item.startedAt = visit.clinicVisit.startedAt;
      item.completedAt = visit.clinicVisit.completedAt;
      item.isRevisit = visit.clinicVisit.isRevisit;
      item.originalVisitId = visit.clinicVisit.originalVisitId;

      if (visit.clinicVisit.originalVisitId) {
        const original = originalVisitMap.get(visit.clinicVisit.originalVisitId);
        item.originalVisitVisitRef = original?.visitRef || null;
        item.originalVisitBillNumber = original?.billNumber || null;
        item.originalVisitDate = original?.createdAt || null;
      }
    }

    return item;
  });

  return {
    items,
    pageInfo: { nextCursor, hasMore, pageSize },
    appliedFilters: toAppliedFilters(filters),
  };
}

/**
 * §10b — resolveBillToVisit: bill number → its visit + patient.
 * billNumber lives on both Visit.billNumber and Bill.billNumber. Throws 404 if none.
 */
export async function resolveBillToVisit(billNumber: string) {
  const visit = await prisma.visit.findFirst({
    where: { OR: [{ billNumber }, { bill: { is: { billNumber } } }] },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      patient: { include: { identifiers: true } },
      branch: { select: { id: true, name: true } },
      bill: { select: { billNumber: true, paymentStatus: true, totalAmountInPaise: true, billedAt: true } },
    },
  });

  if (!visit || !visit.patient) {
    throw new NotFoundError(`No visit found for bill number ${billNumber}`);
  }

  const patient = visit.patient;

  return {
    patient: {
      id: patient.id,
      patientNumber: patient.patientNumber,
      name: patient.name,
      title: patient.title,
      ageDisplay: getPatientAgeDisplay(patient.dateOfBirth, patient.yearOfBirth, patient.ageUnit),
      gender: patient.gender,
      identifiers: patient.identifiers,
    },
    visit: {
      visitId: visit.id,
      domain: visit.domain,
      branchName: visit.branch?.name || 'Unknown',
      createdAt: visit.createdAt,
      billNumber: visit.bill?.billNumber || visit.billNumber,
      totalAmountInPaise: visit.bill?.totalAmountInPaise ?? visit.totalAmountInPaise,
      paymentStatus: visit.bill?.paymentStatus || null,
    },
  };
}

// ============================================================================
// SHP-14 (E2-13a): Patient Editing with Mandatory Reason for Identity Fields
// ============================================================================

// Identity fields that require change reason for staff
const IDENTITY_FIELDS = ['name', 'title', 'age', 'gender', 'phone', 'email'];

export interface UpdatePatientInput {
  patientId: string;
  updates: {
    name?: string;
  title?: 'MR' | 'MRS' | 'MS' | 'MASTER' | 'BABY';
    age?: number; // E2-09: Optional - will be converted to YOB
    ageUnit?: string; // DAYS, MONTHS, YEARS
    dateOfBirth?: Date; // E2-09: Optional - exact DOB if provided
    gender?: 'M' | 'F' | 'O';
    address?: string;
    phone?: string; // Primary phone
    email?: string; // Primary email
    whatsappOptIn?: boolean; // WhatsApp notification consent
  };
  changeReason?: string;
  userId: string;
  userRole: string; // staff, admin, owner
  branchId: string; // For audit log
}

export async function updatePatient(input: UpdatePatientInput) {
  const { patientId, updates, changeReason, userId, userRole, branchId } = input;

  // Fetch existing patient first so we can validate partial updates properly
  const existingPatient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      identifiers: true
    }
  });

  if (!existingPatient) {
    throw new ValidationError('Patient not found');
  }

  // E2-10: Validate demographic fields if they are being updated
  if (updates.name !== undefined || updates.age !== undefined || updates.gender !== undefined) {
    const currentAge = getPatientAge(existingPatient.dateOfBirth, existingPatient.yearOfBirth);
    const validationInput = {
      name: updates.name ?? existingPatient.name,
      age: updates.age ?? currentAge,
      gender: updates.gender ?? existingPatient.gender,
    };
    
    const validationResult = validatePatientDemographics(validationInput);
    if (!validationResult.valid) {
      const errorMessages = Object.entries(validationResult.errors)
        .map(([field, message]) => `${field}: ${message}`)
        .join('; ');
      throw new ValidationError(errorMessages);
    }
  }

  // Validate address if being updated
  if (updates.address !== undefined) {
    const addressError = validateAddress(updates.address);
    if (addressError) {
      throw new ValidationError(addressError);
    }
  }

  // Validate phone if being updated
  if (updates.phone !== undefined) {
    const validationResult = validatePatientDemographics({
      name: 'temp', // Not validating name
      age: 0, // Not validating age
      gender: 'M', // Not validating gender
      identifiers: [{ type: 'PHONE', value: updates.phone }],
    });
    if (!validationResult.valid && validationResult.errors.phone) {
      throw new ValidationError(validationResult.errors.phone);
    }
  }

  // Validate email if being updated
  if (updates.email !== undefined && updates.email) {
    const validationResult = validatePatientDemographics({
      name: 'temp',
      age: 0,
      gender: 'M',
      identifiers: [{ type: 'EMAIL', value: updates.email }],
    });
    if (!validationResult.valid && validationResult.errors.email) {
      throw new ValidationError(validationResult.errors.email);
    }
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
    age: getPatientAge(existingPatient.dateOfBirth, existingPatient.yearOfBirth), // E2-09: Calculate current age
    yearOfBirth: existingPatient.yearOfBirth, // E2-09: Track YOB
    dateOfBirth: existingPatient.dateOfBirth, // E2-09: Track DOB
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
    
    // E2-09: Handle age update - convert to YOB, with unit-aware DOB computation
    if (updates.age !== undefined) {
      // Preserve the patient's existing unit when age is edited without an
      // explicit unit — otherwise editing a MONTHS infant's age (e.g. 1 → 16,
      // unit unchanged so not resent) would be misread as 16 YEARS.
      const unit = updates.ageUnit || existingPatient.ageUnit || 'YEARS';
      if (unit === 'DAYS') {
        const approxDob = new Date(Date.now() - updates.age * 24 * 60 * 60 * 1000);
        patientUpdates.dateOfBirth = approxDob;
        patientUpdates.yearOfBirth = approxDob.getFullYear();
        patientUpdates.ageUnit = 'DAYS';
      } else if (unit === 'MONTHS') {
        const approxDob = new Date();
        approxDob.setMonth(approxDob.getMonth() - updates.age);
        patientUpdates.dateOfBirth = approxDob;
        patientUpdates.yearOfBirth = approxDob.getFullYear();
        patientUpdates.ageUnit = 'MONTHS';
      } else {
        patientUpdates.yearOfBirth = calculateYOBFromAge(updates.age);
        // If age is updated in years, clear DOB since we only have approximate age now
        patientUpdates.dateOfBirth = null;
        patientUpdates.ageUnit = 'YEARS';
      }
    }
    
    if (updates.title !== undefined) patientUpdates.title = updates.title;
    if (updates.gender !== undefined) patientUpdates.gender = updates.gender;
    if (updates.address !== undefined) patientUpdates.address = updates.address;
    if (updates.whatsappOptIn !== undefined) {
      patientUpdates.whatsappOptIn = updates.whatsappOptIn;
      patientUpdates.whatsappOptInAt = updates.whatsappOptIn ? new Date() : null;
      patientUpdates.whatsappOptInSource = updates.whatsappOptIn ? 'STAFF_UPDATE' : null;
    }

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
