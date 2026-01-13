import { PrismaClient } from '@prisma/client';
import { NotFoundError } from '../utils/errors';

const prisma = new PrismaClient();

/**
 * Patient 360 Service
 * 
 * This service provides the canonical patient view - a read-only aggregation
 * of all patient data across all branches and domains.
 * 
 * INVARIANTS:
 * 1. Patient is global - exists once in the system
 * 2. Visit is the operational anchor - all data flows through visits
 * 3. This view is READ-ONLY - no mutations allowed
 */

export interface Patient360Response {
  patient: {
    id: string;
    patientNumber: string;
    name: string;
    age: number;
    gender: string;
    address?: string;
    primaryPhone?: string;
    identifiers: {
      type: string;
      value: string;
      isPrimary: boolean;
    }[];
    createdAt: string;
  };
  visits: VisitTimelineItem[];
  financialSummary: {
    totalDiagnosticsBilledInPaise: number;
    totalClinicBilledInPaise: number;
    totalPaidInPaise: number;
    totalPendingInPaise: number;
    visitCount: {
      diagnostics: number;
      clinic: number;
      total: number;
    };
  };
  lastVisitDate?: string;
  branchesVisited: {
    id: string;
    name: string;
    code: string;
  }[];
}

export interface VisitTimelineItem {
  visitId: string;
  domain: string;
  branchId: string;
  branchName: string;
  branchCode: string;
  billNumber: string;
  visitDate: string;
  status: string;
  totalAmountInPaise: number;
  paymentStatus: string;
  paymentType: string;
  visitType?: string;
  hasReport: boolean;
  reportFinalized: boolean;
  reportFinalizedAt?: string;
  referralDoctorId?: string;
  referralDoctorName?: string;
  clinicDoctorId?: string;
  clinicDoctorName?: string;
}

/**
 * Get complete Patient 360 view
 * Single endpoint that returns all patient data for the canonical view
 */
export async function getPatient360(patientId: string): Promise<Patient360Response> {
  // 1. Get patient with identifiers
  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      identifiers: true,
    },
  });

  if (!patient) {
    throw new NotFoundError('Patient not found');
  }

  // 2. Get all visits with related data
  const visits = await prisma.visit.findMany({
    where: { patientId },
    include: {
      branch: {
        select: { id: true, name: true, code: true },
      },
      bill: {
        select: { paymentStatus: true, paymentType: true },
      },
      referrals: {
        include: {
          referralDoctor: {
            select: { id: true, name: true },
          },
        },
      },
      report: {
        include: {
          versions: {
            orderBy: { versionNum: 'desc' },
            take: 1, // Get latest version only
          },
        },
      },
      clinicVisit: {
        include: {
          clinicDoctor: {
            select: { id: true, name: true },
          },
        },
      },
    },
    orderBy: { createdAt: 'desc' }, // Newest first
  });

  // 3. Transform visits to timeline items
  const visitTimeline: VisitTimelineItem[] = visits.map((visit) => {
    const latestReportVersion = visit.report?.versions[0];
    const referral = visit.referrals[0]; // Get first referral if exists
    
    return {
      visitId: visit.id,
      domain: visit.domain,
      branchId: visit.branch.id,
      branchName: visit.branch.name,
      branchCode: visit.branch.code,
      billNumber: visit.billNumber,
      visitDate: visit.createdAt.toISOString(),
      status: visit.clinicVisit?.status || visit.status,
      totalAmountInPaise: visit.totalAmountInPaise,
      paymentStatus: visit.bill?.paymentStatus || 'PENDING',
      paymentType: visit.bill?.paymentType || 'CASH',
      visitType: visit.clinicVisit?.visitType,
      hasReport: !!visit.report,
      reportFinalized: latestReportVersion?.status === 'FINALIZED',
      reportFinalizedAt: latestReportVersion?.finalizedAt?.toISOString(),
      referralDoctorId: referral?.referralDoctor.id,
      referralDoctorName: referral?.referralDoctor.name,
      clinicDoctorId: visit.clinicVisit?.clinicDoctor.id,
      clinicDoctorName: visit.clinicVisit?.clinicDoctor.name,
    };
  });

  // 4. Calculate financial summary
  const diagnosticsVisits = visits.filter((v) => v.domain === 'DIAGNOSTICS');
  const clinicVisits = visits.filter((v) => v.domain === 'CLINIC');

  const totalDiagnosticsBilledInPaise = diagnosticsVisits.reduce(
    (sum, v) => sum + v.totalAmountInPaise,
    0
  );
  const totalClinicBilledInPaise = clinicVisits.reduce(
    (sum, v) => sum + v.totalAmountInPaise,
    0
  );

  const paidVisits = visits.filter((v) => v.bill?.paymentStatus === 'PAID');
  const pendingVisits = visits.filter((v) => v.bill?.paymentStatus !== 'PAID');

  const totalPaidInPaise = paidVisits.reduce((sum, v) => sum + v.totalAmountInPaise, 0);
  const totalPendingInPaise = pendingVisits.reduce((sum, v) => sum + v.totalAmountInPaise, 0);

  // 5. Get unique branches visited
  const branchMap = new Map<string, { id: string; name: string; code: string }>();
  visits.forEach((v) => {
    if (!branchMap.has(v.branch.id)) {
      branchMap.set(v.branch.id, {
        id: v.branch.id,
        name: v.branch.name,
        code: v.branch.code,
      });
    }
  });

  // 6. Find primary phone
  const primaryPhone = patient.identifiers.find(
    (i) => i.type === 'PHONE' && i.isPrimary
  )?.value || patient.identifiers.find((i) => i.type === 'PHONE')?.value;

  return {
    patient: {
      id: patient.id,
      patientNumber: patient.patientNumber,
      name: patient.name,
      age: patient.age,
      gender: patient.gender,
      address: patient.address || undefined,
      primaryPhone,
      identifiers: patient.identifiers.map((i) => ({
        type: i.type,
        value: i.value,
        isPrimary: i.isPrimary,
      })),
      createdAt: patient.createdAt.toISOString(),
    },
    visits: visitTimeline,
    financialSummary: {
      totalDiagnosticsBilledInPaise,
      totalClinicBilledInPaise,
      totalPaidInPaise,
      totalPendingInPaise,
      visitCount: {
        diagnostics: diagnosticsVisits.length,
        clinic: clinicVisits.length,
        total: visits.length,
      },
    },
    lastVisitDate: visits[0]?.createdAt.toISOString(),
    branchesVisited: Array.from(branchMap.values()),
  };
}

