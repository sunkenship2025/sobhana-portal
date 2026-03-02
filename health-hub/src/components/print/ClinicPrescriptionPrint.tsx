import type { ClinicVisitView, BillReceiptData } from '@/types';
import { BillReceipt } from './BillReceipt';

interface ClinicPrescriptionPrintProps {
  visitView: ClinicVisitView;
  branchName?: string;
}

export const ClinicPrescriptionPrint = ({ visitView, branchName }: ClinicPrescriptionPrintProps) => {
  const { visit, patient, clinicDoctor } = visitView;

  // Calculate follow-up valid date (7 days from visit creation)
  const followUpDate = new Date(visit.createdAt);
  followUpDate.setDate(followUpDate.getDate() + 7);
  const followUpDateStr = followUpDate.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  // Visit type label
  const visitTypeLabel = visit.isRevisit ? 'Revisit' : 'New';
  const visitTypeService = visit.visitType === 'OP' ? 'OP Consultation' : 'IP Consultation';

  const genderFull = patient.gender === 'M' ? 'Male' : patient.gender === 'F' ? 'Female' : 'Other';

  return (
    <div className="print-content bg-white text-black">

      {/* ============ PAGE 1: Prescription Pad ============ */}
      <div className="print-page p-8" style={{ display: 'flex', flexDirection: 'column' }}>
        {/* Doctor Header */}
        <div className="border-b-2 border-black pb-4 mb-6 flex justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">{clinicDoctor?.name || 'Clinic Doctor'}</h1>
            <p className="text-sm">{clinicDoctor?.qualification}</p>
            <p className="text-sm">Reg No:</p>
            <p className="text-sm">{clinicDoctor?.registrationNumber}</p>
          </div>
          <div className="text-right text-sm">
            <p><strong>Date: {new Date(visit.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' })}</strong></p>
            <p>Bill No: {visit.billNumber}</p>
            <p>Visit Type: {visitTypeLabel}</p>
          </div>
        </div>

        {/* Patient Info */}
        <div className="mb-2">
          <p className="text-base"><strong>Patient Name:</strong>&ensp;{patient.name.toUpperCase()}</p>
        </div>
        <div className="border-b border-black pb-3 mb-6">
          <p className="text-base"><strong>Age / Gender:</strong>&ensp;{patient.age} / {genderFull}</p>
        </div>

        {/* Rx Symbol & Prescription Area */}
        <div className="flex-1">
          <p className="text-5xl font-bold mb-6" style={{ fontFamily: 'serif' }}>℞</p>
        </div>

        {/* Follow-up line */}
        <div className="mt-auto">
          <p className="text-sm mb-2">Free follow-up valid until {followUpDateStr}.</p>
          <div className="border-t border-black mb-16"></div>
        </div>

        {/* Doctor Signature */}
        <div className="text-center mb-4">
          <div className="inline-block">
            <div className="border-t border-black w-48 mb-1"></div>
            <p className="text-sm">Doctor's Signature</p>
          </div>
        </div>
      </div>

      {/* ============ PAGE 2: Bill Receipt (shared component) ============ */}
      <BillReceipt
        asPage
        data={{
          billNumber: visit.billNumber,
          date: visit.createdAt,
          domain: 'CLINIC',
          visitType: visit.visitType,
          isRevisit: visit.isRevisit,
          branchName,
          patient: {
            name: patient.name,
            phone: patient.identifiers.find(i => i.type === 'PHONE')?.value || 'N/A',
            age: patient.age,
            gender: patient.gender,
          },
          doctor: clinicDoctor ? {
            name: clinicDoctor.name,
            qualification: clinicDoctor.qualification,
            specialty: clinicDoctor.specialty,
          } : undefined,
          paymentType: visit.paymentType,
          paymentStatus: visit.paymentStatus,
          totalAmount: visit.consultationFeeInPaise / 100,
          items: [{
            id: visit.id,
            name: visitTypeService,
            price: visit.consultationFeeInPaise / 100,
          }],
        }}
      />

    </div>
  );
};
