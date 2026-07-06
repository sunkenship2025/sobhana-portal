import type { ClinicVisitView } from "@/types";

/**
 * Map the GET /api/visits/clinic(/:id) response shape into the ClinicVisitView
 * the print components (BillReceipt / ClinicPrescriptionPrint) consume. Shared
 * by ClinicNewVisit (in-memory print) and PrescriptionPrintPage (fetch-by-id).
 */
export function buildClinicVisitView(apiVisit: any): ClinicVisitView {
  return {
    visit: {
      id: apiVisit.id,
      branchId: apiVisit.branchId,
      visitRef: apiVisit.visitRef,
      billNumber: apiVisit.billNumber ?? null,
      patientId: apiVisit.patientId,
      domain: "CLINIC",
      visitType: apiVisit.visitType,
      doctorId: apiVisit.doctorId,
      hospitalWard: apiVisit.hospitalWard || undefined,
      totalAmountInPaise: Math.round((apiVisit.totalAmount || 0) * 100),
      consultationFeeInPaise: Math.round((apiVisit.consultationFee || 0) * 100),
      paymentType: apiVisit.paymentType ?? null,
      paymentStatus: apiVisit.paymentStatus ?? null,
      hasBill: apiVisit.hasBill,
      billedAt: apiVisit.billedAt ? new Date(apiVisit.billedAt) : null,
      status: apiVisit.status,
      isRevisit: apiVisit.isRevisit || false,
      originalVisitId: apiVisit.originalVisitId || undefined,
      originalVisitVisitRef: apiVisit.originalVisitVisitRef || null,
      originalVisitBillNumber: apiVisit.originalVisitBillNumber || null,
      originalVisitDate: apiVisit.originalVisitDate
        ? new Date(apiVisit.originalVisitDate)
        : null,
      createdAt: new Date(apiVisit.createdAt),
      updatedAt: new Date(apiVisit.updatedAt),
    },
    patient: apiVisit.patient,
    clinicDoctor: apiVisit.doctor || undefined,
  };
}