/**
 * Get diagnostic visit detail for Patient 360 drawer
 */
export async function getDiagnosticVisitDetail(visitId: string) {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      branch: {
        select: { name: true },
      },
      bill: true,
      referrals: {
        include: {
          referralDoctor: {
            select: { id: true, name: true, phone: true },
          },
        },
      },
      testOrders: {
        include: {
          test: true,
          testResults: {
            orderBy: { createdAt: 'desc' },
            take: 1, // Latest result per test
          },
        },
      },
      report: {
        include: {
          versions: {
            orderBy: { versionNum: 'desc' },
            take: 1,
            include: {
              testResults: true,
            },
          },
        },
      },
    },
  });

  if (!visit || visit.domain !== 'DIAGNOSTICS') {
    throw new NotFoundError('Diagnostic visit not found');
  }

  const latestVersion = visit.report?.versions[0];
  const referral = visit.referrals[0];

  return {
    visitId: visit.id,
    branchName: visit.branch.name,
    billNumber: visit.billNumber,
    visitDate: visit.createdAt.toISOString(),
    status: visit.status,
    totalAmountInPaise: visit.totalAmountInPaise,
    paymentStatus: visit.bill?.paymentStatus || 'PENDING',
    paymentType: visit.bill?.paymentType || 'CASH',
    referralDoctor: referral
      ? {
          id: referral.referralDoctor.id,
          name: referral.referralDoctor.name,
          phone: referral.referralDoctor.phone || undefined,
        }
      : undefined,
    testOrders: visit.testOrders.map((to) => ({
      id: to.id,
      testName: to.test.name,
      testCode: to.test.code,
      priceInPaise: to.priceInPaise,
      referenceRange: {
        min: to.test.referenceMin || 0,
        max: to.test.referenceMax || 0,
        unit: to.test.referenceUnit || '',
      },
    })),
    results: latestVersion?.testResults.map((tr) => {
      const testOrder = visit.testOrders.find((to) => to.id === tr.testOrderId);
      return {
        testOrderId: tr.testOrderId,
        testName: testOrder?.test.name || '',
        testCode: testOrder?.test.code || '',
        value: tr.value,
        flag: tr.flag,
        referenceRange: {
          min: testOrder?.test.referenceMin || 0,
          max: testOrder?.test.referenceMax || 0,
          unit: testOrder?.test.referenceUnit || '',
        },
      };
    }),
    report: latestVersion
      ? {
          id: visit.report!.id,
          currentVersionId: latestVersion.id,
          versionNumber: latestVersion.versionNum,
          status: latestVersion.status,
          finalizedAt: latestVersion.finalizedAt?.toISOString() || null,
        }
      : undefined,
  };
}

