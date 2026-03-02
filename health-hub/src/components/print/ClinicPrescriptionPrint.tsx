import type { ClinicVisitView } from '@/types';
import { API_BASE_URL } from '@/lib/api';

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
  const dateStr = new Date(visit.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const feeAmount = (visit.consultationFeeInPaise / 100).toFixed(2);

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

      {/* ============ PAGE 2: Bill Receipt ============ */}
      <div className="print-page p-8" style={{ display: 'flex', flexDirection: 'column' }}>

        {/* Logo Header - Centered */}
        <div className="flex justify-center mb-1">
          <img src={`${API_BASE_URL}/images/sobhana-clinic-logo.png`} alt="Sobhana" style={{ height: '60px', objectFit: 'contain' }} />
        </div>
        {branchName && (
          <p className="text-center text-xs tracking-widest uppercase mb-3">{branchName}</p>
        )}
        <div className="border-t-2 border-black mb-4"></div>

        {/* Bill Info Row */}
        <div className="flex justify-between text-sm mb-1">
          <div>
            <p><strong>Bill No:</strong>&ensp;{visit.billNumber}</p>
            <p><strong>Date:</strong>&ensp;{dateStr}</p>
            <p><strong>Visit Type:</strong>&ensp;{visitTypeService}</p>
          </div>
          <div className="text-right">
            <p><strong>Payment:</strong>&ensp;{visit.paymentType}</p>
            <p><strong>Status:</strong>&ensp;{visit.paymentStatus}</p>
          </div>
        </div>

        {/* Patient Details Box */}
        <div className="border border-black p-3 my-4">
          <h2 className="font-bold text-sm mb-2">Patient Details</h2>
          <div className="grid grid-cols-2 gap-y-1 text-sm">
            <p><strong>Name:</strong>&ensp;{patient.name.toUpperCase()}</p>
            <p><strong>Phone:</strong>&ensp;{patient.identifiers.find(i => i.type === 'PHONE')?.value || 'N/A'}</p>
            <p><strong>Age:</strong>&ensp;{patient.age} years</p>
            <p><strong>Gender:</strong>&ensp;{genderFull}</p>
          </div>
        </div>

        {/* Consulting Doctor */}
        <p className="text-sm mb-3">
          <strong>Consulting Doctor:</strong>&ensp;{clinicDoctor?.name}{clinicDoctor?.qualification ? `, ${clinicDoctor.qualification}` : ''}{clinicDoctor?.specialty ? ` (${clinicDoctor.specialty})` : ''}
        </p>

        {/* Service Table */}
        <table className="w-full border-collapse border border-black text-sm mb-4">
          <thead>
            <tr className="border-b border-black">
              <th className="border-r border-black p-2 text-left w-16">S.NO</th>
              <th className="border-r border-black p-2 text-left">SERVICE DESCRIPTION</th>
              <th className="p-2 text-right w-32">AMOUNT (₹)</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-black">
              <td className="border-r border-black p-2">1</td>
              <td className="border-r border-black p-2">{visitTypeService}</td>
              <td className="p-2 text-right">{feeAmount}</td>
            </tr>
            <tr>
              <td className="border-r border-black p-2"></td>
              <td className="border-r border-black p-2 text-right font-bold">TOTAL</td>
              <td className="p-2 text-right font-bold">₹{feeAmount}</td>
            </tr>
          </tbody>
        </table>

        {/* Revisit Note */}
        <div className="border border-black p-3 mb-4">
          <p className="text-xs">
            <strong>Note:</strong> <em>This receipt is valid for a free revisit within 7 days from the date of issue for the same complaint with the same consultant. Please carry this bill for the follow-up visit.</em>
          </p>
        </div>

        {/* Spacer to push footer to bottom */}
        <div className="flex-1"></div>

        {/* Footer */}
        <div className="border-t border-black pt-3 text-center">
          <p className="text-sm mb-1">We appreciate your trust in Sobhana.</p>
          <p className="text-xs tracking-wider uppercase">* This is a computer generated invoice and does not require a physical signature *</p>
        </div>
      </div>

    </div>
  );
};
