import type {
  BillReceiptData,
  ClinicVisitView,
  DiagnosticVisitView,
} from "@/types";

export interface ApiBillData {
  visit: {
    id: string;
    visitRef?: string;
    billNumber?: string | null;
    hasBill?: boolean;
    domain: "CLINIC" | "DIAGNOSTICS";
    status: string;
    createdAt: string;
    totalAmount: number;
    discountType?: "FLAT_AMOUNT" | "PERCENTAGE" | null;
    discountPercentage?: number | null;
    discountAmountInPaise?: number;
    paidAmountInPaise?: number;
    netAmountInPaise?: number;
    dueAmountInPaise?: number;
    visitType?: string;
    isRevisit?: boolean;
    originalVisitBillNumber?: string | null;
    originalVisitDate?: string | null;
  };
  patient: {
    name: string;
    title?: string | null;
    age: number;
    ageUnit?: "DAYS" | "MONTHS" | "YEARS";
    ageDisplay?: string;
    gender: string;
    phone: string;
  };
  branch: {
    name: string;
    code: string;
  };
  payment: {
    type?: string | null;
    status?: string | null;
    transactions?: { paymentType: string; amountInPaise: number }[];
  };
  doctor?: {
    name: string;
    qualification?: string;
  };
  referralDoctor?: {
    name: string;
  };
  items: Array<{
    id: string;
    name: string;
    code: string;
    price: number;
    referralCommissionType?: "PERCENTAGE" | "FIXED_AMOUNT";
    referralCommissionPercent?: number;
    referralCommissionAmountInPaise?: number;
  }>;
  reportQr?: { show: boolean; url?: string; dataUrl?: string } | null;
}

export function mapApiBillToReceiptData(api: ApiBillData): BillReceiptData {
  return {
    visitRef: api.visit.visitRef,
    billNumber: api.visit.billNumber,
    hasBill: api.visit.hasBill,
    date: api.visit.createdAt,
    domain: api.visit.domain,
    visitType: api.visit.visitType,
    isRevisit: api.visit.isRevisit,
    originalBillNumber: api.visit.originalVisitBillNumber,
    originalVisitDate: api.visit.originalVisitDate,
    branchName: api.branch.name,
    patient: {
      name: api.patient.name,
      title: api.patient.title,
      phone: api.patient.phone,
      age: api.patient.age,
      ageUnit: api.patient.ageUnit,
      ageDisplay: api.patient.ageDisplay,
      gender: api.patient.gender,
    },
    doctor: api.doctor,
    referralDoctor: api.referralDoctor,
    paymentType: api.payment.type,
    paymentStatus: api.payment.status,
    transactions: api.payment.transactions,
    totalAmount: api.visit.totalAmount,
    discountType: api.visit.discountType,
    discountPercentage: api.visit.discountPercentage,
    discountAmountInPaise: api.visit.discountAmountInPaise,
    paidAmountInPaise: api.visit.paidAmountInPaise,
    netAmountInPaise: api.visit.netAmountInPaise,
    dueAmountInPaise: api.visit.dueAmountInPaise,
    items: api.items.map((item) => ({
      id: item.id,
      name: item.name,
      price: item.price,
      referralType: item.referralCommissionType,
      referralPercent: item.referralCommissionPercent,
      referralAmountInPaise: item.referralCommissionAmountInPaise,
    })),
    reportQrDataUrl: api.reportQr?.show ? api.reportQr.dataUrl : null,
  };
}

function getClinicServiceName(visit: ClinicVisitView["visit"]): string {
  const visitTypeService =
    visit.visitType === "OP" ? "OP Consultation" : "IP Consultation";
  return visit.isRevisit ? `${visitTypeService} (Revisit)` : visitTypeService;
}

export function mapClinicVisitViewToReceiptData(
  visitView: ClinicVisitView,
  branchName?: string,
): BillReceiptData {
  const { visit, patient, clinicDoctor } = visitView;
  const patientPhone =
    patient.identifiers.find((identifier) => identifier.type === "PHONE")
      ?.value || "N/A";
  const serviceName = getClinicServiceName(visit);

  return {
    visitRef: visit.visitRef,
    billNumber: visit.billNumber,
    hasBill: visit.hasBill,
    date: visit.createdAt,
    domain: "CLINIC",
    visitType: visit.visitType,
    isRevisit: visit.isRevisit,
    originalBillNumber: visit.originalVisitBillNumber || null,
    originalVisitDate: visit.originalVisitDate || null,
    branchName,
    patient: {
      name: patient.name,
      title: patient.title,
      phone: patientPhone,
      age: patient.age,
      ageUnit: patient.ageUnit,
      ageDisplay: patient.ageDisplay,
      gender: patient.gender,
    },
    doctor: clinicDoctor
      ? {
          name: clinicDoctor.name,
          qualification: clinicDoctor.qualification,
          specialty: clinicDoctor.specialty,
        }
      : undefined,
    transactions: visit.transactions || [],
    paymentType: visit.paymentType,
    paymentStatus: visit.paymentStatus,
    totalAmount: visit.consultationFeeInPaise / 100,
    discountReason: visit.discountReason,
    discountType: visit.discountType,
    discountPercentage: visit.discountPercentage,
    discountAmountInPaise: visit.discountAmountInPaise,
    paidAmountInPaise: visit.paidAmountInPaise,
    netAmountInPaise: visit.netAmountInPaise,
    dueAmountInPaise: visit.dueAmountInPaise,
    items: [
      {
        id: visit.id,
        name: serviceName,
        price: visit.consultationFeeInPaise / 100,
      },
    ],
  };
}

export function mapDiagnosticsVisitViewToReceiptData(
  visitView: DiagnosticVisitView,
  branchName?: string,
): BillReceiptData {
  return {
    billNumber: visitView.visit.billNumber,
    date: visitView.visit.createdAt,
    domain: "DIAGNOSTICS",
    branchName,
    patient: {
      name: visitView.patient.name,
      title: visitView.patient.title,
      phone:
        visitView.patient.identifiers?.find((id) => id.type === "PHONE")
          ?.value || "",
      age: visitView.patient.age,
      ageUnit: visitView.patient.ageUnit,
      ageDisplay: visitView.patient.ageDisplay,
      gender: visitView.patient.gender,
    },
    referralDoctor: visitView.referralDoctor
      ? {
          name: visitView.referralDoctor.name,
        }
      : undefined,
    paymentType: visitView.visit.paymentType,
    transactions: visitView.visit.transactions || [],
    paymentStatus: visitView.visit.paymentStatus,
    totalAmount: visitView.visit.totalAmountInPaise / 100,
    discountType: visitView.visit.discountType,
    discountPercentage: visitView.visit.discountPercentage,
    discountAmountInPaise: visitView.visit.discountAmountInPaise,
    paidAmountInPaise: visitView.visit.paidAmountInPaise,
    netAmountInPaise: visitView.visit.netAmountInPaise,
    dueAmountInPaise: visitView.visit.dueAmountInPaise,
    items:
      visitView.billItems ??
      visitView.testOrders.map((order) => ({
        id: order.id,
        name: order.testName,
        price: order.priceInPaise / 100,
        referralType: visitView.referralDoctor
          ? order.referralCommissionType
          : undefined,
        referralPercent: visitView.referralDoctor
          ? order.referralCommissionPercent
          : undefined,
        referralAmountInPaise: visitView.referralDoctor
          ? (order.referralCommissionAmountInPaise ?? undefined)
          : undefined,
      })),
  };
}