/**
 * Get clinic visit detail for Patient 360 drawer
 */
export async function getClinicVisitDetail(visitId: string) {
  const visit = await prisma.visit.findUnique({
    where: { id: visitId },
    include: {
      branch: {
        select: { name: true },
      },
      bill: true,
      referrals: {
        include: {
          referralDoctor: {
            select: { id: true, name: true, phone: true },
          },
        },
      },
      clinicVisit: {
        include: {
          clinicDoctor: true,
        },
      },
    },
  });

  if (!visit || visit.domain !== 'CLINIC' || !visit.clinicVisit) {
    throw new NotFoundError('Clinic visit not found');
  }

  const referral = visit.referrals[0];

  return {
    visitId: visit.id,
    branchName: visit.branch.name,
    billNumber: visit.billNumber,
    visitDate: visit.createdAt.toISOString(),
    visitType: visit.clinicVisit.visitType,
    status: visit.clinicVisit.status,
    consultationFeeInPaise: visit.clinicVisit.consultationFeeInPaise,
    paymentStatus: visit.bill?.paymentStatus || 'PENDING',
    paymentType: visit.bill?.paymentType || 'CASH',
    hospitalWard: visit.clinicVisit.hospitalWard || undefined,
    clinicDoctor: {
      id: visit.clinicVisit.clinicDoctor.id,
      name: visit.clinicVisit.clinicDoctor.name,
      qualification: visit.clinicVisit.clinicDoctor.qualification,
      specialty: visit.clinicVisit.clinicDoctor.specialty,
      registrationNumber: visit.clinicVisit.clinicDoctor.registrationNumber,
      phone: visit.clinicVisit.clinicDoctor.phone || undefined,
    },
    referralDoctor: referral
      ? {
          id: referral.referralDoctor.id,
          name: referral.referralDoctor.name,
          phone: referral.referralDoctor.phone || undefined,
        }
      : undefined,
  };
}

/**
 * Search patients globally (for Patient 360 navigation)
 * Returns minimal patient info for search results
 */
export async function searchPatientsGlobal(query: {
  phone?: string;
  patientNumber?: string;
  name?: string;
  limit?: number;
}) {
  const limit = query.limit || 20;
  const results: any[] = [];

  // Search by patient number (exact match)
  if (query.patientNumber) {
    const patient = await prisma.patient.findFirst({
      where: {
        patientNumber: {
          contains: query.patientNumber,
          mode: 'insensitive',
        },
      },
      include: {
        identifiers: {
          where: { type: 'PHONE' },
          take: 1,
        },
        visits: {
          select: { id: true },
          take: 1,
        },
      },
    });

    if (patient) {
      results.push({
        id: patient.id,
        patientNumber: patient.patientNumber,
        name: patient.name,
        age: patient.age,
        gender: patient.gender,
        phone: patient.identifiers[0]?.value,
        hasVisits: patient.visits.length > 0,
      });
    }
    return results;
  }

  // Search by phone
  if (query.phone) {
    const identifiers = await prisma.patientIdentifier.findMany({
      where: {
        type: 'PHONE',
        value: {
          contains: query.phone,
          mode: 'insensitive',
        },
      },
      include: {
        patient: {
          include: {
            visits: {
              select: { id: true },
              take: 1,
            },
          },
        },
      },
      take: limit,
    });

    return identifiers.map((id) => ({
      id: id.patient.id,
      patientNumber: id.patient.patientNumber,
      name: id.patient.name,
      age: id.patient.age,
      gender: id.patient.gender,
      phone: id.value,
      hasVisits: id.patient.visits.length > 0,
    }));
  }

  // Search by name
  if (query.name) {
    const patients = await prisma.patient.findMany({
      where: {
        name: {
          contains: query.name,
          mode: 'insensitive',
        },
      },
      include: {
        identifiers: {
          where: { type: 'PHONE' },
          take: 1,
        },
        visits: {
          select: { id: true },
          take: 1,
        },
      },
      take: limit,
    });

    return patients.map((p) => ({
      id: p.id,
      patientNumber: p.patientNumber,
      name: p.name,
      age: p.age,
      gender: p.gender,
      phone: p.identifiers[0]?.value,
      hasVisits: p.visits.length > 0,
    }));
  }

  return results;
}
